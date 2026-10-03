import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { ApplySession, FieldReport, FillReport, FillValues, PageScan, UploadState } from '@shared/apply-types'
import { embedRuleFor } from '@shared/apply-embeds'
import { applyUrlFor, isTrustedApplyPage } from '@shared/apply-url'
import { AUTOFILL_CHANNELS, UPLOAD_ATTR } from '@shared/autofill-channels'
import { resolveApplicationFile, resolveApplicationFolder } from '../applications/safe-path'
import { readApplication } from '../applications/scan'
import { isBlockedPage } from '../jobs/blocked'
import { uploadFile, type Cdp } from './upload'
import { parseFillReport, parsePageScan, parseUploadState } from './validate'

/**
 * Auto-apply (#24, #63): one session at a time. Opens the application's apply
 * page in an in-app browser tab, asks the tab's preload to detect and fill the
 * form once the page is ready (and to verify the values held), attaches
 * `resume.pdf` / `cover.pdf` over CDP and confirms the site's upload widget
 * shows them, follows the form into an embedded iframe or a popup tab, and
 * watches for the site's confirmation page. It never submits, never clicks
 * the site's buttons and never changes tracking; the user presses the site's
 * Submit button and then "Mark as applied".
 */

/** One browser tab, as the service needs it (wrapped around `WebContents` in ipc.ts). */
export interface ApplyPage {
  send(channel: string, payload: unknown): void
  /** Messages from this tab's preload; returns the unsubscribe function. */
  onMessage(channel: string, listener: (payload: unknown) => void): () => void
  /** A main-frame load finished (`true`) or a single-page app changed its URL (`false`). */
  onLoad(listener: (fullLoad: boolean) => void): () => void
  /** The main frame committed a navigation to `url` (after any server redirects). */
  onNavigate(listener: (url: string) => void): () => void
  /** The main frame started a navigation to another document (the current one is about to go). */
  onNavigationStart?(listener: () => void): () => void
  onClosed(listener: () => void): () => void
}

export interface ApplyDeps {
  workspace(): Promise<string>
  /** Values from the current master profile. */
  values(): Promise<FillValues>
  openTab(url: string): Promise<string>
  navigate(tabId: string, url: string): Promise<unknown>
  page(tabId: string): ApplyPage
  attachDebugger(tabId: string): Cdp
  emit(session: ApplySession | null): void
  /** A page opened a popup, which became tab `tabId`; returns the unsubscribe function. */
  onTabOpened?(listener: (openerTabId: string, tabId: string) => void): () => void
  /** Dev builds testing against the local mock ATS: loopback embedded forms may be opened too. */
  allowLocalEmbeds?: boolean
  /** Delays for re-detecting a page whose form renders late; injectable for tests. */
  retryDelaysMs?: number[]
  requestTimeoutMs?: number
  /** How long the site's widget may take to show an attached file. */
  uploadConfirmMs?: number
}

interface Context {
  sessionId: string
  /** The tab the session follows (a popup from it takes over). */
  tabId: string
  page: ApplyPage
  values: FillValues
  resumePath: string
  coverPath: string | null
  /** Listeners of the session's tab (replaced when a popup takes over). */
  unsubscribe: Array<() => void>
  /** Listeners that live as long as the session. */
  sessionUnsubscribe: Array<() => void>
  /**
   * Origins Huntgry fills on its own: the posting's, the landing page of the
   * session's first navigation (its server redirects, e.g. a Greenhouse board
   * that redirects to the company's careers site) and embedded forms it opened.
   */
  trusted: Set<string>
  /** The first main-frame navigation has committed (later ones are the user's). */
  landed: boolean
  /** Embedded forms opened this session (a stale token can bounce back; bounded). */
  embedFollows: number
  /** The company page an embedded form was opened from, to reload it when the embed expired. */
  embedHost: string | null
  /** The page (URL and step) filled automatically, so a re-detect of the same page does not fill again. */
  autoFilledUrl: string | null
  /** The page generation (`loadSeq`) a fill is running for, or null. */
  fillingSeq: number | null
  /** Bumped on every load and on a single-page confirmation, so stale detects, fills and uploads give up. */
  loadSeq: number
  timers: Set<ReturnType<typeof setTimeout>>
}

