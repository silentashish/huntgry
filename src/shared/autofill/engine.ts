import type { FieldKey, FieldReport, FillReport, FillValues, PageScan } from '../apply-types'
import { EMBED_RULES, embedRuleFor } from '../apply-embeds'
import { adapterFor, type Adapter } from './adapters'
import { UPLOAD_ATTR } from '../autofill-channels'
import {
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
import { matchFileField, matchTextField, type Match } from './match'

/**
 * The autofill engine: pure DOM code, run by the browser tab's preload and by
 * jsdom in tests. It fills text fields and marks file inputs for main to
 * upload over CDP. It never submits a form, presses a button or answers a
 * choice: selects, comboboxes, checkboxes, radios, consent and demographic
 * questions are only reported. (guard.test.ts enforces the "never submits".)
 */

/** Upload marker values: `data-huntgry-upload="resume" | "cover"`. */
export const UPLOAD_KIND = { resume: 'resume', coverLetter: 'cover' } as const

interface Planned {
  el: FormControl
  key: FieldKey | null
  score: number
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

/** Decides what each control gets: adapter fields first, then the generic matcher, one field per key. */
function plan(adapter: Adapter, root: Element): Planned[] {
  const controls = controlsOf(root)
  const known = new Map<FormControl, FieldKey>()
  for (const [selector, key] of adapter.known) {
    const el = root.querySelector(selector)
    if (el && isControl(el) && isRelevant(el) && !known.has(el)) known.set(el, key)
  }
  const claimedByAdapter = new Set(known.values())

  const planned: Planned[] = controls.map((el) => {
    const adapterKey = known.get(el)
    if (adapterKey) return { el, key: adapterKey, score: 10 }
    const kind = kindOf(el)
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
    step: adapter.step?.(doc) ?? 'form',
    stepTitle: adapter.stepTitle?.(doc)?.trim().slice(0, 120) || null
  }
}

/** The first iframe on the page that holds an ATS's embedded form (see apply-embeds.ts). */
function embedUrlOf(doc: Document, base: URL): string | null {
  for (const rule of EMBED_RULES) {
    for (const iframe of Array.from(doc.querySelectorAll(rule.iframe))) {
      const src = iframe.getAttribute('src')
      if (!src) continue
      try {
        const absolute = new URL(src, base).href
        if (embedRuleFor(absolute) === rule) return absolute
      } catch {
        // Not a URL; try the next iframe.
      }
    }
  }
  return null
}

/** Whether the page is the site's "application submitted" page. */
export function detectConfirmation(doc: Document): boolean {
  const url = pageUrl(doc)
  return adapterFor(url, doc).isConfirmation(url, doc)
}

/**
 * Fills the form's text fields that are empty (a value the user typed is
 * kept), reads each one back, marks the file inputs for upload and outlines
 * what it did. Returns one report line per field.
 */
export function fillPage(doc: Document, values: FillValues): FillReport {
  const url = pageUrl(doc)
  const adapter = adapterFor(url, doc)
  const root = adapter.formRoot(doc)
  const report: FillReport = { ats: adapter.ats, url: url.href, fields: [], hasSubmitButton: false }
  if (!root) return report
  report.hasSubmitButton = hasSubmitButton(root)
  for (const old of Array.from(doc.querySelectorAll(`[${UPLOAD_ATTR}]`))) old.removeAttribute(UPLOAD_ATTR)

  for (const p of plan(adapter, root)) {
    const kind = kindOf(p.el)
    const line: FieldReport = {
      key: p.key,
      label: labelOf(p.el),
      kind,
      required: isRequired(p.el),
      outcome: 'unmatched'
    }
    report.fields.push(line)
    if (p.outcome) {
      line.outcome = p.outcome
      line.reason = p.reason
      if (p.outcome !== 'skipped-unsupported') highlight(p.el, 'attention')
      continue
    }
    if (p.key === 'resume' || p.key === 'coverLetter') {
      p.el.setAttribute(UPLOAD_ATTR, UPLOAD_KIND[p.key])
      line.outcome = 'to-upload'
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
    } else {
      line.outcome = 'rejected'
      line.reason = el.value ? `The site changed it to "${el.value.slice(0, 80)}".` : 'The site cleared it.'
      highlight(el, 'attention')
    }
  }
  return report
}
