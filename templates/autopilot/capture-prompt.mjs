#!/usr/bin/env node
/**
 * autopilot/capture-prompt — UserPromptSubmit hook (specs: intent-ledger; auto-answer: prompt switch).
 *
 * Every submitted prompt becomes one ledger entry, classified at capture time against the
 * executors' typed-log: `human-typed`, `machine-typed` (the watcher's own prompt), or `mixed`
 * (measured 2026-09-13 10:04:22: a half-typed human line fused with the continue prompt).
 *
 * THE PROMPT SWITCH (user requirement 2026-09-13: "tudni kell az autopilotot kikapcsolni ha a
 * promptban kérem — élesítés után bármikor"): a line-initial `autopilot off|ki|on|be [project]`
 * flips the kill-switch file HERE, before the agent's turn starts — the agent does not own the
 * switch, so a drifted agent cannot overrule it. Only a `human-typed` prompt may flip it.
 *
 * Output: UserPromptSubmit `additionalContext` stating the new state (only when a directive
 * applied). Exit 0 ALWAYS — capture must never block a human's prompt.
 */
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  appendEntry, bindSession, captureDictations, classifyPrompt, findHandoffFile, handoffDirFor, isJudgeRun,
  loadConfig, logVerdict, parseDirective, readStdinJson, session8, setSwitch,
} from "./ledger.mjs"

export function capturePrompt(ev, { now = new Date() } = {}) {
  const sessionId = ev.session_id ?? ""
  if (!sessionId) return null
  // The platform labels non-human submits itself: `sdk` (a headless -p run's prompt), loop and
  // schedule wakeups, poll events, system. Those are never the human's words.
  if (ev.source && ev.source !== "user") return { skipped: `source ${ev.source}` }
  // Measured 2026-09-13 (probe M2, 2.1.270): the payload carries NO `source`, and a harness task
  // notification fires this hook with its XML as the "prompt" — including autopilot's own
  // asyncRewake answer, which arrives as a task notification. Recording those as human-typed would
  // turn machine output into the human's direction, the exact loop the ledger exists to prevent.
  if (/^\s*<task-notification>/.test(String(ev.prompt ?? ""))) return { skipped: "task notification — not human input" }
  const cwd = ev.cwd ?? process.cwd()
  const dir = handoffDirFor(cwd)
  const config = loadConfig(cwd)
  captureDictations(dir, cwd, sessionId)

  const prompt = String(ev.prompt ?? "")
  const cls = classifyPrompt(dir, prompt, { now: now.getTime() })

  // `/handoff <ID>` typed by the human names the thread this session carries — bind before recording.
  if (cls.source === "human-typed") {
    const m = /^\s*\/handoff\s+(\d{4}-[0-9a-f]{4})\b/.exec(prompt)
    if (m && findHandoffFile(dir, m[1])) bindSession(dir, sessionId, m[1])
  }

  const entry = appendEntry(dir, {
    sessionId, source: cls.source, text: prompt, now,
    ref: cls.match ? { kind: cls.match.kind, typedAt: cls.match.at } : null,
  })

  const directive = parseDirective(prompt, config.directivePatterns ?? [])
  if (!directive) return { entry }
  if (cls.source !== "human-typed") {
    logVerdict(dir, { kind: "directive-ignored", session: session8(sessionId), source: cls.source, matched: directive.matched })
    return { entry, ignored: directive }
  }

  const state = setSwitch(dir, sessionId, directive)
  appendEntry(dir, { sessionId, source: "directive", text: `autopilot ${directive.on ? "on" : "off"} (${directive.scope})`, ref: { matched: directive.matched }, now })
  logVerdict(dir, { kind: "directive", session: session8(sessionId), on: directive.on, scope: directive.scope, off: state.off })

  let context
  if (!directive.on) {
    context = `[autopilot] OFF ${directive.scope === "project" ? "for this whole tree (.no-autopilot)" : "for this session"} — switched by the human's prompt ("${directive.matched}"). No stop will be answered automatically and no automatic continuation will be sent. Confirm this in one line.`
  } else if (state.off) {
    context = `[autopilot] still OFF — the ${directive.scope} switch was lifted, but ${state.tree ? "the project switch .no-autopilot is present (say \"autopilot on project\" to lift it)" : "the session switch is still present"}. Tell the human in one line.`
  } else {
    context = `[autopilot] ON — switched by the human's prompt ("${directive.matched}"). Automatic answers and continuations resume under their evidence rules. Confirm this in one line.`
  }
  return { entry, directive, state, context }
}

function main() {
  if (isJudgeRun()) return
  const r = capturePrompt(readStdinJson())
  if (r?.context) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: r.context } }))
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ""
if (invoked === fileURLToPath(import.meta.url)) {
  try { main() } catch { /* capture must never block the human's prompt */ }
  process.exit(0)
}
