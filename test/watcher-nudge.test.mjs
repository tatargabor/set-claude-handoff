import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const WATCHER = join(ROOT, "templates/watch-auto-clear.sh")
const GATE = join(ROOT, "templates/clear-gate.mjs")
const PID = "424242"
const SID = "feedface-1111-2222-3333-444455556666"

/**
 * One watched session in a throwaway HOME: a runtime record, an idle transcript at `tokens`, and a
 * fake `tmux` on PATH whose pane hosts the session pid, renders an empty idle prompt, and appends
 * every send-keys call to `keys.log`. Runs the real watcher for a few 1-second passes.
 */
function runWatcher({ tokens, extraArgs = [], marker = false, seconds = 5 }) {
  const base = mkdtempSync(join(tmpdir(), "watch-nudge-"))
  const home = join(base, "home")
  const proj = join(base, "proj")
  const bin = join(base, "bin")
  const hd = join(proj, ".set/handoff")
  mkdirSync(join(home, ".claude/sessions"), { recursive: true })
  mkdirSync(hd, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(home, ".claude/sessions", `${PID}.json`),
    JSON.stringify({ pid: Number(PID), sessionId: SID, cwd: proj, startedAt: Date.now() - 60_000 }))
  const tdir = join(home, ".claude/projects", proj.replace(/\//g, "-"))
  mkdirSync(tdir, { recursive: true })
  writeFileSync(join(tdir, `${SID}.jsonl`), JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "done" }], usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens } },
  }) + "\n")
  if (marker) {
    writeFileSync(join(hd, "1123-aaaa--thread.md"), "# thread\n")
    writeFileSync(join(hd, `.written-${SID.replace(/-/g, "").slice(0, 8)}`), `${new Date().toISOString()} 1123-aaaa--thread.md\n`)
  }
  const keys = join(base, "keys.log")
  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash
case "$1" in
  list-panes) printf '%s\\tfake:0.0\\n' ${PID} ;;
  capture-pane) printf '\\xe2\\x9d\\xaf\\xc2\\xa0\\n' ;;
  send-keys) shift; printf '%s\\n' "$*" >> "${keys}" ;;
esac
exit 0
`)
  chmodSync(join(bin, "tmux"), 0o755)
  spawnSync("timeout", [String(seconds), "bash", WATCHER, "--dir", proj, "--interval", "1", "--gate", GATE, ...extraArgs], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8",
  })
  const log = existsSync(join(hd, "auto-clear.log")) ? readFileSync(join(hd, "auto-clear.log"), "utf8") : ""
  return {
    keys: existsSync(keys) ? readFileSync(keys, "utf8").trim().split("\n").filter(Boolean) : [],
    log,
    record: join(hd, `.handoff-nudged-${SID.replace(/-/g, "").slice(0, 8)}`),
  }
}

test("an unarmed idle session at ≥ 60 % of the threshold gets /handoff typed exactly ONCE — measured 2026-11-23: 80 of 141 watched sessions in one consumer tree never armed, so no clear could ever fire", () => {
  const r = runWatcher({ tokens: 260_000 }) // ≥ 0.6 × 400k = 240k, < 400k
  assert.deepEqual(r.keys, ["-t fake:0.0 -l /handoff", "-t fake:0.0 Enter"], `keys typed: ${JSON.stringify(r.keys)}\n${r.log}`)
  assert.ok(existsSync(r.record), "the nudge is recorded")
  assert.equal((r.log.match(/^\S+ NUDGE /gm) ?? []).length, 1, r.log)
  const after = r.log.slice(r.log.search(/^\S+ NUDGE /m))
  assert.ok((after.match(/^\S+ no {4}/gm) ?? []).length >= 2, `later passes ran and typed nothing:\n${r.log}`)
})

test("the arm nudge stays quiet below the ratio, for an armed session, and with --arm-nudge false", () => {
  assert.deepEqual(runWatcher({ tokens: 200_000, seconds: 3 }).keys, [], "200k < 240k")
  assert.deepEqual(runWatcher({ tokens: 260_000, marker: true, seconds: 3 }).keys, [], "an armed session needs no nudge")
  assert.deepEqual(runWatcher({ tokens: 260_000, extraArgs: ["--arm-nudge", "false"], seconds: 3 }).keys, [], "the off switch")
})
