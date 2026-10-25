import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_EXPLORE_CATEGORY as CAT } from '@shared/explore-types'
import { JOB_ID_PATTERN } from '@shared/jobs-types'
import { fetchDetails, JOBRIGHT_HUMAN_CHECK } from '../jobs/service'
import { jobsDir, listJobs, readJob, saveJob } from '../jobs/store'
import { inferDate, jobrightId, JOBRIGHT_NEW_GRAD_README, linkCell, parseReadme, safeCompanyUrl, workModelOf } from './parse'
import { JOBRIGHT_API_URL } from './api'
import { addExplore, cachePath, fetchReadme, listExplore, postJson, readCache, refreshExplore, toJob, type ExploreDeps } from './service'
import { exploreSource } from './source'

const TODAY = new Date(2026, 9, 21, 9, 30) // Oct 21 2026, local time
const link = (id: string) => `https://jobright.ai/jobs/info/${id}?utm_campaign=Software%20Engineering&utm_source=1103`

const README = `# 2026 Software Engineer New Grad Positions

## Daily Job List  🌐 🧭 🏆

<!-- TABLE_START -->

| Company | Job Title | Location | Work Model | Date Posted |
| ----- | --------- |  --------- | ---- | ------- |
| **[Rocket](https://www.rocketcompanies.com)** | **[Software Engineer I](${link('6a9eb151dacf777321a93040')})** | Detroit, MI, United States | On Site | Oct 21 |
| ↳ | **[Formal Verification Engineer](${link('6a8dbb62cc0cf27068524b7a')})** | Mountain View | Remote | Oct 21 |
| **[Cadence](https://www.cadence.com)** | **[CST Application Engineer](${link('6ac7f69cfcdafb60c6a46cd2')})** | San Jose, CA, United States | Hybrid | Oct 20 |
| ↳ | **[Bad date](${link('6ac7f69cfcdafb60c6a46cd3')})** | San Jose | Hybrid | Someday |
| **[Evil](javascript:alert(1))** | **[Phish](https://evil.example.com/jobs/info/6ac7f69cfcdafb60c6a46cd4)** | Nowhere | Remote | Oct 20 |
| ↳ | **[Not a posting](https://jobright.ai/companies/6ac7f69cfcdafb60c6a46cd5)** | Nowhere | Remote | Oct 20 |
| **[Plain Co](javascript:alert(1))** | **[Data Engineer \\| Platform](${link('6ac7f69cfcdafb60c6a46cd6')})** | Austin, TX | Onsite | Dec 30 |
| ↳ | **[Short row](${link('6ac7f69cfcdafb60c6a46cd7')})** | Austin |
| **[Rocket](https://www.rocketcompanies.com)** | **[Software Engineer I](${link('6a9eb151dacf777321a93040')})** | Detroit, MI, United States | On Site | Oct 21 |

<!-- TABLE_END -->
`

