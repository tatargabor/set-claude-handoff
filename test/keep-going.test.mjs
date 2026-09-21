import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decideStop, lastHumanPrompt, lastAssistantText, DEFAULTS } from "../templates/keep-going.mjs"
import { missingParts, bashHandoffTarget, targetOf } from "../templates/handoff-arm.mjs"

const base = { message: "Committed. Next I will run the suite.", tokens: 100_000, markerAgeMs: null, killed: null, human: "h1" }

test("an ordinary stop is blocked and told to continue — the rule: stop only on a real question", () => {
  const d = decideStop(base)
  assert.equal(d.block, true)
  assert.match(d.reason, /Do not stop here/)
  assert.match(d.reason, /NEED INPUT:/)
})

test("a permission-style question does NOT stop the session — only the explicit NEED INPUT line does", () => {
  assert.equal(decideStop({ ...base, message: "Tests are green. Want me to push?" }).block, true)
  assert.equal(decideStop({ ...base, message: "Two options remain.\n\nNEED INPUT: which customer tier gets the discount?" }).block, false)
  assert.equal(decideStop({ ...base, message: "**NEED INPUT:** the API key for staging" }).block, false, "markdown-wrapped marker")
  assert.equal(decideStop({ ...base, message: "ALL DONE: every task is finished and committed." }).block, false)
})

test("a marker merely MENTIONED mid-sentence does not count — only a line that starts with it", () => {
  assert.equal(decideStop({ ...base, message: "I will write NEED INPUT: lines when needed." }).block, true)
})

test("background tasks running ⇒ the stop is allowed (their notification wakes the session)", () => {
  assert.equal(decideStop({ ...base, backgroundTasks: [{ id: "b1" }] }).block, false)
})

test("the kill switch always allows the stop", () => {
  assert.equal(decideStop({ ...base, killed: ".no-keepgoing" }).block, false)
})

test("at the limit with no armed handoff: blocked with 'write the handoff', at most 3 times", () => {
  let state = {}
  for (let i = 1; i <= DEFAULTS.handoffNudges; i++) {
    const d = decideStop({ ...base, tokens: 520_000, state })
    assert.equal(d.block, true, `nudge ${i}`)
    assert.match(d.reason, /Write the handoff NOW/)
    assert.match(d.reason, /Write or Edit tool \(never Bash\)/)
    state = d.state
  }
  const last = decideStop({ ...base, tokens: 520_000, state })
  assert.equal(last.block, false, "after 3 unanswered nudges it stops so a human sees it")
  assert.match(last.why, /stopping so a human sees it/)
})

test("at the limit WITH a fresh armed handoff: the stop is allowed so the watcher can clear", () => {
  assert.equal(decideStop({ ...base, tokens: 520_000, markerAgeMs: 60_000 }).block, false)
  assert.equal(decideStop({ ...base, tokens: 520_000, markerAgeMs: 2 * 3600_000 }).block, true, "an old marker is not this round's handoff")
})

test("the budget runs out, and a new HUMAN prompt resets it", () => {
  let state = {}
  for (let i = 0; i < 3; i++) state = decideStop({ ...base, state, opts: { max: 3 } }).state
  assert.equal(decideStop({ ...base, state, opts: { max: 3 } }).block, false, "3/3 spent ⇒ stop")
  assert.equal(decideStop({ ...base, human: "h2", state, opts: { max: 3 } }).block, true, "new human prompt ⇒ fresh budget")
})

test("no human prompt found (null) does NOT reset the budget on every stop — it must still run out", () => {
  let state = {}
  for (let i = 0; i < 2; i++) state = decideStop({ ...base, human: null, state, opts: { max: 2 } }).state
  assert.equal(decideStop({ ...base, human: null, state, opts: { max: 2 } }).block, false)
})

