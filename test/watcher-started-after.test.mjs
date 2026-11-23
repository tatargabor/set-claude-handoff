import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runWatcher, SID } from "./helpers/watcher-harness.mjs"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// The bug these guard, measured 2026-11-23 in one product family's trees: with --started-after now
// (the /auto-clear skill's own command until this change), the arming session itself is excluded,
// and the only trace is a `skip … started before --started-after` line every minute nobody reads.
// One tree's only working session was skipped 2858 times; all 6 of its compactions in the window
// happened unprotected; another tree's two sessions, 4926 and 3421 times.
// (change started-after-self-exclusion)

test("AC-1: the first start-filter skip writes ONE .excluded-<session8> (resume command + reason), logs the skip ONCE, and types nothing into the session", () => {
  // The arming session predates the watcher: fresh wiring stamp (init just ran), session started
  // 120 min ago — excluded by the DEFAULT filter, announced, never typed into.
  const r = runWatcher({ tokens: 410_000, wiredAtMin: 0, seconds: 4 })
  assert.ok(r.excludedBody?.includes(`claude --resume ${SID}`), `the way out is named:\n${r.excludedBody}`)
  assert.match(r.excludedBody ?? "", /before --started-after/, "the reason is in the record")
  assert.equal((r.log.match(/^\S+ skip .+started before --started-after/gm) ?? []).length, 1,
    `logged once, not on every pass:\n${r.log}`)
  assert.deepEqual(r.keys, [], "never typed into: an excluded session's hooks are exactly why it is excluded")
})

test("AC-2: a watcher restart in a tree already wired — a session started AFTER the wiring stamp is watched, not skipped", () => {
  const r = runWatcher({ tokens: 410_000, startedAtMin: 60, wiredAtMin: 120, seconds: 5 })
  assert.equal(r.excluded, null, `no exclusion record:\n${r.log}`)
  assert.match(r.log, /watcher started .* started-after=wired \S+ \(default\)/, "the default filter announces its moment")
  assert.deepEqual(r.keys, ["-t fake:0.0 -l /handoff", "-t fake:0.0 Enter"], `gated like any session:\n${r.log}`)
})

test("an explicit --started-after overrides the wiring stamp — a session started after the stamp but before the flag is still excluded (the flag is the operator's word)", () => {
  const r = runWatcher({ tokens: 410_000, startedAtMin: 30, wiredAtMin: 120,
    extraArgs: ["--started-after", new Date(Date.now() - 10 * 60_000).toISOString()], seconds: 3 })
  assert.ok(r.excludedBody?.includes("claude --resume "), `the record is still written:\n${r.log}`)
  assert.equal((r.log.match(/started before --started-after/gm) ?? []).length, 1, r.log)
})

test("AC-3: a resumed session — a new runtime record for the same id, started after the wiring — is gated like any other and its own earlier marker arms the /clear", () => {
  // The marker predates the new process start on purpose: the gate announces a restored process of
  // the SAME session id and still accepts its own thread's marker.
  const r = runWatcher({ tokens: 250_000, idleMin: 49, marker: true, startedAtMin: 5, wiredAtMin: 120, seconds: 4 })
  assert.equal(r.excluded, null, `not excluded:\n${r.log}`)
  assert.match(r.log, /watcher started .* started-after=wired /, "the default filter is ON — the resumed session passes it")
  assert.deepEqual(r.keys.slice(0, 2), ["-t fake:0.0 -l /clear", "-t fake:0.0 Enter"], r.log)
  assert.match(r.log, /^\S+ FIRE .*\/clear/m)
})

test("a corrupt wiring stamp refuses to start — a silently OFF filter is how a session that cannot reload gets cleared", () => {
  const r = runWatcher({ tokens: 410_000, wiredStamp: "not a date\n", seconds: 2 })
  assert.deepEqual(r.keys, [], r.log)
  assert.doesNotMatch(r.log, /watcher started/, "no pass ever ran")
  assert.match(r.stderr, /wiring stamp is not a parseable date/)
})

test("no stamp and no --started-after: no default filter — the old session is watched exactly as before the change", () => {
  const r = runWatcher({ tokens: 410_000, seconds: 4 })
  assert.equal(r.excluded, null, r.log)
  assert.match(r.log, /watcher started .* started-after=any/)
  assert.deepEqual(r.keys.slice(0, 2), ["-t fake:0.0 -l /handoff", "-t fake:0.0 Enter"], r.log)
})

test("the /auto-clear skill names the promised interface — the wiring-stamp default, the exclusion record, the resume way out — and no longer advises --started-after now, the command that excluded the arming session itself (agreed with another team; change started-after-self-exclusion)", () => {
  const skill = readFileSync(join(PKG_ROOT, "skills/auto-clear/SKILL.md"), "utf8")
  assert.match(skill, /\.reload-wired-at/, "the wiring stamp is named")
  assert.match(skill, /\.excluded-<session8>/, "the exclusion record is named")
  assert.match(skill, /claude --resume <id>/, "the way out is named")
  assert.doesNotMatch(skill, /--started-after \$\(date/, "the old advice is gone from the watcher command")
})