describe('Jobright README parser', () => {
  const jobs = parseReadme(README, { today: TODAY })

  it('reads rows, with ↳ taking the previous company', () => {
    expect(jobs.map((j) => j.title)).toEqual([
      'Software Engineer I',
      'Formal Verification Engineer',
      'CST Application Engineer',
      'Data Engineer | Platform'
    ])
    expect(jobs[0]).toEqual({
      id: '6a9eb151dacf777321a93040',
      company: 'Rocket',
      companyUrl: 'https://www.rocketcompanies.com/',
      title: 'Software Engineer I',
      url: 'https://jobright.ai/jobs/info/6a9eb151dacf777321a93040',
      location: 'Detroit, MI, United States',
      workModel: 'On Site',
      postedAt: '2026-10-21'
    })
    expect(jobs[1]).toMatchObject({ company: 'Rocket', companyUrl: 'https://www.rocketcompanies.com/', workModel: 'Remote' })
  })

  it('skips malformed rows: bad dates, other hosts, non-posting links, short rows, repeated ids', () => {
    const ids = jobs.map((j) => j.id)
    expect(ids).not.toContain('6ac7f69cfcdafb60c6a46cd3')
    expect(ids).not.toContain('6ac7f69cfcdafb60c6a46cd4')
    expect(ids).not.toContain('6ac7f69cfcdafb60c6a46cd5')
    expect(ids).not.toContain('6ac7f69cfcdafb60c6a46cd7')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('drops unsafe company links but keeps the row', () => {
    expect(jobs[3]).toMatchObject({ company: 'Plain Co', companyUrl: null })
    expect(safeCompanyUrl('http://localhost:3000')).toBeNull()
    expect(safeCompanyUrl('http://user:pw@example.com')).toBeNull()
    expect(safeCompanyUrl('ftp://example.com')).toBeNull()
    expect(safeCompanyUrl('https://acme.com/careers')).toBe('https://acme.com/careers')
  })

  it('infers the year: a date after today is last year', () => {
    expect(inferDate('Oct 21', TODAY)).toBe('2026-10-21')
    expect(inferDate('Oct 22', TODAY)).toBe('2026-10-22') // a day ahead: time zones
    expect(inferDate('Oct 25', TODAY)).toBe('2025-10-25')
    expect(inferDate('Dec 30', TODAY)).toBe('2025-12-30')
    expect(inferDate('Jan 2', new Date(2027, 0, 3))).toBe('2027-01-02')
    expect(inferDate('Dec 31', new Date(2027, 0, 3))).toBe('2026-12-31')
    expect(inferDate('Feb 30', TODAY)).toBeNull()
    expect(inferDate('Foo 3', TODAY)).toBeNull()
    expect(inferDate('2026-10-21', TODAY)).toBeNull()
    expect(jobs[3].postedAt).toBe('2025-12-30')
  })

  it('maps the work model', () => {
    expect(workModelOf('On Site')).toBe('On Site')
    expect(workModelOf('Onsite')).toBe('On Site')
    expect(workModelOf(' remote ')).toBe('Remote')
    expect(workModelOf('Hybrid')).toBe('Hybrid')
    expect(workModelOf('Flexible')).toBeNull()
  })

  it('reads link cells and Jobright ids strictly', () => {
    expect(linkCell('**[A](https://a.com)**')).toEqual({ text: 'A', url: 'https://a.com' })
    expect(linkCell('Plain')).toEqual({ text: 'Plain', url: null })
    expect(jobrightId('https://jobright.ai/jobs/info/abc123def')).toBe('abc123def')
    expect(jobrightId('https://www.jobright.ai/jobs/info/abc123def?x=1')).toBe('abc123def')
    expect(jobrightId('https://jobright.ai.evil.com/jobs/info/abc123def')).toBeNull()
    expect(jobrightId('https://u:p@jobright.ai/jobs/info/abc123def')).toBeNull()
    expect(jobrightId('https://jobright.ai/jobs/info/../x')).toBeNull()
    expect(jobrightId('http://127.0.0.1:4000/jobs/info/abc123def', ['127.0.0.1:4000'])).toBe('abc123def')
    // Jobright's own host only over https.
    expect(jobrightId('http://jobright.ai/jobs/info/abc123def')).toBeNull()
    expect(jobrightId('http://www.jobright.ai/jobs/info/abc123def')).toBeNull()
  })

  it('keeps a test host on its own origin', () => {
    const md = `| **[A](https://a.com)** | **[T](http://127.0.0.1:4000/jobs/info/abc123def?u=1)** | X | Remote | Oct 21 |`
    expect(parseReadme(md, { today: TODAY, hosts: ['127.0.0.1:4000'] })[0].url).toBe('http://127.0.0.1:4000/jobs/info/abc123def')
    expect(parseReadme(md, { today: TODAY })).toEqual([])
  })

  it('every saved id fits the jobs id pattern', () => {
    for (const j of jobs) expect(JOB_ID_PATTERN.test(toJob(j, TODAY).id)).toBe(true)
  })
})

describe('Explore source override', () => {
  const env = {
    HUNTGRY_EXPLORE_API_URL: 'http://127.0.0.1:5000/jobright/swan/mini-sites/list',
    HUNTGRY_EXPLORE_SOURCE_URL: 'http://127.0.0.1:5000/jobright/README.md',
    HUNTGRY_ALLOW_LOCAL_URLS: '1'
  }
  const real = { apiUrl: JOBRIGHT_API_URL, readmeUrl: JOBRIGHT_NEW_GRAD_README, hosts: ['jobright.ai', 'www.jobright.ai'] }

  it('is used only unpackaged, with local URLs allowed, for loopback URLs', () => {
    expect(exploreSource(false, env)).toEqual({
      apiUrl: 'http://127.0.0.1:5000/jobright/swan/mini-sites/list',
      readmeUrl: 'http://127.0.0.1:5000/jobright/README.md',
      hosts: ['jobright.ai', 'www.jobright.ai', '127.0.0.1:5000']
    })
    expect(exploreSource(true, env)).toEqual(real)
    expect(exploreSource(false, { ...env, HUNTGRY_ALLOW_LOCAL_URLS: '' })).toEqual(real)
    expect(exploreSource(false, {})).toEqual(real)
  })

  it('ignores each override that is not loopback, on its own', () => {
    expect(exploreSource(false, { ...env, HUNTGRY_EXPLORE_API_URL: 'https://example.com/list' })).toEqual({
      apiUrl: JOBRIGHT_API_URL,
      readmeUrl: 'http://127.0.0.1:5000/jobright/README.md',
      hosts: ['jobright.ai', 'www.jobright.ai', '127.0.0.1:5000']
    })
    expect(exploreSource(false, { ...env, HUNTGRY_EXPLORE_SOURCE_URL: 'https://example.com/x.md' }).readmeUrl).toBe(JOBRIGHT_NEW_GRAD_README)
    expect(exploreSource(false, { ...env, HUNTGRY_EXPLORE_API_URL: 'http://10.0.0.5/list' }).apiUrl).toBe(JOBRIGHT_API_URL)
  })
})

/** The README path (#142): the API is down, so the default category falls back to it (#169). */
describe('Explore service, README fallback', () => {
  let ws: string
  let fetches: string[]
  let apiCalls: string[]
  let answer: () => Promise<string>
  const deps = (): ExploreDeps => ({
    apiUrl: JOBRIGHT_API_URL,
    readmeUrl: JOBRIGHT_NEW_GRAD_README,
    hosts: ['jobright.ai', 'www.jobright.ai'],
    postJson: async (url) => {
      apiCalls.push(url)
      throw new Error('The newgrad-jobs API answered HTTP 500 for the Jobright jobs.')
    },
    fetchText: async (url) => {
      fetches.push(url)
      return answer()
    },
    refusal: async () => null,
    now: () => TODAY
  })

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'huntgry-explore-'))
    fetches = []
    apiCalls = []
    answer = async () => README
  })
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true })
  })

  it('fetches once, then serves the cache (offline too) until a refresh', async () => {
    const first = await listExplore(ws, CAT, deps())
    expect(first.jobs).toHaveLength(4)
    expect(first.fetchedAt).toBe(TODAY.toISOString())
    expect(fetches).toEqual([JOBRIGHT_NEW_GRAD_README])
    expect(first).toMatchObject({ category: CAT, source: 'readme', fallbackReason: 'The newgrad-jobs API answered HTTP 500 for the Jobright jobs.' })
    expect(apiCalls).toEqual([`${JOBRIGHT_API_URL}?position=0&count=500`])
    expect(JSON.parse(await readFile(cachePath(ws), 'utf8'))).toMatchObject({ source: 'readme', sourceUrl: JOBRIGHT_NEW_GRAD_README })

    answer = async () => {
      throw new Error('Could not reach GitHub for the Jobright list (you may be offline).')
    }
    expect((await listExplore(ws, CAT, deps())).jobs).toHaveLength(4)
    expect(fetches).toHaveLength(1)
    // A failed refresh says why and leaves the cache as it was.
    await expect(refreshExplore(ws, CAT, deps())).rejects.toThrow(/offline/)
    expect((await readCache(ws, CAT, deps()))?.jobs).toHaveLength(4)

    answer = async () => README.split('\n').slice(0, 9).join('\n')
    expect((await refreshExplore(ws, CAT, deps())).jobs).toHaveLength(1)
    expect(fetches).toHaveLength(3)
  })

  it('refuses a list with no readable rows, and a refused source URL', async () => {
    answer = async () => '# nothing here'
    await expect(listExplore(ws, CAT, deps())).rejects.toThrow(/no jobs/)
    await expect(listExplore(ws, CAT, { ...deps(), refusal: async () => 'Refusing to load x' })).rejects.toThrow('Refusing to load x')
  })

  it('ignores a cache of another source and invalid cached rows', async () => {
    await mkdir(join(ws, '.huntgry', 'explore'), { recursive: true })
    const cache = { category: CAT, source: 'readme', sourceUrl: JOBRIGHT_NEW_GRAD_README, fetchedAt: 'x', jobs: [] }
    for (const other of [{ sourceUrl: 'https://other' }, { source: 'api' }, { source: 'elsewhere' }, { category: 'newgrad:us:sales' }]) {
      await writeFile(cachePath(ws), JSON.stringify({ ...cache, ...other }))
      expect(await readCache(ws, CAT, deps())).toBeNull()
    }
    await writeFile(cachePath(ws), JSON.stringify({ ...cache, jobs: [{ id: '../../etc', title: 'x' }] }))
    expect(await readCache(ws, CAT, deps())).toEqual({ jobs: [], fetchedAt: 'x', category: CAT, source: 'readme' })
  })

  it('falls back only for the default category, and says why when the README fails too', async () => {
    await expect(refreshExplore(ws, 'newgrad:us:data_analysis', deps())).rejects.toThrow(
      'The newgrad-jobs API answered HTTP 500 for the Jobright jobs.'
    )
    expect(fetches).toEqual([])
    answer = async () => {
      throw new Error('GitHub answered HTTP 503 for the Jobright list.')
    }
    await expect(refreshExplore(ws, CAT, deps())).rejects.toThrow(
      'The newgrad-jobs API answered HTTP 500 for the Jobright jobs. The GitHub list could not be read either: GitHub answered HTTP 503 for the Jobright list.'
    )
  })

  it('drops cached rows whose URL is not the posting page of their own id', async () => {
    await listExplore(ws, CAT, deps())
    const cache = JSON.parse(await readFile(cachePath(ws), 'utf8'))
    const [a, b, c] = cache.jobs
    cache.jobs = [
      { ...a, url: 'https://evil.example.com/' },
      { ...b, url: `https://jobright.ai/jobs/info/${c.id}` },
      { ...c, url: `http://jobright.ai/jobs/info/${c.id}` }
    ]
    await writeFile(cachePath(ws), JSON.stringify(cache))
    expect((await readCache(ws, CAT, deps()))?.jobs).toEqual([])
    await expect(addExplore(ws, a.id, CAT, deps())).rejects.toThrow(/no longer on the Jobright list/)
  })

  it('adds a row as a jobright job, idempotently', async () => {
    await listExplore(ws, CAT, deps())
    const job = await addExplore(ws, '6a8dbb62cc0cf27068524b7a', CAT, deps())
    expect(job).toMatchObject({
      id: 'jobright:6a8dbb62cc0cf27068524b7a',
      source: 'jobright',
      title: 'Formal Verification Engineer',
      company: 'Rocket',
      url: 'https://jobright.ai/jobs/info/6a8dbb62cc0cf27068524b7a',
      boardUrl: 'https://jobright.ai/jobs/info/6a8dbb62cc0cf27068524b7a',
      postedAt: '2026-10-21T12:00:00.000Z',
      remote: true,
      workplaceType: 'Remote',
      descriptionComplete: false,
      tags: [],
      salary: ''
    })
    // A description fetched since is kept: a second add does not write the file again.
    await saveJob(ws, { ...job, description: 'Full text', descriptionComplete: true })
    const again = await addExplore(ws, '6a8dbb62cc0cf27068524b7a', CAT, deps())
    expect(again).toMatchObject({ id: job.id, description: 'Full text', descriptionComplete: true })
    expect(await readdir(jobsDir(ws))).toEqual(['jobright-6a8dbb62cc0cf27068524b7a.json'])
    expect((await listJobs(ws)).map((j) => j.id)).toEqual([job.id])
  })

  it('merges with the same job saved from another board', async () => {
    await listExplore(ws, CAT, deps())
    const byUrl = { ...toJob((await readCache(ws, CAT, deps()))!.jobs[0], TODAY), id: 'url:abc', source: 'url' as const, sourceId: 'abc' }
    await saveJob(ws, { ...byUrl, fetchedAt: '2026-10-01T00:00:00.000Z' })
    const added = await addExplore(ws, '6a9eb151dacf777321a93040', CAT, deps())
    expect(added.id).toBe('url:abc')
    expect(added.aliases).toEqual(['jobright:6a9eb151dacf777321a93040'])
    expect(await readJob(ws, 'jobright:6a9eb151dacf777321a93040')).not.toBeNull()
  })

  it('refuses ids that are not on the list, and links the guard refuses', async () => {
    await listExplore(ws, CAT, deps())
    await expect(addExplore(ws, 'ffffffffffffffffffffffff', CAT, deps())).rejects.toThrow(/no longer on the Jobright list/)
    await expect(
      addExplore(ws, '6a9eb151dacf777321a93040', CAT, { ...deps(), refusal: async () => 'Refusing to load jobright.ai' })
    ).rejects.toThrow('Refusing to load jobright.ai')
  })

  it('fetches the full description from the Jobright page, and says when it needs a human check', async () => {
    await listExplore(ws, CAT, deps())
    const job = await addExplore(ws, '6a8dbb62cc0cf27068524b7a', CAT, deps())
    const loaded: string[] = []
    await expect(
      fetchDetails(ws, job.id, async (url) => {
        loaded.push(url)
        return { status: 'blocked', message: 'jobright.ai asked for a human check (Just a moment...).' }
      })
    ).rejects.toThrow(JOBRIGHT_HUMAN_CHECK)
    expect(loaded).toEqual([job.url])
    const full = await fetchDetails(ws, job.id, async (url) => ({
      status: 'ok',
      data: {
        url,
        title: 'Formal Verification Engineer',
        text: '',
        ld: [
          JSON.stringify({
            '@type': 'JobPosting',
            title: 'Formal Verification Engineer',
            hiringOrganization: { name: 'Rocket' },
            description: `<p>${'Prove hardware designs correct with formal methods. '.repeat(10)}</p>`
          })
        ]
      }
    }))
    expect(full).toMatchObject({ id: job.id, source: 'jobright', descriptionComplete: true, url: job.url })
    expect(full.description).toContain('Prove hardware designs correct')
  })
})

