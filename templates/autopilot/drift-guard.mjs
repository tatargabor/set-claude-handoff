#!/usr/bin/env node
/**
 * autopilot/drift-guard — may a freshly cleared session be continued automatically?
 * (specs: drift-guard). EVALUATES ONLY — the watcher types, and only on `continue: true`.
 *
 * Checks, all of which must hold (each is named in the verdict, pass or fail):
 *   optout     — `.no-autopilot` (tree) / `.no-autopilot-<session8>` absent
 *   bound      — the session is bound to a thread, and its reload was NOT chosen by file age.
 *                Measured 2026-09-13 08:46:52Z: an mtime-chosen reload loaded another worktree's
 *                thread; with auto-continue on, that session would have continued a thread that
 *                belonged to another seat.
 *   budget     — automatic continuations since the last human input < maxAutoContinues
 *   alignment  — when a judge is configured: `aligned` only; error/timeout counts as `unclear`.
 *                Without a judge the check is SKIPPED AND SAYS SO.
 *
 * Usage: node drift-guard.mjs --session <freshId> [--dir <handoffDir>] [--cwd <tree>] [--json]
 * Exit 0 whenever the evaluation ran (the exit code is never the trigger); 2 on usage error.
 */
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { findHandoffFile, loadConfig, logVerdict, optoutState, readThread, silenceCounts, threadOf } from "./ledger.mjs"
import { buildAlignmentPrompt, runJudge } from "./judge.mjs"

/** The handoff's summary and its CURRENT next step — a later UPDATE block supersedes §5. */
export function handoffCourse(body) {
  const text = String(body ?? "")
  const summary = /\*\*In one sentence:\*\*\s*(.+)/.exec(text)?.[1] ?? ""
  const lines = text.split("\n")
  const s5 = lines.findIndex((l) => /^##\s*5\./.test(l))
  let nextStep = ""
  if (s5 >= 0) {
    const end = lines.findIndex((l, i) => i > s5 && /^##\s/.test(l))
    nextStep = lines.slice(s5 + 1, end < 0 ? undefined : end).join("\n").trim()
  }
  const update = lines.findIndex((l) => /^#+\s*UPDATE\b|^\*\*UPDATE\b/i.test(l))
  if (update >= 0) nextStep = `${lines.slice(update).join("\n").trim()}\n\n(original §5, superseded where the UPDATE says so:)\n${nextStep}`
  return { summary, nextStep }
}

export function evaluate({ dir, sessionId, cwd, config, judge = runJudge }) {
  const cfg = config ?? loadConfig(cwd ?? process.cwd())
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })

  const opt = optoutState(dir, sessionId)
  add("optout", !opt.off, opt.off ? `switched off (${opt.tree ? "project .no-autopilot" : "session"})` : "no opt-out")

  const thread = threadOf(dir, sessionId)
  const mtimeReload = thread.reload && thread.reload.choice !== "marker"
  const bound = thread.bound && !mtimeReload
  add("bound", bound,
    mtimeReload ? `unbound — reload chosen by ${thread.reload.choice}${thread.reload.id ? ` (${thread.reload.id})` : ""}`
    : thread.bound ? `thread ${thread.id} (${thread.via})` : `unbound — ${thread.via}`)

  const entries = bound ? readThread(dir, thread.id) : []
  const silence = silenceCounts(entries)
  const max = cfg.maxAutoContinues ?? 3
  add("budget", silence.continues < max, `${silence.continues} automatic continuation(s) since the last human input, budget ${max}`)

  if (!cfg.judgeCommand || cfg.alignment === false) {
    add("alignment", true, `skipped — ${cfg.alignment === false ? "alignment disabled in profile" : "no judge configured"}; deterministic checks only`)
  } else if (!bound) {
    add("alignment", false, "not evaluated — no bound thread")
  } else {
    const file = findHandoffFile(dir, thread.id)
    if (!file) add("alignment", false, `unclear — handoff ${thread.id} not found in ${dir}`)
    else {
      const course = handoffCourse(readFileSync(file, "utf8"))
      const r = judge({ command: cfg.judgeCommand, prompt: buildAlignmentPrompt({ entries, ...course }), timeoutSec: cfg.judgeTimeoutSec })
      const v = String(r.verdict?.verdict ?? "unclear").toLowerCase()
      add("alignment", v === "aligned", r.error ? `unclear — ${r.error}` : `${v}: ${r.verdict?.reason ?? "no reason given"} (${r.latencyMs} ms)`)
    }
  }

  return { continue: checks.every((c) => c.ok), thread: thread.id, checks, config: cfg.source, at: new Date().toISOString() }
}

function main(argv) {
  const get = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const sessionId = get("--session")
  if (!sessionId) { console.error("--session is required"); return 2 }
  const cwd = resolve(get("--cwd") ?? process.cwd())
  const dir = resolve(get("--dir") ?? join(cwd, ".set", "handoff"))
  if (!existsSync(dir)) { console.log(JSON.stringify({ continue: false, checks: [{ name: "dir", ok: false, detail: `handoff dir missing: ${dir}` }] })); return 0 }
  const result = evaluate({ dir, sessionId, cwd })
  logVerdict(dir, { kind: "drift-guard", session: sessionId.slice(0, 8), continue: result.continue, checks: result.checks })
  if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2))
  else {
    for (const c of result.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(10)} ${c.detail}`)
    console.log(result.continue ? "CONTINUE — the watcher may send the continue prompt" : "HOLD — no continue prompt")
  }
  return 0
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ""
if (invoked === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
