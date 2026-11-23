import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, utimesSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { cmdInit } from "../bin/cli.mjs"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const silent = () => {}

function project(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "handoff-test-"))
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  return dir
}

test("init installs the skill and a profile", () => {
  const dir = project({ ".gitignore": "node_modules/\n" })
  cmdInit({ cwd: dir, log: silent })

  const skill = readFileSync(join(dir, ".claude/skills/handoff/SKILL.md"), "utf8")
  assert.match(skill, /^---\nname: handoff\n/)
  assert.ok(existsSync(join(dir, ".claude/handoff.profile.md")))
})

test("re-init upgrades the skill but NEVER overwrites the profile", () => {
  // The contract that makes upgrading safe. If init clobbered the project's probes, nobody
  // would ever upgrade, and the skill would fork per project — which is what this package exists
  // to undo.
  const dir = project({ ".gitignore": "" })
  cmdInit({ cwd: dir, log: silent })

  const profilePath = join(dir, ".claude/handoff.profile.md")
  writeFileSync(profilePath, "# my own probes\n")
  writeFileSync(join(dir, ".claude/skills/handoff/SKILL.md"), "stale\n")

  cmdInit({ cwd: dir, log: silent })

  assert.equal(readFileSync(profilePath, "utf8"), "# my own probes\n")
  assert.match(readFileSync(join(dir, ".claude/skills/handoff/SKILL.md"), "utf8"), /name: handoff/)
})

test("init adds .set/ to .gitignore exactly once, and recognises the existing forms", () => {
  const dir = project({ ".gitignore": "node_modules/\n" })
  cmdInit({ cwd: dir, log: silent })
  cmdInit({ cwd: dir, log: silent })
  const ignore = readFileSync(join(dir, ".gitignore"), "utf8")
  assert.equal(ignore.split("\n").filter((l) => l.trim() === ".set/").length, 1)

  for (const form of [".set", "/.set/", "/.set"]) {
    const d = project({ ".gitignore": `${form}\n` })
    cmdInit({ cwd: d, log: silent })
    assert.equal(readFileSync(join(d, ".gitignore"), "utf8"), `${form}\n`, `${form} should count as ignored`)
  }
})

test("init survives a repo with no .gitignore instead of crashing", () => {
  const dir = project()
  const lines = []
  cmdInit({ cwd: dir, log: (m) => lines.push(m) })
  assert.ok(lines.some((l) => /no .gitignore/.test(l)), "the missing file must be announced, not swallowed")
})

test("the profile pre-fills only probes it can prove from package.json", () => {
  const dir = project({
    ".gitignore": "",
    "package.json": JSON.stringify({ scripts: { test: "vitest run", build: "next build" } }),
    "pnpm-lock.yaml": "",
  })
  cmdInit({ cwd: dir, log: silent })
  const profile = readFileSync(join(dir, ".claude/handoff.profile.md"), "utf8")

  assert.match(profile, /`pnpm test`.*detected — verify/)
  assert.match(profile, /`pnpm build`.*detected — verify/)
  assert.doesNotMatch(profile, /`pnpm lint`/, "a script that does not exist must not be invented")
  assert.doesNotMatch(profile, /<your test command>/, "the detected row replaces the placeholder")
})

test("a malformed package.json degrades to the plain template", () => {
  const dir = project({ ".gitignore": "", "package.json": "{ not json" })
  cmdInit({ cwd: dir, log: silent })
  assert.match(readFileSync(join(dir, ".claude/handoff.profile.md"), "utf8"), /<your test command>/)
})

test("--global installs the skill without a profile", () => {
  const home = project()
  const dir = project()
  const prevHome = process.env.HOME
  process.env.HOME = home
  try {
    cmdInit({ cwd: dir, global: true, log: silent })
  } finally {
    process.env.HOME = prevHome
  }
  assert.ok(existsSync(join(home, ".claude/skills/handoff/SKILL.md")))
  assert.ok(!existsSync(join(home, ".claude/handoff.profile.md")), "the profile is per project")
  assert.ok(!existsSync(join(dir, ".claude")), "--global must not touch the cwd")
})

test("the CLI runs when invoked through a symlink (how npm installs a bin)", () => {
  // Regression: the entry guard compared argv[1] to "cli.mjs" by suffix, so the npm-installed
  // binary (node_modules/.bin/set-claude-handoff → a symlink) silently did nothing at all.
  const dir = project()
  const link = join(dir, "set-claude-handoff")
  symlinkSync(join(PKG_ROOT, "bin/cli.mjs"), link)
  const out = execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" })
  assert.match(out.trim(), /^\d+\.\d+\.\d+$/)
})

test("an unknown command exits non-zero instead of pretending to work", () => {
  assert.throws(() =>
    execFileSync(process.execPath, [join(PKG_ROOT, "bin/cli.mjs"), "instal"], { encoding: "utf8", stdio: "pipe" }),
  )
})

test("init installs the auto-clear switchboard skill alongside the handoff skill — activation must be invocable from any project", async () => {
  const dir = project()
  await cmdInit({ cwd: dir, log: silent })
  const skill = readFileSync(join(dir, ".claude/skills/auto-clear/SKILL.md"), "utf8")
  assert.match(skill, /^---\nname: auto-clear\n/)
  // re-run overwrites it (package-owned = upgrade path), same as the handoff skill
  writeFileSync(join(dir, ".claude/skills/auto-clear/SKILL.md"), "stale\n")
  await cmdInit({ cwd: dir, log: silent })
  assert.match(readFileSync(join(dir, ".claude/skills/auto-clear/SKILL.md"), "utf8"), /name: auto-clear/)
})

