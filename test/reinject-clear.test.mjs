import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, existsSync, utimesSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, basename } from "node:path"
import { execFileSync } from "node:child_process"
import { buildInjection, sameEventDoubleFire, previousSessionOf, NO_OWN_HANDOFF } from "../templates/hooks/handoff-reinject-clear.mjs"

const tmp = () => mkdtempSync(join(tmpdir(), "reinject-"))

function handoff(dir, name, body) {
  writeFileSync(join(dir, name), body)
}

/** The clear-gate's arm-marker convention, inlined so the two suites agree on the format. */
function armMarker(dir, sessionId, file) {
  const s8 = String(sessionId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)
  writeFileSync(join(dir, `.written-${s8}`), `${new Date().toISOString()} ${basename(file)}\n`)
}

test("a second compact in the same session must inject again — the measured once-per-session suppression", () => {
  // Measured 2026-09-12 in consumer-repo: reinject visible in only 4 of 17 compacts; a session that
  // compacted 4× in a day could only ever reinject once, because the marker lived forever.
  const dir = tmp()
  handoff(dir, "0912-aaaa--thread.md", "# thread")
  const dedup = join(dir, ".injected-abcd1234-compact")
  writeFileSync(dedup, "old\n")
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000)
  utimesSync(dedup, twoHoursAgo, twoHoursAgo)
  assert.equal(sameEventDoubleFire(dedup), false, "past the window the guard must not suppress")
  const inj = buildInjection({ dir, source: "compact" })
  assert.match(inj, /0912-aaaa/, "a later compact injects again (here: the candidate list — no own marker)")
})

test("a double-fire of the SAME event must not inject twice — the guard still works inside its window", () => {
  const dir = tmp()
  const dedup = join(dir, ".injected-abcd1234-clear")
  writeFileSync(dedup, "just now\n")
  assert.equal(sameEventDoubleFire(dedup), true)
})

test("resume and startup must never inject — the allowlist is per event type", () => {
  const dir = tmp()
  handoff(dir, "0912-aaaa--thread.md", "# thread")
  assert.equal(buildInjection({ dir, source: "resume" }), null)
  assert.equal(buildInjection({ dir, source: "startup" }), null)
  assert.equal(buildInjection({ dir, source: "fork" }), null)
})

test("a clear with no handoff must announce it — an unloaded context must not look loaded", () => {
  const dir = tmp()
  const inj = buildInjection({ dir, source: "clear" })
  assert.match(inj, /NOTHING to load/)
  // ...but a compact with nothing to load stays silent (the machine page path handles it).
  assert.equal(buildInjection({ dir, source: "compact" }), null)
})

