/**
 * Local mock applicant tracking systems (#24, #63): the routes behind
 * `node scripts/mock-ats.mjs` (manual testing) and the e2e mock server
 * (`e2e/fixtures/servers/`), so both serve exactly the same forms.
 *
 * Serves the committed form fixtures (src/shared/autofill/fixtures) at
 * /greenhouse/, /lever/, /ashby/ and /generic/. Greenhouse and Lever behave like the
 * live sites (scripts/mock-ats/sites/*.js, captured 2026-10-03): Greenhouse
 * hydrates after `load` (resetting anything filled earlier) and uploads a
 * chosen file at once to a presigned "S3" (/greenhouse/s3), swapping the input
 * for the file name; Lever sends a chosen résumé to its parser
 * (/lever/parseResume), which fills empty contact fields. Both submit with
 * JavaScript. Uploads are recorded to `uploadsFile` (default: uploads.json
 * next to the submission file) with their size and sha256.
 *
 * Company-site flows: /greenhouse/redirect-company 302s to /company/careers
 * on `otherOrigin()` (a different origin), which injects a Greenhouse
 * `/embed/job_app?validityToken=` iframe 800 ms after load, like Greenhouse's
 * embed loader; a token older than 30 s redirects to
 * `/embed/job_board?error=true`. /company/posting-popup and
 * /company/posting-link have only an "Apply" link to the form (new tab /
 * same tab).
 *
 * /workday/ is a client-rendered multi-step Workday flow (see workday.mjs)
 * whose resume uploads are recorded to `uploadsFile` too.
 *
 * Ashby (./ashby.mjs) is client-rendered: an empty #root, the form rendered
 * after `load`, Ashby's resume widget (/ashby/upload, recorded to
 * `uploadsFile`), its "Autofill from resume" parser (/ashby/parse), and a
 * careers page embedding it (/ashby/careers).
 *
 * Pressing a page's own Submit button posts to the mock, which records what
 * it received (field names, text values, attached file names and sizes; not
 * the file bytes) to `submissionFile` (default
 * <tmp>/huntgry-mock-ats/last-submission.json) and shows the ATS's
 * confirmation page. Nothing here submits anything: the person, or the e2e
 * test, presses Submit.
 *
 * Plain ESM without `import.meta`, so Playwright's transform can load it next
 * to the TypeScript fixtures; callers pass `fixturesDir`.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { createWorkdayMock, WORKDAY_POSTING } from './workday.mjs'
import { ashbySite } from './ashby.mjs'

/** Where the CLI records submissions: `<tmp>/huntgry-mock-ats/last-submission.json`. */
export function defaultSubmissionFile() {
  return join(tmpdir(), 'huntgry-mock-ats', 'last-submission.json')
}

const withScript = (html, src) => html.replace('</body>', `<script src="${src}"></script></body>`)

/**
 * A react-select Gender question like the live boards' EEO section (#71): `react-select.js` gives it the menu
 * behaviour (open on mousedown, choose on click), so remembered answers can be picked in it.
 */
const GENDER_QUESTION = `<div class="field-wrapper"><div class="select"><div class="select__container select__container--outside-label" data-mock-options="Male|Female|Decline to self-identify"><label id="question_gender-label" for="question_gender" class="label select__label select__label--outside-label">Gender</label><div class="select-shell"><div><div class="select-shell"><div class="select-shell"><div class="select-shell" id="react-select-question_gender-placeholder">Select...</div><div class="select-shell" data-value=""><input class="select__input" autocomplete="off" id="question_gender" tabindex="0" type="text" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="question_gender-label" role="combobox" value=""/></div></div></div></div></div><input tabindex="-1" aria-hidden="true" class="select-shell" name="gender" value=""/></div></div></div>`

