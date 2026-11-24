import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { cmdInit } from "../bin/cli.mjs"
import { INSTALLED_FILES, manifestKey } from "../bin/installed-files.mjs"
import { cmdVersions, shippedFilesFromGit, shippedHashesOf } from "../bin/versions.mjs"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const silent = () => {}
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")
// shipped-hashes.json is generated, never committed — the manifest this suite asserts against
// is the one computed live from git history, which is what `versions --json` serves here.
const liveManifest = () => shippedFilesFromGit({ pkgRoot: PKG_ROOT })

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })
}

test("the manifest's keys are exactly the files init --auto-clear --autopilot writes — a key init does not write blesses a foreign path; a written file without a key is invisible to the doctor", () => {
  const dir = mkdtempSync(join(tmpdir(), "versions-map-"))
  cmdInit({ cwd: dir, autoClear: true, autopilot: true, log: silent })
  const written = walk(join(dir, ".claude"))
    .map((p) => ".claude/" + relative(join(dir, ".claude"), p).replaceAll("\\", "/"))
    .sort()
  // handoff.profile.md is project-owned generated content — detection fills it per project,
  // so it is not a verbatim copy of a package file and has no shipped blob to list.
  const installed = written.filter((p) => p !== ".claude/handoff.profile.md")
  assert.deepEqual(Object.keys(liveManifest()).sort(), installed)
})

test("the last shipped hash of every key is the file's HEAD blob — a manifest whose newest entry is not what HEAD ships would misclassify the shipped version as a local edit; HEAD and not the working tree, so an uncommitted edit must not fail the suite", () => {
  const manifest = liveManifest()
  for (const e of INSTALLED_FILES) {
    const hashes = manifest[manifestKey(e)]
    assert.ok(Array.isArray(hashes) && hashes.length > 0, `${manifestKey(e)} must list at least one shipped version`)
    assert.match(hashes.at(-1), /^[0-9a-f]{64}$/, "every entry is a full sha256 hex digest")
    const headBlob = execFileSync("git", ["-C", PKG_ROOT, "show", `HEAD:${e.src}`])
    assert.equal(
      hashes.at(-1),
      sha256(headBlob),
      `${e.src}'s HEAD blob must be the newest shipped version`,
    )
  }
})

test("shippedHashesOf reads oldest first, deduped, through renames and deletions — a generator bug reproduces on BOTH sides of the committed-JSON compare, so that test alone cannot catch it", () => {
  const repo = mkdtempSync(join(tmpdir(), "versions-git-"))
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  const write = (name, content) => {
    mkdirSync(dirname(join(repo, name)), { recursive: true })
    writeFileSync(join(repo, name), content)
  }
  const commit = (msg) => {
    git("add", "-A")
    git("commit", "-q", "-m", msg)
  }
  write("f.mjs", "v1\n"); commit("v1")
  write("f.mjs", "v2\n"); commit("v2")
  write("f.mjs", "v1\n"); commit("back to v1 — one shipped version, listed once")
  git("mv", "f.mjs", "g.mjs"); commit("rename — --follow bridges it (a rename is ONE commit; a delete + a later re-add is a gap follow cannot cross)")
  write("g.mjs", "v2\n"); commit("v2 again under the new name — deduped, kept at its oldest position")
  write("g.mjs", "v3\n"); commit("v3 — current content, so the last entry")
  assert.deepEqual(shippedHashesOf("g.mjs", { pkgRoot: repo }), [sha256("v1\n"), sha256("v2\n"), sha256("v3\n")])
  // A deletion as the newest event carries the all-zero blob — skipping it is the difference
  // between the file's last real version and a cat-file failure.
  write("h.mjs", "hx\n"); commit("h")
  git("rm", "-q", "h.mjs"); commit("delete h")
  assert.deepEqual(shippedHashesOf("h.mjs", { pkgRoot: repo }), [sha256("hx\n")])
})

test("shippedHashesOf dedupes by NEWEST appearance — with v1 → v2 → v1 the last entry must be v1, the current content: keeping each blob at its OLDEST position produced [v1, v2], so the live v1 file read as a local edit, and --regenerate reproduced the same wrong order on every run", () => {
  const repo = mkdtempSync(join(tmpdir(), "versions-dedupe-"))
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  const write = (name, content) => writeFileSync(join(repo, name), content)
  const commit = (msg) => {
    git("add", "-A")
    git("commit", "-q", "-m", msg)
  }
  write("f.mjs", "v1\n"); commit("v1")
  write("f.mjs", "v2\n"); commit("v2")
  write("f.mjs", "v1\n"); commit("back to v1 — one shipped version, but its newest appearance is last")
  assert.deepEqual(shippedHashesOf("f.mjs", { pkgRoot: repo }), [sha256("v2\n"), sha256("v1\n")])
})

