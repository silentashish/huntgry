import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { ApplySession, FieldReport, FillValues, PageScan } from '@shared/apply-types'
import { applyUrlFor, isGreenhouseEmbedUrl } from '@shared/apply-url'
import { AUTOFILL_CHANNELS, UPLOAD_ATTR } from '@shared/autofill-channels'
import { resolveApplicationFile, resolveApplicationFolder } from '../applications/safe-path'
import { readApplication } from '../applications/scan'
import { isBlockedPage } from '../jobs/blocked'
import { uploadFile, type Cdp } from './upload'
import { parseFillReport, parsePageScan } from './validate'

/**
 * Auto-apply (#24): one session at a time. Opens the application's apply page
 * in an in-app browser tab, asks the tab's preload to detect and fill the
 * form, attaches `resume.pdf` / `cover.pdf` over CDP, and watches for the
 * site's confirmation page. It never submits and never changes tracking; the
 * user presses the site's Submit button and then "Mark as applied".
 */

/** One browser tab, as the service needs it (wrapped around `WebContents` in ipc.ts). */
export interface ApplyPage {
  send(channel: string, payload: unknown): void
  /** Messages from this tab's preload; returns the unsubscribe function. */
  onMessage(channel: string, listener: (payload: unknown) => void): () => void
  /** A main-frame load finished (`true`) or a single-page app changed its URL (`false`). */
  onLoad(listener: (fullLoad: boolean) => void): () => void
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
  /** Delays for re-detecting a page whose form renders late; injectable for tests. */
  retryDelaysMs?: number[]
  requestTimeoutMs?: number
}

interface Context {
  sessionId: string
  page: ApplyPage
  values: FillValues
  resumePath: string
  coverPath: string | null
  unsubscribe: Array<() => void>
  /** The page URL filled automatically, so a re-detect of the same page does not fill again. */
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

export class ApplyService {
  private session: ApplySession | null = null
  private ctx: Context | null = null
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly deps: ApplyDeps) {}

  current(): ApplySession | null {
    return this.session
  }

  async start(applicationId: string): Promise<ApplySession> {
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
    const page = this.deps.page(tabId)
    const sessionId = randomUUID()
    const ctx: Context = {
      sessionId,
      page,
      values,
      resumePath,
      coverPath,
      unsubscribe: [],
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
    ctx.unsubscribe.push(
      page.onMessage(AUTOFILL_CHANNELS.result, (payload) => this.onResult(payload)),
      page.onMessage(AUTOFILL_CHANNELS.confirmation, () => {
        if (this.ctx !== ctx) return
        // The page is a different page now: any fill or upload still running for the form is stale.
        ctx.loadSeq++
        this.update({ status: 'submitted-detected', message: CONFIRMED })
      }),
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
    this.deps.emit(this.session)
    return this.session
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
    if (!this.ctx || this.ctx.sessionId !== sessionId) throw new Error('This apply session has ended. Press Apply again.')
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
    if (!scan.formFound) {
      if (scan.embedUrl && isGreenhouseEmbedUrl(scan.embedUrl) && this.session) {
        this.update({ status: 'opened', message: 'This page embeds a Greenhouse form; opening it directly.' })
        await this.deps.navigate(this.session.tabId, scan.embedUrl).catch((err: unknown) => {
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
        message: 'No application form found on this page yet. Open the apply form in the page, then press Fill form.'
      })
      return
    }
    // Known ATS forms fill on their own; on other sites only a page with a resume upload counts as an application form.
    const auto = scan.url !== ctx.autoFilledUrl && (scan.ats !== 'generic' || scan.hasResumeInput)
    if (auto) {
      ctx.autoFilledUrl = scan.url
      await this.fillPage(ctx)
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
      const report = parseFillReport(await this.request(ctx, AUTOFILL_CHANNELS.fill, { values: ctx.values }))
      if (!current()) return
      ctx.autoFilledUrl = report.url
      // Text first, files last: Lever's resume parser overwrites empty text fields after an upload.
      for (const field of report.fields) {
        if (!current()) return
        if (field.outcome === 'to-upload') await this.upload(ctx, field, current)
      }
      if (!current()) return
      this.update({ status: 'filled', ats: report.ats, report, message: summary(report.fields) })
    } catch (err) {
      if (current()) this.update({ status: 'error', message: `Filling failed: ${errorMessage(err)}` })
    } finally {
      if (ctx.fillingSeq === seq) ctx.fillingSeq = null
    }
  }

  private async upload(ctx: Context, field: FieldReport, current: () => boolean): Promise<void> {
    const cover = field.key === 'coverLetter'
    const path = cover ? ctx.coverPath : ctx.resumePath
    if (!path || !this.session) {
      field.outcome = 'skipped-no-value'
      field.reason = 'This application has no cover.pdf.'
      return
    }
    // The selector is built from our own constants, never from page data.
    const selector = `[${UPLOAD_ATTR}="${cover ? 'cover' : 'resume'}"]`
    const tabId = this.session.tabId
    try {
      await uploadFile(() => this.deps.attachDebugger(tabId), selector, [path], { shouldContinue: current })
      field.outcome = 'uploaded'
      field.value = basename(path)
    } catch (err) {
      field.outcome = 'upload-failed'
      field.reason = errorMessage(err)
    }
  }

  /** Sends a request to the tab's preload and waits for its answer. */
  private request(ctx: Context, channel: string, payload: object): Promise<unknown> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('The page did not answer.'))
      }, this.deps.requestTimeoutMs ?? 10_000)
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
    for (const off of ctx.unsubscribe) off()
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

function summary(fields: FieldReport[]): string {
  const count = (...outcomes: FieldReport['outcome'][]) => fields.filter((f) => outcomes.includes(f.outcome)).length
  const filled = count('filled', 'uploaded')
  const open = fields.filter(
    (f) => f.required && !['filled', 'uploaded', 'kept'].includes(f.outcome)
  ).length
  const parts = [`Filled ${filled} field${filled === 1 ? '' : 's'}.`]
  if (open) parts.push(`${open} required field${open === 1 ? '' : 's'} still need${open === 1 ? 's' : ''} you.`)
  if (count('upload-failed')) parts.push('An upload failed; attach the file yourself.')
  parts.push('Review the form, then press the site’s Submit button yourself.')
  return parts.join(' ')
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
