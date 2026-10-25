import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  ATS_LABEL,
  type AdapterStep,
  type ApplyAts,
  type ApplySession,
  type FieldReport,
  type FillProfile,
  type FillReport,
  type FillValues,
  EMPTY_FILL_PROFILE,
  type PageScan,
  type UploadState
} from '@shared/apply-types'
import { embedPageFor } from '@shared/apply-embeds'
import { FACTS, isConsentQuestion, NO_ANSWERS, resolveAnswer, type FactKey, type PageAnswers } from '@shared/apply-facts'
import { aiAnswerReason, isDemographicQuestion } from '@shared/ai-answers'
import { applyUrlFor, isTrustedApplyPage } from '@shared/apply-url'
import { AUTOFILL_CHANNELS, UPLOAD_ATTR } from '@shared/autofill-channels'
import { reviewBlocker } from '@shared/review-types'
import { resolveApplicationFile, resolveApplicationFolder } from '../applications/safe-path'
import { readApplication } from '../applications/scan'
import { approvalDrift } from '../review/service'
import { isBlockedPage } from '../jobs/blocked'
import type { Draft, DraftQuestion } from './draft-answers'
import { isCompanySpecificQuestion, type Mapping, type MapQuestion } from './map-questions'
import { uploadFile, type Cdp } from './upload'
import { parseEdits, parseFillReport, parsePageScan, parseUploadState, type PageEdit } from './validate'

/**
 * Auto-apply (#24, #63): one session at a time. Opens the application's apply
 * page in an in-app browser tab, asks the tab's preload to detect and fill the
 * form once the page is ready (and to verify the values held), attaches
 * `resume.pdf` / `cover.pdf` over CDP and confirms the site's upload widget
 * shows them, follows the form into an embedded iframe or a popup tab, and
 * watches for the site's confirmation page. It never submits, never clicks
 * the site's buttons and never changes tracking; the user presses the site's
 * Submit button and then "Mark as applied".
 *
 * Automation (#154) prepares a form unattended through `prepare` (main only, never over IPC): the same
 * open and fill, in a tab that is not activated, with the file uploads left for the user's own open, and
 * a snapshot of the fill (report, AI drafts and answers) when every model call is done. The user's open
 * (`start` with that snapshot) writes the same answers again without asking the model.
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

/**
 * Application answers (#71): the memory under userData and the model that
 * maps unknown questions and, since #136, answers them from the master
 * profile. Stored values never go to the model, only labels/options and the
 * application's context.
 * Every call names the workspace the session started in: switching
 * workspaces mid-session must never move one person's answers into
 * another's memory, nor show them on the other's application.
 */
export interface AnswersDeps {
  /** What the page gets with each fill: confirmed facts (stored over the profile's) and the question memory. */
  load(workspace: string): Promise<PageAnswers>
  /** The user's answer, to remember: the fact for a question that asks one, else the answer itself. */
  remember(workspace: string, answer: { question: string; label: string; fact: FactKey | null; value: string }): Promise<void>
  /** A model's mappings and probable answers (#136), stored unconfirmed. */
  rememberMappings(
    workspace: string,
    mappings: Array<{ question: string; label: string; fact: FactKey | null; value?: string | null }>
  ): Promise<void>
  /**
   * One model call for the questions nothing knows yet, with the application's context (company, role, job
   * description, master profile; built by the caller from `applicationId`); rejects when no model is available or
   * it fails.
   */
  map(workspace: string, applicationId: string, questions: MapQuestion[]): Promise<Mapping[]>
  /**
   * Drafts for open-ended questions (#82) from the application's tailored resume and job description, in one
   * call; rejects when no model is available or it fails. Without it, those questions stay with the user.
   */
  draft?(workspace: string, applicationId: string, questions: DraftQuestion[]): Promise<Draft[]>
}

export interface ApplyDeps {
  workspace(): Promise<string>
  /** Values from the current master profile. */
  values(): Promise<FillValues>
  /**
   * The master profile's repeatable sections (#136: work experience, education, skills, websites), sent with every
   * fill for the adapters that fill them (Workday My Experience). Without it those sections are left alone.
   */
  profile?(): Promise<FillProfile>
  /** Remembered application answers (#71); without them only contact fields are filled. */
  answers?: AnswersDeps
  /**
   * The Settings switch "Pick dropdown answers automatically" (#71, owner decision): read before every fill, so
   * turning it off applies to the next fill. Without it, or off, click-only widgets only get suggestions.
   */
  pickWidgets?(): Promise<boolean>
  /**
   * The Settings switch "Use AI to answer unknown questions" (#136), read before every fill. On (or without it):
   * the model is asked once per page and its answers are written as "AI answers; check them". Off: no model call
   * at all (no mapping, no drafts); answers a model gave earlier are only suggested.
   */
  aiAnswers?(): Promise<boolean>
  /** `activate: false` opens it without taking the active tab; `background` keeps its timers running while hidden. */
  openTab(url: string, options?: { activate?: boolean; background?: boolean }): Promise<string>
  /** Closes a tab (Automation's hidden tab once its fill is saved). */
  closeTab?(tabId: string): void
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
  /**
   * How long main waits for a Workday fill (#136). Default 60 s: My Experience adds blocks and picks skills inside
   * the page (bounded there to 40 s), on top of the readiness wait, the other picks (8 s) and the verify pass.
   */
  workdayFillTimeoutMs?: number
  /** How long the site's widget may take to show an attached file. */
  uploadConfirmMs?: number
}

