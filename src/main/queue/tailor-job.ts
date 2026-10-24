import { JOB_ID_PATTERN, type Job } from '@shared/jobs-types'
import {
  ACTIVE_STATUSES,
  type EnqueueInput,
  type EnqueueResult,
  type QueueAgent,
  type QueueOptions,
  type TailorJobInput,
  type TailorJobResult
} from '@shared/queue-types'
import { requireStartParams } from '../cli/command'

/**
 * The Tailor page's Start in the single flow (#158). A job typed or pasted on the Tailor page goes
 * the way of every other job: it becomes a saved job (so it shows in Jobs and is deduped like
 * one), then one unattended queue item, which runs to the end through the queue's slots and the
 * verify gate and lands in Review. Electron-free; `queue/ipc.ts` passes the app's functions in.
 */

export interface TailorJobDeps {
  workspace(): Promise<string>
  findJob(workspace: string, id: string): Promise<Job | null>
  addPasted(workspace: string, input: { title?: string; company?: string; url?: string; text: string }): Promise<Job>
  addByUrl(workspace: string, url: string): Promise<Job>
  enqueue(input: EnqueueInput, workspace: string): Promise<EnqueueResult>
  defaultAgent(): Promise<QueueAgent>
}

/** Shape check of the form (IPC input is untrusted): the run parameters' own rules, plus `savedJobId`. */
export function requireTailorJobInput(input: unknown): TailorJobInput {
  const p = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const saved = p.savedJobId
  if (saved !== undefined && saved !== null && (typeof saved !== 'string' || !JOB_ID_PATTERN.test(saved)))
    throw new Error('Invalid job id.')
  const savedJobId = typeof saved === 'string' ? saved : undefined
  // A saved job carries its own posting: the description / URL check applies to the others.
  const params = requireStartParams(savedJobId ? { jobDescription: 'saved', ...p } : p)
  return {
    ...(savedJobId ? { savedJobId } : {}),
    ...(savedJobId ? {} : { jobDescription: params.jobDescription, jobUrl: params.jobUrl }),
    company: params.company,
    role: params.role,
    notes: params.notes,
    coverLetter: params.coverLetter,
    dateStyle: params.dateStyle,
    ...(params.agent ? { agent: params.agent } : {})
  }
}

/** The saved job for the form: the one sent from Jobs, else the pasted text, else the posting at the URL. */
async function savedJob(deps: TailorJobDeps, ws: string, input: TailorJobInput): Promise<Job> {
  if (input.savedJobId) {
    const job = await deps.findJob(ws, input.savedJobId)
    if (!job) throw new Error('This job is no longer saved.')
    return job
  }
  const text = input.jobDescription?.trim()
  if (text) return deps.addPasted(ws, { title: input.role, company: input.company, url: input.jobUrl, text })
  if (input.jobUrl) return deps.addByUrl(ws, input.jobUrl)
  throw new Error('Paste a job description or enter the posting URL.')
}

export async function tailorJob(deps: TailorJobDeps, raw: unknown): Promise<TailorJobResult> {
  const input = requireTailorJobInput(raw)
  const ws = await deps.workspace()
  const saved = await savedJob(deps, ws, input)
  // The queue keys items by the canonical job (a posting seen on several boards is one job).
  const job = (await deps.findJob(ws, saved.id)) ?? saved
  const options: QueueOptions = { coverLetter: input.coverLetter, dateStyle: input.dateStyle }
  if (input.notes?.trim()) options.notes = input.notes.trim()
  const res = await deps.enqueue(
    { jobIds: [job.id], options, agent: input.agent ?? (await deps.defaultAgent()), unattended: true },
    ws
  )
  // Already queued (the same posting started twice): follow that item instead of a second run.
  const item = res.state.items.find((i) => i.jobId === job.id && ACTIVE_STATUSES.includes(i.status))
  if (!item) throw new Error(res.skipped[0]?.reason ?? 'The job could not be queued.')
  return { state: res.state, itemId: item.id, jobId: job.id }
}
