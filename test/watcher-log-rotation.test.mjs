import { test } from "node:test"
import assert from "node:assert/strict"
import { runWatcher } from "./helpers/watcher-harness.mjs"

// The bug this guards, measured 2026-11-23: one consumer tree's auto-clear.log had grown to
// 47 MB / 236 385 lines. The dedupe (watcher-log-dedupe.test.mjs) stops the flood; size rotation
// is the safety net for whatever else grows: past --log-max-kb the log becomes .1 and the fresh
// file's first line names the rotation and the size.

test("startup rotation: a log already past --log-max-kb becomes .1 — any old .1 replaced — and the fresh file opens with the rotate line naming the size", () => {
  const r = runWatcher({ tokens: 100_000, seconds: 2, extraArgs: ["--log-max-kb", "1"], prefillLogBytes: 2048, staleLog1: true })
  assert.ok(r.log1 != null, `auto-clear.log.1 exists:\n${r.log}`)
  assert.ok(!r.log1.includes("stale"), "the old .1 was replaced")
  assert.equal(r.log1.length, 2048, "the pre-filled content moved whole")
  const first = r.log.split("\n")[0]
  assert.match(first, / rotate /, r.log)
  assert.match(first, /2048 bytes/, `the first line names the size it rotated from:\n${first}`)
})

test("per-pass rotation: a log that crosses the cap DURING the run rotates at the top of a pass — the .1 holds the run's own first lines, so this was not the startup check", () => {
  // 800 B is under the 1 KB cap at start; the watcher's own first lines cross it during pass 1.
  const r = runWatcher({ tokens: 100_000, seconds: 4, extraArgs: ["--log-max-kb", "1"], prefillLogBytes: 800 })
  assert.ok(r.log1 != null, `no rotation happened:\n${r.log}`)
  assert.match(r.log1, /watcher started/, "the .1 must hold this run's own started line — proof of a mid-run rotation, not the startup check")
  assert.match(r.log.split("\n")[0], / rotate /, r.log)
})

test("--log-max-kb 0 is refused at startup with the same exit 2 style — measured: 0 KB rotated on EVERY pass, so the log never held more than one pass's lines", () => {
  const r = runWatcher({ tokens: 100_000, seconds: 2, extraArgs: ["--log-max-kb", "0"] })
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}:\n${r.stderr}`)
  assert.match(r.stderr, /--log-max-kb must be a positive integer \(KB\), got: 0/, r.stderr)
  assert.ok(!r.log.includes("watcher started"), `the watcher must not start:\n${r.log}`)
})
