#!/usr/bin/env node
/**
 * clear-gate — decide whether a session may be cleared automatically. NEVER clears anything.
 *
 * ═══ THE CONTRACT (specs: auto-clear) ═══
 *
 * This script only EVALUATES. It prints one verdict per gate and exits 0 always — the exit
 * code must not become a trigger. An executor (tmux send-keys, the fleet pty owner, a remote
 * control client) reads the verdict and decides whether to type `/clear`. The package ships
 * the gate and the contract; the environment ships the keystrokes.
 *
 * Gates, all of which must hold (any failure ⇒ not eligible, and the reason is named):
 *   1. tokens     — context size ≥ threshold. Source order: the session's OWN statusline-
 *                   persisted file (`.context-tokens-<session8>`, documented
 *                   `context_window.total_input_tokens`) if fresher than the freshness bound,
 *                   else the transcript's last usage triple (works, but the transcript format
 *                   is officially unstable — this is the FALLBACK, not the source). A stale
 *                   file also falls through to the transcript — measured 2026-09-13: returning
 *                   "stale" instead starved 1061 of 1742 armed-night verdicts while the
 *                   transcripts held the true numbers. No session id ⇒ the legacy shared
 *                   `.context-tokens` (pre-9.3 shape). Unknown ⇒ not eligible: unknown must
 *                   never read as above-threshold.
 *   2. marker     — `.written-<session8>` exists in the handoff dir: per-session-id by
 *                   construction, so another session's marker can never arm THIS session
 *                   (session identity is the id, never "a handoff exists"). The session's
 *                   start (from ~/.claude/sessions/<pid>.json, earliest record wins — a fleet
 *                   restore keeps the id and restarts the process) is reported in the detail,
 *                   not enforced: blocking a restored thread from its own armed handoff was
 *                   measured harmful on 2026-09-13.
 *   3. idle       — transcript tail has no unanswered user message and no tool_use without its
 *                   tool_result. A tool awaiting a PERMISSION decision also has no result yet,
 *                   so a pending prompt fails this gate — which is load-bearing: a dialog
 *                   swallows the executor's keystrokes (measured 2026-09-12).
 *   4. background — while `backgroundWorkBlocks` is true (the default — survival of harness
 *                   tasks across /clear is unverified), the armed handoff must DECLARE no
 *                   background work via BACKGROUND_NONE_PATTERN; unresolvable ⇒ blocked
 *                   (fail-closed: an unreadable declaration is not a "none"). Relax only with
 *                   the pilot's recorded measurement (task 6.4 of the change).
 *   5. optout     — `.no-autoclear-<session8>` in the handoff dir blocks the clear whatever
 *                   else holds. This is the kill switch for "disable auto-clear for THIS
 *                   session": the user creates it, or asks the agent to, and the gate obeys —
 *                   an agent's verbal promise cannot disable the watcher, a marker file can.
 *
 * Usage:
 *   node clear-gate.mjs [--session <id>] [--threshold N] [--freshness SEC]
 *        [--dir <handoffDir>] [--transcript <path>] [--tokens-file <path>] [--json] [--dry-run]
 *   A hook-style JSON on stdin (session_id, transcript_path, cwd) is also accepted.
 *
 * Exit code is 0 whenever the evaluation itself ran (eligible or not); 2 on usage/setup error.
 * `--dry-run` is accepted for executor symmetry: the gate never triggers, dry or not.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { basename, join, resolve } from "node:path"

const MARKER_PREFIX = ".written-"
const DEFAULT_THRESHOLD = 500_000
const DEFAULT_FRESHNESS_SEC = 300
const BACKGROUND_NONE_PATTERN = "none left|none running|no (?:background|running)|nem fut(?: semmi)?|nincs(?: futó)? háttér"

export function session8(sessionId) {
  return String(sessionId ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "ismeretlen"
}

/**
 * The marker convention, as a function so the write-time hook and the tests share one body:
 * a marker exists ONLY for a handoff that passed the content gate. A failed gate must never
 * arm a session (test: marker.test / "a failing gate must never arm").
 */
export function armMarker(handoffDir, sessionId, handoffFile, { passed = true, now = new Date() } = {}) {
  const path = join(handoffDir, MARKER_PREFIX + session8(sessionId))
  if (!passed) {
    if (existsSync(path)) { try { unlinkSync(path) } catch { /* best effort */ } }
    return { wrote: false, path, reason: "gate not passed — no marker" }
  }
  writeFileSync(path, `${now.toISOString()} ${basename(handoffFile)}\n`)
  return { wrote: true, path }
}

/**
 * Live context size: the first FRESH statusline-persisted candidate, else the transcript
 * fallback. A stale candidate is remembered ("statusline-stale" is only reported when nothing
 * else pans out) — it must not SHORT-CIRCUIT the fallback: measured 2026-09-13 in the armed
 * consumer night, a returning-early "stale" starved 1061 of 1742 verdicts while the sessions'
 * own transcripts held the true ~528k.
 */