interface Pending {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_RETRIES = [1000, 3000]
/** The preload waits for the page to settle (up to ~6 s) before it answers a detect. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_UPLOAD_CONFIRM_MS = 10_000
const MAX_EMBED_FOLLOWS = 3

export class ApplyService {
  private session: ApplySession | null = null
  private ctx: Context | null = null
  private readonly pending = new Map<string, Pending>()
  /** A start() is between its first await and emitting the new session. */
  private starting = false

  constructor(private readonly deps: ApplyDeps) {}

  current(): ApplySession | null {
    return this.session
  }

  /**
   * Opens a new session. One start at a time: a second one while the first
   * is still resolving files and opening the tab is refused, so two quick
   * clicks (or two windows) cannot swap the session under each other.
   */
  async start(applicationId: string): Promise<ApplySession> {
    if (this.starting) throw new Error('Another Apply is still starting. Try again in a moment.')
    this.starting = true
    try {
      return await this.open(applicationId)
    } finally {
      this.starting = false
    }
  }

  private async open(applicationId: string): Promise<ApplySession> {
    const workspace = await this.deps.workspace()
    const folder = await resolveApplicationFolder(workspace, applicationId)
    const record = await readApplication(workspace, folder)
    if (!record.jobUrl) throw new Error('This application has no posting URL. Add it in the application drawer first.')
    const resumePath = await resolveApplicationFile(workspace, applicationId, 'resume.pdf').catch(() => {
      throw new Error('This application has no resume.pdf yet. Build it in Tailor first.')
    })
    const coverPath = await resolveApplicationFile(workspace, applicationId, 'cover.pdf').catch(() => null)
    const values = await this.deps.values()
    const applyUrl = applyUrlFor(record.jobUrl)

    this.end()
    const tabId = await this.deps.openTab(applyUrl)
    const sessionId = randomUUID()
    const ctx: Context = {
      sessionId,
      tabId,
      page: this.deps.page(tabId),
      values,
      resumePath,
      coverPath,
      unsubscribe: [],
      sessionUnsubscribe: [],
      trusted: new Set([originOf(applyUrl)]),
      landed: false,
      embedFollows: 0,
      embedHost: null,
      autoFilledUrl: null,
      fillingSeq: null,
      loadSeq: 0,
      timers: new Set()
    }
    this.ctx = ctx
    this.session = {
      id: sessionId,
      applicationId,
      title: [record.role, record.company].filter(Boolean).join(' · '),
      tabId,
      applyUrl,
      ats: null,
      status: 'opened',
      report: null,
      hasCover: coverPath !== null,
      message: null
    }
    this.watch(ctx)
    if (this.deps.onTabOpened) {
      ctx.sessionUnsubscribe.push(
        this.deps.onTabOpened((opener, child) => {
          if (this.ctx === ctx && opener === ctx.tabId) this.follow(ctx, child)
        })
      )
    }
    this.deps.emit(this.session)
    return this.session
  }

