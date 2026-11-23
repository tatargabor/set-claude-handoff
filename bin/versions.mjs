/**
 * The shipped-versions manifest (`versions`): for every file init installs, the sha256 of every
 * version this repository ever shipped, oldest first. A consumer's doctor hashes its installed
 * copy and looks it up here — a hit means "an unedited copy of ours" (safe to overwrite), a
 * miss means "a local edit" (ask before overwriting).
 *
 * shipped-hashes.json is GENERATED, never committed: everything that packs the package —
 * `npm publish`, `npm pack`, installing it as a git dependency — runs the prepack script
 * `versions --regenerate`, so every published or git-installed package carries a fresh JSON,
 * and a template commit never needs a regeneration commit next to it. A git checkout has no
 * committed JSON to read: there `versions --json` computes the manifest live from git history
 * without writing; a package directory without git reads shipped-hashes.json; with neither,
 * the command announces it on stderr and exits 1.
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

/** Is this package root a git checkout (the only place history can be read)? */
function inGitCheckout(pkgRoot) {
  try {
    runGit(pkgRoot, ["rev-parse", "--is-inside-work-tree"])
    return true
  } catch {
    return false
  }
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
  // --topo-order keeps parents before children in the newest-first walk, so "first occurrence"
  // below really is a blob's newest appearance even where --follow crosses renames.
  const out = git(pkgRoot, ["log", "--follow", "--topo-order", "--no-abbrev", "--format=%H", "--raw", "--", src]).toString()
  // Dedupe keeps each blob's first occurrence in the NEWEST-first walk — its newest appearance.
  // Deduping after reversing instead keeps the OLDEST appearance, and that is the measured bug:
  // with v1 → v2 → v1 the list came out [v1, v2], so the live v1 file read as a local edit, and
  // --regenerate reproduced the same wrong order. Newest-first + reverse keeps the list oldest
  // first AND lets each blob's newest position stand — the current content ends up last.
  const seen = new Set()
  const newestFirst = []
  for (const line of out.split("\n")) {
    if (!line.startsWith(":")) continue
    const blob = line.slice(1).split(" ")[3]
    if (blob && !ZERO_BLOB.test(blob) && !seen.has(blob)) {
      seen.add(blob)
      newestFirst.push(blob)
    }
  }
  const hashes = newestFirst.reverse().map((blob) => hash(git(pkgRoot, ["cat-file", "blob", blob])))
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
    if (!inGitCheckout(pkgRoot)) {
      err(`versions --regenerate reads git history and needs a git checkout — the published package ships ${MANIFEST_FILE} already`)
      return 1
    }
    const files = shippedFilesFromGit({ pkgRoot })
    writeFileSync(join(pkgRoot, MANIFEST_FILE), JSON.stringify(files, null, 2) + "\n")
    const count = Object.values(files).reduce((a, h) => a + h.length, 0)
    log(`wrote ${MANIFEST_FILE} — ${Object.keys(files).length} installed files, ${count} shipped versions`)
  }

  if (!regenerate || json) {
    let files
    if (json && !regenerate && inGitCheckout(pkgRoot)) {
      // A git checkout has no committed JSON to serve (shipped-hashes.json is generated, not
      // committed): compute the manifest live, exactly as --regenerate does, but write nothing —
      // serving a stored copy would freeze the list at whatever the last regeneration produced.
      files = shippedFilesFromGit({ pkgRoot })
    } else {
      const file = join(pkgRoot, MANIFEST_FILE)
      // Absence is announced, never silent: an empty stdout would read as "zero shipped
      // versions", i.e. every installed file a local edit — the one answer a doctor must not guess.
      if (!existsSync(file)) {
        err(`versions: ${MANIFEST_FILE} is missing at ${file} — regenerate it in a git checkout: node bin/cli.mjs versions --regenerate`)
        return 1
      }
      files = JSON.parse(readFileSync(file, "utf8"))
    }
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
