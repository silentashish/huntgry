import { NO_ANSWERS, resolveAnswer, type PageAnswers } from '../apply-facts'
import type { AdapterStep, ApplyAts, FieldKey, FieldReport, FillReport, FillValues, PageScan, UploadState } from '../apply-types'
import { EMBED_RULES, embedPathMatches } from '../apply-embeds'
import { adapterFor, type Adapter, type UploadProbe } from './adapters'
import { UPLOAD_ATTR, UPLOAD_GROUP_ATTR } from '../autofill-channels'
import {
  chosenOf,
  highlight,
  isControl,
  isRelevant,
  isRequired,
  kindOf,
  labelOf,
  setNativeValue,
  valueMatches,
  type FormControl
} from './dom'
import { answerable, answerField, editedInGroup, strategyOf, writeAnswer, yesNoGroup, type PickRequest } from './answers'
import { pick, widgetOf } from './pick'
import { matchFileField, matchTextField, type Match } from './match'
import { sleep } from './ready'
import { defaultUploadAttached } from './upload-state'
import { editedByUser } from './user-edits'

/**
 * The autofill engine: pure DOM code, run by the browser tab's preload and by
 * jsdom in tests. It fills text fields and marks file inputs for main to
 * upload over CDP, and answers the questions the user taught it (#71,
 * answers.ts): typed fields, native selects and native radios, never a
 * checkbox, never a widget that needs a click. It never submits a form or
 * presses a button. (guard.test.ts enforces the "never submits".)
 */

/** Upload marker values: `data-huntgry-upload="resume" | "cover"`. */
export const UPLOAD_KIND = { resume: 'resume', coverLetter: 'cover' } as const
export type UploadKey = keyof typeof UPLOAD_KIND

interface Planned {
  el: FormControl
  key: FieldKey | null
  score: number
  /** The container the control was found in, when it is one of the adapter's `answerRoots`. */
  root?: Element
  /** Set when the planner already knows the outcome (ambiguous, unsupported…). */
  outcome?: FieldReport['outcome']
  reason?: string
}

const MAX_FIELDS = 150

function pageUrl(doc: Document): URL {
  return new URL(doc.location?.href ?? doc.URL)
}

/** Every relevant control of the form, radios collapsed to one per group. */
function controlsOf(root: Element): FormControl[] {
  const seenRadio = new Set<string>()
  const out: FormControl[] = []
  for (const el of Array.from(root.querySelectorAll('input, textarea, select'))) {
    if (!isControl(el) || !isRelevant(el)) continue
    if (kindOf(el) === 'radio') {
      const name = el.getAttribute('name') ?? ''
      if (seenRadio.has(name)) continue
      seenRadio.add(name)
    }
    out.push(el)
    if (out.length >= MAX_FIELDS) break
  }
  return out
}

/**
 * A stable id per control for the panel's answers: kind plus `name` or `id`
 * (else the label), numbered when several controls share it. Recomputed the
 * same way on every fill, so it survives re-renders that keep the markup.
 */
function fieldIdsOf(controls: FormControl[]): Map<FormControl, string> {
  const seen = new Map<string, number>()
  const ids = new Map<FormControl, string>()
  for (const el of controls) {
    const base = `${kindOf(el)}:${(el.getAttribute('name') || el.id || `label:${labelOf(el)}`).slice(0, 160)}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    ids.set(el, n === 1 ? base : `${base}#${n}`)
  }
  return ids
}

/** Controls the adapter marks as pickers or click-only: answers are only suggested for them. */
function clickOnlyOf(adapter: Adapter, roots: Element[]): Set<Element> {
  const out = new Set<Element>()
  for (const root of roots)
    for (const selector of [...(adapter.choices ?? []), ...(adapter.clickOnly ?? [])])
      for (const el of Array.from(root.querySelectorAll(selector))) out.add(el)
  return out
}

/** The adapter's extra answer-only containers (outside the form root), with their questions. */
function answerRootsOf(adapter: Adapter, doc: Document, root: Element): Element[] {
  return (adapter.answerRoots?.(doc) ?? []).filter((r) => r !== root && !root.contains(r) && !r.contains(root))
}

/**
 * Dropdown buttons with a listbox (Workday): not form controls, but questions
 * answered from memory (#71). Reported as comboboxes; never matched to contact values.
 */
