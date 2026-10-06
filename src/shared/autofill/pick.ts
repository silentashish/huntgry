import { normalizeText } from '../apply-facts'
import { radioGroup, radioLabel } from './dom'
import { waitUntil } from './ready'
import { asHuntgry } from './user-edits'

/**
 * Picking an option in a widget that only takes a click (#71, owner decision
 * of 2026-10-06): a react-select combobox (Greenhouse), a yes/no button group
 * or React radios (Ashby), a dropdown button with a listbox (Workday).
 *
 * This is the ONLY module in Huntgry that dispatches synthetic pointer or
 * mouse events (guard.test.ts allowlists exactly this file for them, and still
 * forbids keyboard and submit events here). Every press goes through `press`,
 * which first checks the target with `refusal`:
 * - it must be inside the field's own widget: its control, its button group
 *   or radio group, or a listbox the control demonstrably owns (named by its
 *   `aria-controls` / `aria-owns`, inside the widget, or naming the control
 *   in `aria-labelledby`); an untied popup is never used;
 * - nothing the press reaches or activates may be a link, a submit / image /
 *   reset control, a button that would submit its form, a checkbox, a label
 *   for a control outside the widget (or for a checkbox or button), a button
 *   enclosing the widget, a disabled element, or anything labelled Submit /
 *   Apply / Next / Continue / Save / Review (the target and every wrapper it
 *   bubbles through inside the widget);
 * - the check runs again before every event of a press, so a page handler
 *   that turns the target into a submit button mid-sequence stops it;
 * - a widget whose options read like consent (agree, accept, certify…) is
 *   never picked in;
 * - and every pick runs inside `withSafetyNet`, which cancels any submit and
 *   any click outside the widget while it runs, puts back outside checkboxes
 *   and stops picking when the page changes step.
 * Only pointer and mouse events are sent (pointerdown, mousedown, pointerup,
 * mouseup, click); never a key, so nothing can press Enter in a form. The
 * value is read back afterwards; a pick that did not stick is reported.
 */

export type PickWidget =
  | { type: 'listbox'; scope: Element; opener: HTMLElement }
  | { type: 'buttons'; scope: Element; options: HTMLElement[] }
  | { type: 'radios'; scope: Element; options: HTMLInputElement[] }

export type PickResult =
  | { status: 'filled'; value: string }
  | { status: 'kept'; value: string }
  /** `halt`: the safety net caught the page acting outside the field; no more picks in this fill. */
  | { status: 'failed'; reason: string; halt?: boolean }

const tag = (el: Element) => el.tagName.toLowerCase()
const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()
/** "Select…", "Select One", "Choose": nothing chosen yet. */
const PLACEHOLDER = /^(select|choose|pick)( one| an option)?\b|^\s*$/i
/** Labels of the site's own flow buttons: never pressed, whatever widget they sit in. */
const FLOW_WORDS = /\b(submit|apply|next|continue|save|review)\b/i
/** Options that read like consent: such a widget is never picked in, whatever was remembered. */
const CONSENT_OPTION = /\b(consent\w*|certif\w*|agree\w*|acknowledg\w*|accept\w*|authori[sz]e|opt[ -]?in|subscribe)\b/i

/** Elements a page uses to submit or leave: never inside a widget we press. */
const CONTROLS_OUTSIDE = 'input:not([type="hidden"]), select, textarea'

/**
 * The smallest container that holds `el` and nothing else the user fills: it
 * stops before an ancestor with another field, a link or a submit control.
 */
function ownScope(el: Element, maxDepth = 6): Element {
  let scope: Element = el.parentElement ?? el
  for (let i = 0; i < maxDepth; i++) {
    const up = scope.parentElement
    if (!up || tag(up) === 'form' || tag(up) === 'body') break
    const others = Array.from(up.querySelectorAll(CONTROLS_OUTSIDE)).filter(
      (c) => c !== el && !(c.getAttribute('aria-hidden') === 'true' && c.getAttribute('tabindex') === '-1')
    )
    if (others.length > 0 || up.querySelector('a[href], [type="submit"]')) break
    scope = up
  }
  return scope
}

