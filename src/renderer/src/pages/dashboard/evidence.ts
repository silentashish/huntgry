import type { EvidenceTarget } from '@shared/insights-types'
import type { MasterProfile } from '@shared/master-profile'

/**
 * The evidence modal's preview of the change to master-profile.md, before anything is written:
 * the lines it adds (`added`, shown with "+") and the line it replaces (`removed`, shown with "-"), if any.
 */
export function changeLines(before: MasterProfile, after: MasterProfile, t: EvidenceTarget): { removed: string[]; added: string[] } {
  if (t.kind === 'skills') {
    const changed = after.skills.find((g) => {
      const old = before.skills.find((o) => o.category === g.category)
      return !old || JSON.stringify(old) !== JSON.stringify(g)
    })
    if (!changed) return { removed: [], added: [] }
    const old = before.skills.find((o) => o.category === changed.category)
    return {
      removed: old ? [`Skills · ${old.category}: ${old.items.join(', ')}`] : [],
      added: [`Skills · ${changed.category}: ${changed.items.join(', ')}`]
    }
  }
  const pick = (p: MasterProfile) => (t.kind === 'experience' ? p.experience[t.index] : p.projects[t.index])
  const a = pick(before)
  const b = pick(after)
  const removed: string[] = []
  const added: string[] = []
  if (a.technologies !== b.technologies) {
    if (a.technologies.trim()) removed.push(`Technologies: ${a.technologies}`)
    added.push(`Technologies: ${b.technologies}`)
  }
  for (const h of b.highlights.filter((h) => !a.highlights.includes(h))) added.push(`- ${h}`)
  return { removed, added }
}
