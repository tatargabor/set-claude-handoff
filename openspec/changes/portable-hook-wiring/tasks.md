## 1. CLI

- [x] 1.1 `hook <arm|reinject|keep-going>`: spawn the template with inherited stdio, pass the exit code [REQ: hooks-run-from-the-installed-package-with-no-per-repo-copy]
- [x] 1.2 `--from-plugin` stand-down read from the project's settings files [REQ: a-plugin-line-stands-down-where-the-project-wires-its-own-copy]
- [x] 1.3 `plugin-files <dir> [--keep-going] [--dry-run]`: merge, idempotent, vendored-copy report [REQ: plugin-files-merges-portable-lines-into-a-plugin]
- [x] 1.4 SessionStart line announces a missing binary [REQ: a-missing-binary-is-announced-at-session-start]
- [x] 1.5 `watch`: exec the package watcher with the package gate [REQ: the-watcher-runs-from-the-package-and-is-visible-to-keep-going]

## 2. Watcher and keep-going

- [x] 2.1 Watcher heartbeat each pass; AP_DIR from the gate's directory [REQ: the-watcher-runs-from-the-package-and-is-visible-to-keep-going]
- [x] 2.2 keep-going: a fresh heartbeat counts as a watched tree [REQ: the-watcher-runs-from-the-package-and-is-visible-to-keep-going]

## 3. Close

- [x] 3.1 Tests for every scenario, each failing without its change [REQ: hooks-run-from-the-installed-package-with-no-per-repo-copy]
- [x] 3.2 README and auto-clear skill: plugin wiring; `npm test` [REQ: plugin-files-merges-portable-lines-into-a-plugin]

## Acceptance Criteria (from spec scenarios)

- [x] AC-1: WHEN `hook arm` gets a passing sheet event THEN the marker is written [REQ: hooks-run-from-the-installed-package-with-no-per-repo-copy, scenario: arm-through-the-package]
- [x] AC-2: WHEN settings name the hook file THEN `--from-plugin` exits 0 silently [REQ: a-plugin-line-stands-down-where-the-project-wires-its-own-copy, scenario: project-still-wires-its-copy]
- [x] AC-3: WHEN a copy exists unwired THEN the plugin line runs [REQ: a-plugin-line-stands-down-where-the-project-wires-its-own-copy, scenario: unwired-copy]
- [x] AC-4: WHEN foreign hooks and a vendored line exist THEN foreign kept, own lines once after two runs, vendored reported [REQ: plugin-files-merges-portable-lines-into-a-plugin, scenario: existing-plugin-hooks]
- [x] AC-5: WHEN no watcher copy but a 2-min heartbeat THEN keep-going asks for the handoff [REQ: the-watcher-runs-from-the-package-and-is-visible-to-keep-going, scenario: tree-with-no-copies]
- [x] AC-6: WHEN the binary is missing THEN session start says the reload is off [REQ: a-missing-binary-is-announced-at-session-start, scenario: binary-not-installed]
