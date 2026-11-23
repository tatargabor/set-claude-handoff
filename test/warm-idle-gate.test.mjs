import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluate, armMarker, NUDGE_PREFIX } from "../templates/clear-gate.mjs"

// The bug these guard: a size threshold can never precede the runtime's IDLE compaction. Measured
// 2026-11-23 in one product family's consumer trees, 122 of 348 auto compactions (every one of the 40
// under 250k) came after ≥ 45 min idle, median 54.8 min. The only trigger that can be first is a timer.

const SID = "abcdef12-3456-7890"
const S8 = "abcdef12"
const MIN = 60_000

function session({ tokens, idleMin, toolPending = false }) {
  const dir = mkdtempSync(join(tmpdir(), "warm-idle-"))
  const tr = join(dir, "t.jsonl")
  const lastAt = Date.now() - idleMin * MIN
  const content = toolPending ? [{ type: "tool_use", id: "t1" }] : [{ type: "text", text: "done" }]
  writeFileSync(tr, JSON.stringify({ type: "assistant", timestamp: new Date(lastAt).toISOString(),
    message: { content, usage: { input_tokens: 0, cache_read_input_tokens: tokens } } }) + "\n")
  return { dir, tr, lastAt }
}
function arm(dir, at) {
  writeFileSync(join(dir, "1123-aaaa--thread.md"), "# thread\n")
  const m = armMarker(dir, SID, "1123-aaaa--thread.md", { passed: true })
  utimesSync(m.path, new Date(at), new Date(at))
}
const run = (s, extra = {}) => evaluate({ dir: s.dir, sessionId: SID, transcriptPath: s.tr, ...extra })

test("AC-1: a 250k session idle 48 min, unarmed, never nudged → the nudge is due, named warm-idle — and a 230k one too, which the 240k size nudge never asks", () => {
  for (const tokens of [250_000, 230_000]) {
  const s = session({ tokens, idleMin: 48 })
  const r = run(s)
  assert.equal(r.idle.due, true, r.idle.reason)
  assert.equal(r.eligible, false, "unarmed: never cleared")
  assert.equal(r.nudge.due, true, r.nudge.reason)
  assert.equal(r.nudge.trigger, "warm-idle")
  }
})

test("AC-2: a 250k session idle 49 min with a passing marker from its last act → eligible, trigger warm-idle, below the 400k threshold", () => {
  const s = session({ tokens: 250_000, idleMin: 49 })
  arm(s.dir, s.lastAt)
  const r = run(s)
  assert.equal(r.eligible, true, JSON.stringify(r.gates))
  assert.equal(r.action, "clear")
  assert.equal(r.trigger, "warm-idle")
})

test("AC-3: a 150k session idle 50 min → nothing due, and the verdict names the floor", () => {
  const s = session({ tokens: 150_000, idleMin: 50 })
  arm(s.dir, s.lastAt)
  const r = run(s)
  assert.equal(r.idle.due, false)
  assert.match(r.idle.reason, /floor 200000/)
  assert.equal(r.eligible, false)
  assert.match(r.gates.find((g) => g.name === "tokens").detail, /warm-idle: 150000 < floor 200000/)
})

test("AC-4: idle 55 min with no armed handoff → no clear and no nudge (the runtime's compaction is under way); the reason says the warm window was missed", () => {
  const s = session({ tokens: 250_000, idleMin: 55 })
  const r = run(s)
  assert.equal(r.idle.late, true)
  assert.match(r.idle.reason, /warm window missed/)
  assert.equal(r.eligible, false)
  assert.equal(r.nudge.due, false, "not even the size nudge types into a compacting session")
})

test("AC-5: a turn that is not idle is never due for idle, however old the last record", () => {
  const s = session({ tokens: 250_000, idleMin: 50, toolPending: true })
  arm(s.dir, s.lastAt)
  const r = run(s)
  assert.equal(r.idle.due, false)
  assert.match(r.idle.reason, /turn not idle/)
  assert.equal(r.eligible, false)
})

test("an armed handoff OLDER than the last work is not cleared for idle — measured in the audit: 6 of 15 clear pairs had > 30 min of work after the last handoff write", () => {
  const s = session({ tokens: 250_000, idleMin: 49 })
  arm(s.dir, s.lastAt - 120 * MIN)
  const r = run(s)
  assert.equal(r.idle.due, false)
  assert.match(r.idle.reason, /older than the last work/)
  assert.equal(r.eligible, false)
})

test("a handoff written after a warm-idle nudge is cleared at once, not 48 minutes later — the nudge's own turn restarts the idle clock", () => {
  const s = session({ tokens: 250_000, idleMin: 1 })
  writeFileSync(join(s.dir, NUDGE_PREFIX + S8), "2026-11-23T20:00:00Z /handoff warm-idle\n")
  utimesSync(join(s.dir, NUDGE_PREFIX + S8), new Date(s.lastAt - 5 * MIN), new Date(s.lastAt - 5 * MIN))
  arm(s.dir, s.lastAt)
  const r = run(s)
  assert.equal(r.eligible, true, r.idle.reason)
  assert.equal(r.trigger, "warm-idle")
  // …but a SIZE nudge's record does not shortcut the clock
  writeFileSync(join(s.dir, NUDGE_PREFIX + S8), "2026-11-23T20:00:00Z /handoff\n")
  utimesSync(join(s.dir, NUDGE_PREFIX + S8), new Date(s.lastAt - 5 * MIN), new Date(s.lastAt - 5 * MIN))
  assert.equal(run(s).eligible, false)
})

test("--idle-minutes 0 turns the warm-idle trigger off", () => {
  const s = session({ tokens: 250_000, idleMin: 50 })
  arm(s.dir, s.lastAt)
  const r = run(s, { idleMinutes: 0 })
  assert.equal(r.idle.reason, "off")
  assert.equal(r.eligible, false)
})
