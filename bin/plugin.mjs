/**
 * Hook wiring with no per-repo copy (specs: portable-hooks).
 *
 * `hook <name>` runs the package's own template, so a plugin's hooks.json can call the installed
 * binary instead of a copy in every repo. `plugin-files` writes those lines into a plugin. A copy a
 * project still wires keeps working: with --from-plugin the line stands down there, because a double
 * reinject injects twice and a double keep-going spends the budget twice.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"

export const HOOKS = {
  arm: { file: "handoff-arm.mjs", template: "templates/handoff-arm.mjs", event: "PostToolUse", matcher: "Write|Edit|MultiEdit|Bash", timeout: 10 },
  reinject: { file: "handoff-reinject-clear.mjs", template: "templates/hooks/handoff-reinject-clear.mjs", event: "SessionStart", matcher: "clear|compact", timeout: 15 },
  "keep-going": { file: "keep-going.mjs", template: "templates/keep-going.mjs" },
}

/**
 * Does the project's own settings wire this hook? Settings decide, not the file's presence. Two shapes
 * count: a copy (`…/handoff-reinject-clear.mjs`) and the package line written into settings
 * (`set-claude-handoff hook reinject`, without --from-plugin). Missing the second would make a plugin
 * fire beside a project that wires the package itself: a double reload, a budget spent twice.
 */
export function projectWires(projectDir, name) {
  const h = HOOKS[name]
  const pkgLine = new RegExp(`\\shook\\s+${name.replace("-", "\\-")}(\\s|$)`)
  for (const f of ["settings.json", "settings.local.json"]) {
    let text
    try { text = readFileSync(join(projectDir, ".claude", f), "utf8") } catch { continue }
    if (text.includes(h.file)) return true
    let commands = []
    try { commands = commandsOf(JSON.parse(text)) } catch { continue } // unparsable: the runtime cannot run it either
    // a package line is the project's own only WITHOUT --from-plugin; with it, it is a plugin-style line
    if (commands.some((c) => c.includes("set-claude-handoff") && pkgLine.test(c) && !c.includes("--from-plugin"))) return true
  }
  return false
}

function commandsOf(node, out = []) {
  if (Array.isArray(node)) for (const n of node) commandsOf(n, out)
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) k === "command" && typeof v === "string" ? out.push(v) : commandsOf(v, out)
  return out
}

export function cmdHook(pkgRoot, rest, { env = process.env, cwd = process.cwd() } = {}) {
  const [name, ...args] = rest
  const h = HOOKS[name]
  if (!h) {
    console.error(`hook: unknown hook "${name ?? ""}" — one of: ${Object.keys(HOOKS).join(", ")}`)
    return 0 // a hook error must never break the work
  }
  const fromPlugin = args.includes("--from-plugin")
  const pass = args.filter((a) => a !== "--from-plugin")
  if (fromPlugin && projectWires(env.CLAUDE_PROJECT_DIR || cwd, name)) return 0
  const r = spawnSync(process.execPath, [join(pkgRoot, h.template), ...pass], { stdio: "inherit", env })
  return r.status ?? 0
}

export function cmdWatch(pkgRoot, rest) {
  const args = rest.includes("--gate") ? rest : ["--gate", join(pkgRoot, "templates", "clear-gate.mjs"), ...rest]
  const r = spawnSync("bash", [join(pkgRoot, "templates", "watch-auto-clear.sh"), ...args], { stdio: "inherit" })
  return r.status ?? 1
}

const FIND = 'H="$(command -v set-claude-handoff || echo "$HOME/.local/bin/set-claude-handoff")"'
const MISSING = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext:
  "[set-claude-handoff] ⚠ The handoff reload is OFF on this machine: `set-claude-handoff` is not installed " +
  "(not on PATH, not in ~/.local/bin), so this cleared or compacted context got no handoff. Load yours with " +
  "`/handoff <ID>`. Fix: `npm i -g set-claude-handoff`, then restart the session." } })

