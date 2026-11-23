import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluate, armMarker, NUDGE_PREFIX } from "../templates/clear-gate.mjs"

// The bug these guard: the size path cleared a session whose handoff lagged its work. The arm nudge
// asked at 60 % of the threshold (240k at 400k), and that marker armed the clear at 400k. Everything
// done in between was lost, and no gate on the size path checked the handoff was the last act.
// Owner rule 2026-11-23: the handoff runs right before the clear.

const SID = "c0ffee00-1234-5678"
const S8 = "c0ffee00"
const MIN = 60_000

function session({ tokens = 410_000, timestamp = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hbc-"))
  const tr = join(dir, "t.jsonl")
  const lastAt = Date.now() - 1 * MIN
  writeFileSync(tr, JSON.stringify({ type: "assistant", ...(timestamp ? { timestamp: new Date(lastAt).toISOString() } : {}),
    message: { content: [{ type: "text", text: "done" }], usage: { input_tokens: 0, cache_read_input_tokens: tokens } } }) + "\n")
  if (!timestamp) utimesSync(tr, new Date(lastAt), new Date(lastAt))
  return { dir, tr, lastAt }
}
const at = (t) => new Date(t)
function arm(dir, when) {
  writeFileSync(join(dir, "1123-bbbb--thread.md"), "# thread\n")
  const m = armMarker(dir, SID, "1123-bbbb--thread.md", { passed: true })
  utimesSync(m.path, at(when), at(when))
}
function record(dir, suffix, when, body = "2026-11-23T20:00:00Z /handoff size\n") {
  const p = join(dir, NUDGE_PREFIX + S8 + suffix)
  writeFileSync(p, body); utimesSync(p, at(when), at(when))
}
const run = (s, extra = {}) => evaluate({ dir: s.dir, sessionId: SID, transcriptPath: s.tr, ...extra })
const marker = (r) => r.gates.find((g) => g.name === "marker")

test("AC-5: a handoff that was the last act clears at the threshold; 30 min of work after it fails the marker gate, naming the lag", () => {
  const fresh = session()
  arm(fresh.dir, fresh.lastAt - 20_000)
  const r1 = run(fresh)
  assert.equal(r1.eligible, true, JSON.stringify(r1.gates))
  assert.equal(r1.trigger, "size")

  const stale = session()
  arm(stale.dir, stale.lastAt - 30 * MIN)
  const r2 = run(stale)
  assert.equal(r2.eligible, false)
  assert.match(marker(r2).detail, /STALE: the session worked 30 min after its handoff/)
})

test("AC-2: a stale handoff at the threshold gets /handoff again (record .2) instead of a /clear", () => {
  const s = session()
  record(s.dir, "", s.lastAt - 60 * MIN)       // the first ask…
  arm(s.dir, s.lastAt - 40 * MIN)              // …answered, then 40 more minutes of work
  const r = run(s)
  assert.equal(r.eligible, false)
  assert.equal(r.nudge.due, true, r.nudge.reason)
  assert.equal(r.nudge.record, `${NUDGE_PREFIX}${S8}.2`)
  assert.equal(r.nudge.ask, 2)
  assert.match(r.nudge.reason, /stale handoff \(40 min behind\)/)
})

test("AC-3: an ask not yet answered (record newer than the marker) is not repeated", () => {
  const s = session()
  arm(s.dir, s.lastAt - 40 * MIN)
  record(s.dir, "", s.lastAt - 10 * MIN)
  const r = run(s)
  assert.equal(r.nudge.due, false)
  assert.match(r.nudge.reason, /not answered/)
})

test("AC-4: after three asks the stale session is left to the native compaction, and the reason says so", () => {
  const s = session()
  record(s.dir, "", s.lastAt - 90 * MIN); record(s.dir, ".2", s.lastAt - 70 * MIN); record(s.dir, ".3", s.lastAt - 50 * MIN)
  arm(s.dir, s.lastAt - 40 * MIN)
  const r = run(s)
  assert.equal(r.eligible, false)
  assert.equal(r.nudge.due, false)
  assert.match(r.nudge.reason, /asked 3 times and the handoff is still stale — left to the native compaction/)
})

test("compact-on-background needs a fresh handoff too — a stale marker never compacts", () => {
  const s = session()
  arm(s.dir, s.lastAt - 30 * MIN)
  const r = run(s, { backgroundWorkBlocks: true, compactOnBackground: true })
  assert.notEqual(r.action, "compact")
})

test("no timestamped assistant record: freshness falls back to the transcript's mtime", () => {
  const s = session({ timestamp: false })
  arm(s.dir, s.lastAt - 30 * MIN)
  assert.match(marker(run(s)).detail, /STALE/)
  const f = session({ timestamp: false })
  arm(f.dir, f.lastAt)
  assert.equal(run(f).eligible, true)
})
