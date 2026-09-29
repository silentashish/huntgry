/**
 * Every Resume Tailor naming convention the app relies on lives here, so a
 * change in the skill (silentashish/claude-resume-generator-skill) is a
 * one-file update. The skill's code has no workspace contract beyond
 * `CV_HOME/<role>/<company>/<job-id>/`; the master profile name is a README
 * convention that differs between versions.
 */

/** Master profile name used by the skill v3 README ("How to use"). Create writes this one. */
export const MASTER_PROFILE_FILE = 'master-profile.md'

/** Older name (README flowchart, `assets/master_profile.example.md`). Accepted on Import. */
export const LEGACY_MASTER_PROFILE_FILE = 'master_profile.md'

/** Optional base cover letter listed by the v3 README. */
export const COVER_LETTER_FILE = 'cover-letter.md'

/** Tells Claude Code that this directory is CV_HOME. Written by Create only, never by Import. */
export const CLAUDE_FILE = 'CLAUDE.md'

/** Huntgry's own data inside a workspace (runs, saved jobs, tracking); never an application folder. */
export const HUNTGRY_DIR = '.huntgry'

/** Entries that do not make a directory "non-empty" and are skipped by the scan. */
export const IGNORED_ENTRIES: ReadonlySet<string> = new Set([
  HUNTGRY_DIR,
  '.DS_Store',
  '.git',
  'Thumbs.db',
  '.build',
  'desktop.ini'
])

/** Files `build.py` writes into `<CV_HOME>/<role>/<company>/<job-id>/`. Any one marks an application folder. */
export const APPLICATION_MARKERS: ReadonlySet<string> = new Set([
  'job-description.md',
  'resume_data.json',
  'build-report.json',
  'resume.pdf',
  'cover_data.json'
])

/** `<role>/<company>/<job-id>` sits exactly this many directories below the root. */
export const APPLICATION_DEPTH = 3

/** Upper bound on directory entries visited per scan, so picking `~` or `/` cannot hang the app. */
export const MAX_SCAN_ENTRIES = 5000
