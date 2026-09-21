#!/usr/bin/env node
/**
 * autopilot/ledger — the thread-scoped intent ledger (specs: intent-ledger).
 *
 * WHAT IT IS: an append-only record of what the HUMAN said to one work thread, written at capture
 * time with provenance. It exists because the transcript cannot tell. Measured 2026-09-13 on the
 * consumer: the auto-clear watcher's typed continue prompt and an owner-write bridge are both
 * recorded as `origin.kind:"human"`, `promptSource:"typed"`. Anything that reads "what the human
 * said" back from the transcript would, one cycle later, cite machine output as the human's
 * direction — a self-reinforcing drift loop.
 *
 * Layout (under <tree>/.set/handoff/, gitignored with the rest of .set/):
 *   ledger/<handoffID>.jsonl   one thread's entries — keyed by the handoff ID, so it survives clears
 *   ledger/s-<session8>.jsonl  a session's entries before the session is bound to a thread
 *   .thread-<session8>         session → thread binding (content: the handoff ID)
 *   .reload-<session8>         how a cleared session's reload chose its handoff {choice, id, prev}
 *   typed.jsonl                what executors typed, logged BEFORE typing (the provenance source)
 *   .no-autopilot              kill switch, whole tree
 *   .no-autopilot-<session8>   kill switch, one session
 *   autopilot.log              one JSON line per verdict — answered or not, continued or not
 *
 * Provenance: `human-typed` · `human-picked` · `human-dictated` are EVIDENCE; `directive` is human
 * input but not evidence; `machine-typed` · `mixed` · `auto-answer` are never evidence.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const HUMAN_EVIDENCE = new Set(["human-typed", "human-picked", "human-dictated"])
export const HUMAN_INPUT = new Set([...HUMAN_EVIDENCE, "directive"])
export const TYPED_WINDOW_MS = 15 * 60_000

export const DEFAULTS = Object.freeze({
  judgeCommand: ["claude", "-p", "--model", "haiku", "--output-format", "json"],
  judgeTimeoutSec: 45,
  maxAutoContinues: 3,
  maxAutoAnswers: 8,
  denyList: [],
  replaceDefaultDenyList: false,
  directivePatterns: [],
  charterChars: 1500,
  alignment: true,
  minQuoteChars: 12,
})

export function session8(sessionId) {
  return String(sessionId ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "ismeretlen"
}

export const handoffDirFor = (cwd) => join(cwd, ".set", "handoff")
export const ledgerDir = (dir) => join(dir, "ledger")

/** Control bytes out, whitespace collapsed. The 10:04:22 fusion carried a literal \x15. */
export function normalizeText(s) {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
}

export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex")

