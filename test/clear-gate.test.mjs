import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { armMarker, evaluate, readTokens, sessionStartAt } from "../templates/clear-gate.mjs"

const tmp = () => mkdtempSync(join(tmpdir(), "gate-"))

const GOOD_TRANSCRIPT = (p) => writeFileSync(p, JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 500_000 } },
  stop_reason: "end_turn",
}) + "\n")

test("a failing gate must never arm a session — a handoff that did not pass leaves no marker", () => {
  const dir = tmp()
  const r = armMarker(dir, "session-abcd1234", "0912-abcd--x.md", { passed: false })
  assert.equal(r.wrote, false)
  assert.equal(existsSync(r.path), false)
})

test("another session's handoff must not arm this session — parallel threads share one tree", () => {
  const dir = tmp()
  armMarker(dir, "aaaaaaaa-1111", "0912-aaaa--other-thread.md", { passed: true })
  const res = evaluate({ dir, sessionId: "bbbbbbbb-2222", threshold: 1, transcriptPath: null, backgroundWorkBlocks: false })
  const marker = res.gates.find((g) => g.name === "marker")
  assert.equal(marker.ok, false, "sibling marker must not arm session b")
})

test("an unknown context size must never read as above-threshold — stale or missing is not eligible", () => {
  const dir = tmp()
  const tok = readTokens({ tokensFile: join(dir, ".context-tokens"), transcriptPath: null })
  assert.equal(tok.tokens, null)
  const res = evaluate({ dir, sessionId: "aaaaaaaa-1111", backgroundWorkBlocks: false })
  assert.equal(res.gates.find((g) => g.name === "tokens").ok, false)
})

test("a stale token file must not arm the clear — the freshness bound guards a vanished statusline", () => {
  const dir = tmp()
  const f = join(dir, ".context-tokens")
  writeFileSync(f, JSON.stringify({ totalInputTokens: 900000, updatedAt: new Date(Date.now() - 3600_000).toISOString() }))
  const tok = readTokens({ tokensFile: f, freshnessSec: 300 })
  assert.equal(tok.tokens, null, "hour-old numbers are unknown, not above-threshold")
})

test("the transcript fallback supplies the number when the statusline file is absent — documented formula", () => {
  const dir = tmp()
  const tr = join(dir, "t.jsonl")
  GOOD_TRANSCRIPT(tr)
  const tok = readTokens({ tokensFile: join(dir, ".context-tokens"), transcriptPath: tr })
  assert.equal(tok.tokens, 500_030) // 10 + 20 + 500_000 — cache_read is the dominant term
  assert.equal(tok.source, "transcript-fallback")
})

test("a pending permission prompt must block the clear — a dialog swallows the executor's keystrokes", () => {
  const dir = tmp()
  const tr = join(dir, "t.jsonl")
  writeFileSync(tr, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }) + "\n")
  const res = evaluate({ dir, sessionId: "aaaaaaaa-1111", threshold: 1, transcriptPath: tr, backgroundWorkBlocks: false })
  const idle = res.gates.find((g) => g.name === "idle")
  assert.equal(idle.ok, false)
  assert.match(idle.detail, /awaiting result/)
})

test("a tool call left without its result must block — mid-turn is not idle", () => {
  const dir = tmp()
  const tr = join(dir, "t.jsonl")
  writeFileSync(tr, [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "and now?" }] } }),
  ].join("\n") + "\n")
  const res = evaluate({ dir, sessionId: "aaaaaaaa-1111", threshold: 1, transcriptPath: tr, backgroundWorkBlocks: false })
  assert.equal(res.gates.find((g) => g.name === "idle").ok, false, "unanswered user message = mid-turn")
})

test("all gates hold → eligible — the one path that may ever fire", () => {
  const dir = tmp()
  const tr = join(dir, "t.jsonl")
  GOOD_TRANSCRIPT(tr)
  const tokf = join(dir, ".context-tokens")
  writeFileSync(tokf, JSON.stringify({ totalInputTokens: 520_000, updatedAt: new Date().toISOString() }))
  armMarker(dir, "aaaaaaaa-1111", "0912-aaaa--thread.md", { passed: true })
  writeFileSync(join(dir, "0912-aaaa--thread.md"), "# handoff\n\nBackground: none left.\n")
  const res = evaluate({ dir, sessionId: "aaaaaaaa-1111", threshold: 500_000, transcriptPath: tr, backgroundWorkBlocks: true })
  assert.equal(res.eligible, true, JSON.stringify(res.gates))
})

test("backgroundWorkBlocks=true blocks unless the armed handoff declares 'none' — fail-closed on unreadable declarations", () => {
  const dir = tmp()
  const tr = join(dir, "t.jsonl")
  GOOD_TRANSCRIPT(tr)
  const tokf = join(dir, ".context-tokens")
  writeFileSync(tokf, JSON.stringify({ totalInputTokens: 520_000, updatedAt: new Date().toISOString() }))
  armMarker(dir, "aaaaaaaa-1111", "0912-aaaa--thread.md", { passed: true })
  writeFileSync(join(dir, "0912-aaaa--thread.md"), "# handoff — background state not stated anywhere\n")
  const res = evaluate({ dir, sessionId: "aaaaaaaa-1111", threshold: 500_000, transcriptPath: tr, backgroundWorkBlocks: true })
  assert.equal(res.eligible, false, "an unresolvable declaration is not a 'none'")
})

