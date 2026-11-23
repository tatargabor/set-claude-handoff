import { test } from "node:test"
import assert from "node:assert/strict"
import { runWatcher, WORKING_SCREEN } from "./helpers/watcher-harness.mjs"

// The bug these guard: the runtime compacts an idle 200k+ session by itself ~53.8 min after its last
// request, and no size threshold can come first. Measured 2026-11-23: 122 of 348 auto compactions in
// one product family's trees were idle-triggered. The watcher is the executor of the second trigger.

test("AC-1 watcher: an unarmed 230k session idle 48 min gets /handoff typed once; the record and the log name warm-idle", () => {
  const r = runWatcher({ tokens: 230_000, idleMin: 48 })
  assert.deepEqual(r.keys, ["-t fake:0.0 -l /handoff", "-t fake:0.0 Enter"], `${JSON.stringify(r.keys)}\n${r.log}`)
  assert.match(r.recordBody ?? "", /\/handoff warm-idle$/m, "the record carries the trigger word")
  assert.equal((r.log.match(/^\S+ NUDGE .*trigger=warm-idle/gm) ?? []).length, 1, r.log)
})

test("AC-2 watcher: an armed 250k session idle 49 min is cleared below the 400k threshold, and FIRE names warm-idle", () => {
  const r = runWatcher({ tokens: 250_000, idleMin: 49, marker: true, seconds: 4 })
  assert.deepEqual(r.keys.slice(0, 2), ["-t fake:0.0 -l /clear", "-t fake:0.0 Enter"], `${JSON.stringify(r.keys)}\n${r.log}`)
  assert.match(r.log, /^\S+ FIRE .*\/clear.*trigger=warm-idle/m)
})

test("AC-3 watcher: a 150k session idle 50 min — nothing typed, the log names the floor", () => {
  const r = runWatcher({ tokens: 150_000, idleMin: 50, marker: true, seconds: 3 })
  assert.deepEqual(r.keys, [], r.log)
  assert.match(r.log, /warm-idle: 150000 < floor 200000/)
})

test("AC-4 watcher: unarmed and idle 55 min — nothing typed, and 'warm-idle missed' is logged ONCE over several passes", () => {
  const r = runWatcher({ tokens: 250_000, idleMin: 55, seconds: 4 })
  assert.deepEqual(r.keys, [], r.log)
  assert.equal((r.log.match(/^\S+ warm-idle missed /gm) ?? []).length, 1, r.log)
  assert.ok((r.log.match(/^\S+ no {4}/gm) ?? []).length >= 2, `several passes ran:\n${r.log}`)
})

test("a spinner on the pane: the warm-idle clear waits and never presses Escape (the Escape is for a turn run past the size limit, not for idle)", () => {
  const r = runWatcher({ tokens: 250_000, idleMin: 49, marker: true, screen: WORKING_SCREEN, seconds: 3 })
  assert.deepEqual(r.keys, [], `no key at all, Escape included:\n${r.log}`)
  assert.match(r.log, /warm-idle waits/)
})

test("--idle-minutes 0: the startup line says warm-idle=off and the armed idle session is left alone", () => {
  const r = runWatcher({ tokens: 250_000, idleMin: 49, marker: true, extraArgs: ["--idle-minutes", "0"], seconds: 3 })
  assert.deepEqual(r.keys, [], r.log)
  assert.match(r.log, /watcher started .* warm-idle=off/)
  const on = runWatcher({ tokens: 100_000, seconds: 2 })
  assert.match(on.log, /watcher started .* warm-idle=on \(48 min, floor 200000\)/)
})
