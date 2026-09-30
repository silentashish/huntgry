import { describe, expect, it } from 'vitest'
import { alreadyAppliedText, applyBlocker } from './blocker'

describe('applyBlocker', () => {
  it('needs resume.pdf and a posting URL', () => {
    expect(applyBlocker({ files: [], jobUrl: 'https://x.example' })).toMatch(/resume\.pdf/)
    expect(applyBlocker({ files: ['resume.pdf'], jobUrl: null })).toMatch(/posting URL/)
    expect(applyBlocker({ files: ['cover.pdf', 'resume.pdf'], jobUrl: 'https://x.example' })).toBeNull()
  })

  it('says when it was applied', () => {
    expect(alreadyAppliedText('2026-09-30')).toContain('2026-09-30')
    expect(alreadyAppliedText(undefined)).toBe('You marked this application as applied.')
  })
})
