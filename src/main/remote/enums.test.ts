import { describe, expect, it } from 'vitest'
import { MAX_CONCURRENCY, MAX_ENQUEUE } from '@shared/queue-types'
import { AGENT_IDS, type DateStyle } from '@shared/runner-types'
import { REMOTE_AGENT_IDS, REMOTE_DATE_STYLES, REMOTE_MAX_CONCURRENCY, REMOTE_MAX_JOBS, type RemoteAgentId, type RemoteDateStyle } from '@shared/remote'

/**
 * The protocol package owns copies of the enums the phone may send (ADR-0001, "Package
 * boundary"). They must equal the desktop's, so a new agent id or date style cannot be added
 * on one side only.
 */
describe('remote enums equal the desktop enums', () => {
  it('REMOTE_AGENT_IDS = AGENT_IDS', () => {
    expect([...REMOTE_AGENT_IDS]).toEqual([...AGENT_IDS])
  })

  it('REMOTE_DATE_STYLES = DateStyle', () => {
    // Type-level: both directions assignable, so the union and the tuple cannot drift.
    const toDesktop: DateStyle[] = [...REMOTE_DATE_STYLES]
    const toRemote: RemoteDateStyle[] = ['inline', 'right'] satisfies DateStyle[]
    expect(toDesktop).toEqual(toRemote)
    expect(REMOTE_DATE_STYLES).toEqual(['inline', 'right'])
    const agent: RemoteAgentId = AGENT_IDS[0]
    expect(REMOTE_AGENT_IDS).toContain(agent)
  })

  it('REMOTE_MAX_CONCURRENCY = MAX_CONCURRENCY and REMOTE_MAX_JOBS = MAX_ENQUEUE', () => {
    expect(REMOTE_MAX_CONCURRENCY).toBe(MAX_CONCURRENCY)
    expect(REMOTE_MAX_JOBS).toBe(MAX_ENQUEUE)
  })
})