  /** Listens to the session's current tab. */
  private watch(ctx: Context): void {
    const page = ctx.page
    ctx.unsubscribe.push(
      page.onMessage(AUTOFILL_CHANNELS.result, (payload) => this.onResult(payload)),
      page.onMessage(AUTOFILL_CHANNELS.confirmation, () => {
        if (this.ctx !== ctx) return
        // The page is a different page now: any fill or upload still running for the form is stale.
        ctx.loadSeq++
        this.update({ status: 'submitted-detected', message: CONFIRMED })
      }),
      page.onMessage(AUTOFILL_CHANNELS.formAppeared, () => {
        // A form or an embedded form rendered after the detect found none (late iframe, client-rendered form).
        if (this.ctx === ctx && ctx.fillingSeq === null) void this.detect(ctx, ctx.loadSeq, Number.POSITIVE_INFINITY)
      }),
      page.onNavigate((url) => {
        if (this.ctx !== ctx) return
        // Another document is active from here on: drop every fill, upload and status still running for the last
        // one, without waiting for the new page's did-finish-load (#63 review).
        ctx.loadSeq++
        if (ctx.landed) return
        // Where the posting URL's own redirects land is the posting's site (Greenhouse boards → company careers).
        ctx.landed = true
        const origin = originOf(url)
        if (origin) ctx.trusted.add(origin)
      }),
      ...(page.onNavigationStart
        ? [
            page.onNavigationStart(() => {
              // The person (or the page) is leaving this document: nothing more is written to it.
              if (this.ctx === ctx) ctx.loadSeq++
            })
          ]
        : []),
      page.onLoad((fullLoad) => {
        if (this.ctx !== ctx) return
        const seq = ++ctx.loadSeq
        // A single-page app swaps its view after the URL changes; give it a moment.
        if (fullLoad) void this.detect(ctx, seq, 0)
        else this.later(ctx, 500, () => void this.detect(ctx, seq, 0))
      }),
      page.onClosed(() => {
        if (this.ctx !== ctx) return
        this.release()
        this.update({ status: 'closed', message: 'The apply tab was closed.' })
      })
    )
  }

  /**
   * The form opened in a new tab from the session's tab (an "Apply" link with
   * target=_blank): the session moves there. Trust does not move with it: the
   * new page is filled on its own only on a trusted origin.
   */
  private follow(ctx: Context, tabId: string): void {
    let page: ApplyPage
    try {
      page = this.deps.page(tabId)
    } catch {
      return
    }
    for (const off of ctx.unsubscribe) off()
    ctx.unsubscribe = []
    ctx.tabId = tabId
    ctx.page = page
    ctx.loadSeq++
    ctx.landed = true
    this.watch(ctx)
    this.update({ tabId, status: 'opened', report: null, message: 'The page opened a new tab; following it there.' })
  }

  /** Detects and fills the tab's current page (Fill form / Fill again). */
  async fill(sessionId: string): Promise<ApplySession> {
    const ctx = this.require(sessionId)
    await this.fillPage(ctx)
    return this.session as ApplySession
  }

  cancel(sessionId: string): void {
    if (this.session?.id === sessionId) this.end()
  }

  /** Ends any session (app quit, window closed). */
  stop(): void {
    this.end()
  }

  private require(sessionId: string): Context {
    if (!this.ctx || this.ctx.sessionId !== sessionId)
      throw new Error('This apply session has ended. Press Apply again.')
    return this.ctx
  }

