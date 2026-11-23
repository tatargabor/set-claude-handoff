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

Arm it from any project with the `/auto-clear` skill (installed by every `init`): it checks
the measured state, installs the machinery, starts the watcher with the profile's tuning, and
verifies the log before calling it armed. Two kill-switch scopes, both plain files in
`.set/handoff/`: `.no-autoclear` (whole tree) and `.no-autoclear-<session8>` (one session).

`init --auto-clear` also installs the executor (`watch-auto-clear.sh`) with its **presence check**
(`presence.mjs`: it reads the session's input line and never types into text a human is writing — the
fix for a measured collision where `/clear` landed inside a half-typed line), and two hook templates: **`clear-gate`** — decides whether a session may be
cleared automatically (context ≥ threshold, this session's own handoff marker, idle, no pending prompt,
background-work policy), and **`handoff-reinject-clear`** — a `SessionStart` hook (`clear` | `compact`)
that reloads the latest handoff into the fresh context as pointer + preview (on a compact, only the session's
own armed handoff — an unarmed session gets the candidate list instead of a guess). The gate never clears; an
external executor (tmux send-keys, the fleet pty owner) reads its verdict and types `/clear` — every
`/clear` then reloads, manual or automatic. Auto-compact stays untouched as the backstop. See
`specs/auto-clear` and `specs/clear-reload` in `openspec/`, and verify your environment with
`templates/selftest-clear-reload.sh`.

**No per-repo copy: wiring through a plugin.** A product family can ship the hooks in its own Claude Code
plugin instead of copying them into every repo. With the package installed (`npm i -g set-claude-handoff`):

```bash
set-claude-handoff plugin-files <plugin-dir> [--keep-going]   # merges the lines into <plugin-dir>/hooks/hooks.json
set-claude-handoff watch --dir <tree> --interval 60 --auto-continue default   # the watcher, from the package
```

The lines carry no machine path: each finds the binary at run time (`command -v`, else `~/.local/bin`) and
calls `set-claude-handoff hook <arm|reinject|keep-going> --from-plugin`. Where a project's own settings still
wire a copy of that hook, the plugin's line stands down, so nothing fires twice. A re-run replaces only
its own lines, and a vendored copy in the same `hooks.json` is reported, not removed. Without the binary,
the reload line says at session start that the reload is off. The watcher writes `.set/handoff/.watcher-alive`
every pass; keep-going reads it to know a watcher acts on its handoff demand.

**Auto-continue:** the executor may take `--auto-continue "PROMPT"` — after a successful
automatic clear it re-prompts the fresh session (default off; the prompt should tell the agent
to read the full handoff and continue its next-steps section, stopping at decision blocks).
Fires only after automatic clears, never manual ones.

**Clearing at a work boundary:** a session that has just finished a unit of work (a change
archived, a run ended) can ask to be cleared below the threshold. It writes its handoff naming the
next step, then `.set/handoff/.clear-request-<session8>` (or `.clear-request-any`, for whichever
armed session of the tree is eligible first) holding `{"next": "<next step>", "from": "<who asked>",
"at": "<ISO time>"}`. The gate lets the size gate pass when the request parses, is younger than two
hours (`--request-ttl`), its `next` appears as a whole token in the session's own armed handoff, and
that handoff was the session's last act: the transcript has not moved more than ten minutes past the
arm marker (`--request-window`), because work done after the handoff is not in it and a clear would
lose it. Every other gate still holds, and an opt-out beats a request. The watcher claims the file by rename before it types,
deletes it after the clear, and removes a request the gate refused as unparsable, next-less or
stale. A peer never writes another session's `-<session8>` request: it asks, and the session writes
its own handoff and request. A peer may write `.clear-request-any`; it clears only a session whose
own fresh handoff already names that `next`. The default threshold is 400k — below the harness's own auto-compact, which the owner's settings put at a 550k window (firing near ~500k); the earlier 320k sat under a 400k window measured to fire at 366–372k
(opus-5-5, 400k `autoCompactWindow`, 2026-11-23); a project with another window passes `--threshold`.

**The handoff runs right before the clear.** The marker gate passes only when the handoff was the
session's last act, meaning its last assistant record is at most `--request-window` (600 s) after the
marker. At the threshold, an idle session with no fresh handoff gets `/handoff` typed, and the clear
follows once it exists. A stale handoff is asked for again only after the previous ask was answered,
and at most 3 times.

**Warm-idle rotation**, the second trigger. The harness also compacts an IDLE session by itself
(*idle compaction*, ≥ 200k tokens, ~54 min after the last request). That is about a third of the
compactions measured, and no size threshold reaches them. So a session idle for `--idle-minutes`
(default 48) at ≥ `--idle-floor` tokens (default 200000) is treated like this:
- unarmed: it gets the `/handoff` nudge once;
- armed by its own last act: it is cleared while its prompt cache is still warm;
- past 54 min: nothing is typed, and `warm-idle missed` is logged once.

It never presses Escape for idle. Off: `--idle-minutes 0`.

