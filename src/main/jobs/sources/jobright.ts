/**
 * Jobright's summary of a posting (#148). A Jobright posting page (`/jobs/info/<id>`) has no JSON-LD
 * `JobPosting`, but its `__NEXT_DATA__` → `props.pageProps.dataSource.jobResult` carries Jobright's own
 * reading of the posting: `jobSummary`, `coreResponsibilities[]` and `qualifications.mustHave[]` /
 * `niceToHave[]`, signed in or not. It is the description of last resort when the employer's page is
 * only an application form.
 */

import { POSTING_EXTRACT } from './posting'

/**
 * Loader expression: everything `POSTING_EXTRACT` reads, plus `jobright` with the summary fields (`null` on a
 * page without `__NEXT_DATA__`). One load serves both readings when the job's link is still the Jobright page.
 * `null` while the page is still loading and the Next.js data is not there yet.
 */
export const JOBRIGHT_POSTING_EXTRACT = `(() => {
  const el = document.getElementById('__NEXT_DATA__')
  if (!el && document.readyState !== 'complete') return null
  const posting = JSON.parse(${POSTING_EXTRACT})
  let jobright = null
  try {
    const job = ((((JSON.parse((el && el.textContent) || '{}').props || {}).pageProps || {}).dataSource || {}).jobResult) || {}
    const q = job.qualifications || {}
    jobright = { jobSummary: job.jobSummary, coreResponsibilities: job.coreResponsibilities, mustHave: q.mustHave, niceToHave: q.niceToHave }
  } catch {
    jobright = null
  }
  return JSON.stringify({ ...posting, jobright })
})()`

const MAX_TEXT = 8000
const MAX_ITEMS = 40

const text = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '')
const items = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .map(text)
        .filter(Boolean)
        .slice(0, MAX_ITEMS)
    : []

/**
 * The summary as Markdown: the summary paragraph, then Responsibilities, Must have and Nice to have as lists.
 * Empty when the page gave none of them. Shape-checked: it comes from a web page.
 */
export function jobrightSummaryOf(data: unknown): string {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
  const j = (typeof d.jobright === 'object' && d.jobright !== null ? d.jobright : {}) as Record<string, unknown>
  const parts: string[] = []
  const summary = text(j.jobSummary)
  if (summary) parts.push(summary)
  for (const [heading, list] of [
    ['Responsibilities', items(j.coreResponsibilities)],
    ['Must have', items(j.mustHave)],
    ['Nice to have', items(j.niceToHave)]
  ] as const) {
    if (list.length > 0) parts.push(`## ${heading}\n\n${list.map((l) => `- ${l}`).join('\n')}`)
  }
  return parts.join('\n\n')
}
