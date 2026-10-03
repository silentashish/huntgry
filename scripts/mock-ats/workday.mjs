/**
 * A mock Workday apply flow (#65): a client-rendered single-page app built
 * from the committed `workday-*.html` fixtures, served under /workday/ by the
 * mock ATS (`node scripts/mock-ats.mjs` and the e2e mock server).
 *
 * Like the real site (captured 2026-10-03):
 * - the shell has no content; the app draws the page about `renderMs` (600)
 *   after load and every step after a spinner;
 * - posting → `<job>/apply` (choice) → `<job>/apply/applyManually` or
 *   `…/autofillWithResume` change the URL with pushState; inside the flow
 *   (sign-in wall, My Information, My Experience, …) the URL stays the same
 *   and only the progress bar's active step changes;
 * - the sign-in wall accepts any email and password, but only when someone
 *   presses its Sign In / Create Account button (the e2e test does; Huntgry
 *   never does);
 * - the resume drop zone uploads the file to `/workday/_upload` (recorded,
 *   with its size and sha256, to the mock ATS's uploads file), shows a progress bar,
 *   then replaces the drop zone, input included, with the uploaded-file list
 *   `file-upload-successful`;
 * - on Autofill with Resume it then reads the resume for `parseMs` (3000):
 *   a `resumeParsing` banner shows on whatever step is open, and when it
 *   ends the parser writes its values into My Information, overwriting what
 *   is there (first name "Alexander", last name "Rivera", email
 *   "alex.rivera@parsed.example"; phone and city stay empty). A My
 *   Information opened after the parse shows them pre-filled.
 *
 * Nothing is submitted: the flow ends at Application Questions. `?tenant=legacy`
 * on the posting URL switches My Information to the older tenants' markup.
 * Plain ESM without `import.meta` (see server.mjs).
 */

/** The mock posting, relative to the server's origin. */
export const WORKDAY_POSTING = '/workday/job/Remote-USA/Software-Engineer_JR-1001'

const VIEWS = new Set([
  'posting',
  'apply-choice',
  'signin',
  'create-account',
  'my-information',
  'my-information-legacy',
  'autofill-resume',
  'my-experience',
  'application-questions'
])

