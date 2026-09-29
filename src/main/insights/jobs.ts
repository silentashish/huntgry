import { jobDescriptionFor, type Job } from '@shared/jobs-types'
import type { SourcedJobText } from '@shared/profile-insights'
import { scanApplications } from '../applications/scan'
import { readJobDescriptions } from '../graph/jobs'
import { listJobs } from '../jobs/store'

/** URL identity for dedupe: scheme and host case, trailing slash, fragment and tracking parameters ignored. */
export function sameJobUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|gh_src|ref$|source$)/i.test(k)) u.searchParams.delete(k)
    return `${u.host.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`
  } catch {
    return url.trim()
  }
}

/** A saved job as gap-analysis text: title, company, description and board tags. */
function savedJobText(job: Job): SourcedJobText {
  return {
    id: job.id,
    title: [job.title, job.company].filter(Boolean).join(' · '),
    text: [jobDescriptionFor(job), job.tags.join(', ')].filter(Boolean).join('\n\n'),
    kind: 'saved'
  }
}

/**
 * Every job description the gap insights look at: the applications' own
 * `job-description.md`, plus saved jobs that were not dismissed and have no
 * application yet (same posting URL), so a tailored job is counted once.
 */
export async function collectJobTexts(
  workspace: string,
  read = {
    applications: readJobDescriptions,
    urls: async (ws: string) => (await scanApplications(ws)).applications.map((a) => a.jobUrl),
    saved: listJobs
  }
): Promise<SourcedJobText[]> {
  const [apps, appUrls, saved] = await Promise.all([
    read.applications(workspace).catch(() => []),
    read.urls(workspace).catch(() => [] as (string | null)[]),
    read.saved(workspace).catch(() => [] as Job[])
  ])
  const applied = new Set(appUrls.filter((u): u is string => !!u).map(sameJobUrl))
  return [
    ...apps.map((j) => ({ ...j, kind: 'application' as const })),
    ...saved.filter((j) => !j.dismissed && !(j.url && applied.has(sameJobUrl(j.url)))).map(savedJobText)
  ]
}
