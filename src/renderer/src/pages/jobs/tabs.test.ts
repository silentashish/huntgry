import { describe, expect, it } from 'vitest'
import { jobsTab, savedCount } from './tabs'

describe('jobsTab (#189: the tab the Jobs page opens on)', () => {
  it('opens Saved when a saved job is to be opened, whatever tab was asked for', () => {
    expect(jobsTab({ openId: 'jobright:a1' }, 0)).toBe('saved')
    expect(jobsTab({ openId: 'jobright:a1', tab: 'discover' }, 3)).toBe('saved')
    expect(jobsTab({ openId: 'jobright:a1' }, null)).toBe('saved')
  })

  it('opens the tab asked for, even before the saved jobs are read', () => {
    expect(jobsTab({ tab: 'discover' }, 5)).toBe('discover')
    expect(jobsTab({ tab: 'saved' }, 0)).toBe('saved')
    expect(jobsTab({ tab: 'discover' }, null)).toBe('discover')
  })

  it('defaults to Saved when there are saved jobs and to Discover when there are none', () => {
    expect(jobsTab(undefined, 2)).toBe('saved')
    expect(jobsTab({ reload: 1 }, 1)).toBe('saved')
    expect(jobsTab(undefined, 0)).toBe('discover')
  })

  it('waits for the saved jobs when nothing was asked for', () => {
    expect(jobsTab(undefined, null)).toBeNull()
    expect(jobsTab({ reload: 1 }, null)).toBeNull()
  })
})

describe('savedCount', () => {
  it('counts the saved jobs still in play, not the dismissed ones', () => {
    expect(savedCount([{}, { dismissed: false }, { dismissed: true }])).toBe(2)
    expect(savedCount([])).toBe(0)
  })
})
