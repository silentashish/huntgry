import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_EXPLORE_CATEGORY as CAT, EXPLORE_MAX_ROWS } from '@shared/explore-types'
import { apiRow, fetchApiList, JOBRIGHT_API_URL, PAGE_SIZE, pageUrl, parseApiPage } from './api'
import { JOBRIGHT_NEW_GRAD_README } from './parse'
import { addExplore, cachePath, listExplore, readCache, refreshExplore, type ExploreDeps } from './service'
import { scoreRow } from '@shared/explore-score'
import { profileSignals, scoreJob } from '@shared/job-relevance'
import { emptyProfile } from '@shared/master-profile'

const NOW = new Date(2026, 9, 24, 10, 0)
const AT = new Date(2026, 9, 23, 18, 30).getTime()

const id = (n: number) => `6a${String(n).padStart(22, '0')}`

/** One `jobList` entry in the API's shape (#169). */
const entry = (n: number, props: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  jobId: id(n),
  tabCategory: [CAT],
  postedAt: AT,
  properties: {
    title: `Software Engineer ${n}`,
    company: 'Notion',
    location: 'San Francisco, CA; New York, NY',
    salary: '$150000-$168000/yr',
    workModel: 'Hybrid',
    industry: ['SaaS', 'Software'],
    companySize: '501-1000',
    qualifications: "1. You've shipped Android apps.\n2. Kotlin, Jetpack Compose.\n...",
    expLevel: null,
    jobFunction: null,
    h1bSponsored: 'Not Sure',
    isNewGrad: false,
    roleType: null,
    ...props
  },
  ...over
})

const answer = (jobList: unknown[], total = jobList.length) => ({ success: true, errorCode: 10000, errorMsg: null, result: { total, jobList } })

describe('newgrad-jobs API rows', () => {
  it('maps an entry to a listed job with the API fields', () => {
    expect(apiRow(entry(1), { now: NOW })).toEqual({
      id: id(1),
      company: 'Notion',
      companyUrl: null,
      title: 'Software Engineer 1',
      url: `https://jobright.ai/jobs/info/${id(1)}`,
      location: 'San Francisco, CA; New York, NY',
      workModel: 'Hybrid',
      postedAt: '2026-10-23',
      salary: '$150000-$168000/yr',
      qualifications: "1. You've shipped Android apps.\n2. Kotlin, Jetpack Compose.\n...",
      h1b: 'Not Sure',
      industry: ['SaaS', 'Software'],
      companySize: '501-1000'
    })
  })

  it('skips malformed entries', () => {
    const bad = [
      null,
      'x',
      { ...entry(1), jobId: '../../etc/passwd' },
      { ...entry(1), jobId: 42 },
      entry(1, {}, { properties: null }),
      entry(1, { title: '' }),
      entry(1, { title: 7 }),
      entry(1, { company: undefined }),
      entry(1, {}, { postedAt: '2026-10-23' }),
      entry(1, {}, { postedAt: Number.NaN }),
      entry(1, {}, { postedAt: Date.UTC(2019, 0, 1) }),
      entry(1, {}, { postedAt: NOW.getTime() + 3 * 86_400_000 })
    ]
    for (const b of bad) expect(apiRow(b, { now: NOW })).toBeNull()
  })

  it('drops or cleans bad fields but keeps the row', () => {
    const row = apiRow(
      entry(1, {
        title: '  <b>Software</b>\tEngineer  ',
        location: { city: 'x' },
        salary: 150000,
        workModel: 'Flexible',
        h1bSponsored: 'Maybe',
        industry: ['SaaS', 3, '', 'SaaS', 'x'.repeat(100)],
        companySize: ['10000+'],
        qualifications: `1. ${'a'.repeat(5000)}\r\n2. b`,
        expLevel: 'Entry Level'
      }),
      { now: NOW }
    )!
    expect(row).toMatchObject({ title: 'Software Engineer', location: '', workModel: null, expLevel: 'Entry Level' })
    expect(row.industry).toEqual(['SaaS', 'x'.repeat(60)])
    expect(row.qualifications).toHaveLength(4000)
    for (const k of ['salary', 'h1b', 'companySize'] as const) expect(row[k]).toBeUndefined()
  })

  it('links the e2e mock origin only when its host is allowed', () => {
    const mock = { origin: 'http://127.0.0.1:5000', hosts: ['jobright.ai', '127.0.0.1:5000'], now: NOW }
    expect(apiRow(entry(1), mock)?.url).toBe(`http://127.0.0.1:5000/jobs/info/${id(1)}`)
    expect(apiRow(entry(1), { ...mock, hosts: ['jobright.ai'] })).toBeNull()
  })

  it('reads a page, and refuses answers that are not a successful list', () => {
    expect(parseApiPage(answer([entry(1), { jobId: 'bad' }], 2116), { now: NOW })).toMatchObject({ total: 2116, received: 2, jobs: [{ id: id(1) }] })
    expect(() => parseApiPage({ success: false, errorCode: 40001, result: null })).toThrow('The newgrad-jobs API refused the request (error 40001).')
    expect(() => parseApiPage(null)).toThrow(/refused the request\.$/)
    expect(() => parseApiPage({ success: 'true', result: { jobList: [] } })).toThrow(/refused/)
    expect(() => parseApiPage({ success: true, result: { jobList: {} } })).toThrow(/shape Huntgry does not know/)
    expect(parseApiPage({ success: true, result: { jobList: [], total: -1 } }).total).toBeNull()
  })
})

