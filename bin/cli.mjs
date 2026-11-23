#!/usr/bin/env node
/**
 * set-claude-handoff — installer for the `/handoff` Claude Code skill.
 *
 * Two kinds of file, and the difference is the whole point of this CLI:
 *   - package-owned: skills/handoff/SKILL.md  → overwritten on every init (that is the upgrade)
 *   - project-owned: .claude/handoff.profile.md → written once, NEVER overwritten
 * A skill upgrade that clobbers the project's probes would make upgrading unsafe, so nobody
 * would upgrade.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { cmdHook, cmdWatch, cmdPluginFiles, projectWiringFile } from "./plugin.mjs"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const VERSION = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version

const USAGE = `set-claude-handoff ${VERSION}

  set-claude-handoff init [--global] [--auto-clear] [--autopilot]
                                       install the /handoff skill into this project (or ~/.claude);
                                       --auto-clear also installs the auto-clear hook templates (opt-in)
                                       --autopilot installs the autopilot hooks + /autopilot skill (opt-in)
                                       (both installs ship the /auto-clear on/off switchboard skill)
  set-claude-handoff hook <arm|reinject|keep-going> [args] [--from-plugin]
                                       run a hook from this package, no per-repo copy; --from-plugin
                                       stands down where the project's settings wire its own copy
  set-claude-handoff watch --dir <tree> [watcher flags]
                                       run the auto-clear watcher from this package
  set-claude-handoff plugin-files <plugin-dir> [--keep-going] [--dry-run]
                                       merge the portable hook lines into <plugin-dir>/hooks/hooks.json
  set-claude-handoff --version
  set-claude-handoff help

init writes:
  .claude/skills/handoff/SKILL.md    the skill      (overwritten on re-run = upgrade)
  .claude/skills/auto-clear/SKILL.md the /auto-clear on/off switchboard (same)
  .claude/handoff.profile.md         your probes    (created once, never overwritten)
  .gitignore                         a .set/ entry, if the repo does not ignore it yet

--auto-clear additionally writes (package-owned, overwritten on re-run):
  .claude/hooks/clear-gate.mjs              the gate — evaluates, never triggers
  .claude/hooks/handoff-reinject-clear.mjs  SessionStart(clear|compact) reload
  .claude/hooks/watch-auto-clear.sh         the executor (run it under tmux / systemd)
  .claude/hooks/presence.mjs                the executor's is-a-human-typing check
  .claude/hooks/turn-state.mjs              the executor's is-a-turn-running check + submit confirm
  .claude/hooks/handoff-arm.mjs             arms a session when it writes a passing handoff (PostToolUse)
  .claude/hooks/keep-going.mjs              opt-in: never stop without a real question; handoff at the limit

--autopilot additionally writes (package-owned, overwritten on re-run):
  .claude/hooks/autopilot/*.mjs             intent ledger, capture + answer hooks, drift guard
  .claude/skills/autopilot/SKILL.md         the /autopilot on/off/status switchboard
and PRINTS the settings.json hook snippet + profile fields for you to merge — init never
edits settings.json or your statusline (they are yours; a clobbering installer is one
nobody runs).
`

function main(argv) {
  const [cmd = "help", ...rest] = argv
  switch (cmd) {
    case "init":
      return cmdInit({ global: rest.includes("--global"), autoClear: rest.includes("--auto-clear"), autopilot: rest.includes("--autopilot"), cwd: process.cwd() })
    case "hook":
      return cmdHook(PKG_ROOT, rest)
    case "watch":
      return cmdWatch(PKG_ROOT, rest)
    case "plugin-files":
      return cmdPluginFiles(rest)
    case "--version":
    case "-v":
      console.log(VERSION)
      return 0
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE)
      return 0
    default:
      console.error(`Unknown command: ${cmd}\n`)
      console.log(USAGE)
      return 1
  }
}

/**
 * A user-level skill of the same name SHADOWS the project's copy. Measured 2026-11-23 from the
 * transcripts on one machine: 928 of 938 handoff loads and 297 of 297 auto-clear loads came from
 * ~/.claude/skills/, and the global auto-clear copy was two months behind (it still taught 500k and
 * background blocking on). So the project upgrade this init performs reaches nobody while a stale
 * global copy exists — announce it, never silently.
 */
