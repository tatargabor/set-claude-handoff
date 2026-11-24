import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { pluginLines, mergePluginHooks, cmdPluginFiles } from "../bin/plugin.mjs"
import { decideStop } from "../templates/keep-going.mjs"

// The request these guard (a consumer family, 2026-11-08): wire the hooks with no per-repo copy. Two of
// its repos carried byte-identical copies of seven hooks, a plugin vendored an old keep-going, and each
// upgrade had to visit every tree.

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const SHEET = ["# HANDOFF: t — 2026-11-23 · ID: 1123-abcd", ...["0", "1", "2", "3", "4", "5", "6", "7"].map((n) => `## ${n}. s\nnone`)].join("\n") + "\n"

/** A machine where the binary is installed (a bin dir with the npm-style symlink), or not. */
function machine({ installed = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "plugin-"))
  const bin = join(base, "bin"), home = join(base, "home"), proj = join(base, "proj")
  for (const d of [bin, home, join(proj, ".set/handoff"), join(proj, ".claude")]) mkdirSync(d, { recursive: true })
  if (installed) symlinkSync(join(ROOT, "bin/cli.mjs"), join(bin, "set-claude-handoff"))
  // Only `node` itself, in a dir of its own and first: the bin's `#!/usr/bin/env node` must find the node
  // running these tests (not an older /usr/bin/node), and node's real dir may hold a global install of
  // this very package, which would make "not installed" a lie.
  const nodeBin = join(base, "node-bin"); mkdirSync(nodeBin); symlinkSync(process.execPath, join(nodeBin, "node"))
  const env = { PATH: `${installed ? `${bin}:` : ""}${nodeBin}:/usr/bin:/bin`, HOME: home, CLAUDE_PROJECT_DIR: proj, CLAUDE_CODE_ENTRYPOINT: "cli" }
  return { base, proj, env }
}
const line = (name, opts) => pluginLines(opts).find((l) => l.name === name).command
const sh = (cmd, env, input) => spawnSync("bash", ["-c", cmd], { env, input: JSON.stringify(input), encoding: "utf8" })

test("AC-1: the plugin's arm line arms through the installed package — no copy in the repo", () => {
  const m = machine()
  const sheet = join(m.proj, ".set/handoff/1123-abcd--t.md")
  writeFileSync(sheet, SHEET)
  const r = sh(line("arm"), m.env, { tool_name: "Write", session_id: "abcd1234-ffff", cwd: m.proj, tool_input: { file_path: sheet } })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(m.proj, ".set/handoff/.written-abcd1234")), "marker written")
  assert.ok(!existsSync(join(m.proj, ".claude/hooks")), "nothing was copied into the repo")
})

