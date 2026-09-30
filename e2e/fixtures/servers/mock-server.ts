import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createMockAts, sendHtml, type MockAts } from '../../../scripts/mock-ats/server.mjs'
import { EMPLOYER_POSTINGS, hiringCafePage, indeedPage, postingPage } from './pages'

/**
 * One local server per worker, on a free `127.0.0.1` port, standing in for
 * every site the Jobs, Browser and Apply flows reach:
 *
 * - `/?searchState=…`      hiring.cafe-shaped search page (`__NEXT_DATA__.props.pageProps.ssrHits`)
 * - `/jobs?q=…`            Indeed-shaped search page (`window.mosaic.providerData[…jobcards]`), snippets only
 * - `/postings/employer/:id`, `/postings/lever-style`, `/postings/ashby-style`  posting pages
 * - `/bot-wall`            a 403 "Just a moment…" human check
 * - `/page/one`, `/page/two`, `/hang`  plain pages for the browser's history and Stop
 * - `/redirect/lever`      302 to the Lever form on the *other* loopback origin (`localhost`)
 * - `/greenhouse/`, `/lever/`, `/generic/`, `/generic-cover/` + `…/submit` + the thanks pages: the mock ATS
 *   (`scripts/mock-ats/server.mjs`, the same code as `node scripts/mock-ats.mjs`)
 *
 * The app is pointed at it with `HUNTGRY_JOB_BOARD_BASE_URL_*` (see `boardEnv`) and reaches it because the
 * harness sets `HUNTGRY_ALLOW_LOCAL_URLS=1`. Nothing here submits a form: the ATS routes only record what a
 * Submit pressed by the test sent.
 */

export interface MockServer {
  /** `http://127.0.0.1:<port>`, the origin the fixtures and the board overrides use. */
  origin: string
  /** `http://localhost:<port>`: the same server on a different origin, for the redirect case. */
  altOrigin: string
  port: number
  /** Where the ATS routes record the last submission (`last-submission.json`). */
  submissionFile: string
  /** Every request path the server answered, in order. */
  requests: string[]
  /** Environment that points the app's job boards at this server. */
  boardEnv(): Record<string, string>
  close(): Promise<void>
}

/** The committed form fixtures the mock ATS serves. */
export const FIXTURES_DIR = resolve(__dirname, '../../../src/shared/autofill/fixtures')

const read = (name: string) => readFileSync(join(FIXTURES_DIR, name), 'utf8')

/** The generic form with a cover-letter upload added, to exercise `cover.pdf`. */
const genericWithCover = () =>
  read('generic-form.html')
    .replace(/action="[^"]*"/, 'action="/generic-cover/submit"')
    .replace(
      '<p><label for="pf">Portfolio</label>',
      '<p><label for="cl">Cover letter</label> <input id="cl" name="cover_letter" type="file" accept=".pdf"></p>\n  <p><label for="pf">Portfolio</label>'
    )

const BOT_WALL = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Just a moment...</title></head><body>
<h1>Checking your browser before accessing the site.</h1><p>Please verify you are human to continue.</p></body></html>`

const page = (title: string, body: string) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

export async function startMockServer(submissionFile: string): Promise<MockServer> {
  const requests: string[] = []
  const hanging = new Set<ServerResponse>()
  let origin = ''
  let altOrigin = ''
  const ats: MockAts = createMockAts({
    fixturesDir: FIXTURES_DIR,
    submissionFile,
    extraSites: { 'generic-cover': { form: genericWithCover, thanks: '/generic-cover/thanks', thanksPage: () => read('generic-thanks.html') } }
  })

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push(url.pathname + url.search)
    if (url.pathname === '/') {
      const state = url.searchParams.get('searchState')
      if (state) return sendHtml(res, 200, hiringCafePage(state, origin))
      return sendHtml(res, 200, ats.index())
    }
    if (url.pathname === '/jobs') return sendHtml(res, 200, indeedPage(url.searchParams.get('q') ?? ''))
    if (url.pathname.startsWith('/postings/')) {
      const html = postingPage(url.pathname.slice('/postings/'.length), origin)
      return html ? sendHtml(res, 200, html) : sendHtml(res, 404, 'Not found')
    }
    if (url.pathname === '/bot-wall') return sendHtml(res, 403, BOT_WALL)
    if (url.pathname === '/page/one') {
      return sendHtml(res, 200, page('Mock page one', '<h1>Page one</h1><p><a href="/page/two" id="next">Go to page two</a></p>'))
    }
    if (url.pathname === '/page/two') {
      return sendHtml(res, 200, page('Mock page two', '<h1>Page two</h1><p><a href="/page/one" id="prev">Back to page one</a></p>'))
    }
    if (url.pathname === '/hang') {
      // Headers and a partial body, never the end: the tab stays "loading" until Stop is pressed.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.write('<!DOCTYPE html><html><head><title>Still loading</title></head><body><p>This page never finishes.</p>')
      hanging.add(res)
      res.on('close', () => hanging.delete(res))
      return
    }
    if (url.pathname === '/redirect/lever') return sendHtml(res, 302, '', { location: `${altOrigin}/lever/` })
    if (ats.handle(req, res)) return
    sendHtml(res, 404, 'Not found')
  }

  const server: Server = createServer(handle)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('The mock server has no port.')
  const port = address.port
  origin = `http://127.0.0.1:${port}`
  altOrigin = `http://localhost:${port}`
  return {
    origin,
    altOrigin,
    port,
    submissionFile,
    requests,
    boardEnv: () => ({
      HUNTGRY_JOB_BOARD_BASE_URL_HIRINGCAFE: origin,
      // Indeed on the other loopback name: a different host for the loader's per-host rate limit.
      HUNTGRY_JOB_BOARD_BASE_URL_INDEED: altOrigin
    }),
    close: () => {
      for (const res of hanging) res.destroy()
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

/** Ids of the employer postings the mock hiring.cafe hits link to. */
export { EMPLOYER_POSTINGS }
