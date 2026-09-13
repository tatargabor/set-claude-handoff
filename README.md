# set-claude-handoff

**Hand one work thread to the next Claude Code session — measured, not remembered.**

A `/handoff` skill that writes what is open, what was decided, what is blocked and what comes
next into an ID-tagged file, so that `/clear` + a fresh session becomes cheaper and cleaner than
letting the context grow until it compacts.

```
/handoff                    → writes .set/handoff/0726-3f9a--<slug>.md, prints the ID
/clear                      → (you issue this)
/handoff 0726-3f9a          → the successor loads the thread and re-measures it
/handoff list               → what is written
```

## Why

Measured in the project this was extracted from: over two days, **62 forced compacts**, and
**69% of the token budget** went into re-reading accumulated context rather than into the work.

A compact is lossy in the worst possible way — it keeps what *looks* important and drops what a
successor cannot reconstruct: which of the four parallel threads is still open, which number came
from a command and which from a guess, which decision was only ever spoken.

## Install

```bash
npm install --save-dev set-claude-handoff
npx set-claude-handoff init
```

`init` writes:

| file | owner | on re-run |
|---|---|---|
| `.claude/skills/handoff/SKILL.md` | the package | **overwritten** — this is the upgrade path |
| `.claude/handoff.profile.md` | **your project** | never touched |
| `.gitignore` | your project | a `.set/` entry is appended if missing |

User-wide instead of per repo (the skill works without a profile):

```bash
npm i -g set-claude-handoff
set-claude-handoff init --global      # ~/.claude/skills/handoff/
```

## The profile is the whole abstraction

The skill is deliberately generic; **what "state" means is not.** In a service repo it is a green
test suite and a deployed revision. In a document repo it is which client material is written,
committed and sent. So the project — not the package — declares that, in
`.claude/handoff.profile.md`:

```markdown
## What "state" means here
<one paragraph>

## Probes
| command | what it tells you | expect |
|---|---|---|
| `pnpm test` | is the suite green | `N passed`, 0 failed |
| `./scripts/deploy-status.sh staging` | did it ship | exit 0 + the deployed revision |

## Never lose
- `.set/copilot/` — raw recordings not yet handed to their owner; gitignored, so a
  /clear makes them invisible

## Parallel sessions
<which paths belong to another thread>

## Template extras
<extra columns/sections for the skeleton — e.g. a `client` column, or "already sent, do not rewrite">
```

`init` pre-fills the probe table with what it can **prove** from `package.json` scripts and marks
those rows `detected — verify`. It guesses nothing else: a probe that measures the wrong thing is
worse than a blank line, because it looks like someone already thought about it.

**No profile is not an error** — the skill still runs the universal git probes, and then *says in
the handoff* that no profile existed. Silence would let a thin measurement read as a simple project.

## The model, stated

| | |
|---|---|
| where | `.set/handoff/<ID>--<slug>.md` — gitignored, never committed |
| ID | `<MMDD>-<4 hex>`, printed when written |
| loading | by hand only: `/handoff <ID>`. No SessionStart auto-injection |
| lifetime | until you `rm` it; nothing references it |

**One thread = one file = one writer.** Parallel sessions on one working tree are normal; a single
shared file means whoever writes second silently overwrites the first. Separate IDs, no lockfile.

**Not auto-injected on purpose.** If every session gets every handoff, nobody *carries* the
thread, and you need collision signalling, staleness detection and archiving — an apparatus whose
only cause is that the file outlives the read. Loading by ID makes all of it unnecessary.

## The three rules the format is shaped by

1. **Every thread goes across, not just the running one.** The failure this came from, in the
   user's words: *"I define several tasks in one session, and at the end it gets lost… or I move
   to another session, but there I only deal with one of them."*
2. **Decision ≠ work.** What only a human can decide, the successor will not decide — unmarked, it
   either waits forever or gets decided for them, which is worse.
3. **Numbers only from commands.** The date, the commit SHA, the count are fields you fill in
   "roughly" because the sentence formally requires them. The successor **cannot check them**.
   Not measured → write *"not measured"*.

## Automatic clear (opt-in)

`init --auto-clear` also installs two hook templates: **`clear-gate`** — decides whether a session may be
cleared automatically (context ≥ threshold, this session's own handoff marker, idle, no pending prompt,
background-work policy), and **`handoff-reinject-clear`** — a `SessionStart` hook (`clear` | `compact`)
that reloads the latest handoff into the fresh context as pointer + preview. The gate never clears; an
external executor (tmux send-keys, the fleet pty owner) reads its verdict and types `/clear` — every
`/clear` then reloads, manual or automatic. Auto-compact stays untouched as the backstop. See
`specs/auto-clear` and `specs/clear-reload` in `openspec/`, and verify your environment with
`templates/selftest-clear-reload.sh`.

**Auto-continue:** the executor may take `--auto-continue "PROMPT"` — after a successful
automatic clear it re-prompts the fresh session (default off; the prompt should tell the agent
to read the full handoff and continue its next-steps section, stopping at decision blocks).
Fires only after automatic clears, never manual ones.

**Opting a session out:** create `.no-autoclear-<session8>` in the repo's `.set/handoff/`
(`session8` = first 8 alphanumeric characters of the session id, shown in the statusline) —
the gate refuses to clear that session whatever else holds. Delete the file to re-arm. Ask the
agent in that session to create it for you; a verbal "don't clear me" without the file binds
nothing.

## Related

- [set-copilot](https://github.com/tatargabor/set-copilot) — voice dictation + meeting copilot for Claude Code
- [set-core](https://github.com/tatargabor/set-core) — multi-change orchestration for Claude Code
- [set-agent-comm](https://github.com/tatargabor/set-agent-comm) — messaging between agents on one machine

## License

MIT