test("AC-2: a project whose settings still wire its copy makes the plugin line stand down — a double reinject would inject twice", () => {
  // two machines: the reload injects at most once per clear, so a second call on one tree would be
  // silent whether or not the stand-down works
  const u = machine()
  writeFileSync(join(u.proj, ".set/handoff/1123-abcd--t.md"), SHEET)
  assert.match(sh(line("reinject"), u.env, { session_id: "eeee1111-x", source: "clear", cwd: u.proj }).stdout, /1123-abcd/, "unwired: the plugin reloads")
  const m = machine()
  writeFileSync(join(m.proj, ".set/handoff/1123-abcd--t.md"), SHEET)
  const ev = { session_id: "eeee1111-x", source: "clear", cwd: m.proj }
  writeFileSync(join(m.proj, ".claude/settings.json"), JSON.stringify({ hooks: { SessionStart: [{ matcher: "clear|compact",
    hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/handoff-reinject-clear.mjs"' }] }] } }))
  const r = sh(line("reinject"), m.env, ev)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "", "wired copy: the plugin says nothing")
})

test("AC-3: a copy that exists but no settings file wires does not make the plugin stand down — an unwired copy fires nothing", () => {
  const m = machine()
  mkdirSync(join(m.proj, ".claude/hooks"), { recursive: true })
  writeFileSync(join(m.proj, ".claude/hooks/handoff-arm.mjs"), "// stale copy, unwired\n")
  const sheet = join(m.proj, ".set/handoff/1123-abcd--t.md")
  writeFileSync(sheet, SHEET)
  sh(line("arm"), m.env, { tool_name: "Write", session_id: "abcd5678-ffff", cwd: m.proj, tool_input: { file_path: sheet } })
  assert.ok(existsSync(join(m.proj, ".set/handoff/.written-abcd5678")))
})

test("AC-4: plugin-files keeps foreign hooks, adds its lines once over two runs, and names a vendored copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-files-"))
  mkdirSync(join(dir, "hooks"))
  const foreign = { type: "command", command: "node guard.mjs" }
  const vendored = { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/keep-going/keep-going.mjs" stop --max 40' }
  writeFileSync(join(dir, "hooks/hooks.json"), JSON.stringify({ description: "family", hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [foreign] }], Stop: [{ hooks: [vendored] }] } }))
  const out = []
  cmdPluginFiles([dir, "--keep-going"], { log: (l) => out.push(l) })
  cmdPluginFiles([dir, "--keep-going"], { log: () => {} })
  const doc = JSON.parse(readFileSync(join(dir, "hooks/hooks.json"), "utf8"))
  assert.equal(doc.description, "family")
  assert.deepEqual(doc.hooks.PreToolUse, [{ matcher: "Bash", hooks: [foreign] }])
  const all = Object.values(doc.hooks).flat().flatMap((e) => e.hooks.map((h) => h.command))
  assert.equal(all.filter((c) => c.includes('"$H" hook')).length, 4, "four portable lines, once")
  assert.ok(all.includes(vendored.command), "the vendored line is reported, never removed")
  assert.match(out.join("\n"), /also wires a copy of the same hook[\s\S]*keep-going\/keep-going\.mjs/)
  for (const c of all.filter((c) => c.includes('"$H" hook'))) assert.doesNotMatch(c, /\/home\/|\/Users\//, "no machine path")

  const dry = mkdtempSync(join(tmpdir(), "plugin-dry-"))
  cmdPluginFiles([dry, "--dry-run"], { log: () => {} })
  assert.ok(!existsSync(join(dry, "hooks/hooks.json")), "--dry-run writes nothing")
})

test("AC-5: a watcher heartbeat counts as a watched tree — with no per-repo watcher copy keep-going still asks for the handoff at the limit", () => {
  const m = machine()
  const tr = join(m.base, "t.jsonl")
  writeFileSync(tr, [
    { type: "user", uuid: "u1", message: { role: "user", content: "go" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Step done." }], usage: { input_tokens: 0, cache_read_input_tokens: 410_000 } } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n")
  const ev = { session_id: "kkkk6666-x", cwd: m.proj, transcript_path: tr }
  const stop = line("keep-going stop", { keepGoing: true })
  assert.doesNotMatch(JSON.parse(sh(stop, m.env, ev).stdout).reason, /Write the handoff/, "no watcher: no demand")
  const hb = join(m.proj, ".set/handoff/.watcher-alive")
  writeFileSync(hb, "1 60s\n")
  const t = new Date(Date.now() - 2 * 60_000); utimesSync(hb, t, t)
  assert.match(JSON.parse(sh(stop, m.env, ev).stdout).reason, /Write the handoff NOW/, "a 2-min heartbeat: demand")
  const old = new Date(Date.now() - 30 * 60_000); utimesSync(hb, old, old)
  assert.doesNotMatch(JSON.parse(sh(stop, m.env, { ...ev, session_id: "kkkk7777-x" }).stdout).reason, /Write the handoff/, "a 30-min heartbeat is a dead watcher")
})

test("AC-6: without the binary the SessionStart line says the reload is off — never a silent blank", () => {
  const m = machine({ installed: false })
  const r = sh(line("reinject"), m.env, { session_id: "x", source: "clear", cwd: m.proj })
  assert.equal(r.status, 0)
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext
  assert.match(ctx, /handoff reload is OFF/)
  assert.match(ctx, /npm i -g set-claude-handoff/)
  assert.equal(sh(line("arm"), m.env, {}).status, 0, "the other lines fail open")
})

test("the watcher writes its heartbeat every pass, and takes its modules from beside the gate it was given", async () => {
  const { runWatcher } = await import("./helpers/watcher-harness.mjs")
  const r = runWatcher({ tokens: 10_000, seconds: 3 })
  assert.match(r.log, /watcher started/)
  const hb = join(r.record, "..", ".watcher-alive")
  assert.ok(existsSync(hb), "heartbeat written")
  assert.match(readFileSync(hb, "utf8"), /^\d+ 1s /)
})

test("`watch` runs the package's watcher with the package's gate — a unit needs no per-repo copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-pkg-"))
  const home = mkdtempSync(join(tmpdir(), "watch-home-"))
  mkdirSync(join(home, ".claude/sessions"), { recursive: true })
  spawnSync("timeout", ["3", "node", join(ROOT, "bin/cli.mjs"), "watch", "--dir", dir, "--interval", "1"], { env: { ...process.env, HOME: home }, encoding: "utf8" })
  const log = readFileSync(join(dir, ".set/handoff/auto-clear.log"), "utf8")
  assert.match(log, /watcher started/)
  assert.ok(existsSync(join(dir, ".set/handoff/.watcher-alive")))
})

test("the pure stop decision is unchanged by the heartbeat: autoClear is still the caller's input", () => {
  assert.match(decideStop({ message: "x", tokens: 410_000, human: "h", autoClear: true }).reason, /Write the handoff NOW/)
})

test("a project that wires the PACKAGE line in its own settings makes the plugin stand down too — set-core may write `set-claude-handoff hook reinject` into settings (2026-11-23), and a file-name check missed it: a double reload", async () => {
  const { projectWires } = await import("../bin/plugin.mjs")
  const m = machine()
  const put = (command) => writeFileSync(join(m.proj, ".claude/settings.json"), JSON.stringify({ hooks: { SessionStart: [{ matcher: "clear|compact", hooks: [{ type: "command", command }] }] } }))
  put('H="$(command -v set-claude-handoff)"; "$H" hook reinject')
  assert.equal(projectWires(m.proj, "reinject"), true)
  assert.equal(projectWires(m.proj, "arm"), false, "only the hook it names")
  put(line("reinject"))
  assert.equal(projectWires(m.proj, "reinject"), false, "a plugin-style line (--from-plugin) is not the project's own copy")
  writeFileSync(join(m.proj, ".set/handoff/1123-abcd--t.md"), SHEET)
  put('set-claude-handoff hook reinject')
  assert.equal(sh(line("reinject"), m.env, { session_id: "ffff1111-x", source: "clear", cwd: m.proj }).stdout, "", "the plugin line says nothing")
})

test("the /auto-clear skill's status step recognises the package route — reported 2026-11-24 by a consumer wired through a plugin: the copy-only checks (`test -f .claude/hooks/clear-gate.mjs`, a settings grep) said gate-missing and not wired although the setup worked", () => {
  const skill = readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "skills/auto-clear/SKILL.md"), "utf8")
  const status = skill.slice(skill.indexOf("## 1. STATE first"), skill.indexOf("## 2. ARM"))
  assert.match(status, /hook reinject --from-plugin/, "the plugin's wiring line is looked for")
  assert.match(status, /set-claude-handoff watch/, "a package-run watcher is named")
  assert.match(status, /\.watcher-alive/, "the heartbeat is evidence")
  assert.match(status, /"Not wired" is the\s+verdict only when neither route shows the reload hook/, "no-copy alone is not a verdict")
  assert.doesNotMatch(status, /echo gate-missing/, "the copy-only verdict word is gone")
})
