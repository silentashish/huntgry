import { describe, expect, it, vi } from 'vitest'
import type { ApplicationTracking } from '@shared/applications-types'
import { alreadyAppliedText, applyBlocker, trackingFor } from './blocker'

describe('applyBlocker', () => {
  it('needs resume.pdf and a posting URL', () => {
    expect(applyBlocker({ files: [], jobUrl: 'https://x.example' })).toMatch(/resume\.pdf/)
    expect(applyBlocker({ files: ['resume.pdf'], jobUrl: null })).toMatch(/posting URL/)
    expect(applyBlocker({ files: ['cover.pdf', 'resume.pdf'], jobUrl: 'https://x.example' })).toBeNull()
  })

  it('blocks unreviewed, needs-attention and discarded unattended results until approved', () => {
    const ok = { files: ['resume.pdf'], jobUrl: 'https://x.example' }
    const at = '2026-09-30T00:00:00.000Z'
    const review = (state: 'unreviewed' | 'needs-attention' | 'approved' | 'discarded') => ({
      tracking: { review: { state, runId: 'r', at } }
    })
    expect(applyBlocker({ ...ok, ...review('unreviewed') })).toMatch(/Unreviewed.*Review page/)
    expect(applyBlocker({ ...ok, ...review('needs-attention') })).toMatch(/needs attention/)
    expect(applyBlocker({ ...ok, ...review('discarded') })).toMatch(/discarded/)
    expect(applyBlocker({ ...ok, ...review('approved') })).toBeNull()
    expect(applyBlocker({ ...ok, tracking: { review: undefined } })).toBeNull()
    // The review state is the first reason given.
    expect(applyBlocker({ files: [], jobUrl: null, ...review('unreviewed') })).toMatch(/Unreviewed/)
  })

  it('says when it was applied', () => {
    expect(alreadyAppliedText('2026-09-30')).toContain('2026-09-30')
    expect(alreadyAppliedText(undefined)).toBe('You marked this application as applied.')
  })
})

describe('trackingFor', () => {
  const store: Record<string, ApplicationTracking> = {
    'r/c/1': { status: 'generated', notes: '' },
    'r/c/2': { status: 'applied', notes: '', appliedAt: '2026-09-30' }
  }
  const getter = () =>
    vi.fn(async (id: string) => {
      const tracking = store[id]
      if (!tracking) throw new Error('This application folder no longer exists.')
      return { tracking }
    })

  it('uses the tracking the caller has, without reading', async () => {
    const get = getter()
    expect(await trackingFor({ id: 'a', tracking: { status: 'applied', notes: '' } }, get)).toMatchObject({
      status: 'applied'
    })
    expect(get).not.toHaveBeenCalled()
  })

  it('reads the application by id when only the id is known (Tailor run), never from a possibly truncated list', async () => {
    const get = getter()
    expect(await trackingFor({ id: 'r/c/2' }, get)).toMatchObject({ status: 'applied', appliedAt: '2026-09-30' })
    expect(get).toHaveBeenCalledWith('r/c/2')
    expect(await trackingFor({ id: 'r/c/1' }, get)).toMatchObject({ status: 'generated' })
  })

  it('fails instead of skipping the question when the application cannot be read', async () => {
    await expect(trackingFor({ id: 'r/c/9' }, getter())).rejects.toThrow(/no longer exists/)
  })
})
