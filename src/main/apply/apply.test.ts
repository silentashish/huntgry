import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { factsFromProfile, type PageAnswers } from '@shared/apply-facts'
import type { ApplySession, FillReport, FillValues } from '@shared/apply-types'
import { AUTOFILL_CHANNELS, UPLOAD_ATTR } from '@shared/autofill-channels'
import { detectConfirmation, fillPage, pickAnswers, scanPage, uploadStateOf, verifyFill, type UploadKey } from '@shared/autofill/engine'
import { updateReview, type RecordedReview } from '../review/authority'
import { contentRevisionOf } from '../review/service'
import { refusalFor } from '../browser/url'
import { isLoopbackUrl, localUrlsAllowed } from '../cli/dev-urls'
import { answersFile, pageAnswers, readAnswers, rememberAnswer, rememberMappings, setAnswersRoot } from './answers-store'
import type { MapQuestion } from './map-questions'
import { ApplyService, type AnswersDeps, type ApplyDeps, type ApplyPage } from './service'
import { uploadFile, type Cdp } from './upload'
import { parseFillReport, parsePageScan } from './validate'

const FIXTURES = join(__dirname, '../../shared/autofill/fixtures')
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')

const VALUES: FillValues = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+1 555 123 4567',
  location: 'London',
  linkedin: 'https://www.linkedin.com/in/ada',
  github: '',
  website: '',
  currentCompany: ''
}

/**
 * A browser tab whose "preload" is the real engine running on a jsdom page,
 * answering asynchronously like the IPC round trip does.
 */
class FakeTab implements ApplyPage {
  onNavigationStart?: ApplyPage['onNavigationStart']
  dom: JSDOM
  listeners = new Map<string, Set<(payload: unknown) => void>>()
  loads = new Set<(full: boolean) => void>()
  navigations = new Set<(url: string) => void>()
  closes = new Set<() => void>()
  /** What the page's upload widget shows after an attach; `engine` asks the real adapter, waiting like the preload does. */
  uploadAnswer: string = 'attached'
  lastReport: FillReport | null = null
  sent: string[] = []
  /** The answers each fill request carried (#71). */
  answersSeen: Array<PageAnswers | undefined> = []
  /** The pick switch each fill request carried (#71). */
  picksSeen: Array<boolean | undefined> = []
  /** When set, fill replies wait here until `releaseFills()` (a slow page). */
  heldFills: Array<() => void> | null = null

  releaseFills() {
    const held = this.heldFills ?? []
    this.heldFills = null
    for (const reply of held) reply()
  }

  constructor(html: string, url: string) {
    this.dom = new JSDOM(html, { url })
  }

  load(html: string, url: string) {
    this.commit(html, url)
    this.finishLoad()
  }

  /** A main-frame navigation commits: the new document is active, its load has not finished yet. */
  commit(html: string, url: string) {
    this.dom = new JSDOM(html, { url })
    for (const l of this.navigations) l(url)
  }

  finishLoad() {
    for (const l of this.loads) l(true)
  }

  /** The preload's fill: fill, then the verify pass (without its delays). A marker-only pass keeps the text report. */
  private async fill(values: FillValues, text?: boolean, answers?: PageAnswers, pick?: boolean): Promise<FillReport> {
    const doc = this.dom.window.document
    this.answersSeen.push(answers)
    this.picksSeen.push(pick)
    const filled = fillPage(doc, values, { text, answers, pick })
    await pickAnswers(filled)
    const report = await verifyFill(doc, values, filled, { settleMs: 0 })
    if (text !== false) this.lastReport = report
    return report
  }

  close() {
    for (const l of this.closes) l()
  }

  /** An in-page navigation (pushState): the DOM changes, main hears `did-navigate-in-page`, no step report yet. */
  navigateInPage(html: string, url = this.dom.window.location.href) {
    this.dom = new JSDOM(html, { url })
    for (const l of this.loads) l(false)
  }

  /** A single-page app moving to another step in place (same URL), as the preload's step watcher reports it. */
  step(html: string) {
    this.dom = new JSDOM(html, { url: this.dom.window.location.href })
    this.reply(AUTOFILL_CHANNELS.step, { url: this.dom.window.location.href })
  }

  /** The preload's upload-state wait, against the real adapter. */
  private async engineUploadState(key: UploadKey, fileName: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const state = uploadStateOf(this.dom.window.document, key, fileName)
      if (state === 'attached' || Date.now() >= deadline) return state
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  reply(channel: string, payload: unknown) {
    for (const l of this.listeners.get(channel) ?? []) l(payload)
  }

  send(channel: string, payload: unknown): void {
    this.sent.push(channel)
    const { requestId, values, text, key, fileName, timeoutMs, answers, pick } = payload as {
      requestId: string
      values?: FillValues
      answers?: PageAnswers
      pick?: boolean
      text?: boolean
      key?: UploadKey
      fileName?: string
      timeoutMs?: number
    }
    const doc = this.dom.window.document
    if (channel === AUTOFILL_CHANNELS.fill && this.heldFills) {
      // The page did the fill already; only its answer is late.
      const result = this.fill(values as FillValues, text, answers, pick)
      this.heldFills.push(() => void result.then((r) => this.reply(AUTOFILL_CHANNELS.result, { requestId, ok: true, result: r })))
      return
    }
    void (async () => {
      await Promise.resolve()
      let result: unknown
      if (channel === AUTOFILL_CHANNELS.detect) result = scanPage(doc)
      else if (channel === AUTOFILL_CHANNELS.fill) result = await this.fill(values as FillValues, text, answers, pick)
      else if (channel === AUTOFILL_CHANNELS.uploadState)
        result =
          this.uploadAnswer === 'engine'
            ? await this.engineUploadState(key ?? 'resume', fileName ?? '', timeoutMs ?? 1000)
            : this.uploadAnswer
      else if (channel === AUTOFILL_CHANNELS.afterUpload)
        result = this.lastReport && (await verifyFill(doc, values as FillValues, this.lastReport, { settleMs: 0 }))
      else return
      this.reply(AUTOFILL_CHANNELS.result, { requestId, ok: true, result })
    })()
  }

  onMessage(channel: string, listener: (payload: unknown) => void) {
    const set = this.listeners.get(channel) ?? new Set()
    set.add(listener)
    this.listeners.set(channel, set)
    return () => set.delete(listener)
  }

  onLoad(listener: (full: boolean) => void) {
    this.loads.add(listener)
    return () => this.loads.delete(listener)
  }

  onNavigate(listener: (url: string) => void) {
    this.navigations.add(listener)
    return () => this.navigations.delete(listener)
  }

  onClosed(listener: () => void) {
    this.closes.add(listener)
    return () => this.closes.delete(listener)
  }
}

class FakeDebugger implements Cdp {
  log: string[] = []
  attached = false
  failOn: string | null = null
  files: string[] = []
  /** Runs after `DOM.setFileInputFiles`, like the site's widget reacting to the file. */
  onSetFiles: (() => void) | null = null
  /** What `DOM.getDocument` says the tab's document is (undefined: not reported). */
  documentURL: string | undefined = undefined
  /** When set, this command waits for `open()` (a slow CDP round trip). */
  gate: { method: string; open(): void; wait: Promise<void> } | null = null

  holdOn(method: string) {
    let open = () => undefined as void
    const wait = new Promise<void>((resolve) => (open = resolve))
    this.gate = { method, open: () => open(), wait }
  }

  async sendCommand(method: string, params?: object): Promise<unknown> {
    this.log.push(method)
    if (this.gate?.method === method) await this.gate.wait
    if (method === this.failOn) return Promise.reject(new Error(`${method} failed`))
    const p = (params ?? {}) as Record<string, unknown>
    if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1, documentURL: this.documentURL } })
    if (method === 'DOM.querySelector') {
      this.log.push(`selector ${String(p.selector)}`)
      return Promise.resolve({ nodeId: 7 })
    }
    if (method === 'DOM.setFileInputFiles') {
      this.files = p.files as string[]
      this.onSetFiles?.()
    }
    return Promise.resolve({})
  }

  isAttached() {
    return this.attached
  }

  detach() {
    this.attached = false
    this.log.push('detach')
  }
}

let ws: string
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-apply-'))
})
afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
})

const ID = 'software-engineer/acme/gh-1'

async function application(files: Record<string, string>, id = ID): Promise<string> {
  const dir = join(ws, id)
  await mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
  return dir
}

function setup(tab: FakeTab, dbg = new FakeDebugger(), extra: Partial<ApplyDeps> = {}, tabs: Record<string, FakeTab> = {}) {
  const events: Array<ApplySession | null> = []
  const opened: string[] = []
  const navigated: string[] = []
  const popupListeners = new Set<(opener: string, child: string) => void>()
  const openPopup = (opener: string, child: string) => {
    for (const l of popupListeners) l(opener, child)
  }
  const deps: ApplyDeps = {
    workspace: async () => ws,
    values: async () => VALUES,
    openTab: async (url) => {
      opened.push(url)
      return 'tab-1'
    },
    navigate: async (_id, url) => navigated.push(url),
    page: (id) => tabs[id] ?? tab,
    onTabOpened: (listener) => {
      popupListeners.add(listener)
      return () => popupListeners.delete(listener)
    },
    attachDebugger: () => {
      dbg.attached = true
      dbg.log.push('attach')
      return dbg
    },
    emit: (s) => events.push(s),
    retryDelaysMs: [],
    requestTimeoutMs: 500,
    uploadConfirmMs: 50,
    ...extra
  }
  return { service: new ApplyService(deps), events, opened, navigated, dbg, openPopup }
}