test("several RECENT handoffs on a clear → nothing is loaded by mtime, all are listed — the newest of two parallel threads is a coin flip", () => {
  const dir = tmp()
  handoff(dir, "0911-0001--other-thread.md", "# other thread")
  handoff(dir, "0912-0002--this-thread.md", "# this thread")
  const inj = buildInjection({ dir, source: "clear" })
  assert.match(inj, /no handoff loaded/)
  assert.match(inj, /2 pages of this tree were written in the last 2 h/)
  assert.match(inj, /0912-0002--this-thread\.md/)
  assert.match(inj, /0911-0001--other-thread\.md/, "every candidate stays reachable")
  assert.doesNotMatch(inj, /# this thread/, "no page body was injected")
})

test("a clear with only an OLD page lists it instead of loading it — measured 2026-11-23: one tree reloaded the same 35-day-old page 26 times into six unrelated sessions", () => {
  const dir = tmp()
  handoff(dir, "1008-490b--old-thread.md", "# a thread from last month")
  const old = new Date(Date.now() - 35 * 86_400_000)
  utimesSync(join(dir, "1008-490b--old-thread.md"), old, old)
  const inj = buildInjection({ dir, source: "clear", sessionId: "fresh555-6666" })
  assert.match(inj, /no handoff loaded/)
  assert.match(inj, /1008-490b/)
  assert.doesNotMatch(inj, /a thread from last month/)
  assert.match(inj, /\/handoff <ID>/)
})

test("one recent page among old ones is loaded on a clear — the unambiguous case keeps its fallback", () => {
  const dir = tmp()
  handoff(dir, "1001-0aaa--old.md", "# old")
  const old = new Date(Date.now() - 3 * 86_400_000)
  utimesSync(join(dir, "1001-0aaa--old.md"), old, old)
  handoff(dir, "1123-0bbb--just-written.md", "# just written\n")
  const inj = buildInjection({ dir, source: "clear", sessionId: "fresh777-8888" })
  assert.match(inj, /# just written/)
  assert.match(inj, /the only page of this tree written in the last 2 h/)
  assert.match(inj, /1001-0aaa--old\.md/, "the old page stays reachable")
})

test("an over-cap handoff must truncate LOUDLY, naming the file — never a silent fragment", () => {
  const dir = tmp()
  handoff(dir, "0912-aaaa--big.md", "# big\n" + "x".repeat(20_000))
  const inj = buildInjection({ dir, source: "clear" })
  assert.ok(inj.length <= 10_000, `injection must respect the platform cap, got ${inj.length}`)
  assert.match(inj, /truncated — full page: `.*0912-aaaa--big\.md`/)
})

test("the machine page joins the injection, smaller frame — numbers, not intent", () => {
  const dir = tmp()
  handoff(dir, "0912-aaaa--thread.md", "# thread")
  writeFileSync(join(dir, ".latest"), "0912-auto-abcd--allapot.md\n")
  handoff(dir, "0912-auto-abcd--allapot.md", "# AUTOMATIKUS HANDOFF\nbranch: main")
  armMarker(dir, "abcd1234", "0912-aaaa--thread.md")
  const inj = buildInjection({ dir, source: "compact", sessionId: "abcd1234" })
  assert.match(inj, /# thread/)
  assert.match(inj, /Machine state page/)
  assert.match(inj, /branch: main/)
  assert.ok(!existsSync(join(dir, ".written-nonexistent")))
})

test("the session's OWN marker beats mtime — after a clear, a thread must get back the page it armed, not the tree's newest (9.1)", () => {
  const dir = tmp()
  handoff(dir, "0912-eb89--other-thread.md", "# another thread's page\n")
  handoff(dir, "0911-a16a--my-thread.md", "# MY thread's page\n")
  utimesSync(join(dir, "0912-eb89--other-thread.md"), new Date(), new Date()) // newest by mtime
  armMarker(dir, "9f11a2b3-c4d5", "0911-a16a--my-thread.md")
  const out = buildInjection({ dir, source: "clear", sessionId: "9f11a2b3-c4d5-e6f7" })
  assert.match(out, /0911-a16a--my-thread\.md/, "the marker-named page is loaded")
  assert.match(out, /arm marker/, "the choice is announced as marker-based, not silent")
  assert.doesNotMatch(out.split("\n").find((l) => l.includes("0911-a16a")) ?? "", /verify it is YOURS/,
    "no mtime-doubt caption on a marker-chosen page")
})

test("a worktree thread's clear must find the worktree handoff — measured 2026-09-13: wt-ai's clear got the main repo's newest page instead of its own 0912-ff48", () => {
  const base = mkdtempSync(join(tmpdir(), "wt-"))
  const exec = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" })
  const main = join(base, "main")
  const wt = join(base, "wt-fix")
  mkdirSync(main, { recursive: true })
  exec(["init", "-q"], main)
  writeFileSync(join(main, "f.txt"), "x\n")
  exec(["add", "f.txt"], main); exec(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], main)
  exec(["worktree", "add", "-q", "-b", "fix", wt, "HEAD"], main)

  // The thread lives in the worktree: its handoff and its arm marker are THERE,
  // while the reinject resolves from the main tree (the measured blind direction).
  const wtHandoffDir = join(wt, ".set/handoff")
  mkdirSync(wtHandoffDir, { recursive: true })
  handoff(wtHandoffDir, "0912-ff48--worktree-thread.md", "# the worktree thread's page\n")
  armMarker(wtHandoffDir, "9f11a2b3-c4d5", "0912-ff48--worktree-thread.md")
  mkdirSync(join(main, ".set/handoff"), { recursive: true })
  handoff(join(main, ".set/handoff"), "0912-eb89--main-repo-thread.md", "# a DIFFERENT thread's page\n")

  const out = buildInjection({ dir: join(main, ".set/handoff"), source: "clear", sessionId: "9f11a2b3-c4d5-e6f7" })
  assert.match(out, /0912-ff48--worktree-thread\.md/, "the worktree thread's own page is loaded from the main-cwd direction")
  assert.match(out, /arm marker/)
})

test("with no marker the fallback stays in the session's OWN tree — measured 2026-09-13: the bugfix pane (main cwd) must not get a sibling worktree's newer page as its reload", () => {
  const base = mkdtempSync(join(tmpdir(), "wt2-"))
  const exec = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" })
  const main = join(base, "main")
  const wt = join(base, "wt-fix")
  mkdirSync(main, { recursive: true })
  exec(["init", "-q"], main)
  writeFileSync(join(main, "f.txt"), "x\n")
  exec(["add", "f.txt"], main); exec(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], main)
  exec(["worktree", "add", "-q", "-b", "fix", wt, "HEAD"], main)

  const wtHandoffDir = join(wt, ".set/handoff")
  mkdirSync(wtHandoffDir, { recursive: true })
  handoff(wtHandoffDir, "0912-ff48--worktree-thread.md", "# the worktree thread's page\n")
  mkdirSync(join(main, ".set/handoff"), { recursive: true })
  handoff(join(main, ".set/handoff"), "0912-eb89--main-repo-thread.md", "# the main thread's page\n")

  // The fresh bugfix session (cwd = main tree, no marker under its new id): its own tree's
  // newest page is the primary choice; the worktree's NEWER page must not win by recency.
  const out = buildInjection({ dir: join(main, ".set/handoff"), source: "clear", sessionId: "" })
  const primaryLine = out.split("\n").find((l) => l.includes("**Handoff:")) ?? ""
  assert.match(primaryLine, /0912-eb89--main-repo-thread\.md/, "the cwd tree's own newest page is loaded")
  assert.doesNotMatch(primaryLine, /0912-ff48/, "a sibling tree's page must not become the primary choice")
  assert.match(out, /wt-fix/, "but it stays reachable, listed by full path")
})

/** The watcher's record of the session an automatic clear replaced, keyed by the claude pid. */
function firelock(dir, pid, sid, at = Date.now()) {
  writeFileSync(join(dir, `.firelock-${pid}`), JSON.stringify({ sid, at }) + "\n")
}

test("without autopilot the firelock must still name the cleared session — measured 2026-09-25: the ledger is absent in a plain install, so EVERY automatic clear fell through to mtime", () => {
  const dir = tmp()
  firelock(dir, 4242, "aaaa1111-2222-3333-4444-555566667777")
  assert.equal(previousSessionOf(dir, 4242), "aaaa1111-2222-3333-4444-555566667777")
  assert.equal(previousSessionOf(dir, 9999), "", "another process's lock must not link")
  assert.equal(previousSessionOf(dir, null), "", "no pid — nothing to follow")
})

test("a STALE firelock must be ignored — an old record would bind a fresh session to a dead thread", () => {
  const dir = tmp()
  firelock(dir, 4242, "aaaa1111-dead", Date.now() - 20 * 60_000)
  assert.equal(previousSessionOf(dir, 4242), "", "past the 15-minute window the lock is not trusted")
})

test("an unreadable firelock must not take the injection down — it falls back to mtime", () => {
  const dir = tmp()
  writeFileSync(join(dir, ".firelock-4242"), "{ not json")
  assert.equal(previousSessionOf(dir, 4242), "")
})

test("the cleared session's marker beats mtime on the clear path — the fresh id cannot have a marker yet", () => {
  const dir = tmp()
  handoff(dir, "0925-mine--docs.md", "# my own thread")
  handoff(dir, "0925-other--bugfix.md", "# another seat's thread")
  const older = new Date(Date.now() - 3600_000)
  utimesSync(join(dir, "0925-mine--docs.md"), older, older) // the OTHER page is newer by mtime
  armMarker(dir, "cleared1-1111", join(dir, "0925-mine--docs.md"))
  const inj = buildInjection({ dir, source: "clear", sessionId: "fresh222-2222", prevSessionId: "cleared1-1111" })
  assert.match(inj, /# my own thread/, "the cleared session's own page must win over the newer one")
  assert.match(inj, /arm marker of the session this automatic clear replaced/)
})

test("every reload states that the thread is the work and a goal file is context — the measured lane takeover", () => {
  const dir = tmp()
  handoff(dir, "0925-aaaa--thread.md", "# thread")
  assert.match(buildInjection({ dir, source: "clear", sessionId: "fresh222" }), /not your work queue/)
  assert.match(buildInjection({ dir, source: "compact", sessionId: "fresh222" }), /not your work queue/)
  assert.match(buildInjection({ dir: tmp(), source: "clear", sessionId: "x" }), /not your work queue/,
    "the nothing-to-load path needs it too — that context is the likeliest to grab another lane")
})

test("a compact with no own marker must not load the newest handoff by mtime — measured 2026-11-23: 80 of 141 watched sessions never armed, and their native compacts were handed another thread's page", () => {
  const dir = tmp()
  handoff(dir, "1122-aaaa--my-thread.md", "# my thread — never armed\n")
  handoff(dir, "1123-bbbb--other-seat.md", "# ANOTHER seat's thread body\n")
  const older = new Date(Date.now() - 3 * 3600_000)
  utimesSync(join(dir, "1122-aaaa--my-thread.md"), older, older) // the other seat's page is the newest
  const inj = buildInjection({ dir, source: "compact", sessionId: "unarmed1-2222" })
  assert.doesNotMatch(inj, /ANOTHER seat's thread body/, "no body is loaded on a guess")
  assert.doesNotMatch(inj, /\*\*Handoff:/, "nothing is presented as THE handoff")
  assert.ok(inj.includes(NO_OWN_HANDOFF), "the instruction is stated verbatim")
  assert.match(inj, /`1123-bbbb` · other-seat · \d+ min old/, "candidates carry id, slug and age")
  assert.match(inj, /`1122-aaaa` · my-thread · 3 h old/)
  assert.match(inj, /not your work queue/, "the lane guard holds here too")
})

test("a compact WITH its own marker still loads that handoff — the list replaces only the mtime guess", () => {
  const dir = tmp()
  handoff(dir, "1122-aaaa--my-thread.md", "# my thread body\n")
  handoff(dir, "1123-bbbb--other-seat.md", "# other\n")
  armMarker(dir, "armed111-2222", "1122-aaaa--my-thread.md")
  const inj = buildInjection({ dir, source: "compact", sessionId: "armed111-2222" })
  assert.match(inj, /# my thread body/)
  assert.doesNotMatch(inj, new RegExp(NO_OWN_HANDOFF.slice(0, 30)))
})

test("the clear path keeps its mtime fallback — a cleared context has no summary to rely on", () => {
  const dir = tmp()
  handoff(dir, "1123-bbbb--only.md", "# the only page\n")
  const inj = buildInjection({ dir, source: "clear", sessionId: "fresh333-4444" })
  assert.match(inj, /# the only page/)
  assert.match(inj, /verify it is YOURS/)
})
