import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canRefetchDetails, jobDescriptionFor, JOBRIGHT_SUMMARY_NOTE, tailorPrefillFor, type Job } from '@shared/jobs-types'
import type { LoadResult } from './loader'
import { fetchDetails, JOBRIGHT_HUMAN_CHECK } from './service'
import { JOBRIGHT_POSTING_EXTRACT, jobrightSummaryOf } from './sources/jobright'
import { parsePosting, POSTING_EXTRACT, type PageData } from './sources/posting'
import { canonicalize, findCanonical, mergeJob, readJob, saveJob } from './store'

/** Jobright's summary when the employer's page is only an application form (#148). */

const ID = '6ada8a3454bbabbab07175fc'
const PAGE = `https://jobright.ai/jobs/info/${ID}`
const EMPLOYER = 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Software-Engineer_R123/apply'

/** Jobright's `jobResult` fields, as a signed-out page has them. */
const JOB_RESULT = {
  jobSummary: 'Acme is hiring a new-grad Software Engineer to build   its payments platform.',
  coreResponsibilities: ['Build Go services for the ledger.', 'Own features end to end.'],
  qualifications: { mustHave: ['BS in Computer Science.', 'Go or Java.'], niceToHave: ['Kubernetes.'] }
}

const SUMMARY = [
  'Acme is hiring a new-grad Software Engineer to build its payments platform.',
  '## Responsibilities\n\n- Build Go services for the ledger.\n- Own features end to end.',
  '## Must have\n\n- BS in Computer Science.\n- Go or Java.',
  '## Nice to have\n\n- Kubernetes.'
].join('\n\n')

const FORM_TEXT =
  'Apply for Software Engineer\nFirst name *\nLast name *\nEmail *\nPhone\nResume/CV * Attach, Dropbox or enter manually\nLinkedIn profile\nAre you legally authorized to work in the United States? *\nWill you now or in the future require sponsorship? *\nSubmit application'

/** What the hidden loader returns for each page kind. */
const formOnly = (url: string): LoadResult => ({
  status: 'ok',
  data: { url, title: 'Apply | Acme Careers', ld: [], text: FORM_TEXT, formText: FORM_TEXT.length - 30 }
})
const fullPosting = (url: string): LoadResult => ({
  status: 'ok',
  data: {
    url,
    title: 'Software Engineer',
    text: '',
    formText: 0,
    ld: [
      JSON.stringify({
        '@type': 'JobPosting',
        title: 'Software Engineer',
        description: `<p>${'Acme builds payment rails for small businesses in forty countries. '.repeat(6)}</p>`
      })
    ]
  }
})
const jobrightPage = (url: string, jobResult: unknown = JOB_RESULT): LoadResult => ({
  status: 'ok',
  data: { url, title: 'Software Engineer - Acme | Jobright', ld: [], text: 'Software Engineer\nAcme\nSign up to apply', jobright: jobrightFields(jobResult) }
})
const jobrightFields = (r: unknown) => {
  const j = r as typeof JOB_RESULT
  return { jobSummary: j.jobSummary, coreResponsibilities: j.coreResponsibilities, mustHave: j.qualifications?.mustHave, niceToHave: j.qualifications?.niceToHave }
}

const jobrightJob = (over: Partial<Job> = {}): Job => ({
  id: `jobright:${ID}`,
  source: 'jobright',
  sourceId: ID,
  title: 'Software Engineer',
  company: 'Acme',
  location: 'New York, NY',
  remote: false,
  salary: '',
  postedAt: '2026-10-21T12:00:00.000Z',
  url: EMPLOYER,
  boardUrl: PAGE,
  description: '',
  descriptionComplete: false,
  tags: [],
  fetchedAt: '2026-10-21T09:30:00.000Z',
  ...over
})