  private async detect(ctx: Context, seq: number, attempt: number): Promise<void> {
    let scan: PageScan
    try {
      scan = parsePageScan(await this.request(ctx, AUTOFILL_CHANNELS.detect, {}))
    } catch {
      // The page navigated away or is still busy; the next load detects again.
      return
    }
    if (this.ctx !== ctx || ctx.loadSeq !== seq) return
    this.update({ ats: scan.ats })
    if (scan.confirmation) {
      this.update({ status: 'submitted-detected', message: CONFIRMED })
      return
    }
    // Only the posting's own site (and where its redirects landed) or a Greenhouse / Lever host is filled (or
    // followed into an embedded form) without asking: markup alone (scan.ats, a resume upload, an iframe) is not
    // proof, since any page can look like an ATS form.
    const trusted = isTrustedApplyPage(scan.url, [...ctx.trusted])
    if (isExpiredEmbed(scan.url) && ctx.embedHost && ctx.embedFollows < MAX_EMBED_FOLLOWS) {
      // A Greenhouse embed token expired (it lives seconds to minutes): reload the company page for a fresh one.
      this.update({ status: 'opened', message: 'The embedded application form expired; reloading the company page.' })
      await this.deps.navigate(ctx.tabId, ctx.embedHost).catch((err: unknown) => {
        this.update({ status: 'error', message: errorMessage(err) })
      })
      return
    }
    if (scan.step !== 'form') {
      this.update({ status: 'ready', message: STEP_MESSAGE[scan.step] })
      return
    }
    if (!scan.formFound) {
      const embed = scan.embedUrl
      if (trusted && embed && embedRuleFor(embed, { allowLoopback: this.deps.allowLocalEmbeds === true })) {
        if (ctx.embedFollows >= MAX_EMBED_FOLLOWS) {
          this.update({ status: 'ready', message: 'The embedded application form keeps failing to load. Open it in the page, then press Fill form.' })
          return
        }
        ctx.embedFollows++
        ctx.embedHost = scan.url
        ctx.trusted.add(originOf(embed))
        this.update({ status: 'opened', message: 'This page embeds the application form; opening it directly.' })
        await this.deps.navigate(ctx.tabId, embed).catch((err: unknown) => {
          this.update({ status: 'error', message: errorMessage(err) })
        })
        return
      }
      if (isBlockedPage({ title: scan.title, text: scan.text })) {
        this.update({
          status: 'blocked',
          message: 'The site asked for a human check. Complete it in the page, then press Fill form.'
        })
        return
      }
      const delay = (this.deps.retryDelaysMs ?? DEFAULT_RETRIES)[attempt]
      if (delay !== undefined) this.later(ctx, delay, () => void this.detect(ctx, seq, attempt + 1))
      this.update({
        status: 'ready',
        message:
          "No application form on this page yet. Open it with the page's own Apply button; Huntgry fills it when it appears (or press Fill form)."
      })
      return
    }
    // Known ATS forms fill on their own; on other sites only a page with a resume upload counts as an application form.
    // A multi-step form is filled once per step.
    const pageKey = `${scan.url}#${scan.stepTitle ?? ''}`
    const auto = trusted && pageKey !== ctx.autoFilledUrl && (scan.ats !== 'generic' || scan.hasResumeInput)
    if (auto) {
      ctx.autoFilledUrl = pageKey
      await this.fillPage(ctx)
    } else if (!trusted) {
      this.update({
        status: 'ready',
        message: `This page is on ${hostOf(scan.url)}, not the posting's site, so Huntgry did not fill it. If it is the application form, press Fill form.`
      })
    } else if (this.session?.status !== 'filled') {
      this.update({ status: 'ready', message: 'Press Fill form to fill this page.' })
    }
  }

  /**
   * Fills the page that is loaded now. Everything it does is tied to that
   * page (its `loadSeq`): if the user navigates or submits meanwhile, the
   * rest of the work (uploads, the final status) is dropped, so it can never
   * touch the next document or overwrite "submitted" with "filled".
   */
  private async fillPage(ctx: Context): Promise<void> {
    const seq = ctx.loadSeq
    if (ctx.fillingSeq === seq) return
    ctx.fillingSeq = seq
    const current = () => this.ctx === ctx && ctx.loadSeq === seq
    this.update({ status: 'filling', message: null })
    try {
      // The preload waits for the page to settle, fills, then checks a moment later that the values held.
      let report = parseFillReport(await this.request(ctx, AUTOFILL_CHANNELS.fill, { values: ctx.values }))
      if (!current()) return
      if (report.url) ctx.autoFilledUrl ??= `${report.url}#`
      const uploads = report.fields.filter((f) => f.outcome === 'to-upload')
      // Default order is text first, files last: Lever's resume parser only fills empty fields, after an upload.
      // A `files-first` adapter reported its file fields only; its text is filled after the upload.
      for (const field of uploads) {
        if (!current()) return
        await this.upload(ctx, field, current, report.url)
      }
      if (!current()) return
      if (uploads.some((f) => f.outcome === 'uploaded')) {
        // Wait for the site's parser, then restore any value it replaced.
        const verified = await this.request(ctx, AUTOFILL_CHANNELS.afterUpload, { values: ctx.values }).catch(() => null)
        if (!current()) return
        if (verified && report.uploadOrder === 'text-first') report = withTextFrom(report, parseFillReport(verified))
      }
      if (report.uploadOrder === 'files-first') {
        const text = parseFillReport(await this.request(ctx, AUTOFILL_CHANNELS.fill, { values: ctx.values, text: true }))
        if (!current()) return
        report = withFilesFrom(text, report)
      }
      this.update({ status: 'filled', ats: report.ats, report, message: summary(report.fields) })
    } catch (err) {
      if (current()) this.update({ status: 'error', message: `Filling failed: ${errorMessage(err)}` })
    } finally {
      if (ctx.fillingSeq === seq) {
        ctx.fillingSeq = null
        // The fill was dropped because a navigation started, but nothing replaced it: the navigation was cancelled,
        // or was a download / 204 that never commits a document. Do not leave the panel stuck on "Filling".
        if (this.ctx === ctx && ctx.loadSeq !== seq && this.session?.status === 'filling') {
          this.update({ status: 'ready', message: 'Press Fill form to fill this page.' })
        }
      }
    }
  }