function listboxButtons(root: Element, planned: Planned[]): Planned[] {
  const seen = new Set(planned.map((p) => p.el as Element))
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"]'))
    .filter((b) => !b.disabled && !seen.has(b))
    .slice(0, 50)
    .map((b) => ({
      el: b as unknown as FormControl,
      key: null,
      score: 0,
      outcome: 'skipped-unsupported' as const,
      reason: 'A choice; pick it yourself.'
    }))
}

/** Questions of the extra containers: only ever answered from memory, never matched to contact values. */
function answerOnlyPlanned(roots: Element[]): Planned[] {
  return roots.flatMap((root) =>
    controlsOf(root)
      .filter((el) => kindOf(el) !== 'file')
      .map((el): Planned => {
        const kind = kindOf(el)
        const choice = kind === 'select' || kind === 'combobox' || kind === 'checkbox' || kind === 'radio'
        return choice
          ? { el, key: null, score: 0, root, outcome: 'skipped-unsupported', reason: 'A choice; pick it yourself.' }
          : { el, key: null, score: 0, root, outcome: 'unmatched', reason: 'Huntgry does not answer this; fill it in.' }
      })
  )
}

/** Decides what each control gets: adapter fields first, then the generic matcher, one field per key. */
function plan(adapter: Adapter, root: Element): Planned[] {
  const controls = controlsOf(root)
  const known = new Map<FormControl, FieldKey>()
  for (const [selector, key] of adapter.known) {
    const el = root.querySelector(selector)
    if (el && isControl(el) && isRelevant(el) && !known.has(el)) known.set(el, key)
  }
  const claimedByAdapter = new Set(known.values())
  const choices = new Set<Element>()
  for (const selector of adapter.choices ?? []) for (const el of Array.from(root.querySelectorAll(selector))) choices.add(el)

  const planned: Planned[] = controls.map((el) => {
    const adapterKey = known.get(el)
    if (adapterKey) return { el, key: adapterKey, score: 10 }
    const kind = kindOf(el)
    if (choices.has(el)) {
      return { el, key: null, score: 0, outcome: 'skipped-unsupported', reason: "Pick it from the site's suggestions." }
    }
    if (kind === 'select' || kind === 'combobox' || kind === 'checkbox' || kind === 'radio') {
      return { el, key: null, score: 0, outcome: 'skipped-unsupported', reason: 'A choice; pick it yourself.' }
    }
    let match: Match | null = null
    if (kind === 'file') match = matchFileField(el)
    else if (kind === 'text') match = matchTextField(el)
    if (!match) {
      const reason =
        kind === 'file'
          ? 'Not a resume or cover-letter upload; attach it yourself.'
          : 'Huntgry does not answer this; fill it in.'
      return { el, key: null, score: 0, outcome: 'unmatched', reason }
    }
    if (claimedByAdapter.has(match.key)) {
      return { el, key: null, score: 0, outcome: 'unmatched', reason: 'Another field already takes this value.' }
    }
    return { el, key: match.key, score: match.score }
  })

  // One field per key: the best score wins; a tie leaves all of them to the user.
  const byKey = new Map<FieldKey, Planned[]>()
  for (const p of planned) if (p.key && !p.outcome) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p])
  for (const group of byKey.values()) {
    if (group.length < 2) continue
    const top = Math.max(...group.map((p) => p.score))
    const winners = group.filter((p) => p.score === top)
    for (const p of group) {
      if (winners.length > 1) {
        p.outcome = 'ambiguous'
        p.reason = 'Several fields look like this one; fill it in.'
      } else if (p !== winners[0]) {
        p.outcome = 'unmatched'
        p.reason = 'Another field already takes this value.'
      }
    }
  }
  return planned
}

function hasSubmitButton(root: Element): boolean {
  return root.querySelector('button[type="submit"], input[type="submit"], button:not([type])') !== null
}