export function readJsonl(path) {
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

// ── executor provenance ──────────────────────────────────────────────────────

/** An executor calls this BEFORE it types — the record is what lets capture tell machine from human. */
export function logTyped(dir, { kind, text, sessionId = "", pid = "", now = new Date() }) {
  mkdirSync(dir, { recursive: true })
  const norm = normalizeText(text)
  appendFileSync(join(dir, "typed.jsonl"), JSON.stringify({
    at: now.toISOString(), kind, session8: sessionId ? session8(sessionId) : "", pid: String(pid ?? ""), sha256: sha256(norm), text: norm,
  }) + "\n")
}

/**
 * Classify a submitted prompt against the recent typed-log. Matching is by text within a time
 * window, NOT by session: the continue prompt lands in the FRESH session a clear just created,
 * whose id the executor did not know when it logged.
 *   equal    → machine-typed
 *   contains → mixed (the measured fusion of a half-typed human line with a machine prompt)
 */
export function classifyPrompt(dir, prompt, { now = Date.now(), windowMs = TYPED_WINDOW_MS } = {}) {
  const norm = normalizeText(prompt)
  const recent = readJsonl(join(dir, "typed.jsonl")).filter((r) => r.text && now - Date.parse(r.at) <= windowMs).reverse()
  if (!norm) return { source: "human-typed", match: null }
  const equal = recent.find((r) => r.text === norm)
  if (equal) return { source: "machine-typed", match: equal }
  const contained = recent.find((r) => r.text.length >= 6 && norm.includes(r.text))
  if (contained) return { source: "mixed", match: contained }
  return { source: "human-typed", match: null }
}

// ── thread binding ───────────────────────────────────────────────────────────

export function handoffIdOf(name) {
  const m = /^(\d{4}-[0-9a-f]{4})--/.exec(basename(String(name ?? "")))
  return m ? m[1] : null
}

export function findHandoffFile(dir, id) {
  if (!id || !existsSync(dir)) return null
  const f = readdirSync(dir).find((n) => n.startsWith(`${id}--`) && n.endsWith(".md"))
  return f ? join(dir, f) : null
}

/** Bind a session to a thread and fold its pre-binding entries into the thread's file. */
export function bindSession(dir, sessionId, id) {
  const s8 = session8(sessionId)
  mkdirSync(ledgerDir(dir), { recursive: true })
  writeFileSync(join(dir, `.thread-${s8}`), `${id}\n`)
  const own = join(ledgerDir(dir), `s-${s8}.jsonl`)
  const entries = readJsonl(own)
  if (entries.length) {
    appendFileSync(join(ledgerDir(dir), `${id}.jsonl`), entries.map((e) => JSON.stringify({ ...e, thread: id, foldedFrom: `s-${s8}` })).join("\n") + "\n")
  }
  if (existsSync(own)) unlinkSync(own)
}

/**
 * Which thread a session belongs to. Order: an explicit binding; else the session's own arm
 * marker (it proves the session's handoff passed the write-time gate — the spec's fold moment),
 * which binds lazily here so no hook-ordering race with the consumer's write-check hook exists.
 * A cleared session whose reload was NOT chosen by marker is recorded unbound by the reinject.
 */
export function threadOf(dir, sessionId) {
  const s8 = session8(sessionId)
  const reload = readReload(dir, sessionId)
  const bindingPath = join(dir, `.thread-${s8}`)
  if (existsSync(bindingPath)) {
    const id = readFileSync(bindingPath, "utf8").trim()
    if (id) return { id, bound: true, via: "binding", reload }
  }
  const marker = join(dir, `.written-${s8}`)
  if (existsSync(marker)) {
    const name = readFileSync(marker, "utf8").trim().split(/\s+/)[1]
    const id = handoffIdOf(name)
    if (id && name && existsSync(join(dir, name))) {
      bindSession(dir, sessionId, id)
      return { id, bound: true, via: "arm-marker", reload }
    }
  }
  return { id: `s-${s8}`, bound: false, via: reload ? `reload chosen by ${reload.choice}` : "no binding", reload }
}

export function writeReload(dir, sessionId, record) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `.reload-${session8(sessionId)}`), JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n")
}

export function readReload(dir, sessionId) {
  const p = join(dir, `.reload-${session8(sessionId)}`)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, "utf8")) } catch { return { choice: "unreadable" } }
}

// ── entries ──────────────────────────────────────────────────────────────────

export function appendEntry(dir, { sessionId, source, text, ref = null, now = new Date() }) {
  const { id: thread } = threadOf(dir, sessionId)
  const entry = {
    id: `${now.getTime().toString(36)}-${randomBytes(2).toString("hex")}`,
    at: now.toISOString(),
    thread,
    session8: session8(sessionId),
    source,
    text: String(text ?? ""),
    ...(ref ? { ref } : {}),
  }
  mkdirSync(ledgerDir(dir), { recursive: true })
  appendFileSync(join(ledgerDir(dir), `${thread}.jsonl`), JSON.stringify(entry) + "\n")
  return entry
}