describe("Jobright's summary fields", () => {
  /** Evaluates the extract against a fake page: `next` is the `__NEXT_DATA__` text, `null` for none. */
  const run = (next: string | null, readyState = 'complete') => {
    const main = { innerText: 'Software Engineer\nAcme', querySelectorAll: () => [] }
    const doc = {
      readyState,
      title: 'Software Engineer - Acme | Jobright',
      getElementById: (id: string) => (id === '__NEXT_DATA__' && next !== null ? { textContent: next } : null),
      querySelectorAll: () => [],
      querySelector: () => main,
      body: main
    }
    const out = new Function('document', 'location', `return ${JOBRIGHT_POSTING_EXTRACT}`)(doc, { href: PAGE }) as string | null
    return out === null ? null : JSON.parse(out)
  }
  const next = (pageProps: unknown) => JSON.stringify({ props: { pageProps } })

  it('reads the summary from a signed-out page, along with the posting data', () => {
    const data = run(next({ logined: false, dataSource: { jobResult: JOB_RESULT } }))
    expect(data).toMatchObject({ url: PAGE, ld: [], text: 'Software Engineer\nAcme', formText: 0 })
    expect(jobrightSummaryOf(data)).toBe(SUMMARY)
  })

  it('waits for the Next.js data while the page loads, and gives nothing without it', () => {
    expect(run(null, 'loading')).toBeNull()
    expect(run(null)).toMatchObject({ jobright: {} })
    expect(jobrightSummaryOf(run(null))).toBe('')
    expect(jobrightSummaryOf(run('{not json'))).toBe('')
  })

  it('builds Markdown from whichever fields there are, shape-checked', () => {
    expect(jobrightSummaryOf({ jobright: { coreResponsibilities: ['Ship code.', 42, ''], mustHave: 'not a list' } })).toBe(
      '## Responsibilities\n\n- Ship code.'
    )
    expect(jobrightSummaryOf({ jobright: { jobSummary: { html: 'x' } } })).toBe('')
    expect(jobrightSummaryOf(null)).toBe('')
  })
})

describe('application-form pages (#148)', () => {
  it('a page that is only an application form is not a posting', () => {
    expect(parsePosting((formOnly(EMPLOYER) as { data: PageData }).data)).toBeNull()
  })

  it('a posting with an application form below it still is', () => {
    const description = 'Acme builds payment rails for small businesses in forty countries. '.repeat(4)
    const job = parsePosting({ url: EMPLOYER, title: 'Software Engineer', ld: [], text: `${description}\n${FORM_TEXT}`, formText: FORM_TEXT.length })
    expect(job?.descriptionComplete).toBe(true)
  })

  it('the posting extract counts the text inside forms', () => {
    const main = { innerText: `Intro\n${FORM_TEXT}`, querySelectorAll: (sel: string) => (sel === 'form' ? [{ innerText: FORM_TEXT }] : []) }
    const doc = { title: 'Apply', querySelectorAll: () => [], querySelector: () => main, body: main }
    const out = new Function('document', 'location', `return ${POSTING_EXTRACT}`)(doc, { href: EMPLOYER }) as string
    expect(JSON.parse(out).formText).toBe(FORM_TEXT.length)
  })
})