const SHELL = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Workday</title></head>
<body><div id="app"></div><script src="/workday/_app.js"></script></body></html>`

/** The page's own script. Runs in the browser; serialised with `toString()`. */
function workdayApp() {
  const app = document.getElementById('app')
  const params = new URLSearchParams(location.search)
  const store = {
    get: (k) => sessionStorage.getItem(`wd:${k}`),
    set: (k, v) => sessionStorage.setItem(`wd:${k}`, String(v))
  }
  if (params.get('tenant')) store.set('tenant', params.get('tenant'))
  const RENDER_MS = Number(params.get('renderMs') ?? store.get('renderMs') ?? 600)
  store.set('renderMs', RENDER_MS)
  const PARSE_MS = Number(params.get('parseMs') ?? store.get('parseMs') ?? 3000)
  store.set('parseMs', PARSE_MS)
  const PARSED = [
    ['#name--legalName--firstName, [data-automation-id="legalNameSection_firstName"]', 'Alexander'],
    ['#name--legalName--lastName, [data-automation-id="legalNameSection_lastName"]', 'Rivera'],
    ['#emailAddress--emailAddress, [data-automation-id="email"]', 'alex.rivera@parsed.example']
  ]
  const base = location.pathname.replace(/\/apply(\/.*)?$/, '').replace(/\/$/, '')
  const FLOWS = {
    applyManually: ['signin', 'my-information', 'my-experience', 'application-questions'],
    autofillWithResume: ['signin', 'autofill-resume', 'my-information', 'my-experience', 'application-questions']
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const aid = (el) => el?.closest?.('[data-automation-id]')?.getAttribute('data-automation-id') ?? null
  const flowName = () => location.pathname.split('/').pop()

  function view() {
    const path = location.pathname.replace(/\/$/, '')
    if (path === base) return 'posting'
    if (path.endsWith('/apply')) return 'apply-choice'
    const steps = FLOWS[flowName()] ?? FLOWS.applyManually
    let step = Number(store.get(`${flowName()}:step`) ?? 0)
    if (step === 0 && store.get('signedIn')) step = 1
    const name = steps[Math.min(step, steps.length - 1)]
    if (name === 'signin' && store.get('wall') === 'create') return 'create-account'
    if (name === 'my-information' && store.get('tenant') === 'legacy') return 'my-information-legacy'
    return name
  }

  let generation = 0
  async function show(delay) {
    const mine = ++generation
    // Workday keeps the page while it loads the next step, under a spinner.
    app.insertAdjacentHTML('beforeend', '<div data-automation-id="loadingSpinner" aria-label="Loading"></div>')
    const name = view()
    const [res] = await Promise.all([fetch(`/workday/_view/${name}`), sleep(delay)])
    const { title, html } = await res.json()
    if (mine !== generation) return
    document.title = title
    app.innerHTML = html
    app.dataset.view = name
    parseState()
  }

  /** The parser's values land on My Information (overwriting), once the parse is over. */
  function applyParsed() {
    if (!app.dataset.view?.startsWith('my-information')) return
    for (const [selector, value] of PARSED) {
      const el = app.querySelector(selector)
      if (el) el.value = value
    }
  }

  /** Shows the parse banner while Workday reads the resume, and applies its result when it is done. */
  function parseState() {
    const until = Number(store.get('parseUntil') ?? 0)
    if (!until) return
    if (Date.now() >= until) {
      applyParsed()
      return
    }
    if (!app.querySelector('[data-automation-id="resumeParsing"]')) {
      app.insertAdjacentHTML('beforeend', '<div data-automation-id="resumeParsing" role="status">Reading your resume…</div>')
    }
    const mine = generation
    setTimeout(() => {
      if (mine !== generation) return
      app.querySelector('[data-automation-id="resumeParsing"]')?.remove()
      applyParsed()
    }, until - Date.now())
  }

  function go(path) {
    history.pushState({}, '', path)
    void show(RENDER_MS / 2)
  }

  function advance(by = 1) {
    const key = `${flowName()}:step`
    const current = Number(store.get(key) ?? 0) || (store.get('signedIn') ? 1 : 0)
    store.set(key, Math.max(store.get('signedIn') ? 1 : 0, current + by))
    void show(RENDER_MS / 2)
  }

  document.addEventListener('click', (e) => {
    const id = aid(e.target)
    if (!id) return
    if (id === 'adventureButton') {
      e.preventDefault()
      go(`${base}/apply`)
    } else if (id === 'autofillWithResume' || id === 'applyManually') {
      e.preventDefault()
      store.set(`${id}:step`, store.get('signedIn') ? 1 : 0)
      go(`${base}/apply/${id}`)
    } else if (id === 'useMyLastApplication') {
      e.preventDefault()
    } else if (id === 'createAccountLink' || id === 'signInLink') {
      store.set('wall', id === 'createAccountLink' ? 'create' : 'signin')
      void show(0)
    } else if (id === 'backToJobPosting') {
      go(base)
    } else if (id === 'bottom-navigation-next-button') {
      advance(1)
    } else if (id === 'pageFooterBackButton') {
      advance(-1)
    }
  })

  // Sign In / Create Account: only when someone presses the button (the test; never Huntgry).
  document.addEventListener('submit', (e) => {
    const form = e.target
    if (form.getAttribute('data-automation-id') !== 'signInFormo') return
    e.preventDefault()
    const value = (id) => form.querySelector(`[data-automation-id="${id}"]`)?.value ?? ''
    const create = !!form.querySelector('[data-automation-id="verifyPassword"]')
    const ok =
      value('email').includes('@') &&
      value('password') !== '' &&
      (!create || (value('verifyPassword') === value('password') && form.querySelector('[data-automation-id="createAccountCheckbox"]').checked))
    if (!ok) {
      form.insertAdjacentHTML('afterbegin', '<div role="alert" data-automation-id="errorMessage">Enter your email and password.</div>')
      return
    }
    store.set('signedIn', '1')
    store.set(`${flowName()}:step`, 1)
    void show(RENDER_MS / 2)
  })

  // The resume drop zone: upload, progress bar, (parse,) then the uploaded-file list in place of the zone.
  document.addEventListener('change', async (e) => {
    const input = e.target
    if (input.getAttribute?.('data-automation-id') !== 'file-upload-input-ref') return
    const file = input.files?.[0]
    if (!file) return
    const zone = input.closest('[data-automation-id="file-upload-drop-zone"]')
    zone.insertAdjacentHTML('beforeend', '<div data-automation-id="file-upload-in-progress" role="progressbar" aria-label="Uploading">Uploading…</div>')
    const body = new FormData()
    body.append('file', file)
    body.append('step', app.dataset.view ?? '')
    await fetch('/workday/_upload', { method: 'POST', body })
    await sleep(300)
    const item = document.createElement('div')
    item.setAttribute('data-automation-id', 'file-upload-successful')
    item.innerHTML =
      '<div data-automation-id="file-upload-item"><span data-automation-id="file-upload-item-name"></span> <span>Successfully Uploaded!</span> <button type="button" data-automation-id="delete-file">Delete</button></div>'
    item.querySelector('[data-automation-id="file-upload-item-name"]').textContent = file.name
    zone.replaceWith(item)
    if (app.dataset.view === 'autofill-resume') {
      store.set('parseUntil', Date.now() + PARSE_MS)
      parseState()
    }
  })

  window.addEventListener('popstate', () => void show(RENDER_MS / 2))
  void show(RENDER_MS)
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * The /workday/ routes. `handle(req, res)` returns false for other paths.
 * @param {{ read: (name: string) => string, record: (req: import('node:http').IncomingMessage) => Promise<Record<string, unknown>>, log: (line: string) => void }} options
 */
export function createWorkdayMock({ read, record, log }) {
  const viewOf = (name) => {
    const html = read(`workday-${name}.html`)
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? 'Workday'
    const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? ''
    return { title, html: body }
  }

  return {
    handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/workday' && !url.pathname.startsWith('/workday/')) return false
      const rest = url.pathname.slice('/workday/'.length)
      if (rest === '_app.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(`(${workdayApp.toString()})()\n`)
      } else if (rest.startsWith('_view/')) {
        const name = rest.slice('_view/'.length)
        if (VIEWS.has(name)) json(res, 200, viewOf(name))
        else json(res, 404, { error: 'No such view' })
      } else if (rest === '_upload' && req.method === 'POST') {
        record(req)
          .then((entry) => {
            log(`[mock-ats] workday: upload ${entry.file} (${entry.bytes} bytes) on ${entry.step}`)
            json(res, 200, { ok: true })
          })
          .catch((err) => json(res, 400, { error: err.message }))
      } else if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(SHELL)
      } else {
        json(res, 405, { error: 'The mock Workday only uploads; nothing is submitted.' })
      }
      return true
    }
  }
}
