import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { runWatcher } from "./helpers/watcher-harness.mjs"

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
