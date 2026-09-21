#!/usr/bin/env node
/**
 * autopilot/answer-stop — Stop hook, registered with `"asyncRewake": true` (specs: auto-answer).
 *
 * Answers a turn that ended waiting for the human: a prose question, a "done, what next?", or a
 * wait on the session's own background work with independent steps offered. Probe P3 (2.1.270):
 * the Stop input carries `last_assistant_message` and `background_tasks`; an asyncRewake hook that
 * exits 2 wakes the idle session with its output as a task-notification turn — WITHOUT blocking
 * the human while the judge runs.
 *
 * THE STALE GUARD (P3's trap, measured): a human message typed while the hook runs does NOT cancel
 * the rewake — the old answer was delivered after the human's newer turn. So right before exiting
 * 2 this hook re-reads the transcript (user / assistant / queue entries), the thread's ledger and
 * the session record; anything new since the stop, or a busy session, discards the answer (logged).
 *
 * Exit 2 + labeled answer on stdout and stderr (the measured working shape) only when delivered;
 * exit 0 in every other case.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { appendEntry, handoffDirFor, isJudgeRun, logVerdict, readStdinJson, readThread, session8 } from "./ledger.mjs"
import { failed, validate } from "./validate.mjs"
import { buildAnswerPrompt, runJudge } from "./judge.mjs"
import { answerContext, hhmm } from "./answer-dialog.mjs"

const QUESTION = /\?\s*$|\?\s*\n|(?:^|[\s,.;:(])(shall i|should i|do you want|would you like|want me to|let me know|which (?:one|option)|szeretnéd|folytassam|mehet\b|melyik|válassz|döntsd el)/i
const MEANWHILE = /\b(while it runs|meanwhile|in the meantime|before (?:that|it) finishes|if you want to act before|amíg fut|közben|addig is)\b/i
const DONE = /\b(done|finished|completed|what(?:'s| is)? next|kész|elkészült|befejeztem|mi a következő)\b/i

/** Deterministic prefilter — no judge call is spent on a turn that is not waiting for the human. */
export function stopKind(message, backgroundTasks = []) {
  const tail = String(message ?? "").slice(-1500)
  if (backgroundTasks.length && MEANWHILE.test(tail)) return "background wait with steps offered"
  if (QUESTION.test(tail)) return "prose question"
  if (DONE.test(tail)) return "turn ended as done"
  return null
}

/** The part of the message the human would answer: its last paragraph. */
export const lastParagraph = (message) => String(message ?? "").trim().split(/\n\s*\n/).filter((p) => p.trim()).pop()?.trim().slice(-800) ?? ""

/** New activity marker: user / assistant / queue entries only — hook attachments do not count. */
export function transcriptMark(path) {
  if (!path || !existsSync(path)) return { count: -1, last: null }
  let count = 0, last = null
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.type === "user" || e.type === "assistant" || e.type === "queue-operation") { count++; last = e.uuid ?? e.timestamp ?? last }
  }
  return { count, last }
}

export function sessionStatus(sessionId) {
  const dir = join(homedir(), ".claude", "sessions")
  if (!existsSync(dir)) return null
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try { const r = JSON.parse(readFileSync(join(dir, f), "utf8")); if (r.sessionId === sessionId) return r.status ?? null } catch { /* not ours */ }
  }
  return null
}

export function answerStop(ev, { judge = runJudge, statusOf = sessionStatus, now = () => new Date() } = {}) {
  const sessionId = ev.session_id ?? ""
  if (!sessionId || ev.stop_hook_active) return null
  const cwd = ev.cwd ?? process.cwd()
  const dir = handoffDirFor(cwd)
  const message = String(ev.last_assistant_message ?? "")
  const bg = Array.isArray(ev.background_tasks) ? ev.background_tasks : []
  const base = { kind: "stop", session: session8(sessionId), backgroundTasks: bg.length }

  const kind = stopKind(message, bg)
  if (!kind) { logVerdict(dir, { ...base, stop: "none", outcome: "not waiting for the human — not judged" }); return null }

  const before = transcriptMark(ev.transcript_path)
  const { ctx, pre, dictation } = answerContext(dir, cwd, sessionId)
  base.dictation = dictation
  if (pre.length) { logVerdict(dir, { ...base, stop: kind, outcome: "not answered", failed: failed(pre) }); return null }
  const ledgerBefore = ctx.entries.length

  const question = lastParagraph(message)
  const r = judge({
    command: ctx.config.judgeCommand, timeoutSec: ctx.config.judgeTimeoutSec,
    prompt: buildAnswerPrompt({ kind, question, entries: ctx.entries, decisionItems: ctx.decisionItems, lastAssistantMessage: message, backgroundTasks: bg }),
  })
  const v = validate(r.verdict, { ...ctx, question, lastAssistantMessage: message, backgroundTasks: bg, judgeError: r.error })
  const judged = { ...base, stop: kind, class: r.verdict?.class ?? null, latencyMs: r.latencyMs }
  if (!v.ok) { logVerdict(dir, { ...judged, outcome: "not answered", failed: failed(v.checks) }); return null }

  // Stale guard — the last step before delivery.
  const after = transcriptMark(ev.transcript_path)
  const ledgerAfter = readThread(dir, ctx.threadId).length
  const status = statusOf(sessionId)
  if (after.count !== before.count || after.last !== before.last || ledgerAfter !== ledgerBefore || status === "busy") {
    logVerdict(dir, { ...judged, outcome: "discarded — the session moved on while the answer was computed", transcriptBefore: before.count, transcriptAfter: after.count, ledgerBefore, ledgerAfter, status })
    return null
  }

  const cited = r.verdict.evidence[0]
  const entry = ctx.entries.find((e) => e.id === cited.entryId)
  const text = `[autopilot] Automatic answer — derived from the human's own earlier words (${hhmm(entry.at)}, ${entry.source}: "${cited.quote}"), not a new human decision. ${r.verdict.answer.trim()}`
  appendEntry(dir, { sessionId, source: "auto-answer", text, now: now(), ref: { stop: kind, class: r.verdict.class, evidence: r.verdict.evidence } })
  logVerdict(dir, { ...judged, outcome: "answered" })
  return { message: text }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ""
if (invoked === fileURLToPath(import.meta.url)) {
  let code = 0
  try {
    if (!isJudgeRun()) {
      const out = answerStop(readStdinJson())
      if (out) { process.stdout.write(`${out.message}\n`); process.stderr.write(`${out.message}\n`); code = 2 }
    }
  } catch { code = 0 /* an autopilot failure leaves the session waiting, exactly as without it */ }
  process.exit(code)
}
