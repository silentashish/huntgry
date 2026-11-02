import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Fetcher } from '../cli/posting'
import type { LoadResult } from './loader'
import { getPublicJson, MAX_JSON_BYTES, type JsonFetcher, type JsonResult } from './public-json'
import { addByUrl, fetchDetails, ORACLE_UNREACHABLE } from './service'
import {
  ORACLE_PAGE_EXTRACT,
  oracleApiOrigin,
  oracleRef,
  requisitionUrl,
  type OraclePage
} from './sources/oracle'
import { POSTING_EXTRACT } from './sources/posting'
import { readJob } from './store'

/** Oracle HCM Candidate Experience postings, read from the requisition API (#191). */

const AMEX = 'https://careers.americanexpress.com/en/sites/CX_1/job/26014651/?utm_medium=career+site&utm_source=job+alert'
const AMEX_CLEAN = 'https://careers.americanexpress.com/en/sites/CX_1/job/26014651/'
const TENANT = 'https://egug.fa.us2.oraclecloud.com'
const API = `${TENANT}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%2226014651%22,siteNumber=CX_1`

const fixture = (name: string) => readFile(join(__dirname, 'fixtures', name), 'utf8')

/** Runs a loader extract in a parsed page (jsdom has no layout, so `innerText` is the text content). */
async function extract(html: string, expression: string, url: string): Promise<OraclePage> {
  const dom = new JSDOM(html, { url })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    get(this: HTMLElement) {
      return this.textContent ?? ''
    }
  })
  const out = new Function('document', 'location', `return ${expression}`)(dom.window.document, dom.window.location)
  return JSON.parse(out as string) as OraclePage
}

let ws: string
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-oracle-'))
})
afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
})

/** A hidden-window loader serving the saved shell (as the extract reads it), recording what it was asked for. */
async function shellLoader(html?: string) {
  const shell = html ?? (await fixture('oracle-ce-shell.html'))
  const calls: string[] = []
  const load = async (url: string, expression: string): Promise<LoadResult> => {
    calls.push(url)
    return { status: 'ok', data: await extract(shell, expression, url) }
  }
  return { load, calls }
}

/** A JSON API stub answering one URL, recording every URL it was asked for. */
function jsonStub(answers: Record<string, JsonResult>, allowLoopback = false) {
  const calls: string[] = []
  const json: JsonFetcher = async (url) => {
    calls.push(url)
    return answers[url] ?? { status: 'error', httpStatus: 404, message: `${new URL(url).host} answered HTTP 404.` }
  }
  json.allowLoopback = allowLoopback
  return { json, calls }
}

describe('Oracle Candidate Experience URLs', () => {
  it('recognises postings on a custom domain and on oraclecloud.com, with or without a language and query', () => {
    expect(oracleRef(AMEX)).toEqual({ siteNumber: 'CX_1', jobId: '26014651', apiOrigin: null })
    expect(oracleRef('https://careers.example.com/sites/CX/job/12')).toMatchObject({ siteNumber: 'CX', jobId: '12' })
    expect(
      oracleRef('https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26014651?src=x')
    ).toEqual({ siteNumber: 'CX_1', jobId: '26014651', apiOrigin: TENANT })
    expect(oracleRef('https://EGUG.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions/preview/7')).toEqual({
      siteNumber: 'CX_1',
      jobId: '7',
      apiOrigin: TENANT
    })
    // Over plain http, Oracle's host is not taken from the URL (the page is read for it, and it must be https).
    expect(oracleRef('http://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/1')?.apiOrigin).toBeNull()
    for (const url of [
      'https://careers.example.com/en/sites/CX_1/jobs',
      'https://careers.example.com/en/sites/CX_1/job/abc',
      'https://careers.example.com/job/26014651',
      'ftp://careers.example.com/en/sites/CX_1/job/1',
      'not a url'
    ])
      expect(oracleRef(url), url).toBeNull()
  })

  it('calls only an https *.oraclecloud.com API host named by a page', () => {
    expect(oracleApiOrigin('https://egug.fa.us2.oraclecloud.com:443')).toBe(TENANT)
    expect(oracleApiOrigin('https://EGUG.fa.us2.oraclecloud.com/')).toBe(TENANT)
    for (const bad of [
      'http://egug.fa.us2.oraclecloud.com',
      'https://egug.fa.us2.oraclecloud.com:8443',
      'https://oraclecloud.com.evil.example',
      'https://evil.example/egug.fa.us2.oraclecloud.com',
      'https://user:pw@egug.fa.us2.oraclecloud.com',
      'https://127.0.0.1',
      'https://10.0.0.5',
      'javascript:alert(1)',
      ''
    ])
      expect(oracleApiOrigin(bad), bad).toBeNull()
    // Loopback only with the dev builds' mock-server allowance.
    expect(oracleApiOrigin('http://127.0.0.1:4100')).toBeNull()
    expect(oracleApiOrigin('http://127.0.0.1:4100', true)).toBe('http://127.0.0.1:4100')
    expect(oracleApiOrigin('http://10.0.0.5:4100', true)).toBeNull()
  })

  it('builds the requisition-details call the Candidate Experience app makes', () => {
    expect(requisitionUrl(TENANT, oracleRef(AMEX)!)).toBe(API)
  })

  it('reads the Oracle host, title and company from the shell page', async () => {
    const page = await extract(await fixture('oracle-ce-shell.html'), ORACLE_PAGE_EXTRACT, AMEX)
    expect(page.oracleHosts?.[0]).toBe('https://egug.fa.us2.oraclecloud.com:443')
    expect(page.og).toMatchObject({
      title: 'Senior AI Engineer II - Forward Deployed Engineer - Enterprise AI Platforms',
      siteName: 'American Express'
    })
    expect(page.og?.description).toMatch(/^Why Join American Express/)
    // The shell has no JSON-LD and no description: the bug (#191).
    expect(page.ld).toEqual([])
    expect((await extract(await fixture('oracle-ce-shell.html'), POSTING_EXTRACT, AMEX)).text.length).toBeLessThan(200)
  })
})

