import { isConsentQuestion, matchFact, questionKey, resolveAnswer, type FactKey, type PageAnswers } from '../apply-facts'
import type { FieldKind, FieldReport } from '../apply-types'
import {
  checkRadio,
  chosenOf,
  highlight,
  kindOf,
  optionsOf,
  radioGroup,
  setNativeValue,
  setSelectValue,
  type FormControl
} from './dom'
import { widgetOf } from './pick'
import { editedByUser } from './user-edits'

/**
 * Application answers in the page (#71): questions the contact matcher left
 * alone (screening, EEO, salary, notice period…) are answered from the
 * remembered facts and question memory main sends with each fill.
 *
 * What may be written, and how, is decided in one place: `strategyOf`.
 * - typed fields: the native value setter (as for contact fields);
 * - native `<select>`: its native value setter, then `input` / `change`;
 * - native radios on pages that listen to `change`: the `checked` setter;
 * - checkboxes: never (consent, certification, acknowledgements);
 * - widgets that only take a click (react-select comboboxes, Workday dropdown
 *   buttons, an adapter's `clickOnly` / `choices`, e.g. Ashby's React radios,
 *   and yes/no button groups): `ClickOnlyPolicy`. `pick` queues a
 *   `PickRequest` for pick.ts, the one module allowed to press anything;
 *   `suggest` shows the remembered answer in the panel for the user to pick.
 */

/**
 * What happens to a widget that only takes a click. The owner decided on
 * 2026-10-06 that Huntgry picks remembered answers there (pick.ts), behind the
 * Settings switch "Pick dropdown answers automatically" (on by default), which
 * main sends with every fill as `pick`. Off, or when the answer is not trusted
 * (a model's mapping the user has not confirmed), it only suggests.
 */
export type ClickOnlyPolicy = 'suggest' | 'pick'

/** An answer to pick after the synchronous fill (the engine's `pickAnswers` runs them). */
export interface PickRequest {
  el: FormControl
  /** The container the control was found in (radio groups are looked up there). */
  root: ParentNode
  line: FieldReport
  fact: FactKey | null
  value: string
}

export type WriteStrategy = 'text' | 'select' | 'radio' | 'click-only' | 'never'

/** How a control of `kind` can be answered; `clickOnly` when the adapter says its framework needs a click. */
export function strategyOf(kind: FieldKind, clickOnly: boolean): WriteStrategy {
  if (kind === 'checkbox' || kind === 'file' || kind === 'other') return 'never'
  if (clickOnly || kind === 'combobox') return 'click-only'
  if (kind === 'select') return 'select'
  if (kind === 'radio') return 'radio'
  return 'text'
}

/** What the memory says about a question: the fact, the answer and whether it may be written. */
export interface Lookup {
  fact?: FactKey
  value?: string
  confirmed: boolean
}

export function lookup(answers: PageAnswers, question: string, label: string): Lookup {
  const q = answers.questions[question]
  if (q) {
    const fact = q.fact ?? undefined
    // The exact option the user confirmed for this very question wins over the fact (which may fit several options).
    return { fact, value: q.value ?? q.option ?? (fact ? answers.facts[fact] : undefined), confirmed: q.confirmed }
  }
  const fact = matchFact(label)
  // A catalog match is trusted like a confirmation: the fact's value is the user's own.
  return fact ? { fact, value: answers.facts[fact], confirmed: true } : { confirmed: false }
}

/** Kinds a question can be answered for at all (files are uploads; `other` is dates, numbers…). */
export const answerable = (kind: FieldKind) => kind !== 'file' && kind !== 'other'

/** Whether a choice is unanswered (or a typed field empty). */
function isEmpty(el: FormControl, kind: FieldKind, root: ParentNode): boolean {
  return chosenOf(el, root) === '' && !(kind === 'text' || kind === 'textarea' ? el.value.trim() : '')
}

/** Whether the person changed the control (any radio of its group) since Huntgry watched the page. */
export function editedInGroup(el: FormControl, kind: FieldKind, root: ParentNode): boolean {
  if (kind !== 'radio') return editedByUser(el)
  return radioGroup(el as HTMLInputElement, root).some(editedByUser)
}

