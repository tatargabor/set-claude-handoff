import { test } from "node:test"
import assert from "node:assert/strict"
import { runWatcher, SID } from "./helpers/watcher-harness.mjs"

// The bug these guard, measured 2026-11-23: one consumer tree's auto-clear.log had grown to
// 47 MB / 236 385 lines, and one session's identical verdict appeared 879× in its last 3000
// lines — `no <sid> tokens:184211 < 400000 via transcript-fallback (-1s old)`, once per 60 s
// pass, the only change between passes being the token number. The dedupe keys on the verdict's
// SHAPE ($failed with every run of digits replaced by N) and lets a 30-min heartbeat through.

const noLines = (log) => (log.match(/^\S+ no {4}.*$/gm) ?? [])

test("a session below the threshold logs its 'no' verdict ONCE over ~5 one-second passes — measured 2026-11-23: one session's identical verdict appeared 879× in a 47 MB consumer log, once per 60 s pass", () => {
  // idleMin=null: the gate falls back to the transcript mtime, so the freshness age in the
  // detail grows every pass — exactly the digit churn the shape must normalize away.
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
