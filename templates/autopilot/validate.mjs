/**
 * autopilot/validate — the deterministic half of every automatic answer (specs: auto-answer).
 *
 * THE JUDGE PROPOSES, THIS DECIDES. A judge (an LLM) classifies a stop and proposes an answer with
 * quoted evidence; nothing it reports about its own confidence counts. An answer passes only when
 * every check below holds, and each check is named in the verdict — pass or fail — so the log
 * says exactly why a stop was or was not answered.
 *
 * Why quotes, not confidence: the failure that matters is a plausible derivation, and a
 * confidence number does not catch it; a verbatim-quote check against the human's own recorded
 * words does.
 */
import { isEvidence, normalizeText } from "./ledger.mjs"

export const ANSWER_CLASSES = new Set(["DERIVABLE", "APPROVAL", "PARALLEL"])

/**
 * Package default deny-list — irreversible or outward actions a machine never approves, whatever
 * the evidence. Profiles extend it (`denyList`) or replace it (`replaceDefaultDenyList: true`).
 */
export const DEFAULT_DENY = [
  String.raw`\bgit\s+push\b|\bforce[- ]push\b|\bpush\w*\s+(?:to\s+)?(?:origin|main|master|prod)`,
  String.raw`\bdeploy\w*|\bélesít\w*|\bproduction\b|\bprod\s+(?:db|database|server)`,
  String.raw`\bdelete\b|\btörl\w*|\brm\s+-rf\b|\bdrop\s+(?:table|database)\b|\btruncate\b`,
  String.raw`\breset\s+--hard\b|\bgit\s+clean\b`,
  String.raw`\bsend\w*\s+(?:\w+\s+){0,3}(?:client|customer|partner)|\bügyfél\w*\s+(?:\w+\s+){0,2}küld|\bküld\w*\s+(?:\w+\s+){0,3}ügyfél`,
  String.raw`\bpublish\w*|\bpublikál\w*|\brelease\b|\bmerge\s+(?:to|into)\s+(?:main|master)`,
  String.raw`\bpay\b|\bpayment\b|\bfizet\w*|\bpurchase\b|\bvásárol\w*|\bspend\b`,
]

export function denyPatterns(config = {}) {
  const base = config.replaceDefaultDenyList ? [] : DEFAULT_DENY
  return [...base, ...(config.denyList ?? [])].map((s) => new RegExp(s, "i"))
}

