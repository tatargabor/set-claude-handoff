// A real watch-auto-clear.sh run against one fake session in a throwaway HOME. The session has a
// runtime record and a transcript at `tokens`; its last assistant record is `idleMin` minutes old when
// that is given. A fake `tmux` on PATH hosts the session pid, renders `screen` (an empty idle prompt by
// default), and appends every send-keys call to keys.log. The watcher then runs for a few one-second
// passes. Shared by the watcher-level tests, so a new trigger reuses the harness instead of copying it.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)))
export const WATCHER = join(ROOT, "templates/watch-auto-clear.sh")
export const GATE = join(ROOT, "templates/clear-gate.mjs")
export const PID = "424242"
export const SID = "feedface-1111-2222-3333-444455556666"
export const S8 = SID.replace(/-/g, "").slice(0, 8)
export const IDLE_SCREEN = "\\xe2\\x9d\\xaf\\xc2\\xa0\\n"                       // "❯ " — empty input row
export const WORKING_SCREEN = "\\xe2\\x9c\\xbb Wibbling\\xe2\\x80\\xa6 \\n" + IDLE_SCREEN

export function runWatcher({ tokens, idleMin = null, marker = false, markerAgeMin = null, nudgeRecord = null, nudgeRecordAgeMin = null,
  screen = IDLE_SCREEN, extraArgs = [], seconds = 5, mutate = null, prefillLogBytes = 0, staleLog1 = false, watcherTmpUnwritable = false }) {
  const base = mkdtempSync(join(tmpdir(), "watch-harness-"))
  const home = join(base, "home"), proj = join(base, "proj"), bin = join(base, "bin")
  // A temp dir the WATCHER cannot create its no-dedupe dir in (chmod 555 blocks a non-root writer;
  // node's own tmpdir() here is untouched — only the child env points at this).
  let roTmp = null
  if (watcherTmpUnwritable) { roTmp = join(base, "ro-tmp"); mkdirSync(roTmp); chmodSync(roTmp, 0o555) }
  const hd = join(proj, ".set/handoff")
  for (const d of [join(home, ".claude/sessions"), hd, bin]) mkdirSync(d, { recursive: true })
  writeFileSync(join(home, ".claude/sessions", `${PID}.json`),
    JSON.stringify({ pid: Number(PID), sessionId: SID, cwd: proj, startedAt: Date.now() - 120 * 60_000 }))
  const tdir = join(home, ".claude/projects", proj.replace(/\//g, "-"))
  mkdirSync(tdir, { recursive: true })
  const lastAt = idleMin == null ? null : Date.now() - idleMin * 60_000
  writeFileSync(join(tdir, `${SID}.jsonl`), JSON.stringify({
    type: "assistant", ...(lastAt == null ? {} : { timestamp: new Date(lastAt).toISOString() }),
    message: { content: [{ type: "text", text: "done" }], usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens } },
  }) + "\n")
  const record = join(hd, `.handoff-nudged-${S8}`)
  if (nudgeRecord) {
    writeFileSync(record, nudgeRecord)
    if (nudgeRecordAgeMin != null) { const t = new Date(Date.now() - nudgeRecordAgeMin * 60_000); utimesSync(record, t, t) }
  }
  if (marker) {
    writeFileSync(join(hd, "1123-aaaa--thread.md"), "# thread\n")
    const m = join(hd, `.written-${S8}`)
    writeFileSync(m, `${new Date().toISOString()} 1123-aaaa--thread.md\n`)
    const at = markerAgeMin != null ? new Date(Date.now() - markerAgeMin * 60_000) : lastAt != null ? new Date(lastAt) : null
    if (at) utimesSync(m, at, at)
  }
  const keys = join(base, "keys.log")
  const logPath = join(hd, "auto-clear.log")
  if (prefillLogBytes > 0) writeFileSync(logPath, "x".repeat(prefillLogBytes))
  if (staleLog1) writeFileSync(`${logPath}.1`, "stale\n")
  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash
case "$1" in
  list-panes) printf '%s\\tfake:0.0\\n' ${PID} ;;
  capture-pane) printf '${screen}' ;;
  send-keys) shift; printf '%s\\n' "$*" >> "${keys}" ;;
esac
exit 0
`)
  chmodSync(join(bin, "tmux"), 0o755)
  // A detached snippet the test drives a change from MID-run — the fake tmux is not called at all
  // on a plain "no" pass, so it cannot be the trigger. It sleeps its own lead-in, then runs in
  // `base` with $HD/$TDIR set and TMPDIR=base (also the watcher's TMPDIR, so snippets can reach
  // the watcher's own temp state, e.g. its no-dedupe memory, via a set-handoff-no-dedupe-* glob).
  if (mutate) {
    spawn("bash", ["-c", mutate], { cwd: base, detached: true, stdio: "ignore",
      env: { ...process.env, TMPDIR: base, HD: hd, TDIR: tdir } }).unref()
  }
  const run = spawnSync("timeout", [String(seconds), "bash", WATCHER, "--dir", proj, "--interval", "1", "--gate", GATE, ...extraArgs], {
    env: { ...process.env, HOME: home, TMPDIR: roTmp ?? base, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8",
  })
  const log = existsSync(join(hd, "auto-clear.log")) ? readFileSync(join(hd, "auto-clear.log"), "utf8") : ""
  return {
    status: run.status, stderr: run.stderr ?? "",
    keys: existsSync(keys) ? readFileSync(keys, "utf8").trim().split("\n").filter(Boolean) : [],
    log, log1: existsSync(`${logPath}.1`) ? readFileSync(`${logPath}.1`, "utf8") : null,
    base, record, recordBody: existsSync(record) ? readFileSync(record, "utf8") : null,
    record2: existsSync(record + ".2") ? readFileSync(record + ".2", "utf8") : null,
  }
}
