import { describe, expect, it } from 'vitest'
import type { Job } from '@shared/jobs-types'
import type { EnqueueInput, EnqueueResult, QueueItem } from '@shared/queue-types'
import { requireTailorJobInput, tailorJob, type TailorJobDeps } from './tailor-job'

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  source: id.split(':')[0] as Job['source'],
  sourceId: id.split(':')[1],
  title: 'Engineer',
  company: 'Acme',
  location: '',
  remote: true,
  salary: '',
  postedAt: null,
  url: '',
  boardUrl: null,
  description: 'Build APIs.',
  descriptionComplete: true,
  tags: [],
  fetchedAt: '2026-10-24T00:00:00.000Z',
  ...over
})

function fakeDeps(saved: Job[] = []) {
  const jobs = new Map(saved.map((j) => [j.id, j]))
  const calls: { pasted: unknown[]; byUrl: string[]; enqueued: EnqueueInput[] } = { pasted: [], byUrl: [], enqueued: [] }
  const items: QueueItem[] = []
  const deps: TailorJobDeps = {
    workspace: async () => '/ws',
    findJob: async (_ws, id) => jobs.get(id) ?? [...jobs.values()].find((j) => j.aliases?.includes(id)) ?? null,
    addPasted: async (_ws, input) => {
      calls.pasted.push(input)
      const j = job('pasted:abc', { title: input.title ?? 'Pasted', company: input.company ?? '', description: input.text, url: input.url ?? '' })
      jobs.set(j.id, j)
      return j
    },
    addByUrl: async (_ws, url) => {
      calls.byUrl.push(url)
      const j = job('url:fetched', { url })
      jobs.set(j.id, j)
      return j
    },
    enqueue: async (input): Promise<EnqueueResult> => {
      calls.enqueued.push(input)
      const id = input.jobIds[0]
      const skipped = items.some((i) => i.jobId === id && i.status === 'queued') ? [{ jobId: id, reason: 'Already in the queue.' }] : []
      if (!skipped.length)
        items.push({ id: `q-${items.length}`, jobId: id, title: '', options: input.options, agent: input.agent ?? 'claude', status: 'queued', runId: null, attempts: 0, createdAt: '', updatedAt: '', unattended: true })
      return { state: { items: [...items], concurrency: 1, paused: false } as unknown as EnqueueResult['state'], added: skipped.length ? 0 : 1, skipped }
    },
    defaultAgent: async () => 'claude'
  }
  return { deps, calls, items }
}

const form = { coverLetter: true, dateStyle: 'right' as const }

describe('tailorJob (the Tailor page’s Start, #158)', () => {
  it('saves a pasted job and queues it unattended with the form’s options', async () => {
    const { deps, calls } = fakeDeps()
    const res = await tailorJob(deps, { ...form, jobDescription: 'A long pasted posting for a staff engineer role.', role: 'Staff Engineer', company: 'Acme', jobUrl: 'https://acme.example/1', notes: ' Lead with Go. ' })
    expect(calls.pasted).toEqual([{ title: 'Staff Engineer', company: 'Acme', url: 'https://acme.example/1', text: 'A long pasted posting for a staff engineer role.' }])
    expect(calls.enqueued).toEqual([
      { jobIds: ['pasted:abc'], options: { coverLetter: true, dateStyle: 'right', notes: 'Lead with Go.' }, agent: 'claude', unattended: true }
    ])
    expect(res).toMatchObject({ itemId: 'q-0', jobId: 'pasted:abc' })
  })

  it('queues a saved job as it is, by its canonical id', async () => {
    const { deps, calls } = fakeDeps([job('hiring.cafe:a', { aliases: ['indeed:a2'] })])
    const res = await tailorJob(deps, { ...form, savedJobId: 'indeed:a2', agent: 'codex', jobDescription: 'ignored' })
    expect(calls.pasted).toEqual([])
    expect(calls.enqueued[0]).toMatchObject({ jobIds: ['hiring.cafe:a'], agent: 'codex', unattended: true })
    expect(res.jobId).toBe('hiring.cafe:a')
    await expect(tailorJob(deps, { ...form, savedJobId: 'url:gone' })).rejects.toThrow(/no longer saved/)
  })

  it('saves a URL-only job from its posting page', async () => {
    const { deps, calls } = fakeDeps()
    await tailorJob(deps, { ...form, jobUrl: 'https://acme.example/2' })
    expect(calls.byUrl).toEqual(['https://acme.example/2'])
    expect(calls.enqueued[0].jobIds).toEqual(['url:fetched'])
  })

  it('follows the item already in the queue instead of starting the same job twice', async () => {
    const { deps, calls } = fakeDeps([job('url:a')])
    const first = await tailorJob(deps, { ...form, savedJobId: 'url:a' })
    const second = await tailorJob(deps, { ...form, savedJobId: 'url:a' })
    expect(calls.enqueued).toHaveLength(2)
    expect(second.itemId).toBe(first.itemId)
  })

  it('validates the form like a run start', () => {
    expect(() => requireTailorJobInput({ coverLetter: true })).toThrow(/job description/)
    expect(() => requireTailorJobInput({ jobUrl: 'file:///etc/passwd' })).toThrow(/http/)
    expect(() => requireTailorJobInput({ savedJobId: '../../etc' })).toThrow(/Invalid job id/)
    expect(requireTailorJobInput({ savedJobId: 'url:a', dateStyle: 'inline', jobDescription: 'x' })).toEqual({
      savedJobId: 'url:a',
      company: undefined,
      role: undefined,
      notes: undefined,
      coverLetter: false,
      dateStyle: 'inline'
    })
  })
})