/** Whitespace/case-insensitive; the agent-authored "(Recommended)" marker never counts as text. */
export function normQuote(s) {
  return normalizeText(s).toLowerCase().replace(/\(recommended\)/g, " ").replace(/^["'„”“»«\s]+|["'„”“»«\s]+$/g, "").replace(/\s+/g, " ").trim()
}

/** §3 of a handoff, minus its "agent work" block: the items only the human may decide. */
export function decisionItems(handoffBody) {
  const lines = String(handoffBody ?? "").split("\n")
  const start = lines.findIndex((l) => /^##\s*3\./.test(l))
  if (start < 0) return []
  const items = []
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const l = lines[i].trim()
    if (/^\*\*agent work|^#+\s*agent work/i.test(l)) break
    const m = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(l)
    if (m && m[1].length >= 12) items.push(m[1])
  }
  return items
}

const words = (s) => new Set(normQuote(s).replace(/[`*_()[\]{}:;,.!?"'„”]/g, " ").split(" ").filter((w) => w.length >= 5))

/** A question touches a decision item when it contains the item, or shares ≥ 60% of its long words. */
export function touchesDecision(question, items) {
  const q = normQuote(question)
  const qw = words(question)
  for (const item of items) {
    const n = normQuote(item)
    if (n.length >= 12 && (q.includes(n) || n.includes(q))) return item
    const iw = [...words(item)]
    if (iw.length >= 3 && iw.filter((w) => qw.has(w)).length / iw.length >= 0.6) return item
  }
  return null
}

/**
 * @param verdict   judge output {class, answer, evidence:[{entryId, quote}], independence, decisionItem} or null
 * @param context   {threadId, bound, entries, optout, silence, config, question, lastAssistantMessage,
 *                   backgroundTasks, decisionItems, handoffFound}
 * @returns {ok, checks:[{name, ok, detail}]}
 */
export function validate(verdict, ctx) {
  const cfg = ctx.config ?? {}
  const minQuote = cfg.minQuoteChars ?? 12
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })

  add("optout", !ctx.optout?.off, ctx.optout?.off ? `switched off (${ctx.optout.tree ? "project" : "session"})` : "no opt-out")
  add("bound", !!ctx.bound, ctx.bound ? `thread ${ctx.threadId}` : "no bound thread")
  const max = cfg.maxAutoAnswers ?? 8
  const used = ctx.silence?.answers ?? 0
  const need = ctx.answersNeeded ?? 1
  add("budget", used + need <= max, `${used} automatic answer(s) since the last human input, ${need} more needed, budget ${max}`)
  add("handoff", !!ctx.handoffFound, ctx.handoffFound ? "bound handoff found — decision items checked" : "bound handoff not found — decision items cannot be checked (fail closed)")

  if (!verdict || typeof verdict !== "object") {
    add("judge", false, `no usable judge verdict${ctx.judgeError ? `: ${ctx.judgeError}` : ""}`)
    return { ok: false, checks }
  }
  add("judge", true, "verdict parsed")

  const cls = String(verdict.class ?? "").toUpperCase()
  add("class", ANSWER_CLASSES.has(cls), ANSWER_CLASSES.has(cls) ? cls : `${cls || "missing"} — never answered`)
  add("answer", typeof verdict.answer === "string" && verdict.answer.trim().length > 0, "answer text present")

  // Evidence: every quote verbatim (normalized) inside the named HUMAN entry of THIS thread.
  const evidence = Array.isArray(verdict.evidence) ? verdict.evidence : []
  const problems = []
  if (!evidence.length) problems.push("no evidence cited")
  for (const ev of evidence) {
    const entry = (ctx.entries ?? []).find((e) => e.id === ev?.entryId)
    const q = normQuote(ev?.quote)
    if (!entry) { problems.push(`entry ${ev?.entryId} not in this thread's ledger`); continue }
    if (entry.thread !== ctx.threadId) { problems.push(`entry ${entry.id} belongs to thread ${entry.thread}`); continue }
    if (!isEvidence(entry)) { problems.push(`entry ${entry.id} is ${entry.source} — never evidence`); continue }
    if (/\(recommended\)/i.test(String(ev?.quote ?? "")) && q.length < minQuote) { problems.push("quote is only an agent-authored (Recommended) label"); continue }
    if (q.length < minQuote) { problems.push(`quote shorter than ${minQuote} chars: "${ev?.quote}"`); continue }
    if (!normQuote(entry.text).includes(q)) problems.push(`quote not verbatim in entry ${entry.id}: "${ev?.quote}"`)
  }
  add("evidence", problems.length === 0, problems.length ? problems.join("; ") : `${evidence.length} verbatim human quote(s)`)

  // Background wait: continuing in parallel needs the agent's OWN statement that the step is independent.
  const bg = Array.isArray(ctx.backgroundTasks) ? ctx.backgroundTasks : []
  if (cls === "PARALLEL" || (bg.length > 0 && cls === "APPROVAL")) {
    const ind = normQuote(verdict.independence)
    const inMsg = ind.length >= minQuote && normQuote(ctx.lastAssistantMessage).includes(ind)
    add("parallel", bg.length > 0 && inMsg,
      bg.length === 0 ? "PARALLEL without running background work"
      : inMsg ? "agent's own message states the step is independent of the running work"
      : "no verbatim independence statement from the agent's message — leave the wake to the completion notification")
  }

  const deny = denyPatterns(cfg).find((re) => re.test(String(ctx.question ?? "")) || re.test(String(verdict.answer ?? "")))
  add("deny-list", !deny, deny ? `matches ${deny.source}` : "no deny-listed action")

  const touched = verdict.decisionItem ? String(verdict.decisionItem) : touchesDecision(ctx.question, ctx.decisionItems ?? [])
  add("decision-item", !touched, touched ? `touches a user-decision item: ${touched}` : "no user-decision item touched")

  return { ok: checks.every((c) => c.ok), checks }
}

export const failed = (checks) => checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; ")
