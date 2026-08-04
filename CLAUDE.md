# set-claude-handoff — project instructions

**A `/handoff` skill for Claude Code: one work thread, measured, written to an ID-tagged file so
that `/clear` beats a compact.**

Extracted on 2026-08-04 from a private ERP project where the cost was measured: 62 forced
compacts in two days, 69% of the token budget spent re-reading context instead of working.

## Language

Code, comments, README, CLI output, `skills/**`, `templates/**`: **English** — this is a public
package. Conversation with the user and any working notes under `docs/`: **Hungarian** (full
diacritics, never ASCII substitutes).

## The three principles — do not weaken these

1. **Nothing project-specific in `skills/handoff/SKILL.md`.** The moment a concrete command, path
   or domain term lands there, every consumer forks the file and the package stops being an
   upgrade path. Project specifics go in `.claude/handoff.profile.md`, which the project owns.
   This is the reason the package exists — three repos had already forked the same skill by hand.
2. **Two owners, and `init` respects the boundary.** Package-owned files are overwritten on every
   `init` (that *is* the upgrade); the profile is written once and never touched. An upgrade that
   could clobber a project's probes is an upgrade nobody runs.
3. **Absence is announced, never silent.** No profile → the handoff says so. No `.gitignore` →
   `init` says so. A number that was not measured → *"not measured"*. The whole point of a handoff
   is that the successor cannot verify it, so a confident blank is the worst possible output.

## Tests

```bash
node --test          # zero dependencies
```

**Every regression test names the bug it guards.** The symlink test exists because the entry
guard matched `argv[1]` by suffix, so the npm-installed binary did nothing at all. Do not add a
test for a hypothetical.

## Detection stays shallow on purpose

`init` pre-fills the profile's probe table only from `package.json` scripts, and marks those rows
`detected — verify`. A guessed probe that measures the wrong thing is worse than a blank line: it
looks like someone already thought about it. If you extend detection, it must stay provable from
a file in the repo — never from the directory name or a framework guess.

## Consumers

Three repos, installed 2026-08-04: the ERP project this came from, `a private sibling project` (both replacing a
hand-forked copy that had already drifted) and `set-atlas`. If the skill changes,
`npx set-claude-handoff init` in those repos is the upgrade — and their profiles must survive it.

**Before changing `SKILL.md`, read all three profiles.** They are the evidence for what actually
had to be project-specific; a rule that only one of them needs does not belong in the package.
