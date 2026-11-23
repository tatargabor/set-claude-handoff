import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { cmdInit } from "../bin/cli.mjs"
import { INSTALLED_FILES, manifestKey } from "../bin/installed-files.mjs"
import { cmdVersions, shippedFilesFromGit, shippedHashesOf } from "../bin/versions.mjs"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const silent = () => {}
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")
const committedManifest = () => JSON.parse(readFileSync(join(PKG_ROOT, "shipped-hashes.json"), "utf8"))

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
  assert.deepEqual(Object.keys(committedManifest()).sort(), installed)
})

test("the last shipped hash of every key is the file's current content — a manifest regenerated on a stale checkout would misclassify the current version as a local edit", () => {
  const manifest = committedManifest()
  for (const e of INSTALLED_FILES) {
    const hashes = manifest[manifestKey(e)]
    assert.ok(Array.isArray(hashes) && hashes.length > 0, `${manifestKey(e)} must list at least one shipped version`)
    assert.match(hashes.at(-1), /^[0-9a-f]{64}$/, "every entry is a full sha256 hex digest")
    assert.equal(
      hashes.at(-1),
      sha256(readFileSync(join(PKG_ROOT, e.src))),
      `${e.src}'s current content must be the newest shipped version`,
    )
  }
})

test("shipped-hashes.json is up to date with HEAD — a release that edits a template without regenerating ships a version its own manifest does not list", () => {
  // This is what forces a release to regenerate: any template change without a re-run of
  // `versions --regenerate` breaks this compare.
  assert.deepEqual(shippedFilesFromGit({ pkgRoot: PKG_ROOT }), committedManifest())
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

test("`versions --json` prints the promised shape — {package, version, files}, files equal to the committed JSON", () => {
  const out = execFileSync(process.execPath, [join(PKG_ROOT, "bin/cli.mjs"), "versions", "--json"], { encoding: "utf8" })
  const m = JSON.parse(out)
  assert.deepEqual(Object.keys(m), ["package", "version", "files"])
  assert.equal(m.package, "set-claude-handoff")
  assert.equal(m.version, JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version)
  assert.deepEqual(m.files, committedManifest())
})

test("the doctor view separates an unedited copy from a local edit — the promise the manifest exists for", () => {
  const pkg = mkdtempSync(join(tmpdir(), "versions-doctor-"))
  cpSync(join(PKG_ROOT, "shipped-hashes.json"), join(pkg, "shipped-hashes.json"))
  cpSync(join(PKG_ROOT, "skills"), join(pkg, "skills"), { recursive: true })
  cpSync(join(PKG_ROOT, "templates"), join(pkg, "templates"), { recursive: true })

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
