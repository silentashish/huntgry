import type { FieldKind } from '../apply-types'
import { asHuntgry } from './user-edits'

/**
 * DOM helpers for the autofill engine. They run in the browser tab's preload
 * (an isolated world) and in jsdom for tests, so they never use globals such
 * as `HTMLInputElement`: constructors come from the element's own window.
 */

export type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

const TEXT_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'search'])
/** Inputs that are never a question (or must never be touched, like passwords). */
const IGNORED_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'password'])

const tag = (el: Element) => el.tagName.toLowerCase()

export function isControl(el: Element): el is FormControl {
  const t = tag(el)
  return t === 'input' || t === 'textarea' || t === 'select'
}

/** Bot traps: fields people never see, which only scripts fill (Workday's `beecatcher`). */
const HONEYPOT = /honey ?pot|beecatcher|bot[-_ ]?(trap|catcher)/i

/** Controls worth reporting: not hidden plumbing, not disabled, not a password, not a honeypot. */
export function isRelevant(el: FormControl): boolean {
  if (el.disabled) return false
  if (tag(el) === 'input' && IGNORED_TYPES.has((el as HTMLInputElement).type)) return false
  const names = [el.getAttribute('name'), el.id, el.getAttribute('data-automation-id'), el.getAttribute('class')]
  if (names.some((n) => n && HONEYPOT.test(n))) return false
  // react-select keeps an invisible `required` mirror input next to its combobox.
  if (el.getAttribute('aria-hidden') === 'true' && el.getAttribute('tabindex') === '-1') return false
  return true
}

export function kindOf(el: FormControl): FieldKind {
  const t = tag(el)
  if (t === 'select') return 'select'
  if (t === 'textarea') return 'textarea'
  const input = el as HTMLInputElement
  const type = input.type.toLowerCase()
  if (type === 'file') return 'file'
  if (type === 'checkbox') return 'checkbox'
  if (type === 'radio') return 'radio'
  if (input.getAttribute('role') === 'combobox' || input.getAttribute('aria-autocomplete') === 'list') return 'combobox'
  if (TEXT_TYPES.has(input.getAttribute('type')?.toLowerCase() ?? '')) return 'text'
  return 'other'
}

const clean = (text: string | null | undefined) => (text ?? '').replace(/[*✱]/g, ' ').replace(/\s+/g, ' ').trim()

function textOfIds(doc: Document, ids: string | null): string {
  if (!ids) return ''
  return ids
    .split(/\s+/)
    .map((id) => doc.getElementById(id)?.textContent ?? '')
    .join(' ')
}

/** A `<label>`'s own text: a wrapping label also contains the control (and a select's options), Lever its field box. */
function labelText(label: HTMLLabelElement): string {
  const copy = label.cloneNode(true) as Element
  for (const inner of Array.from(copy.querySelectorAll('select, textarea, input, button, .application-field')))
    inner.remove()
  return copy.textContent ?? ''
}

/** The raw label text (asterisks kept), used for both display and the required check. */
function rawLabel(el: FormControl): string {
  const doc = el.ownerDocument
  const kind = kindOf(el)
  // Greenhouse hides the file input behind "Attach"; the upload group names it ("Resume/CV").
  if (kind === 'file' || kind === 'radio') {
    const group = el.closest('[role="group"][aria-labelledby], [role="radiogroup"][aria-labelledby]')
    if (group) return textOfIds(doc, group.getAttribute('aria-labelledby'))
  }
  if (kind === 'radio') {
    const legend = el.closest('fieldset')?.querySelector('legend')?.textContent
    if (legend) return legend
    const question = el.closest('li.application-question, .application-question')?.querySelector('.application-label')
    if (question?.textContent) return question.textContent
  }
  const labelledBy = textOfIds(doc, el.getAttribute('aria-labelledby'))
  if (labelledBy.trim()) return labelledBy
  const aria = el.getAttribute('aria-label')
  if (aria?.trim()) return aria
  const labels = el.labels ? Array.from(el.labels) : []
  const fromLabel = labels.map(labelText).join(' ')
  if (fromLabel.trim()) return fromLabel
  return el.getAttribute('placeholder') ?? el.getAttribute('name') ?? el.id ?? ''
}

/** Human label of a control, e.g. "First Name" (asterisks and extra spaces removed, at most 160 chars). */
export function labelOf(el: FormControl): string {
  return clean(rawLabel(el)).slice(0, 160)
}