/** The click-only widget `el` belongs to, or null when Huntgry does not know how to pick in it. */
export function widgetOf(el: Element): PickWidget | null {
  const t = tag(el)
  if (t === 'input' && el.getAttribute('role') === 'combobox') {
    const scope = el.closest('[class*="select__container"], [class*="SelectContainer"]') ?? ownScope(el)
    return { type: 'listbox', scope, opener: el as HTMLElement }
  }
  if (t === 'button' && el.getAttribute('aria-haspopup') === 'listbox') {
    const scope = el.closest('[data-automation-id^="formField-"]') ?? el.parentElement ?? el
    return { type: 'listbox', scope, opener: el as HTMLElement }
  }
  const input = el as HTMLInputElement
  if (t === 'input' && input.type === 'checkbox') {
    // Only Ashby's yes/no screening widget: a hidden (tabindex -1) checkbox in a `yesno` group of exactly a Yes and a
    // No button. Any other checkbox (consent, certification) is never a question Huntgry answers.
    const scope = el.closest('[class*="yesno"]')
    if (!scope || el.getAttribute('tabindex') !== '-1') return null
    const options = Array.from(scope.querySelectorAll<HTMLElement>('button'))
    const words = options.map((b) => (b.getAttribute('data-option') ?? text(b)).toLowerCase())
    return options.length === 2 && words[0] === 'yes' && words[1] === 'no' ? { type: 'buttons', scope, options } : null
  }
  if (t === 'input' && input.type === 'radio') {
    const scope = el.closest('fieldset, [role="radiogroup"]') ?? ownScope(el)
    return { type: 'radios', scope, options: radioGroup(input, scope) }
  }
  return null
}

/**
 * Listboxes that demonstrably belong to the widget's control: named by its `aria-controls` / `aria-owns`, inside the
 * widget, or naming the control in their `aria-labelledby`. A listbox with no such tie is never used, however it
 * appeared: the pick then fails and stays a suggestion.
 */
export function ownListboxes(widget: Extract<PickWidget, { type: 'listbox' }>): Element[] {
  const doc = widget.opener.ownerDocument
  const ids = `${widget.opener.getAttribute('aria-controls') ?? ''} ${widget.opener.getAttribute('aria-owns') ?? ''}`
    .split(/\s+/)
    .filter(Boolean)
  const candidates = new Set<Element>()
  for (const id of ids) {
    const box = doc.getElementById(id)
    if (box) candidates.add(box)
  }
  for (const box of Array.from(widget.scope.querySelectorAll('[role="listbox"], [class*="__menu"]'))) candidates.add(box)
  if (widget.opener.id) {
    for (const box of Array.from(doc.querySelectorAll('[role="listbox"]')))
      if (idsOf(box, 'aria-labelledby').includes(widget.opener.id)) candidates.add(box)
  }
  return [...candidates].filter((box) => isOwnListbox(box, widget))
}

const idsOf = (el: Element, attr: string) => (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)

/** Controls that open a list of their own: another field's widget, never part of this one. */
const OTHER_OPENERS = '[role="combobox"], [aria-haspopup="listbox"], select'

/**
 * A referenced or contained element is this field's list only when it is a
 * list (role=listbox, or react-select's menu inside the widget), does not
 * name another control as its owner, and holds no other field's opener or
 * list: a broad region (a panel with other fields) is never a listbox.
 */
function isOwnListbox(box: Element, widget: Extract<PickWidget, { type: 'listbox' }>): boolean {
  const isList = box.getAttribute('role') === 'listbox' || (widget.scope.contains(box) && /__menu\b/.test(box.className))
  if (!isList) return false
  const doc = box.ownerDocument
  const owners = idsOf(box, 'aria-labelledby')
    .map((id) => doc.getElementById(id))
    .filter((el): el is HTMLElement => el !== null && el.matches(OTHER_OPENERS))
  if (owners.some((el) => el !== widget.opener)) return false
  if (Array.from(box.querySelectorAll(OTHER_OPENERS)).some((el) => el !== widget.opener)) return false
  // A list inside the list (another widget's) is not ours either.
  if (box.querySelector('[role="listbox"]')) return false
  return true
}

/** The options of the widget's own listboxes (role=option, or react-select's option class), not of nested lists. */
function listboxOptions(boxes: Element[]): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const box of boxes) {
    const options = box.querySelectorAll<HTMLElement>('[role="option"], [class*="__option"]')
    for (const o of Array.from(options)) {
      const list = o.closest('[role="listbox"]')
      if (list && list !== box) continue
      if (!out.includes(o) && o.getAttribute('aria-disabled') !== 'true') out.push(o)
    }
  }
  return out
}