test("a stale statusline file must not starve the transcript fallback — the short-circuit starved 1061 of 1742 armed-night verdicts (2026-09-13)", () => {
  const dir = tmp()
  const f = join(dir, ".context-tokens")
  writeFileSync(f, JSON.stringify({ totalInputTokens: 900000, updatedAt: new Date(Date.now() - 3600_000).toISOString() }))
  const tr = join(dir, "t.jsonl")
  GOOD_TRANSCRIPT(tr)
  const tok = readTokens({ tokensFile: f, transcriptPath: tr, freshnessSec: 300 })
  assert.equal(tok.source, "transcript-fallback", "a stale candidate falls through; the session's own transcript decides")
  assert.equal(tok.tokens, 500_030)
})

test("a session must never arm from the shared token file — two sessions in one repo overwrote each other's numbers (9.3)", () => {
  const dir = tmp()
  // A FRESH shared file, but its number belongs to ANOTHER session's statusline render.
  writeFileSync(join(dir, ".context-tokens"), JSON.stringify({ totalInputTokens: 900_000, updatedAt: new Date().toISOString() }))
  const res = evaluate({ dir, sessionId: "aaaaaaaa-1111", threshold: 500_000, transcriptPath: null, backgroundWorkBlocks: false })
  const tokens = res.gates.find((g) => g.name === "tokens")
  assert.equal(tokens.ok, false, "another session's fresh number is still not THIS session's number")
})

test("the session's own per-session token file arms the gate — the 9.3 fix direction", () => {
  const dir = tmp()
  writeFileSync(join(dir, ".context-tokens-aaaaaaaa"), JSON.stringify({ totalInputTokens: 600_000, updatedAt: new Date().toISOString() }))
  const res = evaluate({ dir, sessionId: "aaaaaaaa-1111", threshold: 500_000, transcriptPath: null, backgroundWorkBlocks: false })
  const tokens = res.gates.find((g) => g.name === "tokens")
  assert.equal(tokens.ok, true)
  assert.match(tokens.detail, /statusline/)
})

test("the start check must find the runtime's own <pid>.json — the old dot-filter skipped every record file", () => {
  const home = mkdtempSync(join(tmpdir(), "home-"))
  const sessions = join(home, ".claude", "sessions")
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, "3014805.json"), JSON.stringify({ sessionId: "9adce541-c3d3", startedAt: 1000 }))
  writeFileSync(join(sessions, "3014805.deadbeef.key"), "noise")
  const prev = process.env.HOME
  process.env.HOME = home
  try {
    assert.equal(sessionStartAt("9adce541-c3d3"), 1000)
  } finally { process.env.HOME = prev }
})

test("a restored process must not disown the session's marker — identity is the id, the earliest start wins", () => {
  const home = mkdtempSync(join(tmpdir(), "home-"))
  const sessions = join(home, ".claude", "sessions")
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, "1.json"), JSON.stringify({ sessionId: "9adce541-c3d3", startedAt: 1000 }))
  writeFileSync(join(sessions, "2.json"), JSON.stringify({ sessionId: "9adce541-c3d3", startedAt: 9000 }))
  const prev = process.env.HOME
  process.env.HOME = home
  try {
    assert.equal(sessionStartAt("9adce541-c3d3"), 1000)
  } finally { process.env.HOME = prev }
})

test("an opt-out marker blocks the clear even when every other gate holds — the per-session kill switch", () => {
  const dir = tmp()
  const tr = join(dir, "t.jsonl")
  GOOD_TRANSCRIPT(tr)
  writeFileSync(join(dir, ".context-tokens-aaaaaaaa"), JSON.stringify({ totalInputTokens: 600_000, updatedAt: new Date().toISOString() }))
  armMarker(dir, "aaaaaaaa-1111", "0912-aaaa--thread.md", { passed: true })
  writeFileSync(join(dir, "0912-aaaa--thread.md"), "# handoff\n\nBackground: none left.\n")
  const without = evaluate({ dir, sessionId: "aaaaaaaa-1111", threshold: 500_000, transcriptPath: tr, backgroundWorkBlocks: true })
  assert.equal(without.eligible, true)
  writeFileSync(join(dir, ".no-autoclear-aaaaaaaa"), "user asked 2026-09-13\n")
  const withOptOut = evaluate({ dir, sessionId: "aaaaaaaa-1111", threshold: 500_000, transcriptPath: tr, backgroundWorkBlocks: true })
  assert.equal(withOptOut.eligible, false, "the user's disable must beat every other gate")
  assert.match(withOptOut.gates.find((g) => g.name === "optout").detail, /disabled for this session/)
})