describe('Fetch full description falls back to Jobright (#148)', () => {
  let ws: string
  let loads: string[]
  const loader =
    (answer: (url: string, extract: string) => LoadResult) =>
    async (url: string, extract: string): Promise<LoadResult> => {
      loads.push(url)
      return answer(url, extract)
    }

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'huntgry-jobright-summary-'))
    loads = []
  })
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true })
  })

  it("uses Jobright's summary when the employer's page is only an application form", async () => {
    await saveJob(ws, jobrightJob())
    const full = await fetchDetails(ws, `jobright:${ID}`, loader((url) => (url === EMPLOYER ? formOnly(url) : jobrightPage(url))))
    // The employer's page first, then the Jobright page.
    expect(loads).toEqual([EMPLOYER, PAGE])
    expect(full).toMatchObject({ description: SUMMARY, descriptionComplete: true, descriptionSource: 'jobright-summary', url: EMPLOYER })
    expect((await readJob(ws, `jobright:${ID}`))?.descriptionSource).toBe('jobright-summary')
    // Tailoring gets the text, with the note; the drawer still offers a new fetch.
    expect(tailorPrefillFor(full)).toMatchObject({ descriptionComplete: true })
    expect(jobDescriptionFor(full)).toContain(JOBRIGHT_SUMMARY_NOTE)
    expect(jobDescriptionFor(full)).toContain('## Must have\n\n- BS in Computer Science.')
    expect(canRefetchDetails(full)).toBe(true)
  })

  it("keeps the employer's description when there is one, and never loads the Jobright page", async () => {
    await saveJob(ws, jobrightJob())
    const full = await fetchDetails(ws, `jobright:${ID}`, loader((url) => (url === EMPLOYER ? fullPosting(url) : jobrightPage(url))))
    expect(loads).toEqual([EMPLOYER])
    expect(full.descriptionComplete).toBe(true)
    expect(full.descriptionSource).toBeUndefined()
    expect(full.description).toContain('Acme builds payment rails')
    expect(jobDescriptionFor(full)).not.toContain(JOBRIGHT_SUMMARY_NOTE)
  })

  it('takes the summary over a shorter partial description, not over a longer one', async () => {
    const partial = (text: string) => (url: string): LoadResult => ({
      status: 'ok',
      data: { url, title: 'Software Engineer', text: '', ld: [JSON.stringify({ '@type': 'JobPosting', title: 'Software Engineer', description: text })] }
    })
    await saveJob(ws, jobrightJob())
    const short = await fetchDetails(ws, `jobright:${ID}`, loader((url) => (url === EMPLOYER ? partial('Build payments.')(url) : jobrightPage(url))))
    expect(short).toMatchObject({ description: SUMMARY, descriptionSource: 'jobright-summary' })

    await saveJob(ws, { ...jobrightJob(), id: 'jobright:other', sourceId: 'other', description: '', descriptionComplete: false })
    const long = 'Acme pays well. '.repeat(12).trim()
    expect(long.length).toBeLessThanOrEqual(200)
    const kept = await fetchDetails(
      ws,
      'jobright:other',
      loader((url) => (url === EMPLOYER ? partial(long)(url) : jobrightPage(url, { jobSummary: 'Acme is hiring.' })))
    )
    expect(kept).toMatchObject({ description: long, descriptionComplete: false })
    expect(kept.descriptionSource).toBeUndefined()
  })

  it('reads a Jobright page still linked as the job (#142) once, for the page and the summary', async () => {
    await saveJob(ws, jobrightJob({ url: PAGE }))
    const extracts: string[] = []
    const full = await fetchDetails(
      ws,
      `jobright:${ID}`,
      loader((url, extract) => {
        extracts.push(extract)
        return jobrightPage(url)
      })
    )
    expect(loads).toEqual([PAGE])
    expect(extracts).toEqual([JOBRIGHT_POSTING_EXTRACT])
    expect(full).toMatchObject({ description: SUMMARY, descriptionSource: 'jobright-summary' })
  })

  it("a Jobright page's own human check still says so, without a second load", async () => {
    await saveJob(ws, jobrightJob({ url: PAGE }))
    await expect(
      fetchDetails(ws, `jobright:${ID}`, loader(() => ({ status: 'blocked', message: 'jobright.ai asked for a human check.' })))
    ).rejects.toThrow(JOBRIGHT_HUMAN_CHECK)
    expect(loads).toEqual([PAGE])
  })

  it("reports the employer page's failure when the Jobright page gives no summary either", async () => {
    await saveJob(ws, jobrightJob())
    await expect(
      fetchDetails(ws, `jobright:${ID}`, loader((url) => (url === EMPLOYER ? formOnly(url) : { status: 'blocked', message: 'Human check.' })))
    ).rejects.toThrow(/employer's page did not have a readable description/)
    await expect(
      fetchDetails(ws, `jobright:${ID}`, loader((url) => (url === EMPLOYER ? formOnly(url) : jobrightPage(url, {}))))
    ).rejects.toThrow(/employer's page did not have a readable description/)
    expect((await readJob(ws, `jobright:${ID}`))?.description).toBe('')
  })

  it("a later fetch that finds the employer's posting replaces the summary and its marker", async () => {
    await saveJob(ws, jobrightJob())
    await fetchDetails(ws, `jobright:${ID}`, loader((url) => (url === EMPLOYER ? formOnly(url) : jobrightPage(url))))
    loads = []
    const full = await fetchDetails(ws, `jobright:${ID}`, loader((url) => fullPosting(url)))
    expect(loads).toEqual([EMPLOYER])
    expect(full.description).toContain('Acme builds payment rails')
    expect(full.descriptionSource).toBeUndefined()
    expect(canRefetchDetails(full)).toBe(false)
    expect('descriptionSource' in ((await readJob(ws, `jobright:${ID}`)) ?? {})).toBe(false)
  })

  it('a job merged from several boards prefers the posting over the summary', async () => {
    const summary = jobrightJob({ description: SUMMARY, descriptionComplete: true, descriptionSource: 'jobright-summary' })
    const url: Job = {
      ...jobrightJob(),
      id: 'url:abc',
      source: 'url',
      sourceId: 'abc',
      boardUrl: null,
      description: 'The posting. '.repeat(20),
      descriptionComplete: true,
      fetchedAt: '2026-10-22T09:30:00.000Z'
    }
    const [merged] = canonicalize([summary, url])
    expect(merged.description).toBe(url.description)
    expect(merged.descriptionSource).toBeUndefined()
    const [alone] = canonicalize([summary, { ...url, description: 'Snippet.', descriptionComplete: false }])
    expect(alone.descriptionSource).toBe('jobright-summary')
    await saveJob(ws, summary)
    expect((await findCanonical(ws, summary.id))?.descriptionSource).toBe('jobright-summary')
  })

  it('a re-saved board copy without a description keeps the summary and its marker', () => {
    const saved = jobrightJob({ description: SUMMARY, descriptionComplete: true, descriptionSource: 'jobright-summary' })
    expect(mergeJob(saved, jobrightJob())).toMatchObject({ description: SUMMARY, descriptionSource: 'jobright-summary' })
    const replaced = mergeJob(saved, jobrightJob({ description: 'The posting. '.repeat(20), descriptionComplete: true }))
    expect(replaced.descriptionSource).toBeUndefined()
  })
})