/** Input types whose activation submits, resets, uploads or ticks: never pressed, nor a label pointing at one. */
const NEVER_ACTIVATED = new Set(['submit', 'image', 'reset', 'button', 'file', 'checkbox'])

/**
 * Why `target` must not be pressed for `widget`, or null when it may be.
 * `listboxes` are the widget's own listboxes (listbox widgets, once open).
 * It checks everything the press can reach or activate: the target, every
 * ancestor the events bubble through (a click inside a button activates the
 * button, a click on a label activates its control), and labels' controls.
 */
export function refusal(target: Element, widget: PickWidget, listboxes: readonly Element[] = []): string | null {
  if (!target.isConnected) return 'something no longer on the page'
  const within = (node: Element) => widget.scope.contains(node) || listboxes.some((box) => box.contains(node))
  if (!within(target)) return 'outside the field’s widget'
  let inWidget = true
  for (let el: Element | null = target; el && tag(el) !== 'body'; el = el.parentElement) {
    const why = inWidget ? elementRefusal(el, el === target, widget, within) : enclosingRefusal(el, within)
    if (why) return why
    if (el === widget.scope || listboxes.includes(el)) inWidget = false
  }
  return null
}

/** An element on the path inside the widget (the target, its option, button or label wrappers). */
function elementRefusal(el: Element, isTarget: boolean, widget: PickWidget, within: (node: Element) => boolean): string | null {
  const t = tag(el)
  if (t === 'a' && el.hasAttribute('href')) return 'a link'
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return 'something disabled'
  const type = (el.getAttribute('type') ?? '').toLowerCase()
  if (type === 'submit' || type === 'image' || type === 'reset') return 'a submit control'
  if (t === 'button' && (el as HTMLButtonElement).type === 'submit' && (el as HTMLButtonElement).form) return 'a button that would submit the form'
  if (t === 'input' && NEVER_ACTIVATED.has((el as HTMLInputElement).type)) return 'a checkbox or button input'
  if (t === 'label') {
    const why = labelRefusal(el as HTMLLabelElement, within)
    if (why) return why
  }
  // What a person reads as this element's name. A combobox input is named by its question (which may say
  // "continue"), so the opener counts only its shown text; everything else its label, title, value and text.
  const opener = widget.type === 'listbox' && el === widget.opener
  const named = isTarget || t === 'button' || t === 'label' || ['button', 'option', 'menuitem', 'link'].includes(el.getAttribute('role') ?? '')
  const labelledBy = idsOf(el, 'aria-labelledby')
    .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ')
  const words = opener
    ? t === 'button'
      ? `${text(el)} ${labelledBy}`
      : ''
    : `${el.getAttribute('aria-label') ?? ''} ${labelledBy} ${el.getAttribute('title') ?? ''} ${el.getAttribute('value') ?? ''} ${named ? text(el) : ''}`
  if (FLOW_WORDS.test(words.slice(0, 400))) return 'something labelled like a submit or navigation button'
  return null
}

/** An ancestor around the whole widget: the press bubbles there, so it must not be anything a click activates. */
function enclosingRefusal(el: Element, within: (node: Element) => boolean): string | null {
  const t = tag(el)
  if (t === 'a' && el.hasAttribute('href')) return 'something inside a link'
  if (t === 'button' || t === 'input' || el.getAttribute('role') === 'button') return 'something inside a button'
  if (t === 'label') return labelRefusal(el as HTMLLabelElement, within)
  return null
}

/** A label activates its control: only a control of this widget that is not a checkbox, button or upload. */
function labelRefusal(label: HTMLLabelElement, within: (node: Element) => boolean): string | null {
  const control = label.control
  if (!control) return null
  if (!within(control)) return 'a label for a control outside the widget'
  if (tag(control) === 'button' || NEVER_ACTIVATED.has((control as HTMLInputElement).type)) return 'a label for a checkbox or button'
  return null
}

/**
 * Presses `target` with pointer and mouse events only. `refusal` is checked
 * again before every event: a page handler may change the target during the
 * sequence (make it a submit button, move it, disable it), and the sequence
 * stops there.
 */