interface Context {
  sessionId: string
  /** The tab the session follows (a popup from it takes over). */
  tabId: string
  page: ApplyPage
  values: FillValues
  /** The profile's repeatable sections (#136), read at start like `values`. */
  profile: FillProfile
  /** Remembered answers, loaded at start and after the user teaches one (#71). */
  answers: PageAnswers
  /** Pick trusted answers in click-only widgets (the Settings switch as of the last fill). */
  pick: boolean
  /** Use AI answers (the Settings switch as of the last fill, #136). */
  ai: boolean
  /** Answers the user gave in the panel without Remember: this session only, by question key. */
  once: Record<string, string>
  /** An AI answer in the page the user's correction may replace (#136), by question key. */
  replace: Record<string, string>
  /**
   * Model answers that depend on this company, role or job description (#136: not `reusable`, or a draft-like
   * question), by question key: written into this application's page as AI answers, never stored, so the next
   * application asks the model again.
   */
  aiOnce: Record<string, { fact: FactKey | null; value: string }>
  /** The workspace the session started in; every answer read and write goes there (#71). */
  workspace: string
  /** Question keys already sent to the model this session (never sent twice). */
  asked: Set<string>
  /** Pages (URL plus step title) that already had their one model call, made or failed. */
  mappedSteps: Set<string>
  /** The application being applied to (its resume and job description are the drafts' context, #82). */
  applicationId: string
  /** AI drafts typed into open-ended questions this session, by question key (#82); never remembered. */
  drafts: Map<string, string>
  /** Pages (URL plus step title) that already had their one draft call, made or failed. */
  draftedSteps: Set<string>
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
  /**
   * The page generation (`loadSeq`) that showed the site's "application submitted" page (#119): nothing fills that
   * page, and work still in flight for it (a draft's refill, an answer) never turns "Submitted" back into "Filled".
   */
  confirmedSeq: number | null
  timers: Set<ReturnType<typeof setTimeout>>
  /** Automation's unattended fill (#154): no uploads (they send files to the employer before Submit). */
  deferUploads: boolean
  /** The model calls after the last fill (`learn`: mapping, drafts and their refills), while they run. */
  learning: Promise<void> | null
}

interface Pending {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_RETRIES = [1000, 3000]
/** Questions of one page sent to the model at most (the call's own bound). */
const MAX_MAPPED = 40
/** Open-ended questions of one page drafted at most (#82). */
const MAX_DRAFTED = 10
/** The preload waits for the page to settle (up to ~6 s) before it answers a detect. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
/**
 * A Workday fill (#136) may add My Experience blocks and pick skills in the page: the preload bounds that phase to
 * 40 s and the other picks to 8 s, plus its readiness wait (3 s) and verify pass (~1.3 s). Main waits a little longer
 * than that sum, and no more: a page that never answers still ends in "Filling failed".
 */
const WORKDAY_FILL_TIMEOUT_MS = 60_000
const DEFAULT_UPLOAD_CONFIRM_MS = 10_000
const MAX_EMBED_FOLLOWS = 3
/** Automation's whole fill may take this long by default (page load, fill, model calls, refills). */
const DEFAULT_PREPARE_TIMEOUT_MS = 180_000
/** A page that shows no form for this long (after its own retries) ends a prepare as "no form". */
const READY_SETTLE_MS = 12_000
const DRAFTED = 'AI draft from your resume and this job description. Read and edit it in the page before you submit.'

export class ApplyService {
  private session: ApplySession | null = null
  private ctx: Context | null = null
  private readonly pending = new Map<string, Pending>()
  /** A start() is between its first await and emitting the new session. */
  private starting = false
  /** The session is Automation's unattended fill (#154): not shown to the renderer. */
  private quiet = false
  /** Called on every session change (a prepare waits for its fill this way). */
  private readonly watchers = new Set<() => void>()

  constructor(private readonly deps: ApplyDeps) {}

  current(): ApplySession | null {
    return this.quiet ? null : this.session
  }

  /** A session is open or starting (Automation waits rather than ending the user's, #154). */
  busy(): boolean {
    return this.starting || (this.ctx !== null && !this.quiet)
  }

  /**
   * Opens a new session. One start at a time: a second one while the first
   * is still resolving files and opening the tab is refused, so two quick
   * clicks (or two windows) cannot swap the session under each other.
   */
  async start(applicationId: string, seed?: PreparedSeed): Promise<ApplySession> {
    if (this.starting) throw new Error('Another Apply is still starting. Try again in a moment.')
    this.starting = true
    try {
      return await this.open(applicationId, { seed })
    } finally {
      this.starting = false
    }
  }

