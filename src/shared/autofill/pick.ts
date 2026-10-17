import { normalizeText } from '../apply-facts'
import { radioGroup, radioLabel, typeText } from './dom'
import { waitUntil } from './ready'
import { asHuntgry } from './user-edits'
import { ADD_NAME, NAV_AREAS } from './workday-sections'

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
 * one exception is `workdaySearchEnter` (#136): Workday's multiselect prompts
 * search only on Enter, so an Enter keydown / keyup goes to a Workday search
 * box, never anything else (see there). The value is read back afterwards; a
 * pick that did not stick is reported.
 *
 * Typeaheads (#136: Greenhouse's and Lever's location, Workday's prompts) are
 * a widget of their own: the search text is written with the native setter
 * and an `input` event (dom.ts `typeText`), then the widget's own list is
 * awaited, the matching suggestion pressed like an option and read back.
 *
 * Two bounded presses outside a widget's options (#136, Workday My
 * Experience), each with `refusal`'s checks and inside the safety net:
 * - `pressAdd`: a section's own Add / Add Another button (`ADD_NAME`), inside
 *   that section, never in the page's navigation footer, and only while the
 *   page stays on its step;
 * - `pressToggle`: exactly two kinds of check box, unchecked ones only: Work
 *   Experience's "I currently work here" and Self Identify's disability
 *   status boxes. Never a consent, terms or any other check box.
 */

export type PickWidget =
  | { type: 'listbox'; scope: Element; opener: HTMLElement }
  | { type: 'typeahead'; scope: Element; input: HTMLInputElement }
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

/** Workday's multiselect prompt search box (Country Phone Code, Skills, School): it searches on Enter. */
export function isWorkdaySearchBox(el: Element): boolean {
  return (
    tag(el) === 'input' &&
    el.getAttribute('data-automation-id') === 'searchBox' &&
    el.closest('[data-automation-id="multiSelectContainer"]') !== null &&
    el.closest('form') === null
  )
}

/**
 * The typeahead `input` belongs to (#136): a search box whose suggestions the
 * site renders as you type, and which drops free text (Greenhouse's
 * react-select location, Lever's location, Workday's multiselect prompts).
 * Null for anything that is not a text input.
 */
export function typeaheadOf(el: Element): PickWidget | null {
  if (tag(el) !== 'input') return null
  const input = el as HTMLInputElement
  if (!['', 'text', 'search'].includes((input.getAttribute('type') ?? '').toLowerCase())) return null
  const scope =
    el.closest('[data-automation-id^="formField-"]') ??
    el.closest('[class*="select__container"], [class*="SelectContainer"]') ??
    ownScope(el)
  return { type: 'typeahead', scope, input }
}

/**
 * Lists in the document before Huntgry opened a widget (snapshot taken right
 * before the press, or before typing into a typeahead). A list that appears
 * afterwards may be the widget's own even when nothing names it; see
 * `freshList`.
 */
const OPENED = new WeakMap<PickWidget, ReadonlySet<Element>>()

/** Lists a typeahead's suggestions come in: ARIA listboxes, Workday's prompt list, Lever's location results. */
const TYPEAHEAD_LISTS = '[role="listbox"], [data-automation-id="activeListContainer"], .dropdown-results'
/** Suggestions in those lists. */
const TYPEAHEAD_OPTIONS =
  '[role="option"], [class*="__option"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"], .dropdown-location'

/**
 * The one list that appeared in the document after the widget was opened
 * (`OPENED`), when exactly one did and no other control claims it (its
 * `aria-labelledby` or another control's `aria-controls` / `aria-owns` names
 * someone else). Several new lists, or one tied to another control, are
 * never used.
 */
function freshList(widget: PickWidget, selector: string, opener: Element): Element | null {
  const before = OPENED.get(widget)
  if (!before) return null
  const doc = widget.scope.ownerDocument
  const fresh = Array.from(doc.querySelectorAll(selector)).filter((box) => !before.has(box) && !Array.from(before).some((old) => old.contains(box)))
  // A list inside another new list is part of it, not a second one.
  const top = fresh.filter((box) => !fresh.some((other) => other !== box && other.contains(box)))
  if (top.length !== 1) return null
  const box = top[0]
  if (box.id) {
    const claimed = Array.from(doc.querySelectorAll('[aria-controls], [aria-owns]')).some(
      (el) => el !== opener && (idsOf(el, 'aria-controls').includes(box.id) || idsOf(el, 'aria-owns').includes(box.id))
    )
    if (claimed) return null
  }
  return box
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
  // Workday dropdown buttons (#136): some tenants render the popup without `aria-controls`. For a dropdown BUTTON
  // only, the single listbox that appeared after Huntgry pressed it (snapshot in `pickInside`), tied to no other
  // control, is its popup. Comboboxes (react-select) keep the strict tie: their menus always name the input. The
  // reference Workday fillers rely on `aria-controls` → `ul#id` at the end of body, which the tie above covers.
  if (candidates.size === 0 && tag(widget.opener) === 'button') {
    const box = freshList(widget, '[role="listbox"]', widget.opener)
    if (box) candidates.add(box)
  }
  return [...candidates].filter((box) => isOwnListbox(box, widget.opener, widget.scope))
}

/**
 * The lists a typeahead's suggestions are in: named by its input's
 * `aria-controls` / `aria-owns`, inside the widget, or (Workday renders its
 * prompt list in a popup at the end of the page) the single list that
 * appeared after Huntgry typed, tied to no other control.
 */
export function typeaheadLists(widget: Extract<PickWidget, { type: 'typeahead' }>): Element[] {
  const doc = widget.input.ownerDocument
  const candidates = new Set<Element>()
  for (const id of [...idsOf(widget.input, 'aria-controls'), ...idsOf(widget.input, 'aria-owns')]) {
    const box = doc.getElementById(id)
    if (box) candidates.add(box)
  }
  for (const box of Array.from(widget.scope.querySelectorAll(`${TYPEAHEAD_LISTS}, [class*="__menu"]`))) candidates.add(box)
  if (candidates.size === 0) {
    const box = freshList(widget, TYPEAHEAD_LISTS, widget.input)
    if (box) candidates.add(box)
  }
  return [...candidates].filter((box) => isOwnListbox(box, widget.input, widget.scope, TYPEAHEAD_LISTS))
}

/** The lists the widget's options may be pressed in (none for button and radio groups). */
function listsOf(widget: PickWidget): Element[] {
  if (widget.type === 'listbox') return ownListboxes(widget)
  if (widget.type === 'typeahead') return typeaheadLists(widget)
  return []
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
function isOwnListbox(box: Element, opener: Element, scope: Element, lists = '[role="listbox"]'): boolean {
  const isList = box.matches(lists) || (scope.contains(box) && /__menu\b/.test(box.className))
  if (!isList) return false
  const doc = box.ownerDocument
  const owners = idsOf(box, 'aria-labelledby')
    .map((id) => doc.getElementById(id))
    .filter((el): el is HTMLElement => el !== null && el.matches(OTHER_OPENERS))
  if (owners.some((el) => el !== opener)) return false
  if (Array.from(box.querySelectorAll(OTHER_OPENERS)).some((el) => el !== opener)) return false
  // A list inside the list (another widget's) is not ours either.
  if (box.querySelector(lists)) return false
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

/** A typeahead's suggestions in its own lists (the innermost element when Workday nests them), usable ones only. */
function typeaheadOptions(lists: Element[]): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const box of lists) {
    const found = Array.from(box.querySelectorAll<HTMLElement>(TYPEAHEAD_OPTIONS))
    for (const o of found) {
      if (found.some((inner) => inner !== o && o.contains(inner))) continue
      if (!out.includes(o) && o.getAttribute('aria-disabled') !== 'true') out.push(o)
    }
  }
  return out
}

/** A suggestion's text: Workday names it in `data-automation-label`. */
const optionText = (o: Element) => (o.getAttribute('data-automation-label') ?? text(o)).replace(/\s+/g, ' ').trim()

/** Input types whose activation submits, resets, uploads or ticks: never pressed, nor a label pointing at one. */
const NEVER_ACTIVATED = new Set(['submit', 'image', 'reset', 'button', 'file', 'checkbox'])

/**
 * Why `target` must not be pressed for `widget`, or null when it may be.
 * `listboxes` are the widget's own listboxes (listbox widgets, once open).
 * It checks everything the press can reach or activate: the target, every
 * ancestor the events bubble through (a click inside a button activates the
 * button, a click on a label activates its control), and labels' controls.
 */
export function refusal(target: Element, widget: PickWidget, listboxes: readonly Element[] = [], toggle?: Element): string | null {
  if (!target.isConnected) return 'something no longer on the page'
  const within = (node: Element) => widget.scope.contains(node) || listboxes.some((box) => box.contains(node))
  if (!within(target)) return 'outside the field’s widget'
  let inWidget = true
  for (let el: Element | null = target; el && tag(el) !== 'body'; el = el.parentElement) {
    const why = inWidget ? elementRefusal(el, el === target, widget, within, toggle) : enclosingRefusal(el, within)
    if (why) return why
    if (el === widget.scope || listboxes.includes(el)) inWidget = false
  }
  return null
}

/** An element on the path inside the widget (the target, its option, button or label wrappers). */
function elementRefusal(el: Element, isTarget: boolean, widget: PickWidget, within: (node: Element) => boolean, toggle?: Element): string | null {
  const t = tag(el)
  if (t === 'a' && el.hasAttribute('href')) return 'a link'
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return 'something disabled'
  const type = (el.getAttribute('type') ?? '').toLowerCase()
  if (type === 'submit' || type === 'image' || type === 'reset') return 'a submit control'
  if (t === 'button' && (el as HTMLButtonElement).type === 'submit' && (el as HTMLButtonElement).form) return 'a button that would submit the form'
  // `toggle`: the one check box `pressToggle` allowed (its own checks ran first); never any other.
  if (t === 'input' && NEVER_ACTIVATED.has((el as HTMLInputElement).type) && !(el === toggle && isTarget)) return 'a checkbox or button input'
  if (t === 'label') {
    const why = labelRefusal(el as HTMLLabelElement, within)
    if (why) return why
  }
  // What a person reads as this element's name. A combobox input is named by its question (which may say
  // "continue"), so the opener counts only its shown text; everything else its label, title, value and text.
  const opener = (widget.type === 'listbox' && el === widget.opener) || (widget.type === 'typeahead' && el === widget.input)
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
function press(
  target: HTMLElement,
  widget: PickWidget,
  listboxes: () => readonly Element[] = () => [],
  abort: () => string | null = () => null,
  { extra = () => null, toggle }: { extra?: () => string | null; toggle?: Element } = {}
): void {
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
      // The safety net's latch (a blocked event, a page or step change) stops the press before any further event.
      const stopped = abort()
      if (stopped) throw new Error(`Huntgry stopped: ${stopped}.`)
      const refused = refusal(target, widget, listboxes(), toggle) ?? extra()
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
  if (widget.type === 'typeahead') {
    // Workday shows a prompt's choice as a pill; react-select as its single value; Lever in the input itself.
    const pill = widget.scope.querySelector('[data-automation-id="selectedItem"]')
    if (pill) return (pill.getAttribute('data-automation-label') ?? pill.getAttribute('title') ?? text(pill)).trim()
    const chosen = widget.scope.querySelector('[class*="single-value"], [class*="singleValue"]')
    if (chosen) return text(chosen)
    return widget.input.value.trim()
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

/** The pills of a Workday multiselect prompt (#136: Skills), as they name their choice. */
export function pillsOf(widget: PickWidget): string[] {
  return Array.from(widget.scope.querySelectorAll('[data-automation-id="selectedItem"]')).map((pill) =>
    (pill.getAttribute('data-automation-label') ?? pill.getAttribute('title') ?? text(pill)).trim()
  )
}

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
  /** Typeaheads: the text to search for (the city, the country…). */
  search?: string
  /**
   * A multiselect typeahead (#136: Workday's Skills): other pills do not count as an answer; the pick is done once
   * a pill shows the chosen suggestion.
   */
  multi?: boolean
  /** How long a Workday search box waits for suggestions before its Enter (default 600 ms). */
  enterAfterMs?: number
  /**
   * The AI answer Huntgry itself picked in this widget, which the user's confirmed answer corrects (#136). A
   * radio / button group or listbox that shows exactly this, untouched (`touched`), is picked again with the
   * correction; one showing anything else is kept. Typeaheads always keep their choice.
   */
  replace?: string
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
 * - it also cancels a click whose target, or the control of the label it
 *   lands on (resolved at dispatch time), is a checkbox or radio this pick is
 *   not answering, even inside the widget;
 * - it snapshots every checkbox and radio of the page except the ones this
 *   pick answers (the group's radios, Ashby's yes/no mirror), and the page
 *   state (URL and step). A changed one is put back; that, a blocked event or
 *   a page change makes the pick fail with `halt`, so the fill stops picking;
 * - the latch and the page state are checked before every dispatched event
 *   and after the menu opens, so nothing is pressed on a page that moved on;
 * - cleanup that runs page handlers (closing the menu by blur) happens while
 *   the net is up; the listeners are removed last, after a microtask and a
 *   task.
 */
async function withSafetyNet(
  widget: PickWidget,
  pageState: () => string,
  run: (abort: () => string | null) => Promise<PickResult>,
  ownControls?: readonly Element[]
): Promise<PickResult> {
  const doc = widget.scope.ownerDocument
  const view = doc.defaultView
  if (!view) return { status: 'failed', reason: 'The page has no window.' }
  const inWidget = (node: Node | null): boolean => {
    if (!node) return false
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement
    if (!el) return false
    if (widget.scope.contains(el)) return true
    return listsOf(widget).some((box) => box.contains(el))
  }
  // Controls the pick itself may change: the radios of the group being answered, Ashby's yes/no mirror checkbox.
  const own = new Set<Element>(
    ownControls ??
      (widget.type === 'radios' ? widget.options : widget.type === 'buttons' ? Array.from(widget.scope.querySelectorAll('input[type="checkbox"]')) : [])
  )
  // Every other checkbox and radio of the page, inside the widget or not, is snapshotted and put back if it changes.
  const toggles = Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="checkbox"], input[type="radio"]')).filter((c) => !own.has(c))
  const states = toggles.map((c) => c.checked)
  const state = pageState()
  let caught: string | null = null
  const block = (event: Event, why: string) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    caught ??= why
  }
  /** What a click on `el` would activate right now (a label's control is resolved at dispatch time). */
  const activates = (el: Element | null): Element | null => {
    const label = el?.closest('label')
    return (label as HTMLLabelElement | null)?.control ?? (el && tag(el) === 'input' ? el : null)
  }
  const onSubmit = (event: Event) => block(event, 'the page tried to submit the form')
  const onPointer = (event: Event) => {
    const node = (event.composedPath?.()[0] ?? event.target) as Node | null
    const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement)
    if (!inWidget(node)) return block(event, 'a click reached something outside the field')
    const control = activates(el)
    // A checkbox or radio this pick is not answering, clicked directly or through a label, even inside the widget.
    if (control && tag(control) === 'input' && ['checkbox', 'radio'].includes((control as HTMLInputElement).type) && !own.has(control)) {
      block(event, 'a click reached a checkbox or radio that is not this question’s')
    }
  }
  const abort = () => caught ?? (pageState() !== state ? 'the page moved to another step' : null)
  view.addEventListener('submit', onSubmit, true)
  for (const type of NET_POINTER_EVENTS) view.addEventListener(type, onPointer, true)
  try {
    let result: PickResult
    try {
      result = await run(abort)
    } catch (err) {
      result = { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
    }
    toggles.forEach((c, i) => {
      if (c.checked === states[i]) return
      c.checked = states[i]
      caught ??= 'a checkbox or radio that is not this question’s changed (put back)'
    })
    const stopped = abort()
    if (stopped) {
      // Cleanup that runs page handlers (blur) happens with the net still up.
      closeMenu(widget)
      return { status: 'failed', reason: `Huntgry stopped: ${stopped}.`, halt: true }
    }
    return result
  } finally {
    // Removed last, after a microtask and a task: anything the cleanup scheduled still meets the net.
    await Promise.resolve()
    await new Promise<void>((resolve) => view.setTimeout(resolve, 0))
    view.removeEventListener('submit', onSubmit, true)
    for (const type of NET_POINTER_EVENTS) view.removeEventListener(type, onPointer, true)
  }
}

export function pick(widget: PickWidget, choose: (options: string[]) => string | null, options: PickOptions = {}): Promise<PickResult> {
  return withSafetyNet(widget, options.pageState ?? defaultPageState(widget.scope.ownerDocument), (abort) =>
    widget.type === 'typeahead' ? typeaheadInside(widget, choose, options, abort) : pickInside(widget, choose, options, abort)
  )
}

async function pickInside(
  widget: PickWidget,
  choose: (options: string[]) => string | null,
  { timeoutMs = 1500, touched = () => false, replace }: PickOptions,
  abort: () => string | null = () => null
): Promise<PickResult> {
  const doc = widget.scope.ownerDocument
  const current = pickedValue(widget)
  const keep = (): PickResult => ({ status: 'kept', value: pickedValue(widget) })
  /** The widget still shows exactly the AI answer Huntgry picked, and the person has not touched it (#136). */
  const replaceable = (shown: string) => replace !== undefined && shown !== '' && same(shown, replace) && !touched()
  try {
    if (widget.type === 'radios' || widget.type === 'buttons') {
      const options: HTMLElement[] = widget.options
      const texts = widget.type === 'radios' ? widget.options.map(radioLabel) : widget.options.map(text)
      if (texts.some((t) => CONSENT_OPTION.test(t))) return { status: 'failed', reason: 'Its options read like consent.' }
      const chosen = choose(texts)
      if (!chosen) return { status: 'failed', reason: 'None of the options fits your saved answer.' }
      if (current && same(current, chosen)) return { status: 'filled', value: current }
      if (current && !replaceable(current)) return { status: 'kept', value: current }
      if (touched()) return keep()
      press(options[texts.indexOf(chosen)], widget, () => [], abort)
      await waitUntil(doc, () => same(pickedValue(widget), chosen), timeoutMs)
      return same(pickedValue(widget), chosen) ? { status: 'filled', value: chosen } : { status: 'failed', reason: 'The site did not take the pick.' }
    }
    // A listbox: what is chosen shows in the control; the options exist only once it is open.
    if (current) {
      const chosen = choose([current])
      if (chosen) return { status: 'filled', value: current }
      if (!replaceable(current)) return { status: 'kept', value: current }
    }
    if (touched()) return keep()
    if (widget.type !== 'listbox') return { status: 'failed', reason: 'Not a list widget.' }
    OPENED.set(widget, new Set(Array.from(doc.querySelectorAll('[role="listbox"]'))))
    press(widget.opener, widget, () => [], abort)
    let boxes: Element[] = []
    await waitUntil(
      doc,
      () => {
        boxes = ownListboxes(widget)
        return listboxOptions(boxes).length > 0
      },
      timeoutMs
    )
    // The page may have moved on (or the net caught something) while the menu rendered: stop before any option.
    const stopped = abort()
    if (stopped) {
      closeMenu(widget)
      return { status: 'failed', reason: `Huntgry stopped: ${stopped}.` }
    }
    // The person may have typed or chosen while the menu rendered (an AI answer being corrected must still show).
    const shown = pickedValue(widget)
    if (touched() || (shown && !(current && same(shown, current) && replaceable(shown)))) {
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
    press(options[texts.indexOf(chosen)], widget, () => ownListboxes(widget), abort)
    await waitUntil(doc, () => same(pickedValue(widget), chosen), timeoutMs)
    if (same(pickedValue(widget), chosen)) return { status: 'filled', value: chosen }
    closeMenu(widget)
    return { status: 'failed', reason: 'The site did not take the pick.' }
  } catch (err) {
    closeMenu(widget)
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The ONLY keyboard event Huntgry sends (#136, the Workday exception, guarded
 * by guard.test.ts: this is the single KeyboardEvent constructor in the
 * codebase). Workday's multiselect prompts (Country Phone Code, Skills,
 * School) search only when Enter is pressed in their search box. Sent only:
 * - to an `input[data-automation-id="searchBox"]` inside a
 *   `[data-automation-id="multiSelectContainer"]` with no `<form>` ancestor
 *   (checked again here, whatever the caller thought);
 * - from `typeaheadInside`, inside the safety net (submit events cancelled,
 *   clicks outside the widget cancelled), after Huntgry typed the search text
 *   and no suggestion appeared within about 600 ms.
 * Synthetic key events are untrusted and have no default action: the browser
 * never submits a form or activates a button because of them; only the
 * page's own key listeners see them.
 */
function workdaySearchEnter(input: HTMLInputElement): void {
  if (!isWorkdaySearchBox(input) || input.form !== null || input.closest('form') !== null) {
    throw new Error('Huntgry sends Enter only to a Workday search box.')
  }
  const view = input.ownerDocument.defaultView
  if (!view) throw new Error('The page has no window.')
  asHuntgry(() => {
    for (const type of ['keydown', 'keyup']) {
      input.dispatchEvent(new view.KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
    }
  })
}

/** How long a typeahead waits for suggestions before a Workday search box gets its Enter. */
const ENTER_AFTER_MS = 600

/**
 * Picks in a typeahead (#136): presses the search box (like a person's click
 * into it), types `search`, waits for the widget's own suggestions, presses
 * the one `choose` names and reads it back. Text Huntgry typed but could not
 * turn into a choice is cleared again; the field then goes to the user.
 */
async function typeaheadInside(
  widget: Extract<PickWidget, { type: 'typeahead' }>,
  choose: (options: string[]) => string | null,
  { timeoutMs = 1500, touched = () => false, search = '', multi = false, enterAfterMs = ENTER_AFTER_MS }: PickOptions,
  abort: () => string | null = () => null
): Promise<PickResult> {
  const doc = widget.scope.ownerDocument
  const input = widget.input
  const keep = (): PickResult => ({ status: 'kept', value: pickedValue(widget) })
  // A multiselect's other pills are other answers, not this one.
  const current = multi ? '' : pickedValue(widget)
  const shows = (choice: string) => (multi ? pillsOf(widget).some((p) => same(p, choice)) : same(pickedValue(widget), choice))
  let typed = false
  /** Takes back the search text Huntgry typed (never text the person typed meanwhile). */
  const untype = () => {
    if (typed && input.isConnected && input.value === search && !touched()) typeText(input, '')
    closeMenu(widget)
  }
  try {
    if (current) {
      const chosen = choose([current])
      return chosen ? { status: 'filled', value: current } : { status: 'kept', value: current }
    }
    if (touched()) return keep()
    if (!search.trim()) return { status: 'failed', reason: 'Nothing to search for.' }
    OPENED.set(widget, new Set(Array.from(doc.querySelectorAll(TYPEAHEAD_LISTS))))
    press(input, widget, () => [], abort)
    const stoppedEarly = abort()
    if (stoppedEarly) return { status: 'failed', reason: `Huntgry stopped: ${stoppedEarly}.` }
    input.focus?.()
    typeText(input, search)
    typed = true
    let options: HTMLElement[] = []
    let texts: string[] = []
    let chosen: string | null = null
    const look = () => {
      options = typeaheadOptions(typeaheadLists(widget))
      texts = options.map(optionText)
      // No suggestions yet is no answer (a remembered answer's chooser accepts any text when it sees no options).
      chosen = texts.length ? choose(texts) : null
      return chosen !== null && texts.includes(chosen)
    }
    const workday = isWorkdaySearchBox(input)
    let found = await waitUntil(doc, look, workday ? Math.min(enterAfterMs, timeoutMs) : timeoutMs)
    if (!found && workday && !abort() && !touched()) {
      workdaySearchEnter(input)
      found = await waitUntil(doc, look, timeoutMs)
    }
    const stopped = abort()
    if (stopped) {
      untype()
      return { status: 'failed', reason: `Huntgry stopped: ${stopped}.` }
    }
    // The person may have typed or chosen while the suggestions loaded.
    if (touched()) {
      closeMenu(widget)
      return keep()
    }
    if (texts.some((t) => CONSENT_OPTION.test(t))) {
      untype()
      return { status: 'failed', reason: 'Its options read like consent.' }
    }
    if (!found || chosen === null) {
      untype()
      return { status: 'failed', reason: texts.length ? 'None of the suggestions fits your profile.' : 'No suggestions appeared.' }
    }
    const pickText: string = chosen
    press(options[texts.indexOf(pickText)], widget, () => typeaheadLists(widget), abort)
    await waitUntil(doc, () => shows(pickText), timeoutMs)
    if (shows(pickText)) return { status: 'filled', value: pickText }
    untype()
    return { status: 'failed', reason: 'The site did not take the pick.' }
  } catch (err) {
    untype()
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

export interface PressOptions {
  /** The page and step the press happens on; a change stops it (safety net). */
  pageState: () => string
  /** How long the page may take to show the result. */
  timeoutMs?: number
}

/** Why `button` must not be pressed as `section`'s Add button, or null when it may be (#136). */
export function addRefusal(button: Element, section: Element): string | null {
  if (!button.isConnected) return 'something no longer on the page'
  if (button === section || !section.contains(button)) return 'a button outside its section'
  if (button.closest(NAV_AREAS)) return 'a button of the page’s navigation'
  if (tag(button) !== 'button' && button.getAttribute('role') !== 'button') return 'something that is not a button'
  const label = (button.getAttribute('aria-label') ?? '').trim()
  const shown = text(button)
  if (!label && !shown) return 'an unnamed button'
  if ((label && !ADD_NAME.test(label)) || (shown && !ADD_NAME.test(shown))) return 'a button that is not named Add'
  if (/delete|remove/i.test(button.getAttribute('data-automation-id') ?? '')) return 'a delete button'
  return null
}

/**
 * Presses a section's Add / Add Another button (#136, Workday My Experience) and waits until `grew()` says a new
 * block rendered. Refused (`addRefusal`, checked again before every event, and `refusal`): anything not named like
 * an Add button, outside the section, in the page's navigation footer, a link, a submit control. The press runs in
 * the safety net (a submit, a click outside the section or a step change stops it); nothing is ever pressed in a
 * block (its Delete button included).
 */
export function pressAdd(button: HTMLElement, section: Element, grew: () => boolean, { pageState, timeoutMs = 1500 }: PressOptions): Promise<PickResult> {
  const why = addRefusal(button, section)
  if (why) return Promise.resolve({ status: 'failed', reason: `Huntgry does not press ${why}.` })
  const widget: PickWidget = { type: 'buttons', scope: section, options: [button] }
  return withSafetyNet(
    widget,
    pageState,
    async (abort) => {
      press(button, widget, () => [], abort, { extra: () => addRefusal(button, section) })
      await waitUntil(section.ownerDocument, grew, timeoutMs)
      return grew() ? { status: 'filled', value: 'added' } : { status: 'failed', reason: 'The site did not add a block.' }
    },
    []
  )
}

/** The only check boxes Huntgry ever ticks (#136): "I currently work here", and Self Identify's disability boxes. */
const TOGGLES = '[data-automation-id="formField-currentlyWorkHere"], [data-automation-id="formField-disabilityStatus"]'

/** The allowed field a check box belongs to, or null. */
function toggleField(input: Element): Element | null {
  return input.closest(TOGGLES) ?? (/--currentlyWorkHere$/.test(input.id) ? input.parentElement : null)
}

/** Why `input` must not be ticked, or null when it may be (#136). */
export function toggleRefusal(input: Element): string | null {
  if (!input.isConnected) return 'something no longer on the page'
  if (tag(input) !== 'input' || (input as HTMLInputElement).type !== 'checkbox') return 'something that is not a check box'
  if (!toggleField(input)) return 'a check box other than “I currently work here” or a disability status'
  if ((input as HTMLInputElement).checked) return 'a check box that is already ticked'
  if ((input as HTMLInputElement).disabled) return 'something disabled'
  if (input.closest(NAV_AREAS) || input.closest('form')) return 'a check box in a form or the page’s navigation'
  const label = `${radioLabel(input as HTMLInputElement)} ${input.getAttribute('aria-label') ?? ''}`
  if (CONSENT_OPTION.test(label) || FLOW_WORDS.test(label)) return 'a check box worded like consent'
  return null
}

/**
 * Ticks one allowed check box (#136): "I currently work here" for a current job, or the disability status box the
 * stored fact names. Only an unchecked one, only those (`toggleRefusal`, checked again before every event); the
 * press runs in the safety net, which puts back any other check box that changes.
 */
export function pressToggle(input: HTMLInputElement, { pageState, timeoutMs = 1000 }: PressOptions): Promise<PickResult> {
  const why = toggleRefusal(input)
  if (why) return Promise.resolve({ status: 'failed', reason: `Huntgry does not press ${why}.` })
  const scope = toggleField(input) ?? input
  const widget: PickWidget = { type: 'buttons', scope, options: [input] }
  return withSafetyNet(
    widget,
    pageState,
    async (abort) => {
      press(input, widget, () => [], abort, { toggle: input, extra: () => (input.checked ? null : toggleRefusal(input)) })
      await waitUntil(input.ownerDocument, () => input.checked, timeoutMs)
      return input.checked ? { status: 'filled', value: 'ticked' } : { status: 'failed', reason: 'The site did not tick it.' }
    },
    [input]
  )
}