export function isRequired(el: FormControl): boolean {
  if ((el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true') return true
  if (el.closest('[role="group"][aria-required="true"]')) return true
  return /[*✱]/.test(rawLabel(el))
}

const digits = (s: string) => s.replace(/\D/g, '')

/** Whether the field shows `value` (phone numbers compare digits, since sites reformat them). */
export function valueMatches(el: FormControl, value: string, phone = false): boolean {
  const actual = el.value.trim()
  if (actual === value.trim()) return true
  return phone && digits(actual) !== '' && digits(actual) === digits(value)
}

/**
 * Writes `value` the way a person typing would look to the page's framework:
 * through the prototype's native setter (React keeps its own copy of the value
 * on the element, so `el.value = x` alone is ignored), then `input`, `change`
 * and a blur. Returns whether the field shows the value afterwards.
 */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string, phone = false): boolean {
  const view = el.ownerDocument.defaultView
  if (!view) return false
  const proto = tag(el) === 'textarea' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  asHuntgry(() => {
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new view.Event('input', { bubbles: true }))
    el.dispatchEvent(new view.Event('change', { bubbles: true }))
    el.dispatchEvent(new view.FocusEvent('blur'))
    el.dispatchEvent(new view.FocusEvent('focusout', { bubbles: true }))
  })
  return valueMatches(el, value, phone)
}

const OUTLINE = { done: '#2f9e44', attention: '#f08c00' } as const

/** Green outline for fields Huntgry filled, amber for fields that need the user. */
export function highlight(el: Element, tone: keyof typeof OUTLINE): void {
  const style = (el as HTMLElement).style
  if (!style) return
  style.setProperty('outline', `2px solid ${OUTLINE[tone]}`)
  style.setProperty('outline-offset', '1px')
}

/** The radios of `radio`'s group inside `root` (by `name`; a radio without one is its own group). */
export function radioGroup(radio: HTMLInputElement, root: ParentNode): HTMLInputElement[] {
  const name = radio.getAttribute('name')
  if (!name) return [radio]
  return Array.from(root.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter(
    (r) => r.getAttribute('name') === name && isRelevant(r)
  )
}

/** A radio's own option text ("Yes"), from its label without the control, else its value. */
export function radioLabel(radio: HTMLInputElement): string {
  const label = radio.labels?.[0] ?? radio.closest('label')
  const text = label ? clean(labelText(label as HTMLLabelElement)) : ''
  return (text || radio.value || '').slice(0, 120)
}

/** Placeholder options: no value, or "Select…", "Choose", "--". */
const PLACEHOLDER = /^(select|choose|please (select|choose)|pick|-+|—)\b|^\s*$/i

function isPlaceholder(option: HTMLOptionElement): boolean {
  return option.value === '' || PLACEHOLDER.test(option.text.trim())
}

/** The choices a select or radio group offers, as the page words them (at most 30, 120 characters each). */
export function optionsOf(el: FormControl, root: ParentNode): string[] {
  const kind = kindOf(el)
  let options: string[] = []
  if (kind === 'select') {
    options = Array.from((el as HTMLSelectElement).options)
      .filter((o) => !o.disabled && !isPlaceholder(o))
      .map((o) => clean(o.text).slice(0, 120))
  } else if (kind === 'radio') {
    options = radioGroup(el as HTMLInputElement, root).map(radioLabel)
  }
  return [...new Set(options.filter(Boolean))].slice(0, 30)
}

/** What a select or radio group shows now (the option text), or '' when nothing is chosen. */
export function chosenOf(el: FormControl, root: ParentNode): string {
  const kind = kindOf(el)
  if (kind === 'select') {
    const option = (el as HTMLSelectElement).selectedOptions?.[0]
    return option && !isPlaceholder(option) ? clean(option.text) : ''
  }
  if (kind === 'radio') {
    const checked = radioGroup(el as HTMLInputElement, root).find((r) => r.checked)
    return checked ? radioLabel(checked) : ''
  }
  return el.value.trim()
}

/**
 * Chooses the option whose text is `optionText` the way a person's choice
 * looks to the page's framework: the select's native `value` setter, then
 * `input` and `change`. No click, no key. Returns whether it shows the option.
 */
export function setSelectValue(select: HTMLSelectElement, optionText: string): boolean {
  const view = select.ownerDocument.defaultView
  const option = Array.from(select.options).find((o) => clean(o.text) === optionText)
  if (!view || !option) return false
  const setter = Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'value')?.set
  asHuntgry(() => {
    if (setter) setter.call(select, option.value)
    else select.value = option.value
    select.dispatchEvent(new view.Event('input', { bubbles: true }))
    select.dispatchEvent(new view.Event('change', { bubbles: true }))
  })
  return select.selectedOptions?.[0] === option
}

/**
 * Checks the radio of `radio`'s group whose label is `optionText`: the native
 * `checked` setter, then `input` and `change`. No click. Only for pages that
 * listen to `change` (plain HTML, Lever); React radios take a click and are
 * click-only (see answers.ts). Returns whether the radio is checked.
 */
export function checkRadio(radio: HTMLInputElement, root: ParentNode, optionText: string): boolean {
  const view = radio.ownerDocument.defaultView
  const target = radioGroup(radio, root).find((r) => radioLabel(r) === optionText)
  if (!view || !target) return false
  const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'checked')?.set
  asHuntgry(() => {
    if (setter) setter.call(target, true)
    else target.checked = true
    target.dispatchEvent(new view.Event('input', { bubbles: true }))
    target.dispatchEvent(new view.Event('change', { bubbles: true }))
  })
  return target.checked
}