describe('newgrad-jobs API paging', () => {
  let calls: { url: string; body: unknown }[]
  /** The category as the API serves it: `size` rows, newest first, paged by `position` / `count`. */
  const serve = (size: number) => async (url: string, body: unknown) => {
    calls.push({ url, body })
    const u = new URL(url)
    const position = Number(u.searchParams.get('position'))
    const count = Number(u.searchParams.get('count'))
    const rows = Array.from({ length: Math.max(0, Math.min(count, size - position)) }, (_, i) => entry(position + i))
    return answer(rows, size)
  }
  const deps = (postJson: (url: string, body: unknown) => Promise<unknown>) => ({ apiUrl: JOBRIGHT_API_URL, postJson, refusal: async () => null, now: NOW })

  beforeEach(() => {
    calls = []
  })

  it('pages 500 at a time and stops at the cap of 1,000 rows', async () => {
    const { jobs, total } = await fetchApiList(CAT, deps(serve(2175)))
    expect(PAGE_SIZE).toBe(500)
    expect(EXPLORE_MAX_ROWS).toBe(1000)
    expect(jobs).toHaveLength(1000)
    expect(total).toBe(2175)
    expect(calls).toEqual([
      { url: pageUrl(JOBRIGHT_API_URL, 0, 500), body: { category: CAT } },
      { url: pageUrl(JOBRIGHT_API_URL, 500, 500), body: { category: CAT } }
    ])
    expect(calls[0].url).toBe('https://jobright.ai/swan/mini-sites/list?position=0&count=500')
  })

  it('stops at the total, or at a short page', async () => {
    expect((await fetchApiList(CAT, deps(serve(320)))).jobs).toHaveLength(320)
    expect(calls).toHaveLength(1)
    calls = []
    expect((await fetchApiList(CAT, { ...deps(serve(70)), pageSize: 30, maxRows: 1000 })).jobs).toHaveLength(70)
    expect(calls.map((c) => new URL(c.url).searchParams.get('position'))).toEqual(['0', '30', '60'])
  })

  it('honours a smaller cap, and drops repeated ids across pages', async () => {
    const repeat = async (url: string, body: unknown) => {
      calls.push({ url, body })
      return answer([entry(1), entry(2)], 10)
    }
    expect((await fetchApiList(CAT, { ...deps(repeat), pageSize: 2, maxRows: 6 })).jobs.map((j) => j.id)).toEqual([id(1), id(2)])
    expect(calls).toHaveLength(3)
    calls = []
    expect((await fetchApiList(CAT, { ...deps(serve(50)), pageSize: 20, maxRows: 25 })).jobs).toHaveLength(25)
    expect(calls.map((c) => new URL(c.url).searchParams.get('count'))).toEqual(['20', '5'])
  })

  it('keeps the rows read when a later page fails; a failed first page or no row throws', async () => {
    const flaky = async (url: string, body: unknown) => {
      if (new URL(url).searchParams.get('position') !== '0') throw new Error('The newgrad-jobs API answered HTTP 502 for the Jobright jobs.')
      return serve(2000)(url, body)
    }
    expect((await fetchApiList(CAT, deps(flaky))).jobs).toHaveLength(500)
    await expect(fetchApiList(CAT, deps(async () => ({ success: false })))).rejects.toThrow(/refused/)
    await expect(fetchApiList(CAT, deps(async () => answer([{ jobId: 'x' }, entry(1, { title: '' })], 2)))).rejects.toThrow(
      'The newgrad-jobs API sent no job Huntgry could read.'
    )
    // An unknown category: success with total 0.
    await expect(fetchApiList('newgrad:us:nope', deps(async () => answer([], 0)))).rejects.toThrow(/no job/)
  })

  it('asks the public-URL guard about each page', async () => {
    await expect(fetchApiList(CAT, { ...deps(serve(10)), refusal: async () => 'Refusing to load jobright.ai' })).rejects.toThrow(
      'Refusing to load jobright.ai'
    )
    expect(calls).toEqual([])
  })
})

