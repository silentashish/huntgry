import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
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

/** An application form's fields; `labels` long ones push the form past any length limit. */
const formFields = (labels = '') => `
<p><label for="fn">First name *</label> <input id="fn"></p>
<p><label for="ln">Last name *</label> <input id="ln"></p>
<p><label for="em">Email *</label> <input id="em" type="email"></p>
<p><label for="cv">Resume/CV * (PDF, DOC or DOCX, up to 5 MB)</label> <input id="cv" type="file"></p>
<p><label for="au">Are you legally authorized to work in the United States? *</label> <select id="au"><option>Yes</option><option>No</option></select></p>
<p><label for="sp">Will you now or in the future require visa sponsorship? *</label> <select id="sp"><option>Yes</option><option>No</option></select></p>
${labels}<button type="submit">Submit application</button>`

const DESCRIPTION = 'Acme builds payment rails for small businesses in forty countries, and the ledger team keeps every cent accounted for. '.repeat(5)

/** Runs a loader extract in a parsed page (jsdom has no layout, so `innerText` is the text content). */
async function extract(html: string, expression: string, url = EMPLOYER): Promise<Record<string, unknown> | null> {
  const dom = new JSDOM(html, { url })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    get(this: HTMLElement) {
      return this.textContent ?? ''
    }
  })
  if (dom.window.document.readyState !== 'complete') await new Promise((r) => dom.window.addEventListener('load', r))
  const out = new Function('document', 'location', `return ${expression}`)(dom.window.document, dom.window.location) as string | null
  return out === null ? null : JSON.parse(out)
}

const page = (body: string, head = '') =>
  `<!DOCTYPE html><html><head><title>Software Engineer | Acme Careers</title>${head}</head><body>${body}</body></html>`
const FORM_ONLY = page(`<main><h1>Apply: Software Engineer</h1><form>${formFields()}</form></main>`)

/** What the hidden loader returns for each page kind. */
let formOnlyData: Record<string, unknown>
const formOnly = (): LoadResult => ({ status: 'ok', data: formOnlyData })
const fullPosting = (url: string): LoadResult => ({
  status: 'ok',
  data: {
    url,
    title: 'Software Engineer',
    text: '',
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
  /** A Jobright page: `next` is the `__NEXT_DATA__` text, `null` for none. */
  const run = (next: string | null) =>
    extract(
      page(
        '<main><h1>Software Engineer</h1>\n<p>Acme</p></main>' +
          (next === null ? '' : `<script id="__NEXT_DATA__" type="application/json">${next}</script>`)
      ),
      JOBRIGHT_POSTING_EXTRACT,
      PAGE
    )
  const next = (pageProps: unknown) => JSON.stringify({ props: { pageProps } })

  it('reads the summary from a signed-out page, along with the posting data', async () => {
    const data = await run(next({ logined: false, dataSource: { jobResult: JOB_RESULT } }))
    expect(data).toMatchObject({ url: PAGE, ld: [], prose: 'Software Engineer Acme' })
    expect(jobrightSummaryOf(data)).toBe(SUMMARY)
  })

  it('waits for the Next.js data while the page loads, and gives nothing without it', async () => {
    const loading = { readyState: 'loading', getElementById: () => null }
    expect(new Function('document', `return ${JOBRIGHT_POSTING_EXTRACT}`)(loading)).toBeNull()
    expect(await run(null)).toMatchObject({ jobright: {} })
    expect(jobrightSummaryOf(await run(null))).toBe('')
    expect(jobrightSummaryOf(await run('{not json'))).toBe('')
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
  const posting = async (html: string) => parsePosting((await extract(html, POSTING_EXTRACT)) as unknown as PageData)

  it('a page that is only an application form is not a posting, however long its labels', async () => {
    const data = (await extract(FORM_ONLY, POSTING_EXTRACT))!
    expect((data.text as string).length).toBeGreaterThan(200)
    expect(data.prose).toBe('Apply: Software Engineer')
    expect(parsePosting(data as unknown as PageData)).toBeNull()
  })

  it('a posting with an application form below it still is', async () => {
    const job = await posting(page(`<main><h1>Software Engineer</h1><p>${DESCRIPTION}</p><form>${formFields()}</form></main>`))
    expect(job?.descriptionComplete).toBe(true)
    expect(job?.description).toContain('ledger team')
  })

  it('so is a description inside the form, next to the application fields', async () => {
    const job = await posting(page(`<main><form><section><h1>Software Engineer</h1><p>${DESCRIPTION}</p></section>${formFields()}</form></main>`))
    expect(job?.descriptionComplete).toBe(true)
    expect(job?.description).toContain('ledger team')
  })

  it('and a description followed by a form longer than the text limit', async () => {
    const labels = Array.from({ length: 700 }, (_, i) => `<p><label for="q${i}">${'Tell us about a project you are proud of. '.repeat(2)}</label> <textarea id="q${i}"></textarea></p>`).join('')
    const data = (await extract(page(`<main><h1>Software Engineer</h1><p>${DESCRIPTION}</p><form>${formFields(labels)}</form></main>`), POSTING_EXTRACT))!
    expect((data.text as string).length).toBe(60000)
    expect(parsePosting(data as unknown as PageData)?.descriptionComplete).toBe(true)
  })

  it('pages read before #148 (no prose) are judged by their text, as before', () => {
    expect(parsePosting({ url: EMPLOYER, title: 'Software Engineer', ld: [], text: DESCRIPTION })?.descriptionComplete).toBe(true)
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
    formOnlyData = (await extract(FORM_ONLY, POSTING_EXTRACT))!
    ws = await mkdtemp(join(tmpdir(), 'huntgry-jobright-summary-'))
    loads = []
  })
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true })
  })

  it("uses Jobright's summary when the employer's page is only an application form", async () => {
    await saveJob(ws, jobrightJob())
    const full = await fetchDetails(ws, `jobright:${ID}`, loader((url) => (url === EMPLOYER ? formOnly() : jobrightPage(url))))
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

  it("keeps an employer description that sits inside the application form (no JSON-LD)", async () => {
    await saveJob(ws, jobrightJob())
    const html = page(`<main><form><section><h1>Software Engineer</h1><p>${DESCRIPTION}</p></section>${formFields()}</form></main>`)
    const data = (await extract(html, POSTING_EXTRACT))!
    const full = await fetchDetails(ws, `jobright:${ID}`, loader((url) => (url === EMPLOYER ? { status: 'ok', data } : jobrightPage(url))))
    expect(loads).toEqual([EMPLOYER])
    expect(full.descriptionSource).toBeUndefined()
    expect(full.description).toContain('ledger team')
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
      fetchDetails(ws, `jobright:${ID}`, loader((url) => (url === EMPLOYER ? formOnly() : { status: 'blocked', message: 'Human check.' })))
    ).rejects.toThrow(/employer's page did not have a readable description/)
    await expect(
      fetchDetails(ws, `jobright:${ID}`, loader((url) => (url === EMPLOYER ? formOnly() : jobrightPage(url, {}))))
    ).rejects.toThrow(/employer's page did not have a readable description/)
    expect((await readJob(ws, `jobright:${ID}`))?.description).toBe('')
  })

  it("a later fetch that finds the employer's posting replaces the summary and its marker", async () => {
    await saveJob(ws, jobrightJob())
    await fetchDetails(ws, `jobright:${ID}`, loader((url) => (url === EMPLOYER ? formOnly() : jobrightPage(url))))
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
