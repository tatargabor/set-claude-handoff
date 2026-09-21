import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyActivity, classifyStream } from "../templates/turn-state.mjs"

// The Mac seat's measured shape (2026-09-21): the prompt row 1358 bytes from the end, followed by
// OSC 52 clipboard paints and an update banner that do not repaint it.
const osc52 = "\x1b]52;c;" + "Y29waWVkIHRleHQ=".repeat(40) + "\x07copied 16 chars to clipboard"
const MAC_IDLE = "…earlier output…\r\n❯\xa0\r\n" + osc52 + " ".repeat(700) + "\r\n✔ Update installed · Restart to update"

test("the measured Mac tail: the old 800-byte window says unknown — activity says idle", () => {
  assert.ok(MAC_IDLE.length - MAC_IDLE.lastIndexOf("❯\xa0") > 800, "fixture reproduces the 1358-byte distance")
  assert.equal(classifyStream(MAC_IDLE), "unknown", "the defect, held in a test")
  assert.equal(classifyActivity(0, MAC_IDLE), "idle")
})

test("any output growth is working — a spinner in fragments or a human typing, never type into it", () => {
  assert.equal(classifyActivity(5963, MAC_IDLE), "working")
  assert.equal(classifyActivity("1", "✻92✽705Beaming…9⏺102"), "working")
})

test("a TUI that exited is not idle, even with its pid still in the roster (measured on the Mac demo seat)", () => {
  assert.equal(classifyActivity(0, "❯\xa0\r\n…\r\nResume this session with: claude --resume ff88dba9-0000"), "exited")
})

test("no prompt row, or no activity number, is unknown", () => {
  assert.equal(classifyActivity(0, "no prompt here"), "unknown")
  assert.equal(classifyActivity("", MAC_IDLE), "unknown")
  assert.equal(classifyActivity("x", MAC_IDLE), "unknown")
})
