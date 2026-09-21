import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  DEFAULTS, appendEntry, bindSession, captureDictations, charterBlock, classifyPrompt, logTyped, optoutState, parseDirective, readReload,
  readThread, session8, silenceCounts, threadOf, writeReload,
} from "../templates/autopilot/ledger.mjs"
import { buildInjection, previousSessionOf } from "../templates/hooks/handoff-reinject-clear.mjs"
import { classifyInputRow, classifyStream, safeToType } from "../templates/presence.mjs"
import { classifyScreen, classifyStream as turnClassifyStream, fireLockState, safeToClear, transcriptSaysSubmitted } from "../templates/turn-state.mjs"
import { decisionItems, validate } from "../templates/autopilot/validate.mjs"
import { evaluate as driftEvaluate } from "../templates/autopilot/drift-guard.mjs"
import { capturePrompt } from "../templates/autopilot/capture-prompt.mjs"
import { captureAnswer } from "../templates/autopilot/capture-answer.mjs"
import { answerDialog } from "../templates/autopilot/answer-dialog.mjs"
import { answerStop } from "../templates/autopilot/answer-stop.mjs"

const AP = join(fileURLToPath(new URL("..", import.meta.url)), "templates", "autopilot")
const SID = "aaaaaaaa-1111-2222-3333"
const CONTINUE = "Autopilot continue after an automatic /clear (auto-continue): read the reloaded handoff in full and continue with its current next step."
const HUMAN = "igen, javítsd a resolver három hibáját, GLM-en teszteld"

function tree() {
  const cwd = mkdtempSync(join(tmpdir(), "autopilot-"))
  const dir = join(cwd, ".set", "handoff")
  mkdirSync(dir, { recursive: true })
  return { cwd, dir }
}

function handoff(dir, { id = "0913-abcd", decisions = "" } = {}) {
  writeFileSync(join(dir, `${id}--resolver-fixes.md`), [
    `# HANDOFF: resolver-fixes · ID: ${id}`, "", "**In one sentence:** fix the three resolver bugs, test on GLM", "",
    "## 3. What is blocked — DECISION or WORK", "", "**Waiting on user decision:**", decisions, "**Agent work remains:** none", "",
    "## 5. Next steps, in order", "", "1. fix resolver bug two", "",
  ].join("\n"))
  return id
}

function boundThread(dir, opts) {
  const id = handoff(dir, opts)
  bindSession(dir, SID, id)
  return id
}

const ctxFor = (id, entries, extra = {}) => ({
  threadId: id, bound: true, entries, optout: { off: false }, silence: silenceCounts(entries), config: {},
  question: "Shall I continue with the resolver fixes?", decisionItems: [], handoffFound: true, ...extra,
})
const detail = (v, name) => v.checks.find((c) => c.name === name)?.detail ?? ""
const verdictOn = (entry, quote, extra = {}) => ({ class: "DERIVABLE", answer: "Yes, continue.", evidence: [{ entryId: entry.id, quote }], ...extra })

// ── provenance (intent-ledger) ───────────────────────────────────────────────

test("the watcher's continue prompt was recorded as origin:human/typed (measured 2026-09-13) — a typed-log match is machine-typed", () => {
  const { dir } = tree()
  logTyped(dir, { kind: "continue", text: CONTINUE })
  assert.equal(classifyPrompt(dir, CONTINUE).source, "machine-typed")
  assert.equal(classifyPrompt(dir, HUMAN).source, "human-typed")
})

test("the 10:04:22 fusion of a half-typed human line with the continue prompt is mixed — and never evidence", () => {
  const { dir } = tree()
  const id = boundThread(dir)
  logTyped(dir, { kind: "continue", text: CONTINUE })
  const fused = `glm is jo lehet\x15${CONTINUE}`
  const cls = classifyPrompt(dir, fused)
  assert.equal(cls.source, "mixed")
  const e = appendEntry(dir, { sessionId: SID, source: cls.source, text: fused })
  const v = validate(verdictOn(e, "glm is jo lehet Autopilot"), ctxFor(id, readThread(dir, id)))
  assert.equal(v.ok, false)
  assert.match(detail(v, "evidence"), /mixed — never evidence/)
})

