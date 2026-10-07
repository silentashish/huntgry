import { canFetchDetails, type Job } from '@shared/jobs-types'
import { api } from '../../api'

/**
 * Readies a job for the Tailor form, so the run never has to read a job board URL (boards block
 * plain HTTP): a summary is first swapped for the employer's full posting when one can be fetched,
 * then the job is marked tailored. Every saved change is passed to `onSaved`; returns the job to prefill from.
 */
export async function prepareTailor(job: Job, onSaved: (job: Job) => void): Promise<Job> {
  let current = job
  if (canFetchDetails(job)) {
    try {
      current = await api.jobs.fetchDetails(job.id)
      onSaved(current)
    } catch {
      // Hand off the summary; the Tailor form says it is one.
    }
  }
  try {
    current = await api.jobs.update(job.id, { tailored: true })
    onSaved(current)
  } catch {
    // Marking is a convenience; tailoring still works.
  }
  return current
}
