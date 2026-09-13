#!/usr/bin/env node
/**
 * handoff-reinject-clear — SessionStart hook (matchers: `clear` AND `compact`).
 *
 * WHAT THE FRESH CONTEXT RECEIVES (specs: clear-reload):
 * the latest manual handoff as POINTER + PREVIEW — path, ID, and a bounded excerpt — plus the
 * machine state page if one exists. The full file is deliberately NOT injected: hook output is
 * capped at 10 000 characters by the platform, and pointer + preview makes the cap ours by
 * choice instead of an overflow side effect. The fresh context reads the full file from disk.
 *
 * IDEMPOTENCY — PER EVENT, NOT PER SESSION. Measured 2026-09-12 in consumer-repo: a once-per-
 * session marker suppressed reinjection on later compacts of the same session (reinject
 * markers visible in only 4 of 17 compacts; one session compacted 4× in a day and could only
 * ever reinject once). So: this hook injects on `clear` and `compact` events only — never on
 * resume/startup/fork — and dedups same-event double-fires with a short time window, not a
 * permanent marker. A second compact an hour later MUST inject again.
 *
 * HONESTY RULES: the mtime choice is announced when several handoffs exist (the newest file
 * may be another thread's); truncation is loud and names the file; a `/clear` with nothing to
 * load says so — an unloaded context must never look loaded from the outside.
 *
 * Hook input (stdin JSON): session_id, source (clear|compact|resume|startup|fork), cwd.
 * Output: SessionStart additionalContext JSON on stdout. Exit 0 ALWAYS — a hook must never
 * break the session's start; failure is announced in-chat or silent, never fatal.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

const MAX_TOTAL = 10_000          // platform cap for hook output strings
const MAX_MANUAL = 7_000          // manual handoff preview budget
const MAX_AUTO = 2_300            // machine page budget (with headers, stays under the cap)
const DEDUP_WINDOW_MS = 120_000   // same-event double-fire guard — time-boxed, never permanent
const MARKER_PREFIX = ".written-" // same convention as the clear-gate's arm marker

function readEvent() {
  try { return JSON.parse(readFileSync(0, "utf8")) } catch { return {} }
}

function cut(text, max, path) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n… (truncated — full page: \`${path}\`, ${text.length} chars — READ IT before working)`
}

function session8(sessionId) {
  return String(sessionId ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "ismeretlen"
}

/**
 * Candidate handoff dirs: the session's cwd tree FIRST, then every sibling worktree's
 * (9.1, measured 2026-09-13: a manual clear of the consumer's worktree agent reloaded the MAIN
 * repo's newest handoff — a different thread — because the tree was resolved from the hook's
 * install location instead of the thread). Enumerating worktrees is what makes the
 * marker-based choice below able to find the thread wherever in the fan it wrote its handoff.
 */
export function candidateHandoffDirs(startDir) {
  const dirs = [startDir]
  try {
    const out = execFileSync("git", ["-C", dirname(startDir), "worktree", "list", "--porcelain"], { encoding: "utf8" })
    for (const m of out.matchAll(/^worktree (.+)$/gm)) dirs.push(join(m[1], ".set/handoff"))
  } catch { /* not a git tree (or no git) — the cwd tree alone */ }
  return [...new Set(dirs)]
}

/** The handoff THIS session armed with, if its marker still names an existing file. */
function markerChoice(dirs, s8) {
  if (s8 === "ismeretlen") return null
  for (const dir of dirs) {
    const mp = join(dir, MARKER_PREFIX + s8)
    if (!existsSync(mp)) continue
    try {
      const name = readFileSync(mp, "utf8").trim().split(/\s+/)[1]
      if (name && existsSync(join(dir, name))) return { dir, file: name }
    } catch { /* unreadable marker — fall through to mtime */ }
  }
  return null
}