test("shippedHashesOf lists a blob that only a MERGE commit created — `git log --raw` shows no diff for merges by default, so this repo's own merge of two watcher branches left the HEAD blob of watch-auto-clear.sh out of the manifest and the shipped file read as a local edit", () => {
  const repo = mkdtempSync(join(tmpdir(), "versions-merge-"))
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  const commit = (msg) => { git("add", "-A"); git("commit", "-q", "-m", msg) }
  writeFileSync(join(repo, "f.sh"), "a\nmid\nb\n"); commit("base")
  git("checkout", "-q", "-b", "side")
  writeFileSync(join(repo, "f.sh"), "a\nmid\nB\n"); commit("side edits the last line")
  git("checkout", "-q", "main")
  writeFileSync(join(repo, "f.sh"), "A\nmid\nb\n"); commit("main edits the first line")
  git("merge", "-q", "--no-ff", "-m", "merge side", "side") // a clean merge: "A mid B" exists only in the merge commit
  const head = execFileSync("git", ["-C", repo, "show", "HEAD:f.sh"])
  assert.equal(head.toString(), "A\nmid\nB\n")
  assert.equal(shippedHashesOf("f.sh", { pkgRoot: repo }).at(-1), sha256(head), "the merge-made blob must be the newest shipped version")
})

test("every .mjs template the package carries is in the install table — init installs from the table, so a file missing there silently stops shipping at all", () => {
  const templates = ["templates", "templates/hooks", "templates/autopilot"].flatMap((d) =>
    readdirSync(join(PKG_ROOT, d))
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => `${d}/${f}`),
  )
  const srcs = INSTALLED_FILES.map((e) => e.src)
  for (const t of templates) assert.ok(srcs.includes(t), `${t} is not in INSTALLED_FILES — init would never install it`)
  assert.equal(new Set(srcs).size, srcs.length, "a duplicated src would make one manifest key clobber another")
  const keys = INSTALLED_FILES.map(manifestKey)
  assert.equal(new Set(keys).size, keys.length, "a duplicated dst would make one manifest key clobber another")
  for (const e of INSTALLED_FILES) assert.ok(existsSync(join(PKG_ROOT, e.src)), `${e.src} must exist`)
})

test("versions --json without shipped-hashes.json announces it on stderr and exits 1 — an empty stdout would read as zero shipped versions, i.e. every installed file a local edit", () => {
  const empty = mkdtempSync(join(tmpdir(), "versions-missing-"))
  const errs = []
  assert.equal(cmdVersions(empty, ["--json"], { log: silent, err: (m) => errs.push(m) }), 1)
  const text = errs.join("\n")
  assert.match(text, /shipped-hashes\.json/)
  assert.match(text, /--regenerate/, "the remedy must be named, not just the failure")
})

test("versions --regenerate outside a git checkout says so and exits 1 — the published package has no history to read and ships the JSON already", () => {
  const empty = mkdtempSync(join(tmpdir(), "versions-nogit-"))
  const errs = []
  assert.equal(cmdVersions(empty, ["--regenerate"], { log: silent, err: (m) => errs.push(m) }), 1)
  assert.match(errs.join("\n"), /git checkout/)
  assert.ok(!existsSync(join(empty, "shipped-hashes.json")), "no history read, no manifest written")
})

