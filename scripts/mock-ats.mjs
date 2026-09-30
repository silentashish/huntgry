#!/usr/bin/env node
/**
 * Local mock applicant tracking systems for testing auto-apply (#24) by hand,
 * so no real employer ever receives a test application.
 *
 *   node scripts/mock-ats.mjs            # http://localhost:4173/
 *   HUNTGRY_ALLOW_LOCAL_URLS=1 npm run dev
 *
 * Serves the committed form fixtures (src/shared/autofill/fixtures) at
 * /greenhouse/, /lever/ and /generic/. Pressing the page's own Submit button
 * posts to the mock, which records what it received (field names, text
 * values, attached file names and sizes; not the file bytes) to
 * <tmp>/huntgry-mock-ats/last-submission.json and shows the ATS's
 * confirmation page. Listens on 127.0.0.1 only. Unit tests never use it.
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT ?? 4173)
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../src/shared/autofill/fixtures')
const OUT_DIR = join(tmpdir(), 'huntgry-mock-ats')
const OUT = join(OUT_DIR, 'last-submission.json')

const read = (name) => readFileSync(join(FIXTURES, name), 'utf8')

/** Each mock: its form page (made to post to the mock) and its confirmation page. */
const SITES = {
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

const INDEX = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Mock ATS</title></head><body>
<h1>Huntgry mock ATS</h1><p>Local copies of application forms for testing auto-apply. Nothing leaves this machine.</p>
<ul>${Object.keys(SITES)
  .map((s) => `<li><a href="/${s}/">${s}</a></li>`)
  .join('')}</ul></body></html>`

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(body)
}

async function record(site, req) {
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
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT, `${JSON.stringify({ site, receivedAt: new Date().toISOString(), fields }, null, 2)}\n`)
  console.log(`[mock-ats] ${site}: recorded ${Object.keys(fields).length} fields → ${OUT}`)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const [site, action] = url.pathname.split('/').filter(Boolean)
  const mock = SITES[site]
  if (!site) return send(res, 200, INDEX)
  if (!mock) return send(res, 404, 'Not found')
  if (req.method === 'POST' && action === 'submit') {
    record(site, req)
      .then(() => send(res, 303, '', { location: mock.thanks }))
      .catch((err) => send(res, 400, `Could not read the form: ${err.message}`))
    return
  }
  if (url.pathname === mock.thanks) return send(res, 200, mock.thanksPage())
  if (!action) return send(res, 200, mock.form())
  send(res, 404, 'Not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-ats] http://localhost:${PORT}/  (greenhouse, lever, generic); submissions → ${OUT}`)
})