test("init --autopilot installs the whole hook directory — every hook imports ./ledger.mjs, so a partial install breaks them all at load", async () => {
  const { existsSync: exists } = await import("node:fs")
  const dir = project()
  await cmdInit({ cwd: dir, autopilot: true, log: silent })
  for (const f of ["ledger.mjs", "validate.mjs", "judge.mjs", "drift-guard.mjs", "capture-prompt.mjs", "capture-answer.mjs", "answer-dialog.mjs", "answer-stop.mjs"]) {
    assert.ok(exists(join(dir, ".claude/hooks/autopilot", f)), f)
  }
  assert.match(readFileSync(join(dir, ".claude/skills/autopilot/SKILL.md"), "utf8"), /^---\nname: autopilot\n/)
  assert.ok(!exists(join(dir, ".claude/settings.json")), "settings.json is consumer-owned — init prints the merge, never performs it")
  assert.doesNotMatch(readFileSync(join(dir, ".claude/handoff.profile.md"), "utf8"), /## Autopilot/, "the profile is project-owned")
})

test("init --auto-clear ships the watcher and its presence check — the 10:03:50Z typing-collision fix must reach consumers", async () => {
  const { existsSync: exists, statSync } = await import("node:fs")
  const dir = project()
  await cmdInit({ cwd: dir, autoClear: true, log: silent })
  const watcher = join(dir, ".claude/hooks/watch-auto-clear.sh")
  assert.ok(exists(watcher))
  assert.ok(statSync(watcher).mode & 0o111, "the watcher must be executable")
  assert.ok(exists(join(dir, ".claude/hooks/presence.mjs")), "the watcher refuses to start without its presence check")
  assert.ok(exists(join(dir, ".claude/hooks/turn-state.mjs")), "the watcher refuses to start without its turn-state check")
  assert.ok(exists(join(dir, ".claude/hooks/handoff-arm.mjs")), "without an arming hook no session is ever cleared")
  assert.ok(exists(join(dir, ".claude/hooks/keep-going.mjs")))
})

test("init --auto-clear prints keep-going hooks WITHOUT --threshold — a number pasted into settings.json stayed at 500000 after the gate's default moved to 400000", () => {
  const dir = mkdtempSync(join(tmpdir(), "init-kg-"))
  const out = []
  cmdInit({ cwd: dir, autoClear: true, log: (l) => out.push(l) })
  const kg = out.join("\n").split("\n").filter((l) => l.includes("keep-going.mjs\\\" "))
  assert.ok(kg.length >= 2, `keep-going hook lines printed:\n${out.join("\n")}`)
  for (const l of kg) assert.doesNotMatch(l, /--threshold/, l)
})

test("init --auto-clear stamps the wiring time ONCE — a re-run never moves it, or every session started since the first install would fall behind the watcher's filter (change started-after-self-exclusion)", () => {
  const dir = mkdtempSync(join(tmpdir(), "init-stamp-"))
  cmdInit({ cwd: dir, autoClear: true, log: silent })
  const stamp = join(dir, ".set/handoff/.reload-wired-at")
  const body = readFileSync(stamp, "utf8")
  assert.match(body, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n$/, "ONE line, ISO-8601 UTC with Z, parsed with Date.parse")
  assert.ok(Number.isFinite(Date.parse(body.trim())), "the stamp is a date")
  const old = new Date(Date.now() - 90 * 24 * 3600_000)
  utimesSync(stamp, old, old)
  cmdInit({ cwd: dir, autoClear: true, log: silent })
  assert.equal(readFileSync(stamp, "utf8"), body, "the content survives a re-run")
  assert.ok(Math.abs(statSync(stamp).mtimeMs - old.getTime()) < 5000, "the re-run did not even touch the file")
  const plain = mkdtempSync(join(tmpdir(), "init-nostamp-"))
  cmdInit({ cwd: plain, log: silent })
  assert.ok(!existsSync(join(plain, ".set/handoff/.reload-wired-at")), "no --auto-clear, no wiring, no stamp")
})

test("a project init warns when a user-level skill copy shadows it and differs — measured 2026-11-23: 928 of 938 handoff loads came from ~/.claude/skills, whose auto-clear copy was two months stale", () => {
  const dir = mkdtempSync(join(tmpdir(), "init-shadow-"))
  const home = mkdtempSync(join(tmpdir(), "home-shadow-"))
  mkdirSync(join(home, ".claude/skills/auto-clear"), { recursive: true })
  writeFileSync(join(home, ".claude/skills/auto-clear/SKILL.md"), "# an old copy\n1. limit (default 500k)\n")
  const out = []
  cmdInit({ cwd: dir, home, log: (l) => out.push(l) })
  const text = out.join("\n")
  assert.match(text, /user-level copy SHADOWS/)
  assert.match(text, /skills\/auto-clear\/SKILL\.md/)
  assert.match(text, /init --global/)

  const home2 = mkdtempSync(join(tmpdir(), "home-clean-"))
  const out2 = []
  cmdInit({ cwd: mkdtempSync(join(tmpdir(), "init-clean-")), home: home2, log: (l) => out2.push(l) })
  assert.doesNotMatch(out2.join("\n"), /SHADOWS/, "no global copy, no warning")
})