  /**
   * Attaches the file over CDP, then asks the page whether the site's own
   * upload widget shows it. A file input that a re-render replaced (so the
   * upload missed it) is marked again and tried once more. Only a widget that
   * shows the file counts as `uploaded`.
   */
  private async upload(ctx: Context, field: FieldReport, current: () => boolean, documentUrl: string): Promise<void> {
    const cover = field.key === 'coverLetter'
    const path = cover ? ctx.coverPath : ctx.resumePath
    if (!path) {
      field.outcome = 'skipped-no-value'
      field.reason = 'This application has no cover.pdf.'
      return
    }
    const key = cover ? 'coverLetter' : 'resume'
    // The selector is built from our own constants, never from page data.
    const selector = `[${UPLOAD_ATTR}="${cover ? 'cover' : 'resume'}"]`
    const fileName = basename(path)
    let state: UploadState = 'missing'
    let error = ''
    for (let attempt = 0; attempt < 2 && state !== 'attached'; attempt++) {
      if (attempt > 0) {
        if (!current()) return
        // Mark the (re-created) input again; text the first pass filled is left as it is.
        await this.request(ctx, AUTOFILL_CHANNELS.fill, { values: ctx.values, text: false }).catch(() => null)
      }
      try {
        await uploadFile(() => this.deps.attachDebugger(ctx.tabId), selector, [path], {
          shouldContinue: current,
          documentUrl
        })
        error = ''
      } catch (err) {
        error = errorMessage(err)
        if (!current()) return
        continue
      }
      if (!current()) return
      const timeoutMs = this.deps.uploadConfirmMs ?? DEFAULT_UPLOAD_CONFIRM_MS
      state = await this.request(ctx, AUTOFILL_CHANNELS.uploadState, { key, fileName, timeoutMs }, timeoutMs + 5000)
        .then(parseUploadState)
        .catch(() => 'missing' as const)
      // Still uploading (e.g. a slow S3 upload): the file reached the site; do not attach it twice.
      if (state === 'pending') break
    }
    if (state === 'attached') {
      field.outcome = 'uploaded'
      field.value = fileName
      field.reason = undefined
    } else {
      field.outcome = 'upload-failed'
      field.reason =
        error ||
        (state === 'pending'
          ? `The site is still uploading ${fileName}; check it in the page before you submit.`
          : `The site did not show ${fileName} as attached; attach it yourself.`)
    }
  }

