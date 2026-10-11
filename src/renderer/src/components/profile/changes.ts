import type { MasterProfile } from '@shared/master-profile'

/** Ignores differences that the file format cannot represent (blank lines in lists, trailing spaces). */
export function normalizeProfile(p: MasterProfile): MasterProfile {
  const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean)
  return {
    ...p,
    summary: p.summary.trim(),
    gaps: clean(p.gaps),
    experience: p.experience.map((e) => ({ ...e, highlights: clean(e.highlights) })),
    projects: p.projects.map((e) => ({ ...e, highlights: clean(e.highlights) })),
    education: p.education.map((e) => ({ ...e, highlights: clean(e.highlights) }))
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * How many fields differ between two values, as a person would count them: a changed text field
 * is one, a list of lines (highlights, gaps) is one field, and an entry added or removed is one.
 */
export function countChanges(a: unknown, b: unknown): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    // A list of plain values is one field (one textarea, one comma list).
    if (a.every((x) => !isRecord(x)) && b.every((x) => !isRecord(x))) return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1
    let n = Math.abs(a.length - b.length)
    for (let i = 0; i < Math.min(a.length, b.length); i++) n += countChanges(a[i], b[i])
    return n
  }
  if (isRecord(a) && isRecord(b)) {
    let n = 0
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) n += countChanges(a[key], b[key])
    return n
  }
  return a === b ? 0 : 1
}

/** Changed fields between the form and the file, ignoring what the file format cannot hold. */
export function profileChanges(draft: MasterProfile, saved: MasterProfile): number {
  return countChanges(normalizeProfile(draft), normalizeProfile(saved))
}

export function fieldsLabel(n: number): string {
  return `${n} field${n === 1 ? '' : 's'}`
}

/** The leave-guard question's text (Figma: Profile — Leave guard modal). */
export function leaveMessage(changes: number, fileName: string): string {
  return `The master profile has ${changes} unsaved field${changes === 1 ? '' : 's'}. Leaving the page throws ${changes === 1 ? 'it' : 'them'} away; ${fileName} on disk is not touched.`
}