function press(target: HTMLElement, widget: PickWidget, listboxes: () => readonly Element[] = () => []): void {
  const view = target.ownerDocument.defaultView
  if (!view) throw new Error('The page has no window.')
  const init = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, view }
  const up = { ...init, buttons: 0 }
  const Pointer = view.PointerEvent ?? view.MouseEvent
  const events: Array<() => Event> = [
    () => new Pointer('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true } as PointerEventInit),
    () => new view.MouseEvent('mousedown', init),
    () => new Pointer('pointerup', { ...up, pointerType: 'mouse', isPrimary: true } as PointerEventInit),
    () => new view.MouseEvent('mouseup', up),
    () => new view.MouseEvent('click', up)
  ]
  asHuntgry(() => {
    for (const make of events) {
      const refused = refusal(target, widget, listboxes())
      if (refused) throw new Error(`Huntgry does not press ${refused}.`)
      target.dispatchEvent(make())
    }
  })
}

/** What the widget shows as chosen now ('' when nothing). */
export function pickedValue(widget: PickWidget): string {
  if (widget.type === 'radios') {
    const checked = widget.options.find((r) => r.checked)
    return checked ? radioLabel(checked) : ''
  }
  if (widget.type === 'buttons') {
    const pressed = widget.options.find((b) => b.getAttribute('aria-pressed') === 'true' || /\b(active|selected)\b/i.test(b.className))
    return pressed ? text(pressed) : ''
  }
  const single = widget.scope.querySelector('[class*="single-value"], [class*="singleValue"]')
  if (single) return text(single)
  // Text typed into the combobox (a search in progress) is the user's: it counts as an answer to keep.
  if (tag(widget.opener) === 'input') return (widget.opener as HTMLInputElement).value.trim()
  if (tag(widget.opener) === 'button') {
    const shown = text(widget.opener)
    return PLACEHOLDER.test(shown) ? '' : shown
  }
  return ''
}

const same = (a: string, b: string) => normalizeText(a) === normalizeText(b)

/** Closes a menu left open without a key: the control loses focus (react-select and Workday close on blur). */
function closeMenu(widget: PickWidget): void {
  const doc = widget.scope.ownerDocument
  const active = doc.activeElement as HTMLElement | null
  if (active && widget.scope.contains(active)) active.blur?.()
}

export interface PickOptions {
  /** How long the menu may take to render, and the choice to show. */
  timeoutMs?: number
  /** Whether the person changed the field: checked before every press (also after the menu wait); then kept. */
  touched?: () => boolean
  /** The page and step the pick happens on (default: URL and first heading); a change stops picking. */
  pageState?: () => string
}

/** Events a press could turn into an action elsewhere: blocked outside the widget while a pick runs. */
const NET_POINTER_EVENTS = ['click', 'auxclick', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']

const defaultPageState = (doc: Document) => () =>
  `${doc.location?.href ?? doc.URL}|${(doc.querySelector('h1, h2')?.textContent ?? '').trim().slice(0, 200)}`

/**
 * The safety net around every pick, so a case `refusal` did not foresee
 * fails closed instead of acting:
 * - while it runs, capture listeners on the window cancel (preventDefault +
 *   stopImmediatePropagation) every `submit` event, and every click, mouse
 *   or pointer event whose target (composedPath()[0]) is outside the field's
 *   widget and its own listboxes: a label activating an outside checkbox, a
 *   button turned into a submit button at click time, a handler re-sending
 *   the click elsewhere;
 * - it snapshots every checkbox of the page outside the widget and the page
 *   state (URL and step) first; a changed checkbox is put back, and any of
 *   these makes the pick fail with `halt`, so the fill stops picking.
 * The listeners are removed in `finally`.
 */
async function withSafetyNet(
  widget: PickWidget,
  pageState: () => string,
  run: () => Promise<PickResult>
): Promise<PickResult> {
  const doc = widget.scope.ownerDocument
  const view = doc.defaultView
  if (!view) return { status: 'failed', reason: 'The page has no window.' }
  const inWidget = (node: Node | null): boolean => {
    if (!node) return false
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement
    if (!el) return false
    if (widget.scope.contains(el)) return true
    return widget.type === 'listbox' && ownListboxes(widget).some((box) => box.contains(el))
  }
  // Every checkbox of the page (the form's, those tied to it with `form=`, and any other), outside the widget.
  const checkboxes = Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).filter((c) => !widget.scope.contains(c))
  const ticked = checkboxes.map((c) => c.checked)
  const state = pageState()
  let caught: string | null = null
  const block = (event: Event, why: string) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    caught ??= why
  }
  const onSubmit = (event: Event) => block(event, 'the page tried to submit the form')
  const onPointer = (event: Event) => {
    const target = (event.composedPath?.()[0] ?? event.target) as Node | null
    if (!inWidget(target)) block(event, 'a click reached something outside the field')
  }
  view.addEventListener('submit', onSubmit, true)
  for (const type of NET_POINTER_EVENTS) view.addEventListener(type, onPointer, true)
  let result: PickResult
  try {
    result = await run()
  } catch (err) {
    result = { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  } finally {
    view.removeEventListener('submit', onSubmit, true)
    for (const type of NET_POINTER_EVENTS) view.removeEventListener(type, onPointer, true)
  }
  checkboxes.forEach((c, i) => {
    if (c.checked === ticked[i]) return
    c.checked = ticked[i]
    caught ??= 'a checkbox outside the field changed (put back)'
  })
  if (pageState() !== state) caught ??= 'the page moved to another step'
  if (caught) {
    closeMenu(widget)
    return { status: 'failed', reason: `Huntgry stopped: ${caught}.`, halt: true }
  }
  return result
}