  /** Sends a request to the tab's preload and waits for its answer. */
  private request(ctx: Context, channel: string, payload: object, timeoutMs?: number): Promise<unknown> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('The page did not answer.'))
      }, timeoutMs ?? this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        ctx.page.send(channel, { requestId, ...payload })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private onResult(payload: unknown): void {
    const o = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
    const entry = typeof o.requestId === 'string' ? this.pending.get(o.requestId) : undefined
    if (!entry || typeof o.requestId !== 'string') return
    this.pending.delete(o.requestId)
    clearTimeout(entry.timer)
    if (o.ok === true) entry.resolve(o.result)
    else entry.reject(new Error(typeof o.error === 'string' ? o.error.slice(0, 200) : 'The page could not do that.'))
  }

  private later(ctx: Context, ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      ctx.timers.delete(timer)
      if (this.ctx === ctx) fn()
    }, ms)
    ctx.timers.add(timer)
  }

  private update(patch: Partial<ApplySession>): void {
    if (!this.session) return
    this.session = { ...this.session, ...patch }
    this.deps.emit(this.session)
  }

  /** Drops the tab listeners and pending requests; the session object stays for the panel. */
  private release(): void {
    const ctx = this.ctx
    if (!ctx) return
    this.ctx = null
    for (const off of [...ctx.unsubscribe, ...ctx.sessionUnsubscribe]) off()
    for (const timer of ctx.timers) clearTimeout(timer)
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('The apply session ended.'))
      this.pending.delete(id)
    }
  }

  private end(): void {
    const had = this.session !== null
    this.release()
    this.session = null
    if (had) this.deps.emit(null)
  }
}

const CONFIRMED = 'The site shows its "application submitted" page. Mark this application as applied?'

/** What the panel says on a page that is a step of the apply flow but not a form to fill. */
const STEP_MESSAGE: Record<Exclude<PageScan['step'], 'form'>, string> = {
  posting: "This is the job posting. Press the site's Apply button; Huntgry fills the form when it appears.",
  choice: 'The site asks how to apply. Choose an option in the page; Huntgry fills the form when it appears.',
  'account-wall':
    'The site asks you to sign in or create an account. Do that in the page yourself; Huntgry fills the next steps.',
  other: 'This page is not an application form. Huntgry fills the form when it appears.'
}

/** Greenhouse's page for an embed whose token expired (`/embed/job_board?…&error=true`). */
function isExpiredEmbed(url: string): boolean {
  try {
    const u = new URL(url)
    return /\/embed\/job_board\/?$/.test(u.pathname) && u.searchParams.get('error') === 'true'
  } catch {
    return false
  }
}

/** `report` with its text fields taken from `verified` (a later verify of the same page). */
function withTextFrom(report: FillReport, verified: FillReport): FillReport {
  if (verified.url !== report.url) return report
  const text = new Map(verified.fields.filter((f) => f.kind === 'text' || f.kind === 'textarea').map((f) => [f.key, f]))
  return {
    ...report,
    fields: report.fields.map((f) => (f.key && (f.kind === 'text' || f.kind === 'textarea') && text.get(f.key)) || f)
  }
}

/** `report` (the text pass of a files-first adapter) with the upload outcomes of the first pass. */
function withFilesFrom(report: FillReport, first: FillReport): FillReport {
  const files = new Map(first.fields.filter((f) => f.kind === 'file' && f.key).map((f) => [f.key, f]))
  return { ...report, fields: report.fields.map((f) => (f.kind === 'file' && f.key && files.get(f.key)) || f) }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function summary(fields: FieldReport[]): string {
  const count = (...outcomes: FieldReport['outcome'][]) => fields.filter((f) => outcomes.includes(f.outcome)).length
  const filled = count('filled', 'uploaded')
  const open = fields.filter((f) => f.required && !['filled', 'uploaded', 'kept'].includes(f.outcome)).length
  const parts = [`Filled ${filled} field${filled === 1 ? '' : 's'}.`]
  if (open) parts.push(`${open} required field${open === 1 ? '' : 's'} still need${open === 1 ? 's' : ''} you.`)
  if (count('upload-failed')) parts.push('An upload failed; attach the file yourself.')
  parts.push('Review the form, then press the site’s Submit button yourself.')
  return parts.join(' ')
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || 'another site'
  } catch {
    return 'another site'
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
