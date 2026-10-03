/**
 * The mock Ashby site (#64), served at /ashby/ by `scripts/mock-ats/server.mjs`.
 *
 * Like jobs.ashbyhq.com it is client-rendered: the page arrives as an empty
 * `#root`, and a script renders the captured form (fixtures/ashby-form.html)
 * `renderMs` after `load` (default 500 ms, `?renderMs=` to change it). The
 * script copies the live behaviour Huntgry depends on:
 *
 * - `#_systemfield_resume` uploads on `change` (POST /ashby/upload, recorded,
 *   standing in for `ApiCreateFileUploadHandle`). Meanwhile the widget lists
 *   the file with a spinner; once uploaded, with a delete button, and the
 *   dropzone button reads "Replace". A failed upload shows a toast and lists
 *   nothing.
 * - The "Autofill from resume" pane parses its file (POST /ashby/parse,
 *   recorded) and fills the *empty* name and email with parser values.
 *   `?parsed=1` renders the form as if the candidate had already used it.
 * - `?failUpload=1` makes /ashby/upload fail (recorded with `failed: true`):
 *   the widget then shows the "failed to upload" toast and lists no file, as
 *   on the live page when Ashby rejects a file.
 * - There is no `<form>`: Submit (`.ashby-application-form-submit-button`)
 *   posts the answers and the uploaded file to /ashby/submit and swaps the
 *   form for Ashby's success panel in place, without a navigation.
 *
 * Uploads and parses are recorded to `ashby-uploads.json` next to the
 * submission file (name, type and size; not the bytes). Nothing here submits
 * on its own: only a person or a test presses Submit.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'

/** Where the mock Ashby records uploads and parses: `ashby-uploads.json` beside the submission file. */
export function ashbyUploadsFile(submissionFile) {
  return join(dirname(submissionFile), 'ashby-uploads.json')
}

const THANKS = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Software Engineer @ Acme</title></head><body>
<div class="ashby-application-form-success-container"><div role="status" aria-live="polite" tabindex="-1"><h2>Success</h2>
<p>Your application was successfully submitted. We'll contact you if there are next steps.</p></div></div></body></html>`

/** What the mock "Autofill from resume" parser reads from any file. */
const PARSED = { _systemfield_name: 'Parsed Name', _systemfield_email: 'parsed@example.com' }