export function warnShadowingGlobal({ home = homedir(), log = console.log } = {}) {
  const stale = []
  for (const name of ["handoff", "auto-clear", "autopilot"]) {
    const g = join(home, ".claude", "skills", name, "SKILL.md")
    const pkg = join(PKG_ROOT, "skills", name, "SKILL.md")
    if (existsSync(g) && existsSync(pkg) && readFileSync(g, "utf8") !== readFileSync(pkg, "utf8")) stale.push(g)
  }
  if (stale.length === 0) return []
  log(`\n⚠ A user-level copy SHADOWS this project's skill, and it differs from this package version:`)
  for (const g of stale) log(`    ${g}`)
  log(`  Claude Code loads the user-level skill, so the copy just written here is not the one sessions read.`)
  log(`  Refresh it with \`set-claude-handoff init --global\` (a hand edit in it is overwritten), or delete it.`)
  return stale
}

export function cmdInit({ global = false, autoClear = false, autopilot = false, cwd = process.cwd(), log = console.log, home = homedir() } = {}) {
  const target = global ? join(home, ".claude") : join(cwd, ".claude")
  const skillDir = join(target, "skills", "handoff")

  mkdirSync(skillDir, { recursive: true })
  const skillPath = join(skillDir, "SKILL.md")
  const existed = existsSync(skillPath)
  writeFileSync(skillPath, readFileSync(join(PKG_ROOT, "skills", "handoff", "SKILL.md"), "utf8"))
  log(`${existed ? "updated" : "installed"}  ${rel(cwd, skillPath)}`)

  // The auto-clear SKILL (the on/off switchboard) always installs — it is tiny and must be
  // invocable from any project; the machinery it arms stays behind --auto-clear.
  const acSkillDir = join(target, "skills", "auto-clear")
  mkdirSync(acSkillDir, { recursive: true })
  const acSkillPath = join(acSkillDir, "SKILL.md")
  const acExisted = existsSync(acSkillPath)
  writeFileSync(acSkillPath, readFileSync(join(PKG_ROOT, "skills", "auto-clear", "SKILL.md"), "utf8"))
  log(`${acExisted ? "updated" : "installed"}  ${rel(cwd, acSkillPath)}`)

  if (autoClear) installAutoClear({ target, cwd, log })
  if (autopilot) installAutopilot({ target, cwd, log })

  if (!global) warnShadowingGlobal({ home, log })

  if (global) {
    // The profile describes ONE project's probes, so a user-wide install has nothing to put in
    // it. Say so — otherwise the skill reports "no project profile" and the reason looks like a bug.
    log(`\nGlobal install: no profile written (it is per project).`)
    log(`Run \`set-claude-handoff init\` inside a repo to get .claude/handoff.profile.md.`)
    return 0
  }

  const profilePath = join(target, "handoff.profile.md")
  if (existsSync(profilePath)) {
    log(`kept      ${rel(cwd, profilePath)}  (project-owned — not overwritten)`)
  } else {
    writeFileSync(profilePath, buildProfile(cwd))
    log(`created   ${rel(cwd, profilePath)}  ← edit this: it is what makes the handoff measure`)
  }

  const ignore = ensureSetIgnored(cwd)
  if (ignore === "added") log(`updated   .gitignore  (added .set/ — handoffs are never committed)`)
  else if (ignore === "already") log(`ok        .gitignore already ignores .set/`)
  else log(`note      no .gitignore found — make sure .set/ is not committed`)

  log(`\nDone. In Claude Code:  /handoff   ·   /handoff <ID>   ·   /handoff list`)
  return 0
}