export function buildInjection({ dir, source, now = Date.now(), sessionId = "" }) {
  if (source !== "clear" && source !== "compact") return null // per-event allowlist

  const s8 = session8(sessionId)
  const dirs = candidateHandoffDirs(dir).filter((d) => existsSync(d))

  if (dirs.length === 0) return source === "clear"
    ? plain("No handoff directory found — this cleared context starts with nothing loaded. If a thread was open here, it was not written down.")
    : null

  // Resolution order: the session's OWN marker across ALL candidate trees (it names the exact
  // file this session armed with), then newest-by-mtime of the CWD's OWN tree — loudly
  // announced as the heuristic it is. Merging the other trees into the mtime fallback was
  // MEASURED harmful on 2026-09-13: the bugfix pane (cwd = main tree, no marker reachable by
  // its fresh id) got a sibling worktree's newer page as its reload. Other trees' pages stay
  // REACHABLE — listed by full path — but never become the primary choice by recency.
  const marked = markerChoice(dirs, s8)

  // Manual handoffs (not the machine `--allapot.md` pages) — all trees, newest first, for
  // the listing; the fallback CHOICE below reads only the cwd's own tree.
  const manual = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith(".md") && !f.endsWith("--allapot.md"))
      .map((f) => ({ dir: d, f, m: statSync(join(d, f)).mtimeMs })),
  ).sort((a, b) => b.m - a.m)

  const homeManual = manual.filter((k) => k.dir === dir)
  const chosen = marked ?? (homeManual[0] ? { dir: homeManual[0].dir, file: homeManual[0].f } : null)

  const parts = []
  let used = 0

  if (chosen) {
    const p = join(chosen.dir, chosen.file)
    let body = ""
    try { body = readFileSync(p, "utf8") } catch { body = null }
    const shown = chosen.dir === dir ? `.set/handoff/${chosen.file}` : p
    const reason = marked
      ? "chosen by THIS session's own arm marker — the thread you wrote before the clear"
      : "chosen as newest by mtime — in a parallel-session tree, verify it is YOURS"
    const others = manual.filter((k) => !(k.dir === chosen.dir && k.f === chosen.file))
    parts.push([
      `## ⚠ Fresh context — handoff reloaded (${source})`,
      "",
      `**Handoff: \`${shown}\`** (${reason}).`,
      others.length > 0 ? `Other live handoffs: ${others.slice(0, 6).map((k) => (k.dir === dir ? `.set/handoff/${k.f}` : join(k.dir, k.f))).join(", ")}.` : "",
      "",
      body == null
        ? `⚠ The handoff file exists but is UNREADABLE — open it by hand before working.`
        : cut(body, Math.min(MAX_MANUAL, MAX_TOTAL - used - 400), p),
      "",
    ].filter((s) => s !== "").join("\n"))
    used += parts[0].length
  } else if (source === "clear") {
    parts.push([
      "## ⚠ Fresh context — NOTHING to load",
      "",
      "No handoff exists in this repository or its worktrees. If a work thread was open before the clear, it was not written down; proceed carefully and re-measure state from the repo.",
      "",
    ].join("\n"))
    used += parts[0].length
  }

  // The machine page (PreCompact hook output), if present — secondary, smaller frame.
  const latestPtr = join(dir, ".latest")
  if (existsSync(latestPtr)) {
    try {
      const name = readFileSync(latestPtr, "utf8").trim()
      const p = join(dir, name)
      if (name && existsSync(p)) {
        const auto = cut(readFileSync(p, "utf8"), Math.max(0, Math.min(MAX_AUTO, MAX_TOTAL - used - 200)), p)
        if (auto.trim()) parts.push(`### Machine state page (hook-written — numbers, not intent)\n\n${auto}`)
      }
    } catch { /* a bad pointer must not take the injection down */ }
  }

  return parts.length ? parts.join("\n") : null
}

function plain(text) {
  return text
}

function emit(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
  }))
}

/** Same-event double-fire guard, exported for the regression test of the measured bug. */
export function sameEventDoubleFire(dedupPath, now = Date.now(), windowMs = DEDUP_WINDOW_MS) {
  return existsSync(dedupPath) && now - statSync(dedupPath).mtimeMs < windowMs
}

function main() {
  const ev = readEvent()
  const dir = process.env.HANDOFF_DIR ?? join(ev.cwd ?? process.cwd(), ".set/handoff")
  const injection = buildInjection({ dir, source: ev.source, now: Date.now(), sessionId: ev.session_id })
  if (!injection) return

  // Same-event double-fire guard: a marker per session+source, honored only inside the window.
  // Past the window it is ignored — that is what makes a later compact inject again.
  const s8 = String(ev.session_id ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "x"
  const dedup = join(dir, `.injected-${s8}-${ev.source}`)
  if (sameEventDoubleFire(dedup)) return
  try { writeFileSync(dedup, new Date().toISOString() + "\n") } catch { /* worst case: one duplicate */ }

  emit(injection)
}

// Run only when invoked as the hook itself — importing this module (the tests do) must never
// touch stdin, which would block the importer forever.
const invoked = process.argv[1] ? resolve(process.argv[1]) : ""
if (invoked === fileURLToPath(import.meta.url)) {
  try { main() } catch { /* never break the session start */ }
  process.exit(0)
}
