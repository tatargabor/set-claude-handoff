import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs"
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
})