/** What kind of page this is: ATS, form present, confirmation page, bot-wall text for main to judge. */
export function scanPage(doc: Document): PageScan {
  const url = pageUrl(doc)
  const adapter = adapterFor(url, doc)
  const root = adapter.formRoot(doc)
  const controls = root ? controlsOf(root) : []
  return {
    ats: adapter.ats,
    url: url.href,
    title: (doc.title ?? '').slice(0, 300),
    text: (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 3000),
    confirmation: adapter.isConfirmation(url, doc),
    formFound: controls.some((c) => kindOf(c) === 'text' || kindOf(c) === 'file'),
    hasResumeInput: controls.some((c) => matchFileField(c)?.key === 'resume'),
    embedUrl: embedUrlOf(doc, url),
    ...stepOf(adapter, doc, root)
  }
}

interface StepInfo {
  step: AdapterStep
  stepTitle: string | null
  stepFields: string | null
  ready: boolean
}

/**
 * The adapter's view of the step. `stepFields` (multi-step adapters only)
 * lists the profile fields the step shows now, so fields a step renders late
 * count as a change; `ready` is the adapter's `ready` answer right now (a
 * promise counts as ready; the preload's readiness wait awaits it).
 */
function stepOf(adapter: Adapter, doc: Document, root: Element | null): StepInfo {
  const ready = adapter.ready?.(doc)
  return {
    step: adapter.step?.(doc) ?? 'form',
    stepTitle: adapter.stepTitle?.(doc)?.trim().slice(0, 120) || null,
    stepFields: adapter.step ? fieldKeysOf(adapter, root) : null,
    ready: typeof ready === 'boolean' ? ready : true
  }
}

function fieldKeysOf(adapter: Adapter, root: Element | null): string {
  if (!root) return ''
  const keys = new Set<FieldKey>()
  for (const p of plan(adapter, root)) if (p.key && !p.outcome) keys.add(p.key)
  return [...keys].sort().join(',')
}

/** Where the page is in the site's apply flow (cheap; the preload's step watcher polls it). */
export function pageStep(doc: Document): { ats: ApplyAts } & StepInfo {
  const adapter = adapterFor(pageUrl(doc), doc)
  return { ats: adapter.ats, ...stepOf(adapter, doc, adapter.formRoot(doc)) }
}

/**
 * The first iframe on the page that holds an ATS's embedded form (see
 * apply-embeds.ts), matched by path here; main checks its host before
 * opening it (and only allows a loopback mock in dev builds).
 */
function embedUrlOf(doc: Document, base: URL): string | null {
  return embedUrlsOf(doc, base)[0] ?? null
}

/** Every embedded-form iframe URL on the page, in rule then document order. */
export function embedUrlsOf(doc: Document, base: URL = pageUrl(doc)): string[] {
  const urls: string[] = []
  for (const rule of EMBED_RULES) {
    for (const iframe of Array.from(doc.querySelectorAll(rule.iframe))) {
      const src = iframe.getAttribute('src')
      if (!src) continue
      try {
        const absolute = new URL(src, base)
        if (/^https?:$/.test(absolute.protocol) && embedPathMatches(rule, absolute)) urls.push(absolute.href)
      } catch {
        // Not a URL; try the next iframe.
      }
    }
  }
  return urls
}

/** Whether the page is the site's "application submitted" page. */
export function detectConfirmation(doc: Document): boolean {
  const url = pageUrl(doc)
  return adapterFor(url, doc).isConfirmation(url, doc)
}

export interface FillOptions {
  /**
   * `false` marks the file inputs only and leaves text alone (the first pass
   * of a `files-first` adapter). Default: fill text unless the adapter
   * attaches files first, in which case the report says `uploadOrder:
   * 'files-first'` and main asks again with `text: true` after the upload.
   */
  text?: boolean
  /** Remembered facts and question answers (#71); without them only contact fields are filled. */
  answers?: PageAnswers
  /**
   * Pick trusted remembered answers in widgets that only take a click (the
   * Settings switch, sent by main). The picks are queued on the report
   * (`pendingPicks`) and run by `pickAnswers` after this synchronous fill.
   */
  pick?: boolean
}

/** Picks a fill queued for `pickAnswers` (not part of the report sent to main). */
const PENDING_PICKS = new WeakMap<FillReport, PickRequest[]>()

export const pendingPicks = (report: FillReport): PickRequest[] => PENDING_PICKS.get(report) ?? []

/** The upload widget around a file input (see `Adapter.uploadGroup`). */
function defaultUploadGroup(input: HTMLInputElement): Element | null {
  return (
    input.closest('[role="group"], fieldset, .file-upload, .application-question, .application-field, label') ??
    input.parentElement
  )
}