test("the hook's own nudges (isMeta user entries) are not human prompts — measured transcript shape", () => {
  const lines = [
    { type: "user", uuid: "u1", message: { role: "user", content: "fix the login bug" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Fixed." }] } },
    { type: "user", uuid: "m1", isMeta: true, message: { role: "user", content: "Stop hook feedback:\n[keep-going 1/40] Do not stop here" } },
    { type: "user", uuid: "t1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } },
    { type: "user", uuid: "c1", message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" } },
  ].map((e) => JSON.stringify(e))
  assert.equal(lastHumanPrompt(lines), "u1")
  assert.equal(lastAssistantText(lines), "Fixed.")
})

const SHEET = `# HANDOFF: x — 2026-09-21T10:00:00Z   ·   ID: 0921-abcd

## 0. Start here — probe commands
none
## 1. Open work — EVERY thread on this line
none
## 2. What was decided (and where it is written)
none
## 3. What is blocked — DECISION or WORK
none
## 4. What this round measured / changed
none
## 5. Next steps, in order
none
## 6. What NOT to touch
none
## 7. What we learned about the METHOD
none left
`

test("handoff-arm: a complete sheet passes, a missing section is named", () => {
  assert.deepEqual(missingParts(SHEET), [])
  assert.deepEqual(missingParts(SHEET.replace(/## 3\. .*\n/, "")), ["section `## 3.`"])
})

test("handoff-arm: Bash counts only a sheet the command names AND that was just written", () => {
  const dir = mkdtempSync(join(tmpdir(), "arm-"))
  mkdirSync(join(dir, ".set/handoff"), { recursive: true })
  const f = join(dir, ".set/handoff/0921-abcd--x.md")
  writeFileSync(f, SHEET)
  assert.equal(bashHandoffTarget(`f=.set/handoff/0921-abcd--x.md && cat > "$f" <<'EOF'`, dir), f, "path set in a variable — the measured heredoc shape")
  assert.equal(targetOf({ tool_name: "Write", cwd: dir, tool_input: { file_path: f } }), f)
  assert.equal(targetOf({ tool_name: "Write", cwd: dir, tool_input: { file_path: join(dir, ".set/handoff/scratch/notes.md") } }), "", "not a sheet")
  const old = (Date.now() - 600_000) / 1000
  utimesSync(f, old, old)
  assert.equal(bashHandoffTarget(`sed -n 1,20p .set/handoff/0921-abcd--x.md`, dir), "", "a READ of an old sheet arms nothing")
})

test("handoff-arm as a hook: arms on a passing write, disarms and warns on a failing one", () => {
  const dir = mkdtempSync(join(tmpdir(), "arm-"))
  mkdirSync(join(dir, ".set/handoff"), { recursive: true })
  const f = join(dir, ".set/handoff/0921-abcd--x.md")
  const run = () => execFileSync("node", [new URL("../templates/handoff-arm.mjs", import.meta.url).pathname], {
    input: JSON.stringify({ tool_name: "Write", session_id: "abcd1234-ffff", cwd: dir, tool_input: { file_path: f } }), encoding: "utf8" })
  writeFileSync(f, SHEET)
  assert.equal(run(), "")
  const marker = join(dir, ".set/handoff/.written-abcd1234")
  assert.ok(existsSync(marker))
  assert.match(readFileSync(marker, "utf8"), /0921-abcd--x\.md/)
  writeFileSync(f, SHEET.replace(/## 5\. .*\n/, ""))
  assert.match(run(), /NOT armed.*## 5\./)
  assert.ok(!existsSync(marker), "a broken rewrite must not leave the session armed on the old sheet")
})

test("keep-going as a hook: prints a block decision on an ordinary stop, nothing when killed", () => {
  const dir = mkdtempSync(join(tmpdir(), "kg-"))
  const tr = join(dir, "t.jsonl")
  writeFileSync(tr, [
    { type: "user", uuid: "u1", message: { role: "user", content: "go" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Step 1 done." }], usage: { input_tokens: 10, cache_read_input_tokens: 1000 } } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n")
  const run = () => execFileSync("node", [new URL("../templates/keep-going.mjs", import.meta.url).pathname, "stop"], {
    input: JSON.stringify({ session_id: "kkkk1111-x", cwd: dir, transcript_path: tr }), encoding: "utf8" })
  const out = JSON.parse(run())
  assert.equal(out.decision, "block")
  assert.match(out.reason, /keep-going 1\/40/)
  assert.match(readFileSync(join(dir, ".set/handoff/keep-going.log"), "utf8"), /block kkkk1111  continue 1\/40/)
  writeFileSync(join(dir, ".set/handoff/.no-keepgoing"), "")
  assert.equal(run(), "")
})