export function readTokens({ tokensFile, tokensFiles, transcriptPath, freshnessSec = DEFAULT_FRESHNESS_SEC, now = Date.now() } = {}) {
  const candidates = tokensFiles ?? (tokensFile ? [tokensFile] : [])
  let sawStale = false
  for (const path of candidates) {
    if (!path || !existsSync(path)) continue
    try {
      const rec = JSON.parse(readFileSync(path, "utf8"))
      const ageSec = (now - Date.parse(rec.updatedAt)) / 1000
      if (Number.isFinite(rec.totalInputTokens) && ageSec <= freshnessSec) {
        return { tokens: rec.totalInputTokens, source: "statusline", ageSec }
      }
      sawStale = true
    } catch { /* a corrupt candidate falls to the next source */ }
  }
  if (transcriptPath && existsSync(transcriptPath)) {
    const t = tokensFromTranscript(transcriptPath)
    if (t != null) return { tokens: t, source: "transcript-fallback", ageSec: null }
  }
  return { tokens: null, source: sawStale ? "statusline-stale" : "unknown", ageSec: null }
}

/** Last usage triple in the transcript — the formula context-guard has run in production. */
export function tokensFromTranscript(path) {
  try {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      let e; try { e = JSON.parse(lines[i]) } catch { continue }
      const u = e?.message?.usage ?? e?.usage
      if (u && (u.input_tokens != null || u.cache_read_input_tokens != null)) {
        return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      }
    }
  } catch { /* unreadable transcript ⇒ unknown */ }
  return null
}

/**
 * Session start time from the runtime's own records (~/.claude/sessions/<pid>.json).
 * Two measured bugs lived here (fixed 2026-09-13):
 * - the old filter skipped any file whose NAME contains a dot — true of every `<pid>.json` —
 *   so the marker gate's start check NEVER ran (it announced the skip and passed on presence);
 * - a fleet restore restarts the PROCESS but keeps the session id, so matching any single
 *   record is arbitrary. The session's birth is the EARLIEST start among its records: identity
 *   is the id, never the process, and a restored session must not disown its own marker.
 */
export function sessionStartAt(sessionId) {
  const dir = join(process.env.HOME ?? "", ".claude", "sessions")
  if (!existsSync(dir)) return null
  let earliest = null
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue // skips the <pid>.<hash>.key files too
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), "utf8"))
      if (rec.sessionId === sessionId && Number.isFinite(rec.startedAt)) {
        earliest = earliest == null ? rec.startedAt : Math.min(earliest, rec.startedAt)
      }
    } catch { /* a malformed record is not ours to fix */ }
  }
  return earliest
}

/** Idle: no unanswered user message, no tool_use left without its tool_result. */
export function transcriptIdle(path, window = 200) {
  if (!path || !existsSync(path)) return { idle: false, reason: "transcript missing" }
  let lines
  try {
    lines = readFileSync(path, "utf8").trimEnd().split("\n").slice(-window)
  } catch { return { idle: false, reason: "transcript unreadable" } }
  const pending = new Set()
  let last = null
  for (const line of lines) {
    let e; try { e = JSON.parse(line) } catch { continue }
    const type = e.type
    if (type === "assistant" && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block?.type === "tool_use") pending.add(block.id)
        if (block?.type === "text") last = { type: "assistant-text" }
      }
    }
    if (type === "user" && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block?.type === "tool_result") pending.delete(block.tool_use_id)
        else last = { type: "user" } // an unanswered user message ⇒ mid-turn
      }
    }
  }
  if (pending.size > 0) return { idle: false, reason: `tool call(s) awaiting result: ${[...pending].length}` }
  if (last?.type === "user") return { idle: false, reason: "user message awaiting response" }
  return { idle: true, reason: "turn ended, nothing pending" }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
