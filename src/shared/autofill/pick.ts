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
 *   or radio group, or the listbox that control owns (by `aria-controls` /
 *   `aria-owns` / `aria-labelledby`, inside the widget, or the one listbox
 *   that appeared when the control was pressed);
 * - never a link, a submit button (`type=submit`, or a button that would
 *   submit its form), a button outside the widget, a disabled element, or
 *   anything labelled Submit / Apply / Next / Continue / Save / Review.
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
  | { status: 'failed'; reason: string }

const tag = (el: Element) => el.tagName.toLowerCase()
const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()
/** "Select…", "Select One", "Choose": nothing chosen yet. */
const PLACEHOLDER = /^(select|choose|pick)( one| an option)?\b|^\s*$/i
/** Labels of the site's own flow buttons: never pressed, whatever widget they sit in. */
const FLOW_WORDS = /\b(submit|apply|next|continue|save|review)\b/i

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
    // A yes/no button group with a hidden checkbox (Ashby).
    const scope = el.closest('[class*="yesno"]') ?? el.parentElement
    const options = scope ? Array.from(scope.querySelectorAll<HTMLElement>('button[aria-pressed], button[data-option]')) : []
    return scope && options.length >= 2 ? { type: 'buttons', scope, options } : null
  }
  if (t === 'input' && input.type === 'radio') {
    const scope = el.closest('fieldset, [role="radiogroup"]') ?? ownScope(el)
    return { type: 'radios', scope, options: radioGroup(input, scope) }
  }
  return null
}

/** Listboxes that belong to the widget's control (see the module comment). */
function ownListboxes(widget: Extract<PickWidget, { type: 'listbox' }>, before: ReadonlySet<Element>): Element[] {
  const doc = widget.opener.ownerDocument
  const ids = `${widget.opener.getAttribute('aria-controls') ?? ''} ${widget.opener.getAttribute('aria-owns') ?? ''}`
    .split(/\s+/)
    .filter(Boolean)
  const owned = new Set<Element>()
  for (const id of ids) {
    const box = doc.getElementById(id)
    if (box) owned.add(box)
  }
  for (const box of Array.from(widget.scope.querySelectorAll('[role="listbox"], [class*="__menu"]'))) owned.add(box)
  const all = Array.from(doc.querySelectorAll('[role="listbox"]'))
  if (widget.opener.id) {
    for (const box of all) if ((box.getAttribute('aria-labelledby') ?? '').split(/\s+/).includes(widget.opener.id)) owned.add(box)
  }
  if (owned.size === 0) {
    // A popup rendered elsewhere (Workday): only the single listbox that appeared after the press, and only one.
    const fresh = all.filter((box) => !before.has(box))
    if (fresh.length === 1) owned.add(fresh[0])
  }
  return [...owned]
}

/** The options of the widget's own listboxes (role=option, or react-select's option class). */
function listboxOptions(boxes: Element[]): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const box of boxes) {
    const options = box.querySelectorAll<HTMLElement>('[role="option"], [class*="__option"]')
    for (const o of Array.from(options)) if (!out.includes(o) && o.getAttribute('aria-disabled') !== 'true') out.push(o)
  }
  return out
}

/**
 * Why `target` must not be pressed for `widget`, or null when it may be.
 * `listboxes` are the widget's own listboxes (listbox widgets, once open).
 */
export function refusal(target: Element, widget: PickWidget, listboxes: readonly Element[] = []): string | null {
  const inside = widget.scope.contains(target) || listboxes.some((box) => box.contains(target))
  if (!inside) return 'outside the field’s widget'
  if (target.closest('a[href]')) return 'a link'
  if ((target as HTMLButtonElement).disabled || target.closest('[aria-disabled="true"]')) return 'disabled'
  const button = target.closest('button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]')
  if (button) {
    if (!widget.scope.contains(button) && !listboxes.some((box) => box.contains(button))) return 'a button outside the widget'
    if (button.getAttribute('type')?.toLowerCase() === 'submit') return 'a submit button'
    const b = button as HTMLButtonElement
    if (b.type === 'submit' && b.form) return 'a button that would submit the form'
  }
  if (target.getAttribute('type')?.toLowerCase() === 'submit') return 'a submit control'
  // The words on what is pressed. A combobox input is named by its question (which may say "continue"), so only
  // its own shown text counts; options, buttons and radios count their label and value too.
  const words =
    widget.type === 'listbox' && target === widget.opener
      ? tag(target) === 'button'
        ? text(target)
        : ''
      : `${target.getAttribute('aria-label') ?? ''} ${(target as HTMLInputElement).value ?? ''} ${text(target)}`
  if (FLOW_WORDS.test(words.slice(0, 200))) return 'labelled like a submit or navigation button'
  return null
}

