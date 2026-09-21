/**
 * autopilot/judge — the LLM half: builds the prompt, runs the configured judge command, parses
 * its JSON. It PROPOSES only; `validate.mjs` decides (specs: auto-answer, drift-guard).
 *
 * No recursion (spec): the judge runs with AUTOPILOT_JUDGE=1 in its environment — every autopilot
 * hook exits at once when it sees it — from a scratch working directory outside the project, so
 * project hooks do not load, with the parent's CLAUDE* session variables removed.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isEvidence } from "./ledger.mjs"

const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)}… (truncated)` : t }

function humanEntries(entries, maxChars = 12_000) {
  const human = entries.filter(isEvidence)
  const out = []
  let used = 0
  for (const e of [...human].reverse()) { // newest first under the cap, printed oldest first
    const line = `[${e.id}] ${e.at.slice(0, 16)}Z ${e.source}: ${JSON.stringify(e.text)}`
    if (used + line.length > maxChars) break
    out.unshift(line)
    used += line.length
  }
  return out.length ? out.join("\n") : "(none)"
}

export function buildAnswerPrompt({ kind, question, options = [], entries, decisionItems = [], lastAssistantMessage = "", backgroundTasks = [] }) {
  return `You are the evidence judge of an autopilot for a coding-agent session. A human set this work thread's direction; the agent has stopped. Decide whether the human's OWN recorded words already settle the stop. You never invent intent.

HUMAN ENTRIES — the only admissible evidence (id, time, source, verbatim text):
${humanEntries(entries)}

USER-DECISION ITEMS — the human must decide these; never answer a stop that touches one:
${decisionItems.length ? decisionItems.map((d) => `- ${d}`).join("\n") : "(none)"}

THE STOP
kind: ${kind}
question: ${JSON.stringify(question)}
${options.length ? `options (agent-authored — never evidence): ${JSON.stringify(options)}\n` : ""}agent's last message (agent-authored — never evidence of intent): ${JSON.stringify(clip(lastAssistantMessage, 4000))}
background work still running: ${backgroundTasks.length ? `yes (${backgroundTasks.length})` : "no"}

CLASSIFY
- DERIVABLE: a human entry directly answers the question.
- APPROVAL: the agent asks permission to proceed with a step, and human entries show that step is within the direction the human set.
- PARALLEL: background work is running and the agent names a step it can do meanwhile that human entries cover; set "independence" to the EXACT sentence from the agent's last message that says the step does not depend on the running work.
- NEW: anything else — new information, a choice the entries do not make, any doubt.

RULES
- Quote evidence EXACTLY as written in the entries (copy characters, never paraphrase), at least 12 characters, with the entry id.
- Option labels, "(Recommended)" markers and the agent's own text are never evidence.
- If the stop touches a user-decision item, set "decisionItem" to that item and class NEW.
- Irreversible or outward actions (push, deploy, delete, send to a client, publish, pay): class NEW.
- When unsure: NEW.
- "answer": what to tell the agent, in the language of the question; for a dialog, the option label to pick or a short free-text answer.

Reply with ONLY this JSON object, nothing else:
{"class":"DERIVABLE|APPROVAL|PARALLEL|NEW","answer":"","evidence":[{"entryId":"","quote":""}],"independence":null,"decisionItem":null}`
}

export function buildAlignmentPrompt({ entries, summary, nextStep }) {
  return `You check whether an unattended coding-agent thread is still on the course its human set. Compare the agent's latest handoff with the human's own recorded words.

HUMAN ENTRIES (verbatim, oldest first):
${humanEntries(entries, 8000)}

AGENT'S HANDOFF — summary: ${JSON.stringify(clip(summary, 1500))}
AGENT'S HANDOFF — next step (later UPDATE sections supersede the list): ${JSON.stringify(clip(nextStep, 3000))}

Verdict:
- aligned: the next step serves the direction the human set.
- drifted: the next step works on something the human did not set for this thread.
- unclear: the entries do not let you tell, or any doubt.

Reply with ONLY: {"verdict":"aligned|drifted|unclear","reason":"one sentence"}`
}

/** First JSON object in a text (a model may wrap it in prose or a code fence). */
export function extractJson(text) {
  const s = String(text ?? "")
  const a = s.indexOf("{"), b = s.lastIndexOf("}")
  if (a < 0 || b <= a) return null
  try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
}

/**
 * Run the judge. `command` is an argv array; the prompt goes on stdin. Accepts both a raw JSON
 * reply and `claude -p --output-format json`'s envelope ({result: "<model text>"}).
 * Returns {verdict|null, error|null, latencyMs}.
 */
export function runJudge({ command, prompt, timeoutSec = 45 }) {
  const started = Date.now()
  if (!Array.isArray(command) || !command.length) return { verdict: null, error: "no judge command configured", latencyMs: 0 }
  const cwd = join(tmpdir(), "autopilot-judge")
  mkdirSync(cwd, { recursive: true })
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k)))
  env.AUTOPILOT_JUDGE = "1"
  const r = spawnSync(command[0], command.slice(1), { input: prompt, cwd, env, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 4 * 1024 * 1024 })
  const latencyMs = Date.now() - started
  if (r.error) return { verdict: null, error: r.error.code === "ETIMEDOUT" ? `judge timed out after ${timeoutSec}s` : `judge failed: ${r.error.message}`, latencyMs }
  if (r.status !== 0) return { verdict: null, error: `judge exited ${r.status}: ${clip(r.stderr, 300)}`, latencyMs }
  const outer = extractJson(r.stdout)
  const verdict = outer && typeof outer.result === "string" ? extractJson(outer.result) : outer
  return verdict ? { verdict, error: null, latencyMs } : { verdict: null, error: `judge reply unparseable: ${clip(r.stdout, 300)}`, latencyMs }
}