export function evaluate(opts = {}) {
  const threshold = Number(opts.threshold ?? DEFAULT_THRESHOLD)
  const freshnessSec = Number(opts.freshnessSec ?? DEFAULT_FRESHNESS_SEC)
  const dir = resolve(opts.dir ?? ".set/handoff")
  const sessionId = opts.sessionId ?? ""
  const s8 = session8(sessionId)
  // Per-session token file first (9.3: two sessions in one repo overwrote the shared file and
  // read each other's numbers). The shared name is read only when no session id exists —
  // a number from ANOTHER session's file must never arm THIS session.
  const tokensFiles = opts.tokensFile
    ? [opts.tokensFile]
    : (s8 === "ismeretlen" ? [join(dir, ".context-tokens")] : [join(dir, `.context-tokens-${s8}`)])
  const transcriptPath = opts.transcriptPath ?? null

  const gates = []
  const add = (name, ok, detail) => gates.push({ name, ok, detail })

  // 1. tokens
  const tok = readTokens({ tokensFiles, transcriptPath, freshnessSec })
  add("tokens", tok.tokens != null && tok.tokens >= threshold,
    tok.tokens == null ? `unknown (source: ${tok.source})` : `${tok.tokens} ≥ ${threshold} via ${tok.source} (${Math.round(tok.ageSec ?? -1)}s old)`)

  // 2. marker — this session's own. The s8 suffix makes it per-session-id (another session's
  //    marker never matches); the start comparison stays as ANNOUNCEMENT only: measured
  //    2026-09-13, a fleet RESTORE keeps the session id and restarts the process, so the
  //    thread's own marker predates the new start — blocking on that starved the restored
  //    thread of exactly its own armed handoff.
  const markerPath = join(dir, MARKER_PREFIX + s8)
  let markerOk = false, markerDetail = "no marker for this session"
  if (s8 === "ismeretlen") markerDetail = "no session id given"
  else if (existsSync(markerPath)) {
    markerOk = true
    const startAt = sessionStartAt(sessionId)
    const mtime = statSync(markerPath).mtimeMs
    markerDetail = startAt == null
      ? "marker present (session record not found — start check skipped, announced)"
      : mtime >= startAt
        ? "marker present, postdates session start"
        : "marker present — predates the process start: a restored process of the SAME session id, armed from its own thread"
  }
  add("marker", markerOk, markerDetail)

  // 3. idle
  const idle = transcriptIdle(transcriptPath)
  add("idle", idle.idle, idle.reason)

  // 4. background — declared none, or the profile measured its relaxation
  let bgOk = true, bgDetail = "backgroundWorkBlocks=false — relaxed by measurement/profile"
  if (opts.backgroundWorkBlocks !== false) {
    bgOk = false; bgDetail = "blocked: backgroundWorkBlocks=true and survival across /clear is unverified"
    const markerContent = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : ""
    if (markerContent) {
      const m = markerContent.match(/^\S+ (.+)$/m) // marker line 2nd field: the handoff file name
      if (m && existsSync(join(dir, m[1].trim()))) {
        const body = readFileSync(join(dir, m[1].trim()), "utf8")
        const re = new RegExp(opts.backgroundNonePattern ?? BACKGROUND_NONE_PATTERN, "i")
        if (re.test(body)) { bgOk = true; bgDetail = `handoff declares no background work (${m[1].trim()})` }
        else bgDetail = `blocked: handoff ${m[1].trim()} has no resolvable "none" declaration`
      }
    }
  }
  add("background", bgOk, bgDetail)

  // 5. optout — per-session kill switch; presence blocks regardless of everything else.
  const optedOut = s8 !== "ismeretlen" && existsSync(join(dir, `.no-autoclear-${s8}`))
  add("optout", !optedOut, optedOut
    ? `opt-out present (.no-autoclear-${s8}) — auto-clear disabled for this session`
    : "no opt-out")

  const eligible = gates.every((g) => g.ok)
  return { eligible, sessionId: s8, threshold, gates, at: new Date().toISOString() }
}

function main(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--json" || a === "--dry-run") o.json = a === "--json"
    else if (a === "--session") o.sessionId = argv[++i]
    else if (a === "--threshold") o.threshold = argv[++i]
    else if (a === "--freshness") o.freshnessSec = argv[++i]
    else if (a === "--dir") o.dir = argv[++i]
    else if (a === "--transcript") o.transcriptPath = argv[++i]
    else if (a === "--tokens-file") o.tokensFile = argv[++i]
    else if (a === "--background-none-pattern") o.backgroundNonePattern = argv[++i]
    else if (a === "--background-work-blocks") o.backgroundWorkBlocks = argv[++i] !== "false"
    else { console.error(`unknown flag: ${a}`); return 2 }
  }
  if (!o.sessionId || !o.transcriptPath) {
    try {
      const hook = JSON.parse(readFileSync(0, "utf8"))
      o.sessionId = o.sessionId ?? hook.session_id
      o.transcriptPath = o.transcriptPath ?? hook.transcript_path
      o.dir = o.dir ?? (hook.cwd ? join(hook.cwd, ".set/handoff") : undefined)
    } catch { /* flags only is fine */ }
  }
  const result = evaluate(o)
  if (o.json) console.log(JSON.stringify(result, null, 2))
  else {
    for (const g of result.gates) console.log(`${g.ok ? "PASS" : "FAIL"}  ${g.name.padEnd(11)} ${g.detail}`)
    console.log(`${result.eligible ? "ELIGIBLE" : "NOT ELIGIBLE"} — the gate never clears; the executor decides`)
  }
  return 0
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ""
if (invoked === import.meta.url.replace("file://", "")) {
  process.exit(main(process.argv.slice(2)))
}