function markUpload(adapter: Adapter, el: FormControl, key: UploadKey): void {
  const kind = UPLOAD_KIND[key]
  el.setAttribute(UPLOAD_ATTR, kind)
  const group = (adapter.uploadGroup ?? defaultUploadGroup)(el as HTMLInputElement)
  group?.setAttribute(UPLOAD_GROUP_ATTR, kind)
}

/**
 * Fills the form's text fields that are empty (a value the user typed is
 * kept), reads each one back, marks the file inputs (and their upload
 * widgets) for upload and outlines what it did. Returns one report line per
 * field. A page the adapter says is not a form step (a sign-in wall, a
 * posting) is not touched at all.
 */
export function fillPage(doc: Document, values: FillValues, options: FillOptions = {}): FillReport {
  const url = pageUrl(doc)
  const adapter = adapterFor(url, doc)
  const uploadOrder = adapter.uploadOrder ?? 'text-first'
  const root = adapter.formRoot(doc)
  const { step, stepTitle, stepFields } = stepOf(adapter, doc, root)
  const report: FillReport = { ats: adapter.ats, url: url.href, fields: [], hasSubmitButton: false, uploadOrder, step, stepTitle, stepFields }
  if (step !== 'form') return report
  if (!root) return report
  const writeText = options.text ?? uploadOrder === 'text-first'
  report.hasSubmitButton = hasSubmitButton(root)
  for (const attr of [UPLOAD_ATTR, UPLOAD_GROUP_ATTR]) {
    for (const old of Array.from(doc.querySelectorAll(`[${attr}]`))) old.removeAttribute(attr)
  }
  let first: Element | null = null
  const extraRoots = answerRootsOf(adapter, doc, root)
  const base = [...plan(adapter, root), ...answerOnlyPlanned(extraRoots)]
  const planned = [...base, ...listboxButtons(root, base)]
  const ids = fieldIdsOf(planned.map((p) => p.el))
  const clickOnly = clickOnlyOf(adapter, [root, ...extraRoots])
  const answers = options.answers ?? NO_ANSWERS
  const picks: PickRequest[] = []
  PENDING_PICKS.set(report, picks)

  for (const p of planned) {
    const kind = kindOf(p.el)
    const line: FieldReport = {
      key: p.key,
      label: labelOf(p.el),
      kind,
      required: isRequired(p.el),
      outcome: 'unmatched'
    }
    if (p.outcome) {
      line.outcome = p.outcome
      line.reason = p.reason
      if (p.outcome !== 'skipped-unsupported') highlight(p.el, 'attention')
      // A question the contact block does not cover: answered from what the user taught Huntgry (#71).
      if (writeText && p.outcome !== 'ambiguous' && answerable(kind) && (kind !== 'checkbox' || yesNoGroup(p.el))) {
        line.fieldId = ids.get(p.el)
        const policy = options.pick ? 'pick' : 'suggest'
        if (answerField(p.el, line, p.root ?? root, answers, clickOnly.has(p.el), policy, picks)) first ??= p.el
      }
      report.fields.push(line)
      continue
    }
    if (p.key === 'resume' || p.key === 'coverLetter') {
      markUpload(adapter, p.el, p.key)
      line.outcome = 'to-upload'
      first ??= p.el
      report.fields.push(line)
      continue
    }
    // Text left for the second pass of a files-first adapter is not reported yet.
    if (!writeText) continue
    report.fields.push(line)
    if (!p.key || (kind !== 'text' && kind !== 'textarea')) continue
    const value = values[p.key]
    const el = p.el as HTMLInputElement | HTMLTextAreaElement
    const phone = p.key === 'phone'
    if (!value) {
      line.outcome = 'skipped-no-value'
      line.reason = 'Not in your master profile.'
      highlight(el, 'attention')
      continue
    }
    if (el.value.trim() && !valueMatches(el, value, phone)) {
      line.outcome = 'kept'
      line.value = el.value.trim().slice(0, 200)
      line.reason = 'Already filled in; left as is.'
      continue
    }
    const ok = valueMatches(el, value, phone) || setNativeValue(el, value, phone)
    line.value = value
    if (ok) {
      line.outcome = 'filled'
      highlight(el, 'done')
      first ??= el
    } else {
      line.outcome = 'rejected'
      line.reason = el.value ? `The site changed it to "${el.value.slice(0, 80)}".` : 'The site cleared it.'
      highlight(el, 'attention')
    }
  }
  // Greenhouse shows the form below a long description: bring it into view so the user sees what was filled.
  ;(first as HTMLElement | null)?.scrollIntoView?.({ block: 'center' })
  return report
}