/** The mock Greenhouse form: fields get names and the form posts to the mock (the real one submits through React). */
const greenhouseForm = (read) =>
  withScript(
    read('greenhouse-form.html')
      .replace('<div class="application--submit">', `${GENDER_QUESTION}<div class="application--submit">`)
      .replace(/<form method="get" action="[^"]*"/, '<form method="post" enctype="multipart/form-data" action="/greenhouse/submit"')
      .replace(/<(input|textarea)( [^>]*?)? id="([^"]+)"/g, (m, tag, rest = '', id) =>
        / name="/.test(rest) ? m : `<${tag}${rest} name="${id}" id="${id}"`
      )
      // Without Greenhouse's scripts its dropdowns cannot be answered, so their hidden required mirrors must go.
      .replace(/ required=""/g, '')
      .replace('</body>', '<script src="/mock-ats/react-select.js"></script></body>'),
    '/mock-ats/greenhouse.js'
  )

/**
 * Each mock site: its form page (made to post to the mock) and its confirmation page.
 * @param {(name: string) => string} read
 */
export function mockAtsSites(read) {
  return {
    greenhouse: {
      form: () => greenhouseForm(read),
      thanks: '/greenhouse/confirmation',
      thanksPage: () => read('greenhouse-confirmation.html')
    },
    lever: {
      // Like the live page, the form has no action: lever.js posts it to /lever/submit.
      form: () => withScript(read('lever-form.html'), '/mock-ats/lever.js'),
      thanks: '/lever/thanks',
      thanksPage: () => read('lever-thanks.html')
    },
    ashby: ashbySite(read),
    generic: {
      form: () => read('generic-form.html'),
      thanks: '/generic/thanks',
      thanksPage: () => read('generic-thanks.html')
    }
  }
}

export function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
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

