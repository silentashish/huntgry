import { createHash } from 'node:crypto'
import type { Job, JobSourceId } from '@shared/jobs-types'
import { htmlToText } from '../text'

/**
 * Any job posting page: schema.org `JobPosting` JSON-LD first (most ATSs and
 * boards publish it for Google Jobs), otherwise the page's readable text.
 */

/** Runs in the page: JSON-LD blocks, the title and the main text. */
export const POSTING_EXTRACT = `(() => {
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent || '')
  const main = document.querySelector('main, article, [role=main]') || document.body
  return JSON.stringify({ ld, title: document.title, text: main ? main.innerText.slice(0, 60000) : '', url: location.href })
})()`

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** The first JobPosting in a list of JSON-LD strings (handles arrays and `@graph`). */
export function findJobPosting(ldBlocks: readonly string[]): Obj | null {
  for (const block of ldBlocks) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block)
    } catch {
      continue
    }
    const stack: unknown[] = [parsed]
    while (stack.length > 0) {
      const item = stack.shift()
      if (Array.isArray(item)) stack.push(...item)
      else if (typeof item === 'object' && item !== null) {
        const o = item as Obj
        const type = o['@type']
        if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return o
        if (Array.isArray(o['@graph'])) stack.push(...o['@graph'])
      }
    }
  }
  return null
}

function locationOf(p: Obj): { location: string; remote: boolean } {
  const locs = Array.isArray(p.jobLocation) ? p.jobLocation : p.jobLocation ? [p.jobLocation] : []
  const parts = locs.map((l) => {
    const a = obj(obj(l).address)
    return [str(a.addressLocality), str(a.addressRegion), str(a.addressCountry) || str(obj(a.addressCountry).name)]
      .filter(Boolean)
      .join(', ')
  })
  const remote = str(p.jobLocationType).toUpperCase() === 'TELECOMMUTE'
  return { location: parts.filter(Boolean).join(' / ') || (remote ? 'Remote' : ''), remote }
}

function salaryOf(p: Obj): string {
  const b = obj(p.baseSalary)
  const v = obj(b.value)
  const cur = str(b.currency) || 'USD'
  const unit = str(v.unitText).toLowerCase()
  const fmt = (n: unknown) =>
    typeof n === 'number'
      ? cur === 'USD'
        ? `$${n.toLocaleString('en-US')}`
        : `${n.toLocaleString('en-US')} ${cur}`
      : ''
  const range = [fmt(v.minValue), fmt(v.maxValue)].filter(Boolean).join(' – ') || fmt(v.value)
  return range ? `${range}${unit ? ` / ${unit}` : ''}` : ''
}

/** Stable id for a URL-based job: a hash of the URL without its query noise. */
export function urlJobId(url: string): string {
  let key = url
  try {
    const u = new URL(url)
    for (const p of [...u.searchParams.keys()])
      if (/^(utm_|ref|source|src|gh_src|trk|tk)$|^utm_/i.test(p)) u.searchParams.delete(p)
    u.hash = ''
    key = u.toString()
  } catch {
    // keep as is
  }
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** ISO string for a parseable date, else `null` (some pages publish "Posted 3 days ago"). */
export function isoDate(value: string): string | null {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

export interface PageData {
  ld: string[]
  title: string
  text: string
  url: string
}

/** Builds a job from an extracted page. `null` when the page has no usable content. */
export function parsePosting(page: PageData, source: JobSourceId = 'url', now = new Date()): Job | null {
  const posting = findJobPosting(page.ld)
  const url = page.url
  if (posting) {
    const { location, remote } = locationOf(posting)
    const description = htmlToText(str(posting.description))
    const title = str(posting.title) || page.title
    if (!title) return null
    return {
      id: `${source}:${urlJobId(url)}`,
      source,
      sourceId: urlJobId(url),
      title,
      company: str(obj(posting.hiringOrganization).name),
      location,
      remote,
      salary: salaryOf(posting),
      postedAt: isoDate(str(posting.datePosted)),
      url,
      boardUrl: null,
      description,
      descriptionComplete: description.length > 200,
      tags: [],
      fetchedAt: now.toISOString()
    }
  }
  const text = page.text.replace(/\n{3,}/g, '\n\n').trim()
  if (text.length < 200) return null
  const title = page.title.split(/\s[|–—-]\s/)[0].trim() || 'Job posting'
  return {
    id: `${source}:${urlJobId(url)}`,
    source,
    sourceId: urlJobId(url),
    title,
    company: '',
    location: '',
    remote: /\bremote\b/i.test(text.slice(0, 2000)),
    salary: '',
    postedAt: null,
    url,
    boardUrl: null,
    description: text,
    descriptionComplete: true,
    tags: [],
    fetchedAt: now.toISOString()
  }
}
