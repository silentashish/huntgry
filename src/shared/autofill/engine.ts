import { NO_ANSWERS, normalizeText, resolveAnswer, type PageAnswers } from '../apply-facts'
import type { AdapterStep, ApplyAts, FieldKey, FieldReport, FillProfile, FillReport, FillValues, PageScan, UploadState } from '../apply-types'
import { EMBED_RULES, embedPathMatches } from '../apply-embeds'
import { chooseLocationOption, chooseOption, locationParts, matchesOption, phoneCountryOf, type ChoiceKey } from '../geo'
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
  selectOptionTexts,
  setNativeValue,
  setSelectValue,
  valueMatches,
  type FormControl
} from './dom'
import { answerable, answerField, editedInGroup, strategyOf, writeAnswer, yesNoGroup, type PickRequest } from './answers'
import { isWorkdaySearchBox, pick, pickedValue, typeaheadOf, widgetOf, type PickWidget } from './pick'
import { matchChoiceField, matchFileField, matchTextField, type Match } from './match'
import { sleep } from './ready'
import { runSections, type SectionJob } from './sections'
import { defaultUploadAttached } from './upload-state'
import { editedByUser } from './user-edits'

/**
 * The autofill engine: pure DOM code, run by the browser tab's preload and by
 * jsdom in tests. It fills text fields and marks file inputs for main to
 * upload over CDP, and answers the questions the user taught it (#71,
 * answers.ts): typed fields, native selects and native radios, never a
 * checkbox. Address parts, country / state dropdowns, phone type and code,
 * and location typeaheads are filled from the profile (#136). Widgets that
 * need a click are queued for pick.ts (`pickAnswers`), the only module that
 * presses anything. It never submits a form or presses a flow button.
 * (guard.test.ts enforces the "never submits".)
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
  /**
   * A dropdown or typeahead filled from the profile (#136): the value it takes, whether it is typed and picked
   * (a typeahead) rather than opened, and what it is when the profile has no such value (a choice for the user).
   */
  choice?: ChoiceKey
  typeahead?: boolean
  fallback?: { outcome: FieldReport['outcome']; reason: string }
}

const FIELD_KEYS = new Set<string>(['location', 'addressLine1', 'city', 'state', 'postalCode', 'country'])
const asFieldKey = (key: ChoiceKey): FieldKey | null => (FIELD_KEYS.has(key) ? (key as FieldKey) : null)

/**
 * Whether a profile dropdown is typed and picked: a text input (Lever's
 * location), Workday's prompt search box, or a combobox asked for a place
 * (Greenhouse's react-select location, which loads its options as you type).
 */
function usesTypeahead(el: Element, key: ChoiceKey): boolean {
  if (el.tagName.toLowerCase() !== 'input') return false
  return kindOf(el as FormControl) === 'text' || isWorkdaySearchBox(el) || key === 'location' || key === 'city'
}

function choicePlanned(el: FormControl, key: ChoiceKey, reason: string, root?: Element): Planned {
  return {
    el,
    key: asFieldKey(key),
    score: 0,
    root,
    choice: key,
    typeahead: usesTypeahead(el, key),
    fallback: { outcome: 'skipped-unsupported', reason }
  }
}

/** The adapter's `valueChoices` found in `root`: element → the value it takes (the first selector wins). */
function valueChoicesOf(adapter: Adapter, root: Element): Map<Element, ChoiceKey> {
  const out = new Map<Element, ChoiceKey>()
  for (const [selector, key] of adapter.valueChoices ?? [])
    for (const el of Array.from(root.querySelectorAll(selector))) if (!out.has(el)) out.set(el, key)
  return out
}

/** The profile value a dropdown takes; '' when the profile has none (phone defaults need a phone number). */
export function choiceValueOf(key: ChoiceKey, values: FillValues): string {
  if (key === 'phoneType') return values.phone.trim() ? 'Mobile' : ''
  if (key === 'phoneCountryCode') return values.phone.trim() ? phoneCountryOf(values.country, values.phone) : ''
  if (key === 'location') return values.location.trim() || [values.city, values.state].filter((v) => v.trim()).join(', ')
  return values[key].trim()
}

/** Picks the option of `options` that is `value` (a place's suggestion list, or a dropdown's options). */
function chooserFor(key: ChoiceKey, value: string): (options: string[]) => string | null {
  if (key === 'location' || key === 'city') return (options) => chooseLocationOption(value, options)
  return (options) => chooseOption(key, value, options)
}

