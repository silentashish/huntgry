import { describe, expect, it } from 'vitest'
import type { Job } from '@shared/jobs-types'
import { mergeJobs } from './merge'

const job = (id: string, extra: Partial<Job> = {}): Job =>
  ({ id, title: id, fetchedAt: '2030-01-01T00:00:00Z', postedAt: null, ...extra }) as Job

describe('mergeJobs', () => {
  it('replaces by id and sorts newest first', () => {
    const out = mergeJobs([job('a', { postedAt: '2030-01-01' })], [job('a', { title: 'A2', postedAt: '2030-01-01' }), job('b', { postedAt: '2030-02-01' })])
    expect(out.map((j) => [j.id, j.title])).toEqual([['b', 'b'], ['a', 'A2']])
  })

  it('shows a cross-board job once when its canonical id changes', () => {
    const before = [job('hiring.cafe:X', { aliases: ['indeed:Y'] })]
    const after = mergeJobs(before, [job('indeed:Y', { aliases: ['hiring.cafe:X'] })])
    expect(after.map((j) => j.id)).toEqual(['indeed:Y'])
    // And the reverse: a card that listed the incoming job as its alias goes too.
    expect(mergeJobs([job('indeed:Y', { aliases: ['hiring.cafe:X'] })], [job('hiring.cafe:X')]).map((j) => j.id)).toEqual(['hiring.cafe:X'])
  })
})
