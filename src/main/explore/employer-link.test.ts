import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LoadResult } from '../jobs/loader'
import { fetchDetails } from '../jobs/service'
import { findCanonical, readJob, saveJob } from '../jobs/store'
import {
  accountOf,
  employerLink,
  JOBRIGHT_PAGE_EXTRACT,
  jobrightPageOf,
  resolveEmployerLink,
  resolveJobrightCopies,
  type LinkDeps
} from './employer-link'
import { JOBRIGHT_NEW_GRAD_README } from './parse'
import { addExplore, listExplore, toJob, type ExploreDeps } from './service'

const TODAY = new Date(2026, 9, 21, 9, 30)
const ID = '6ada8a3454bbabbab07175fc'
const PAGE = `https://jobright.ai/jobs/info/${ID}`
const EMPLOYER = 'https://www.citadel.com/careers/details/software-engineer-university-graduate-us/'

const README = `| Company | Job Title | Location | Work Model | Date Posted |
| ----- | --------- |  --------- | ---- | ------- |
| **[Citadel](https://www.citadel.com)** | **[Software Engineer – University Graduate (US)](${PAGE}?utm_source=1103)** | New York, NY, United States | On Site | Oct 21 |
`

const page = (pageProps: Record<string, unknown>) => ({ logined: null, applyLink: null, originalUrl: null, ...pageProps })

describe('Jobright page fields (#146)', () => {
  it('reads the extract result defensively', () => {
    expect(jobrightPageOf({ logined: true, applyLink: EMPLOYER, originalUrl: EMPLOYER })).toEqual({
      logined: true,
      applyLink: EMPLOYER,
      originalUrl: EMPLOYER
    })
    expect(jobrightPageOf({ logined: 'yes', applyLink: 42 })).toEqual({ logined: null, applyLink: null, originalUrl: null })
    expect(jobrightPageOf(null)).toEqual({ logined: null, applyLink: null, originalUrl: null })
  })

  it('takes applyLink, else originalUrl, and drops only utm_* parameters', () => {
    expect(employerLink(page({ applyLink: `${EMPLOYER}?utm_source=jobright&gh_jid=123` }))).toBe(`${EMPLOYER}?gh_jid=123`)
    expect(employerLink(page({ originalUrl: 'https://coforma.pinpointhq.com/en/postings/4b767d51' }))).toBe(
      'https://coforma.pinpointhq.com/en/postings/4b767d51'
    )
    // An unusable applyLink falls back to originalUrl.
    expect(employerLink(page({ applyLink: 'javascript:alert(1)', originalUrl: EMPLOYER }))).toBe(EMPLOYER)
  })

  it("refuses Jobright's own pages, other schemes and credentials", () => {
    for (const bad of [
      PAGE,
      'https://www.jobright.ai/jobs/info/x',
      'https://apply.jobright.ai/x',
      'ftp://example.com/job',
      'https://user:pass@example.com/job',
      'not a url',
      `https://example.com/${'a'.repeat(2100)}`
    ])
      expect(employerLink(page({ applyLink: bad }))).toBeNull()
    // The e2e mock's Jobright host counts as Jobright's.
    expect(employerLink(page({ applyLink: 'http://127.0.0.1:4000/postings/x' }), ['127.0.0.1:4000'])).toBeNull()
    expect(employerLink(page({ applyLink: 'http://127.0.0.1:4001/postings/x' }), ['127.0.0.1:4000'])).toBe(
      'http://127.0.0.1:4001/postings/x'
    )
  })

  it('reads the account state from the app settings', () => {
    expect(accountOf({})).toEqual({ connected: null, checkedAt: null })
    expect(accountOf({ jobright: { connected: true, checkedAt: '2026-10-22T10:00:00.000Z' } })).toEqual({
      connected: true,
      checkedAt: '2026-10-22T10:00:00.000Z'
    })
  })

  it('evaluates in a page: signed in, signed out, and a page without Next.js data', () => {
    const run = (html: string | null, readyState = 'complete') => {
      const doc = {
        readyState,
        getElementById: (id: string) => (id === '__NEXT_DATA__' && html !== null ? { textContent: html } : null)
      }
      return new Function('document', `return ${JOBRIGHT_PAGE_EXTRACT}`)(doc) as string | null
    }
    const next = (pageProps: unknown) => JSON.stringify({ props: { pageProps } })
    expect(JSON.parse(run(next({ logined: true, dataSource: { jobResult: { applyLink: EMPLOYER, originalUrl: EMPLOYER } } }))!)).toEqual({
      logined: true,
      applyLink: EMPLOYER,
      originalUrl: EMPLOYER
    })
    expect(JSON.parse(run(next({ logined: false, dataSource: { jobResult: { isCompanySiteLink: true } } }))!)).toEqual({
      logined: false,
      applyLink: null,
      originalUrl: null
    })
    expect(JSON.parse(run(null)!)).toEqual({ logined: null, applyLink: null, originalUrl: null })
    expect(run(null, 'loading')).toBeNull()
    expect(JSON.parse(run('{not json')!)).toEqual({ logined: null, applyLink: null, originalUrl: null })
  })
})

