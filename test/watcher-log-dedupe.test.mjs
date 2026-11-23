import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { runWatcher, SID, WATCHER } from "./helpers/watcher-harness.mjs"

// The unwritable-TMPDIR proof needs the mkdir to actually fail, which chmod cannot do to root.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0

// The bug these guard, measured 2026-11-23: one consumer tree's auto-clear.log had grown to
// 47 MB / 236 385 lines, and one session's identical verdict appeared 879× in its last 3000
// lines — `no <sid> tokens:184211 < 400000 via transcript-fallback (-1s old)`, once per 60 s
// pass, the only change between passes being the token number. The dedupe keys on the verdict's
// SHAPE ($failed with every run of digits replaced by N) and lets a 30-min heartbeat through.

const noLines = (log) => (log.match(/^\S+ no {4}.*$/gm) ?? [])

test("a session below the threshold logs its 'no' verdict ONCE over ~5 one-second passes — measured 2026-11-23: one session's identical verdict appeared 879× in a 47 MB consumer log, once per 60 s pass", () => {
  // idleMin=null: the gate falls back to the transcript, whose age it cannot know, so the
  // detail's `(-1s old)` is CONSTANT every pass (clear-gate prints `tok.ageSec ?? -1`). These
  // runs therefore never exercise the digit normalisation — with verdict_shape reduced to
  // identity they still pass; the shape itself has its own unit test below.
  const r = runWatcher({ tokens: 100_000, seconds: 6 })
  assert.equal(noLines(r.log).length, 1, `the same-shape verdict repeats:\n${r.log}`)
  assert.deepEqual(JSON.stringify(r.keys), "[]", r.log)
})

test("when the failing gates change, the line logs again — the opt-out file appears mid-run; digits alone never trigger this", () => {
  const r = runWatcher({ tokens: 100_000, seconds: 6,
    mutate: 'sleep 2; printf x > "$HD/.no-autoclear-feedface"' })
  const lines = noLines(r.log)
  assert.equal(lines.length, 2, `expected one line before the opt-out and one after:\n${r.log}`)
  assert.match(lines[1], /optout/, `the second line carries the new failing gate:\n${r.log}`)
  assert.notEqual(lines[0], lines[1], r.log)
  assert.deepEqual(JSON.stringify(r.keys), "[]", r.log)
})

test("the heartbeat: past 30 min of the same shape the line is written again — the session's memory epoch is seeded 1900 s back mid-run", () => {
  const memory = SID.replace(/[^a-zA-Z0-9]/g, "")
  const r = runWatcher({ tokens: 100_000, seconds: 6, mutate: `sleep 2.5
f=$(ls "$TMPDIR"/set-handoff-no-dedupe-*/${memory} 2>/dev/null | head -1)
[ -n "$f" ] || exit 0
shape=$(cut -d' ' -f2- "$f")
printf '%s %s\\n' "$(( $(date +%s) - 1900 ))" "$shape" > "$f"` })
  const lines = noLines(r.log)
  assert.equal(lines.length, 2, `the heartbeat must let exactly one more line through:\n${r.log}`)
})

// The unit the watcher-level runs above cannot reach: their harness detail is constant (see the
// comment on the first test), so with verdict_shape reduced to identity they still pass. This
// runs the REAL function text extracted from templates/watch-auto-clear.sh.
const shapeOf = (detail) => {
  const fn = readFileSync(WATCHER, "utf8").match(/^verdict_shape\(\) \{.*\}$/m)
  assert.ok(fn, "verdict_shape() is defined on a single line in the watcher")
  const r = spawnSync("bash", ["-c", `${fn[0]}\nverdict_shape "$1"`, "shape", detail], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

test("verdict_shape folds every run of digits: a moving token count or a ticking age is the same shape, a different failing gate is not — measured 2026-11-23: the churn 'tokens:184211 … (-1s old)' was one verdict logging 879× because only its digits moved", () => {
  const a = shapeOf("tokens:184211 < 400000 via transcript-fallback (-1s old)")
  const b = shapeOf("tokens:184999 < 400000 via transcript-fallback (-2s old)")
  assert.equal(a, b, "digits alone must never change the shape")
  assert.equal(a, "tokens:N < N via transcript-fallback (-Ns old)")
  assert.equal(shapeOf("idle 55 min"), shapeOf("idle 55.1 min"), "a ticking tenth of a minute is the same moving number")
  assert.equal(shapeOf("idle 55.1 min"), "idle N min", "the decimal age must fold into the same N, not survive as N.N")
  assert.notEqual(a, shapeOf("optout"), "a different gate failing is a different shape")
})

test("the watcher's no-dedupe temp dir is gone when the run is killed — one dir per watcher lifetime accumulated otherwise (every harness run ends by timeout's TERM)", () => {
  const r = runWatcher({ tokens: 100_000, seconds: 3 })
  const left = readdirSync(r.base).filter((n) => n.startsWith("set-handoff-no-dedupe-"))
  assert.deepEqual(left, [], `leftover no-dedupe dirs in ${r.base}:\n${r.log}`)
})

test("a no-dedupe dir that cannot be created is announced in the log — a silently disabled dedupe was silent", { skip: isRoot ? "chmod 555 cannot stop root, so the failure cannot be provoked" : false }, () => {
  const r = runWatcher({ tokens: 100_000, seconds: 3, watcherTmpUnwritable: true })
  assert.match(r.log, /warn  no-dedupe: cannot create \S+ — verdict lines repeat per pass/, r.log)
})

test("a TERM sent to the watcher alone ends it at once, not after the pass's sleep — the INT TERM HUP trap made bash defer the signal until `sleep \"$INTERVAL\"` (60 s in production) ran out", () => {
  const t0 = Date.now()
  const r = runWatcher({ tokens: 100_000, seconds: 2, extraArgs: ["--interval", "30"], termWatcherOnly: true })
  const elapsed = (Date.now() - t0) / 1000
  assert.ok(elapsed < 10, `the watcher took ${elapsed.toFixed(1)} s to stop after its TERM:\n${r.log}`)
  const left = readdirSync(r.base).filter((n) => n.startsWith("set-handoff-no-dedupe-"))
  assert.deepEqual(left, [], `leftover no-dedupe dirs in ${r.base}:\n${r.log}`)
})
