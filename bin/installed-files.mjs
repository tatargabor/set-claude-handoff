/**
 * THE table of every file init writes verbatim into the target .claude/. The installer
 * (cli.mjs) and the shipped-versions manifest (versions.mjs) both read it, so the manifest can
 * never drift from what init actually installs.
 *
 * src   the package file, relative to the package root
 * dst   the install target, relative to the project's .claude/
 * when  the opt-in that installs it — null = every init; "auto-clear" / "autopilot" = the flag
 *
 * The manifest reports .claude/ + dst (manifestKey) because that is the path a consumer's
 * doctor hashes. Both directions of a mismatch are defects: a manifest key init does not write
 * blesses a foreign path; an install missing from the manifest is invisible to the doctor.
 * test/versions.test.mjs guards both directions and the completeness of templates/ itself.
 */
export const INSTALLED_FILES = [
  { src: "skills/handoff/SKILL.md", dst: "skills/handoff/SKILL.md", when: null },
  { src: "skills/auto-clear/SKILL.md", dst: "skills/auto-clear/SKILL.md", when: null },
  { src: "templates/clear-gate.mjs", dst: "hooks/clear-gate.mjs", when: "auto-clear" },
  { src: "templates/hooks/handoff-reinject-clear.mjs", dst: "hooks/handoff-reinject-clear.mjs", when: "auto-clear" },
  { src: "templates/watch-auto-clear.sh", dst: "hooks/watch-auto-clear.sh", when: "auto-clear" },
  { src: "templates/presence.mjs", dst: "hooks/presence.mjs", when: "auto-clear" },
  { src: "templates/turn-state.mjs", dst: "hooks/turn-state.mjs", when: "auto-clear" },
  { src: "templates/handoff-arm.mjs", dst: "hooks/handoff-arm.mjs", when: "auto-clear" },
  { src: "templates/keep-going.mjs", dst: "hooks/keep-going.mjs", when: "auto-clear" },
  { src: "templates/autopilot/answer-dialog.mjs", dst: "hooks/autopilot/answer-dialog.mjs", when: "autopilot" },
  { src: "templates/autopilot/answer-stop.mjs", dst: "hooks/autopilot/answer-stop.mjs", when: "autopilot" },
  { src: "templates/autopilot/capture-answer.mjs", dst: "hooks/autopilot/capture-answer.mjs", when: "autopilot" },
  { src: "templates/autopilot/capture-prompt.mjs", dst: "hooks/autopilot/capture-prompt.mjs", when: "autopilot" },
  { src: "templates/autopilot/drift-guard.mjs", dst: "hooks/autopilot/drift-guard.mjs", when: "autopilot" },
  { src: "templates/autopilot/judge.mjs", dst: "hooks/autopilot/judge.mjs", when: "autopilot" },
  { src: "templates/autopilot/ledger.mjs", dst: "hooks/autopilot/ledger.mjs", when: "autopilot" },
  { src: "templates/autopilot/validate.mjs", dst: "hooks/autopilot/validate.mjs", when: "autopilot" },
  { src: "skills/autopilot/SKILL.md", dst: "skills/autopilot/SKILL.md", when: "autopilot" },
]

/** The installed target path a consumer's doctor hashes, relative to the project root. */
export function manifestKey(entry) {
  return ".claude/" + entry.dst
}
