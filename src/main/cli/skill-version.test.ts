import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSkillMd, skillSupportsSingleFlow, skillVersionWarning } from './skill-version'

const V5 = '# resume-tailor\n\n```markdown\n# Tailoring notes\n<!-- resume-tailor notes v2 -->\n```\n'
const V4 = '# resume-tailor\n\nStop after the gap analysis and ask the user to approve.\n'

describe('skill version (#158: Huntgry needs resume-tailor v5)', () => {
  it('reads the copy itself: v5 carries the v2 notes marker, v4 does not', () => {
    expect(skillSupportsSingleFlow(V5, null)).toBe(true)
    expect(skillSupportsSingleFlow(V4, null)).toBe(false)
    expect(skillSupportsSingleFlow(V5, 'v6')).toBe(true)
  })

  it('takes a known release tag below v5 as old, whatever the text', () => {
    expect(skillSupportsSingleFlow(V5, 'v4')).toBe(false)
    expect(skillSupportsSingleFlow(null, 'v4')).toBe(false)
    expect(skillSupportsSingleFlow(null, 'v5')).toBe(true)
    expect(skillSupportsSingleFlow(null, null)).toBeNull()
  })

  it('warns without blocking, naming the copy and the update', () => {
    expect(skillVersionWarning('v4')).toMatch(/needs resume-tailor v5 \(this copy is v4\).*still work.*Sync from GitHub/)
    expect(skillVersionWarning(null)).not.toContain('this copy is')
  })

  it('reads SKILL.md of a skill folder, null when missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huntgry-skill-'))
    try {
      expect(await readSkillMd(dir)).toBeNull()
      expect(await readSkillMd(null)).toBeNull()
      await writeFile(join(dir, 'SKILL.md'), V5)
      expect(await readSkillMd(dir)).toBe(V5)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