/** Waits until the session reaches `status` (the flow is a chain of async hops). */
async function until(service: ApplyService, status: ApplySession['status']) {
  await vi.waitFor(() => expect(service.current()?.status).toBe(status), { timeout: 2000, interval: 5 })
}

const GH_URL = 'https://job-boards.greenhouse.io/acme/jobs/1000001'

describe('ApplyService', () => {
  it('refuses an application without a posting URL or a resume.pdf', async () => {
    await application({ 'job-description.md': 'Engineer\n', 'resume.pdf': '%PDF' })
    const { service } = setup(new FakeTab('', GH_URL))
    await expect(service.start(ID)).rejects.toThrow(/no posting URL/)

    await application({ 'job-description.md': `Engineer\n${GH_URL}\n` }, 'a/b/no-resume')
    await expect(service.start('a/b/no-resume')).rejects.toThrow(/no resume\.pdf/)
    expect(service.current()).toBeNull()
  })

  it('refuses an unattended result until it is approved on the Review page (#31 gate)', async () => {
    const files = { 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF', 'huntgry.json': JSON.stringify({ status: 'generated' }) }
    const record = (state: RecordedReview['state'], extra: Partial<RecordedReview> = {}) =>
      updateReview(ws, ID, () => ({ state, runId: '20260930-000000-aaaaaa', at: '2026-09-30T00:00:00.000Z', ...extra }))
    await application(files)
    await record('unreviewed')
    const { service } = setup(new FakeTab('', GH_URL))
    await expect(service.start(ID)).rejects.toThrow(/Unreviewed.*Review page/)
    await record('needs-attention')
    await expect(service.start(ID)).rejects.toThrow(/needs attention/)
    await record('discarded')
    await expect(service.start(ID)).rejects.toThrow(/discarded/)
    expect(service.current()).toBeNull()
    // Approved without the files it vouches for: refused; with them: opens.
    await record('approved')
    await expect(service.start(ID)).rejects.toThrow(/changed since you approved/)
    await record('approved', { contentRevision: await contentRevisionOf(ws, ID) })
    await expect(service.start(ID)).resolves.toMatchObject({ status: 'opened' })
  })

  it('an approval no longer holds once the resume changed, and an agent cannot approve through huntgry.json', async () => {
    const dir = await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF', 'huntgry.json': '{}' })
    await updateReview(ws, ID, () => ({ state: 'unreviewed', runId: '20260930-000000-aaaaaa', at: '2026-09-30T00:00:00.000Z' }))
    const { service } = setup(new FakeTab('', GH_URL))
    // The agent writes "approved" where it can write: main's state stays Unreviewed.
    await writeFile(join(dir, 'huntgry.json'), JSON.stringify({ review: { state: 'approved', runId: '20260930-000000-aaaaaa', at: '2026-09-30T09:00:00.000Z' } }))
    await expect(service.start(ID)).rejects.toThrow(/Unreviewed/)
    // Approved, then the run (or anything) rewrites the PDF: Apply refuses until it is reviewed again.
    const approvedRevision = await contentRevisionOf(ws, ID)
    await updateReview(ws, ID, (c) => ({ ...c!, state: 'approved', contentRevision: approvedRevision }))
    await writeFile(join(dir, 'resume.pdf'), '%PDF rewritten')
    await expect(service.start(ID)).rejects.toThrow(/changed since you approved/)
    expect(service.current()).toBeNull()
  })

  it('fails closed: review notes without a review state, or a malformed one, block Apply (#31 gate)', async () => {
    const jd = { 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' }
    await application({ ...jd, 'review-notes.md': '# Review notes\n' }, 'a/b/stopped-run')
    const { service } = setup(new FakeTab('', GH_URL))
    await expect(service.start('a/b/stopped-run')).rejects.toThrow(/Unreviewed.*Review page/)
    await application({ ...jd, 'huntgry.json': JSON.stringify({ status: 'generated', review: { state: 'aproved' } }) }, 'a/b/broken')
    await expect(service.start('a/b/broken')).rejects.toThrow(/needs attention/)
    // A well-formed "approved" that main never recorded is no better.
    await application({ ...jd, 'huntgry.json': JSON.stringify({ review: { state: 'approved', runId: 'x', at: 'y' } }) }, 'a/b/forged')
    await expect(service.start('a/b/forged')).rejects.toThrow(/needs attention/)
    expect(service.current()).toBeNull()
  })

  it('refuses a symlinked resume.pdf and ids outside the workspace', async () => {
    const outside = join(ws, 'secret.pdf')
    await writeFile(outside, '%PDF secret')
    const dir = await application({ 'job-description.md': `Engineer\n${GH_URL}\n` })
    await symlink(outside, join(dir, 'resume.pdf'))
    const { service } = setup(new FakeTab('', GH_URL))
    await expect(service.start(ID)).rejects.toThrow(/no resume\.pdf/)
    await expect(service.start('../../etc/x')).rejects.toThrow()
  })

  it('opens the apply page, fills it, uploads resume.pdf over CDP and never submits', async () => {
    const dir = await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab(fixture('greenhouse-form.html'), GH_URL)
    const submit = vi.spyOn(tab.dom.window.HTMLFormElement.prototype, 'submit')
    const { service, opened, dbg, events } = setup(tab)

    const session = await service.start(ID)
    expect(session).toMatchObject({
      status: 'opened',
      applyUrl: GH_URL,
      tabId: 'tab-1',
      title: 'Software Engineer · Acme'
    })
    expect(opened).toEqual([GH_URL])

    tab.load(fixture('greenhouse-form.html'), GH_URL)
    const form = tab.dom
    const submitted = vi.spyOn(form.window.HTMLFormElement.prototype, 'submit')
    await until(service, 'filled')

    const current = service.current()!
    expect(current.ats).toBe('greenhouse')
    expect((form.window.document.getElementById('first_name') as HTMLInputElement).value).toBe('Ada')
    expect(current.report?.fields.find((f) => f.key === 'resume')).toMatchObject({
      outcome: 'uploaded',
      value: 'resume.pdf'
    })
    expect(dbg.log).toEqual([
      'attach',
      'DOM.getDocument',
      'DOM.querySelector',
      'selector [data-huntgry-upload="resume"]',
      'DOM.setFileInputFiles',
      'detach'
    ])
    expect(dbg.files).toEqual([join(dir, 'resume.pdf')])
    expect(await realpath(dbg.files[0])).toBe(await realpath(join(dir, 'resume.pdf')))
    expect(dbg.attached).toBe(false)
    expect(current.message).toMatch(/Submit button yourself/)
    expect(events.map((e) => e?.status)).toEqual(['opened', 'opened', 'filling', 'filled'])
    expect(submit).not.toHaveBeenCalled()
    expect(submitted).not.toHaveBeenCalled()
  })

  it('detaches the debugger when the upload fails', async () => {
    await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', GH_URL)
    const dbg = new FakeDebugger()
    dbg.failOn = 'DOM.setFileInputFiles'
    const { service } = setup(tab, dbg)
    await service.start(ID)
    tab.load(fixture('greenhouse-form.html'), GH_URL)
    await until(service, 'filled')
    expect(service.current()!.report?.fields.find((f) => f.key === 'resume')).toMatchObject({
      outcome: 'upload-failed',
      reason: 'DOM.setFileInputFiles failed'
    })
    expect(dbg.log.at(-1)).toBe('detach')
    expect(dbg.attached).toBe(false)
    expect(service.current()!.message).toMatch(/upload failed/)
  })

  it('drops a fill whose page was replaced by the confirmation page meanwhile', async () => {
    await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', GH_URL)
    const { service, dbg } = setup(tab)
    await service.start(ID)
    tab.heldFills = []
    tab.load(fixture('greenhouse-form.html'), GH_URL)
    await until(service, 'filling')
    // The user submits; the site's confirmation page loads while the old fill is still pending.
    tab.load(fixture('greenhouse-confirmation.html'), `${GH_URL}/confirmation`)
    await until(service, 'submitted-detected')
    tab.releaseFills()
    await new Promise((r) => setTimeout(r, 30))
    expect(service.current()).toMatchObject({ status: 'submitted-detected', report: null })
    expect(dbg.log).toEqual([])
  })

  it('drops a pending fill as soon as another document commits, before its load finishes (#63 review)', async () => {
    await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', GH_URL)
    const { service, dbg } = setup(tab)
    await service.start(ID)
    tab.heldFills = []
    tab.load(fixture('greenhouse-form.html'), GH_URL)
    await until(service, 'filling')
    // The user follows a link: the untrusted page is active, but did-finish-load has not fired yet.
    tab.commit(fixture('greenhouse-form.html'), 'https://untrusted.example/application')
    tab.releaseFills()
    await new Promise((r) => setTimeout(r, 30))
    // Nothing reached the debugger, so the new page never received the previous page's resume.
    expect(dbg.log).toEqual([])
    expect(service.current()!.status).not.toBe('filled')
    tab.finishLoad()
    await until(service, 'ready')
    expect(service.current()!.message).toMatch(/untrusted\.example/)
    expect(dbg.log).toEqual([])
  })

  it('drops a pending fill when a navigation starts', async () => {
    await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', GH_URL)
    const starts = new Set<() => void>()
    tab.onNavigationStart = (listener: () => void) => {
      starts.add(listener)
      return () => starts.delete(listener)
    }
    const { service, dbg } = setup(tab)
    await service.start(ID)
    tab.heldFills = []
    tab.load(fixture('greenhouse-form.html'), GH_URL)
    await until(service, 'filling')
    for (const l of starts) l()
    tab.releaseFills()
    await new Promise((r) => setTimeout(r, 30))
    expect(dbg.log).toEqual([])
  })

  it('does not stay on "Filling" when a navigation starts but never commits (cancelled, download, 204)', async () => {
    await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', GH_URL)
    const starts = new Set<() => void>()
    tab.onNavigationStart = (listener: () => void) => {
      starts.add(listener)
      return () => starts.delete(listener)
    }
    const { service, dbg } = setup(tab)
    await service.start(ID)
    tab.heldFills = []
    tab.load(fixture('greenhouse-form.html'), GH_URL)
    await until(service, 'filling')
    // A navigation starts; no did-navigate / did-finish-load follows.
    for (const l of starts) l()
    tab.releaseFills()
    await until(service, 'ready')
    expect(service.current()!.message).toBe('Press Fill form to fill this page.')
    expect(dbg.log).toEqual([])
    // Fill form works again on the same page.
    await service.fill(service.current()!.id)
    expect(service.current()!.status).toBe('filled')
  })

  it('refuses an upload when CDP finds another document than the one filled', async () => {
    await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', GH_URL)
    const dbg = new FakeDebugger()
    dbg.documentURL = 'https://untrusted.example/application'
    const { service } = setup(tab, dbg)
    await service.start(ID)
    tab.load(fixture('greenhouse-form.html'), GH_URL)
    await until(service, 'filled')
    expect(dbg.log).not.toContain('DOM.setFileInputFiles')
    expect(service.current()!.report?.fields.find((f) => f.key === 'resume')).toMatchObject({
      outcome: 'upload-failed',
      reason: 'The page changed; the upload was cancelled.'
    })
    // The same document (fragment aside) is fine.
    const ok = new FakeDebugger()
    ok.documentURL = `${GH_URL}#app`
    await uploadFile(() => ok, '[x]', ['/tmp/a.pdf'], { documentUrl: GH_URL })
    expect(ok.log).toContain('DOM.setFileInputFiles')
  })

  it('cancels an upload in flight when the page confirms submission', async () => {
    await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', GH_URL)
    const dbg = new FakeDebugger()
    dbg.holdOn('DOM.querySelector')
    const { service } = setup(tab, dbg)
    await service.start(ID)
    tab.load(fixture('greenhouse-form.html'), GH_URL)
    await vi.waitFor(() => expect(dbg.log).toContain('DOM.querySelector'))
    // A single-page form swaps in its "submitted" view (the preload's watcher reports it).
    tab.reply(AUTOFILL_CHANNELS.confirmation, { url: GH_URL })
    await until(service, 'submitted-detected')
    dbg.gate?.open()
    await vi.waitFor(() => expect(dbg.log.at(-1)).toBe('detach'))
    await new Promise((r) => setTimeout(r, 30))
    expect(dbg.log).not.toContain('DOM.setFileInputFiles')
    expect(dbg.attached).toBe(false)
    expect(service.current()!.status).toBe('submitted-detected')
  })

  it('reports a confirmation page and leaves tracking alone', async () => {
    const dir = await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', GH_URL)
    const { service } = setup(tab)
    await service.start(ID)
    tab.load(fixture('greenhouse-confirmation.html'), `${GH_URL}/confirmation`)
    await until(service, 'submitted-detected')
    expect(service.current()!.message).toMatch(/Mark this application as applied/)
    // The preload's own watcher (single-page confirmation) says the same.
    await service.fill(service.current()!.id).catch(() => undefined)
    tab.reply(AUTOFILL_CHANNELS.confirmation, { url: GH_URL })
    await until(service, 'submitted-detected')
    expect(await readdir(dir)).not.toContain('huntgry.json')
  })

  it('opens Lever postings on /apply and fills by field name', async () => {
    const posting = 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000001'
    await application({ 'job-description.md': `Engineer\n${posting}\n`, 'resume.pdf': '%PDF', 'cover.pdf': '%PDF' })
    const tab = new FakeTab('', `${posting}/apply`)
    const { service, opened } = setup(tab)
    const session = await service.start(ID)
    expect(opened).toEqual([`${posting}/apply`])
    expect(session.hasCover).toBe(true)
    tab.load(fixture('lever-form.html'), `${posting}/apply`)
    await until(service, 'filled')
    expect((tab.dom.window.document.querySelector('[name="name"]') as HTMLInputElement).value).toBe('Ada Lovelace')
    expect(service.current()!.ats).toBe('lever')
  })

  it('does not fill a page on another origin on its own, however much it looks like an ATS form', async () => {
    const careers = 'https://careers.example.com/jobs/1'
    await application({ 'job-description.md': `Engineer\n${careers}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', careers)
    const { service, dbg, navigated } = setup(tab)
    await service.start(ID)
    // The posting loads first; the user then follows a link elsewhere: Greenhouse markup on an unrelated host.
    tab.load('<h1>Engineer</h1>', careers)
    await until(service, 'ready')
    tab.sent = []
    tab.load(fixture('greenhouse-form.html'), 'https://evil.example/apply')
    await until(service, 'ready')
    expect(service.current()!.message).toMatch(/evil\.example.*Fill form/)
    expect(tab.sent).toEqual([AUTOFILL_CHANNELS.detect])
    expect((tab.dom.window.document.getElementById('first_name') as HTMLInputElement).value).toBe('')
    expect(dbg.log).toEqual([])
    // Nor is an embedded form on such a page followed.
    tab.load(fixture('greenhouse-embed-host.html'), 'https://evil.example/careers')
    await until(service, 'ready')
    expect(navigated).toEqual([])
    // The user can still fill it deliberately.
    tab.load(fixture('greenhouse-form.html'), 'https://evil.example/apply')
    await until(service, 'ready')
    await service.fill(service.current()!.id)
    expect(service.current()!.status).toBe('filled')
    expect((tab.dom.window.document.getElementById('first_name') as HTMLInputElement).value).toBe('Ada')
  })

  it('fills a Greenhouse or Lever host reached from the posting (redirect, embed)', async () => {
    const careers = 'https://careers.example.com/jobs/1'
    await application({ 'job-description.md': `Engineer\n${careers}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', careers)
    const { service } = setup(tab)
    await service.start(ID)
    tab.load(fixture('greenhouse-form.html'), 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1')
    await until(service, 'filled')
  })

  it('opens an embedded Greenhouse form directly', async () => {
    const careers = 'https://acme.example/careers/engineer'
    await application({ 'job-description.md': `Engineer\n${careers}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', careers)
    const { service, navigated } = setup(tab)
    await service.start(ID)
    tab.load(fixture('greenhouse-embed-host.html'), careers)
    await vi.waitFor(() => expect(navigated).toHaveLength(1))
    expect(navigated[0]).toMatch(/^https:\/\/job-boards\.greenhouse\.io\/embed\/job_app\?for=acme&token=1000001/)
  })

  it('trusts where the posting URL redirected to (a Greenhouse board → the company careers site)', async () => {
    const board = 'https://job-boards.greenhouse.io/acme/jobs/1000001'
    const careers = 'https://careers.acme.example/positions/1000001?gh_jid=1000001'
    await application({ 'job-description.md': `Engineer\n${board}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', board)
    const { service, navigated } = setup(tab)
    await service.start(ID)
    // The board's 302 lands on the company site, which embeds the form with a short-lived token.
    tab.load(fixture('greenhouse-embed-host.html').replace('token=1000001', 'validityToken=abc'), careers)
    await vi.waitFor(() => expect(navigated).toHaveLength(1))
    expect(navigated[0]).toMatch(/^https:\/\/job-boards\.greenhouse\.io\/embed\/job_app\?for=acme&validityToken=abc/)
    expect(service.current()!.message).toMatch(/embeds the Greenhouse application form/)

    // The token expired: Greenhouse shows its error board; the company page is loaded again for a fresh one.
    tab.load('<h1>Sorry</h1>', 'https://job-boards.greenhouse.io/embed/job_board?for=acme&error=true')
    await vi.waitFor(() => expect(navigated).toEqual([navigated[0], careers]))
    expect(service.current()!.message).toMatch(/expired/)

    // A later page the user clicked to on another site is still not trusted.
    tab.load(fixture('greenhouse-form.html'), 'https://other.example/apply')
    await until(service, 'ready')
    expect(service.current()!.message).toMatch(/other\.example/)
  })

  it('opens a loopback embedded form only when local URLs are allowed (dev builds)', async () => {
    const host = 'http://127.0.0.1:4173/company/careers'
    await application({ 'job-description.md': `Engineer\n${host}\n`, 'resume.pdf': '%PDF' })
    const html = '<iframe src="http://127.0.0.1:4174/embed/job_app?for=acme&validityToken=t"></iframe>'
    for (const allow of [false, true]) {
      const tab = new FakeTab('', host)
      const { service, navigated } = setup(tab, undefined, { allowLocalEmbeds: allow })
      await service.start(ID)
      tab.load(html, host)
      if (allow) await vi.waitFor(() => expect(navigated).toHaveLength(1))
      else {
        await until(service, 'ready')
        expect(navigated).toEqual([])
      }
    }
  })

  it('follows the form into a popup tab opened from the session tab', async () => {
    const posting = 'https://careers.example.com/jobs/1'
    await application({ 'job-description.md': `Engineer\n${posting}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', posting)
    const popup = new FakeTab('', posting)
    const { service, openPopup } = setup(tab, undefined, {}, { 'tab-2': popup })
    await service.start(ID)
    tab.load('<h1>Engineer</h1><a href="/apply/1" target="_blank">Apply</a>', posting)
    await until(service, 'ready')
    expect(service.current()!.message).toMatch(/page's own Apply button/)
    // The user presses the page's Apply; the site opens the form in a new tab.
    openPopup('tab-9', 'tab-2')
    expect(service.current()!.tabId).toBe('tab-1')
    openPopup('tab-1', 'tab-2')
    expect(service.current()).toMatchObject({ tabId: 'tab-2', status: 'opened' })
    popup.load(fixture('generic-form.html'), 'https://careers.example.com/apply/1')
    await until(service, 'filled')
    expect((popup.dom.window.document.querySelector('#f1') as HTMLInputElement).value).toBe('Ada')
    // The old tab is no longer followed.
    tab.load(fixture('greenhouse-confirmation.html'), `${posting}/confirmation`)
    await new Promise((r) => setTimeout(r, 20))
    expect(service.current()!.status).toBe('filled')
  })

  it('reports an upload the site widget never shows as failed, after one retry', async () => {
    await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', GH_URL)
    tab.uploadAnswer = 'missing'
    const { service, dbg } = setup(tab)
    await service.start(ID)
    tab.load(fixture('greenhouse-form.html'), GH_URL)
    await until(service, 'filled')
    expect(service.current()!.report?.fields.find((f) => f.key === 'resume')).toMatchObject({
      outcome: 'upload-failed',
      reason: 'The site did not show resume.pdf as attached; attach it yourself.'
    })
    expect(dbg.log.filter((l) => l === 'DOM.setFileInputFiles')).toHaveLength(2)
    expect(service.current()!.message).toMatch(/upload failed/)
  })

  it('does not attach twice while the site is still uploading', async () => {
    await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', GH_URL)
    tab.uploadAnswer = 'pending'
    const { service, dbg } = setup(tab)
    await service.start(ID)
    tab.load(fixture('greenhouse-form.html'), GH_URL)
    await until(service, 'filled')
    expect(dbg.log.filter((l) => l === 'DOM.setFileInputFiles')).toHaveLength(1)
    expect(service.current()!.report?.fields.find((f) => f.key === 'resume')?.reason).toMatch(/still uploading/)
  })

  it('tells the user what to do on a non-form step and fills nothing', async () => {
    await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', GH_URL)
    const { service } = setup(tab)
    await service.start(ID)
    tab.send = function (channel: string, payload: unknown) {
      const { requestId } = payload as { requestId: string }
      this.sent.push(channel)
      queueMicrotask(() =>
        this.reply(AUTOFILL_CHANNELS.result, {
          requestId,
          ok: true,
          result: { ...scanPage(this.dom.window.document), step: 'account-wall' }
        })
      )
    }
    tab.load(fixture('greenhouse-form.html'), GH_URL)
    await until(service, 'waiting')
    expect(service.current()!.message).toMatch(/Sign in or create your account in the page yourself/)
    expect(service.current()!.step).toEqual({ kind: 'account-wall', title: null })
    expect(tab.sent).toEqual([AUTOFILL_CHANNELS.detect])
  })

  it('opens an Ashby posting on /application, waits for the late form and attaches to #_systemfield_resume', async () => {
    const posting = 'https://jobs.ashbyhq.com/acme/0f3c1f5a-1111-4222-8333-944445555666'
    await application({ 'job-description.md': `Engineer\n${posting}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', `${posting}/application`)
    const { service, opened, dbg } = setup(tab, new FakeDebugger(), { retryDelaysMs: [50] })
    await service.start(ID)
    expect(opened).toEqual([`${posting}/application`])
    // Client-rendered: at load the page is an empty shell. Recognised by host, nothing to fill yet.
    tab.load('<!DOCTYPE html><title>Software Engineer @ Acme</title><div id="root"></div>', `${posting}/application`)
    await until(service, 'ready')
    expect(service.current()!.ats).toBe('ashby')
    // React renders the form into the same document: no new load event, as on the real SPA. Only the service's
    // re-detect can pick it up.
    const rendered = new JSDOM(fixture('ashby-form.html')).window.document.getElementById('root')!.innerHTML
    tab.dom.window.document.getElementById('root')!.innerHTML = rendered
    await until(service, 'filled')
    const doc = tab.dom.window.document
    expect((doc.getElementById('_systemfield_name') as HTMLInputElement).value).toBe('Ada Lovelace')
    expect(doc.getElementById('_systemfield_resume')!.getAttribute(UPLOAD_ATTR)).toBe('resume')
    // The "Autofill from resume" input is never marked.
    expect(doc.querySelector(`.ashby-application-form-autofill-uploader input[${UPLOAD_ATTR}]`)).toBeNull()
    expect(service.current()!.report?.fields.find((f) => f.key === 'resume')).toMatchObject({ outcome: 'uploaded' })
    expect(dbg.log).toContain('DOM.setFileInputFiles')
  })

  it('opens an embedded Ashby form on its /application page and fills it there', async () => {
    const careers = 'https://acme.example/careers/engineer'
    await application({ 'job-description.md': `Engineer\n${careers}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', careers)
    const { service, navigated } = setup(tab)
    await service.start(ID)
    tab.load(fixture('ashby-embed-host.html'), careers)
    await vi.waitFor(() => expect(navigated).toHaveLength(1))
    const form = 'https://jobs.ashbyhq.com/acme/0f3c1f5a-1111-4222-8333-944445555666/application'
    expect(navigated[0]).toBe(form)
    expect(service.current()!.message).toBe('This page embeds the Ashby application form; opening it directly.')
    // jobs.ashbyhq.com is not the posting's origin, but a verified ATS host: filled without asking.
    tab.load(fixture('ashby-form.html'), form)
    await until(service, 'filled')
    expect((tab.dom.window.document.getElementById('_systemfield_email') as HTMLInputElement).value).toBe('ada@example.com')
  })

  it('does not follow an Ashby iframe that is not a job, or one on an untrusted page', async () => {
    const careers = 'https://acme.example/careers'
    await application({ 'job-description.md': `Engineer\n${careers}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', careers)
    const { service, navigated } = setup(tab)
    await service.start(ID)
    tab.load('<h1>Careers</h1><iframe id="ashby_embed_iframe" src="https://jobs.ashbyhq.com/acme?embed=js"></iframe>', careers)
    await until(service, 'ready')
    tab.load(fixture('ashby-embed-host.html'), 'https://evil.example/careers')
    await until(service, 'ready')
    expect(navigated).toEqual([])
  })

  it('reports a bot wall as blocked, and a page without a form as ready', async () => {
    const url = 'https://careers.example.com/jobs/1'
    await application({ 'job-description.md': `Engineer\n${url}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', url)
    const { service } = setup(tab)
    await service.start(ID)
    tab.load('<title>Just a moment...</title><p>Verify you are human</p>', url)
    await until(service, 'blocked')
    tab.load('<h1>Engineer</h1><p>About the role</p>', url)
    await until(service, 'ready')
  })

  it('does not auto-fill a generic page without a resume upload', async () => {
    const url = 'https://careers.example.com/jobs/1'
    await application({ 'job-description.md': `Engineer\n${url}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', url)
    const { service } = setup(tab)
    await service.start(ID)
    tab.load('<form><label>Email <input name="email"></label><label>Name <input name="name"></label></form>', url)
    await until(service, 'ready')
    expect(tab.sent).toEqual([AUTOFILL_CHANNELS.detect])
    await service.fill(service.current()!.id)
    expect(service.current()!.status).toBe('filled')
  })

  it('refuses a second start while the first is still opening', async () => {
    await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' })
    await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' }, 'a/b/other')
    const { service, opened } = setup(new FakeTab('', GH_URL))
    const [first, second] = await Promise.allSettled([service.start(ID), service.start('a/b/other')])
    expect(first).toMatchObject({ status: 'fulfilled', value: { applicationId: ID } })
    expect(second).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringMatching(/still starting/) })
    })
    expect(opened).toHaveLength(1)
    expect(service.current()!.applicationId).toBe(ID)
    // Once it has started, a new Apply may replace the session as before.
    await expect(service.start('a/b/other')).resolves.toMatchObject({ applicationId: 'a/b/other' })
  })

  it('ends on cancel, on a second start and when the tab closes', async () => {
    await application({ 'job-description.md': `Engineer\n${GH_URL}\n`, 'resume.pdf': '%PDF' })
    const first = new FakeTab('', GH_URL)
    const { service, events } = setup(first)
    const s1 = await service.start(ID)
    const s2 = await service.start(ID)
    expect(s2.id).not.toBe(s1.id)
    expect(events).toContain(null)
    await expect(service.fill(s1.id)).rejects.toThrow(/ended/)

    first.close()
    expect(service.current()).toMatchObject({ id: s2.id, status: 'closed' })
    await expect(service.fill(s2.id)).rejects.toThrow(/ended/)
    service.cancel(s2.id)
    expect(service.current()).toBeNull()
    expect(events.at(-1)).toBeNull()
    // Listeners are gone: a late load does nothing.
    first.load(fixture('greenhouse-form.html'), GH_URL)
    expect(first.loads.size).toBe(0)
  })
})

describe('ApplyService on Workday', () => {
  const JOB = 'https://acme.wd1.myworkdayjobs.com/en-US/AcmeCareers/job/Remote-USA/Software-Engineer_JR-1001'
  const WD_ID = 'software-engineer/acme/wd-1'
  const workdayApp = () => application({ 'job-description.md': `Engineer\n${JOB}\n`, 'resume.pdf': '%PDF' }, WD_ID)
  /** A tab whose upload-state answer comes from the Workday adapter's widget check. */
  const wdTab = () => {
    const tab = new FakeTab('', JOB)
    tab.uploadAnswer = 'engine'
    return tab
  }
  /** Workday's widget lists a file a little after the attach (and after its parse): allow it 600 ms. */
  const wdSetup = (tab: FakeTab, dbg = new FakeDebugger(), extra: Partial<ApplyDeps> = {}) =>
    setup(tab, dbg, { uploadConfirmMs: 600, ...extra })
  const value = (tab: FakeTab, selector: string) => (tab.dom.window.document.querySelector(selector) as HTMLInputElement).value

  /** Workday's widget: the drop zone gives way to the uploaded-file list once the file is in (and parsed). */
  const showUploaded = (tab: FakeTab, delayMs = 50) => () => {
    setTimeout(() => {
      const zone = tab.dom.window.document.querySelector('[data-automation-id="file-upload-drop-zone"]')
      if (zone)
        zone.outerHTML =
          '<div data-automation-id="file-upload-successful"><div data-automation-id="file-upload-item">resume.pdf</div></div>'
    }, delayMs)
  }

  it('walks posting → choice → sign-in wall → My Information → My Experience, filling only the form steps, once each', async () => {
    await workdayApp()
    const tab = wdTab()
    const dbg = new FakeDebugger()
    dbg.onSetFiles = showUploaded(tab, 120)
    const { service } = wdSetup(tab, dbg)
    const session = await service.start(WD_ID)
    expect(session.applyUrl).toBe(JOB)

    tab.load(fixture('workday-posting.html'), JOB)
    await until(service, 'waiting')
    expect(service.current()).toMatchObject({ ats: 'workday', step: { kind: 'posting', title: 'Job posting' } })
    expect(service.current()!.message).toMatch(/Press "Apply" in the page yourself/)

    tab.load(fixture('workday-apply-choice.html'), `${JOB}/apply`)
    await vi.waitFor(() => expect(service.current()!.step?.kind).toBe('choice'))
    expect(service.current()!.message).toMatch(/"Autofill with Resume".*"Apply Manually"/)

    tab.load(fixture('workday-signin.html'), `${JOB}/apply/applyManually`)
    await vi.waitFor(() => expect(service.current()!.step?.kind).toBe('account-wall'))
    expect(service.current()).toMatchObject({ status: 'waiting', report: null })
    expect(service.current()!.message).toMatch(/Sign in or create your Workday account in the page yourself/)
    expect(value(tab, '[data-automation-id="email"]')).toBe('')
    expect(value(tab, '[data-automation-id="password"]')).toBe('')
    expect(tab.sent).not.toContain(AUTOFILL_CHANNELS.fill)

    // The user signs in; Workday swaps in My Information without a navigation.
    tab.step(fixture('workday-my-information.html'))
    await until(service, 'filled')
    expect(service.current()!.step).toEqual({ kind: 'form', title: 'My Information' })
    expect(value(tab, '#name--legalName--firstName')).toBe('Ada')
    expect(value(tab, '#phoneNumber--phoneNumber')).toBe('+1 555 123 4567')
    expect(dbg.log).toEqual([])

    // Next (pressed by the user) → My Experience, same URL: the resume goes in and Workday's widget confirms it.
    tab.step(fixture('workday-my-experience.html'))
    await vi.waitFor(() => expect(service.current()!.step?.title).toBe('My Experience'))
    await until(service, 'filled')
    expect(service.current()!.report?.fields.find((f) => f.key === 'resume')).toMatchObject({
      outcome: 'uploaded',
      value: 'resume.pdf'
    })
    expect(value(tab, '[data-automation-id="linkedinQuestion"]')).toBe(VALUES.linkedin)
    expect(dbg.log.filter((l) => l === 'DOM.setFileInputFiles')).toHaveLength(1)

    // The same step reported again (a re-render) is not filled or uploaded twice.
    const fills = tab.sent.filter((c) => c === AUTOFILL_CHANNELS.fill).length
    tab.reply(AUTOFILL_CHANNELS.step, {})
    await new Promise((r) => setTimeout(r, 50))
    expect(tab.sent.filter((c) => c === AUTOFILL_CHANNELS.fill)).toHaveLength(fills)

    // Application Questions is the user's.
    tab.step(fixture('workday-application-questions.html'))
    await until(service, 'waiting')
    expect(service.current()).toMatchObject({ report: null, step: { kind: 'other', title: 'Application Questions' } })
    expect(service.current()!.message).toMatch(/Nothing for Huntgry on this step \("Application Questions"\)/)
  })

  it('a step reported again while its fill is running (in-page navigation, then the watcher) does not cancel it', async () => {
    await workdayApp()
    const tab = wdTab()
    const { service } = wdSetup(tab)
    await service.start(WD_ID)
    tab.load(fixture('workday-signin.html'), `${JOB}/apply/applyManually`)
    await until(service, 'waiting')

    // The in-page navigation's detect sees My Information and starts filling; the page is slow to answer.
    tab.heldFills = []
    tab.navigateInPage(fixture('workday-my-information.html'))
    await until(service, 'filling')
    await vi.waitFor(() => expect(tab.heldFills).toHaveLength(1))
    // Then the preload's watcher reports the same step.
    tab.reply(AUTOFILL_CHANNELS.step, {})
    await new Promise((r) => setTimeout(r, 30))
    tab.releaseFills()
    await until(service, 'filled')
    expect(service.current()!.report?.fields.find((f) => f.key === 'firstName')).toMatchObject({ outcome: 'filled' })
    expect(value(tab, '#name--legalName--firstName')).toBe('Ada')
  })

  it('a duplicate step report during the resume upload keeps the upload and its confirmation', async () => {
    await workdayApp()
    const tab = wdTab()
    const dbg = new FakeDebugger()
    dbg.holdOn('DOM.setFileInputFiles')
    dbg.onSetFiles = showUploaded(tab, 20)
    const { service } = wdSetup(tab, dbg)
    await service.start(WD_ID)
    tab.load(fixture('workday-signin.html'), `${JOB}/apply/applyManually`)
    await until(service, 'waiting')
    tab.navigateInPage(fixture('workday-my-experience.html'))
    await vi.waitFor(() => expect(dbg.log).toContain('DOM.setFileInputFiles'))
    tab.reply(AUTOFILL_CHANNELS.step, {})
    await new Promise((r) => setTimeout(r, 30))
    dbg.gate!.open()
    await until(service, 'filled')
    expect(service.current()!.report?.fields.find((f) => f.key === 'resume')).toMatchObject({ outcome: 'uploaded' })
    expect(dbg.log.filter((l) => l === 'DOM.setFileInputFiles')).toHaveLength(1)
  })

  it('Workday starting to read the resume mid-upload (busy, then ready) neither cancels nor repeats the attach', async () => {
    await workdayApp()
    const tab = wdTab()
    const dbg = new FakeDebugger()
    dbg.holdOn('DOM.setFileInputFiles')
    dbg.onSetFiles = showUploaded(tab, 20)
    const { service } = wdSetup(tab, dbg)
    await service.start(WD_ID)
    tab.load(fixture('workday-signin.html'), `${JOB}/apply/autofillWithResume`)
    await until(service, 'waiting')
    tab.navigateInPage(fixture('workday-autofill-resume.html'))
    await vi.waitFor(() => expect(dbg.log).toContain('DOM.setFileInputFiles'))
    const banner = '<div data-automation-id="resumeParsing" role="status">Reading your resume…</div>'
    tab.dom.window.document.body.insertAdjacentHTML('beforeend', banner)
    tab.reply(AUTOFILL_CHANNELS.step, {})
    await new Promise((r) => setTimeout(r, 30))
    dbg.gate!.open()
    await until(service, 'filled')
    expect(service.current()!.report?.fields.find((f) => f.key === 'resume')).toMatchObject({ outcome: 'uploaded' })
    tab.dom.window.document.querySelector('[data-automation-id="resumeParsing"]')!.remove()
    tab.reply(AUTOFILL_CHANNELS.step, {})
    await new Promise((r) => setTimeout(r, 50))
    expect(service.current()).toMatchObject({ status: 'filled' })
    expect(service.current()!.report?.fields.find((f) => f.key === 'resume')).toMatchObject({ outcome: 'uploaded' })
    expect(dbg.log.filter((l) => l === 'DOM.setFileInputFiles')).toHaveLength(1)
  })

  it('Workday replacing the resume input (a step change in place) while the attach is confirmed keeps the upload', async () => {
    await workdayApp()
    const tab = wdTab()
    const dbg = new FakeDebugger()
    const { service } = wdSetup(tab, dbg)
    dbg.onSetFiles = () => {
      // Upload in progress, then the uploaded-file list replaces the drop zone and the watcher reports the change.
      showUploaded(tab, 60)()
      setTimeout(() => tab.reply(AUTOFILL_CHANNELS.step, {}), 80)
    }
    await service.start(WD_ID)
    tab.load(fixture('workday-signin.html'), `${JOB}/apply/autofillWithResume`)
    await until(service, 'waiting')
    tab.step(fixture('workday-autofill-resume.html'))
    await until(service, 'filled')
    await new Promise((r) => setTimeout(r, 100))
    expect(service.current()).toMatchObject({ status: 'filled', step: { kind: 'form', title: 'Autofill with Resume' } })
    expect(service.current()!.report?.fields.find((f) => f.key === 'resume')).toMatchObject({ outcome: 'uploaded' })
    expect(dbg.log.filter((l) => l === 'DOM.setFileInputFiles')).toHaveLength(1)
  })

  it('fills a field the step renders after the first fill, and keeps the earlier lines', async () => {
    await workdayApp()
    const tab = wdTab()
    const { service } = wdSetup(tab)
    await service.start(WD_ID)
    tab.load(fixture('workday-signin.html'), `${JOB}/apply/applyManually`)
    await until(service, 'waiting')

    // My Information arrives without its email field yet.
    const full = new JSDOM(fixture('workday-my-information.html')).window.document
    const emailField = full.querySelector('[data-automation-id="formField-email"]')!.outerHTML
    full.querySelector('[data-automation-id="formField-email"]')!.remove()
    tab.step(`<!DOCTYPE html>${full.documentElement.outerHTML}`)
    await until(service, 'filled')
    expect(service.current()!.report?.fields.some((f) => f.key === 'email')).toBe(false)
    const fills = tab.sent.filter((c) => c === AUTOFILL_CHANNELS.fill).length

    // The email field renders; the watcher reports the change, and only the new field gets filled.
    tab.dom.window.document
      .querySelector('[data-automation-id="formField-phoneType"]')!
      .insertAdjacentHTML('beforebegin', emailField)
    tab.reply(AUTOFILL_CHANNELS.step, {})
    await vi.waitFor(() => expect(value(tab, '#emailAddress--emailAddress')).toBe('ada@example.com'))
    await until(service, 'filled')
    expect(tab.sent.filter((c) => c === AUTOFILL_CHANNELS.fill)).toHaveLength(fills + 1)
    const report = service.current()!.report!
    expect(report.fields.find((f) => f.key === 'email')).toMatchObject({ outcome: 'filled' })
    expect(report.fields.find((f) => f.key === 'firstName')).toMatchObject({ outcome: 'filled' })

    // The same step reported again with nothing new is not filled again.
    tab.reply(AUTOFILL_CHANNELS.step, {})
    await new Promise((r) => setTimeout(r, 50))
    expect(tab.sent.filter((c) => c === AUTOFILL_CHANNELS.fill)).toHaveLength(fills + 1)
  })

  it('keeps the resume line when a later field on My Experience is filled after the upload', async () => {
    await workdayApp()
    const tab = wdTab()
    const dbg = new FakeDebugger()
    dbg.onSetFiles = showUploaded(tab, 20)
    const { service } = wdSetup(tab, dbg)
    await service.start(WD_ID)
    tab.load(fixture('workday-signin.html'), `${JOB}/apply/applyManually`)
    await until(service, 'waiting')
    const full = new JSDOM(fixture('workday-my-experience.html')).window.document
    const social = full.querySelector('[data-automation-id="socialNetworkSection"]')!
    const socialHtml = social.outerHTML
    social.remove()
    tab.step(`<!DOCTYPE html>${full.documentElement.outerHTML}`)
    await until(service, 'filled')
    expect(service.current()!.report?.fields.find((f) => f.key === 'resume')).toMatchObject({ outcome: 'uploaded' })

    tab.dom.window.document.querySelector('[data-automation-id="websiteSection"]')!.insertAdjacentHTML('afterend', socialHtml)
    tab.reply(AUTOFILL_CHANNELS.step, {})
    await vi.waitFor(() => expect(service.current()!.report?.fields.some((f) => f.key === 'linkedin')).toBe(true))
    const report = service.current()!.report!
    expect(report.fields.find((f) => f.key === 'linkedin')).toMatchObject({ outcome: 'filled' })
    expect(report.fields.find((f) => f.key === 'resume')).toMatchObject({ outcome: 'uploaded', value: 'resume.pdf' })
    expect(dbg.log.filter((l) => l === 'DOM.setFileInputFiles')).toHaveLength(1)
  })

  it('waits while Workday reads the resume, then fills My Information around what its parser put in', async () => {
    await workdayApp()
    const tab = wdTab()
    const { service } = wdSetup(tab)
    await service.start(WD_ID)
    tab.load(fixture('workday-signin.html'), `${JOB}/apply/autofillWithResume`)
    await until(service, 'waiting')

    const parsing = fixture('workday-my-information.html').replace(
      '</body>',
      '<div data-automation-id="resumeParsing" role="status">Reading your resume…</div></body>'
    )
    tab.step(parsing)
    await vi.waitFor(() => expect(service.current()!.message).toMatch(/still working on this step/))
    expect(service.current()).toMatchObject({ status: 'waiting', step: { kind: 'form', title: 'My Information' } })
    expect(tab.sent).not.toContain(AUTOFILL_CHANNELS.fill)

    // The parser fills (and overwrites) some fields, then the spinner goes.
    const doc = tab.dom.window.document
    ;(doc.querySelector('#name--legalName--firstName') as HTMLInputElement).value = 'Augusta'
    ;(doc.querySelector('#emailAddress--emailAddress') as HTMLInputElement).value = 'ada@parsed.example'
    doc.querySelector('[data-automation-id="resumeParsing"]')!.remove()
    tab.reply(AUTOFILL_CHANNELS.step, {})
    await until(service, 'filled')
    const report = service.current()!.report!
    expect(report.fields.find((f) => f.key === 'firstName')).toMatchObject({ outcome: 'kept', value: 'Augusta' })
    expect(report.fields.find((f) => f.key === 'email')).toMatchObject({ outcome: 'kept', value: 'ada@parsed.example' })
    expect(report.fields.find((f) => f.key === 'phone')).toMatchObject({ outcome: 'filled' })
    expect(value(tab, '#name--legalName--lastName')).toBe('Lovelace')
  })

  it('reports the upload as failed when Workday never lists the file', async () => {
    await workdayApp()
    const tab = wdTab()
    const dbg = new FakeDebugger()
    const { service } = wdSetup(tab, dbg, { uploadConfirmMs: 200 })
    await service.start(WD_ID)
    tab.load(fixture('workday-autofill-resume.html'), `${JOB}/apply/autofillWithResume`)
    await until(service, 'filling')
    await until(service, 'filled')
    expect(service.current()!.report?.fields.find((f) => f.key === 'resume')).toMatchObject({
      outcome: 'upload-failed',
      reason: 'The site did not show resume.pdf as attached; attach it yourself.'
    })
    // #63 marks the input again and tries once more before giving up.
    expect(dbg.log.filter((l) => l === 'DOM.setFileInputFiles')).toHaveLength(2)
  })

  it('Fill form on the sign-in wall fills nothing and says what to do', async () => {
    await workdayApp()
    const tab = wdTab()
    const { service } = wdSetup(tab)
    const session = await service.start(WD_ID)
    tab.load(fixture('workday-create-account.html'), `${JOB}/apply/applyManually`)
    await until(service, 'waiting')
    await service.fill(session.id)
    expect(service.current()).toMatchObject({ status: 'waiting', report: null, step: { kind: 'account-wall' } })
    for (const id of ['email', 'password', 'verifyPassword', 'beecatcher']) {
      expect(value(tab, `[data-automation-id="${id}"]`), id).toBe('')
    }
    expect((tab.dom.window.document.querySelector('[data-automation-id="createAccountCheckbox"]') as HTMLInputElement).checked).toBe(false)
  })
})

describe('uploadFile', () => {
  it('times out and still detaches', async () => {
    const dbg = new FakeDebugger()
    dbg.sendCommand = () => new Promise(() => undefined)
    const attach = () => {
      dbg.attached = true
      return dbg
    }
    await expect(uploadFile(attach, '[x]', ['/tmp/a.pdf'], { timeoutMs: 20 })).rejects.toThrow(/did not respond/)
    expect(dbg.attached).toBe(false)
  })

  it('fails when the field is gone', async () => {
    const dbg = new FakeDebugger()
    dbg.sendCommand = async (method) => (method === 'DOM.getDocument' ? { root: { nodeId: 1 } } : { nodeId: 0 })
    await expect(uploadFile(() => dbg, '[x]', ['/tmp/a.pdf'])).rejects.toThrow(/no longer on the page/)
  })
})

describe('page replies', () => {
  it('never lets a page claim an upload or upload a non-file field', () => {
    const report = parseFillReport({
      ats: 'evil',
      url: 'javascript:alert(1)',
      hasSubmitButton: 'yes',
      fields: [
        { key: 'resume', label: 'x', kind: 'file', outcome: 'uploaded' },
        { key: 'email', label: 'y', kind: 'text', outcome: 'to-upload' },
        { key: 'resume', label: 'z'.repeat(500), kind: 'file', outcome: 'to-upload', value: 1 }
      ]
    })
    expect(report).toMatchObject({ ats: 'generic', url: '', hasSubmitButton: false })
    expect(report.fields.map((f) => f.outcome)).toEqual(['unmatched', 'unmatched', 'to-upload'])
    expect(report.fields[2].label).toHaveLength(160)
    expect(report.fields[2].value).toBeUndefined()
    expect(() => parseFillReport(null)).toThrow()
  })

  it('keeps only http(s) embed URLs from a scan', () => {
    expect(parsePageScan({ embedUrl: 'file:///etc/passwd', url: 'https://x.example' })).toMatchObject({
      embedUrl: null,
      url: 'https://x.example',
      ats: 'generic',
      formFound: false,
      step: 'form',
      stepTitle: null
    })
  })

  it('accepts the new ATS names and steps, and nothing else', () => {
    expect(parsePageScan({ ats: 'workday', step: 'account-wall', stepTitle: ' Sign In ' })).toMatchObject({
      ats: 'workday',
      step: 'account-wall',
      stepTitle: 'Sign In'
    })
    expect(parsePageScan({ ats: 'ashby', step: 'submit', stepTitle: 3 })).toMatchObject({
      ats: 'ashby',
      step: 'form',
      stepTitle: null
    })
  })

  it('agrees with the engine on the confirmation fixtures', () => {
    const doc = new JSDOM(fixture('lever-thanks.html'), { url: 'https://jobs.lever.co/a/b/thanks' }).window.document
    expect(detectConfirmation(doc)).toBe(true)
  })
})

describe('dev-only local URLs', () => {
  it('is off in packaged builds and without the variable', () => {
    expect(localUrlsAllowed(true, { HUNTGRY_ALLOW_LOCAL_URLS: '1' })).toBe(false)
    expect(localUrlsAllowed(false, {})).toBe(false)
    expect(localUrlsAllowed(false, { HUNTGRY_ALLOW_LOCAL_URLS: 'true' })).toBe(false)
    expect(localUrlsAllowed(false, { HUNTGRY_ALLOW_LOCAL_URLS: '1' })).toBe(true)
  })

  it('allows loopback only', async () => {
    expect(isLoopbackUrl('http://localhost:4173/greenhouse/')).toBe(true)
    expect(isLoopbackUrl('http://127.0.0.1:4173/')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:4173/')).toBe(true)
    expect(isLoopbackUrl('ws://localhost:4173/')).toBe(true)
    expect(isLoopbackUrl('http://192.168.1.10/')).toBe(false)
    expect(isLoopbackUrl('http://localhost.evil.example/')).toBe(false)
    expect(isLoopbackUrl('file:///etc/passwd')).toBe(false)
    const noDns = async () => ['93.184.216.34']
    expect(await refusalFor('http://localhost:4173/', noDns)).toMatch(/local or private/)
    expect(await refusalFor('http://localhost:4173/', noDns, true)).toBeNull()
    expect(await refusalFor('http://10.0.0.1/', noDns, true)).toMatch(/local or private/)
  })
})

describe('application answers (#71)', () => {
  const POSTING = 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000001'
  const SPONSOR = 'cards[00000000-0000-4000-8000-0000000000c1][field1]'
  /** The Lever form with a gender question the catalog does not know ("How do you identify?"). */
  const IDENTIFY = fixture('lever-form.html').replace(
    '<div class="application-label">Gender</div><div class="application-field"><select name="eeo[gender]"><option value="">Select ...</option><option>Male</option><option>Female</option>',
    '<div class="application-label">How do you identify?</div><div class="application-field"><select name="eeo[gender]"><option value="">Select ...</option><option>Man</option><option>Woman</option>'
  )
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'huntgry-answers-'))
    setAnswersRoot(root)
  })
  afterEach(async () => {
    // A test may end while the model's mappings are still being written in the background.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** The real store (under a temp "userData") and a fake model: "identify" / "gender" questions are about gender. */
  function answers(seeds: PageAnswers['facts'] = {}, map?: AnswersDeps['map']) {
    const calls: MapQuestion[][] = []
    const deps: AnswersDeps = {
      load: async (workspace) => pageAnswers(await readAnswers(workspace), seeds),
      remember: async (workspace, a) => void (await rememberAnswer(workspace, a)),
      rememberMappings: async (workspace, m) => void (await rememberMappings(workspace, m)),
      map:
        map ??
        (async (_workspace, questions) => {
          calls.push(questions)
          return questions.map((q) => ({ id: q.id, fact: /identify|gender/i.test(q.question) ? ('gender' as const) : null }))
        })
    }
    return { deps, calls }
  }

  async function open(deps: AnswersDeps, html: string, id = ID, extra: Partial<ApplyDeps> = {}) {
    await application({ 'job-description.md': `Engineer\n${POSTING}\n`, 'resume.pdf': '%PDF' }, id)
    const tab = new FakeTab('', `${POSTING}/apply`)
    const { service } = setup(tab, undefined, { answers: deps, ...extra })
    await service.start(id)
    tab.load(html, `${POSTING}/apply`)
    await until(service, 'filled')
    return { tab, service }
  }

  const select = (tab: FakeTab) => tab.dom.window.document.querySelector('select[name="eeo[gender]"]') as HTMLSelectElement
  const line = (service: ApplyService, label: string) => service.current()!.report!.fields.find((f) => f.label === label)!

  it('sends remembered answers with the fill: a US citizen profile answers sponsorship, no prompt, no model for it', async () => {
    const { deps, calls } = answers(factsFromProfile('US Citizen'))
    await rememberAnswer(ws, { question: 'x', label: 'Gender', fact: 'gender', value: 'Female' })
    const { tab, service } = await open(deps, fixture('lever-form.html'))
    expect(tab.answersSeen[0]?.facts).toMatchObject({ workAuthorized: 'yes', needsSponsorship: 'no', gender: 'Female' })
    expect(line(service, 'Will you require visa sponsorship?')).toMatchObject({ outcome: 'filled', value: 'No' })
    expect(line(service, 'Gender')).toMatchObject({ outcome: 'filled', value: 'Female' })
    const radio = Array.from(tab.dom.window.document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((r) => r.checked)
    expect(radio && radio.name === SPONSOR && radio.value).toBe('No')
    // One call for the page's unknown questions: neither the answered ones nor any stored value goes to the model.
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const sent = JSON.stringify(calls[0])
    expect(sent).toContain('What interests you about this role?')
    expect(sent).not.toMatch(/sponsorship|Gender|Female/)
    // Filling again asks nothing new.
    await service.fill(service.current()!.id)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toHaveLength(1)
  })

  it("only suggests a model's mapping; once confirmed it fills, and the next posting fills it with no model call", async () => {
    const { deps, calls } = answers()
    await rememberAnswer(ws, { question: 'x', label: 'Gender', fact: 'gender', value: 'Female' })
    const first = await open(deps, IDENTIFY)
    await vi.waitFor(() => expect(line(first.service, 'How do you identify?')).toMatchObject({ fact: 'gender', suggestion: 'Woman', suggestedBy: 'model' }))
    expect(line(first.service, 'How do you identify?').outcome).toBe('skipped-unsupported')
    expect(select(first.tab).value).toBe('')
    expect(calls).toHaveLength(1)

    const fieldId = line(first.service, 'How do you identify?').fieldId!
    const after = await first.service.answer(first.service.current()!.id, fieldId, 'Woman', true)
    expect(after.report!.fields.find((f) => f.fieldId === fieldId)).toMatchObject({ outcome: 'filled', value: 'Woman' })
    expect(select(first.tab).value).toBe('Woman')
    // Remembered under the temp userData, not in the workspace.
    expect(JSON.parse(readFileSync(answersFile(ws), 'utf8')).questions[line(first.service, 'How do you identify?').question!]).toMatchObject({
      fact: 'gender',
      confirmed: true,
      source: 'user'
    })
    expect(await readdir(ws)).not.toContain('.huntgry')

    const second = await open(deps, IDENTIFY, 'software-engineer/acme/lv-2')
    expect(line(second.service, 'How do you identify?')).toMatchObject({ outcome: 'filled', value: 'Woman' })
    expect(select(second.tab).value).toBe('Woman')
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toHaveLength(1)
  })

  it('checks an answer against the reported field; without Remember it fills once and stores nothing', async () => {
    const { deps } = answers()
    const { tab, service } = await open(deps, fixture('lever-form.html'))
    const id = service.current()!.id
    const gender = line(service, 'Gender')
    expect(gender).toMatchObject({ fact: 'gender', options: ['Male', 'Female', 'Decline to self-identify'] })
    await expect(service.answer('00000000-0000-4000-8000-000000000000', gender.fieldId!, 'Male', true)).rejects.toThrow(/ended/)
    await expect(service.answer(id, 'select:nope', 'Male', true)).rejects.toThrow(/no longer on the page/)
    await expect(service.answer(id, gender.fieldId!, 'Attack helicopter', true)).rejects.toThrow(/options the page offers/)
    await expect(service.answer(id, gender.fieldId!, ' ', true)).rejects.toThrow(/Type an answer/)
    await service.answer(id, gender.fieldId!, 'Decline to self-identify', false)
    expect(select(tab).value).toBe('Decline to self-identify')
    expect(line(service, 'Gender')).toMatchObject({ outcome: 'filled' })
    expect((await readAnswers(ws)).facts.gender).toBeUndefined()
    // The upload lines of the first fill stay in the report.
    expect(line(service, 'Resume/CV').outcome).toBe('uploaded')
  })

  it('keeps answers in the workspace the session started in, even after a switch', async () => {
    const other = await mkdtemp(join(tmpdir(), 'huntgry-apply-b-'))
    let current = ws
    let releaseMap: () => void = () => undefined
    const mapped = new Promise<void>((r) => (releaseMap = r))
    const { deps } = answers({}, async (_workspace, questions) => {
      await mapped
      return questions.map((q) => ({ id: q.id, fact: /identify/i.test(q.question) ? ('gender' as const) : null }))
    })
    const seen: string[] = []
    const tracked: AnswersDeps = {
      ...deps,
      load: (w) => (seen.push(`load ${w}`), deps.load(w)),
      remember: (w, a) => (seen.push(`remember ${w}`), deps.remember(w, a)),
      rememberMappings: (w, m) => (seen.push(`mappings ${w}`), deps.rememberMappings(w, m))
    }
    // workspace B holds an answer that must never reach A's application.
    await rememberAnswer(other, { question: 'x', label: 'Gender', fact: 'gender', value: 'Male' })
    const { tab, service } = await open(tracked, IDENTIFY, ID, { workspace: async () => current })
    current = other
    const gender = line(service, 'Gender')
    expect(gender).toBeUndefined()
    const race = line(service, 'Race')
    await service.answer(service.current()!.id, race.fieldId!, 'Decline to self-identify', true)
    releaseMap()
    await vi.waitFor(() => expect(seen.some((e) => e.startsWith('mappings'))).toBe(true))
    expect(seen.every((e) => e.endsWith(ws))).toBe(true)
    expect((await readAnswers(ws)).facts.raceEthnicity?.value).toBe('decline')
    expect((await readAnswers(other)).facts.raceEthnicity).toBeUndefined()
    expect(Object.keys((await readAnswers(other)).questions)).toEqual(['x'])
    expect(select(tab).value).toBe('')
    await rm(other, { recursive: true, force: true })
  })

  it('drafts open-ended questions from the resume and job description, types them in, never remembers them (#82)', async () => {
    const drafted: Array<{ applicationId: string; questions: string[] }> = []
    const { deps } = answers()
    deps.draft = async (_w, applicationId, questions) => {
      drafted.push({ applicationId, questions: questions.map((q) => q.question) })
      // Like the real prompt: an answer for motivation questions only, none for location, URLs and the like.
      return questions.filter((q) => /interests you/.test(q.question)).map((q) => ({ id: q.id, answer: `Draft for ${q.question}` }))
    }
    const { tab, service } = await open(deps, fixture('lever-form.html'))
    const label = 'What interests you about this role?'
    await vi.waitFor(() => expect(line(service, label)).toMatchObject({ outcome: 'filled', suggestedBy: 'draft' }))
    expect(line(service, label).value).toBe(`Draft for ${label}`)
    const textarea = tab.dom.window.document.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe(`Draft for ${label}`)
    // One call, for typed questions that ask for no fact: a fact question (gender) or a choice is never sent.
    expect(drafted).toHaveLength(1)
    expect(drafted[0].applicationId).toBe(ID)
    expect(drafted[0].questions).toContain(label)
    expect(drafted[0].questions.join('|')).not.toMatch(/Gender|sponsorship|Race/)
    expect(line(service, 'Current location').suggestedBy).toBeUndefined()
    // The draft is this application's only: nothing of it is stored.
    expect(readFileSync(answersFile(ws), 'utf8')).not.toContain('Draft for')
    // Filling again keeps the mark and makes no new call.
    await service.fill(service.current()!.id)
    expect(line(service, label)).toMatchObject({ outcome: 'filled', suggestedBy: 'draft' })
    await new Promise((r) => setTimeout(r, 20))
    expect(drafted).toHaveLength(1)
  })

  it('leaves text the user typed into an open-ended question alone (#82)', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const { deps } = answers()
    deps.draft = async (_w, _id, questions) => {
      await gate
      return questions.map((q) => ({ id: q.id, answer: 'AI text' }))
    }
    const { tab, service } = await open(deps, fixture('lever-form.html'))
    const textarea = tab.dom.window.document.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = 'My own words'
    textarea.dispatchEvent(new tab.dom.window.Event('input', { bubbles: true }))
    release()
    await new Promise((r) => setTimeout(r, 50))
    expect(textarea.value).toBe('My own words')
    expect(line(service, 'What interests you about this role?').suggestedBy).not.toBe('draft')
  })

  it('makes at most one model call per page: over the limit, late-rendered or after a failure', async () => {
    const many = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => `<p><label for="c${i + from}">Custom question ${i + from}</label><input id="c${i + from}" name="c${i + from}"></p>`).join('')
    const page = (extra: string) =>
      `<form><label>Email <input name="email" type="email"></label>${extra}<input type="file" name="resume"><button type="submit">Send</button></form>`
    const sizes: number[] = []
    const { deps } = answers({}, async (_w, questions) => {
      sizes.push(questions.length)
      throw new Error('quota')
    })
    await application({ 'job-description.md': `Engineer\n${POSTING}\n`, 'resume.pdf': '%PDF' })
    const tab = new FakeTab('', `${POSTING}/apply`)
    const { service } = setup(tab, undefined, { answers: deps })
    await service.start(ID)
    tab.load(page(many(41)), `${POSTING}/apply`)
    await until(service, 'filled')
    await vi.waitFor(() => expect(sizes).toEqual([40]))
    // Fill again on the same page, now with more questions rendered: no second call.
    tab.dom = new JSDOM(page(many(45)), { url: `${POSTING}/apply` })
    await service.fill(service.current()!.id)
    await new Promise((r) => setTimeout(r, 20))
    expect(sizes).toEqual([40])
  })

  it('reuses the exact option confirmed for a question whose options a fact alone cannot pick', async () => {
    const AUTH = (n: number) =>
      `<form><label>Email <input name="email" type="email"></label><fieldset><legend>Are you legally authorized to work in the United States?</legend>
       <label><input type="radio" name="auth${n}" value="a"> Yes, I am</label><label><input type="radio" name="auth${n}" value="b"> Yes, with a visa</label>
       <label><input type="radio" name="auth${n}" value="c"> No</label></fieldset><input type="file" name="resume"><button type="submit">Send</button></form>`
    const checked = (tab: FakeTab) => Array.from(tab.dom.window.document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((r) => r.checked)?.value
    const { deps } = answers()
    const first = await open(deps, AUTH(1))
    const q = line(first.service, 'Are you legally authorized to work in the United States?')
    expect(q).toMatchObject({ fact: 'workAuthorized', outcome: 'skipped-unsupported' })
    await first.service.answer(first.service.current()!.id, q.fieldId!, 'Yes, with a visa', true)
    expect(checked(first.tab)).toBe('b')
    // Another posting, same question and options (other element names): filled with the same option, no prompt.
    const second = await open(deps, AUTH(2), 'software-engineer/acme/lv-2')
    expect(line(second.service, 'Are you legally authorized to work in the United States?')).toMatchObject({ outcome: 'filled', value: 'Yes, with a visa' })
    expect(checked(second.tab)).toBe('b')
  })

  it('sends the "Pick dropdown answers automatically" switch with every fill, read again before each one', async () => {
    const { deps } = answers()
    let on = true
    const { tab, service } = await open(deps, fixture('lever-form.html'), ID, { pickWidgets: async () => on })
    expect(tab.picksSeen.at(-1)).toBe(true)
    on = false
    await service.fill(service.current()!.id)
    expect(tab.picksSeen.at(-1)).toBe(false)
    // Without the setting (or when it cannot be read), nothing is picked.
    const plain = await open(deps, fixture('lever-form.html'), 'software-engineer/acme/lv-3')
    expect(plain.tab.picksSeen.every((p) => p === false)).toBe(true)
  })

  it('a missing or failing model leaves the fill complete and the questions with the user', async () => {
    const { deps } = answers({}, async () => {
      throw new Error('No model available to map questions.')
    })
    const { service } = await open(deps, IDENTIFY)
    await new Promise((r) => setTimeout(r, 20))
    expect(service.current()!.status).toBe('filled')
    expect(line(service, 'How do you identify?')).toMatchObject({ outcome: 'skipped-unsupported' })
    expect(line(service, 'How do you identify?').fact).toBeUndefined()
  })
})