const README = `| Company | Job Title | Location | Work Model | Date Posted |
| ----- | --------- |  --------- | ---- | ------- |
| **[Rocket](https://www.rocketcompanies.com)** | **[Software Engineer I](https://jobright.ai/jobs/info/6a9eb151dacf777321a93040)** | Detroit, MI | On Site | Oct 23 |
`

describe('Explore service, API source (#169)', () => {
  let ws: string
  let apiCalls: string[]
  let readmeCalls: number
  let api: (url: string) => unknown
  const deps = (): ExploreDeps => ({
    apiUrl: JOBRIGHT_API_URL,
    readmeUrl: JOBRIGHT_NEW_GRAD_README,
    hosts: ['jobright.ai', 'www.jobright.ai'],
    postJson: async (url) => {
      apiCalls.push(url)
      return api(url)
    },
    fetchText: async () => {
      readmeCalls++
      return README
    },
    refusal: async () => null,
    now: () => NOW
  })

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'huntgry-explore-api-'))
    apiCalls = []
    readmeCalls = 0
    api = () => answer([entry(1), entry(2, { h1bSponsored: 'Yes' }), { jobId: 'bad' }], 2116)
  })
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true })
  })

  it('lists from the API once, caches the category, and serves the cache until a refresh', async () => {
    const list = await listExplore(ws, CAT, deps())
    expect(list).toMatchObject({ category: CAT, source: 'api', total: 2116, fetchedAt: NOW.toISOString() })
    expect(list.fallbackReason).toBeUndefined()
    expect(list.jobs.map((j) => j.id)).toEqual([id(1), id(2)])
    expect(list.jobs[0].qualifications).toMatch(/^1\. You've shipped/)
    expect(readmeCalls).toBe(0)
    expect(apiCalls).toHaveLength(1)
    expect(cachePath(ws)).toMatch(/explore[/\\]newgrad\.us\.swe\.json$/)
    expect(JSON.parse(await readFile(cachePath(ws), 'utf8'))).toMatchObject({ source: 'api', sourceUrl: JOBRIGHT_API_URL, category: CAT })

    expect((await listExplore(ws, CAT, deps())).jobs).toHaveLength(2)
    expect(apiCalls).toHaveLength(1)
    await refreshExplore(ws, CAT, deps())
    expect(apiCalls).toHaveLength(2)
  })

  it('caches each category on its own', async () => {
    await listExplore(ws, CAT, deps())
    await listExplore(ws, 'newgrad:us:data_analysis', deps())
    expect(apiCalls).toHaveLength(2)
    expect(await readFile(cachePath(ws, 'newgrad:us:data_analysis'), 'utf8')).toContain('"category": "newgrad:us:data_analysis"')
    await listExplore(ws, 'newgrad:us:data_analysis', deps())
    expect(apiCalls).toHaveLength(2)
  })

  it.each([
    ['an HTTP 500', () => {
      throw new Error('The newgrad-jobs API answered HTTP 500 for the Jobright jobs.')
    }, 'The newgrad-jobs API answered HTTP 500 for the Jobright jobs.'],
    ['success: false', () => ({ success: false, errorCode: 50000, result: null }), 'The newgrad-jobs API refused the request (error 50000).'],
    ['malformed rows', () => answer([{ jobId: 'x' }, { jobId: id(9), properties: { title: 3 } }], 2), 'The newgrad-jobs API sent no job Huntgry could read.'],
    ['an unknown shape', () => ({ success: true, result: { jobs: [] } }), 'The newgrad-jobs API answered in a shape Huntgry does not know.']
  ])('falls back to the README on %s, and says so', async (_, fail, reason) => {
    api = fail
    const list = await refreshExplore(ws, CAT, deps())
    expect(list).toMatchObject({ source: 'readme', fallbackReason: reason, jobs: [{ id: '6a9eb151dacf777321a93040' }] })
    expect(readmeCalls).toBe(1)
    expect(await readCache(ws, CAT, deps())).toMatchObject({ source: 'readme', fallbackReason: reason })
  })

  it('a failed refresh leaves the API list cached', async () => {
    await listExplore(ws, 'newgrad:us:ml_ai', deps())
    api = () => {
      throw new Error('The newgrad-jobs API answered HTTP 500 for the Jobright jobs.')
    }
    await expect(refreshExplore(ws, 'newgrad:us:ml_ai', deps())).rejects.toThrow(/HTTP 500/)
    expect((await readCache(ws, 'newgrad:us:ml_ai', deps()))?.jobs).toHaveLength(2)
  })

  it('drops cached rows whose API fields were edited into the wrong type', async () => {
    await listExplore(ws, CAT, deps())
    const cache = JSON.parse(await readFile(cachePath(ws), 'utf8'))
    cache.jobs[0].h1b = 'Definitely'
    cache.jobs[1].industry = 'SaaS'
    await writeFile(cachePath(ws), JSON.stringify(cache))
    expect((await readCache(ws, CAT, deps()))?.jobs).toEqual([])
  })

  it('adds an API row as before, with its salary', async () => {
    await listExplore(ws, CAT, deps())
    const job = await addExplore(ws, id(2), CAT, deps())
    expect(job).toMatchObject({
      id: `jobright:${id(2)}`,
      source: 'jobright',
      sourceId: id(2),
      url: `https://jobright.ai/jobs/info/${id(2)}`,
      boardUrl: `https://jobright.ai/jobs/info/${id(2)}`,
      postedAt: '2026-10-23T12:00:00.000Z',
      salary: '$150000-$168000/yr',
      workplaceType: 'Hybrid',
      descriptionComplete: false
    })
    // Another category's cache does not list it.
    await expect(addExplore(ws, id(1), 'newgrad:us:sales', deps())).rejects.toThrow(/no longer on the Jobright list/)
  })

  it('keeps the qualifications as the added job\'s description, so it scores as its row did (#150)', async () => {
    api = () => answer([entry(1, { qualifications: '1. Kotlin and Android.\n2. Go services are a plus.' })])
    const list = await listExplore(ws, CAT, deps())
    const job = await addExplore(ws, id(1), CAT, deps())
    expect(job.description).toBe('1. Kotlin and Android.\n2. Go services are a plus.')
    expect(job.descriptionComplete).toBe(false)
    const p = emptyProfile()
    p.contact.headline = 'Android Engineer'
    p.skills = [{ category: 'Languages', items: ['Kotlin', 'Go'] }]
    const s = profileSignals(p, NOW)
    const row = scoreRow(list.jobs[0], s, NOW)
    expect(row.kind).toBe('exact')
    expect(scoreJob(job, s, NOW).match.score).toBe(row.score)
    expect(row.score).toBeGreaterThan(0)
  })
})