test("the git probe is silent in a package dir without git — execFileSync forwards the child's stderr, so 'fatal: not a git repository' printed before the curated message and the failure read as a git crash instead of the package's own answer", () => {
  const pkg = mkdtempSync(join(tmpdir(), "versions-probe-"))
  // The published package: bin/ + package.json, no .git anywhere above it.
  cpSync(join(PKG_ROOT, "bin"), join(pkg, "bin"), { recursive: true })
  cpSync(join(PKG_ROOT, "package.json"), join(pkg, "package.json"))
  let stderr = ""
  try {
    execFileSync(process.execPath, [join(pkg, "bin/cli.mjs"), "versions", "--regenerate"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch (e) {
    stderr = String(e.stderr)
  }
  assert.match(stderr, /git checkout/, "the curated message must be the answer")
  assert.ok(!stderr.includes("fatal:"), `git's raw stderr leaked past the probe: ${stderr}`)
})

test("a corrupt shipped-hashes.json announces the file and the remedy on stderr and exits 1 — an uncaught JSON.parse stack trace names neither and reads as a package bug instead of bad data", () => {
  const pkg = mkdtempSync(join(tmpdir(), "versions-corrupt-"))
  writeFileSync(join(pkg, "shipped-hashes.json"), "{ this is not json")
  const errs = []
  assert.equal(cmdVersions(pkg, ["--json"], { log: silent, err: (m) => errs.push(m) }), 1)
  const text = errs.join("\n")
  assert.match(text, /shipped-hashes\.json/)
  assert.match(text, /--regenerate/, "a git checkout must be told the regeneration remedy")
  assert.match(text, /reinstall/, "an installed package must be told the reinstall remedy")
})

test("regenerating in a checkout where an installed file has no history announces the file and the remedy on stderr and exits 1 — the shippedHashesOf throw used to escape cmdVersions as an uncaught stack trace", () => {
  const repo = mkdtempSync(join(tmpdir(), "versions-nohistory-"))
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  // One seed commit, so `git log` itself succeeds and the empty result really is "this file has
  // no history" — the path shippedHashesOf must report, not a git error.
  writeFileSync(join(repo, "README.md"), "seed\n")
  git("add", "-A")
  git("commit", "-q", "-m", "seed")
  const errs = []
  assert.equal(cmdVersions(repo, ["--regenerate"], { log: silent, err: (m) => errs.push(m) }), 1)
  const text = errs.join("\n")
  assert.match(text, /has no git history/)
  assert.match(text, /commit it first, then regenerate/)
  assert.ok(!existsSync(join(repo, "shipped-hashes.json")), "no manifest written from a failed history read")
})

test("`versions --json` prints the promised shape — {package, version, files}, files equal to the manifest computed from git history", () => {
  const out = execFileSync(process.execPath, [join(PKG_ROOT, "bin/cli.mjs"), "versions", "--json"], { encoding: "utf8" })
  const m = JSON.parse(out)
  assert.deepEqual(Object.keys(m), ["package", "version", "files"])
  assert.equal(m.package, "set-claude-handoff")
  assert.equal(m.version, JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version)
  assert.deepEqual(m.files, liveManifest())
})

test("versions --json in a git checkout computes the manifest LIVE, ignoring any on-disk shipped-hashes.json — serving the stored JSON would freeze the list at the last regeneration, which is what forced a regeneration commit after every template commit", () => {
  const file = join(PKG_ROOT, "shipped-hashes.json")
  writeFileSync(file, "{}\n")
  try {
    const out = execFileSync(process.execPath, [join(PKG_ROOT, "bin/cli.mjs"), "versions", "--json"], { encoding: "utf8" })
    assert.deepEqual(JSON.parse(out).files, liveManifest())
  } finally {
    unlinkSync(file)
  }
})

test("the doctor view separates an unedited copy from a local edit — the promise the manifest exists for", () => {
  const pkg = mkdtempSync(join(tmpdir(), "versions-doctor-"))
  // A package dir without git reads the JSON — generate it here exactly as --regenerate writes
  // it, so the test never depends on this checkout's own (uncommitted) copy.
  writeFileSync(join(pkg, "shipped-hashes.json"), JSON.stringify(liveManifest(), null, 2) + "\n")
  // The package files are HEAD's, not the working tree's: the manifest is built from history, so a
  // working-tree copy made this test red during every uncommitted template or skill edit (seen
  // 2026-11-24, four times in one session) although nothing was wrong.
  const tar = execFileSync("git", ["-C", PKG_ROOT, "archive", "HEAD", "skills", "templates"], { maxBuffer: 64 * 1024 * 1024 })
  execFileSync("tar", ["-x", "-C", pkg], { input: tar })

  const clean = []
  assert.equal(cmdVersions(pkg, [], { log: (m) => clean.push(m), err: silent }), 0)
  assert.equal(clean.length, INSTALLED_FILES.length, "one line per installed file")
  assert.ok(clean.every((l) => !/LOCAL EDIT/.test(l)), "an untouched package has no local edit")

  appendFileSync(join(pkg, "templates", "presence.mjs"), "\n// a local tweak\n")
  const edited = []
  assert.equal(cmdVersions(pkg, [], { log: (m) => edited.push(m), err: silent }), 0)
  const flagged = edited.filter((l) => /LOCAL EDIT/.test(l))
  assert.equal(flagged.length, 1, "exactly the edited file is flagged")
  assert.match(flagged[0], /\.claude\/hooks\/presence\.mjs/)
})