/** Writes `answer` with `strategy`; returns whether the page shows it afterwards. */
export function writeAnswer(el: FormControl, strategy: WriteStrategy, root: ParentNode, answer: string): boolean {
  if (strategy === 'text') return setNativeValue(el as HTMLInputElement | HTMLTextAreaElement, answer)
  if (strategy === 'select') return setSelectValue(el as HTMLSelectElement, answer)
  if (strategy === 'radio') return checkRadio(el as HTMLInputElement, root, answer)
  return false
}

/**
 * Answers one reported question in place: fills `line` with the question's
 * key, options and fact, then writes the remembered answer when it is
 * confirmed, fits one of the options and the control is still empty and
 * untouched. Otherwise the answer is only a `suggestion`. Returns whether it
 * wrote.
 */
/** The option texts of a yes/no button group around a hidden checkbox (Ashby), or null for any other checkbox. */
export function yesNoGroup(el: FormControl): string[] | null {
  if (kindOf(el) !== 'checkbox') return null
  const widget = widgetOf(el)
  return widget?.type === 'buttons' ? widget.options.map((b) => (b.textContent ?? '').trim()).filter(Boolean) : null
}

export function answerField(
  el: FormControl,
  line: FieldReport,
  root: ParentNode,
  answers: PageAnswers,
  clickOnly: boolean,
  policy: ClickOnlyPolicy = 'suggest',
  picks: PickRequest[] = []
): boolean {
  // Consent, certification and acknowledgement are never answered from memory, by any strategy (#71 review).
  if (isConsentQuestion(line.label)) return false
  // A yes/no button group is a single choice whose options are its buttons, reported as a radio question.
  const buttons = yesNoGroup(el)
  if (buttons) line.kind = 'radio'
  const kind = buttons ? 'radio' : kindOf(el)
  const strategy = buttons ? 'click-only' : strategyOf(kind, clickOnly)
  if (strategy === 'never') return false
  const options = buttons ?? (kind === 'select' || kind === 'radio' ? optionsOf(el, root) : [])
  // Options that read like consent ("I agree", "I accept"): the whole question is consent, never answered.
  if (options.some(isConsentQuestion)) return false
  line.question = questionKey(line.label, kind, options)
  if (options.length) line.options = options
  const found = lookup(answers, line.question, line.label)
  if (found.fact) line.fact = found.fact
  if (!found.value) {
    if (found.fact || answers.questions[line.question]) line.reason = 'Answer it once below; Huntgry remembers it.'
    return false
  }
  const answer = resolveAnswer(found.fact ?? null, found.value, kind, options)
  if (!answer) {
    line.reason = "Your saved answer is not one of this question's options; pick it yourself."
    return false
  }
  if (!found.confirmed) {
    line.suggestion = answer
    line.suggestedBy = 'model'
    line.reason = 'Suggested from your saved answers; confirm it below.'
    return false
  }
  if (strategy === 'click-only') {
    // Shown as a suggestion; with the `pick` policy, pick.ts then tries to choose it and replaces this line.
    line.suggestion = answer
    line.suggestedBy = 'saved'
    line.reason = `This picker takes a click: choose "${answer.slice(0, 80)}" yourself.`
    if (policy !== 'pick') return false
    // A control the person touched, or a combobox they are typing into, is theirs (checked again before the press).
    const typed = kind === 'combobox' && el.value.trim() !== ''
    if (editedInGroup(el, kind, root) || typed) {
      line.outcome = 'kept'
      line.value = (typed ? el.value.trim() : chosenOf(el, root)).slice(0, 200)
      line.reason = 'You changed it; left as is.'
      return false
    }
    picks.push({ el, root, line, fact: found.fact ?? null, value: found.value })
    return false
  }
  const shown = chosenOf(el, root)
  if (shown === answer) {
    line.outcome = 'filled'
    line.value = answer
    line.reason = undefined
    highlight(el, 'done')
    return false
  }
  if (!isEmpty(el, kind, root) || editedInGroup(el, kind, root)) {
    line.outcome = 'kept'
    line.value = shown.slice(0, 200)
    line.reason = 'Already answered; left as is.'
    return false
  }
  const ok = writeAnswer(el, strategy, root, answer)
  line.value = answer
  if (ok) {
    line.outcome = 'filled'
    line.reason = undefined
    highlight(el, 'done')
  } else {
    line.outcome = 'rejected'
    line.reason = 'The site did not take the saved answer; answer it yourself.'
    highlight(el, 'attention')
  }
  return ok
}