export function readThread(dir, id) {
  return readJsonl(join(ledgerDir(dir), `${id}.jsonl`)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

export const isEvidence = (e) => HUMAN_EVIDENCE.has(e?.source)

/**
 * The human-silence budget, DERIVED from the ledger (no counter file to drift): automatic
 * continuations and automatic answers since the last human input. A human entry resets both.
 * A `mixed` entry does not reset — its human half is unprovable.
 */
export function silenceCounts(entries) {
  let continues = 0, answers = 0
  for (const e of entries) {
    if (HUMAN_INPUT.has(e.source)) { continues = 0; answers = 0; continue }
    if (e.source === "machine-typed" && e.ref?.kind === "continue") continues++
    if (e.source === "auto-answer") answers++
  }
  return { continues, answers }
}

/** The human direction, verbatim: the thread's first human entry, then the newest ones, capped. */
export function charterBlock(entries, maxChars = DEFAULTS.charterChars) {
  const human = entries.filter(isEvidence)
  if (!human.length) return "### Thread direction — the human's own words\n\n⚠ No human entry recorded for this thread yet — the direction below the handoff is the agent's own summary, not the human's words.\n"
  const pick = [human[0], ...human.slice(1).reverse()]
  const out = []
  let used = 0
  for (const [i, e] of pick.entries()) {
    const line = `- ${i === 0 ? "first direction" : "recent"} · ${e.at.slice(0, 16).replace("T", " ")}Z · ${e.source}: "${e.text}"`
    if (used + line.length > maxChars) {
      if (i === 0) out.push(`${line.slice(0, Math.max(0, maxChars - 80))}…" (truncated — full text in ledger/${e.thread}.jsonl)`)
      else out.push(`- … ${pick.length - i} older human entries not shown (ledger/${e.thread}.jsonl)`)
      break
    }
    out.push(line)
    used += line.length
  }
  return `### Thread direction — the human's own words (verbatim, from the intent ledger)\n\n${out.join("\n")}\n`
}

// ── switches and directives ──────────────────────────────────────────────────

export function optoutState(dir, sessionId) {
  const tree = existsSync(join(dir, ".no-autopilot"))
  const session = existsSync(join(dir, `.no-autopilot-${session8(sessionId)}`))
  return { off: tree || session, tree, session }
}

export function setSwitch(dir, sessionId, { on, scope = "session" }) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, scope === "project" ? ".no-autopilot" : `.no-autopilot-${session8(sessionId)}`)
  if (on) { if (existsSync(path)) unlinkSync(path) }
  else writeFileSync(path, `${new Date().toISOString()} switched off from the prompt\n`)
  return { path, ...optoutState(dir, sessionId) }
}

/**
 * Explicit directives only, at the start of a line — a sentence that merely MENTIONS "autopilot
 * off" (discussing the feature, say) must not flip the switch. Profile patterns extend the list;
 * each must capture (on|off word) in group 1 and optionally (project) in group 2.
 */
export const DEFAULT_DIRECTIVES = [
  String.raw`^\s*autopilot\s*[:=]?\s*(off|ki|on|be)\b[ \t]*(project|projekt)?`,
  String.raw`^\s*kapcsold\s+(ki|be)\s+az?\s+autopilot\w*[ \t]*(project|projekt)?`,
]

export function parseDirective(prompt, extra = []) {
  for (const src of [...DEFAULT_DIRECTIVES, ...extra]) {
    const m = new RegExp(src, "im").exec(String(prompt ?? ""))
    if (m) return { on: /^(on|be)$/i.test(m[1]), scope: m[2] ? "project" : "session", matched: m[0].trim() }
  }
  return null
}

// ── dictation adapter (file shape) ───────────────────────────────────────────

/**
 * set-copilot archives each finished dictation as `.set/copilot/<sessionId>/dictation-<ISO>.jsonl`.
 * Each archived file becomes ONE `human-dictated` entry (its final segments joined), captured once.
 * The command shape of the adapter is `node ledger.mjs append --source human-dictated …`.
 */
export function captureDictations(dir, cwd, sessionId) {
  const cdir = join(cwd, ".set", "copilot", String(sessionId ?? ""))
  // Absence is announced (callers log it): no dictation dir is NOT "the human said nothing".
  if (!sessionId || !existsSync(cdir)) return { captured: 0, source: "no dictation dir for this session — dictated input reaches the ledger only through an adapter" }
  const seenPath = join(ledgerDir(dir), `.dictation-seen-${session8(sessionId)}`)
  const seen = new Set(existsSync(seenPath) ? readFileSync(seenPath, "utf8").split("\n").filter(Boolean) : [])
  let n = 0
  for (const f of readdirSync(cdir).filter((f) => /^dictation-.+\.jsonl$/.test(f) && !f.includes("stitched")).sort()) {
    if (seen.has(f)) continue
    // Segments split mid-word or mid-clause carry `midWord: true` (measured: "létreho" + "ztam.",
    // "…diktálásaimból" + ", amit…") — joined without a space, or verbatim quotes would never match.
    const text = readJsonl(join(cdir, f))
      .filter((e) => e.final && typeof e.text === "string" && e.text.trim())
      .reduce((acc, e) => (e.midWord ? acc + e.text.trim() : `${acc} ${e.text.trim()}`), "")
      .trim()
    if (text) { appendEntry(dir, { sessionId, source: "human-dictated", text, ref: { file: f } }); n++ }
    seen.add(f)
  }
  mkdirSync(ledgerDir(dir), { recursive: true })
  writeFileSync(seenPath, [...seen].join("\n") + "\n")
  return { captured: n, source: `set-copilot dictation dir (${n} new)` }
}