describe('adding an Oracle Candidate Experience posting by URL', () => {
  it('saves the job from the requisition API on the host the page names, without tracking parameters', async () => {
    const { load } = await shellLoader()
    const { json, calls } = jsonStub({ [API]: { status: 'ok', data: JSON.parse(await fixture('oracle-ce-requisition.json')) } })
    const job = await addByUrl(ws, AMEX, load, json)
    expect(calls).toEqual([API])
    expect(job).toMatchObject({
      source: 'url',
      title: 'Senior AI Engineer II - Forward Deployed Engineer - Enterprise AI Platforms',
      company: 'American Express',
      location: 'New York, NY, United States / Sunnyvale, CA, United States / Phoenix, AZ, United States',
      remote: false,
      salary: '$123000 - $215250 annually + bonus + benefits',
      postedAt: '2026-10-28T11:17:46.000Z',
      url: AMEX_CLEAN,
      descriptionComplete: true
    })
    // HTML → text like the other sources: the description, then the responsibilities and qualifications.
    expect(job.description).toMatch(/^Why Join American Express\n\nJoining Amex Tech means/)
    expect(job.description).toContain('\n\n## Responsibilities\n\nOpportunity discovery and transformation\n\n- Build trusted')
    expect(job.description).toContain('\n\n## Qualifications\n\n- 5 or more years of experience')
    expect(job.description).not.toMatch(/<[a-z]|&nbsp;/i)
    expect(await readJob(ws, job.id)).toMatchObject({ url: AMEX_CLEAN, descriptionComplete: true })
  })

  it('maps the workplace type', async () => {
    const data = JSON.parse(await fixture('oracle-ce-requisition.json'))
    const { load } = await shellLoader()
    for (const [code, type, expected] of [
      ['ORA_REMOTE', 'Remote', 'Remote'],
      ['ORA_HYBRID', 'Hybrid', 'Hybrid'],
      ['ORA_ON_SITE', 'On-site', 'Onsite']
    ] as const) {
      data.items[0].WorkplaceTypeCode = code
      data.items[0].WorkplaceType = type
      const { json } = jsonStub({ [API]: { status: 'ok', data } })
      const job = await addByUrl(ws, AMEX, load, json)
      expect(job.workplaceType).toBe(expected)
      expect(job.remote).toBe(expected === 'Remote')
    }
  })

  it('calls the oraclecloud.com host of the URL itself, even when its page does not load', async () => {
    const url = `${TENANT}/hcmUI/CandidateExperience/en/sites/CX_1/job/26014651`
    const load = async (): Promise<LoadResult> => ({ status: 'error', message: 'egug.fa.us2.oraclecloud.com did not return job data in time.' })
    const { json, calls } = jsonStub({ [API]: { status: 'ok', data: JSON.parse(await fixture('oracle-ce-requisition.json')) } })
    const job = await addByUrl(ws, url, load, json)
    expect(calls).toEqual([API])
    expect(job).toMatchObject({ url, descriptionComplete: true, company: '' })
  })

  it('says the job closed when the API has no such job, and offers Paste', async () => {
    const { load } = await shellLoader()
    const { json } = jsonStub({ [API]: { status: 'ok', data: { items: [], count: 0 } } })
    await expect(addByUrl(ws, AMEX, load, json)).rejects.toThrow(
      'This job is no longer posted on American Express: it has probably closed. Paste the job description instead.'
    )
  })

  it('does not call a malformed answer a closed job', async () => {
    const shell = (await fixture('oracle-ce-shell.html')).replace(/<meta property="og:[^>]*>/g, '')
    const { json } = jsonStub({ [API]: { status: 'ok', data: { title: 'Error', status: '500' } } })
    await expect(addByUrl(ws, AMEX, (await shellLoader(shell)).load, json)).rejects.toThrow(
      "The careers site's job service could not be reached. Its answer was not a job list. Paste the job description instead."
    )
  })

  it("falls back to the page's Open Graph title and description, incomplete, when the API is unavailable", async () => {
    const { load } = await shellLoader()
    const { json } = jsonStub({ [API]: { status: 'error', httpStatus: 503, message: 'egug.fa.us2.oraclecloud.com answered HTTP 503.' } })
    const job = await addByUrl(ws, AMEX, load, json)
    expect(job).toMatchObject({
      title: 'Senior AI Engineer II - Forward Deployed Engineer - Enterprise AI Platforms',
      company: 'American Express',
      url: AMEX_CLEAN,
      descriptionComplete: false
    })
    expect(job.description).toMatch(/^Why Join American Express.*\.\.\.$/s)
  })

  it('says the site is not reachable, and offers Paste, when neither the API nor the page has the job', async () => {
    const shell = (await fixture('oracle-ce-shell.html')).replace(/<meta property="og:[^>]*>/g, '')
    const { load } = await shellLoader(shell)
    const { json } = jsonStub({})
    await expect(addByUrl(ws, AMEX, load, json)).rejects.toThrow(
      "The careers site's job service could not be reached. egug.fa.us2.oraclecloud.com answered HTTP 404. Paste the job description instead."
    )
  })

  it('never calls a host the page names that is not https *.oraclecloud.com', async () => {
    const shell = (await fixture('oracle-ce-shell.html')).replaceAll('https://egug.fa.us2.oraclecloud.com', 'https://evil.example')
    const { load } = await shellLoader(shell)
    const { json, calls } = jsonStub({})
    // No Oracle host: the page is read like any posting, and the shell has none.
    await expect(addByUrl(ws, AMEX, load, json)).rejects.toThrow('No job posting was found on that page.')
    expect(calls).toEqual([])
    // A loopback host only with the dev builds' allowance (the e2e mock server).
    const local = (await fixture('oracle-ce-shell.html')).replaceAll('https://egug.fa.us2.oraclecloud.com:443', 'http://127.0.0.1:4100')
    const strict = jsonStub({})
    await addByUrl(ws, AMEX, (await shellLoader(local)).load, strict.json)
    // The loopback base is skipped; the footer's oraclecloud.com link is the host then.
    expect(strict.calls).toEqual([API])
    const dev = jsonStub({}, true)
    await addByUrl(ws, AMEX, (await shellLoader(local)).load, dev.json)
    expect(dev.calls[0]).toMatch(/^http:\/\/127\.0\.0\.1:4100\/hcmRestApi\//)
  })

  it('reports a human check on the page as before', async () => {
    const load = async (): Promise<LoadResult> => ({ status: 'blocked', message: 'careers.americanexpress.com asked for a human check (x).' })
    await expect(addByUrl(ws, AMEX, load, jsonStub({}).json)).rejects.toThrow(/human check.*Paste the job description/)
  })

  it('Fetch full description completes a job saved from the Open Graph fallback', async () => {
    const { load } = await shellLoader()
    const down = jsonStub({})
    const partial = await addByUrl(ws, AMEX, load, down.json)
    expect(partial.descriptionComplete).toBe(false)
    const data = JSON.parse(await fixture('oracle-ce-requisition.json'))
    Object.assign(data.items[0], { WorkplaceTypeCode: 'ORA_REMOTE', WorkplaceType: 'Remote' })
    const up = jsonStub({ [API]: { status: 'ok', data } })
    const full = await fetchDetails(ws, partial.id, load, up.json)
    expect(up.calls).toEqual([API])
    expect(full.descriptionComplete).toBe(true)
    expect(full.description).toContain('## Qualifications')
    expect(full.location).toMatch(/^New York, NY/)
    // The API's facts are kept too, not only the description: a complete job is not fetched again.
    expect(full).toMatchObject({ postedAt: '2026-10-28T11:17:46.000Z', remote: true, workplaceType: 'Remote' })
    expect(await readJob(ws, partial.id)).toMatchObject({ postedAt: '2026-10-28T11:17:46.000Z', remote: true, workplaceType: 'Remote' })
  })
})

describe('getPublicJson', () => {
  const PUBLIC = async () => ['203.0.113.10']
  const respond =
    (res: () => Response, seen: { url: string; addresses: readonly string[]; headers: Record<string, string> }[] = []): Fetcher =>
    async (url, init) => {
      seen.push({ url, addresses: init.addresses, headers: init.headers })
      return res()
    }

  it('connects to the checked public address, sends no cookie, and parses JSON', async () => {
    const seen: { url: string; addresses: readonly string[]; headers: Record<string, string> }[] = []
    const fetcher = respond(() => new Response('{"items":[]}', { status: 200 }), seen)
    expect(await getPublicJson(API, { fetcher, resolve: PUBLIC })).toEqual({ status: 'ok', data: { items: [] } })
    expect(seen).toEqual([{ url: API, addresses: ['203.0.113.10'], headers: expect.objectContaining({ accept: 'application/json' }) }])
    expect(Object.keys(seen[0].headers).map((h) => h.toLowerCase())).not.toContain('cookie')
  })

  it('refuses private and loopback addresses before any request', async () => {
    let called = false
    const fetcher: Fetcher = async () => {
      called = true
      return new Response('{}')
    }
    const r1 = await getPublicJson(API, { fetcher, resolve: async () => ['10.1.2.3'] })
    expect(r1).toMatchObject({ status: 'error', message: expect.stringMatching(/private-network/) })
    const r2 = await getPublicJson('http://127.0.0.1:9/x', { fetcher, resolve: PUBLIC })
    expect(r2.status).toBe('error')
    // The e2e harness's restriction: a public name is refused before any lookup.
    const r3 = await getPublicJson(API, { fetcher, resolve: PUBLIC, loopbackOnly: true })
    expect(r3).toMatchObject({ status: 'error', message: expect.stringMatching(/only reach loopback/) })
    expect(called).toBe(false)
    // Loopback with the dev allowance, pinned to the literal.
    const seen: { url: string; addresses: readonly string[]; headers: Record<string, string> }[] = []
    const ok = await getPublicJson('http://localhost:4100/x', {
      fetcher: respond(() => new Response('[]'), seen),
      allowLoopback: true,
      loopbackOnly: true
    })
    expect(ok.status).toBe('ok')
    expect(seen[0].addresses).toEqual(['127.0.0.1'])
  })

  it('does not follow redirects, and caps the body', async () => {
    const redirect = respond(() => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }))
    expect(await getPublicJson(API, { fetcher: redirect, resolve: PUBLIC })).toEqual({
      status: 'error',
      httpStatus: 302,
      message: 'egug.fa.us2.oraclecloud.com answered HTTP 302.'
    })
    const huge = respond(() => new Response(new Uint8Array(MAX_JSON_BYTES + 1)))
    expect(await getPublicJson(API, { fetcher: huge, resolve: PUBLIC })).toMatchObject({ message: /unexpectedly large/ })
    const html = respond(() => new Response('<html>'))
    expect(await getPublicJson(API, { fetcher: html, resolve: PUBLIC })).toMatchObject({ message: /did not answer with JSON/ })
    const down: Fetcher = async () => {
      throw new Error('ECONNRESET')
    }
    expect(await getPublicJson(API, { fetcher: down, resolve: PUBLIC })).toMatchObject({
      message: 'Could not reach egug.fa.us2.oraclecloud.com.'
    })
  })

  it('gives up after the timeout', async () => {
    const hang: Fetcher = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    expect(await getPublicJson(API, { fetcher: hang, resolve: PUBLIC, timeoutMs: 20 })).toMatchObject({ status: 'error' })
  })
})

it('keeps a saved Oracle job, and says why, when Fetch full description finds the job service still down', async () => {
  const { load } = await shellLoader()
  const partial = await addByUrl(ws, AMEX, load, jsonStub({}).json)
  await expect(fetchDetails(ws, partial.id, load, jsonStub({}).json)).rejects.toThrow(ORACLE_UNREACHABLE)
  expect(await readJob(ws, partial.id)).toEqual(partial)
})