test("an automatic answer, machine-typed text, or a bare (Recommended) label is never evidence", () => {
  const { dir } = tree()
  const id = boundThread(dir)
  for (const source of ["auto-answer", "machine-typed"]) {
    const e = appendEntry(dir, { sessionId: SID, source, text: "continue the resolver fixes on GLM" })
    const v = validate(verdictOn(e, "continue the resolver fixes"), ctxFor(id, readThread(dir, id)))
    assert.equal(v.ok, false, `${source} must not pass`)
  }
  const pick = appendEntry(dir, { sessionId: SID, source: "human-picked", text: "Fix it now? → Fix now (Recommended)" })
  const v = validate(verdictOn(pick, "(Recommended)"), ctxFor(id, readThread(dir, id)))
  assert.equal(v.ok, false)
  assert.match(detail(v, "evidence"), /Recommended/)
})

test("entries captured before the thread existed are folded into it when the session binds", () => {
  const { dir } = tree()
  appendEntry(dir, { sessionId: SID, source: "human-typed", text: HUMAN })
  const id = boundThread(dir)
  const entries = readThread(dir, id)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].thread, id)
  assert.equal(existsSync(join(dir, "ledger", "s-aaaaaaaa.jsonl")), false)
})

// ── prompt switch (auto-answer; user requirement 2026-09-13) ─────────────────

test("'autopilot ki' switches the session off before the agent's turn; 'autopilot be' switches it back on", () => {
  const { cwd, dir } = tree()
  const off = capturePrompt({ session_id: SID, cwd, source: "user", prompt: "autopilot ki, ezt most én viszem" })
  assert.equal(optoutState(dir, SID).session, true)
  assert.match(off.context, /OFF for this session/)
  const on = capturePrompt({ session_id: SID, cwd, source: "user", prompt: "autopilot be" })
  assert.equal(optoutState(dir, SID).off, false)
  assert.match(on.context, /ON/)
  capturePrompt({ session_id: SID, cwd, source: "user", prompt: "autopilot off project" })
  assert.equal(optoutState(dir, SID).tree, true)
  const stillOff = capturePrompt({ session_id: SID, cwd, source: "user", prompt: "autopilot on" })
  assert.match(stillOff.context, /still OFF/)
})

test("a machine-typed prompt carrying the directive flips nothing and is logged as ignored", () => {
  const { cwd, dir } = tree()
  logTyped(dir, { kind: "continue", text: "autopilot off" })
  const r = capturePrompt({ session_id: SID, cwd, source: "user", prompt: "autopilot off" })
  assert.ok(r.ignored)
  assert.equal(optoutState(dir, SID).off, false)
  assert.match(readFileSync(join(dir, "autopilot.log"), "utf8"), /directive-ignored/)
})

test("a sentence that merely mentions the switch does not flip it — only a line-initial directive does", () => {
  assert.equal(parseDirective("we should test what autopilot off does to the watcher"), null)
  assert.deepEqual(parseDirective("autopilot off project").scope, "project")
  assert.equal(parseDirective("kapcsold ki az autopilotot").on, false)
})

// ── drift guard ──────────────────────────────────────────────────────────────

const noJudge = { ...DEFAULTS, judgeCommand: null }

test("an mtime-chosen reload (08:46:52Z — another worktree's thread) is never auto-continued", () => {
  const { cwd, dir } = tree()
  boundThread(dir)
  writeReload(dir, SID, { choice: "mtime", id: "0912-ff48" })
  const r = driftEvaluate({ dir, sessionId: SID, cwd, config: noJudge })
  assert.equal(r.continue, false)
  assert.match(r.checks.find((c) => c.name === "bound").detail, /reload chosen by mtime/)
})