  /**
   * Automation's unattended fill (#154, main only): opens the application's apply page in a tab that does not
   * take the active one, fills it like `start` (AI answers and drafts included) without attaching any file, waits
   * until the fill and its model calls are done, then ends the session, closes the tab and returns what was filled.
   * Any other end (a step that is the user's, a bot wall, no form, an error, the timeout) comes back as `ok: false`
   * with the reason. It never submits. An Unreviewed result may be prepared (the user approves it when opening the
   * form); one that needs attention, was discarded, or changed since its approval may not. Refused while another
   * session is open or starting: the caller waits.
   */
  async prepare(applicationId: string, { timeoutMs = DEFAULT_PREPARE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<PrepareResult> {
    if (this.busy() || this.ctx) throw new Error('An apply session is open; Automation waits for it to end.')
    this.starting = true
    let session: ApplySession
    try {
      session = await this.open(applicationId, { prepare: true })
    } finally {
      this.starting = false
    }
    // Read through a call: the check above narrowed `this.ctx` to null across the await.
    const ctx = this.context()
    if (!ctx) return { ok: false, status: 'closed', message: 'The apply session ended before the page loaded.' }
    const tabId = session.tabId
    try {
      const end = await this.settle(ctx, timeoutMs)
      if (end !== 'filled') return { ok: false, status: end, message: this.endMessage(end) }
      await ctx.learning
      const live = this.context() === ctx
      if (!live || this.session?.status !== 'filled' || !this.session.report) {
        return { ok: false, status: live ? (this.session?.status ?? 'closed') : 'closed', message: this.endMessage('closed') }
      }
      return {
        ok: true,
        fill: {
          url: this.session.report.url,
          report: this.session.report,
          drafts: Object.fromEntries(ctx.drafts),
          aiOnce: { ...ctx.aiOnce },
          mappedSteps: [...ctx.mappedSteps],
          draftedSteps: [...ctx.draftedSteps],
          asked: [...ctx.asked]
        }
      }
    } finally {
      if (this.context() === ctx) this.end()
      this.deps.closeTab?.(tabId)
    }
  }

  private context(): Context | null {
    return this.ctx
  }

  /** Waits until the prepare's session settles: filled (and no fill running), a terminal status, or the timeout. */
  private settle(ctx: Context, timeoutMs: number): Promise<PrepareEnd> {
    return new Promise((resolve) => {
      let readySince: number | null = null
      let readyTimer: ReturnType<typeof setTimeout> | null = null
      const done = (end: PrepareEnd) => {
        this.watchers.delete(check)
        clearTimeout(timer)
        if (readyTimer) clearTimeout(readyTimer)
        resolve(end)
      }
      const check = () => {
        if (this.ctx !== ctx || !this.session) return done('closed')
        const { status, message } = this.session
        if (status !== 'ready') {
          readySince = null
          if (readyTimer) clearTimeout(readyTimer)
          readyTimer = null
        }
        if (status === 'filled' && ctx.fillingSeq === null) return done('filled')
        if (status === 'waiting' && message !== BUSY) return done('waiting')
        if (status === 'blocked' || status === 'error' || status === 'closed' || status === 'submitted-detected') return done(status)
        if (status === 'ready' && readySince === null) {
          readySince = Date.now()
          readyTimer = setTimeout(() => {
            if (this.ctx === ctx && this.session?.status === 'ready') done('ready')
          }, READY_SETTLE_MS)
        }
      }
      const timer = setTimeout(() => done('timeout'), timeoutMs)
      this.watchers.add(check)
      check()
    })
  }

  /** Why a prepare ended without a filled form, for the "Needs you" row. */
  private endMessage(end: PrepareEnd): string {
    const message = this.session?.message
    switch (end) {
      case 'waiting':
        return message ?? 'The site needs you on this step.'
      case 'blocked':
        return 'The site asked for a human check.'
      case 'ready':
        return message ?? 'No application form Huntgry could fill on this page.'
      case 'timeout':
        return 'The form did not finish filling in time.'
      case 'submitted-detected':
        return 'The page shows an "application submitted" page.'
      case 'error':
        return message ?? 'Filling failed.'
      default:
        return 'The apply tab closed before the form was filled.'
    }
  }

  private async open(applicationId: string, { seed, prepare = false }: { seed?: PreparedSeed; prepare?: boolean } = {}): Promise<ApplySession> {
    const workspace = await this.deps.workspace()
    const folder = await resolveApplicationFolder(workspace, applicationId)
    const record = await readApplication(workspace, folder)
    // An unattended result is applied only once the user approved it on the Review page (#31). Automation may
    // prepare an Unreviewed one (#154): the user approves it when opening the filled form.
    const review = record.tracking.review
    const unreviewed = prepare && review?.state === 'unreviewed' ? null : reviewBlocker(review)
    if (unreviewed) throw new Error(unreviewed)
    // An approval vouches for the files the user saw; if they changed since, it no longer holds.
    const drift = await approvalDrift(workspace, applicationId)
    if (drift) throw new Error(drift)
    if (!record.jobUrl) throw new Error('This application has no posting URL. Add it in the application drawer first.')
    const resumePath = await resolveApplicationFile(workspace, applicationId, 'resume.pdf').catch(() => {
      throw new Error('This application has no resume.pdf yet. Build it in Tailor first.')
    })
    const coverPath = await resolveApplicationFile(workspace, applicationId, 'cover.pdf').catch(() => null)
    const values = await this.deps.values()
    const profile = (await this.deps.profile?.().catch(() => null)) ?? EMPTY_FILL_PROFILE
    const answers = (await this.deps.answers?.load(workspace).catch(() => null)) ?? NO_ANSWERS
    const applyUrl = applyUrlFor(record.jobUrl)

    this.end()
    this.quiet = prepare
    const tabId = await this.deps.openTab(applyUrl, prepare ? { activate: false, background: true } : undefined)
    const sessionId = randomUUID()
    const ctx: Context = {
      sessionId,
      tabId,
      page: this.deps.page(tabId),
      values,
      profile,
      answers,
      // A prepared fill's answers (#154): written again as they were, without asking the model.
      once: { ...seed?.drafts },
      replace: {},
      aiOnce: { ...(seed?.aiOnce as Context['aiOnce'] | undefined) },
      pick: false,
      ai: true,
      workspace,
      asked: new Set(seed?.asked),
      mappedSteps: new Set(seed?.mappedSteps),
      applicationId,
      drafts: new Map(Object.entries(seed?.drafts ?? {})),
      draftedSteps: new Set(seed?.draftedSteps),
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
      confirmedSeq: null,
      timers: new Set(),
      deferUploads: prepare,
      learning: null
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
    this.notify()
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
        this.confirmed(ctx, ++ctx.loadSeq)
      }),
      // A multi-step site (Workday) moved to another step, rendered more of it or stopped being busy, without a
      // navigation. The detect only invalidates running work when the page really differs from what it last saw.
      page.onMessage(AUTOFILL_CHANNELS.step, () => {
        if (this.ctx === ctx) void this.detect(ctx, null, 0)
      }),
      // The person answered or corrected questions in the page (#136): sent as the page is left or changes step.
      page.onMessage(AUTOFILL_CHANNELS.edits, (payload) => {
        if (this.ctx === ctx) void this.learnEdits(ctx, parseEdits(payload)).catch(() => undefined)
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
    await this.fillPage(ctx, { user: true })
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
      // The page did not answer (the request reached a document that was being replaced, or the page timed out)
      // or answered something unreadable. A newer load detects on its own; if none came, this page is still the
      // current one and nothing else would ever scan it again (#119): try again, a bounded number of times.
      this.detectAgain(ctx, seq, attempt)
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
      // A newer generation overtook this scan. Its own load detects it, except when nothing loads after the bump (a
      // navigation that started but never committed): if this scan saw the confirmation page, look again at the
      // current generation rather than trusting that a load follows (#119).
      if (scan.confirmation) this.detectAgain(ctx, ctx.loadSeq, attempt)
      return
    }
    ctx.pageKey = key
    this.update({ ats: scan.ats, step: stepOf(scan) })
    if (scan.confirmation) {
      this.confirmed(ctx, seq)
      return
    }
    // Only the posting's own site (and where its redirects landed) or an auto-trusted ATS host (AUTO_TRUSTED_ATS) is filled (or
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
      // The page's claim is checked against the embed rules and turned into the form's own page here, in main.
      const embed = scan.embedUrl ? embedPageFor(scan.embedUrl, { allowLoopback: this.deps.allowLocalEmbeds === true }) : null
      if (trusted && embed) {
        if (ctx.embedFollows >= MAX_EMBED_FOLLOWS) {
          this.update({ status: 'ready', message: 'The embedded application form keeps failing to load. Open it in the page, then press Fill form.' })
          return
        }
        ctx.embedFollows++
        ctx.embedHost = scan.url
        ctx.trusted.add(originOf(embed.url))
        this.update({ status: 'opened', message: `This page embeds the ${ATS_LABEL[embed.ats]} application form; opening it directly.` })
        await this.deps.navigate(ctx.tabId, embed.url).catch((err: unknown) => {
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
      this.detectAgain(ctx, seq, attempt)
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
   * Schedules the next detect of generation `seq` (the retry delays bound how many), unless a newer generation
   * already replaced it: that one's own load detects it. A step report (`seq` null) is retried as a step report, for
   * the generation it was made in.
   */
  private detectAgain(ctx: Context, seq: number | null, attempt: number): void {
    const delay = (this.deps.retryDelaysMs ?? DEFAULT_RETRIES)[attempt]
    const generation = seq ?? ctx.loadSeq
    if (delay === undefined || this.ctx !== ctx || ctx.loadSeq !== generation) return
    this.later(ctx, delay, () => {
      // A load meanwhile detects its own page; this retry would only scan it for a generation already gone.
      if (ctx.loadSeq === generation) void this.detect(ctx, seq, attempt + 1)
    })
  }

  /** Generation `seq` is the site's "application submitted" page. */
  private confirmed(ctx: Context, seq: number): void {
    ctx.confirmedSeq = seq
    this.update({ status: 'submitted-detected', message: CONFIRMED })
  }

  /**
   * Fills the page that is loaded now. Everything it does is tied to that
   * page (its `loadSeq`): if the user navigates or submits meanwhile, the
   * rest of the work (uploads, the final status) is dropped, so it can never
   * touch the next document or overwrite "submitted" with "filled".
   */
  private async fillPage(ctx: Context, { user = false }: { user?: boolean } = {}): Promise<void> {
    const seq = ctx.loadSeq
    // The site shows its "application submitted" page: there is no form left to fill (#119). Fill form pressed there
    // ("Not yet" in the panel) overrules the detection: the form may still be open.
    if (ctx.confirmedSeq === seq) {
      if (!user) return
      ctx.confirmedSeq = null
    }
    if (ctx.fillingSeq === seq) return
    ctx.fillingSeq = seq
    // A page whose scan was still pending when Fill form was pressed can turn out to be the confirmation page: the
    // fill then never shows "Filled" over "Submitted" (#119).
    const current = () => this.ctx === ctx && ctx.loadSeq === seq && ctx.confirmedSeq !== seq
    this.update({ status: 'filling', message: null })
    try {
      await this.collectEdits(ctx)
      await this.refreshPick(ctx)
      if (!current()) return
      // The preload waits for the page to settle, fills, then checks a moment later that the values held.
      let report = parseFillReport(await this.request(ctx, AUTOFILL_CHANNELS.fill, this.fillPayload(ctx), this.fillTimeout()))
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
      // Automation's unattended fill (#154) attaches nothing: an upload widget sends the file to the employer.
      const uploads = ctx.deferUploads ? [] : report.fields.filter((f) => f.outcome === 'to-upload')
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
        const text = parseFillReport(await this.request(ctx, AUTOFILL_CHANNELS.fill, { ...this.fillPayload(ctx), text: true }, this.fillTimeout()))
        if (!current()) return
        report = withFilesFrom(text, report)
      }
      this.markHandled(ctx, report)
      report = this.withAi(ctx, this.withDrafts(ctx, report))
      this.update({ status: 'filled', ats: report.ats, report, message: summary(report.fields) })
      ctx.learning = this.learn(ctx, report, seq).catch(() => undefined)
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

  /** How long a fill request may take: longer on Workday (#136, see `WORKDAY_FILL_TIMEOUT_MS`), else the default. */
  private fillTimeout(): number | undefined {
    return this.session?.ats === 'workday' ? (this.deps.workdayFillTimeoutMs ?? WORKDAY_FILL_TIMEOUT_MS) : undefined
  }

  /** What a fill sends the page: the profile values and sections, and the answers (this session's own on top). */
  private fillPayload(ctx: Context): { values: FillValues; profile: FillProfile; answers: PageAnswers; pick: boolean } {
    const questions = { ...ctx.answers.questions }
    // This application's own AI answers, unconfirmed (so they are written and marked as AI answers), unless the
    // memory has something better for the question.
    for (const [question, { fact, value }] of Object.entries(ctx.aiOnce)) {
      const known = questions[question]
      if (!known || (!known.confirmed && !known.value)) questions[question] = { fact, value, confirmed: false }
    }
    for (const [question, value] of Object.entries(ctx.once)) {
      const replace = ctx.replace[question]
      questions[question] = { ...questions[question], value, confirmed: true, ...(replace ? { replace } : {}) }
    }
    return { values: ctx.values, profile: ctx.profile, answers: { facts: ctx.answers.facts, questions, aiAnswers: ctx.ai }, pick: ctx.pick }
  }

  /** Reads the Settings switches for the coming fill: picking (off when it cannot be read), AI answers (#136, on). */
  private async refreshPick(ctx: Context): Promise<void> {
    const [pick, ai] = await Promise.all([
      this.deps.pickWidgets?.().catch(() => false),
      this.deps.aiAnswers ? this.deps.aiAnswers().catch(() => true) : true
    ])
    ctx.pick = pick ?? false
    ctx.ai = ai
  }

  /**
   * Asks the page for the questions the person changed since the last fill (#136) and remembers them, so a
   * correction made a moment ago is stored before the page is filled again. A page that does not answer changes
   * nothing.
   */
  private async collectEdits(ctx: Context): Promise<void> {
    if (!this.deps.answers || !this.session?.report?.fields.some((f) => f.question)) return
    const reply = await this.request(ctx, AUTOFILL_CHANNELS.edits, {}, 2000).catch(() => null)
    if (reply !== null && this.ctx === ctx) await this.learnEdits(ctx, parseEdits(reply)).catch(() => undefined)
  }

  /**
   * Questions the person answered or corrected in the page (#136), remembered as their own confirmed answers. Each
   * edit must name a question of the current report, for the same page; not a consent question, not an AI draft
   * (#82: drafts are this application's only), a select or radio answer one of the reported options. The same
   * value is not stored twice.
   */
  private async learnEdits(ctx: Context, { url, edits }: { url: string; edits: PageEdit[] }): Promise<void> {
    const answers = this.deps.answers
    const report = this.session?.report
    if (!answers || !report || !url || url !== report.url) return
    const learned: Array<{ question: string; label: string; fact: FactKey | null; value: string }> = []
    for (const edit of edits) {
      const field = report.fields.find((f) => f.fieldId === edit.fieldId && f.question)
      if (!field?.question || isConsentQuestion(field.label) || ctx.drafts.has(field.question)) continue
      const value = edit.value.trim()
      if (!value || value.length > 500) continue
      if ((field.kind === 'select' || field.kind === 'radio') && !(field.options ?? []).includes(value)) continue
      if (ctx.once[field.question] === value) continue
      ctx.once[field.question] = value
      // A question whose AI answer depended on this company: the person's version holds for this application only.
      if (ctx.aiOnce[field.question]) continue
      learned.push({ question: field.question, label: field.label, fact: field.fact ?? null, value })
    }
    if (learned.length === 0) return
    // Stored in the session's own workspace, even if the user switched workspaces meanwhile.
    for (const answer of learned) await answers.remember(ctx.workspace, answer).catch(() => undefined)
    const loaded = await answers.load(ctx.workspace).catch(() => null)
    if (loaded && this.ctx === ctx) ctx.answers = loaded
  }

  /**
   * After a fill (#71): the questions nothing knows yet (no fact from the
   * catalog, nothing in the memory) go to the model in one call, labels and
   * options only. Its mappings are stored unconfirmed and shown as
   * suggestions; they are never written until the user confirms one. A
   * missing CLI, a timeout or a bad reply leaves the fields as they are.
   */
  private async learn(ctx: Context, report: FillReport, seq: number): Promise<void> {
    // "Use AI to answer unknown questions" off (#136): no model call at all.
    if (!ctx.ai) return
    await this.mapUnknown(ctx, report, seq)
    await this.draft(ctx, report, seq)
  }

  /**
   * The model's call (#71, #136): each unknown question's fact and probable answer, stored unconfirmed when the
   * answer is reusable (the same on any employer's form); an answer that depends on this company, role or job
   * description is kept for this application only (`aiOnce`), so the next application asks again. When an
   * answer came back for the page that is still loaded, the page is filled again: the answers are written and the
   * panel shows them as "AI answers; check them". Otherwise the lines get the suggestions.
   */
  private async mapUnknown(ctx: Context, report: FillReport, seq: number): Promise<void> {
    const answers = this.deps.answers
    if (!answers) return
    const unknown = new Map<string, FieldReport>()
    for (const f of report.fields) {
      if (!f.question || !f.fieldId || f.fact || f.outcome === 'filled' || f.outcome === 'kept') continue
      if (ctx.answers.questions[f.question] || ctx.once[f.question] || ctx.asked.has(f.question)) continue
      if (!unknown.has(f.question)) unknown.set(f.question, f)
    }
    if (unknown.size === 0) return
    // One call per page and step, made or failed: questions over the limit, or rendered later, stay with the user.
    const step = stepKey(report.url, report.stepTitle ?? null)
    if (ctx.mappedSteps.has(step)) return
    ctx.mappedSteps.add(step)
    const asked = [...unknown.values()].slice(0, MAX_MAPPED)
    for (const f of asked) ctx.asked.add(f.question!)
    const byId = new Map(asked.map((f, i) => [`q${i + 1}`, f]))
    let mappings: Mapping[]
    try {
      mappings = await answers.map(
        ctx.workspace,
        ctx.applicationId,
        [...byId].map(([id, f]) => ({ id, question: f.label, kind: f.kind, options: f.options ?? [] }))
      )
    } catch {
      return
    }
    if (this.ctx !== ctx) return
    const learned = mappings
      .filter((m) => byId.has(m.id))
      .map((m) => {
        const f = byId.get(m.id)!
        // A sensitive fact or a demographic question never takes a model's answer (the parse drops it too).
        const eeo = (m.fact && FACTS[m.fact].sensitive) || isDemographicQuestion(f.label, f.options ?? [])
        const value = eeo ? null : (m.answer?.slice(0, 300) ?? null)
        // Reusable only when the model says so and the question is not about this employer (deterministic backstop).
        const reusable = m.reusable === true && !isCompanySpecificQuestion(f.label)
        return { question: f.question!, label: f.label, fact: m.fact, value, reusable }
      })
    if (learned.length === 0) return
    // An answer that depends on this company is used on this application only (written, marked, never stored).
    for (const l of learned) if (l.value && !l.reusable) ctx.aiOnce[l.question] = { fact: l.fact, value: l.value }
    // Stored: the fact mapping, and the value only when it is reusable. A company-specific answer with no fact
    // stores nothing, so the next application asks the model again.
    const stored = learned
      .filter((l) => !l.value || l.reusable || l.fact)
      .map(({ question, label, fact, value, reusable }) => ({ question, label, fact, value: reusable ? value : null }))
    // Stored in the session's own workspace, even if the user switched workspaces meanwhile.
    if (stored.length) await answers.rememberMappings(ctx.workspace, stored).catch(() => undefined)
    for (const l of stored) {
      ctx.answers.questions[l.question] ??= { fact: l.fact, confirmed: false, ...(l.value ? { value: l.value } : {}) }
    }
    const current = this.session?.report
    if (this.ctx !== ctx || !current || current.url !== report.url) return
    const facts = new Map(learned.filter((l) => l.fact).map((l) => [l.question, l.fact as FactKey]))
    const fields = current.fields.map((f) => {
      const fact = f.question ? facts.get(f.question) : undefined
      if (!fact || f.fact || f.outcome === 'filled' || f.outcome === 'kept') return f
      const value = ctx.answers.facts[fact]
      const suggestion = value ? resolveAnswer(fact, value, f.kind, f.options ?? []) : null
      return suggestion
        ? { ...f, fact, suggestion, suggestedBy: 'model' as const, reason: 'Suggested from your saved answers; confirm it below.' }
        : { ...f, fact, reason: 'Answer it once below; Huntgry remembers it.' }
    })
    this.update({ report: { ...current, fields } })
    // Something can be written now: a model answer, or a mapping to a stored, non-sensitive fact.
    const writable = learned.some((l) => l.value || (l.fact && !FACTS[l.fact].sensitive && ctx.answers.facts[l.fact]))
    if (!writable || !ctx.ai || ctx.fillingSeq !== null || ctx.loadSeq !== seq || ctx.confirmedSeq === seq) return
    await this.refill(ctx).catch(() => undefined)
  }

  /**
   * Report lines Huntgry filled from a model's entry (#136) say so: "AI answer from your profile; check it." The
   * page marks what it typed or selected; a picked answer (pick.ts clears the mark) is marked here.
   */
  private withAi(ctx: Context, report: FillReport): FillReport {
    if (!ctx.ai) return report
    const fields = report.fields.map((f) => {
      const entry = f.question ? (ctx.answers.questions[f.question] ?? ctx.aiOnce[f.question]) : undefined
      if (!entry || ('confirmed' in entry && entry.confirmed) || f.outcome !== 'filled' || f.suggestedBy === 'draft' || ctx.once[f.question!] !== undefined) return f
      const fact = entry.fact && ctx.answers.facts[entry.fact] ? entry.fact : null
      return { ...f, suggestedBy: 'model' as const, reason: aiAnswerReason(fact) }
    })
    return { ...report, fields }
  }

  /**
   * After the mapping (#82): typed questions that ask for no fact ("Why this
   * company?") get a draft from the application's tailored resume and job
   * description, one model call per page and step. A draft holds for this
   * session only and is typed into an empty field only (the user's own text
   * stays); the panel marks it as an AI draft to read before Submit.
   */
  private async draft(ctx: Context, report: FillReport, seq: number): Promise<void> {
    const draft = this.deps.answers?.draft?.bind(this.deps.answers)
    if (!draft || this.ctx !== ctx) return
    const current = this.session?.report
    if (!current || current.url !== report.url) return
    const open = new Map<string, FieldReport>()
    for (const f of current.fields) {
      if (!f.question || !f.fieldId || f.fact || f.outcome === 'filled' || f.outcome === 'kept') continue
      if (f.kind !== 'text' && f.kind !== 'textarea') continue
      if (ctx.once[f.question] || ctx.drafts.has(f.question)) continue
      // Only questions the model already said ask for no personal fact; a remembered answer is filled, not drafted.
      const known = ctx.answers.questions[f.question] ?? (ctx.aiOnce[f.question] ? { ...ctx.aiOnce[f.question], confirmed: false } : undefined)
      if (!known || known.fact || known.confirmed) continue
      if (!open.has(f.question)) open.set(f.question, f)
    }
    if (open.size === 0) return
    const step = stepKey(report.url, report.stepTitle ?? null)
    if (ctx.draftedSteps.has(step)) return
    ctx.draftedSteps.add(step)
    const asked = [...open.values()].slice(0, MAX_DRAFTED)
    const byId = new Map(asked.map((f, i) => [`q${i + 1}`, f]))
    let drafts: Draft[]
    try {
      drafts = await draft(
        ctx.workspace,
        ctx.applicationId,
        [...byId].map(([id, f]) => ({ id, question: f.label }))
      )
    } catch {
      return
    }
    if (this.ctx !== ctx) return
    let added = false
    for (const d of drafts) {
      const f = byId.get(d.id)
      if (!f?.question || ctx.once[f.question]) continue
      ctx.drafts.set(f.question, d.answer)
      ctx.once[f.question] = d.answer
      added = true
    }
    if (!added || this.session?.report?.url !== report.url || ctx.fillingSeq !== null) return
    // The drafts are typed only into the form they were made for (generation `seq`, the fill that reported the
    // questions). Once the page changed (submitted, another page, a navigation that never committed, an in-page URL
    // change) they stay with the session and go in with the next fill instead (#119).
    if (ctx.loadSeq !== seq) return
    await this.refill(ctx).catch(() => undefined)
  }

  /** Report lines Huntgry typed an AI draft into (#82) say so. */
  private withDrafts(ctx: Context, report: FillReport): FillReport {
    if (ctx.drafts.size === 0) return report
    const fields = report.fields.map((f) =>
      f.question && f.outcome === 'filled' && ctx.drafts.has(f.question) && ctx.once[f.question] === ctx.drafts.get(f.question)
        ? { ...f, suggestedBy: 'draft' as const, reason: DRAFTED }
        : f
    )
    return { ...report, fields }
  }

  /**
   * The user answered a question in the panel (#71). The field must be one
   * the page reported, and a select or radio answer one of its options. With
   * `remember` the answer is saved (main's store under userData); without it
   * it holds for this session. Then the page is filled again (typed fields
   * and choices only; the PDFs stay attached).
   */
  async answer(sessionId: string, fieldId: string, value: string, remember: boolean): Promise<ApplySession> {
    const ctx = this.require(sessionId)
    const field = this.session?.report?.fields.find((f) => f.fieldId === fieldId)
    if (!field?.question) throw new Error('That question is no longer on the page. Press Fill again.')
    const answer = value.trim()
    if (!answer || answer.length > 500) throw new Error('Type an answer (at most 500 characters).')
    if ((field.kind === 'select' || field.kind === 'radio') && !(field.options ?? []).includes(answer)) {
      throw new Error('Pick one of the options the page offers.')
    }
    if (remember && this.deps.answers) {
      await this.deps.answers.remember(ctx.workspace, { question: field.question, label: field.label, fact: field.fact ?? null, value: answer })
      ctx.answers = (await this.deps.answers.load(ctx.workspace).catch(() => null)) ?? ctx.answers
    }
    if (this.ctx !== ctx) throw new Error('This apply session has ended. Press Apply again.')
    // This page takes the exact option the user picked (a saved fact may match several of its options).
    ctx.once[field.question] = answer
    // A correction of an AI answer (#136) replaces what Huntgry wrote, never what the person typed since.
    if (field.outcome === 'filled' && field.suggestedBy === 'model' && field.value) ctx.replace[field.question] = field.value
    await this.refill(ctx)
    return this.session as ApplySession
  }

  /** Fills the current page again for an answer, without uploading again; the report keeps the upload lines. */
  private async refill(ctx: Context): Promise<void> {
    if (ctx.fillingSeq !== null) throw new Error('Huntgry is still filling this page. Try again in a moment.')
    const seq = ctx.loadSeq
    // The site already shows its "application submitted" page: there is no form left to fill (#119).
    if (ctx.confirmedSeq === seq || this.session?.status === 'submitted-detected') return
    ctx.fillingSeq = seq
    // A draft or an answer can take seconds; the page may have been submitted meanwhile. Its result is only for the
    // form it was made for: never for the confirmation page, never over "Submitted" (#119).
    const current = () => this.ctx === ctx && ctx.loadSeq === seq && ctx.confirmedSeq !== seq
    try {
      await this.collectEdits(ctx)
      await this.refreshPick(ctx)
      const text = parseFillReport(await this.request(ctx, AUTOFILL_CHANNELS.fill, { ...this.fillPayload(ctx), text: true }, this.fillTimeout()))
      if (!current() || (text.step && text.step !== 'form')) return
      const previous = this.session?.report
      const report = this.withAi(ctx, this.withDrafts(ctx, previous && previous.url === text.url ? withFilesFrom(text, previous) : text))
      this.update({ status: 'filled', report, message: summary(report.fields) })
    } finally {
      if (ctx.fillingSeq === seq) ctx.fillingSeq = null
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
    this.notify()
  }

  /** Tells the renderer (not for Automation's unattended session) and the prepare waiting for it. */
  private notify(): void {
    if (!this.quiet) this.deps.emit(this.session)
    for (const watcher of [...this.watchers]) watcher()
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
    const had = this.session !== null && !this.quiet
    this.release()
    this.session = null
    this.quiet = false
    if (had) this.deps.emit(null)
    for (const watcher of [...this.watchers]) watcher()
  }
}

/** How a prepare ended (#154): `filled`, or the session status (or timeout) that stopped it. */
export type PrepareEnd = 'filled' | 'waiting' | 'blocked' | 'ready' | 'error' | 'closed' | 'submitted-detected' | 'timeout'

/** What a prepared fill hands back to the user's open (`start`), so it writes the same answers without the model. */
export interface PreparedSeed {
  drafts: Record<string, string>
  aiOnce: Record<string, { fact: string | null; value: string }>
  mappedSteps: string[]
  draftedSteps: string[]
  asked: string[]
}

export type PrepareResult =
  | { ok: true; fill: PreparedSeed & { url: string; report: FillReport } }
  | { ok: false; status: Exclude<PrepareEnd, 'filled'> | ApplySession['status']; message: string }

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