// ── profile config and the verdict log ───────────────────────────────────────

/** `## Autopilot` section of .claude/handoff.profile.md, first ```json block; defaults otherwise — announced. */
export function loadConfig(cwd) {
  const path = join(cwd, ".claude", "handoff.profile.md")
  if (!existsSync(path)) return { ...DEFAULTS, source: "defaults — no .claude/handoff.profile.md" }
  const lines = readFileSync(path, "utf8").split("\n")
  const start = lines.findIndex((l) => /^##\s+Autopilot\b/i.test(l))
  if (start < 0) return { ...DEFAULTS, source: "defaults — profile has no ## Autopilot section" }
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  const section = lines.slice(start + 1, end < 0 ? undefined : end).join("\n")
  const m = /```json\s*\n([\s\S]*?)```/.exec(section)
  if (!m) return { ...DEFAULTS, source: "defaults — ## Autopilot has no ```json block" }
  try { return { ...DEFAULTS, ...JSON.parse(m[1]), source: "profile ## Autopilot" } }
  catch (err) { return { ...DEFAULTS, source: `defaults — ## Autopilot json unparseable: ${err.message}` } }
}

export function logVerdict(dir, record) {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, "autopilot.log"), JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n")
  } catch { /* the log must never take a hook down */ }
}

/** Hooks call this first: a judge session must never capture, judge or answer (spec: no recursion). */
export const isJudgeRun = () => process.env.AUTOPILOT_JUDGE === "1"

export function readStdinJson() {
  try { return JSON.parse(readFileSync(0, "utf8")) } catch { return {} }
}

// ── CLI (executor + dictation-adapter + skill surface) ───────────────────────

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

export function main(argv) {
  const [cmd] = argv
  const dir = resolve(arg(argv, "--dir") ?? ".set/handoff")
  const sessionId = arg(argv, "--session") ?? ""
  switch (cmd) {
    case "typed":
      logTyped(dir, { kind: arg(argv, "--kind") ?? "unknown", text: arg(argv, "--text") ?? "", sessionId, pid: arg(argv, "--pid") ?? "" })
      return 0
    case "append": {
      // The adapter can only ever write DICTATION — a CLI that could write `human-typed` would be a
      // provenance hole any script could walk through.
      if (arg(argv, "--source") !== "human-dictated") { console.error("append accepts only --source human-dictated"); return 2 }
      const file = arg(argv, "--text-file")
      const text = file ? readFileSync(file, "utf8") : arg(argv, "--text")
      if (!sessionId || !text?.trim()) { console.error("append needs --session and --text or --text-file"); return 2 }
      console.log(JSON.stringify(appendEntry(dir, { sessionId, source: "human-dictated", text: text.trim(), ref: { via: "cli" } })))
      return 0
    }
    case "switch": {
      const on = argv.includes("--on")
      if (!on && !argv.includes("--off")) { console.error("switch needs --on or --off"); return 2 }
      console.log(JSON.stringify(setSwitch(dir, sessionId, { on, scope: argv.includes("--project") ? "project" : "session" })))
      return 0
    }
    case "show": {
      const t = threadOf(dir, sessionId)
      const entries = readThread(dir, t.id)
      console.log(JSON.stringify({ thread: t, optout: optoutState(dir, sessionId), silence: silenceCounts(entries), entries }, null, 2))
      return 0
    }
    default:
      console.error("usage: ledger.mjs typed|append|switch|show --dir <handoffDir> [--session <id>] …")
      return 2
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ""
if (invoked === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