test("a session with no binding at all is not continued, and says why", () => {
  const { cwd, dir } = tree()
  const r = driftEvaluate({ dir, sessionId: SID, cwd, config: noJudge })
  assert.equal(r.continue, false)
  assert.match(r.checks.find((c) => c.name === "bound").detail, /unbound/)
})

test("the silence budget holds the continue prompt after N machine continuations; one human entry resets it", () => {
  const { cwd, dir } = tree()
  boundThread(dir)
  appendEntry(dir, { sessionId: SID, source: "human-typed", text: HUMAN })
  for (let i = 0; i < 3; i++) appendEntry(dir, { sessionId: SID, source: "machine-typed", text: CONTINUE, ref: { kind: "continue" } })
  assert.equal(driftEvaluate({ dir, sessionId: SID, cwd, config: noJudge }).continue, false)
  appendEntry(dir, { sessionId: SID, source: "human-typed", text: "mehet tovább" })
  assert.equal(driftEvaluate({ dir, sessionId: SID, cwd, config: noJudge }).continue, true)
})

test("a judge error counts as unclear — no continuation; without a judge the skip is announced", () => {
  const { cwd, dir } = tree()
  boundThread(dir)
  const r = driftEvaluate({ dir, sessionId: SID, cwd, config: { ...DEFAULTS, judgeCommand: ["judge"] }, judge: () => ({ verdict: null, error: "boom", latencyMs: 1 }) })
  assert.equal(r.continue, false)
  assert.match(r.checks.find((c) => c.name === "alignment").detail, /unclear — boom/)
  const skipped = driftEvaluate({ dir, sessionId: SID, cwd, config: noJudge })
  assert.match(skipped.checks.find((c) => c.name === "alignment").detail, /skipped — no judge configured/)
})

// ── validator (auto-answer) ──────────────────────────────────────────────────

test("a fabricated quote fails — the judge's plausible derivation is exactly what the quote check exists for", () => {
  const { dir } = tree()
  const id = boundThread(dir)
  const e = appendEntry(dir, { sessionId: SID, source: "human-typed", text: HUMAN })
  const v = validate(verdictOn(e, "yes, deploy the resolver to production"), ctxFor(id, readThread(dir, id)))
  assert.equal(v.ok, false)
  assert.match(detail(v, "evidence"), /not verbatim/)
  const ok = validate(verdictOn(e, "javítsd a resolver három hibáját"), ctxFor(id, readThread(dir, id)))
  assert.equal(ok.ok, true, JSON.stringify(ok.checks))
})

test("a quote from another thread's entry fails", () => {
  const { dir } = tree()
  const id = boundThread(dir)
  const foreign = { id: "x1", at: new Date().toISOString(), thread: "0912-ff48", source: "human-typed", text: HUMAN }
  const v = validate(verdictOn(foreign, "javítsd a resolver három hibáját"), ctxFor(id, [foreign]))
  assert.match(detail(v, "evidence"), /belongs to thread 0912-ff48/)
})

test("a question touching a handoff §3 decision item is never answered, even with a human quote", () => {
  const { dir } = tree()
  const id = boundThread(dir, { decisions: "- who takes over kezzi-kiegyenlites (5 critical findings)?\n" })
  const items = decisionItems(readFileSync(join(dir, `${id}--resolver-fixes.md`), "utf8"))
  assert.equal(items.length, 1)
  const e = appendEntry(dir, { sessionId: SID, source: "human-typed", text: "a kezzi-kiegyenlites kritikus hibáit te vidd" })
  const v = validate(verdictOn(e, "kezzi-kiegyenlites kritikus hibáit"), ctxFor(id, readThread(dir, id), {
    decisionItems: items, question: "Who takes over kezzi-kiegyenlites and its 5 critical findings?",
  }))
  assert.equal(v.ok, false)
  assert.match(detail(v, "decision-item"), /kezzi-kiegyenlites/)
})

