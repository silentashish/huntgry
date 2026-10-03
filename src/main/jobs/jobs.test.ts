import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { jobDescriptionFor, type Job } from '@shared/jobs-types'
import { isBlockedPage } from './blocked'
import type { LoadResult } from './loader'
import { addByUrl, addPasted, fetchDetails, searchJobs, updateJob, validateQuery } from './service'
import { hiringCafeSearchUrl, matchesLocation, parseHiringCafeHits } from './sources/hiringcafe'
import { indeedSearchUrl, parseIndeedCards } from './sources/indeed'
import { findJobPosting, isoDate, parsePosting, urlJobId, type PageData } from './sources/posting'
import { canonicalize, canonicalKey, jobFileName, listJobs, mergeJob, recentSearches, saveJob, writeJobFile } from './store'
import { htmlToText } from './text'

const fixture = async (name: string) => JSON.parse(await readFile(join(__dirname, 'fixtures', name), 'utf8'))

let ws: string
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-jobs-'))
})
afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
})

describe('hiring.cafe', () => {
  it('parses the search page data (recorded from hiringcafe.com)', async () => {
    const data = await fixture('hiringcafe-next-data.json')
    const jobs = parseHiringCafeHits({ hits: data.props.pageProps.ssrHits })
    expect(jobs).toHaveLength(3)
    const j = jobs[0]
    expect(j).toMatchObject({
      source: 'hiring.cafe',
      title: 'Platform Engineer',
      company: 'NS2 Mission',
      remote: false,
      descriptionComplete: false
    })
    expect(j.id).toBe(`hiring.cafe:${j.sourceId}`)
    expect(j.url).toMatch(/^https:\/\/workforcenow\.adp\.com\//)
    expect(j.salary).toBe('$131,644 – $190,789 / year')
    expect(j.tags).toContain('Python')
    expect(j.description).toContain('Requirements:')
    expect(j.postedAt).toBe('2026-09-03T21:38:00.000Z')
  })

  it('skips expired or incomplete hits and builds search URLs', () => {
    expect(
      parseHiringCafeHits({
        hits: [
          { id: 'x', is_expired: true, job_information: { title: 'T' } },
          { job_information: { title: 'no id' } },
          null
        ]
      })
    ).toEqual([])
    expect(parseHiringCafeHits(null)).toEqual([])
    // A hit without apply_url has no posting URL (not the board's home page, #63).
    expect(parseHiringCafeHits({ hits: [{ id: 'n', job_information: { title: 'T' } }] })[0].url).toBe('')
    const url = new URL(hiringCafeSearchUrl({ keywords: 'platform engineer', location: 'Atlanta', remoteOnly: true }))
    expect(JSON.parse(url.searchParams.get('searchState')!)).toEqual({
      searchQuery: 'platform engineer',
      workplaceTypes: ['Remote']
    })
    expect(matchesLocation({ location: 'Herndon, Virginia, United States', remote: false }, 'Atlanta, GA')).toBe(false)
    expect(matchesLocation({ location: 'Atlanta, Georgia, United States', remote: false }, 'Atlanta, GA')).toBe(true)
    expect(matchesLocation({ location: 'Anywhere', remote: true }, 'Atlanta, GA')).toBe(true)
    expect(matchesLocation({ location: 'Herndon', remote: false }, '')).toBe(true)
  })
})

describe('Indeed', () => {
  it('parses the embedded job cards (recorded from indeed.com)', async () => {
    const jobs = parseIndeedCards(await fixture('indeed-jobcards.json'))
    expect(jobs).toHaveLength(3)
    expect(jobs[0]).toMatchObject({
      source: 'indeed',
      title: 'Platform Engineer',
      company: 'Capgemini',
      location: 'Alpharetta, GA',
      salary: '$34.67 - $54.18 an hour',
      tags: ['Contract']
    })
    expect(jobs[0].url).toBe(`https://www.indeed.com/viewjob?jk=${jobs[0].sourceId}`)
    expect(jobs[0].description.startsWith('- Build self-service portals')).toBe(true)
    expect(jobs[0].description).not.toContain('<')
  })

  it('refuses bad job keys and builds search URLs', () => {
    expect(parseIndeedCards({ results: [{ jobkey: '../x', title: 'T' }] })).toEqual([])
    expect(indeedSearchUrl({ keywords: 'sre', location: 'Austin, TX', remoteOnly: false })).toBe(
      'https://www.indeed.com/jobs?q=sre&l=Austin%2C+TX&sort=date'
    )
    expect(indeedSearchUrl({ keywords: 'sre', location: 'Austin', remoteOnly: true })).toContain('l=Remote')
  })
})

describe('postings by URL', () => {
  it('reads JSON-LD JobPosting inside @graph', async () => {
    const page: PageData = await fixture('jsonld-posting.json')
    expect(findJobPosting(page.ld)?.title).toBe('Senior Backend Engineer')
    const job = parsePosting(page)!
    expect(job).toMatchObject({
      title: 'Senior Backend Engineer',
      company: 'Acme Corp',
      location: 'Atlanta, GA, US',
      salary: '$150,000 – $185,000 / year',
      descriptionComplete: true
    })
    expect(job.description).toContain('- Design Python and Go services on AWS')
    expect(job.description).toContain('Kafka pipelines & observability')
    expect(job.postedAt).toBe('2026-09-20T00:00:00.000Z')
  })

  it('falls back to the page text when there is no JobPosting', async () => {
    const job = parsePosting(await fixture('plain-posting.json'))!
    expect(job.title).toBe('Data Engineer')
    expect(job.description).toContain('Build ETL pipelines with Airflow')
    expect(job.description).not.toMatch(/\n{3}/)
    expect(job.remote).toBe(true)
    expect(parsePosting({ ld: [], title: 'Login', text: 'Sign in', url: 'https://x.com' })).toBeNull()
  })

  it('uses the page text when the JobPosting description is a stub', async () => {
    const plain: PageData = await fixture('plain-posting.json')
    const stub = JSON.stringify({ '@type': 'JobPosting', title: 'Data Engineer', hiringOrganization: { name: 'Initech' }, description: 'See below.' })
    const job = parsePosting({ ...plain, ld: [stub] })!
    expect(job.company).toBe('Initech')
    expect(job.description).toContain('Build ETL pipelines with Airflow')
    expect(job.descriptionComplete).toBe(true)
    // Short page text too: the JSON-LD description is kept (and marked incomplete).
    expect(parsePosting({ ...plain, ld: [stub], text: 'Apply now' })!.description).toBe('See below.')
  })

  it('keeps a short JSON-LD description when the page text is something else', async () => {
    const plain: PageData = await fixture('plain-posting.json')
    const short = 'Own the ranking stack for marketplace search: PyTorch models, Spark features, online A/B tests.'
    const ld = JSON.stringify({ '@type': 'JobPosting', title: 'Search Ranking Engineer', description: short })
    // The page text is a different posting (or a site footer): it neither names this job nor contains its description.
    const job = parsePosting({ ...plain, ld: [ld] })!
    expect(job.description).toBe(short)
    expect(job.descriptionComplete).toBe(false)
    // Same title but the text doesn't contain the description either: still kept.
    const sameTitle = parsePosting({ ...plain, ld: [JSON.stringify({ '@type': 'JobPosting', title: 'Data Engineer', description: short })] })!
    expect(sameTitle.description).toBe(short)
  })

  it('ignores tracking parameters in URL ids', () => {
    expect(urlJobId('https://a.com/j/1?utm_source=x&gh_src=y')).toBe(urlJobId('https://a.com/j/1'))
    expect(urlJobId('https://a.com/j/1?id=2')).not.toBe(urlJobId('https://a.com/j/1'))
  })
})

describe('blocked pages and text', () => {
  it('detects bot walls', () => {
    expect(isBlockedPage({ title: 'Just a moment...', text: '' })).toBe(true)
    expect(
      isBlockedPage({ title: 'Indeed', text: 'Additional Verification Required. Your Ray ID for this request is abc' })
    ).toBe(true)
    expect(isBlockedPage({ title: 'Jobs', text: 'ok', status: 403 })).toBe(true)
    expect(isBlockedPage({ title: 'Platform Engineer Jobs', text: '38 results' })).toBe(false)
  })

  it('never throws on bad entities or dates', () => {
    expect(htmlToText('A&#99999999;B&#x1F600;')).toBe('A&#99999999;B😀')
    expect(isoDate('Posted 3 days ago')).toBeNull()
    expect(isoDate('2026-09-20')).toBe('2026-09-20T00:00:00.000Z')
    const page = {
      url: 'https://a.com/j',
      title: 'T',
      text: '',
      ld: [
        JSON.stringify({ '@type': 'JobPosting', title: 'SRE', datePosted: 'yesterday', description: 'x'.repeat(300) })
      ]
    }
    expect(parsePosting(page)?.postedAt).toBeNull()
  })

  it('turns posting HTML into readable text', () => {
    expect(htmlToText('<p>One&nbsp;two</p><ul><li>A &amp; B</li><li>C</li></ul><script>x()</script>')).toBe(
      'One two\n\n- A & B\n- C'
    )
  })
})

describe('store', () => {
  const base = (over: Partial<Job>): Job => ({
    id: 'indeed:abc',
    source: 'indeed',
    sourceId: 'abc',
    title: 'SRE',
    company: 'Acme',
    location: '',
    remote: false,
    salary: '',
    postedAt: null,
    url: 'https://x',
    boardUrl: null,
    description: 'short',
    descriptionComplete: false,
    tags: [],
    fetchedAt: '2026-09-01T00:00:00Z',
    ...over
  })

  it('keeps user state and a full description when a job is found again', () => {
    const saved = base({
      tailoredAt: '2026-09-02',
      dismissed: true,
      description: 'full text',
      descriptionComplete: true
    })
    const merged = mergeJob(saved, base({ salary: '$1', description: 'snippet' }))
    expect(merged).toMatchObject({
      salary: '$1',
      description: 'full text',
      descriptionComplete: true,
      tailoredAt: '2026-09-02',
      dismissed: true
    })
  })

  it('merges the same job across boards into one deterministic canonical record', () => {
    const a = base({
      id: 'indeed:1',
      title: 'Platform Engineer',
      company: 'Acme, Inc.',
      location: 'Austin, TX',
      fetchedAt: '2026-09-01T00:00:00Z',
      salary: '$1'
    })
    const b = base({
      id: 'hiring.cafe:2',
      source: 'hiring.cafe',
      title: 'platform engineer',
      company: 'Acme Inc',
      location: 'Austin, Texas, United States',
      description: 'full',
      descriptionComplete: true,
      fetchedAt: '2026-09-02T00:00:00Z',
      tailoredAt: '2026-09-03T00:00:00Z',
      tags: ['Go']
    })
    const other = base({ id: 'url:3', title: 'Other', company: '' })
    for (const input of [
      [a, b, other],
      [b, other, a]
    ]) {
      const out = canonicalize(input)
      expect(out).toHaveLength(2)
      const job = out.find((j) => j.id === 'indeed:1')!
      // The first-saved record keeps its id; the best description and user state are merged in.
      expect(job).toMatchObject({
        aliases: ['hiring.cafe:2'],
        description: 'full',
        descriptionComplete: true,
        salary: '$1',
        tailoredAt: '2026-09-03T00:00:00Z',
        tags: ['Go']
      })
    }
    expect(canonicalKey({ title: 'X', company: '', location: '', remote: false })).toBeNull()
    // Same title and company in two cities, or twice on one board: separate jobs.
    const herndon = base({
      id: 'hiring.cafe:h',
      source: 'hiring.cafe',
      title: 'PE',
      company: 'NS2',
      location: 'Herndon, Virginia, United States'
    })
    const chantilly = base({
      id: 'hiring.cafe:c',
      source: 'hiring.cafe',
      title: 'PE',
      company: 'NS2',
      location: 'Chantilly, Virginia, United States'
    })
    const sameBoard = base({
      id: 'hiring.cafe:h2',
      source: 'hiring.cafe',
      title: 'PE',
      company: 'NS2',
      location: 'Herndon, VA'
    })
    const indeedHerndon = base({
      id: 'indeed:h',
      title: 'PE',
      company: 'NS2',
      location: 'Herndon, VA 20171',
      fetchedAt: '2026-09-09T00:00:00Z'
    })
    const merged = canonicalize([herndon, chantilly, sameBoard, indeedHerndon])
    expect(merged).toHaveLength(3)
    expect(merged.find((j) => j.id === 'hiring.cafe:h')?.aliases).toEqual(['indeed:h'])
  })

  it('makes safe file names', () => {
    expect(jobFileName('hiring.cafe:adp___x/../y')).toBe('hiring.cafe-adp___x-..-y.json')
    expect(jobFileName('url:abc')).not.toContain(':')
  })
})

describe('service with a stub loader', () => {
  const readJobRaw = async (id: string): Promise<Job> =>
    JSON.parse(await readFile(join(ws, '.huntgry/jobs', jobFileName(id)), 'utf8'))
  const pages: Record<string, LoadResult> = {}
  const load = async (url: string): Promise<LoadResult> => {
    for (const [prefix, res] of Object.entries(pages)) if (url.startsWith(prefix)) return res
    return { status: 'error', message: 'unexpected url' }
  }

  it('reports a board whose loader throws and still searches the others', async () => {
    const hc = await fixture('hiringcafe-next-data.json')
    const flaky = async (url: string): Promise<LoadResult> => {
      if (url.includes('indeed')) throw new Error('The page closed.')
      return { status: 'ok', data: { hits: hc.props.pageProps.ssrHits } }
    }
    const res = await searchJobs(ws, validateQuery({ keywords: 'x', sources: ['indeed', 'hiring.cafe'] }), flaky)
    expect(res.sources).toEqual([
      { source: 'indeed', status: 'error', count: 0, message: 'The page closed.' },
      { source: 'hiring.cafe', status: 'ok', count: 3, message: undefined }
    ])
  })

  it('searches both boards, saves results and reports a blocked board', async () => {
    const hc = await fixture('hiringcafe-next-data.json')
    pages['https://hiringcafe.com/'] = { status: 'ok', data: { hits: hc.props.pageProps.ssrHits } }
    pages['https://www.indeed.com/jobs'] = {
      status: 'blocked',
      message: 'www.indeed.com asked for a human check (Just a moment...).'
    }
    const res = await searchJobs(
      ws,
      validateQuery({ keywords: 'platform engineer', location: '', sources: ['hiring.cafe', 'indeed'] }),
      load
    )
    expect(res.sources).toEqual([
      { source: 'hiring.cafe', status: 'ok', count: 3, message: undefined },
      {
        source: 'indeed',
        status: 'blocked',
        count: 0,
        message: 'www.indeed.com asked for a human check (Just a moment...).'
      }
    ])
    expect((await listJobs(ws)).length).toBe(3)
    expect((await readdir(join(ws, '.huntgry/jobs'))).length).toBe(3)
    expect((await recentSearches(ws))[0].query.keywords).toBe('platform engineer')
    // Searching again does not duplicate.
    await searchJobs(ws, validateQuery({ keywords: 'platform engineer', sources: ['hiring.cafe'] }), load)
    expect((await listJobs(ws)).length).toBe(3)
  })

  it('fetches full details for a hiring.cafe job from the employer page', async () => {
    const hc = await fixture('hiringcafe-next-data.json')
    pages['https://hiringcafe.com/'] = { status: 'ok', data: { hits: hc.props.pageProps.ssrHits } }
    const { jobs } = await searchJobs(ws, validateQuery({ keywords: 'x', sources: ['hiring.cafe'] }), load)
    const posting = await fixture('jsonld-posting.json')
    pages[jobs[0].url] = { status: 'ok', data: { ...posting, url: jobs[0].url } }
    const full = await fetchDetails(ws, jobs[0].id, load)
    expect(full.descriptionComplete).toBe(true)
    expect(full.description).toContain('routing platform')
    expect(full.company).toBe('NS2 Mission')
  })

  it('adds by URL, adds pasted text, marks tailored/dismissed, and explains Indeed details', async () => {
    pages['https://jobs.example.com/'] = { status: 'ok', data: await fixture('jsonld-posting.json') }
    const job = await addByUrl(ws, 'https://jobs.example.com/acme/senior-backend-engineer', load)
    expect(job.source).toBe('url')
    pages['https://blocked.example.com/'] = {
      status: 'blocked',
      message: 'blocked.example.com asked for a human check (x).'
    }
    await expect(addByUrl(ws, 'https://blocked.example.com/j', load)).rejects.toThrow(/Paste the job description/)
    await expect(addByUrl(ws, 'file:///etc/passwd', load)).rejects.toThrow(/http/)

    const pasted = await addPasted(ws, {
      title: '',
      company: 'Globex',
      url: '',
      text: '# ML Engineer\n\nBuild ranking models with PyTorch and Spark for search.'
    })
    expect(pasted).toMatchObject({
      source: 'pasted',
      title: 'ML Engineer',
      company: 'Globex',
      descriptionComplete: true
    })
    const t = await updateJob(ws, pasted.id, { tailored: true })
    expect(t.tailoredAt).toBeTruthy()
    expect((await updateJob(ws, pasted.id, { dismissed: true })).dismissed).toBe(true)
    expect(jobDescriptionFor(t)).toMatch(/^# ML Engineer\n\nGlobex\n\nBuild ranking/)

    const indeed = parseIndeedCards(await fixture('indeed-jobcards.json'))[0]
    await saveJob(ws, indeed)
    await expect(fetchDetails(ws, indeed.id, load)).rejects.toThrow(/human check/)
  })

  it('lists and updates a job found on two boards as one', async () => {
    const hc = await fixture('hiringcafe-next-data.json')
    const hcJob = parseHiringCafeHits({ hits: hc.props.pageProps.ssrHits })[0]
    const card = {
      ...parseIndeedCards(await fixture('indeed-jobcards.json'))[0],
      title: hcJob.title,
      company: hcJob.company,
      location: 'Herndon, VA',
      fetchedAt: '2030-01-01T00:00:00Z'
    }
    await saveJob(ws, hcJob)
    await saveJob(ws, card)
    const listed = await listJobs(ws)
    expect(listed.filter((j) => j.title === hcJob.title && j.company === hcJob.company)).toHaveLength(1)
    const canonical = listed.find((j) => j.id === hcJob.id)!
    expect(canonical.aliases).toEqual([card.id])
    // An update through the alias id reaches every copy.
    await updateJob(ws, card.id, { dismissed: true, tailored: true })
    for (const id of [hcJob.id, card.id]) {
      const raw = JSON.parse(await readFile(join(ws, '.huntgry/jobs', jobFileName(id)), 'utf8'))
      expect(raw.dismissed).toBe(true)
      expect(raw.tailoredAt).toBeTruthy()
    }
  })

  it('fetches details through the hiring.cafe copy when the Indeed copy is canonical', async () => {
    const hc = await fixture('hiringcafe-next-data.json')
    const hcJob = { ...parseHiringCafeHits({ hits: hc.props.pageProps.ssrHits })[0], fetchedAt: '2030-01-02T00:00:00Z' }
    // Saved first, so the Indeed record is the canonical one.
    const card = {
      ...parseIndeedCards(await fixture('indeed-jobcards.json'))[0],
      title: hcJob.title,
      company: hcJob.company,
      location: 'Herndon, VA',
      fetchedAt: '2030-01-01T00:00:00Z'
    }
    await saveJob(ws, card)
    await saveJob(ws, hcJob)
    const canonical = (await listJobs(ws)).find((j) => j.id === card.id)!
    expect(canonical.aliases).toEqual([hcJob.id])

    const posting = await fixture('jsonld-posting.json')
    const requested: string[] = []
    const viaHc = async (url: string): Promise<LoadResult> => {
      requested.push(url)
      return url === hcJob.url ? { status: 'ok', data: { ...posting, url } } : { status: 'error', message: 'unexpected url' }
    }
    for (const id of [card.id, hcJob.id]) {
      const full = await fetchDetails(ws, id, viaHc)
      expect(full.id).toBe(card.id)
      expect(full.descriptionComplete).toBe(true)
      expect(full.description).toContain('routing platform')
    }
    // Loaded once from the hiring.cafe copy's URL (the second call finds it complete), saved to the canonical file.
    expect(requested).toEqual([hcJob.url])
    const raw = JSON.parse(await readFile(join(ws, '.huntgry/jobs', jobFileName(card.id)), 'utf8'))
    expect(raw.descriptionComplete).toBe(true)
  })

  it('tries the next loadable copy when the first one fails', async () => {
    const hc = await fixture('hiringcafe-next-data.json')
    const hcJob = { ...parseHiringCafeHits({ hits: hc.props.pageProps.ssrHits })[0], fetchedAt: '2030-01-01T00:00:00Z' }
    const urlCopy = { ...hcJob, id: 'url:acme-1', source: 'url' as const, sourceId: 'acme-1', url: 'https://careers.example.com/acme-1', fetchedAt: '2030-01-02T00:00:00Z' }
    await saveJob(ws, hcJob)
    await saveJob(ws, urlCopy)
    expect((await listJobs(ws)).find((j) => j.id === hcJob.id)?.aliases).toEqual([urlCopy.id])

    const posting = await fixture('jsonld-posting.json')
    const requested: string[] = []
    const firstFails = async (url: string): Promise<LoadResult> => {
      requested.push(url)
      return url === urlCopy.url ? { status: 'ok', data: { ...posting, url } } : { status: 'error', message: 'timed out.' }
    }
    const full = await fetchDetails(ws, hcJob.id, firstFails)
    expect(full.descriptionComplete).toBe(true)
    expect(requested).toEqual([hcJob.url, urlCopy.url])

    // A first copy with only a partial description does not stop the search for a complete one.
    const partial = { ...(await fixture('plain-posting.json')), ld: [JSON.stringify({ '@type': 'JobPosting', title: 'X', description: 'Short blurb.' })], text: '' }
    await writeJobFile(ws, { ...(await readJobRaw(hcJob.id)), description: '', descriptionComplete: false })
    await writeJobFile(ws, { ...(await readJobRaw(urlCopy.id)), description: '', descriptionComplete: false })
    requested.length = 0
    const partialFirst = async (url: string): Promise<LoadResult> => {
      requested.push(url)
      return { status: 'ok', data: url === hcJob.url ? { ...partial, url } : { ...posting, url } }
    }
    expect((await fetchDetails(ws, hcJob.id, partialFirst)).descriptionComplete).toBe(true)
    expect(requested).toEqual([hcJob.url, urlCopy.url])

    // A partial description from the first copy is still saved when the next load rejects.
    await writeJobFile(ws, { ...(await readJobRaw(hcJob.id)), description: '', descriptionComplete: false })
    await writeJobFile(ws, { ...(await readJobRaw(urlCopy.id)), description: '', descriptionComplete: false })
    const partialThenThrow = async (url: string): Promise<LoadResult> => {
      if (url === urlCopy.url) throw new Error('The page closed.')
      return { status: 'ok', data: { ...partial, url } }
    }
    const kept = await fetchDetails(ws, hcJob.id, partialThenThrow)
    expect(kept.description).toBe('Short blurb.')
    expect(kept.descriptionComplete).toBe(false)

    // When every copy fails, the last failure is reported.
    await saveJob(ws, { ...parseHiringCafeHits({ hits: hc.props.pageProps.ssrHits })[1] })
    const other = parseHiringCafeHits({ hits: hc.props.pageProps.ssrHits })[1]
    await expect(
      fetchDetails(ws, other.id, async () => ({ status: 'error', message: 'timed out.' }))
    ).rejects.toThrow(/timed out\. The summary from the job board is kept/)
  })

  it('validates queries', () => {
    expect(() => validateQuery({ keywords: ' ', sources: ['indeed'] })).toThrow(/keywords/)
    expect(() => validateQuery({ keywords: 'x', sources: ['monster'] })).toThrow(/job board/)
  })
})
