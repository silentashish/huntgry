import type { Job } from '@shared/jobs-types'
import { htmlToText } from '../text'

/**
 * Indeed. Its search page embeds the result cards as JSON
 * (`window.mosaic.providerData['mosaic-provider-jobcards']`), readable in a
 * hidden browser window. Job detail pages sit behind Cloudflare verification,
 * so a saved Indeed job keeps the card's snippet and links to the posting;
 * the full text can be pasted.
 */

export const INDEED_ORIGIN = 'https://www.indeed.com'

export function indeedSearchUrl(
  q: { keywords: string; location: string; remoteOnly: boolean },
  origin: string = INDEED_ORIGIN
): string {
  const params = new URLSearchParams({ q: q.keywords.trim() })
  if (q.remoteOnly) params.set('l', 'Remote')
  else if (q.location.trim()) params.set('l', q.location.trim())
  params.set('sort', 'date')
  return `${origin}/jobs?${params.toString()}`
}

export const INDEED_EXTRACT = `(() => {
  const m = window.mosaic && window.mosaic.providerData && window.mosaic.providerData['mosaic-provider-jobcards']
  const r = m && m.metaData && m.metaData.mosaicProviderJobCardsModel && m.metaData.mosaicProviderJobCardsModel.results
  return Array.isArray(r) ? JSON.stringify({ results: r, empty: r.length === 0 }) : null
})()`

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function parseIndeedCards(data: unknown, now = new Date(), origin: string = INDEED_ORIGIN): Job[] {
  const results = Array.isArray(obj(data).results) ? (obj(data).results as unknown[]) : []
  const jobs: Job[] = []
  for (const raw of results) {
    const r = obj(raw)
    const key = str(r.jobkey)
    const title = str(r.displayTitle) || str(r.title)
    if (!/^[0-9a-f]{8,32}$/i.test(key) || !title || r.expired === true) continue
    const url = `${origin}/viewjob?jk=${key}`
    const location = str(r.formattedLocation)
    jobs.push({
      id: `indeed:${key}`,
      source: 'indeed',
      sourceId: key,
      title,
      company: str(r.company),
      location,
      remote: r.remoteLocation === true || /remote/i.test(location),
      salary: str(obj(r.salarySnippet).text),
      postedAt: typeof r.pubDate === 'number' ? new Date(r.pubDate).toISOString() : null,
      url,
      boardUrl: null,
      description: htmlToText(str(r.snippet)),
      descriptionComplete: false,
      tags: Array.isArray(r.jobTypes)
        ? (r.jobTypes as unknown[]).filter((t): t is string => typeof t === 'string')
        : [],
      fetchedAt: now.toISOString()
    })
  }
  return jobs
}