test("a deny-listed action is refused even when a human quote supports it", () => {
  const { dir } = tree()
  const id = boundThread(dir)
  const e = appendEntry(dir, { sessionId: SID, source: "human-typed", text: "ha kész, told fel nyugodtan a mainre" })
  const v = validate(verdictOn(e, "told fel nyugodtan a mainre"), ctxFor(id, readThread(dir, id), { question: "Shall I git push to origin main now?" }))
  assert.equal(v.ok, false)
  assert.match(detail(v, "deny-list"), /push/)
})

test("a judge-reported confidence alone never passes — no evidence, no answer", () => {
  const { dir } = tree()
  const id = boundThread(dir)
  const v = validate({ class: "DERIVABLE", answer: "yes", confidence: 0.99, evidence: [] }, ctxFor(id, []))
  assert.equal(v.ok, false)
  assert.match(detail(v, "evidence"), /no evidence cited/)
})

test("judge recursion: with AUTOPILOT_JUDGE=1 every autopilot hook exits 0, prints nothing, writes nothing", () => {
  const { cwd, dir } = tree()
  const payload = JSON.stringify({ session_id: SID, cwd, prompt: HUMAN, source: "user", tool_use_id: "toolu_1", tool_input: { questions: [{ question: "Q?", options: [] }] }, last_assistant_message: "Shall I continue?" })
  for (const hook of ["capture-prompt.mjs", "capture-answer.mjs", "answer-dialog.mjs", "answer-stop.mjs"]) {
    const r = spawnSync(process.execPath, [join(AP, hook)], { input: payload, env: { ...process.env, AUTOPILOT_JUDGE: "1" }, encoding: "utf8" })
    assert.equal(r.status, 0, hook)
    assert.equal(r.stdout, "", hook)
  }
  assert.deepEqual(readdirSync(dir), [])
})

// ── answer hooks ─────────────────────────────────────────────────────────────

function transcript(cwd) {
  const p = join(cwd, "t.jsonl")
  writeFileSync(p, JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "…" }] } }) + "\n")
  return p
}

test("probe P3: a rewake answer computed while the human typed is discarded, not delivered stale", () => {
  const { cwd, dir } = tree()
  boundThread(dir)
  const e = appendEntry(dir, { sessionId: SID, source: "human-typed", text: HUMAN })
  const tp = transcript(cwd)
  const judge = () => {
    appendFileSync(tp, JSON.stringify({ type: "user", uuid: "u2", message: { content: "I prefer green, actually" } }) + "\n")
    return { verdict: verdictOn(e, "javítsd a resolver három hibáját"), error: null, latencyMs: 20_000 }
  }
  const ev = { session_id: SID, cwd, transcript_path: tp, last_assistant_message: "Bug one is fixed.\n\nShall I continue with the resolver fixes?", background_tasks: [] }
  assert.equal(answerStop(ev, { judge, statusOf: () => "idle" }), null)
  assert.match(readFileSync(join(dir, "autopilot.log"), "utf8"), /discarded/)
})

test("an undisturbed prose stop is answered — labeled automatic, quoting the human, recorded auto-answer", () => {
  const { cwd, dir } = tree()
  const id = boundThread(dir)
  const e = appendEntry(dir, { sessionId: SID, source: "human-typed", text: HUMAN })
  const ev = { session_id: SID, cwd, transcript_path: transcript(cwd), last_assistant_message: "Bug one is fixed.\n\nShall I continue with the resolver fixes?", background_tasks: [] }
  const out = answerStop(ev, { judge: () => ({ verdict: verdictOn(e, "javítsd a resolver három hibáját"), error: null, latencyMs: 5 }), statusOf: () => "idle" })
  assert.match(out.message, /^\[autopilot\] Automatic answer .*javítsd a resolver három hibáját/)
  assert.equal(readThread(dir, id).at(-1).source, "auto-answer")
})