**Log hygiene.** The per-pass `no` verdict line is written only when the verdict's shape
changes (`$failed` with every run of digits replaced by `N` — a moving token count or freshness
age is not a change) or 30 minutes after that session's last written line (a heartbeat, so a
tail still shows the session is watched); FIRE, NUDGE, request, warm-idle and skip lines are
never deduped. As the safety net, `--log-max-kb` (default 5120) rotates the log at watcher start
and at the top of every pass: past the cap `auto-clear.log` is renamed to `auto-clear.log.1`
(any old `.1` replaced) and the fresh file's first line names the rotation and the size.
Measured 2026-11-23: one consumer tree's log had grown to 47 MB / 236 385 lines, one session's
identical verdict appearing 879× in its last 3000 lines.

**Opting a session out:** create `.no-autoclear-<session8>` in the repo's `.set/handoff/`
(`session8` = first 8 alphanumeric characters of the session id, shown in the statusline) —
the gate refuses to clear that session whatever else holds. Delete the file to re-arm. Ask the
agent in that session to create it for you; a verbal "don't clear me" without the file binds
nothing.

## Keep going (opt-in)

For an unattended session: it does not stop until it has a real reason to, and at the context
limit it writes its own handoff, so auto-clear can clear it and continue it from there.

- `keep-going.mjs stop` (Stop hook) blocks an ordinary stop with "continue with the next step".
  A stop goes through only on a line starting `NEED INPUT:` (a decision nothing earlier answers)
  or `ALL DONE:`, while background tasks run, or when the kill switch
  `.set/handoff/.no-keepgoing` exists. A question like "Want me to push?" does **not** stop it.
- At the threshold it asks for the handoff instead (Write/Edit, never Bash), and once the sheet
  is armed it lets the stop through, so the watcher can clear. It asks only where the watcher is
  installed (`.claude/hooks/watch-auto-clear.sh`); elsewhere a handoff nobody clears is not asked for.
- An outward, irreversible or permission step (a mail, a push, a deletion…) is never covered by
  earlier words: the nudge tells the session to ask it with a `NEED INPUT:` line.
- A budget (`--max`, default 40) counts its own nudges since the last human prompt and stops the
  chain when spent. Its nudges are `isMeta` in the transcript, so they never reset it.
- `handoff-arm.mjs` (PostToolUse) is what arms a session: it writes `.written-<session8>` when
  a handoff sheet with every section lands, through Write/Edit or a Bash write.

`init --auto-clear` installs both; it prints the `settings.json` entries to merge. Every
decision is logged in `.set/handoff/keep-going.log`.

## Autopilot (opt-in)

On top of the automatic clear: keep an unattended thread on the course its human set, and stop it
from waiting on questions the human already answered. Arm it with `/autopilot` (installed by
`init --autopilot`).

**The intent ledger.** A record of what the *human* said to one work thread — typed prompts, dialog
picks, dictation — captured by hooks at the moment it happens and keyed by the handoff ID, so it
survives every clear. It cannot be read back from the transcript: a prompt the watcher typed and an
answer a hook supplied are recorded there exactly like the human's own. So executors log what they
type before typing it, and machine-authored entries are never evidence. Dictation reaches the
ledger in one of two shapes: **file** — set-copilot's archived `.set/copilot/<session>/dictation-*.jsonl`
is picked up by the hooks (one entry per finished dictation, mid-word segments joined exactly); or
**command** — any adapter runs `node .claude/hooks/autopilot/ledger.mjs append --source human-dictated
--session <id> --text-file <file>` (the CLI accepts no other source). A session with neither is
announced in the verdict log, never read as "the human said nothing".

**Drift guard.** After an automatic clear the continue prompt is sent only when the fresh session
reloaded *its own* thread (a reload chosen by file age binds nothing), the silence budget is not
spent (default: 3 automatic continuations since the last human input), and — with a judge
configured — the handoff's next step is still aligned with the human's words. The reload also
injects the thread's human direction verbatim, beside the handoff preview.

**Auto-answer.** A question dialog, a prose question, a "done, what next?" or a wait on background
work is answered only when a verbatim quote of the human's recorded words in this thread backs the
answer — checked deterministically, whatever the judge claims. Never answered: a new decision, a
handoff §3 user-decision item, a deny-listed action (push, deploy, delete, send to a client,
publish, pay), an unbound session, a spent budget. Every answer says it is automatic and quotes
what it relied on; every stop is logged to `.set/handoff/autopilot.log`, answered or not.

**Switching it off and on — any time, from the prompt.** A line starting with `autopilot off` (or
`autopilot ki`) switches it off for the session, `autopilot off project` for the whole tree;
`autopilot on` / `autopilot be` switches it back. A hook applies it before the agent's turn, so no
agent can overrule it, and text the watcher typed can never flip it. The switch files are
`.set/handoff/.no-autopilot` and `.no-autopilot-<session8>`, independent of the auto-clear ones.

Verify a Claude Code upgrade with `templates/selftest-autopilot.sh`: it pins the platform behaviors
the hooks rely on. Evidence and design: `docs/investigations/2026-09-13-thread-anchor-and-auto-answer.md`.

## Related

- [set-copilot](https://github.com/tatargabor/set-copilot) — voice dictation + meeting copilot for Claude Code
- [set-core](https://github.com/tatargabor/set-core) — multi-change orchestration for Claude Code
- [set-agent-comm](https://github.com/tatargabor/set-agent-comm) — messaging between agents on one machine

## License

MIT
