## ADDED Requirements

### Requirement: Hooks run from the installed package with no per-repo copy
The CLI SHALL provide `hook <arm|reinject|keep-going> [args…]`, which runs the package's own hook template
with the caller's stdin and passes its stdout and exit code through.

#### Scenario: Arm through the package
- **WHEN** `set-claude-handoff hook arm` receives a PostToolUse event for a passing handoff sheet
- **THEN** the session's `.written-<session8>` marker is written exactly as the copied hook writes it

### Requirement: A plugin line stands down where the project wires its own copy
WITH `--from-plugin`, `hook` SHALL do nothing and print nothing when the project's
`.claude/settings.json` or `.claude/settings.local.json` names that hook's file.

#### Scenario: Project still wires its copy
- **WHEN** the project's settings name `handoff-reinject-clear.mjs` and `hook reinject --from-plugin` runs
- **THEN** it exits 0 with no output, so the reload is injected once

#### Scenario: Unwired copy
- **WHEN** a hook file exists in `.claude/hooks/` but no settings file names it
- **THEN** the plugin line runs the hook

### Requirement: plugin-files merges portable lines into a plugin
`plugin-files <plugin-dir>` SHALL merge lines with no machine path into `<plugin-dir>/hooks/hooks.json`,
replace only its own earlier lines, keep every other hook, and report a vendored copy of the same hook.
With `--dry-run` it SHALL write nothing.

#### Scenario: Existing plugin hooks
- **WHEN** hooks.json already holds foreign hooks and a vendored `keep-going.mjs` line
- **THEN** the foreign hooks are unchanged, the portable lines are added once even after a second run, and
  the vendored line is named in the report

### Requirement: The watcher runs from the package and is visible to keep-going
`watch --dir <tree>` SHALL run the package's watcher with the package's gate. Every watcher pass SHALL write
`<tree>/.set/handoff/.watcher-alive`, and keep-going SHALL treat a heartbeat younger than 10 minutes as a
watched tree.

#### Scenario: Tree with no copies
- **WHEN** a tree has no `.claude/hooks/watch-auto-clear.sh` but a heartbeat 2 min old, and a session stops at the threshold
- **THEN** keep-going asks for the handoff

### Requirement: A missing binary is announced at session start
The SessionStart line SHALL announce, in `additionalContext`, that the handoff reload is off when the binary
cannot be found.

#### Scenario: Binary not installed
- **WHEN** neither `set-claude-handoff` on PATH nor `~/.local/bin/set-claude-handoff` exists
- **THEN** the session start context says the reload is off and how to install the package
