#!/usr/bin/env node
/**
 * autopilot/answer-dialog — PreToolUse hook, matcher `AskUserQuestion` (specs: auto-answer).
 *
 * In-protocol, never keystrokes: probe P1b (2.1.270) measured that `permissionDecision: "allow"`
 * with `updatedInput.answers` keyed by the exact question text skips the dialog (29 ms) and the
 * model receives it as the user's answer. Because that answer is indistinguishable downstream,
 * two things are mandatory here: the answer TEXT carries the autopilot label and its evidence,
 * and a pending record tells capture-answer.mjs not to log it as `human-picked`.
 *
 * All or nothing: every question of the call must pass the validator, or nothing is printed and
 * the dialog shows to the human unchanged — a partially pre-answered dialog cannot be presented
 * honestly. Exit 0 ALWAYS.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  appendEntry, captureDictations, findHandoffFile, handoffDirFor, isJudgeRun, ledgerDir, loadConfig, logVerdict,
  optoutState, readStdinJson, readThread, session8, silenceCounts, threadOf,
} from "./ledger.mjs"
import { decisionItems, failed, validate } from "./validate.mjs"
import { buildAnswerPrompt, runJudge } from "./judge.mjs"
import { pendingPath } from "./capture-answer.mjs"

export const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` }

/** Shared by both answer hooks: the thread, its human entries, and the checks that cost no judge call. */
export function answerContext(dir, cwd, sessionId, { answersNeeded = 1 } = {}) {
  const config = loadConfig(cwd)
  const dictation = captureDictations(dir, cwd, sessionId)
  const thread = threadOf(dir, sessionId)
  const bound = thread.bound && !(thread.reload && thread.reload.choice !== "marker")
  const entries = bound ? readThread(dir, thread.id) : []
  const handoffFile = bound ? findHandoffFile(dir, thread.id) : null
  const ctx = {
    threadId: thread.id, bound, entries, config, answersNeeded,
    optout: optoutState(dir, sessionId), silence: silenceCounts(entries),
    decisionItems: handoffFile ? decisionItems(readFileSync(handoffFile, "utf8")) : [],
    handoffFound: !!handoffFile,
  }
  const pre = validate(null, ctx).checks.filter((c) => ["optout", "bound", "budget", "handoff"].includes(c.name) && !c.ok)
  return { ctx, pre, dictation: dictation.source }
}

export function answerDialog(ev, { judge = runJudge, now = new Date() } = {}) {
  const sessionId = ev.session_id ?? ""
  const questions = Array.isArray(ev.tool_input?.questions) ? ev.tool_input.questions : []
  if (!sessionId || !questions.length) return null
  const cwd = ev.cwd ?? process.cwd()
  const dir = handoffDirFor(cwd)
  const base = { kind: "stop", stop: "dialog", session: session8(sessionId), toolUseId: ev.tool_use_id ?? null }

  const { ctx, pre, dictation } = answerContext(dir, cwd, sessionId, { answersNeeded: questions.length })
  base.dictation = dictation
  if (pre.length) { logVerdict(dir, { ...base, outcome: "not answered", failed: failed(pre) }); return null }

  const results = []
  for (const q of questions) {
    const r = judge({
      command: ctx.config.judgeCommand, timeoutSec: ctx.config.judgeTimeoutSec,
      prompt: buildAnswerPrompt({ kind: "dialog", question: q.question, options: (q.options ?? []).map((o) => o.label), entries: ctx.entries, decisionItems: ctx.decisionItems }),
    })
    const v = validate(r.verdict, { ...ctx, question: q.question, judgeError: r.error })
    results.push({ q, r, v })
    if (!v.ok) break // all or nothing — no point judging the rest
  }
  const ok = results.length === questions.length && results.every((x) => x.v.ok)
  logVerdict(dir, {
    ...base, outcome: ok ? "answered" : "not answered — dialog shown",
    questions: results.map((x) => ({ question: x.q.question, class: x.r.verdict?.class ?? null, latencyMs: x.r.latencyMs, failed: failed(x.v.checks) || null })),
  })
  if (!ok) return null

  const answers = {}
  for (const { q, r } of results) {
    const cited = r.verdict.evidence[0]
    const entry = ctx.entries.find((e) => e.id === cited.entryId)
    answers[q.question] = `${r.verdict.answer.trim()} — [autopilot: automatic answer from your ${hhmm(entry.at)} words: "${cited.quote}"]`
    appendEntry(dir, { sessionId, source: "auto-answer", now, text: `${q.question} → ${answers[q.question]}`, ref: { toolUseId: ev.tool_use_id ?? null, class: r.verdict.class, evidence: r.verdict.evidence } })
  }
  if (ev.tool_use_id) {
    mkdirSync(ledgerDir(dir), { recursive: true })
    writeFileSync(pendingPath(dir, ev.tool_use_id), `${now.toISOString()}\n`)
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...ev.tool_input, answers } } }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ""
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    if (!isJudgeRun()) {
      const out = answerDialog(readStdinJson())
      if (out) process.stdout.write(JSON.stringify(out))
    }
  } catch { /* on any failure the dialog simply shows — the human answers, as without autopilot */ }
  process.exit(0)
}
