import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NOTES_V2_MARKER } from '@shared/review-types'
import { MIN_SKILL_TAG } from '@shared/runner-types'

/**
 * Whether the resume-tailor skill in use is the one the single flow is built on (#158): v5 runs to
 * the end, writes tailoring-notes.md v2 and reads a job description Huntgry saved. SKILL.md has no
 * version field and a copy installed by hand has no release tag, so the copy's own text decides
 * (v5's SKILL.md carries the v2 notes marker); a known tag below the minimum counts too. An older
 * copy keeps working (the prompt spells the v2 notes out), so this is a warning, never a problem.
 */

const tagNumber = (tag: string): number | null => {
  const m = /^v(\d+)$/.exec(tag.trim())
  return m ? Number(m[1]) : null
}

/** `true` when the copy is v5 or newer, `false` when older, `null` when there is no SKILL.md to read. */
export function skillSupportsSingleFlow(skillMd: string | null, installedTag: string | null): boolean | null {
  const n = installedTag ? tagNumber(installedTag) : null
  const min = tagNumber(MIN_SKILL_TAG)!
  if (n !== null && n < min) return false
  if (skillMd === null) return n === null ? null : n >= min
  return skillMd.includes(NOTES_V2_MARKER)
}

export async function readSkillMd(skillDir: string | null): Promise<string | null> {
  if (!skillDir) return null
  return readFile(join(skillDir, 'SKILL.md'), 'utf8').catch(() => null)
}

export function skillVersionWarning(installedTag: string | null): string {
  return `Huntgry needs resume-tailor ${MIN_SKILL_TAG}${installedTag ? ` (this copy is ${installedTag})` : ''}: it runs to the end and writes the tailoring notes Review reads. Runs on this copy still work; use "Sync from GitHub" in Settings → Claude Code to update it.`
}