/** The client-side app: renders the form late and runs the upload widget, the parser pane and Submit. */
const APP = String.raw`
(() => {
  const params = new URLSearchParams(location.search)
  const renderMs = Number(params.get('renderMs') ?? 500)
  const PARSED = __PARSED__
  let uploaded = null

  const widget = () => document.getElementById('_systemfield_resume').closest('.ashby-application-form-input-file')
  const toast = (text) => {
    const t = document.createElement('div')
    t.className = 'mock-toast'
    t.setAttribute('role', 'alert')
    t.textContent = text
    document.body.append(t)
  }
  const send = (path, body) => fetch(path, { method: 'POST', body })

  function showFile(name, uploading) {
    const w = widget()
    w.querySelector('.ashby-application-form-input-file-item')?.remove()
    if (name !== null) {
      const item = document.createElement('div')
      item.className = '_file_10xk4_1 ashby-application-form-input-file-item'
      const label = document.createElement('div')
      label.className = 'ashby-application-form-input-file-item-name'
      label.innerHTML = '<p><span class="' + (uploading ? 'mock-spinner' : 'mock-icon') + '"></span><span></span></p>'
      label.querySelector('span:last-child').textContent = name
      item.append(label)
      if (!uploading) {
        const del = document.createElement('div')
        del.className = 'ashby-application-form-input-file-item-delete'
        del.innerHTML = '<button title="Delete file">×</button>'
        del.querySelector('button').addEventListener('click', () => {
          uploaded = null
          showFile(null)
        })
        item.append(del)
      }
      w.querySelector('.ashby-application-form-input-file-dropzone').before(item)
    }
    w.querySelector('.ashby-application-form-input-file-dropzone-upload span span').textContent =
      name !== null && !uploading ? 'Replace' : 'Upload File'
  }

  async function uploadResume(file) {
    showFile(file.name, true)
    const body = new FormData()
    body.append('file', file)
    const res = await send(params.get('failUpload') === '1' ? '/ashby/upload?fail=1' : '/ashby/upload', body).catch(() => null)
    if (!res || !res.ok) {
      showFile(null)
      toast(file.name + ' failed to upload')
      return
    }
    uploaded = file
    showFile(file.name, false)
  }

  async function parseResume(file) {
    const pending = document.querySelector('.ashby-application-form-autofill-input-pending-layer')
    pending.dataset.state = 'visible'
    const body = new FormData()
    body.append('file', file)
    const res = await send('/ashby/parse', body)
    const parsed = await res.json()
    setTimeout(() => {
      for (const [id, value] of Object.entries(parsed)) {
        const el = document.getElementById(id)
        if (el && !el.value) el.value = value
      }
      pending.dataset.state = 'hidden'
    }, 600)
  }

  async function submit() {
    const body = new FormData()
    for (const el of document.querySelectorAll('.ashby-application-form-container input[name], .ashby-application-form-container textarea[name]')) {
      if (el.type === 'file') continue
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue
      body.append(el.name, el.type === 'checkbox' ? 'on' : el.value)
    }
    if (uploaded) body.append('_systemfield_resume', uploaded)
    const res = await send('/ashby/submit', body)
    if (!res.ok) return toast('We could not submit your application')
    document.getElementById('form').outerHTML = new DOMParser()
      .parseFromString(await res.text(), 'text/html')
      .querySelector('.ashby-application-form-success-container').outerHTML
  }

  function render() {
    document.getElementById('root').innerHTML = document.getElementById('ashby-form').innerHTML
    // React delegates events to the root; so does the mock (CDP's file chooser fires trusted input/change).
    document.getElementById('root').addEventListener('change', (e) => {
      const input = e.target
      if (input.type !== 'file' || !input.files || !input.files[0]) return
      if (input.id === '_systemfield_resume') uploadResume(input.files[0])
      else if (input.closest('.ashby-application-form-autofill-uploader')) parseResume(input.files[0])
    })
    document.querySelector('.ashby-application-form-submit-button').addEventListener('click', () => void submit())
    // ?parsed=1: the candidate already used "Autofill from resume" (its values are on the form when it appears).
    if (params.get('parsed') === '1') {
      document.getElementById('_systemfield_name').value = PARSED._systemfield_name
      document.getElementById('_systemfield_email').value = PARSED._systemfield_email
    }
  }

  window.addEventListener('load', () => setTimeout(render, renderMs))
})()
`