describe('fetchReadme', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const streamOf = (chunks: number, size: number) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < chunks; i++) c.enqueue(new Uint8Array(size).fill(97))
        c.close()
      }
    })

  it('stops reading a body past 5 MB even without a Content-Length', async () => {
    globalThis.fetch = (async () => new Response(streamOf(6, 1024 * 1024))) as typeof fetch
    await expect(fetchReadme('https://example.com/r.md')).rejects.toThrow(/unexpectedly large/)
  })

  it('reads a body under the cap as UTF-8', async () => {
    globalThis.fetch = (async () => new Response('| ↳ | ok |')) as typeof fetch
    await expect(fetchReadme('https://example.com/r.md')).resolves.toBe('| ↳ | ok |')
  })
})

describe('postJson', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('POSTs the body as JSON, without credentials or redirects, and parses the answer', async () => {
    let seen: RequestInit | undefined
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = init
      return new Response('{"success":true}')
    }) as typeof fetch
    await expect(postJson('https://example.com/list', { category: CAT })).resolves.toEqual({ success: true })
    expect(seen).toMatchObject({ method: 'POST', body: '{"category":"newgrad:us:swe"}', redirect: 'error', credentials: 'omit' })
  })

  it('says what failed: HTTP errors, non-JSON, a body past 5 MB, offline', async () => {
    globalThis.fetch = (async () => new Response('down', { status: 500 })) as typeof fetch
    await expect(postJson('https://example.com/list', {})).rejects.toThrow('The newgrad-jobs API answered HTTP 500 for the Jobright jobs.')
    globalThis.fetch = (async () => new Response('<html>')) as typeof fetch
    await expect(postJson('https://example.com/list', {})).rejects.toThrow(/did not answer with JSON/)
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (let i = 0; i < 6; i++) c.enqueue(new Uint8Array(1024 * 1024).fill(32))
            c.close()
          }
        })
      )) as typeof fetch
    await expect(postJson('https://example.com/list', {})).rejects.toThrow(/unexpectedly large/)
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    await expect(postJson('https://example.com/list', {})).rejects.toThrow('Could not reach the newgrad-jobs API for the Jobright jobs (you may be offline).')
  })
})

