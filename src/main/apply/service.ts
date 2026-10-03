import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { AdapterStep, ApplyAts, ApplySession, FieldReport, FillReport, FillValues, PageScan, UploadState } from '@shared/apply-types'
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
  /**
   * Per page and step (URL plus step title): the profile fields a completed fill has handled (`*` for a whole
   * single-page form). A re-detect fills again only for fields the step rendered since (#65); a fill that was cut
   * short handles nothing, so the next detect of a still-current step retries it.
   */
  handled: Map<string, Set<string>>
  /** What the last accepted detect saw (see `pageKey`), to ignore a step report the service already acted on. */
  pageKey: string | null
  /** The step changed in place (fields added or replaced) while its fill ran: look again once the fill is done. */
  recheck: boolean
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
      handled: new Map(),
      pageKey: null,
      recheck: false,
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
      message: null,
      step: null
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
      // A multi-step site (Workday) moved to another step, rendered more of it or stopped being busy, without a
      // navigation. The detect only invalidates running work when the page really differs from what it last saw.
      page.onMessage(AUTOFILL_CHANNELS.step, () => {
        if (this.ctx === ctx) void this.detect(ctx, null, 0)
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
        ctx.recheck = false
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

  /** `seq` is the load the detect belongs to, or null for a page's step report (a new generation only if the page changed). */
  private async detect(ctx: Context, seq: number | null, attempt: number): Promise<void> {
    let scan: PageScan
    try {
      scan = parsePageScan(await this.request(ctx, AUTOFILL_CHANNELS.detect, {}))
    } catch {
      // The page navigated away or is still busy; the next load detects again.
      return
    }
    if (this.ctx !== ctx) return
    const key = pageKey(scan)
    if (seq === null) {
      if (ctx.fillingSeq !== null && ctx.pageKey !== null && stepId(ctx.pageKey) === stepId(key)) {
        // The step being filled reported again (an in-page navigation's detect got there first), or it changed in
        // place (Workday replaces the resume input once it has the file): the running fill or upload stays valid.
        if (key !== ctx.pageKey) ctx.recheck = true
        return
      }
      if (key !== ctx.pageKey) {
        seq = ++ctx.loadSeq
        ctx.recheck = false
      } else if (!scan.ready) {
        // Only the site's busy state changed.
        return
      } else {
        // The same step, now ready (Workday finished reading the resume): carry on without invalidating anything.
        seq = ctx.loadSeq
      }
    } else if (ctx.loadSeq !== seq) {
      return
    }
    ctx.pageKey = key
    this.update({ ats: scan.ats, step: stepOf(scan) })
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
    // A posting, a "how to apply" choice, a sign-in wall or another step of the site's flow: the user acts in the
    // page; Huntgry presses nothing and fills nothing. The page reports the next step (or the next load detects it).
    if (scan.step !== 'form') {
      this.update({ status: 'waiting', report: null, message: stepMessage(scan.ats, scan.step, scan.stepTitle) })
      return
    }
    // A step filled earlier whose last input the site has since replaced (Workday lists the uploaded resume
    // instead of its drop zone): what was filled still stands.
    if (!scan.formFound && scan.stepTitle && ctx.handled.has(stepKey(scan.url, scan.stepTitle))) return
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
      const at = seq
      if (delay !== undefined) this.later(ctx, delay, () => void this.detect(ctx, at, attempt + 1))
      this.update({
        status: 'ready',
        message:
          "No application form on this page yet. Open it with the page's own Apply button; Huntgry fills it when it appears (or press Fill form)."
      })
      return
    }
    // The site is still working on the step (Workday reading the resume, which rewrites My Information): fill after.
    if (!scan.ready && trusted && unhandled(ctx, scan)) {
      this.update({ status: 'waiting', message: BUSY })
      return
    }
    // Known ATS forms fill on their own; on other sites only a page with a resume upload counts as an application form.
    // A multi-step form is filled once per step, and again only for fields the step rendered since.
    const auto = trusted && unhandled(ctx, scan) && (scan.ats !== 'generic' || scan.hasResumeInput)
    if (auto) {
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
      if (report.step && report.step !== 'form') {
        // Fill form pressed on a step that is the user's (a sign-in wall…): the page was left untouched.
        this.update({
          status: 'waiting',
          report: null,
          step: { kind: report.step, title: report.stepTitle ?? null },
          message: stepMessage(report.ats, report.step, report.stepTitle ?? null)
        })
        return
      }
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
      this.markHandled(ctx, report)
      this.update({ status: 'filled', ats: report.ats, report, message: summary(report.fields) })
      if (ctx.recheck) {
        ctx.recheck = false
        // Fields the step rendered meanwhile get filled now (finally clears fillingSeq first).
        queueMicrotask(() => void this.detect(ctx, ctx.loadSeq, 0))
      }
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
   * A fill completed: remember what the step handled, and keep the lines of an
   * earlier fill of the same step for fields this one no longer sees (Workday
   * replaces the resume input once it has the file).
   */
  private markHandled(ctx: Context, report: FillReport): void {
    const step = stepKey(report.url, report.stepTitle ?? null)
    const done = ctx.handled.get(step) ?? new Set<string>()
    const previous = this.session?.report
    if (previous && done.size && stepKey(previous.url, previous.stepTitle ?? null) === step) {
      const seen = new Set(report.fields.map((f) => f.key))
      report.fields = [...report.fields, ...previous.fields.filter((f) => f.key && !seen.has(f.key))]
    }
    for (const f of report.fields) if (f.key) done.add(f.key)
    if (report.stepFields == null) done.add('*')
    ctx.handled.set(step, done)
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

const stepOf = (scan: PageScan): ApplySession['step'] =>
  scan.step === 'form' && !scan.stepTitle ? null : { kind: scan.step, title: scan.stepTitle }

/** A page and step: a multi-step site keeps its URL while the step changes. */
const stepKey = (url: string, stepTitle: string | null) => `${url}#${stepTitle ?? ''}`

/** What a detect saw, apart from the site's busy state (`ready`); two detects with the same key saw the same page. */
const pageKey = (scan: PageScan) =>
  [scan.ats, scan.url, scan.step, scan.stepTitle, scan.confirmation, scan.stepFields, scan.formFound].join('\n')

/** The page and step part of a `pageKey` (without what the step currently shows). */
const stepId = (key: string) => key.split('\n').slice(0, 5).join('\n')

/** Whether the step shows a field no completed fill has handled yet (single-page forms: not filled yet at all). */
function unhandled(ctx: Context, scan: PageScan): boolean {
  const done = ctx.handled.get(stepKey(scan.url, scan.stepTitle))
  if (!done) return true
  if (scan.stepFields === null) return !done.has('*')
  return scan.stepFields.split(',').some((k) => k && !done.has(k))
}

const BUSY = 'The site is still working on this step (for example, reading your resume). Huntgry fills it once it is done.'

/** What the user does on a step that is theirs. Huntgry never presses the site's buttons. */
function stepMessage(ats: ApplyAts, step: AdapterStep, title: string | null): string {
  const workday = ats === 'workday'
  switch (step) {
    case 'posting':
      return 'This is the job posting. Press "Apply" in the page yourself; Huntgry continues on the next step.'
    case 'choice':
      return workday
        ? 'Choose how to apply in the page: "Autofill with Resume" (Huntgry attaches your resume.pdf) or "Apply Manually". Huntgry does not press either.'
        : 'The site asks how to apply. Choose an option in the page; Huntgry continues on the next step.'
    case 'account-wall':
      return `Sign in or create your ${workday ? 'Workday ' : ''}account in the page yourself. Huntgry fills nothing here (no email, never a password) and fills the next steps once you are past it.`
    default:
      return `Nothing for Huntgry on this step${title ? ` ("${title}")` : ''}. Answer it in the page and continue; Huntgry fills the steps it knows.`
  }
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