function rel(cwd, p) {
  const r = relative(cwd, p)
  return r.startsWith("..") ? p : r
}

/**
 * The auto-clear half (opt-in via --auto-clear). Installs the two package-owned hook files,
 * then PRINTS what the project must merge itself: the settings.json hook registration and the
 * statusline fragment. settings.json and the statusline are consumer-owned — an installer that
 * edits them could clobber a project's own hooks, and an upgrade nobody dares run is no upgrade.
 */
function installAutoClear({ target, cwd, log }) {
  const hooksDir = join(target, "hooks")
  mkdirSync(hooksDir, { recursive: true })
  // The executor and its presence check travel with the gate: the watcher's presence gate (the
  // measured 10:03:50Z typing collision) only reaches a consumer if init ships the watcher too.
  // turn-state.mjs likewise: the watcher exits at start without it, so an init that forgot it
  // (measured 2026-09-21) upgraded a consumer into a watcher that cannot run.
  for (const f of ["clear-gate.mjs", join("hooks", "handoff-reinject-clear.mjs"), "watch-auto-clear.sh", "presence.mjs", "turn-state.mjs", "handoff-arm.mjs", "keep-going.mjs"]) {
    const src = join(PKG_ROOT, "templates", f)
    const dst = join(hooksDir, f.split("/").pop())
    writeFileSync(dst, readFileSync(src, "utf8"), { mode: f.endsWith(".sh") ? 0o755 : 0o644 })
    log(`installed ${rel(cwd, dst)}  (package-owned — overwritten on re-run)`)
  }
  // The wiring stamp (change started-after-self-exclusion): the watcher's --started-after
  // defaults to THIS moment instead of its own start, so a watcher restart stops excluding
  // sessions that already had the hook (measured 2026-11-23: "--started-after now" excluded the
  // arming session itself — one tree's only working session, skipped 2858 times). ONE line,
  // ISO-8601 UTC with Z, parsed with Date.parse. Written only when absent: a re-run that moved
  // it would push every session started since the first install behind the filter. set-core's
  // default install reads this same file instead of recording its own install time.
  const stamp = join(cwd, ".set", "handoff", ".reload-wired-at")
  if (existsSync(stamp)) {
    log(`kept      ${rel(cwd, stamp)}  (the wiring stamp — written once, never moved)`)
  } else if (projectWiringFile(cwd, "reinject")) {
    // The stamp's meaning: sessions started after it have the reload hook. Only a settings file
    // that already wires the hook can prove that moment — "now" is wrong both ways: on a tree
    // wired long ago it re-excludes every running session (the very bug the stamp exists to fix),
    // and on a first install it lands BEFORE the hand-merge of the hook into settings, so sessions
    // started in between pass the filter with no hook (the unsafe direction). The wiring file's
    // own mtime is at or after its wiring edit, so it errs late = safe.
    // The mtime of the file that WIRES it, by the same predicate: a loose "mentions reinject" scan
    // took settings.json's mtime when it carried only a --from-plugin line and the real wiring sat
    // in settings.local.json — a stamp from the wrong file's edit, possibly before the wiring.
    const wiredAt = statSync(projectWiringFile(cwd, "reinject")).mtimeMs
    mkdirSync(dirname(stamp), { recursive: true })
    writeFileSync(stamp, new Date(wiredAt).toISOString().replace(/\.\d{3}Z$/, "Z") + "\n")
    log(`created   ${rel(cwd, stamp)}  (the wiring stamp — the watcher's --started-after default)`)
  } else {
    log(`not yet  ${rel(cwd, stamp)} — the reload hook is not wired in .claude/settings.json yet; after merging it, re-run init --auto-clear (or write the stamp: date -u +%Y-%m-%dT%H:%M:%SZ > .set/handoff/.reload-wired-at)`)
  }
  log(`
Next, merge YOURSELF (init never touches these — they are consumer-owned):

1. .claude/settings.json — add to "hooks"."SessionStart" (merge with existing matchers):
     { "matcher": "clear|compact", "hooks": [ { "type": "command",
         "command": "node \\"$CLAUDE_PROJECT_DIR/.claude/hooks/handoff-reinject-clear.mjs\\"", "timeout": 15 } ] }

   and to "hooks"."PostToolUse" — the arming hook (skip it if the project has its own):
     { "matcher": "Write|Edit|MultiEdit|Bash", "hooks": [ { "type": "command",
         "command": "node \\"$CLAUDE_PROJECT_DIR/.claude/hooks/handoff-arm.mjs\\"", "timeout": 10 } ] }

   OPTIONAL — keep-going (the session stops only on a line starting NEED INPUT: or ALL DONE:,
   and writes the handoff itself at the limit; off again with: touch .set/handoff/.no-keepgoing):
     "Stop":        [ { "hooks": [ { "type": "command",
         "command": "node \\"$CLAUDE_PROJECT_DIR/.claude/hooks/keep-going.mjs\\" stop --max 40", "timeout": 10 } ] } ]
     "PostToolUse": [ { "matcher": "*", "hooks": [ { "type": "command",
         "command": "node \\"$CLAUDE_PROJECT_DIR/.claude/hooks/keep-going.mjs\\" post", "timeout": 10 } ] } ]
   No --threshold: keep-going then reads the gate's own default, so a package upgrade moves both.
   A number written into settings.json stays behind (seen: 500000 after the gate moved to 400000).
   Pass --threshold to keep-going ONLY with the same --threshold on the watcher. Start the watcher
   with --auto-continue default so the cleared session is re-prompted.

2. Your statusline (~/.claude/statusline.sh) — paste the fragment from
   templates/statusline-persist.sh so .set/handoff/.context-tokens gets the live token count.

3. Profile fields (document them in .claude/handoff.profile.md — init does not write profiles):
     clearThresholdTokens: 400000   tokenFreshnessSeconds: 300   backgroundWorkBlocks: false
   Pass them to the gate:  node .claude/hooks/clear-gate.mjs --threshold 400000 --freshness 300
                           --background-work-blocks false --session <id> --transcript <path> --json

The gate only EVALUATES (exit 0, verdict in stdout/--json); an external executor — tmux
send-keys or the fleet pty owner — reads the verdict and types /clear. See the specs:
specs/auto-clear (gates) and specs/clear-reload (reload), plus templates/selftest-clear-reload.sh
for the live check.`)
  return 0
}