/** The portable hook lines: no machine path, the binary found at run time. */
export function pluginLines({ keepGoing = false } = {}) {
  const quiet = (args) => `${FIND}; [ -x "$H" ] && "$H" hook ${args} --from-plugin || true`
  const lines = [
    { ...HOOKS.reinject, name: "reinject", command: `${FIND}; if [ -x "$H" ]; then "$H" hook reinject --from-plugin; else echo '${MISSING}'; fi` },
    { ...HOOKS.arm, name: "arm", command: quiet("arm") },
  ]
  if (keepGoing) {
    lines.push({ file: HOOKS["keep-going"].file, name: "keep-going stop", event: "Stop", matcher: null, timeout: 10, command: quiet("keep-going stop --max 40") })
    lines.push({ file: HOOKS["keep-going"].file, name: "keep-going post", event: "PostToolUse", matcher: "*", timeout: 10, command: quiet("keep-going post") })
  }
  return lines
}

// Our own earlier lines: they find the binary and call `hook`. Matched so a re-run replaces them.
const isOwn = (cmd) => cmd.includes("command -v set-claude-handoff") && cmd.includes('"$H" hook ')

/** Merge the portable lines into <dir>/hooks/hooks.json: own lines replaced, everything else kept. */
export function mergePluginHooks(doc, lines) {
  const out = JSON.parse(JSON.stringify(doc ?? {}))
  out.hooks ??= {}
  for (const ev of Object.keys(out.hooks)) {
    out.hooks[ev] = out.hooks[ev]
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !isOwn(String(h.command ?? ""))) }))
      .filter((e) => e.hooks.length > 0)
    if (out.hooks[ev].length === 0) delete out.hooks[ev]
  }
  const vendored = []
  for (const [ev, entries] of Object.entries(out.hooks)) {
    for (const e of entries) for (const h of e.hooks) {
      const hit = lines.find((l) => String(h.command ?? "").includes(l.file))
      if (hit) vendored.push(`${ev}: ${h.command}`)
    }
  }
  for (const l of lines) {
    const entry = { ...(l.matcher ? { matcher: l.matcher } : {}), hooks: [{ type: "command", command: l.command, timeout: l.timeout }] }
    ;(out.hooks[l.event] ??= []).push(entry)
  }
  return { doc: out, vendored: [...new Set(vendored)] }
}

export function cmdPluginFiles(rest, { log = console.log } = {}) {
  const dir = rest.find((a) => !a.startsWith("--"))
  if (!dir) { console.error("usage: set-claude-handoff plugin-files <plugin-dir> [--keep-going] [--dry-run]"); return 2 }
  const path = join(dir, "hooks", "hooks.json")
  let doc = { hooks: {} }
  if (existsSync(path)) {
    try { doc = JSON.parse(readFileSync(path, "utf8")) } catch (e) { console.error(`${path} is not valid JSON (${e.message}) — nothing written`); return 1 }
  }
  const lines = pluginLines({ keepGoing: rest.includes("--keep-going") })
  const { doc: merged, vendored } = mergePluginHooks(doc, lines)
  const dry = rest.includes("--dry-run")
  if (!dry) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(merged, null, 2) + "\n") }
  log(`${dry ? "would write" : "wrote"}  ${path}: ${lines.map((l) => `${l.event}(${l.matcher ?? "*"}) → hook ${l.name}`).join(", ")}`)
  if (vendored.length) {
    log(`⚠ This plugin also wires a copy of the same hook, so both would fire. Remove these lines once the portable ones are in:`)
    for (const v of vendored) log(`    ${v}`)
  }
  log(`A project that still wires its own copy in .claude/settings*.json keeps it; the plugin's line stands down there.`)
  log(`The watcher runs from the package too: set-claude-handoff watch --dir <tree> --interval 60 --auto-continue default`)
  return 0
}
