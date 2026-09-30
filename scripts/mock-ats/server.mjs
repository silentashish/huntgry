/**
 * Local mock applicant tracking systems (#24): the routes behind
 * `node scripts/mock-ats.mjs` (manual testing) and the e2e mock server
 * (`e2e/fixtures/servers/`), so both serve exactly the same forms.
 *
 * Serves the committed form fixtures (src/shared/autofill/fixtures) at
 * /greenhouse/, /lever/ and /generic/. Pressing a page's own Submit button
 * posts to the mock, which records what it received (field names, text
 * values, attached file names and sizes; not the file bytes) to
 * `submissionFile` (default <tmp>/huntgry-mock-ats/last-submission.json) and
 * shows the ATS's confirmation page. Nothing here submits anything: the
 * person, or the e2e test, presses Submit.
 *
 * Plain ESM without `import.meta`, so Playwright's transform can load it next
 * to the TypeScript fixtures; callers pass `fixturesDir`.
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'

/** Where the CLI records submissions: `<tmp>/huntgry-mock-ats/last-submission.json`. */
export function defaultSubmissionFile() {
  return join(tmpdir(), 'huntgry-mock-ats', 'last-submission.json')
}

/**
 * Each mock site: its form page (made to post to the mock) and its confirmation page.
 * @param {(name: string) => string} read
 */
export function mockAtsSites(read) {
  return {
    greenhouse: {
      // The real board submits through React with ids only; give the fields names and a plain multipart POST.
      form: () =>
        read('greenhouse-form.html')
          .replace(/<form method="get" action="[^"]*"/, '<form method="post" enctype="multipart/form-data" action="/greenhouse/submit"')
          .replace(/<(input|textarea)( [^>]*?)? id="([^"]+)"/g, (m, tag, rest = '', id) =>
            / name="/.test(rest) ? m : `<${tag}${rest} name="${id}" id="${id}"`
          )
          // Without Greenhouse's scripts its dropdowns cannot be answered, so their hidden required mirrors must go.
          .replace(/ required=""/g, ''),
      thanks: '/greenhouse/confirmation',
      thanksPage: () => read('greenhouse-confirmation.html')
    },
    lever: {
      form: () => read('lever-form.html').replace(/action="[^"]*"/, 'action="/lever/submit"'),
      thanks: '/lever/thanks',
      thanksPage: () => read('lever-thanks.html')
    },
    generic: {
      form: () => read('generic-form.html'),
      thanks: '/generic/thanks',
      thanksPage: () => read('generic-thanks.html')
    }
  }
}

export function sendHtml(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(body)
}

/** Reads a multipart/urlencoded POST and writes what it held to `file`. */
export async function recordSubmission(site, req, file) {
  const request = new Request(`http://localhost${req.url}`, {
    method: 'POST',
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: 'half'
  })
  const form = await request.formData()
  const fields = {}
  for (const [name, value] of form.entries()) {
    fields[name] = typeof value === 'string' ? value : { file: value.name, type: value.type, bytes: value.size }
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ site, receivedAt: new Date().toISOString(), fields }, null, 2)}\n`)
  return fields
}

/**
 * The mock ATS as a request handler: `handle(req, res)` answers the ATS
 * routes and returns `true`, or returns `false` for a path it does not know,
 * so a bigger server can mount other pages beside it.
 *
 * @param {{ fixturesDir: string, submissionFile?: string, extraSites?: Record<string, {form(): string, thanks: string, thanksPage(): string}>, log?: (line: string) => void }} options
 */
export function createMockAts(options) {
  const { fixturesDir } = options
  if (!fixturesDir) throw new Error('createMockAts needs fixturesDir (src/shared/autofill/fixtures).')
  const submissionFile = options.submissionFile ?? defaultSubmissionFile()
  const log = options.log ?? (() => undefined)
  const read = (name) => readFileSync(join(fixturesDir, name), 'utf8')
  const sites = { ...mockAtsSites(read), ...(options.extraSites ?? {}) }
  const index = () => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Mock ATS</title></head><body>
<h1>Huntgry mock ATS</h1><p>Local copies of application forms for testing auto-apply. Nothing leaves this machine.</p>
<ul>${Object.keys(sites)
    .map((s) => `<li><a href="/${s}/">${s}</a></li>`)
    .join('')}</ul></body></html>`

  return {
    submissionFile,
    sites: Object.keys(sites),
    index,
    handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const [site, action] = url.pathname.split('/').filter(Boolean)
      const mock = sites[site]
      if (!mock) return false
      if (req.method === 'POST' && action === 'submit') {
        recordSubmission(site, req, submissionFile)
          .then((fields) => {
            log(`[mock-ats] ${site}: recorded ${Object.keys(fields).length} fields → ${submissionFile}`)
            sendHtml(res, 303, '', { location: mock.thanks })
          })
          .catch((err) => sendHtml(res, 400, `Could not read the form: ${err.message}`))
        return true
      }
      if (url.pathname === mock.thanks) sendHtml(res, 200, mock.thanksPage())
      else if (!action) sendHtml(res, 200, mock.form())
      else sendHtml(res, 404, 'Not found')
      return true
    }
  }
}

/**
 * Starts a server that serves only the mock ATS (the CLI). `port: 0` picks a
 * free port; the server listens on 127.0.0.1 only.
 */
export function startMockAts({ port = 4173, host = '127.0.0.1', ...options }) {
  const ats = createMockAts(options)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/') return sendHtml(res, 200, ats.index())
    if (!ats.handle(req, res)) sendHtml(res, 404, 'Not found')
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      resolve({
        server,
        port: actualPort,
        url: `http://${host === '127.0.0.1' ? 'localhost' : host}:${actualPort}/`,
        submissionFile: ats.submissionFile,
        sites: ats.sites,
        close: () => new Promise((done) => server.close(() => done()))
      })
    })
  })
}