/**
 * The autopilot half (opt-in via --autopilot). Every hook imports `./ledger.mjs` and friends, so
 * the whole directory is installed together — a partial install would break every hook at load.
 * settings.json and the profile stay consumer-owned: init prints the merge, never performs it.
 */
function installAutopilot({ target, cwd, log }) {
  const apSrc = join(PKG_ROOT, "templates", "autopilot")
  const apDst = join(target, "hooks", "autopilot")
  mkdirSync(apDst, { recursive: true })
  for (const f of readdirSync(apSrc).filter((f) => f.endsWith(".mjs")).sort()) {
    writeFileSync(join(apDst, f), readFileSync(join(apSrc, f), "utf8"))
    log(`installed ${rel(cwd, join(apDst, f))}  (package-owned — overwritten on re-run)`)
  }
  const skillDir = join(target, "skills", "autopilot")
  mkdirSync(skillDir, { recursive: true })
  const skillPath = join(skillDir, "SKILL.md")
  const existed = existsSync(skillPath)
  writeFileSync(skillPath, readFileSync(join(PKG_ROOT, "skills", "autopilot", "SKILL.md"), "utf8"))
  log(`${existed ? "updated" : "installed"}  ${rel(cwd, skillPath)}`)
  const hook = (file, extra = "") => `{ "type": "command", "command": "node \\"$CLAUDE_PROJECT_DIR/.claude/hooks/autopilot/${file}\\""${extra} }`
  log(`
Next, merge YOURSELF (init never touches these — they are consumer-owned):

1. .claude/settings.json — add to "hooks" (merge with the matchers you already have):
     "UserPromptSubmit": [ { "hooks": [ ${hook("capture-prompt.mjs", `, "timeout": 15`)} ] } ]
     "PostToolUse":      [ { "matcher": "AskUserQuestion", "hooks": [ ${hook("capture-answer.mjs", `, "timeout": 15`)} ] } ]
     "PreToolUse":       [ { "matcher": "AskUserQuestion", "hooks": [ ${hook("answer-dialog.mjs", `, "timeout": 120`)} ] } ]
     "Stop":             [ { "hooks": [ ${hook("answer-stop.mjs", `, "asyncRewake": true, "timeout": 120`)} ] } ]

2. .claude/handoff.profile.md — an "## Autopilot" section with ONE json block (defaults shown;
   omit the section to run on defaults — the hooks say so in their verdicts):
     \`\`\`json
     { "judgeCommand": ["claude", "-p", "--model", "haiku", "--output-format", "json"],
       "judgeTimeoutSec": 45, "maxAutoContinues": 3, "maxAutoAnswers": 8,
       "denyList": [], "replaceDefaultDenyList": false, "directivePatterns": [],
       "charterChars": 1500, "alignment": true, "minQuoteChars": 12 }
     \`\`\`

3. The auto-clear watcher: restart it with --autopilot, so every automatic continuation runs
   through .claude/hooks/autopilot/drift-guard.mjs first.

Switch it off any time from a prompt: a line starting with "autopilot off" (or "autopilot ki";
add "project" for the whole tree). "autopilot on" / "autopilot be" switches it back.`)
  return 0
}