describe('resolving the employer link (#146)', () => {
  let ws: string
  let loads: string[]
  let logins: boolean[]
  let answer: (url: string) => LoadResult
  const link = (over: Partial<LinkDeps> = {}): LinkDeps => ({
    load: async (url) => {
      loads.push(url)
      return answer(url)
    },
    hosts: ['jobright.ai', 'www.jobright.ai'],
    refusal: async () => null,
    onLogin: async (l) => void logins.push(l),
    ...over
  })
  const explore = (connected: boolean): ExploreDeps => ({
    sourceUrl: JOBRIGHT_NEW_GRAD_README,
    hosts: ['jobright.ai', 'www.jobright.ai'],
    fetchText: async () => README,
    refusal: async () => null,
    now: () => TODAY,
    link: { ...link(), connected: async () => connected }
  })
  const signedIn = (): LoadResult => ({ status: 'ok', data: { logined: true, applyLink: EMPLOYER, originalUrl: EMPLOYER } })

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'huntgry-employer-link-'))
    loads = []
    logins = []
    answer = signedIn
  })
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true })
  })

  it('adds a job with the employer link while connected; the Jobright page stays the board link', async () => {
    await listExplore(ws, explore(true))
    const job = await addExplore(ws, ID, explore(true))
    expect(job).toMatchObject({ id: `jobright:${ID}`, source: 'jobright', url: EMPLOYER, boardUrl: PAGE })
    expect(loads).toEqual([PAGE])
    expect(logins).toEqual([true])
    // Idempotent: a second add loads nothing and changes nothing.
    expect(await addExplore(ws, ID, explore(true))).toMatchObject({ url: EMPLOYER })
    expect(loads).toHaveLength(1)
  })

  it('loads nothing when not connected, and keeps the Jobright link', async () => {
    await listExplore(ws, explore(false))
    const job = await addExplore(ws, ID, explore(false))
    expect(job).toMatchObject({ url: PAGE, boardUrl: PAGE })
    expect(loads).toEqual([])
  })

  it('keeps the Jobright link when signed out, when the page has no link, or when loading fails', async () => {
    await listExplore(ws, explore(true))
    answer = () => ({ status: 'ok', data: { logined: false, applyLink: null, originalUrl: null } })
    expect((await addExplore(ws, ID, explore(true))).url).toBe(PAGE)
    // A signed-out page marks the account as not connected.
    expect(logins).toEqual([false])

    const saved = `jobright:${ID}`
    answer = () => ({ status: 'ok', data: { logined: true, applyLink: null, originalUrl: null } })
    expect((await resolveEmployerLink(ws, saved, link())).outcome).toBe('no-link')
    answer = () => ({ status: 'blocked', message: 'jobright.ai asked for a human check.' })
    expect((await resolveEmployerLink(ws, saved, link())).outcome).toBe('failed')
    answer = () => {
      throw new Error('window crashed')
    }
    expect((await resolveEmployerLink(ws, saved, link())).outcome).toBe('failed')
    answer = signedIn
    expect((await resolveEmployerLink(ws, saved, link({ refusal: async () => 'Refusing to load' }))).outcome).toBe('failed')
    expect((await readJob(ws, saved))?.url).toBe(PAGE)
  })

  it('resolves once: a job whose link is already the employer\'s, or not a Jobright job, is skipped', async () => {
    await listExplore(ws, explore(false))
    await addExplore(ws, ID, explore(false))
    expect((await resolveEmployerLink(ws, `jobright:${ID}`, link())).outcome).toBe('resolved')
    expect((await resolveEmployerLink(ws, `jobright:${ID}`, link())).outcome).toBe('skipped')
    expect(loads).toHaveLength(1)
    expect((await resolveEmployerLink(ws, 'url:abc', link())).outcome).toBe('skipped')
  })

  it('fetches the full description from the employer page once the link is resolved', async () => {
    await listExplore(ws, explore(false))
    const row = toJob(
      { id: ID, company: 'Citadel', companyUrl: null, title: 'Software Engineer – University Graduate (US)', url: PAGE, location: 'New York, NY', workModel: 'On Site', postedAt: '2026-10-21' },
      TODAY
    )
    await saveJob(ws, row)
    expect(await resolveJobrightCopies(ws, row.id, link())).toBe(true)
    const pages: string[] = []
    const full = await fetchDetails(ws, row.id, async (url) => {
      pages.push(url)
      return {
        status: 'ok',
        data: {
          url,
          title: 'Software Engineer',
          text: '',
          ld: [
            JSON.stringify({
              '@type': 'JobPosting',
              title: 'Software Engineer – University Graduate (US)',
              hiringOrganization: { name: 'Citadel' },
              description: `<p>${'Build trading tools and research platforms. '.repeat(10)}</p>`
            })
          ]
        }
      }
    })
    expect(pages).toEqual([EMPLOYER])
    expect(full).toMatchObject({ url: EMPLOYER, boardUrl: PAGE, descriptionComplete: true })
    expect((await findCanonical(ws, row.id))?.description).toContain('Build trading tools')
  })

  it("a human check on the employer's page is not reported as Jobright's", async () => {
    await listExplore(ws, explore(true))
    await addExplore(ws, ID, explore(true))
    await expect(
      fetchDetails(ws, `jobright:${ID}`, async () => ({ status: 'blocked', message: 'www.citadel.com asked for a human check.' }))
    ).rejects.toThrow(/www\.citadel\.com asked for a human check/)
  })
})
