#!/usr/bin/env node
/**
 * autopilot/capture-answer — PostToolUse hook, matcher `AskUserQuestion` (specs: intent-ledger).
 *
 * A dialog the HUMAN answered becomes `human-picked` entries (question → answer). A dialog that
 * autopilot answered itself (answer-dialog.mjs left a pending record for the same tool_use_id)
 * is skipped: probe P1b measured that a hook-supplied answer is indistinguishable from a real
 * pick downstream, so this pending record is the only thing that keeps it from being logged as
 * the human's choice.
 *
 * Answers come from the payload's tool_response when present, else from the transcript's
 * toolUseResult for the same tool_use_id (measured location of dialog answers). Exit 0 ALWAYS.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { appendEntry, handoffDirFor, isJudgeRun, ledgerDir, logVerdict, readStdinJson, session8 } from "./ledger.mjs"

export const pendingPath = (dir, toolUseId) => join(ledgerDir(dir), `.pending-${String(toolUseId).replace(/[^a-zA-Z0-9_-]/g, "")}`)

export function answersFromTranscript(path, toolUseId) {
  if (!path || !existsSync(path)) return null
  const lines = readFileSync(path, "utf8").trimEnd().split("\n")
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 400; i--) {
    let e; try { e = JSON.parse(lines[i]) } catch { continue }
    const answers = e?.toolUseResult?.answers
    if (!answers) continue
    const blocks = Array.isArray(e.message?.content) ? e.message.content : []
    if (!toolUseId || blocks.some((b) => b?.tool_use_id === toolUseId)) return answers
  }
  return null
}

export function captureAnswer(ev) {
  const sessionId = ev.session_id ?? ""
  if (!sessionId) return null
  const dir = handoffDirFor(ev.cwd ?? process.cwd())
  const toolUseId = ev.tool_use_id ?? ""
  if (toolUseId && existsSync(pendingPath(dir, toolUseId))) {
    unlinkSync(pendingPath(dir, toolUseId))
    return { skipped: "answered by autopilot — recorded as auto-answer, not human-picked" }
  }
  const answers = ev.tool_response?.answers ?? answersFromTranscript(ev.transcript_path, toolUseId)
  if (!answers || typeof answers !== "object" || !Object.keys(answers).length) {
    logVerdict(dir, { kind: "capture-answer", session: session8(sessionId), detail: "no answers in payload or transcript (dismissed dialog?)" })
    return null
  }
  return Object.entries(answers).map(([question, answer]) => appendEntry(dir, {
    sessionId, source: "human-picked",
    text: `${question} → ${Array.isArray(answer) ? answer.join(", ") : answer}`,
    ref: { toolUseId },
  }))
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ""
if (invoked === fileURLToPath(import.meta.url)) {
  try { if (!isJudgeRun()) captureAnswer(readStdinJson()) } catch { /* never break the tool result */ }
  process.exit(0)
}
