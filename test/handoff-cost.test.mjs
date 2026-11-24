import { test } from "node:test"
import assert from "node:assert/strict"
import { handoffCost, payback } from "../templates/handoff-cost.mjs"

// Owner request 2026-11-24: "can we measure what a handoff costs — is it worth it?" Measured that
// day on one warm-idle clear: ≈ 0.92M input-token equivalents, 80 % of it a cold cache re-write.
const T0 = Date.parse("2026-11-24T10:00:00Z")
const at = (s) => new Date(T0 + s * 1000).toISOString()
const asst = (id, s, u) => JSON.stringify({ type: "assistant", timestamp: at(s), message: { id, usage: u } })
const user = (s, text) => JSON.stringify({ type: "user", timestamp: at(s), message: { content: text } })

test("handoffCost sums the requests after the last user string at or before the marker, each streamed message id once, at the input-equivalent rates", () => {
  const lines = [
    user(0, "do the work"),
    asst("w1", 10, { input_tokens: 1, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0, output_tokens: 100 }),
    user(60, "<command-name>/handoff</command-name>"),
    asst("h1", 70, { input_tokens: 2, cache_creation_input_tokens: 300_000, cache_creation: { ephemeral_1h_input_tokens: 300_000, ephemeral_5m_input_tokens: 0 }, cache_read_input_tokens: 0, output_tokens: 1000 }),
    asst("h1", 71, { input_tokens: 2, cache_creation_input_tokens: 300_000, cache_creation: { ephemeral_1h_input_tokens: 300_000, ephemeral_5m_input_tokens: 0 }, cache_read_input_tokens: 0, output_tokens: 1000 }),
    asst("h2", 80, { input_tokens: 0, cache_creation_input_tokens: 4000, cache_creation: { ephemeral_5m_input_tokens: 4000 }, cache_read_input_tokens: 300_000, output_tokens: 2000 }),
    asst("late", 500, { input_tokens: 0, cache_read_input_tokens: 999_999, output_tokens: 0 }),
  ].join("\n")
  const c = handoffCost(lines, T0 + 90_000, T0 + 120_000)
  assert.equal(c.requests, 2, "h1 streamed twice is one request; the request after <until> is not in the turn")
  assert.equal(c.since, at(60), "the turn starts at the /handoff the nudge typed, not at the earlier work prompt")
  assert.equal(c.contextBefore, 300_001, "the last request before the turn gives the context size the clear removed")
  // h1: 2 + 300000×2 + 1000×5 = 605002; h2: 4000×1.25 + 300000×0.1 + 2000×5 = 45000
  assert.equal(c.equiv, 650_002)
})

test("payback waits for n requests, then prices the smaller context's cache reads against the old size", () => {
  const fresh = (n) => Array.from({ length: n }, (_, i) => asst(`f${i}`, i, { input_tokens: 0, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 0, output_tokens: 10 })).join("\n")
  assert.deepEqual(payback(fresh(5), 300_000, 20), { requests: 5 })
  assert.deepEqual(payback(fresh(25), 300_000, 20), { requests: 20, avgContext: 30_000, savedEquiv: 540_000 })
})
