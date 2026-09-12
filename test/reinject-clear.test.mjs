import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, existsSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildInjection, sameEventDoubleFire } from "../templates/hooks/handoff-reinject-clear.mjs"

const tmp = () => mkdtempSync(join(tmpdir(), "reinject-"))

function handoff(dir, name, body) {
  writeFileSync(join(dir, name), body)
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
