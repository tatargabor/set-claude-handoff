import { test } from "node:test"
import assert from "node:assert/strict"
import { runWatcher, WORKING_SCREEN } from "./helpers/watcher-harness.mjs"
import { existsSync } from "node:fs"
import { join } from "node:path"

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
  // Several passes ran over the 4 s — but the unchanged verdict logs once now (dedupe: shape +
  // 30-min heartbeat, measured 2026-11-23), so one "no" line is the pass evidence there is.
  assert.equal((r.log.match(/^\S+ no {4}/gm) ?? []).length, 1, `repeated verdict:\n${r.log}`)
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

test("a warm-idle clear logs what its handoff turn cost and records it for the payback — owner request 2026-11-24: 'can we measure what a handoff costs?'", () => {
  const r = runWatcher({ tokens: 250_000, idleMin: 49, marker: true, seconds: 4 })
  assert.match(r.log, /^\S+ cost  \S+  handoff turn: \d+ requests, cache write \d+, cache read \d+, output \d+ ≈ \d+ input-token equivalents; .*\(trigger=warm-idle\)/m, r.log)
})

test("after a warm-idle clear the auto-continue opens with WAITING FOR THE USER and asks for no work — owner request 2026-11-24: a session cleared because it sat idle was waiting for the user, so the user must see that it is their turn", () => {
  // The fresh session id appears after the clear, as the runtime rewrites its record.
  const mutate = `sleep 1.5; f="$TMPDIR/home/.claude/sessions/424242.json"; jq '.sessionId="cafebabe-0000-1111-2222-333344445555"' "$f" > "$f.t" && mv "$f.t" "$f"`
  const r = runWatcher({ tokens: 250_000, idleMin: 49, marker: true, seconds: 6, mutate, extraArgs: ["--auto-continue", "default", "--continue-delay", "1"] })
  const typed = r.keys.find((k) => k.startsWith("-t fake:0.0 -l ") && !k.endsWith("/clear"))
  assert.ok(typed, `a continue prompt was typed:\n${JSON.stringify(r.keys)}\n${r.log}`)
  assert.match(typed, /^-t fake:0\.0 -l WAITING FOR THE USER - /)
  assert.match(typed, /Do NOT start or continue any work/)
  assert.doesNotMatch(typed, /Continue with its CURRENT next step/, "not the working-session continue")
})

test("a SIZE clear keeps the working-session continue — only a warm-idle clear means the session was waiting for the user", () => {
  const mutate = `sleep 1.5; f="$TMPDIR/home/.claude/sessions/424242.json"; jq '.sessionId="cafebabe-0000-1111-2222-333344445555"' "$f" > "$f.t" && mv "$f.t" "$f"`
  const r = runWatcher({ tokens: 410_000, marker: true, seconds: 6, mutate, extraArgs: ["--auto-continue", "default", "--continue-delay", "1"] })
  const typed = r.keys.find((k) => k.startsWith("-t fake:0.0 -l ") && !k.endsWith("/clear"))
  assert.ok(typed, `a continue prompt was typed:\n${JSON.stringify(r.keys)}\n${r.log}`)
  assert.match(typed, /Continue with its CURRENT next step/)
  assert.doesNotMatch(typed, /WAITING FOR THE USER/)
})

test("payback: once the fresh session has made 20 requests, the recorded clear is priced against its handoff cost and the record is removed", () => {
  // A recorded clear (pid, context before, cost, at) and a fresh transcript of 20 small requests.
  const mutate = `sleep 0.2; printf '424242 300000 650000 %s\\n' "$(date +%s)" > "$HD/.cost-0ldsess1"
for i in $(seq 1 20); do printf '{"type":"assistant","timestamp":"2026-11-24T10:00:%02dZ","message":{"id":"f%s","usage":{"input_tokens":0,"cache_read_input_tokens":30000,"cache_creation_input_tokens":0,"output_tokens":10}}}\\n' "$i" "$i" >> "$TDIR/feedface-1111-2222-3333-444455556666.jsonl"; done`
  const r = runWatcher({ tokens: 100_000, seconds: 4, mutate })
  assert.match(r.log, /payback  0ldsess1  after 20 requests of \S+: context 300000 → avg \d+, saved ≈ \d+ vs handoff cost ≈ 650000 → net -?\d+ input-token equivalents/, r.log)
  assert.ok(!existsSync(join(r.base, "proj/.set/handoff/.cost-0ldsess1")), "the record is removed once priced")
})