export interface VerifyOptions {
  /** How long a value written again must hold before it counts (sites may clear it asynchronously). */
  settleMs?: number
}

const keepUserEdit = (line: FieldReport, el: HTMLInputElement | HTMLTextAreaElement) => {
  line.outcome = 'kept'
  line.value = el.value.trim().slice(0, 200)
  line.reason = 'You changed it after Huntgry filled it; left as is.'
}

const keepUserAnswer = (line: FieldReport, el: FormControl, root: ParentNode) => {
  line.outcome = 'kept'
  line.value = chosenOf(el, root).slice(0, 200)
  line.reason = 'You changed it after Huntgry filled it; left as is.'
}

/**
 * Checks, a moment after a fill, that every field reported `filled` still
 * holds its value. A late re-render (React hydration) or a resume parser can
 * wipe or replace them: each such value is written once more, then read back
 * after `settleMs` without writing again; a field that does not hold it then
 * becomes `rejected`. A field the person edited since (see user-edits.ts) is
 * `kept` and never overwritten. File inputs that lost their upload marker (a
 * re-render replaced them) are marked again. Mutates and returns `report`.
 */
export async function verifyFill(
  doc: Document,
  values: FillValues,
  report: FillReport,
  { settleMs = 300 }: VerifyOptions = {}
): Promise<FillReport> {
  const url = pageUrl(doc)
  if (url.href !== report.url) return report
  const adapter = adapterFor(url, doc)
  const root = adapter.formRoot(doc)
  if (!root) return report
  const extraRoots = answerRootsOf(adapter, doc, root)
  const planned = [...plan(adapter, root), ...answerOnlyPlanned(extraRoots)]
  const clickOnly = clickOnlyOf(adapter, [root, ...extraRoots])
  const byKey = new Map<FieldKey, FormControl>()
  for (const p of planned) if (p.key && !p.outcome && !byKey.has(p.key)) byKey.set(p.key, p.el)
  const byId = new Map([...fieldIdsOf(planned.map((p) => p.el))].map(([el, id]) => [id, el]))
  const rootOf = new Map(planned.map((p) => [p.el, p.root ?? root]))

  const rewritten: Array<{ line: FieldReport; el: HTMLInputElement | HTMLTextAreaElement; value: string }> = []
  const reanswered: Array<{ line: FieldReport; el: FormControl; value: string }> = []
  for (const line of report.fields) {
    // A remembered answer Huntgry wrote (#71): the same check, keyed by the control's id.
    if (!line.key && line.outcome === 'filled' && line.fieldId && line.value) {
      const el = byId.get(line.fieldId)
      // A picked widget (pick.ts read it back) or a dropdown button: nothing here may write it again.
      if (el && (yesNoGroup(el) || ['click-only', 'never'].includes(strategyOf(kindOf(el), clickOnly.has(el))))) continue
      if (!el && line.kind === 'combobox') continue
      if (!el) {
        line.outcome = 'rejected'
        line.reason = 'The field disappeared after it was filled.'
      } else if (chosenOf(el, rootOf.get(el) ?? root) !== line.value) {
        const at = rootOf.get(el) ?? root
        if (editedInGroup(el, kindOf(el), at)) keepUserAnswer(line, el, at)
        else {
          writeAnswer(el, strategyOf(kindOf(el), false), at, line.value)
          reanswered.push({ line, el, value: line.value })
        }
      }
      continue
    }
    if (!line.key) continue
    if (line.outcome === 'to-upload' && (line.key === 'resume' || line.key === 'coverLetter')) {
      const el = byKey.get(line.key)
      if (el && !el.hasAttribute(UPLOAD_ATTR)) markUpload(adapter, el, line.key)
      continue
    }
    if (line.outcome !== 'filled' || line.key === 'resume' || line.key === 'coverLetter') continue
    const value = values[line.key]
    const el = byKey.get(line.key) as HTMLInputElement | HTMLTextAreaElement | undefined
    if (!value) continue
    if (!el) {
      line.outcome = 'rejected'
      line.reason = 'The field disappeared after it was filled.'
      continue
    }
    const phone = line.key === 'phone'
    if (valueMatches(el, value, phone)) continue
    if (editedByUser(el)) {
      keepUserEdit(line, el)
      continue
    }
    setNativeValue(el, value, phone)
    rewritten.push({ line, el, value })
  }
  if (rewritten.length === 0 && reanswered.length === 0) return report

  // The one permitted rewrite counts only if it still holds a moment later.
  await sleep(doc, settleMs)
  if (pageUrl(doc).href !== report.url) return report
  for (const { line, el, value } of reanswered) {
    const at = rootOf.get(el) ?? root
    if (editedInGroup(el, kindOf(el), at)) {
      keepUserAnswer(line, el, at)
    } else if (el.isConnected && chosenOf(el, at) === value) {
      highlight(el, 'done')
    } else {
      line.outcome = 'rejected'
      line.reason = 'The page cleared the saved answer after filling; answer it yourself.'
      highlight(el, 'attention')
    }
  }
  for (const { line, el, value } of rewritten) {
    if (editedByUser(el)) {
      keepUserEdit(line, el)
    } else if (el.isConnected && valueMatches(el, value, line.key === 'phone')) {
      highlight(el, 'done')
    } else {
      line.outcome = 'rejected'
      line.reason =
        el.isConnected && el.value
          ? `The site changed it to "${el.value.slice(0, 80)}".`
          : 'The page cleared it after filling; fill it in.'
      highlight(el, 'attention')
    }
  }
  return report
}

