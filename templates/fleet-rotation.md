# Fleet rotation — the auto-clear contract for headless (`claude -p`) agents

**For interactive TUI sessions, the executor is `watch-auto-clear.sh` (tmux send-keys). For fleet
`-p` agents, `/clear` is meaningless — there is no TUI to parse it** (`chat.py` runs
`claude -p --output-format stream-json`; raw text on stdin is not even a valid frame). Context
management for a `-p` run is **process rotation**, and the manager already holds both levers:

1. it sees the run's token usage in the stream-json payload (set-core renders it via
   `fleet/context_fill.py`);
2. it owns the process lifecycle (close, start fresh).

So the manager never types. It rotates — and the handoff is what crosses the process boundary.

## The rotation protocol (per agent run)

```
measure          tokens of the last response ≥ threshold (e.g. 500 000)?
   │
turn ends        the agent is between turns (no pending tool call in its transcript —
   │             the same "idle" the clear-gate checks)
   ▼
instruct         send ONE user message on the protocol stream:
   │             "Context is at <N>k. Write the session handoff now (/handoff conventions,
   │             project profile applies). Reply 'handoff written: <path>' when done."
   ▼
wait             for THIS run's marker: .set/handoff/.written-<session8>
   │             (the write-time gate drops it — a handoff that failed the content gate
   │              never arms a rotation). Bounded wait; on timeout: NO rotation, log loudly.
   ▼
rotate           close the run; start the fresh run with the handoff path as the FIRST
                 input: "Read and load .set/handoff/<file> — it is this thread's state —
                 then continue: <original task / next section>."
```

## Reusing the gate verbatim

The clear-gate evaluates a `-p` run with the same verdict JSON as an interactive session — the
transcript, marker and token sources are the same shape (`-p` runs have transcripts under
`~/.claude/projects/<slug>/<sessionId>.jsonl` too):

```bash
node .claude/hooks/clear-gate.mjs --session "<sessionId>" \
     --transcript ~/.claude/projects/<slug>/<sessionId>.jsonl \
     --dir ./.set/handoff --json
# → { "eligible": bool, "gates": [ {name, ok, detail}... ] }
```

`eligible: true` = threshold met, this run's own marker is fresh, turn ended, nothing pending.
The `backgroundWorkBlocks` flag applies as-is; relax it only with the recorded survival
measurement (`docs/investigations/2026-09-12-background-survival.md`).

## Manager-side sketch (set-core, Python — the wiring lands in that repo)

```python
def maybe_rotate(agent, threshold=500_000):
    if agent.last_usage_tokens < threshold or not agent.turn_ended:
        return
    send(agent, f"Context is at {agent.last_usage_tokens//1000}k. Write the session "
                f"handoff now (/handoff conventions, project profile applies).")
    if not wait_for_marker(agent.handoff_dir, agent.session8, timeout=180):
        log.error(f"{agent.label}: no handoff marker in 180s — NOT rotating")
        return
    body = read_handoff_path_from_marker(agent.handoff_dir, agent.session8)
    stop(agent)                                   # the -p run exits; its transcript stays
    start(agent, first_input=(
        f"Read and load .set/handoff/{body} — it is this thread's state. "
        f"Then continue: {agent.next_section}"))
```

## Why not keystrokes, once more

The fleet owner *holds* its agents' ptys — but the other end is a protocol stream, not a TUI.
`/clear` typed there lands as garbage. The owner's write path stays useful for what it was built
for (notifying, interrupting); **context boundaries for headless agents are process boundaries.**
