import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { runWatcher } from "./helpers/watcher-harness.mjs"

test("an unarmed idle session AT the threshold gets /handoff typed exactly ONCE (the handoff runs right before the clear) — measured 2026-11-23: 80 of 141 watched sessions in one consumer tree never armed, so no clear could ever fire", () => {
  const r = runWatcher({ tokens: 410_000 }) // ≥ the 400k threshold: the ask comes at the clear point
  assert.deepEqual(r.keys, ["-t fake:0.0 -l /handoff", "-t fake:0.0 Enter"], `keys typed: ${JSON.stringify(r.keys)}\n${r.log}`)
  assert.ok(existsSync(r.record), "the nudge is recorded")
  assert.equal((r.log.match(/^\S+ NUDGE /gm) ?? []).length, 1, r.log)
  // The later passes still run but stay silent now: an unchanged verdict is deduped to shape
  // changes + a 30-min heartbeat (measured 2026-11-23: it repeated 879× in a 47 MB consumer
  // log). That nothing is ever re-typed is pinned by the keys assertion above.
  assert.match(r.log, /^\S+ no {4}/m, `the asking pass logged its verdict:\n${r.log}`)
})

test("the arm nudge stays quiet below the ratio, for an armed session, and with --arm-nudge false", () => {
  assert.deepEqual(runWatcher({ tokens: 260_000, seconds: 3 }).keys, [], "260k < 400k: the former 60 % no longer asks")
  assert.deepEqual(runWatcher({ tokens: 350_000, marker: true, seconds: 3 }).keys, [], "an armed session below the threshold: nothing")
  assert.deepEqual(runWatcher({ tokens: 410_000, extraArgs: ["--arm-nudge", "false"], seconds: 3 }).keys, [], "the off switch")
})

test("a STALE handoff at the threshold: /handoff is typed again (record .2), never /clear — the 240k handoff used to arm a 400k clear that lost the work in between", () => {
  const r = runWatcher({ tokens: 410_000, idleMin: 1, marker: true, markerAgeMin: 40, nudgeRecord: "x /handoff size\n", nudgeRecordAgeMin: 60, seconds: 4 })
  assert.deepEqual(r.keys, ["-t fake:0.0 -l /handoff", "-t fake:0.0 Enter"], `${JSON.stringify(r.keys)}\n${r.log}`)
  assert.match(r.record2 ?? "", /\/handoff size$/m, "the second ask is recorded as .2")
  assert.match(r.log, /^\S+ NUDGE .*ask 2\/3; stale handoff \(39 min behind\)/m)
})