/**
 * Picks, in `widget`, the option `choose` names (it gets the option texts and
 * returns one of them, or null for none), then reads it back. A widget that
 * already shows an answer, or that the person touched, is left alone
 * (`kept`), unless it already shows that answer.
 */
export function pick(widget: PickWidget, choose: (options: string[]) => string | null, options: PickOptions = {}): Promise<PickResult> {
  return withSafetyNet(widget, options.pageState ?? defaultPageState(widget.scope.ownerDocument), () =>
    pickInside(widget, choose, options)
  )
}

async function pickInside(
  widget: PickWidget,
  choose: (options: string[]) => string | null,
  { timeoutMs = 1500, touched = () => false }: PickOptions
): Promise<PickResult> {
  const doc = widget.scope.ownerDocument
  const current = pickedValue(widget)
  const keep = (): PickResult => ({ status: 'kept', value: pickedValue(widget) })
  try {
    if (widget.type === 'radios' || widget.type === 'buttons') {
      const options: HTMLElement[] = widget.options
      const texts = widget.type === 'radios' ? widget.options.map(radioLabel) : widget.options.map(text)
      if (texts.some((t) => CONSENT_OPTION.test(t))) return { status: 'failed', reason: 'Its options read like consent.' }
      const chosen = choose(texts)
      if (!chosen) return { status: 'failed', reason: 'None of the options fits your saved answer.' }
      if (current) return same(current, chosen) ? { status: 'filled', value: current } : { status: 'kept', value: current }
      if (touched()) return keep()
      press(options[texts.indexOf(chosen)], widget)
      await waitUntil(doc, () => same(pickedValue(widget), chosen), timeoutMs)
      return same(pickedValue(widget), chosen) ? { status: 'filled', value: chosen } : { status: 'failed', reason: 'The site did not take the pick.' }
    }
    // A listbox: what is chosen shows in the control; the options exist only once it is open.
    if (current) {
      const chosen = choose([current])
      return chosen ? { status: 'filled', value: current } : { status: 'kept', value: current }
    }
    if (touched()) return keep()
    press(widget.opener, widget)
    let boxes: Element[] = []
    await waitUntil(
      doc,
      () => {
        boxes = ownListboxes(widget)
        return listboxOptions(boxes).length > 0
      },
      timeoutMs
    )
    // The person may have typed or chosen while the menu rendered.
    if (touched() || pickedValue(widget)) {
      closeMenu(widget)
      return keep()
    }
    const options = listboxOptions(boxes)
    const texts = options.map(text)
    if (texts.some((t) => CONSENT_OPTION.test(t))) {
      closeMenu(widget)
      return { status: 'failed', reason: 'Its options read like consent.' }
    }
    const chosen = choose(texts)
    if (!chosen) {
      closeMenu(widget)
      return {
        status: 'failed',
        reason: options.length ? 'None of the options fits your saved answer.' : 'No list of options tied to this field opened.'
      }
    }
    press(options[texts.indexOf(chosen)], widget, () => ownListboxes(widget))
    await waitUntil(doc, () => same(pickedValue(widget), chosen), timeoutMs)
    if (same(pickedValue(widget), chosen)) return { status: 'filled', value: chosen }
    closeMenu(widget)
    return { status: 'failed', reason: 'The site did not take the pick.' }
  } catch (err) {
    closeMenu(widget)
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}
