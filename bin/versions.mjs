/**
 * The shipped-versions manifest (`versions`): for every file init installs, the sha256 of every
 * version this repository ever shipped, oldest first. A consumer's doctor hashes its installed
 * copy and looks it up here — a hit means "an unedited copy of ours" (safe to overwrite), a
 * miss means "a local edit" (ask before overwriting).
 *
 * The backing data is the committed shipped-hashes.json at the package root. `--regenerate`
 * rebuilds it from `git log --follow` of each source file (every distinct blob, oldest first,
 * deduped), so it runs only in a git checkout; the published package ships the committed JSON
 * (package.json "files") and never needs git.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { INSTALLED_FILES, manifestKey } from "./installed-files.mjs"

const MANIFEST_FILE = "shipped-hashes.json"
const ZERO_BLOB = /^0+$/

function runGit(pkgRoot, args) {
  return execFileSync("git", ["-C", pkgRoot, ...args], { maxBuffer: 64 * 1024 * 1024 })
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")

/**
 * Every distinct content version of one source file, oldest first, as sha256 hex.
 *
 * --follow because several files were renamed into place (templates/hooks/…); the raw line's
 * 4th field is the post-image blob, and additions/deletions carry the all-zero blob, which has
 * no content to hash. git log is newest first; the manifest lists oldest first, so the LAST
 * entry is always the current version — that is the invariant test/versions.test.mjs enforces.
 */
export function shippedHashesOf(src, { pkgRoot, git = runGit, hash = sha256 } = {}) {
  const out = git(pkgRoot, ["log", "--follow", "--no-abbrev", "--format=%H", "--raw", "--", src]).toString()
  const blobs = []
  for (const line of out.split("\n")) {
    if (!line.startsWith(":")) continue
    const blob = line.slice(1).split(" ")[3]
    if (blob && !ZERO_BLOB.test(blob)) blobs.push(blob)
  }
  blobs.reverse()
  const seen = new Set()
  const hashes = []
  for (const blob of blobs) {
    if (seen.has(blob)) continue
    seen.add(blob)
    hashes.push(hash(git(pkgRoot, ["cat-file", "blob", blob])))
  }
  if (!hashes.length) throw new Error(`versions: ${src} has no git history — commit it first, then regenerate`)
  return hashes
}

/** The manifest's files map: installed target path → every shipped sha256, oldest first. */
export function shippedFilesFromGit({ pkgRoot }) {
  const files = {}
  for (const e of INSTALLED_FILES) files[manifestKey(e)] = shippedHashesOf(e.src, { pkgRoot })
  return files
}

/**
 * versions [--json] [--regenerate]
 *   --regenerate  rebuild shipped-hashes.json from git history (git checkout only)
 *   --json        print the manifest a consumer's doctor parses
 *   neither       the doctor view of this package's own copies
 */
export function cmdVersions(pkgRoot, rest, { log = console.log, err = console.error } = {}) {
  const regenerate = rest.includes("--regenerate")
  const json = rest.includes("--json")

  if (regenerate) {
    try {
      runGit(pkgRoot, ["rev-parse", "--is-inside-work-tree"])
    } catch {
      err(`versions --regenerate reads git history and needs a git checkout — the published package ships ${MANIFEST_FILE} already`)
      return 1
    }
    const files = shippedFilesFromGit({ pkgRoot })
    writeFileSync(join(pkgRoot, MANIFEST_FILE), JSON.stringify(files, null, 2) + "\n")
    const count = Object.values(files).reduce((a, h) => a + h.length, 0)
    log(`wrote ${MANIFEST_FILE} — ${Object.keys(files).length} installed files, ${count} shipped versions`)
  }

  if (!regenerate || json) {
    const file = join(pkgRoot, MANIFEST_FILE)
    // Absence is announced, never silent: an empty stdout would read as "zero shipped
    // versions", i.e. every installed file a local edit — the one answer a doctor must not guess.
    if (!existsSync(file)) {
      err(`versions: ${MANIFEST_FILE} is missing at ${file} — regenerate it in a git checkout: node bin/cli.mjs versions --regenerate`)
      return 1
    }
    const files = JSON.parse(readFileSync(file, "utf8"))
    if (json) {
      const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"))
      log(JSON.stringify({ package: pkg.name, version: pkg.version, files }, null, 2))
      return 0
    }
    // The doctor view: does the package's own copy match a version it ever shipped?
    for (const e of INSTALLED_FILES) {
      const hashes = files[manifestKey(e)]
      if (!hashes) {
        log(`${manifestKey(e)}  NOT IN MANIFEST — regenerate`)
        continue
      }
      const current = sha256(readFileSync(join(pkgRoot, e.src)))
      const verdict = hashes.includes(current) ? "current content SHIPPED" : "current content is a LOCAL EDIT (not in the shipped list)"
      log(`${manifestKey(e)}  ${hashes.length} shipped version(s)  ${verdict}`)
    }
  }
  return 0
}
