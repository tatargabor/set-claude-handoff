---
name: handoff
description: Session handoff — writes one thread's open work, MEASURED state and next step into an ID-tagged file, so a compact or /clear cannot dilute it. Use before switching sessions, when the budget runs low, or when a compact is coming. The successor loads it with `/handoff <ID>`.
user_invocable: true
---

# handoff — hand one work thread to a successor with a clean context

**The goal:** make `/clear` + a fresh session cheaper and cleaner than a compact — which it
only is if the state is **written down**, not held in the context.

**Why this exists (measured in the project this skill was extracted from):** over two days,
**62 forced compacts**; **69% of the token budget** went into re-reading accumulated context
rather than into the work.

---

## The model — stated explicitly

**A handoff is not a repo artifact, it is a message between sessions.** Therefore:

| | |
|---|---|
| where | `.set/handoff/<ID>--<slug>.md` — **gitignored**, never committed |
| ID | `<MMDD>-<4 hex>`, e.g. `0726-3f9a` — writing it **prints the ID**; that is what the successor gets |
| loading | **by hand only**: `/handoff <ID>`. No SessionStart auto-injection |
| end of life | a manual `rm`, or it just sits there — nothing references it |

**One thread = one file = one writer.** Parallel sessions on one working tree are normal
(measured: five at once). A single shared file is structurally wrong — whoever writes second
silently overwrites the first. A separate ID means no race, and no lockfile.

**Why not auto-injected into every session:** if every session gets everything, nobody *carries*
the thread, and you then need collision signalling, staleness measurement and archiving — an
apparatus whose only cause is that the file outlives the read. Loading by ID makes all of it moot.

---

## The project profile — where the project-specific part lives

This skill is deliberately generic. What "state" means differs per repo: a green test suite in
one, which client document has been generated and sent in another.

**Read `.claude/handoff.profile.md` if it exists.** It carries, written by the project:

- **What "state" means here** — one paragraph
- **Probes** — the commands worth running in this repo, with what each tells you
- **Never lose** — runtime scratch, untracked drafts, anything gitignored that would vanish silently
- **Parallel sessions** — which paths belong to other threads
- **Template extras** — optional: extra columns/sections for the skeleton below

⚠ **If there is no profile, say so in the handoff** ("no project profile — only the universal
probes were run"). Silence would let the successor read a thin measurement as a simple project.
Offer to create one from `templates/handoff.profile.md` in this package.

---

## `/handoff` — writing (no arguments)

### Phase 1 — MEASURE, do not recall

⚠ **Not skippable, and not replaceable by recalling the conversation.** The date, the commit
SHA, the count are fields you fill in "roughly" because the sentence *formally requires* them —
that is exactly the class of error that gets into a handoff, and the successor **cannot check it**.

Universal, run these always:

```bash
date '+%Y-%m-%dT%H:%M:%S%:z'    # the header timestamp — NEVER from memory
git rev-parse --abbrev-ref HEAD # which branch we are on
git log --oneline -8            # where the tree is
git status --short              # uncommitted AND untracked work
```

Then the probes from `.claude/handoff.profile.md` — only the ones relevant to this thread; do
not run all of them blindly.

**Do not claim what you did not measure.** If a number is missing, write *"not measured"*. That
is always cheaper than a plausible but false number the successor takes at face value.

### Phase 2 — ID and file

If this session **was loaded with `/handoff <ID>`**, reuse **that same ID** — a thread's ID is
stable along the whole chain. Otherwise generate one:

```bash
mkdir -p .set/handoff
ID="$(date +%m%d)-$(openssl rand -hex 2)"    # e.g. 0726-3f9a — NEVER from memory
echo "$ID"
```

The file: `.set/handoff/$ID--<slug>.md` (`<slug>` = the thread's name in kebab-case, only so
`ls` reads well; loading needs the ID alone). Use **exactly** these sections — keep an empty
section with a "none" marker too, because a missing section and missing content look identical
from the outside:

```markdown
# HANDOFF: <slug> — <ISO date from the `date` command>   ·   ID: <ID>

> **The conversation is not a source.** Whatever is not written here is lost at the next compact.
> Under every number, the command that produced it.

**In one sentence:** <where THIS thread stands and what the next step is>

---

## 0. Start here — probe commands

<what the successor can MEASURE the state with, rather than believe it. For each: what you expect.>

## 1. Open work — EVERY thread on this line

<Itemised. NOT only the one I happened to be working on.>

| # | thread | state | where the trace is |
|---|---|---|---|

## 2. What was decided (and where it is written)

<Decision → the repo file that carries it. If it was decided only in the conversation and is
 written nowhere, then it was NOT decided — either write it down now, or move it to §1.>

## 3. What is blocked — DECISION or WORK

<Separated. "Waiting on a user decision" and "agent work remains" are different things,
 and the successor handles them differently.>

## 4. What this round measured / changed

<With commit SHAs (from `git log`) and measured numbers.>

## 5. Next steps, in order

1. …

## 6. What NOT to touch

<If another session works in parallel: which files/directories are theirs.
 If none: "no parallel thread".>
```

If the profile has a **Template extras** section, apply it here — an extra column, an extra
warning line, an extra section. Do not drop any of the sections above for it.

### Phase 3 — uncommitted work

The handoff file itself does **not** go into git. But if `git status` showed uncommitted or
untracked work, **say so in the handoff** — otherwise the successor does not know there is
something to save.

⚠ **Cleanup must NEVER be `git reset --hard`** while there is uncommitted work in the tree: it
takes your own unsaved edits with it (measured: it removed two finished, uncommitted files during
this very skill's development). For a targeted revert use `git restore -- <path>`; to drop a
temporary commit, `git reset --soft`. On untracked files `git clean` is forbidden the same way.

### Phase 4 — report to the user

**Lead with the ID** — without it the successor cannot find the file:

```
Handoff written: .set/handoff/0726-3f9a--session-budget.md
→ in the new session:  /handoff 0726-3f9a

2 open threads, 1 waiting on a user decision. Ready for /clear.
```

`/clear` is issued **by the user**, not by you — no session has a tool to erase its own context.

---

## `/handoff <ID>` — loading

```bash
ls .set/handoff/<ID>--*.md
```

Read it, then **run the §0 probes** and **state the measured state**, not what the file says —
the file is the *last* truth, the command is the *current* one. If they disagree, that itself is
a finding. Remember the ID: if you later write a handoff again, update **this** one.

## `/handoff list` — what is written

```bash
ls -lt .set/handoff/*.md 2>/dev/null || echo "No handoff written."
```

Per line: ID, slug, age. Flag anything older than 30 days — but **do not delete it**: a silent
deletion is indistinguishable from there never having been a handoff. Delete on the user's
request, with `rm`.

---

## The three rules the skeleton is shaped by

1. **Every thread goes across, not just the running one.** The measured failure, in the user's
   words: *"I define several tasks in one session, and at the end it gets lost, it drops out…
   or I move to another session, but there I only deal with one of them."*
2. **Decision ≠ work.** What only the user can decide, the successor **will not** decide; if it
   is not marked, it either waits (deadlock) or gets decided for them (worse).
3. **Numbers only from commands.** See Phase 1.

## Related

- `.claude/handoff.profile.md` — this project's probes and specifics (project-owned)
- The project's own memory / knowledge base, if it has one. A handoff does **not** replace it:
  memory is what is true in *every* session; a handoff is what is open in *this thread*.
