import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_FILTERS, matchesLocation } from '@shared/job-filters'
import { DEFAULT_JOBS_PREFS } from '@shared/jobs-prefs'
import { jobDescriptionFor, type Job } from '@shared/jobs-types'
import { isBlockedPage } from './blocked'
import type { LoadResult } from './loader'
import { prefsPath, readPrefs, updatePrefs } from './prefs'
import { addByUrl, addPasted, fetchDetails, updateJob } from './service'
import { findJobPosting, isoDate, parsePosting, urlJobId, type PageData } from './sources/posting'
import { canonicalize, canonicalKey, jobFileName, listJobs, mergeJob, saveJob, writeJobFile } from './store'
import { htmlToText } from './text'

const fixture = async (name: string) => JSON.parse(await readFile(join(__dirname, 'fixtures', name), 'utf8'))

let ws: string
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-jobs-'))
})
afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
})

describe('matchesLocation', () => {
  it('matches the city of a location, and remote jobs anywhere', () => {
    expect(matchesLocation({ location: 'Herndon, Virginia, United States', remote: false }, 'Atlanta, GA')).toBe(false)
    expect(matchesLocation({ location: 'Atlanta, Georgia, United States', remote: false }, 'Atlanta, GA')).toBe(true)
    expect(matchesLocation({ location: 'Anywhere', remote: true }, 'Atlanta, GA')).toBe(true)
    expect(matchesLocation({ location: 'Herndon', remote: false }, '')).toBe(true)
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

  it('keeps the known structured facts of a job found on two boards (#73)', () => {
    const indeed = base({ id: 'indeed:9', title: 'Backend Engineer', company: 'Acme', location: 'Remote' })
    const hc = base({
      id: 'hiring.cafe:9',
      source: 'hiring.cafe',
      title: 'Backend Engineer',
      company: 'Acme',
      location: 'Remote',
      fetchedAt: '2026-09-05T00:00:00Z',
      visaSponsorship: true,
      seniority: 'Senior Level',
      workplaceType: 'Remote',
      salaryMin: 100,
      salaryMax: 200
    })
    const [job] = canonicalize([indeed, hc])
    // The Indeed copy was saved first and stays canonical, but the facts come from hiring.cafe.
    expect(job).toMatchObject({
      id: 'indeed:9',
      visaSponsorship: true,
      seniority: 'Senior Level',
      workplaceType: 'Remote',
      salaryMin: 100,
      salaryMax: 200
    })
    // A copy that says `true` wins over one that says `false`, whichever is canonical.
    const [both] = canonicalize([
      { ...indeed, visaSponsorship: false },
      { ...hc, visaSponsorship: true }
    ])
    expect(both.visaSponsorship).toBe(true)
    // Old records without the fields stay without them.
    const [old] = canonicalize([indeed, { ...hc, visaSponsorship: undefined, seniority: undefined, workplaceType: undefined, salaryMin: undefined, salaryMax: undefined }])
    expect(old).not.toHaveProperty('visaSponsorship')
    expect(old).not.toHaveProperty('seniority')
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

  /** A job saved by the board search removed in #78; workspaces may still hold some. */
  const legacy = (over: Partial<Job>): Job => ({
    id: 'hiring.cafe:adp___1___594192',
    source: 'hiring.cafe',
    sourceId: 'adp___1___594192',
    title: 'Senior Platform Engineer',
    company: 'NS2 Mission',
    location: 'Herndon, Virginia, United States',
    remote: false,
    salary: '',
    postedAt: '2026-09-30T00:00:00Z',
    url: 'https://careers.example.com/ns2/594192',
    boardUrl: null,
    description: 'A summary.',
    descriptionComplete: false,
    tags: [],
    fetchedAt: '2030-01-01T00:00:00Z',
    ...over
  })
  const indeedCopy = (over: Partial<Job> = {}): Job =>
    legacy({
      id: 'indeed:2bd2cff5c29c9fca',
      source: 'indeed',
      sourceId: '2bd2cff5c29c9fca',
      location: 'Herndon, VA',
      url: 'https://www.indeed.com/viewjob?jk=2bd2cff5c29c9fca',
      ...over
    })

  it('fetches full details for a saved board job from the employer page', async () => {
    const job = await saveJob(ws, legacy({}))
    const posting = await fixture('jsonld-posting.json')
    pages[job.url] = { status: 'ok', data: { ...posting, url: job.url } }
    const full = await fetchDetails(ws, job.id, load)
    expect(full.descriptionComplete).toBe(true)
    expect(full.description).toContain('routing platform')
    expect(full.company).toBe('NS2 Mission')
  })

  it('adds by URL, adds pasted text, marks tailored/dismissed, and explains saved Indeed details', async () => {
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
    const dismissed = await updateJob(ws, pasted.id, { dismissed: true })
    expect(dismissed.dismissed).toBe(true)
    expect(Date.parse(dismissed.dismissedAt!)).not.toBeNaN()
    // Dismissing again keeps the first time; the Board counts its week from it (#85).
    expect((await updateJob(ws, pasted.id, { dismissed: true })).dismissedAt).toBe(dismissed.dismissedAt)
    expect(mergeJob(dismissed, { ...pasted, dismissed: undefined }).dismissedAt).toBe(dismissed.dismissedAt)
    const restored = await updateJob(ws, pasted.id, { dismissed: false })
    expect(restored.dismissed).toBe(false)
    expect(restored.dismissedAt).toBeUndefined()
    expect(jobDescriptionFor(t)).toMatch(/^# ML Engineer\n\nGlobex\n\nBuild ranking/)

    const indeed = await saveJob(ws, indeedCopy())
    await expect(fetchDetails(ws, indeed.id, load)).rejects.toThrow(/human check/)
  })

  it('lists and updates a job found on two boards as one', async () => {
    const hcJob = legacy({ fetchedAt: '2029-12-31T00:00:00Z' })
    const card = indeedCopy()
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
    const hcJob = legacy({ fetchedAt: '2030-01-02T00:00:00Z' })
    // Saved first, so the Indeed record is the canonical one.
    const card = indeedCopy()
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
    const hcJob = legacy({})
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
    const other = await saveJob(
      ws,
      legacy({ id: 'hiring.cafe:other', sourceId: 'other', title: 'Data Engineer', url: 'https://careers.example.com/other' })
    )
    await expect(
      fetchDetails(ws, other.id, async () => ({ status: 'error', message: 'timed out.' }))
    ).rejects.toThrow(/timed out\. The summary from the job board is kept/)
  })
})

describe('Jobs preferences', () => {
  it('defaults when missing or corrupt, and keeps filter changes', async () => {
    expect(await readPrefs(ws)).toEqual(DEFAULT_JOBS_PREFS)
    await mkdir(join(ws, '.huntgry'), { recursive: true })
    await writeFile(prefsPath(ws), '{ not json')
    expect(await readPrefs(ws)).toEqual(DEFAULT_JOBS_PREFS)

    const filters = { ...DEFAULT_FILTERS, sponsorship: 'only-yes' as const, workplace: ['Remote' as const] }
    await updatePrefs(ws, { filters })
    expect(await readPrefs(ws)).toEqual({ filters })
  })

  it('does not lose a change when two land at once', async () => {
    const remote = { ...DEFAULT_FILTERS, workplace: ['Remote' as const] }
    await Promise.all([updatePrefs(ws, { filters: DEFAULT_FILTERS }), updatePrefs(ws, { filters: remote })])
    expect(await readPrefs(ws)).toEqual({ filters: remote })
  })

  it('ignores the auto-refresh and last-search fields of files written before #78', async () => {
    await mkdir(join(ws, '.huntgry'), { recursive: true })
    await writeFile(
      prefsPath(ws),
      JSON.stringify({ filters: DEFAULT_FILTERS, autoRefresh: false, lastRefreshAt: '2026-10-06T00:00:00Z', lastSearch: null })
    )
    expect(await readPrefs(ws)).toEqual(DEFAULT_JOBS_PREFS)
  })
})