/** What the site's upload widget shows for `key` after main attached `fileName`. */
export function uploadStateOf(doc: Document, key: UploadKey, fileName: string): UploadState {
  const kind = UPLOAD_KIND[key]
  const adapter = adapterFor(pageUrl(doc), doc)
  const probe: UploadProbe = {
    doc,
    kind: key,
    input: doc.querySelector<HTMLInputElement>(`input[${UPLOAD_ATTR}="${kind}"]`),
    group: doc.querySelector(`[${UPLOAD_GROUP_ATTR}="${kind}"]`),
    fileName
  }
  return (adapter.uploadAttached ?? defaultUploadAttached)(probe)
}

/** The adapter for the page as it is now (for the preload's waits). */
export function currentAdapter(doc: Document): Adapter {
  return adapterFor(pageUrl(doc), doc)
}

/** Picks at most this many answers per fill (each waits for its menu)… */
const MAX_PICKS = 25
/** …within this time, well inside main's 15 s wait for the fill; later ones stay suggestions. */
const PICK_BUDGET_MS = 8000

/**
 * Runs the picks a fill queued (#71): each widget's remembered answer is
 * chosen through pick.ts, which presses only inside that widget and reads the
 * choice back. Picked lines become `filled`; a widget that already shows
 * another answer is `kept`; a pick that did not stick goes to the user
 * (`rejected`, with the suggestion). Mutates and returns `report`.
 */
export async function pickAnswers(report: FillReport, picks: readonly PickRequest[] = pendingPicks(report)): Promise<FillReport> {
  const deadline = Date.now() + PICK_BUDGET_MS
  for (const req of picks.slice(0, MAX_PICKS)) {
    if (Date.now() > deadline) break
    const widget = req.el.isConnected ? widgetOf(req.el) : null
    if (!widget) continue
    const line = req.line
    const result = await pick(widget, (options) => resolveAnswer(req.fact, req.value, 'select', options))
    if (result.status === 'filled') {
      line.outcome = 'filled'
      line.value = result.value.slice(0, 200)
      line.reason = undefined
      line.suggestion = undefined
      line.suggestedBy = undefined
      highlight(widget.scope, 'done')
    } else if (result.status === 'kept') {
      line.outcome = 'kept'
      line.value = result.value.slice(0, 200)
      line.reason = 'Already answered; left as is.'
    } else {
      line.outcome = 'rejected'
      line.reason = `Huntgry could not pick "${(line.suggestion ?? '').slice(0, 80)}" (${result.reason.slice(0, 80)}); pick it yourself.`
      highlight(widget.scope, 'attention')
    }
  }
  return report
}
