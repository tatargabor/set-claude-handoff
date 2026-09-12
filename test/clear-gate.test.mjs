import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { armMarker, evaluate, readTokens } from "../templates/clear-gate.mjs"

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