test("probe P1b: a hook answer is indistinguishable from a pick — so it carries the label and is never logged human-picked", () => {
  const { cwd, dir } = tree()
  const id = boundThread(dir)
  const e = appendEntry(dir, { sessionId: SID, source: "human-typed", text: HUMAN })
  const q = "Continue the resolver fixes now?"
  const ev = { session_id: SID, cwd, tool_use_id: "toolu_01abc", tool_input: { questions: [{ question: q, header: "Next", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }] } }
  const out = answerDialog(ev, { judge: () => ({ verdict: { ...verdictOn(e, "javítsd a resolver három hibáját"), answer: "Yes" }, error: null, latencyMs: 5 }) })
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow")
  assert.match(out.hookSpecificOutput.updatedInput.answers[q], /^Yes — \[autopilot: automatic answer/)
  captureAnswer({ ...ev, tool_response: { answers: out.hookSpecificOutput.updatedInput.answers } })
  const sources = readThread(dir, id).map((x) => x.source)
  assert.deepEqual(sources, ["human-typed", "auto-answer"])
})

test("a dialog with one derivable and one new question is shown unchanged — no partial answer", () => {
  const { cwd, dir } = tree()
  const id = boundThread(dir)
  const e = appendEntry(dir, { sessionId: SID, source: "human-typed", text: HUMAN })
  let n = 0
  const judge = () => (++n === 1
    ? { verdict: verdictOn(e, "javítsd a resolver három hibáját"), error: null, latencyMs: 5 }
    : { verdict: { class: "NEW", answer: "", evidence: [] }, error: null, latencyMs: 5 })
  const ev = { session_id: SID, cwd, tool_use_id: "toolu_02", tool_input: { questions: [{ question: "Continue the fixes?", options: [] }, { question: "Which of two designs?", options: [] }] } }
  assert.equal(answerDialog(ev, { judge }), null)
  assert.equal(readThread(dir, id).filter((x) => x.source === "auto-answer").length, 0)
})

// ── background wait (user screenshot 2026-09-13, b955a632) ──────────────────

const WAITING = "Arm HX is still running. If you want to act before that, ideas 2 (alias table) and 6 (disagreement flag) are the cheapest first steps. They do not depend on the HX result."

test("b955a632 case: independent steps offered while background work runs are continued when the human's direction covers them", () => {
  const { cwd, dir } = tree()
  boundThread(dir)
  const e = appendEntry(dir, { sessionId: SID, source: "human-typed", text: "amíg fut a HX, dolgozz tovább az alias táblán és a disagreement flagen" })
  const verdict = { class: "PARALLEL", answer: "Continue with the alias table and the disagreement flag while HX runs.", evidence: [{ entryId: e.id, quote: "dolgozz tovább az alias táblán" }], independence: "They do not depend on the HX result." }
  const ev = { session_id: SID, cwd, transcript_path: transcript(cwd), last_assistant_message: WAITING, background_tasks: [{ id: "b1" }] }
  const out = answerStop(ev, { judge: () => ({ verdict, error: null, latencyMs: 5 }), statusOf: () => "idle" })
  assert.match(out.message, /alias table/)

  const noStatement = { ...ev, transcript_path: transcript(cwd), last_assistant_message: WAITING.replace(" They do not depend on the HX result.", "") }
  assert.equal(answerStop(noStatement, { judge: () => ({ verdict, error: null, latencyMs: 5 }), statusOf: () => "idle" }), null)
})

test("b955a632 case: a step that needs the running result is not answered, and the client's prompt suggestion is never evidence", () => {
  const { cwd, dir } = tree()
  boundThread(dir)
  const e = appendEntry(dir, { sessionId: SID, source: "human-typed", text: "amíg fut a HX, dolgozz tovább az alias táblán és a disagreement flagen" })
  const ev = { session_id: SID, cwd, transcript_path: transcript(cwd), last_assistant_message: WAITING, background_tasks: [{ id: "b1" }] }
  assert.equal(answerStop(ev, { judge: () => ({ verdict: { class: "NEW", answer: "", evidence: [] }, error: null, latencyMs: 5 }), statusOf: () => "idle" }), null)
  const suggestion = { class: "PARALLEL", answer: "Run the kNN example arm after HX.", evidence: [{ entryId: e.id, quote: "yes, run the kNN example arm after HX" }], independence: "They do not depend on the HX result." }
  assert.equal(answerStop({ ...ev, transcript_path: transcript(cwd) }, { judge: () => ({ verdict: suggestion, error: null, latencyMs: 5 }), statusOf: () => "idle" }), null)
})

// ── capture: task notifications (probe M2) ───────────────────────────────────

test("probe M2: a task notification fires UserPromptSubmit — autopilot's own rewake answer among them — and is never recorded as human", () => {
  const { cwd, dir } = tree()
  const id = boundThread(dir)
  const prompt = "<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\nStop hook blocking error from command \"Stop\": [autopilot] Automatic answer — continue the resolver fixes"
  const r = capturePrompt({ session_id: SID, cwd, prompt })
  assert.match(r.skipped, /task notification/)
  assert.equal(readThread(dir, id).length, 0)
})

// ── presence gate (task group 0) ─────────────────────────────────────────────

// Rows as measured live (probe M1, `tmux capture-pane -p -e`, 2.1.270).
const ROW = {
  empty: "\x1b[39m❯\xa0",
  typed: "\x1b[39m❯\xa0hello half typed",
  ghost: "\x1b[39m❯\xa0\x1b[2mread notes.txt\x1b[0m",
  busy: "\x1b[38;5;246m❯\xa0\x1b[39m",
  scrollback: "\x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231msay hi\x1b[39m",
  dialog: " \x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m1. \x1b[38;5;153mYes\x1b[39m",
}

test("the 10:03:50Z collision: a half-typed human line reads 'typed' and the executor must not type into it", () => {
  assert.equal(classifyInputRow(`${ROW.scrollback}\nsome output\n${ROW.typed}\n`), "typed")
  assert.equal(safeToType(classifyInputRow(ROW.typed)), false)
  assert.equal(classifyInputRow(`${ROW.scrollback}\n${ROW.empty}`), "empty")
  assert.equal(classifyInputRow(ROW.busy), "empty")
  assert.equal(classifyInputRow(ROW.ghost), "ghost", "a dim client suggestion is not a human — a plain capture cannot tell")
  assert.equal(safeToType("ghost"), true)
})

test("a scrollback prompt or a dialog cursor is not the input line — no input row is unknown, and unknown is never safe", () => {
  assert.equal(classifyInputRow(`${ROW.scrollback}\n${ROW.dialog}`), "unknown")
  assert.equal(safeToType("unknown"), false)
})

test("fleet owner path: the raw tail stream is classified by its last input-row paint (shapes from live ownerd tails)", () => {
  assert.equal(classifyStream("\r\x1b[1B\x1b[39m❯\xa0\r\x1b[1B\x1b[38;5;244m────"), "empty")
  assert.equal(classifyStream("\r\x1b[1B\x1b[39m❯\xa0\x1b[2mmeasure the 375px bar while the loop runs\r\x1b[1B\x1b[22m"), "ghost")
  assert.equal(classifyStream("\r\x1b[3B❯\xa0\x1b[39m\x1b[K\r\x1b[48C"), "empty")
  assert.equal(classifyStream("\r\x1b[1B\x1b[39m❯\xa0we don1t need opu\r\x1b[1B"), "typed")
  assert.equal(classifyStream("no prompt glyph at all"), "unknown")
})

// ── reinject binding and charter (intent-ledger, drift-guard) ────────────────

const FRESH = "bbbbbbbb-4444-5555"
const PREV = "cccccccc-6666-7777"

test("08:46:52Z: an mtime-chosen reload binds no thread, and the injection says so", () => {
  const { dir } = tree()
  handoff(dir)
  const inj = buildInjection({ dir, source: "clear", sessionId: FRESH })
  assert.equal(readReload(dir, FRESH).choice, "mtime")
  assert.equal(threadOf(dir, FRESH).bound, false)
  assert.match(inj, /NOT bound to a thread/)
})

test("probe M3: no platform pointer to the predecessor — the watcher's typed /clear record links it, and the reload binds by that session's marker", () => {
  const { dir } = tree()
  const id = handoff(dir)
  writeFileSync(join(dir, `.written-${session8(PREV)}`), `${new Date().toISOString()} ${id}--resolver-fixes.md\n`)
  appendEntry(dir, { sessionId: PREV, source: "human-typed", text: HUMAN })
  logTyped(dir, { kind: "clear", text: "/clear", sessionId: PREV, pid: 4242 })
  const prev = previousSessionOf(dir, 4242)
  assert.equal(prev, session8(PREV))
  assert.equal(previousSessionOf(dir, 9999), "", "another process's clear must not link")
  const inj = buildInjection({ dir, source: "clear", sessionId: FRESH, prevSessionId: prev })
  assert.equal(readReload(dir, FRESH).choice, "marker")
  const t = threadOf(dir, FRESH)
  assert.equal(t.bound, true)
  assert.equal(t.id, id)
  assert.match(inj, /Thread direction — the human's own words/)
  assert.match(inj, /javítsd a resolver három hibáját/)
})

test("the charter rides inside the 10 000-char hook cap even with a huge handoff and a long ledger", () => {
  const { dir } = tree()
  const id = handoff(dir)
  writeFileSync(join(dir, `${id}--resolver-fixes.md`), `# HANDOFF\n\n${"x".repeat(30_000)}\n`)
  writeFileSync(join(dir, `.written-${session8(PREV)}`), `${new Date().toISOString()} ${id}--resolver-fixes.md\n`)
  for (let i = 0; i < 40; i++) appendEntry(dir, { sessionId: PREV, source: "human-typed", text: `${i} ${"szó ".repeat(80)}` })
  const inj = buildInjection({ dir, source: "clear", sessionId: FRESH, prevSessionId: PREV })
  assert.ok(inj.length <= 10_000, `injection is ${inj.length} chars`)
  assert.match(inj, /Thread direction/)
  assert.match(inj, /truncated/)
})

test("a thread with no human entry says so, instead of passing the agent's summary off as the human's direction", () => {
  assert.match(charterBlock([]), /No human entry recorded/)
})

// ── dictation adapter (file shape) ───────────────────────────────────────────

test("dictation segments split mid-word join without a space — measured 'létreho' + 'ztam.' must stay quotable verbatim", () => {
  const { cwd, dir } = tree()
  const id = boundThread(dir)
  const cdir = join(cwd, ".set", "copilot", SID)
  mkdirSync(cdir, { recursive: true })
  writeFileSync(join(cdir, "dictation-2026-09-13T10-17-29-521Z.jsonl"), [
    { ts: 1, speaker: "mic", text: "amire azt létreho", final: true },
    { type: "silence", duration_ms: 300, ts: 2 },
    { ts: 3, speaker: "mic", text: "ztam.", final: true, midWord: true, cont: true },
    { ts: 4, speaker: "mic", text: "Tehát a bugfixeket csinálja.", final: true },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n")
  assert.equal(captureDictations(dir, cwd, SID).captured, 1)
  const entry = readThread(dir, id).find((e) => e.source === "human-dictated")
  assert.equal(entry.text, "amire azt létrehoztam. Tehát a bugfixeket csinálja.")
  assert.equal(captureDictations(dir, cwd, SID).captured, 0, "each archived dictation is captured once")
})

test("a session with no dictation dir is announced, not read as 'the human said nothing'", () => {
  const { cwd, dir } = tree()
  assert.match(captureDictations(dir, cwd, SID).source, /no dictation dir/)
})

// ── turn gate (task group 0, measured 2026-09-14 probe on 2.1.270) ───────────

// Screen shapes verbatim from the probe captures (c2–c6, ANSI-stripped; input row per presence M1).
const SCREEN = {
  working: [
    "❯ Write a 700-word story about a lighthouse keeper.",
    "✻ Wibbling… ",
    "  ⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY …",
    "\x1b[39m❯\xa0",
  ].join("\n"),
  queued: [
    "✽ Wibbling… ",
    "  ❯ Second message typed while the first turn runs.",
    "\x1b[39m❯\xa0Press up to edit queued messages",
  ].join("\n"),
  interrupted: [
    "  ⎿  Interrupted · What should Claude do instead?",
    "\x1b[39m❯\xa0\x1b[2mTry \"how do I log an error?\"\x1b[0m",
  ].join("\n"),
  scrollbackSentence: [
    "  the previous run logged: config-loading… done",
    "\x1b[39m❯\xa0",
  ].join("\n"),
}

test("21:24:39Z: a seat mid-turn in one long generation reads 'working' — the executor must not type into it", () => {
  assert.equal(classifyScreen(SCREEN.working), "working")
  assert.equal(safeToClear(classifyScreen(SCREEN.working)), false)
  assert.equal(classifyScreen(SCREEN.queued), "queued")
  assert.equal(safeToClear(classifyScreen(SCREEN.queued)), false)
})

test("after ONE Escape the interrupted screen reads idle — and a scrollback sentence ending 'ing…' must not read working", () => {
  assert.equal(classifyScreen(SCREEN.interrupted), "idle")
  assert.equal(safeToClear(classifyScreen(SCREEN.interrupted)), true)
  assert.equal(classifyScreen(SCREEN.scrollbackSentence), "idle", "the spinner shape is glyph + Capitalized gerund + …, nothing else")
})

test("fleet owner path: the tail's last window carries the spinner paint — and no glyph at all is unknown, never idle", () => {
  assert.equal(turnClassifyStream(`\r\x1b[1B✻ Wibbling… \r\x1b[1B\x1b[39m❯\xa0\x1b[39m`), "working")
  assert.equal(turnClassifyStream("\r\x1b[1B\x1b[39m❯\xa0Press up to edit queued messages\r\x1b[1B"), "queued")
  assert.equal(turnClassifyStream("no glyph, no spinner in this tail"), "unknown")
  assert.equal(safeToClear("unknown"), false)
})

test("21:25:16Z: the CONTINUE confirm was false — 'auto-continue' in an attachment or tool_result proves nothing; only a user string entry counts", () => {
  const lines = [
    JSON.stringify({ type: "attachment", attachment: { type: "skill_listing", content: "- auto-clear: Arm, check… (auto-continue) cycle" } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "handoff body says auto-continue" }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "…auto-continue…" }] } }),
    JSON.stringify({ type: "system", subtype: "local_command", content: "…auto-continue…" }),
  ].join("\n")
  assert.equal(transcriptSaysSubmitted(lines, "auto-continue"), false, "the 21:25:16Z confirm matched exactly such lines")
  const submitted = lines + "\n" + JSON.stringify({ type: "user", message: { role: "user", content: "Folytatás automatikus /clear után (auto-continue): olvasd be a handoff fájlt." } })
  assert.equal(transcriptSaysSubmitted(submitted, "auto-continue"), true, "probe M2: a queued message leaves NO user entry, so a user-string hit is real submission")
  assert.equal(transcriptSaysSubmitted("", "auto-continue"), false)
})

test("21:26:17Z: the fire lock holds a second fire while the clear is in flight, and releases when the sessionId changed", () => {
  const NOW = 1_000_000_000
  const lock = JSON.stringify({ sid: "ca523297", at: NOW - 60_000 })
  assert.equal(fireLockState(lock, "ca523297", NOW), "held", "same session, 60 s in — the second /clear must not fire")
  assert.equal(fireLockState(lock, "ce67a4d9", NOW), "stale", "the clear took effect: a fresh sessionId releases the lock")
  assert.equal(fireLockState(JSON.stringify({ sid: "ca523297", at: NOW - 601_000 }), "ca523297", NOW), "stale", "past the 10 min wait the lock gives up")
  assert.equal(fireLockState("garbage", "ca523297", NOW), "free", "an unreadable lock never blocks — but nothing was proven either")
  assert.equal(fireLockState(lock, "", NOW), "held", "no id to verify against: hold rather than double-fire")
})
