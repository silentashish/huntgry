import { describe, expect, it } from 'vitest'
import type { ExploreJob } from '@shared/explore-types'
import type { Job } from '@shared/jobs-types'
import { toJob } from '../explore/service'
import { exploreCandidates } from './sources'

const row = (n: number): ExploreJob => ({
  id: `e2e${String(n).padStart(21, '0')}`,
  company: `Co ${n}`,
  companyUrl: null,
  title: 'Backend Engineer',
  url: `https://jobright.ai/jobs/info/e2e${String(n).padStart(21, '0')}`,
  location: 'Remote',
  workModel: 'Remote',
  postedAt: '2026-10-24'
})

describe('exploreCandidates', () => {
  it('reads the saved jobs once for a large cache and joins rows to them by id and alias', async () => {
    const rows = Array.from({ length: 800 }, (_, i) => row(i))
    let reads = 0
    const savedByAlias: Job = { ...toJob(rows[2], new Date()), id: 'url:merged', aliases: [`jobright:${rows[2].id}`], description: 'Go and AWS.' }
    const source = exploreCandidates({
      rows: async () => rows,
      toJob,
      savedJobs: async () => {
        reads++
        return [{ ...toJob(rows[1], new Date()), description: 'Python.' }, savedByAlias]
      },
      add: async () => {
        throw new Error('not here')
      }
    })
    const inputs = await source.list('/ws')
    expect(reads).toBe(1)
    expect(inputs).toHaveLength(800)
    expect(inputs[0]).toMatchObject({ key: `explore:${rows[0].id}`, scoreable: false })
    expect(inputs[1]).toMatchObject({ key: `jobright:${rows[1].id}`, savedJobId: `jobright:${rows[1].id}`, scoreable: true })
    expect(inputs[2]).toMatchObject({ key: 'url:merged', savedJobId: 'url:merged', scoreable: true })
  })
})
