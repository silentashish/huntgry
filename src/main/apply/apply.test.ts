import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplySession, FillValues } from '@shared/apply-types'
import { AUTOFILL_CHANNELS } from '@shared/autofill-channels'
import { detectConfirmation, fillPage, scanPage } from '@shared/autofill/engine'
import { refusalFor } from '../browser/url'
import { isLoopbackUrl, localUrlsAllowed } from '../cli/dev-urls'
import { ApplyService, type ApplyDeps, type ApplyPage } from './service'
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
  dom: JSDOM
  listeners = new Map<string, Set<(payload: unknown) => void>>()
  loads = new Set<(full: boolean) => void>()
  closes = new Set<() => void>()
  sent: string[] = []
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
    this.dom = new JSDOM(html, { url })
    for (const l of this.loads) l(true)
  }

  close() {
    for (const l of this.closes) l()
  }

  reply(channel: string, payload: unknown) {
    for (const l of this.listeners.get(channel) ?? []) l(payload)
  }

  send(channel: string, payload: unknown): void {
    this.sent.push(channel)
    const { requestId, values } = payload as { requestId: string; values?: FillValues }
    const doc = this.dom.window.document
    if (channel === AUTOFILL_CHANNELS.fill && this.heldFills) {
      this.heldFills.push(() =>
        this.reply(AUTOFILL_CHANNELS.result, { requestId, ok: true, result: fillPage(doc, values as FillValues) })
      )
      return
    }
    queueMicrotask(() => {
      if (channel === AUTOFILL_CHANNELS.detect) {
        this.reply(AUTOFILL_CHANNELS.result, { requestId, ok: true, result: scanPage(doc) })
      } else if (channel === AUTOFILL_CHANNELS.fill) {
        this.reply(AUTOFILL_CHANNELS.result, { requestId, ok: true, result: fillPage(doc, values as FillValues) })
      }
    })
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
    if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } })
    if (method === 'DOM.querySelector') {
      this.log.push(`selector ${String(p.selector)}`)
      return Promise.resolve({ nodeId: 7 })
    }
    if (method === 'DOM.setFileInputFiles') this.files = p.files as string[]
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

function setup(tab: FakeTab, dbg = new FakeDebugger()) {
  const events: Array<ApplySession | null> = []
  const opened: string[] = []
  const navigated: string[] = []
  const deps: ApplyDeps = {
    workspace: async () => ws,
    values: async () => VALUES,
    openTab: async (url) => {
      opened.push(url)
      return 'tab-1'
    },
    navigate: async (_id, url) => navigated.push(url),
    page: () => tab,
    attachDebugger: () => {
      dbg.attached = true
      dbg.log.push('attach')
      return dbg
    },
    emit: (s) => events.push(s),
    retryDelaysMs: [],
    requestTimeoutMs: 500
  }
  return { service: new ApplyService(deps), events, opened, navigated, dbg }
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
    // Redirected elsewhere: Greenhouse markup on an unrelated host.
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