/** What a typeahead is searched with: the city for a location ("Portland"), else the value itself. */
function searchTextOf(key: ChoiceKey, value: string, values: FillValues): string {
  if (key === 'location') return values.city.trim() || locationParts(value).city || value
  return value
}

const MAX_FIELDS = 150

function pageUrl(doc: Document): URL {
  return new URL(doc.location?.href ?? doc.URL)
}

/** Whether a control is left out of the plan: never touched, or filled by sections.ts (#136). */
type Skip = (el: Element) => boolean

const NO_SKIP: Skip = () => false

/** The adapter's `excluded` controls and `sectionRoots` containers: the engine plans none of their controls. */
function skipOf(adapter: Adapter, doc: Document): Skip {
  const containers = [
    ...(adapter.excluded ?? []).flatMap((selector) => Array.from(doc.querySelectorAll(selector))),
    ...(adapter.sectionRoots?.(doc) ?? [])
  ]
  if (containers.length === 0) return NO_SKIP
  return (el) => containers.some((c) => c === el || c.contains(el))
}

/** Every relevant control of the form, radios collapsed to one per group (minus the skipped ones). */
function controlsOf(root: Element, skip: Skip = NO_SKIP): FormControl[] {
  const seenRadio = new Set<string>()
  const out: FormControl[] = []
  for (const el of Array.from(root.querySelectorAll('input, textarea, select'))) {
    if (!isControl(el) || !isRelevant(el) || skip(el)) continue
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
function listboxButtons(adapter: Adapter, root: Element, planned: Planned[], skip: Skip = NO_SKIP, answerOnly = false): Planned[] {
  const seen = new Set(planned.map((p) => p.el as Element))
  const valueChoices = answerOnly ? new Map<Element, ChoiceKey>() : valueChoicesOf(adapter, root)
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"]'))
    .filter((b) => !b.disabled && !seen.has(b) && !skip(b))
    .slice(0, 50)
    .map((b): Planned => {
      const el = b as unknown as FormControl
      // A country / state / phone dropdown takes the profile's value (#136); on an answer-only step, none does.
      const key = answerOnly ? undefined : (valueChoices.get(b) ?? matchChoiceField(el)?.key)
      if (key) return choicePlanned(el, key, 'A choice; pick it yourself.')
      return { el, key: null, score: 0, outcome: 'skipped-unsupported', reason: 'A choice; pick it yourself.' }
    })
}

/** Questions of the extra containers: only ever answered from memory, never matched to contact values. */
function answerOnlyPlanned(roots: Element[], skip: Skip = NO_SKIP): Planned[] {
  return roots.flatMap((root) =>
    controlsOf(root, skip)
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
function plan(adapter: Adapter, root: Element, skip: Skip = NO_SKIP): Planned[] {
  const controls = controlsOf(root, skip)
  const known = new Map<FormControl, FieldKey>()
  for (const [selector, key] of adapter.known) {
    const el = root.querySelector(selector)
    if (el && isControl(el) && isRelevant(el) && !skip(el) && !known.has(el)) known.set(el, key)
  }
  const claimedByAdapter = new Set(known.values())
  const choices = new Set<Element>()
  for (const selector of adapter.choices ?? []) for (const el of Array.from(root.querySelectorAll(selector))) choices.add(el)
  const valueChoices = valueChoicesOf(adapter, root)

  const planned: Planned[] = controls.map((el) => {
    const adapterKey = known.get(el)
    if (adapterKey) return { el, key: adapterKey, score: 10 }
    const kind = kindOf(el)
    const SUGGESTIONS = "Pick it from the site's suggestions."
    const valueChoice = valueChoices.get(el)
    if (valueChoice) return choicePlanned(el, valueChoice, choices.has(el) ? SUGGESTIONS : 'A choice; pick it yourself.')
    if (choices.has(el)) {
      return { el, key: null, score: 0, outcome: 'skipped-unsupported', reason: SUGGESTIONS }
    }
    if (kind === 'select' || kind === 'combobox') {
      // A country, state or city dropdown takes the profile's value (#136); any other choice is the user's.
      const match = matchChoiceField(el)
      if (match) return choicePlanned(el, match.key, 'A choice; pick it yourself.')
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
  // Dropdowns filled from the profile are not contenders: a location question and the site's location picker both get it.
  for (const p of planned) if (p.key && !p.outcome && !p.choice) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p])
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

/**
 * Everything the engine plans on the page: the form's controls (or, on an answer-only step, its questions only),
 * the adapter's extra answer containers and the dropdown buttons, minus the controls the adapter excludes or leaves
 * to sections.ts (#136). The same list, in the same order, for the fill, the verify pass and the step's fields.
 */
function planPage(adapter: Adapter, doc: Document, root: Element): { planned: Planned[]; extraRoots: Element[]; answerOnly: boolean } {
  const skip = skipOf(adapter, doc)
  const answerOnly = adapter.answerOnly?.(doc) === true
  const extraRoots = answerRootsOf(adapter, doc, root)
  const base = [...(answerOnly ? answerOnlyPlanned([root], skip) : plan(adapter, root, skip)), ...answerOnlyPlanned(extraRoots, skip)]
  return { planned: [...base, ...listboxButtons(adapter, root, base, skip, answerOnly)], extraRoots, answerOnly }
}

function hasSubmitButton(root: Element): boolean {
  return root.querySelector('button[type="submit"], input[type="submit"], button:not([type])') !== null
}

/** What kind of page this is: ATS, form present, confirmation page, bot-wall text for main to judge. */
export function scanPage(doc: Document): PageScan {
  const url = pageUrl(doc)
  const adapter = adapterFor(url, doc)
  const root = adapter.formRoot(doc)
  const skip = skipOf(adapter, doc)
  const controls = root ? controlsOf(root, skip) : []
  // An answer-only step (#136) counts as a form with any question, a dropdown button or a section to fill.
  const answerStep = root !== null && adapter.answerOnly?.(doc) === true && (adapter.step?.(doc) ?? 'form') === 'form'
  const questions =
    answerStep && (controls.length > 0 || root.querySelector('button[aria-haspopup="listbox"]') !== null || (adapter.sectionRoots?.(doc).length ?? 0) > 0)
  return {
    ats: adapter.ats,
    url: url.href,
    title: (doc.title ?? '').slice(0, 300),
    text: (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 3000),
    confirmation: adapter.isConfirmation(url, doc),
    formFound: controls.some((c) => kindOf(c) === 'text' || kindOf(c) === 'file') || questions,
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
  // Dropdown buttons count too (#136): Workday renders State only once a country is chosen.
  for (const p of planPage(adapter, root.ownerDocument, root).planned) if (p.key && !p.outcome) keys.add(p.key)
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
  /**
   * The profile's repeatable sections (#136): an adapter with `sectionRoots` (Workday My Experience) gets them
   * filled by `fillSections` after this synchronous fill. Without it those sections are left alone.
   */
  profile?: FillProfile
}

/** Picks a fill queued for `pickAnswers` (not part of the report sent to main). */
const PENDING_PICKS = new WeakMap<FillReport, PickRequest[]>()
/** The sections a fill queued for `fillSections` (#136). */
const PENDING_SECTIONS = new WeakMap<FillReport, SectionJob>()

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
 * A dropdown or typeahead with a profile value (#136). A native select is set
 * at once (its option chosen with `chooseOption`: "OR" for Oregon, "United
 * States of America" for USA); a widget that only takes a click is queued for
 * pick.ts (with `pick` on), or else left to the user with the value to
 * choose. A control that already shows another answer, or one the person
 * touched, is `kept`. Returns whether it wrote.
 */
function fillChoice(
  p: Planned,
  key: ChoiceKey,
  value: string,
  line: FieldReport,
  root: ParentNode,
  pickOn: boolean,
  picks: PickRequest[],
  values: FillValues
): boolean {
  const el = p.el
  const kind = kindOf(el)
  const choose = chooserFor(key, value)
  const fits = (shown: string) => choose([shown]) !== null || (key !== 'location' && key !== 'city' && matchesOption(key, value, shown))
  const keep = (shown: string, reason: string) => {
    line.outcome = 'kept'
    line.value = shown.slice(0, 200)
    line.reason = reason
  }
  if (kind === 'select') {
    const select = el as HTMLSelectElement
    const current = chosenOf(select, root)
    if (editedByUser(select)) {
      keep(current, 'You changed it; left as is.')
      return false
    }
    if (current) {
      if (!fits(current)) {
        keep(current, 'Already chosen; left as is.')
        return false
      }
      line.outcome = 'filled'
      line.value = current
      highlight(select, 'done')
      return true
    }
    const chosen = choose(selectOptionTexts(select))
    if (!chosen) {
      line.outcome = 'rejected'
      line.reason = `None of its options is "${value.slice(0, 80)}"; pick it yourself.`
      highlight(select, 'attention')
      return false
    }
    line.value = chosen
    if (setSelectValue(select, chosen)) {
      line.outcome = 'filled'
      highlight(select, 'done')
      return true
    }
    line.outcome = 'rejected'
    line.reason = 'The site did not take the choice; pick it yourself.'
    highlight(select, 'attention')
    return false
  }
  const widget: PickWidget | null = p.typeahead ? typeaheadOf(el) : widgetOf(el)
  if (!widget) {
    line.outcome = 'skipped-unsupported'
    line.reason = 'A choice; pick it yourself.'
    return false
  }
  const shown = pickedValue(widget)
  if (editedInGroup(el, kind, root)) {
    keep(shown, 'You changed it; left as is.')
    return false
  }
  if (shown) {
    if (!fits(shown)) {
      keep(shown, 'Already chosen; left as is.')
      return false
    }
    line.outcome = 'filled'
    line.value = shown.slice(0, 200)
    highlight(widget.scope, 'done')
    return true
  }
  line.outcome = 'skipped-unsupported'
  line.reason = `This picker takes a click: choose "${value.slice(0, 80)}" yourself.`
  if (pickOn) {
    picks.push({ el, root, line, fact: null, value, choose, search: p.typeahead ? searchTextOf(key, value, values) : undefined })
  }
  return false
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
  const { planned, extraRoots } = planPage(adapter, doc, root)
  const ids = fieldIdsOf(planned.map((p) => p.el))
  const clickOnly = clickOnlyOf(adapter, [root, ...extraRoots])
  const answers = options.answers ?? NO_ANSWERS
  const picks: PickRequest[] = []
  PENDING_PICKS.set(report, picks)
  if (writeText && adapter.sectionRoots) {
    PENDING_SECTIONS.set(report, { doc, report, profile: options.profile ?? null, answers, pick: options.pick === true, pageState: pageStateOf(doc) })
  }

  for (const candidate of planned) {
    const kind = kindOf(candidate.el)
    const choiceValue = candidate.choice ? choiceValueOf(candidate.choice, values) : ''
    // A profile dropdown without a profile value: a profile field is reported as missing from the profile (keeping
    // its key, so a multi-step flow counts it as handled); a phone default is a choice for the user again (and may
    // be answered from memory).
    const missing = candidate.choice && !choiceValue
    const p: Planned = !missing
      ? candidate
      : candidate.key
        ? { ...candidate, choice: undefined, outcome: 'skipped-no-value', reason: 'Not in your master profile; pick it yourself.' }
        : { ...candidate, choice: undefined, outcome: candidate.fallback?.outcome, reason: candidate.fallback?.reason }
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
      if (writeText && !(missing && p.key) && p.outcome !== 'ambiguous' && answerable(kind) && (kind !== 'checkbox' || yesNoGroup(p.el))) {
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
    if (p.choice) {
      line.fieldId = ids.get(p.el)
      if (fillChoice(p, p.choice, choiceValue, line, p.root ?? root, options.pick === true, picks, values)) first ??= p.el
      continue
    }
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
  // Picks run in page order (Workday: Country before the State list that depends on it), dropdown buttons included.
  picks.sort((a, b) => (a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1))
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

/**
 * A picked answer, checked again after the fill (hydration, a late re-render
 * or a resume parser may wipe it): still shown, fine; changed by the person,
 * kept; otherwise it goes to the user with the answer as a suggestion.
 */
function recheckPick(line: FieldReport, el: FormControl, root: ParentNode, typeahead = false): void {
  const value = line.value ?? ''
  const widget = el.isConnected ? (typeahead ? typeaheadOf(el) : widgetOf(el)) : null
  const shown = widget ? pickedValue(widget) : ''
  if (widget && normalizeText(shown) === normalizeText(value)) return
  if (widget && editedInGroup(el, kindOf(el), root)) {
    line.outcome = 'kept'
    line.value = shown.slice(0, 200)
    line.reason = 'You changed it after Huntgry picked it; left as is.'
    return
  }
  line.outcome = 'rejected'
  line.suggestion = value
  line.suggestedBy = 'saved'
  line.reason = widget
    ? `The page cleared the picked answer "${value.slice(0, 80)}"; pick it yourself.`
    : 'The field disappeared after Huntgry picked it.'
  if (widget) highlight(widget.scope, 'attention')
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
  // The same list (and so the same field ids) as the fill, Workday dropdown buttons included.
  const { planned, extraRoots } = planPage(adapter, doc, root)
  const clickOnly = clickOnlyOf(adapter, [root, ...extraRoots])
  const typeaheads = new Set(planned.filter((p) => p.typeahead).map((p) => p.el))
  const byKey = new Map<FieldKey, FormControl>()
  for (const p of planned) if (p.key && !p.outcome && !p.choice && !byKey.has(p.key)) byKey.set(p.key, p.el)
  const byId = new Map([...fieldIdsOf(planned.map((p) => p.el))].map(([el, id]) => [id, el]))
  const rootOf = new Map(planned.map((p) => [p.el, p.root ?? root]))

  const rewritten: Array<{ line: FieldReport; el: HTMLInputElement | HTMLTextAreaElement; value: string }> = []
  const reanswered: Array<{ line: FieldReport; el: FormControl; value: string }> = []
  for (const line of report.fields) {
    // A remembered answer Huntgry wrote (#71), or a profile dropdown it chose (#136; only those lines carry both a
    // key and a field id): the same check, keyed by the control's id.
    if (line.outcome === 'filled' && line.fieldId && line.value) {
      const el = byId.get(line.fieldId)
      // A picked widget: read it again from the page as it is now; never pressed again here.
      const typed = el ? typeaheads.has(el) || isWorkdaySearchBox(el) : false
      if (el && (typed || yesNoGroup(el) || ['click-only', 'never'].includes(strategyOf(kindOf(el), clickOnly.has(el))))) {
        recheckPick(line, el, rootOf.get(el) ?? root, typed)
        continue
      }
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

/** The page and step as the adapter sees them: a press that moves the page on stops the presses (pick.ts's safety net). */
export function pageStateOf(doc: Document): () => string {
  return () => {
    const adapter = currentAdapter(doc)
    return `${doc.location?.href ?? doc.URL}|${adapter.stepTitle?.(doc) ?? ''}|${adapter.step?.(doc) ?? 'form'}`
  }
}

/**
 * Fills the repeatable sections a fill queued (#136, Workday My Experience: blocks added with the section's Add
 * button and filled from the profile, skills picked; and the answer-only steps' date questions and disability check
 * boxes). Runs before `pickAnswers`; its lines are appended to the report. Mutates and returns `report`.
 */
export async function fillSections(report: FillReport): Promise<FillReport> {
  const job = PENDING_SECTIONS.get(report)
  if (!job) return report
  PENDING_SECTIONS.delete(report)
  report.fields.push(...(await runSections(job)))
  return report
}

/** Picks at most this many answers per fill (each waits for its menu)… */
const MAX_PICKS = 25
/**
 * …within this time; later ones stay suggestions. Each pick's waits are capped to what is left, so with the
 * session's readiness wait (≤ 3 s), the verify delay (1 s) and the settle (0.3 s) a fill stays under main's 15 s.
 */
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
    const left = deadline - Date.now()
    if (left <= 0) break
    const doc = req.el.ownerDocument
    // The page and step as the adapter sees them: if a pick moves the page on, the safety net stops picking.
    const pageState = pageStateOf(doc)
    const typeahead = req.search !== undefined
    const widget = req.el.isConnected ? (typeahead ? typeaheadOf(req.el) : widgetOf(req.el)) : null
    if (!widget) continue
    const line = req.line
    const choose = req.choose ?? ((options: string[]) => resolveAnswer(req.fact, req.value, 'select', options))
    const result = await pick(widget, choose, {
      // A pick waits twice (menu, read-back), a typeahead three times (suggestions, after Enter, read-back): each wait
      // gets at most its share of what is left, so the budget is a hard limit.
      timeoutMs: Math.min(1500, Math.max(100, Math.floor(left / (typeahead ? 3 : 2)))),
      touched: () => editedInGroup(req.el, kindOf(req.el), req.root),
      pageState,
      search: req.search
    })
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
      line.reason = `Huntgry could not pick "${(line.suggestion ?? req.value).slice(0, 80)}" (${result.reason.slice(0, 120)}); pick it yourself.`
      highlight(widget.scope, 'attention')
      // The safety net caught the page acting outside the field: no more picks in this fill.
      if (result.halt) break
    }
  }
  return report
}
