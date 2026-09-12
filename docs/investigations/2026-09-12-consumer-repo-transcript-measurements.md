# Measured: compaction, `/clear` and handoff reload in consumer-repo transcripts

**Date:** 2026-09-12 · **Method:** sweep of 32 transcripts (18 most recent, 2026-09-11→12; 14 older
grep-selected for containing compact events, 2026-08-13→09-11) from a corpus of 610 files / 1.3 GB
(the consumer repo's transcript corpus under `~/.claude/projects/`). Sidechain/subagent entries excluded. Companion to
[2026-09-12-auto-clear-and-reload.md](2026-09-12-auto-clear-and-reload.md); evidence for the
`auto-clear-with-handoff-reload` change.

## Compaction

- **17 `isCompactSummary` events across 14 files.** One session compacted **4× in one day** (09:14,
  11:53, 15:02, 17:00).
- Context before: **468 849 – 672 447** (16 of 17 in 566k–672k, clustered at **~666k** — a fixed
  auto-compact trigger, not user-timed). Context after first assistant turn: **144 984 – 177 271**;
  drop **67–78%**, median **75%**.
- **Re-reading spike: not found.** Tool calls in the 10 turns before vs after: median 5 vs 5. In 30-turn
  windows after a compact, `Read` ran **0× in 13 of 17** events; recovery is command-driven (Bash 6–19
  calls per 30 turns: status, git, test scripts), not file-re-read-driven.
- **Reinject markers visible in only 4 of 17 events.** Confounders: the hook's registration window and
  its per-session idempotency marker — the 4-compact session could only have reinjected once by design.
  **This is a measured defect of once-per-session idempotency: it must key on the event, not the session.**
- `/handoff` had been run in the 30 records before the compact in **9 of 17** events — **8 of 17 compacts
  hit with no handoff written at all.**

## `/clear`

- Never appears as a user message in the sample; recorded as `queue-operation` content `/clear` in 3
  files + `lastPrompt` in 1 → **4 measurable instances, a floor, not a total**.
- When it happened, a handoff preceded or accompanied it immediately (one case: handoff written → `/clear`
  enqueued 5 s later; another: `/clear` and the handoff skill launching in the same second).
- First 10 turns of the 18 newest sessions: **7 of 18 began with a handoff load.** First-assistant context
  with a handoff start: 156k–160k; without: 118k–149k. Growth either way: **+15k–22k over 10 turns.**
  The reload cost is one handoff listing + one `cat` + a status banner (`ls -lt .set/handoff/*.md`,
  `cat .set/handoff/<ID>…`, the `date && git rev-parse && git log` banner) — not a repo re-survey.

## The user's own words (verbatim, procedural — not angry)

- `a8a5e426` 2026-09-12T14:51 — *„és compact utan ugye ne felejts el betolteni handoffot"* — reloading is
  a burden the human must remind the agent about.
- `9a02cc94` 2026-09-05T18:02 — *„és ha csak clearelek akkor a compact mar automatikusan visszatölt zha
  ez ugyanaz session és ne mavult el a session mondjuk 1 oran belül vagyok?"* — uncertainty about what
  compaction does to a session.
- `a298841b` 2026-08-24T14:38 — *„compact volt kozben"* — an unplanned compact happened.
- `019e9abe` 2026-09-12T09:28 — *„helyzet? hogy all a munka itt összefoglalva? mi ment le este? mi var?"*
  — the morning-after reconstruction problem.
- Bare `/compact` typed ahead of night work in 4 sessions (distinct from the ~666k auto-trigger).
- `f4bc85d8` 2026-08-26T23:48 — *„…fussunk reggelig aztan leglatuk mennyi égett el…"* — overnight cost
  awareness, explicit.

## What this establishes (and what it cannot)

Established: auto-compact cuts ~75% of context at a fixed ~666k trigger; 8 of 17 compacts caught sessions
with no handoff; once-per-session reinject idempotency suppresses reloads in multi-compact sessions;
post-compact recovery runs status commands rather than re-reading files; a handoff reload costs a bounded
few commands. Cannot establish: that compaction never loses knowledge silently, the true count of `/clear`s
that left no queue record, or how much recovery credit belongs to the compact summary vs the handoff file.
