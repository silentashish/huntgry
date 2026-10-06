import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Job } from '../../src/shared/jobs-types'
import type { PipelineRecord } from '../../src/shared/pipeline-types'
import type { QueueItem, QueueOptions } from '../../src/shared/queue-types'
import type { AgentId } from '../../src/shared/runner-types'

/**
 * Saved jobs and the bulk tailoring queue, written straight into a seeded
 * workspace before launch: what the Jobs page's "Tailor all" leaves behind
 * (`.huntgry/jobs/<id>.json`, `.huntgry/queue.json`). The Jobs UI itself is
 * covered by #49; the queue specs start from its output.
 */

/** A saved job with a full pasted description; `over` sets the rest. */
export function savedJob(over: Partial<Job> & Pick<Job, 'id' | 'title' | 'company'>): Job {
  const sourceId = over.id.split(':').slice(1).join(':')
  return {
    source: 'pasted',
    sourceId,
    location: 'Remote',
    remote: true,
    salary: '',
    postedAt: '2026-09-25',
    url: `https://jobs.example.com/${sourceId}`,
    boardUrl: null,
    description: `${over.company} is hiring a ${over.title}. Requirements: TypeScript, Go, five years of experience.`,
    descriptionComplete: true,
    tags: [],
    fetchedAt: '2026-09-26T10:00:00.000Z',
    ...over
  }
}

/** An Indeed job that has only the board's snippet: the queue cannot fetch its posting (no network, human check). */
export function boardOnlyJob(over: Partial<Job> & Pick<Job, 'id' | 'title' | 'company'>): Job {
  return savedJob({
    source: 'indeed',
    url: 'https://www.indeed.com/viewjob?jk=e2e',
    description: 'Short snippet from the board.',
    descriptionComplete: false,
    ...over
  })
}

/** Same naming rule as src/main/jobs/store.ts (`jobFileName`). */
const jobFileName = (id: string): string => `${id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '').slice(0, 180)}.json`

export async function seedJobs(workspace: string, jobs: Job[]): Promise<void> {
  const dir = join(workspace, '.huntgry/jobs')
  await mkdir(dir, { recursive: true })
  for (const job of jobs) await writeFile(join(dir, jobFileName(job.id)), `${JSON.stringify(job, null, 2)}\n`)
}

export interface SeedQueueItem {
  job: Job
  agent?: AgentId
  status?: QueueItem['status']
  /** For an interrupted item (`running` when the app closed). */
  runId?: string | null
  options?: Partial<QueueOptions>
  /** An unattended pipeline item (#31): its pipeline, and for a `done` one the recorded result. */
  unattended?: true
  pipelineId?: string
  outcome?: QueueItem['outcome']
  applicationId?: string
}

const DEFAULT_OPTIONS: QueueOptions = { coverLetter: false, dateStyle: 'right' }

/** Writes `.huntgry/queue.json` as the queue saves it (with the pipeline's record, if any); the app loads it paused. */
export async function seedQueue(workspace: string, items: SeedQueueItem[], concurrency = 2, pipeline?: PipelineRecord): Promise<QueueItem[]> {
  const at = '2026-09-30T12:00:00.000Z'
  const out: QueueItem[] = items.map((i, n) => ({
    id: `q-20260930-120000-${String(n).padStart(6, '0')}`,
    jobId: i.job.id,
    title: [i.job.title, i.job.company].filter(Boolean).join(' · '),
    options: { ...DEFAULT_OPTIONS, ...i.options },
    agent: i.agent ?? 'claude',
    status: i.status ?? 'queued',
    runId: i.runId ?? null,
    attempts: 0,
    createdAt: at,
    updatedAt: at,
    ...(i.unattended ? { unattended: true as const } : {}),
    ...(i.pipelineId ? { pipelineId: i.pipelineId } : {}),
    ...(i.outcome ? { outcome: i.outcome } : {}),
    ...(i.applicationId ? { applicationId: i.applicationId } : {})
  }))
  await mkdir(join(workspace, '.huntgry'), { recursive: true })
  const file = { version: 1, concurrency, items: out, ...(pipeline ? { pipeline } : {}) }
  await writeFile(join(workspace, '.huntgry/queue.json'), `${JSON.stringify(file, null, 2)}\n`)
  return out
}

export async function readQueue(workspace: string): Promise<{ concurrency: number; items: QueueItem[] }> {
  return JSON.parse(await readFile(join(workspace, '.huntgry/queue.json'), 'utf8'))
}
