import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, existsSync, utimesSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, basename } from "node:path"
import { execFileSync } from "node:child_process"
import { buildInjection, sameEventDoubleFire } from "../templates/hooks/handoff-reinject-clear.mjs"

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
  assert.match(inj, /# thread/)
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

test("several handoffs → the mtime choice is announced and the others are named — parallel threads", () => {
  const dir = tmp()
  handoff(dir, "0911-old--other-thread.md", "# other thread")
  handoff(dir, "0912-new--this-thread.md", "# this thread")
  const inj = buildInjection({ dir, source: "clear" })
  assert.match(inj, /0912-new--this-thread\.md/)
  assert.match(inj, /0911-old--other-thread\.md/, "the not-chosen thread must stay reachable")
  assert.match(inj, /verify it is YOURS/)
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
  const inj = buildInjection({ dir, source: "compact" })
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