/** Reads a multipart upload and appends what it held (name, size, sha256; not the bytes) to `file`. */
export async function recordUpload(site, req, file) {
  const request = new Request(`http://localhost${req.url}`, {
    method: 'POST',
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: 'half'
  })
  const form = await request.formData()
  const entry = { site, receivedAt: new Date().toISOString() }
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') entry[name] = value
    else {
      const bytes = Buffer.from(await value.arrayBuffer())
      entry.file = value.name
      entry.type = value.type
      entry.bytes = bytes.length
      entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    }
  }
  const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  all.push(entry)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`)
  return entry
}

const page = (title, body) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

/** How long a mock `validityToken` stays valid (Greenhouse's live tokens last seconds to minutes). */
const TOKEN_TTL_MS = 30_000

/**
 * The mock ATS as a request handler: `handle(req, res)` answers the ATS
 * routes and returns `true`, or returns `false` for a path it does not know,
 * so a bigger server can mount other pages beside it.
 *
 * @param {{ fixturesDir: string, sitesDir?: string, submissionFile?: string, uploadsFile?: string, otherOrigin?: () => string, extraSites?: Record<string, {form(): string, thanks: string, thanksPage(): string, routes?: Function}>, log?: (line: string) => void }} options
 */
export function createMockAts(options) {
  const { fixturesDir } = options
  if (!fixturesDir) throw new Error('createMockAts needs fixturesDir (src/shared/autofill/fixtures).')
  const submissionFile = options.submissionFile ?? defaultSubmissionFile()
  const uploadsFile = options.uploadsFile ?? join(dirname(submissionFile), 'uploads.json')
  const sitesDir = options.sitesDir ?? join(fixturesDir, '../../../../scripts/mock-ats/sites')
  const log = options.log ?? (() => undefined)
  const read = (name) => readFileSync(join(fixturesDir, name), 'utf8')
  const sites = { ...mockAtsSites(read), ...(options.extraSites ?? {}) }
  const workday = createWorkdayMock({ read, record: (req) => recordUpload('workday', req, uploadsFile), log })
  const index = () => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Mock ATS</title></head><body>
<h1>Huntgry mock ATS</h1><p>Local copies of application forms for testing auto-apply. Nothing leaves this machine.</p>
<ul>${Object.keys(sites)
    .map((s) => `<li><a href="/${s}/">${s}</a></li>`)
    .join('')}<li><a href="${WORKDAY_POSTING}">workday</a></li></ul></body></html>`

  /** Routes beside the per-site ones: scripts, uploads, parser, company pages and embeds. */
  function special(req, res, url) {
    const host = `http://${req.headers.host ?? 'localhost'}`
    const path = url.pathname
    if (path === '/mock-ats/greenhouse.js' || path === '/mock-ats/lever.js' || path === '/mock-ats/react-select.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(readFileSync(join(sitesDir, path.slice('/mock-ats/'.length)), 'utf8'))
      return true
    }
    if (path === '/greenhouse/presign') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ key: `uploads/${Date.now()}`, policy: 'mock' }))
      return true
    }
    if (req.method === 'POST' && (path === '/greenhouse/s3' || path === '/lever/parseResume')) {
      const site = path.startsWith('/lever') ? 'lever' : 'greenhouse'
      recordUpload(site, req, uploadsFile)
        .then((entry) => {
          log(`[mock-ats] ${site}: upload ${entry.file} (${entry.bytes} bytes) → ${uploadsFile}`)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(site === 'lever' ? JSON.stringify({ name: 'Parsed Name', email: 'parsed@example.com', phone: '000-000-0000' }) : '{}')
        })
        .catch((err) => sendHtml(res, 400, `Could not read the upload: ${err.message}`))
      return true
    }
    if (path === '/greenhouse/redirect-company') {
      const other = options.otherOrigin?.() ?? host
      sendHtml(res, 302, '', { location: `${other}/company/careers?gh_jid=1000001&ats=${encodeURIComponent(host)}` })
      return true
    }
    if (path === '/company/careers') {
      // The company page loads Greenhouse's embed script, which adds the form iframe with a fresh token a moment later.
      const ats = url.searchParams.get('ats') ?? host
      const token = Buffer.from(String(Date.now())).toString('base64url')
      const src = `${ats}/embed/job_app?for=acme&validityToken=${token}`
      sendHtml(
        res,
        200,
        page(
          'Software Engineer - Acme Careers',
          `<h1>Software Engineer</h1><p>Join Acme.</p><div id="grnhse_app"></div>
<script>setTimeout(() => { const f = document.createElement('iframe'); f.id = 'grnhse_iframe'; f.width = '100%'; f.height = '900'; f.src = ${JSON.stringify(src)}; document.getElementById('grnhse_app').append(f) }, 800)</script>`
        )
      )
      return true
    }
    if (path === '/embed/job_app') {
      const token = url.searchParams.get('validityToken')
      const issued = token ? Number(Buffer.from(token, 'base64url').toString()) : NaN
      const ttl = Number(url.searchParams.get('ttl') ?? TOKEN_TTL_MS)
      if (!Number.isFinite(issued) || Date.now() - issued > ttl) {
        sendHtml(res, 302, '', { location: `/embed/job_board?for=${url.searchParams.get('for') ?? ''}&error=true` })
      } else {
        sendHtml(res, 200, greenhouseForm(read))
      }
      return true
    }
    if (path === '/embed/job_board') {
      sendHtml(res, 200, page('Acme Jobs', '<h1>Current openings at Acme</h1><p>This job is no longer available.</p>'))
      return true
    }
    if (path === '/company/posting-popup' || path === '/company/posting-link') {
      const target = path.endsWith('popup') ? ' target="_blank"' : ''
      sendHtml(
        res,
        200,
        page(
          'Software Engineer - Acme',
          `<h1>Software Engineer</h1><p>About the role.</p><p><a id="apply" href="/greenhouse/"${target}>Apply now</a></p>`
        )
      )
      return true
    }
    return false
  }

  return {
    submissionFile,
    uploadsFile,
    sites: [...Object.keys(sites), 'workday'],
    index,
    handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (special(req, res, url) || workday.handle(req, res)) return true
      const [site, action] = url.pathname.split('/').filter(Boolean)
      const mock = sites[site]
      if (!mock) return false
      // A site's own endpoints (the mock Ashby's upload and parser).
      if (action && mock.routes?.(action, req, res, { uploadsFile, recordUpload, sendJson, sendHtml, log })) return true
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
        uploadsFile: ats.uploadsFile,
        sites: ats.sites,
        close: () => new Promise((done) => server.close(() => done()))
      })
    })
  })
}