/** Enough of Ashby's look for screenshots: hidden layers and file inputs stay hidden, as on the live page. */
const CSS = `
body { font: 15px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1f2937; margin: 0; background: #fff; }
.ashby-job-posting-right-pane { max-width: 640px; margin: 24px auto; padding: 0 16px; }
[data-state="hidden"], .ashby-application-form-input-file > input[type="file"],
.ashby-application-form-autofill-input-root > input[type="file"] { display: none; }
.ashby-application-form-autofill-uploader, .ashby-application-blocking-disclosure { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
.ashby-application-blocking-disclosure { background: #f0f7ff; border-color: #bfdbfe; }
.ashby-application-form-autofill-input-title, .ashby-application-form-autofill-input-description { margin: 0 0 6px; font-size: 15px; }
.ashby-application-form-field-entry { margin: 0 0 18px; }
.ashby-application-form-question-title { display: block; font-weight: 600; margin-bottom: 6px; }
.ashby-application-form-question-title._required_f7cvd_91::after { content: '*'; color: #dc2626; }
.ashby-application-form-question-description { color: #6b7280; font-size: 13px; }
.ashby-application-form-question-description p { margin: 0 0 6px; }
input[type="text"], input[type="email"], input[type="tel"], input:not([type]), textarea { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font: inherit; }
button { font: inherit; border: 1px solid #111827; background: #fff; border-radius: 999px; padding: 4px 14px; margin-right: 6px; }
.ashby-application-form-input-file { border: 1px dashed #9ca3af; border-radius: 8px; padding: 12px; }
.ashby-application-form-input-file-item { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.ashby-application-form-input-file-item-name p { margin: 0; font-weight: 600; }
.ashby-application-form-input-file-item-delete button { border: 0; }
.ashby-application-form-input-file-dropzone-instructions { display: inline; color: #6b7280; }
.ashby-application-form-input-file-dropzone p { display: inline; margin: 0; }
.mock-spinner::before { content: '⏳ '; } .mock-icon::before { content: '📄 '; }
.ashby-application-form-submit-button { background: #111827; color: #fff; width: 100%; padding: 10px; border-radius: 8px; }
fieldset { border: 0; padding: 0; margin: 0; }
.ashby-application-form-input-radio-group-option, .ashby-application-form-input-checkbox-group-option { display: flex; gap: 6px; align-items: baseline; }
.mock-toast { position: fixed; left: 16px; bottom: 16px; background: #991b1b; color: #fff; padding: 10px 14px; border-radius: 6px; }
.ashby-application-form-success-container { max-width: 640px; margin: 48px auto; padding: 16px; border: 1px solid #86efac; background: #f0fdf4; border-radius: 8px; }
`

/** The served page: an empty root, the captured form in a template, and the app. */
function shell(read) {
  const fixture = read('ashby-form.html')
  const body = fixture.slice(fixture.indexOf('<body>') + '<body>'.length, fixture.lastIndexOf('</body>'))
  const inner = body.trim().replace(/^<div id="root">/, '').replace(/<\/div>$/, '')
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Software Engineer @ Acme</title><style>${CSS}</style></head>
<body><div id="root"></div>
<template id="ashby-form">${inner}</template>
<script>${APP.replace('__PARSED__', JSON.stringify(PARSED))}</script></body></html>`
}

async function readFiles(req) {
  const request = new Request(`http://localhost${req.url}`, { method: 'POST', headers: req.headers, body: Readable.toWeb(req), duplex: 'half' })
  const form = await request.formData()
  const file = form.get('file')
  return file && typeof file !== 'string' ? { file: file.name, type: file.type, bytes: file.size } : null
}

function record(file, entry) {
  let list = []
  try {
    list = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // First record.
  }
  list.push({ ...entry, at: new Date().toISOString() })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`)
}

/**
 * The Ashby site for `mockAtsSites`. `routes` answers its own POST endpoints
 * (`/ashby/upload`, `/ashby/parse`); /ashby/submit and the thanks page are the
 * shared ones.
 *
 * @param {(name: string) => string} read
 */
export function ashbySite(read) {
  return {
    form: () => shell(read),
    thanks: '/ashby/thanks',
    thanksPage: () => THANKS,
    routes(action, req, res, { submissionFile, sendJson }) {
      if (req.method !== 'POST' || (action !== 'upload' && action !== 'parse')) return false
      readFiles(req)
        .then((upload) => {
          if (!upload) return sendJson(res, 400, { error: 'No file.' })
          const failed = action === 'upload' && new URL(req.url ?? '/', 'http://localhost').searchParams.get('fail') === '1'
          record(ashbyUploadsFile(submissionFile), { kind: action, ...upload, ...(failed ? { failed: true } : {}) })
          if (failed) return sendJson(res, 500, { error: 'Upload failed.' })
          if (action === 'upload') return sendJson(res, 200, { handle: `mock-handle-${Date.now()}` })
          // The parser's guesses: they land only in fields that are still empty.
          return sendJson(res, 200, PARSED)
        })
        .catch((err) => sendJson(res, 400, { error: err.message }))
      return true
    }
  }
}