/**
 * Fill the probe table with what can be PROVEN from the repo (package.json scripts), and leave
 * the rest as placeholders. Detection is deliberately shallow: a guessed probe that measures the
 * wrong thing is worse than a blank line, because it looks like someone already thought about it.
 */
function buildProfile(cwd) {
  const template = readFileSync(join(PKG_ROOT, "templates", "handoff.profile.md"), "utf8")
  const rows = []
  const pkgPath = join(cwd, "package.json")
  if (existsSync(pkgPath)) {
    let scripts = {}
    try {
      scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {}
    } catch {
      // A malformed package.json is the project's business, not ours — fall through with no rows.
    }
    const runner = existsSync(join(cwd, "pnpm-lock.yaml"))
      ? "pnpm"
      : existsSync(join(cwd, "yarn.lock"))
        ? "yarn"
        : "npm run"
    for (const name of ["test", "build", "lint", "typecheck"]) {
      if (scripts[name]) rows.push(`| \`${runner} ${name}\` | ${name} | exit 0 |  <!-- detected — verify -->`)
    }
  }
  if (!rows.length) return template
  return template.replace(
    /\| `<your test command>`.*\n\| `<your build command>`.*\n\| `<your deploy\/status command>`.*\n/,
    rows.join("\n") + "\n| `<your deploy/status command>` | did it ship | the deployed revision |\n",
  )
}

function ensureSetIgnored(cwd) {
  const path = join(cwd, ".gitignore")
  if (!existsSync(path)) return "missing"
  const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim())
  if (lines.some((l) => l === ".set/" || l === ".set" || l === "/.set/" || l === "/.set")) return "already"
  appendFileSync(path, "\n# Session scratch — /handoff writes here; never committed.\n.set/\n")
  return "added"
}

// npm installs the bin as a SYMLINK (node_modules/.bin/set-claude-handoff), so argv[1] is that
// name, not cli.mjs — a suffix check here would make the installed CLI silently do nothing.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : ""
if (invoked === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
