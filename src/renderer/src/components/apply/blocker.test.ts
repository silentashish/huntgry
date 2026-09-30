import { describe, expect, it, vi } from 'vitest'
import type { ApplicationRecord, ApplicationsList } from '@shared/applications-types'
import { alreadyAppliedText, applyBlocker, trackingFor } from './blocker'

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

describe('trackingFor', () => {
  const list = (records: Array<Pick<ApplicationRecord, 'id' | 'tracking'>>) => {
    const fn = vi.fn(async () => ({ applications: records, truncated: false }) as unknown as ApplicationsList)
    return fn
  }

  it('uses the tracking the caller has, without listing', async () => {
    const fn = list([])
    expect(await trackingFor({ id: 'a', tracking: { status: 'applied', notes: '' } }, fn)).toMatchObject({
      status: 'applied'
    })
    expect(fn).not.toHaveBeenCalled()
  })

  it('looks the application up when only the id is known (Tailor run)', async () => {
    const fn = list([
      { id: 'r/c/1', tracking: { status: 'generated', notes: '' } },
      { id: 'r/c/2', tracking: { status: 'applied', notes: '', appliedAt: '2026-09-30' } }
    ])
    expect(await trackingFor({ id: 'r/c/2' }, fn)).toMatchObject({ status: 'applied', appliedAt: '2026-09-30' })
    expect(await trackingFor({ id: 'r/c/9' }, fn)).toBeUndefined()
  })
})
