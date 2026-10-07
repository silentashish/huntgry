import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createMockAts, sendHtml, type MockAts } from '../../../scripts/mock-ats/server.mjs'
import { EMPLOYER_POSTINGS, postingPage } from './pages'

/**
 * One local server per worker, on a free `127.0.0.1` port, standing in for
 * every site the Jobs, Browser and Apply flows reach:
 *
 * - `/postings/employer/:id`, `/postings/lever-style`, `/postings/ashby-style`  posting pages
 * - `/bot-wall`            a 403 "Just a moment…" human check
 * - `/page/one`, `/page/two`, `/hang`  plain pages for the browser's history and Stop
 * - `/redirect/lever`      302 to the Lever form on the *other* loopback origin (a second 127.0.0.1 port)
 * - `/greenhouse/`, `/lever/`, `/generic/`, `/generic-cover/` + `…/submit` + the thanks pages: the mock ATS
 *   (`scripts/mock-ats/server.mjs`, the same code as `node scripts/mock-ats.mjs`), with Greenhouse's hydration and
 *   S3 upload widget, Lever's résumé parser, `/greenhouse/redirect-company` → `altOrigin/company/careers` with a
 *   late `/embed/job_app?validityToken=` iframe, and `/company/posting-popup` / `/company/posting-link`
 *
 * The app reaches it because the harness sets `HUNTGRY_ALLOW_LOCAL_URLS=1`. Nothing here submits a form: the ATS routes only record what a
 * Submit pressed by the test sent.
 */

export interface MockServer {
  /** `http://127.0.0.1:<port>`, the origin the fixtures and the board overrides use. */
  origin: string
  /** `http://127.0.0.1:<altPort>`: the same handler on a second listener, a different origin for the redirect case. */
  altOrigin: string
  port: number
  altPort: number
  /** Where the ATS routes record the last submission (`last-submission.json`). */
  submissionFile: string
  /** Uploads the mock Greenhouse S3 and Lever résumé parser received (`uploads.json`: name, bytes, sha256). */
  uploadsFile: string
  /** Every request path the server answered, in order. */
  requests: string[]
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
    otherOrigin: () => altOrigin,
    extraSites: { 'generic-cover': { form: genericWithCover, thanks: '/generic-cover/thanks', thanksPage: () => read('generic-thanks.html') } }
  })

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push(url.pathname + url.search)
    if (url.pathname === '/') return sendHtml(res, 200, ats.index())
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

  // Two listeners, same handler: the second is the "other origin" (a different port is a different origin), and a
  // different host:port for the loader's per-host rate limit. Both on 127.0.0.1 only, so nothing depends on how the
  // machine resolves `localhost`.
  const listen = async (): Promise<Server> => {
    const server: Server = createServer(handle)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    return server
  }
  const [server, altServer] = await Promise.all([listen(), listen()])
  const portOf = (s: Server): number => {
    const address = s.address()
    if (!address || typeof address !== 'object') throw new Error('The mock server has no port.')
    return address.port
  }
  const port = portOf(server)
  const altPort = portOf(altServer)
  origin = `http://127.0.0.1:${port}`
  altOrigin = `http://127.0.0.1:${altPort}`
  return {
    origin,
    altOrigin,
    port,
    altPort,
    submissionFile,
    uploadsFile: ats.uploadsFile,
    requests,
    close: async () => {
      for (const res of hanging) res.destroy()
      for (const s of [server, altServer]) {
        s.closeAllConnections()
        await new Promise<void>((resolve) => s.close(() => resolve()))
      }
    }
  }
}

/** The employer postings served under `/postings/employer/<id>`. */
export { EMPLOYER_POSTINGS }