/** Presses `target` with pointer and mouse events only, after `refusal` allowed it. */
function press(target: HTMLElement, widget: PickWidget, listboxes: readonly Element[] = []): void {
  const refused = refusal(target, widget, listboxes)
  if (refused) throw new Error(`Huntgry does not press ${refused}.`)
  const view = target.ownerDocument.defaultView
  if (!view) throw new Error('The page has no window.')
  const init = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, view }
  const Pointer = view.PointerEvent ?? view.MouseEvent
  asHuntgry(() => {
    target.dispatchEvent(new Pointer('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true } as PointerEventInit))
    target.dispatchEvent(new view.MouseEvent('mousedown', init))
    target.dispatchEvent(new Pointer('pointerup', { ...init, buttons: 0, pointerType: 'mouse', isPrimary: true } as PointerEventInit))
    target.dispatchEvent(new view.MouseEvent('mouseup', { ...init, buttons: 0 }))
    target.dispatchEvent(new view.MouseEvent('click', { ...init, buttons: 0 }))
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
}

/**
 * Picks, in `widget`, the option `choose` names (it gets the option texts and
 * returns one of them, or null for none), then reads it back. A widget that
 * already shows an answer is left alone (`kept`), unless it is that answer.
 */
export async function pick(
  widget: PickWidget,
  choose: (options: string[]) => string | null,
  { timeoutMs = 1500 }: PickOptions = {}
): Promise<PickResult> {
  const doc = widget.scope.ownerDocument
  const current = pickedValue(widget)
  try {
    if (widget.type === 'radios' || widget.type === 'buttons') {
      const options: HTMLElement[] = widget.options
      const texts = widget.type === 'radios' ? widget.options.map(radioLabel) : widget.options.map(text)
      const chosen = choose(texts)
      if (!chosen) return { status: 'failed', reason: 'None of the options fits your saved answer.' }
      if (current) return same(current, chosen) ? { status: 'filled', value: current } : { status: 'kept', value: current }
      press(options[texts.indexOf(chosen)], widget)
      await waitUntil(doc, () => same(pickedValue(widget), chosen), timeoutMs)
      return same(pickedValue(widget), chosen) ? { status: 'filled', value: chosen } : { status: 'failed', reason: 'The site did not take the pick.' }
    }
    // A listbox: what is chosen shows in the control; the options exist only once it is open.
    if (current) {
      const chosen = choose([current])
      return chosen ? { status: 'filled', value: current } : { status: 'kept', value: current }
    }
    const before = new Set(Array.from(doc.querySelectorAll('[role="listbox"]')))
    press(widget.opener, widget)
    let boxes: Element[] = []
    await waitUntil(
      doc,
      () => {
        boxes = ownListboxes(widget, before)
        return listboxOptions(boxes).length > 0
      },
      timeoutMs
    )
    const options = listboxOptions(boxes)
    const texts = options.map(text)
    const chosen = choose(texts)
    if (!chosen) {
      closeMenu(widget)
      return { status: 'failed', reason: options.length ? 'None of the options fits your saved answer.' : 'The list did not open.' }
    }
    press(options[texts.indexOf(chosen)], widget, boxes)
    await waitUntil(doc, () => same(pickedValue(widget), chosen), timeoutMs)
    if (same(pickedValue(widget), chosen)) return { status: 'filled', value: chosen }
    closeMenu(widget)
    return { status: 'failed', reason: 'The site did not take the pick.' }
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}
