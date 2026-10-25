import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { FillValues } from '../apply-types'
import { fillPage, scanPage } from './engine'
import { addRefusal, pick, pressAdd, pressToggle, refusal, toggleRefusal, typeaheadOf, widgetOf } from './pick'
import { testValues } from './fixtures/values'

/**
 * Huntgry never submits an application (owner decision, #24). This fails the
 * build if the code that runs inside job pages ever gains a way to: calling
 * submit()/requestSubmit(), clicking anything, or synthesising key/mouse input.
 */

const ROOT = resolve(__dirname, '../../..')
const FORBIDDEN = [
  /\.submit\s*\(/,
  /requestSubmit/,
  /\.click\s*\(/,
  /new\s+[\w.]*(Keyboard|Mouse|Pointer|Submit)Event\b/,
  /\bsendInputEvent\b/,
  /Input\.dispatch(Key|Mouse)Event/
]

/**
 * The one module allowed to dispatch synthetic pointer and mouse events (#71, owner decision of 2026-10-06: pick
 * remembered answers in click-only widgets). It is still scanned for everything else: submit, requestSubmit,
 * `.click()`, keyboard and submit events. Its bounds are tested in "pick.ts presses only inside the field's widget".
 */
const PICK_MODULE = join(ROOT, 'src/shared/autofill/pick.ts')
const PICK_FORBIDDEN = [...FORBIDDEN.filter((p) => !/Mouse\|Pointer/.test(p.source)), /new\s+[\w.]*(Keyboard|Submit)Event\b/]

function pageSources(): string[] {
  const dir = join(ROOT, 'src/shared/autofill')
  const own = (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('fixtures'))
    .map((f) => join(dir, f))
  return [
    ...own,
    join(ROOT, 'src/shared/autofill-channels.ts'),
    join(ROOT, 'src/shared/apply-embeds.ts'),
    join(ROOT, 'src/preload/browser-page.ts'),
    join(ROOT, 'src/main/apply/service.ts'),
    join(ROOT, 'src/main/apply/upload.ts'),
    // Automation (#154) drives the apply service unattended: it must never gain a way to submit either.
    ...automationSources()
  ]
}

/** Automation's main-process modules (#154): they call `ApplyService.prepare` and must never press anything themselves. */
function automationSources(): string[] {
  const dir = join(ROOT, 'src/main/automation')
  return (readdirSync(dir) as string[]).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => join(dir, f))
}

describe('no-submit guard', () => {
  it('covers the engine, the page preload and the apply service', () => {
    expect(pageSources().length).toBeGreaterThanOrEqual(14)
    expect(pageSources().some((f) => f.endsWith('adapters/greenhouse.ts'))).toBe(true)
  })

  for (const file of pageSources()) {
    it(`${file.slice(ROOT.length + 1)} cannot submit, click or type`, () => {
      const source = readFileSync(file, 'utf8')
      // pick.ts's one Enter for Workday's search boxes is checked on its own below; everything else in it is scanned.
      const scanned = file === PICK_MODULE ? withoutWorkdayEnter(source) : source
      for (const pattern of file === PICK_MODULE ? PICK_FORBIDDEN : FORBIDDEN) expect(scanned, `${pattern} in ${file}`).not.toMatch(pattern)
    })
  }

  /**
   * The Workday exception (#136): Workday's multiselect prompts search only on Enter. The single KeyboardEvent
   * constructor in the code that runs in job pages must sit in pick.ts's `workdaySearchEnter`, which refuses any
   * element but a Workday search box outside a form, and sends only Enter.
   */
  it('allows exactly one keyboard event: Enter, in pick.ts workdaySearchEnter, for a Workday search box', () => {
    const sources = pageSources().map((f) => [f, readFileSync(f, 'utf8')] as const)
    const keyboard = /new\s+[\w.]*KeyboardEvent\b/g
    const hits = sources.flatMap(([f, src]) => [...src.matchAll(keyboard)].map(() => f))
    expect(hits).toEqual([PICK_MODULE])
    const source = readFileSync(PICK_MODULE, 'utf8')
    const body = workdayEnterBody(source)
    expect(body).toMatch(keyboard)
    expect(body).toMatch(/isWorkdaySearchBox\(input\)/)
    expect(body).toMatch(/closest\('form'\)/)
    expect(body).toMatch(/key: 'Enter'/)
    expect(body).not.toMatch(/key: '(?!Enter')/)
    // The check it relies on names the search box, its container and the form.
    const check = /export function isWorkdaySearchBox[\s\S]*?\n}\n/.exec(source)?.[0] ?? ''
    expect(check).toMatch(/data-automation-id'\) === 'searchBox'/)
    expect(check).toMatch(/multiSelectContainer/)
    expect(check).toMatch(/closest\('form'\) === null/)
    // Only the typeahead calls it.
    expect([...source.matchAll(/workdaySearchEnter\(/g)]).toHaveLength(2)
  })
})

/** The body of pick.ts's `workdaySearchEnter` (the function, from its signature to its closing brace). */
function workdayEnterBody(source: string): string {
  const match = /\nfunction workdaySearchEnter\([\s\S]*?\n}\n/.exec(source)
  if (!match) throw new Error('pick.ts has no workdaySearchEnter function')
  return match[0]
}

const withoutWorkdayEnter = (source: string) => source.replace(workdayEnterBody(source), '\n')

/**
 * Buttons of the sites' apply flows that only the user presses: Workday's
 * Apply, its "how to apply" choice, Next / Save and Continue, Sign In and
 * Create Account. Filling every Workday step must not click, submit or
 * focus-trigger any of them, nor type into the sign-in fields or the
 * `beecatcher` honeypot.
 */
const NEVER_TOUCHED = [
  'adventureButton',
  'autofillWithResume',
  'applyManually',
  'useMyLastApplication',
  'bottom-navigation-next-button',
  'pageFooterNextButton',
  'signInSubmitButton',
  'createAccountSubmitButton',
  'createAccountLink',
  'SignInWithEmailButton',
  'select-files'
]
const NEVER_TYPED = ['email', 'password', 'verifyPassword', 'beecatcher', 'createAccountCheckbox']
const VALUES: FillValues = testValues({ location: 'London', github: '', website: '', currentCompany: '' })

describe('Workday buttons Huntgry never presses', () => {
  const fixtures = readdirSync(join(ROOT, 'src/shared/autofill/fixtures')).filter((f) => f.startsWith('workday-'))

  it('covers every Workday fixture and every button in the list', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(9)
    const html = fixtures.map((f) => readFileSync(join(ROOT, 'src/shared/autofill/fixtures', f), 'utf8')).join('\n')
    // Older tenants' Next and the SSO page's "Sign in with email" are not in the fixtures.
    const elsewhere = new Set(['pageFooterNextButton', 'SignInWithEmailButton'])
    for (const id of NEVER_TOUCHED.filter((id) => !elsewhere.has(id))) expect(html, id).toContain(`"${id}"`)
  })

  for (const name of fixtures) {
    it(`${name}: a detect and a fill press nothing`, () => {
      const dom = new JSDOM(readFileSync(join(ROOT, 'src/shared/autofill/fixtures', name), 'utf8'), {
        url: 'https://acme.wd1.myworkdayjobs.com/en-US/AcmeCareers/job/Remote-USA/Software-Engineer_JR-1001/apply'
      })
      const w = dom.window
      const pressed: string[] = []
      for (const type of ['click', 'submit', 'mousedown', 'pointerdown', 'keydown', 'focus']) {
        const log = (e: Event) => pressed.push(`${type} ${(e.target as Element).getAttribute?.('data-automation-id')}`)
        w.document.addEventListener(type, log, true)
      }
      const click = vi.spyOn(w.HTMLElement.prototype, 'click')
      const authValues = () =>
        NEVER_TYPED.map((id) => {
          const el = w.document.querySelector(`[data-automation-id="${id}"]`) as HTMLInputElement | null
          return el && (el.type === 'checkbox' ? el.checked : el.value)
        })
      const before = authValues()
      scanPage(w.document)
      fillPage(w.document, VALUES)
      expect(pressed).toEqual([])
      expect(click).not.toHaveBeenCalled()
      // My Information has its own email field; the sign-in wall's must stay empty.
      if (/signin|create-account/.test(name)) expect(authValues()).toEqual(before)
      expect((w.document.querySelector('[data-automation-id="beecatcher"]') as HTMLInputElement | null)?.value ?? '').toBe('')
    })
  }
})

/** Runtime (non-type) module specifiers imported by a file. */
const runtimeImports = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(/^import (?!type )[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])

describe('preload bundles', () => {
  // Sandboxed preloads cannot load shared chunks, so the two preload entries must share no runtime module.
  it('keeps the page preload and the app preload apart', () => {
    for (const spec of runtimeImports(join(ROOT, 'src/preload/browser-page.ts'))) {
      expect(spec).toMatch(/^(electron|@shared\/autofill\/|@shared\/autofill-channels$)/)
    }
    const preloads = readdirSync(join(ROOT, 'src/preload')).filter((f) => f.endsWith('.ts') && f !== 'browser-page.ts')
    for (const f of preloads) {
      for (const spec of runtimeImports(join(ROOT, 'src/preload', f))) {
        expect(spec, f).not.toMatch(/autofill|apply-url|apply-values/)
      }
    }
  })
})

describe("pick.ts presses only inside the field's widget", () => {
  /** A form with a react-select-like Gender question, its Submit button, and a page that can misbehave on open. */
  function page(menu: string, { tie = true, controls = 'g-listbox' } = {}) {
    const dom = new JSDOM(
      `<form id="f"><div class="select__container"><label id="g-label">Gender</label>
         <input role="combobox" id="g" aria-labelledby="g-label"><div class="select__single-value"></div>
         <a href="/elsewhere" id="link">help</a><button id="inner">Toggle</button><button type="submit" id="inner-submit">Go</button></div>
       <button type="submit" id="submit">Submit application</button></form>`,
      { url: 'https://example.com/apply' }
    )
    const w = dom.window
    const doc = w.document
    const fired: string[] = []
    for (const type of ['submit', 'keydown', 'keypress', 'keyup']) doc.addEventListener(type, () => fired.push(type), true)
    const submit = vi.spyOn(w.HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined)
    const requestSubmit = vi.spyOn(w.HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => undefined)
    doc.addEventListener('submit', (e) => e.preventDefault())
    doc.getElementById('g')!.addEventListener('mousedown', () => {
      if (tie) doc.getElementById('g')!.setAttribute('aria-controls', controls)
      doc.body.insertAdjacentHTML('beforeend', menu)
    })
    const widget = widgetOf(doc.getElementById('g')!)!
    const clicked: string[] = []
    doc.addEventListener('click', (e) => clicked.push((e.target as Element).id || (e.target as Element).tagName), true)
    return { doc, widget, fired, submit, requestSubmit, clicked }
  }
  const female = (options: string[]) => options.find((o) => o === 'Female') ?? null

  it('refuses targets outside the widget, links, submit buttons and flow-labelled controls', () => {
    const { doc, widget } = page('')
    const el = (id: string) => doc.getElementById(id)!
    expect(refusal(el('submit'), widget)).toMatch(/outside/)
    expect(refusal(el('link'), widget)).toMatch(/link/)
    expect(refusal(el('inner-submit'), widget)).toMatch(/submit/)
    // A button without a type submits its form: refused even inside the widget.
    expect(refusal(el('inner'), widget)).toMatch(/submit the form/)
    doc.body.insertAdjacentHTML('beforeend', '<div role="listbox" id="lb"><div role="option" id="next">Next</div><div role="option" id="ok">Female</div></div>')
    expect(refusal(el('next'), widget, [el('lb')])).toMatch(/labelled/)
    expect(refusal(el('ok'), widget, [el('lb')])).toBeNull()
    expect(refusal(el('ok'), widget)).toMatch(/outside/)
    expect(refusal(el('g'), widget)).toBeNull()
  })

  it('never presses a submit button posing as an option, and never sends a key', async () => {
    const { widget, fired, submit, requestSubmit } = page(
      '<div role="listbox" id="g-listbox"><button role="option" type="submit" form="f">Female</button></div>'
    )
    const result = await pick(widget, (options) => options.find((o) => o === 'Female') ?? null, { timeoutMs: 200 })
    expect(result).toMatchObject({ status: 'failed' })
    expect(fired).toEqual([])
    expect(submit).not.toHaveBeenCalled()
    expect(requestSubmit).not.toHaveBeenCalled()
  })

  it('does not take a listbox it cannot tie to the widget', async () => {
    const { doc, widget, fired } = page('')
    // Opening renders two unrelated listboxes elsewhere and no aria-controls target: neither is the widget's.
    doc.getElementById('g')!.addEventListener('mousedown', () => {
      doc.getElementById('g')!.removeAttribute('aria-controls')
      doc.body.insertAdjacentHTML('beforeend', '<div role="listbox"><div role="option">Female</div></div><div role="listbox"><div role="option">Female</div></div>')
    })
    const clicks: Element[] = []
    doc.addEventListener('click', (e) => clicks.push(e.target as Element), true)
    const result = await pick(widget, (options) => options[0] ?? null, { timeoutMs: 150 })
    expect(result).toMatchObject({ status: 'failed' })
    expect(clicks.every((t) => widget.scope.contains(t))).toBe(true)
    expect(fired).toEqual([])
  })

  it('never presses a label whose control is an outside submit image or a consent checkbox', async () => {
    const image = page(
      '<div role="listbox" id="g-listbox"><label role="option" for="image">Female</label></div><input id="image" type="image" form="f" alt="Send">'
    )
    expect(await pick(image.widget, female, { timeoutMs: 200 })).toMatchObject({ status: 'failed' })
    expect(image.fired).toEqual([])
    // Only the field's own control was pressed (to open it); never the label or the image input.
    expect(image.clicked).toEqual(['g'])
    const consent = page(
      '<div role="listbox" id="g-listbox"><label role="option" for="consent">Female</label></div><input id="consent" type="checkbox" name="consent">'
    )
    expect(await pick(consent.widget, female, { timeoutMs: 200 })).toMatchObject({ status: 'failed' })
    expect((consent.doc.getElementById('consent') as HTMLInputElement).checked).toBe(false)
  })

  it('never presses an option nested in a button labelled Next (or any flow word)', async () => {
    const { doc, widget, clicked } = page(
      '<div role="listbox" id="g-listbox"><button type="button" id="next" aria-label="Next"><span role="option" id="opt">Female</span></button></div>'
    )
    const navigated: string[] = []
    doc.addEventListener('mousedown', () => doc.getElementById('next')?.addEventListener('click', () => navigated.push('next')), { once: true })
    expect(await pick(widget, female, { timeoutMs: 200 })).toMatchObject({ status: 'failed' })
    expect(navigated).toEqual([])
    expect(clicked).not.toContain('opt')
  })

  it('stops a press when the page turns the option into a submit button, or moves it, mid-sequence', async () => {
    const turned = page('<div role="listbox" id="g-listbox"><button role="option" type="button" form="f" id="opt">Female</button></div>')
    turned.doc.addEventListener('mousedown', (e) => {
      if ((e.target as Element).id === 'opt') (e.target as HTMLButtonElement).type = 'submit'
    }, true)
    expect(await pick(turned.widget, female, { timeoutMs: 200 })).toMatchObject({ status: 'failed' })
    expect(turned.fired).toEqual([])
    expect(turned.submit).not.toHaveBeenCalled()
    expect(turned.clicked).not.toContain('opt')

    const moved = page('<div role="listbox" id="g-listbox"><div role="option" id="opt">Female</div></div>')
    moved.doc.addEventListener('pointerdown', (e) => {
      if ((e.target as Element).id === 'opt') moved.doc.getElementById('submit')!.append(e.target as Element)
    }, true)
    expect(await pick(moved.widget, female, { timeoutMs: 200 })).toMatchObject({ status: 'failed' })
    expect(moved.clicked).not.toContain('opt')
    expect(moved.fired).toEqual([])
  })

  it('does not use a single new listbox that nothing ties to the field', async () => {
    const { doc, widget, clicked } = page('<div role="listbox"><div role="option" id="stray">Female</div></div>', { tie: false })
    const handled: string[] = []
    doc.addEventListener('mousedown', () => doc.getElementById('stray')?.addEventListener('click', () => handled.push('stray')), { once: true })
    expect(await pick(widget, female, { timeoutMs: 150 })).toMatchObject({ status: 'failed' })
    expect(handled).toEqual([])
    expect(clicked).not.toContain('stray')
  })

  it('cancels a submit the page arranges at click time (type changed in a click listener)', async () => {
    const turned = page('<div role="listbox" id="g-listbox"><button role="option" type="button" form="f" id="opt">Female</button></div>')
    turned.doc.addEventListener('click', (e) => {
      if ((e.target as Element).id === 'opt') (e.target as HTMLButtonElement).type = 'submit'
    }, true)
    const result = await pick(turned.widget, female, { timeoutMs: 200 })
    expect(result).toMatchObject({ status: 'failed', halt: true })
    expect(turned.fired).toEqual([])
    expect(turned.submit).not.toHaveBeenCalled()
    expect(turned.requestSubmit).not.toHaveBeenCalled()
  })

  it('cancels a consent checkbox a label is tied to at click time, and puts it back', async () => {
    const { doc, widget } = page(
      '<div role="listbox" id="g-listbox"><label role="option" id="opt">Female</label></div><input type="checkbox" id="consent" form="f">'
    )
    doc.addEventListener('click', (e) => {
      if ((e.target as Element).id === 'opt') (e.target as HTMLLabelElement).htmlFor = 'consent'
    }, true)
    const result = await pick(widget, female, { timeoutMs: 200 })
    expect(result).toMatchObject({ status: 'failed', halt: true })
    expect((doc.getElementById('consent') as HTMLInputElement).checked).toBe(false)
  })

  it('reads aria-labelledby names on the path: an option inside an externally named Next button is refused', async () => {
    const { doc, widget, clicked } = page(
      '<span id="next-name">Next</span><div role="listbox" id="g-listbox"><button type="button" id="next" aria-labelledby="next-name"><span role="option" id="opt">Female</span></button></div>'
    )
    const advanced: string[] = []
    doc.addEventListener('mousedown', () => doc.getElementById('next')?.addEventListener('click', () => advanced.push('next')), { once: true })
    expect(await pick(widget, female, { timeoutMs: 200 })).toMatchObject({ status: 'failed' })
    expect(advanced).toEqual([])
    expect(clicked).not.toContain('opt')
  })

  it("does not take another field's listbox inside a region the control names", async () => {
    const { doc, widget, clicked } = page(
      `<div id="panel"><input role="combobox" id="other" aria-controls="other-list">
         <div role="listbox" id="other-list" aria-labelledby="other"><div role="option" id="theirs">Female</div></div></div>`,
      { controls: 'panel' }
    )
    const handled: string[] = []
    doc.addEventListener('mousedown', () => doc.getElementById('theirs')?.addEventListener('click', () => handled.push('theirs')), { once: true })
    expect(await pick(widget, female, { timeoutMs: 150 })).toMatchObject({ status: 'failed' })
    expect(handled).toEqual([])
    expect(clicked).not.toContain('theirs')
  })

  it('the safety net: a click re-sent outside, an outside checkbox ticked or a step change stops the pick, and the net is removed after', async () => {
    const resent = page('<div role="listbox" id="g-listbox"><div role="option" id="opt">Female</div></div>')
    const outside: string[] = []
    resent.doc.getElementById('submit')!.addEventListener('click', (e) => {
      e.preventDefault()
      outside.push('submit button')
    })
    resent.doc.addEventListener('click', (e) => {
      // A page handler that forwards the option's click to the form's Submit button.
      if ((e.target as Element).id === 'opt') resent.doc.getElementById('submit')!.dispatchEvent(new resent.doc.defaultView!.MouseEvent('click', { bubbles: true }))
    })
    expect(await pick(resent.widget, female, { timeoutMs: 200 })).toMatchObject({ status: 'failed', halt: true })
    expect(outside).toEqual([])
    expect(resent.fired).toEqual([])
    // Removed afterwards: the page's own clicks work again.
    resent.doc.getElementById('submit')!.dispatchEvent(new resent.doc.defaultView!.MouseEvent('click', { bubbles: true }))
    expect(outside).toEqual(['submit button'])

    const ticked = page('<div role="listbox" id="g-listbox"><div role="option" id="opt">Female</div></div>')
    ticked.doc.getElementById('f')!.insertAdjacentHTML('beforeend', '<input type="checkbox" id="news">')
    ticked.doc.addEventListener('click', (e) => {
      if ((e.target as Element).id === 'opt') (ticked.doc.getElementById('news') as HTMLInputElement).checked = true
    })
    expect(await pick(ticked.widget, female, { timeoutMs: 200 })).toMatchObject({ status: 'failed', halt: true })
    expect((ticked.doc.getElementById('news') as HTMLInputElement).checked).toBe(false)

    const moved = page('<div role="listbox" id="g-listbox"><div role="option" id="opt">Female</div></div>')
    moved.doc.addEventListener('click', (e) => {
      if ((e.target as Element).id === 'opt') moved.doc.defaultView!.history.pushState({}, '', '/apply/step-2')
    })
    expect(await pick(moved.widget, female, { timeoutMs: 200 })).toMatchObject({ status: 'failed', halt: true })
  })

  it('never picks in a widget whose options read like consent', async () => {
    const { widget, clicked } = page('<div role="listbox" id="g-listbox"><div role="option" id="yes">I agree</div><div role="option">I do not agree</div></div>')
    expect(await pick(widget, (o) => o[0] ?? null, { timeoutMs: 200 })).toMatchObject({ status: 'failed', reason: expect.stringMatching(/consent/) })
    expect(clicked).not.toContain('yes')
  })

  it('keeps the net up through cleanup: a submit from the blur that closes the menu is cancelled', async () => {
    const { doc, widget, fired, requestSubmit } = page(
      '<div role="listbox" id="g-listbox"><div role="option" id="opt">Female</div></div><button type="button" id="elsewhere">Elsewhere</button>'
    )
    requestSubmit.mockRestore()
    const g = doc.getElementById('g') as HTMLInputElement
    g.focus()
    // Closing the menu (blur) asks the form to submit; the option's click is forwarded outside (blocked), and the
    // shown value still reads Female, so the pick's own read-back would pass.
    g.addEventListener('blur', () => (doc.getElementById('f') as HTMLFormElement).requestSubmit())
    doc.addEventListener('click', (e) => {
      if ((e.target as Element).id !== 'opt') return
      doc.getElementById('elsewhere')!.dispatchEvent(new doc.defaultView!.MouseEvent('click', { bubbles: true }))
      doc.querySelector('.select__single-value')!.textContent = 'Female'
    })
    const submitted: string[] = []
    doc.getElementById('f')!.addEventListener('submit', () => submitted.push('submit'))
    expect(await pick(widget, female, { timeoutMs: 200 })).toMatchObject({ status: 'failed', halt: true })
    expect(submitted).toEqual([])
    expect(fired).toEqual([])
  })

  it('cancels a label retargeted at click time to a consent checkbox inside the widget, and puts it back', async () => {
    const { doc, widget } = page('<div role="listbox" id="g-listbox"><label role="option" id="opt">Female</label></div>')
    doc.querySelector('.select__container')!.insertAdjacentHTML('beforeend', '<input type="checkbox" id="consent">')
    doc.addEventListener('click', (e) => {
      if ((e.target as Element).id !== 'opt') return
      ;(e.target as HTMLLabelElement).htmlFor = 'consent'
      doc.querySelector('.select__single-value')!.textContent = 'Female'
    }, true)
    const result = await pick(widget, female, { timeoutMs: 200 })
    expect(result).toMatchObject({ status: 'failed', halt: true })
    expect((doc.getElementById('consent') as HTMLInputElement).checked).toBe(false)
  })

  it('stops before any option when the page changes step while the menu opens', async () => {
    const { doc, widget, clicked } = page('<div role="listbox" id="g-listbox"><div role="option" id="opt">Female</div></div>')
    const handled: string[] = []
    doc.getElementById('g')!.addEventListener('mousedown', () => {
      doc.getElementById('opt')?.addEventListener('click', () => handled.push('opt'))
      doc.defaultView!.history.pushState({}, '', '/apply/step-2')
    })
    expect(await pick(widget, female, { timeoutMs: 200 })).toMatchObject({ status: 'failed', halt: true })
    expect(handled).toEqual([])
    expect(clicked).not.toContain('opt')
  })
})

describe('typeaheads (#136) press only their own suggestions and key only a Workday search box', () => {
  /**
   * A search box whose page renders `suggestions` on input, next to a form with a Submit button. `box` is the field's
   * markup (its input has id "q").
   */
  function page(box: string, suggestions: string, { wrapForm = true } = {}) {
    const body = wrapForm ? `<form id="f">${box}<button type="submit" id="submit">Submit application</button></form>` : box
    const dom = new JSDOM(`${body}<div id="elsewhere"></div>`, { url: 'https://example.com/apply' })
    const doc = dom.window.document
    const keys: string[] = []
    const submits: string[] = []
    for (const type of ['keydown', 'keypress', 'keyup']) doc.addEventListener(type, (e) => keys.push(`${type}:${(e as KeyboardEvent).key}`), true)
    doc.addEventListener('submit', (e) => {
      submits.push('submit')
      e.preventDefault()
    }, true)
    const submit = vi.spyOn(dom.window.HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined)
    const requestSubmit = vi.spyOn(dom.window.HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => undefined)
    const input = doc.getElementById('q') as HTMLInputElement
    input.addEventListener('input', () => doc.getElementById('elsewhere')!.insertAdjacentHTML('beforeend', suggestions))
    const clicked: string[] = []
    doc.addEventListener('click', (e) => clicked.push((e.target as Element).id || (e.target as Element).tagName), true)
    const widget = typeaheadOf(input)!
    const noSubmit = () => {
      expect(submits).toEqual([])
      expect(submit).not.toHaveBeenCalled()
      expect(requestSubmit).not.toHaveBeenCalled()
    }
    return { doc, input, widget, keys, clicked, noSubmit, requestSubmit, submits }
  }
  const portland = (options: string[]) => options.find((o) => o.startsWith('Portland')) ?? null

  it('refuses suggestions outside its own list, links and submit buttons', async () => {
    // Two unrelated lists appear and nothing ties either to the input: neither is used.
    const untied = page('<div class="field"><label for="q">City</label><input id="q"></div>', '<ul role="listbox"><li role="option" id="a">Portland</li></ul><ul role="listbox"><li role="option" id="b">Portland</li></ul>')
    expect(await pick(untied.widget, portland, { timeoutMs: 150, search: 'Portland' })).toMatchObject({ status: 'failed' })
    expect(untied.clicked).not.toContain('a')
    expect(untied.clicked).not.toContain('b')
    untied.noSubmit()
    // Its own list (named by aria-controls), but the suggestion is a link, or a submit button.
    for (const option of ['<a href="/away" role="option" id="opt">Portland</a>', '<button type="submit" role="option" id="opt">Portland</button>']) {
      const own = page('<div class="field"><label for="q">City</label><input id="q" aria-controls="list"></div>', `<ul role="listbox" id="list">${option}</ul>`)
      expect(await pick(own.widget, portland, { timeoutMs: 150, search: 'Portland' })).toMatchObject({ status: 'failed' })
      expect(own.clicked).not.toContain('opt')
      own.noSubmit()
    }
    // A refusal names the list explicitly: an option in another control's list is outside.
    const other = page('<div class="field"><input id="q"></div><input role="combobox" aria-controls="theirs">', '<ul role="listbox" id="theirs"><li role="option" id="t">Portland</li></ul>')
    expect(await pick(other.widget, portland, { timeoutMs: 150, search: 'Portland' })).toMatchObject({ status: 'failed' })
    expect(refusal(other.doc.getElementById('t')!, other.widget)).toMatch(/outside/)
    expect(other.keys).toEqual([])
  })

  it('never sends Enter outside a Workday search box (a plain input, a search box in a form or outside a prompt)', async () => {
    const cases = [
      page('<div class="field"><input id="q"></div>', ''),
      page('<div data-automation-id="formField-x"><div data-automation-id="multiSelectContainer"><input id="q" data-automation-id="searchBox"></div></div>', ''),
      page('<div data-automation-id="formField-x"><input id="q" data-automation-id="searchBox"></div>', '', { wrapForm: false })
    ]
    for (const c of cases) {
      expect(await pick(c.widget, portland, { timeoutMs: 120, search: 'Portland' })).toMatchObject({ status: 'failed' })
      expect(c.keys).toEqual([])
      expect(c.input.value).toBe('')
      c.noSubmit()
    }
  })

  it('sends one Enter to a Workday search box outside any form, and still never submits', async () => {
    const c = page(
      '<div data-automation-id="formField-x"><div data-automation-id="multiSelectContainer"><input id="q" data-automation-id="searchBox"></div></div><form id="other"><button type="submit">Submit</button></form>',
      '',
      { wrapForm: false }
    )
    // Like Workday: results only on Enter; this page also asks a form to submit when it sees the key (for real).
    c.requestSubmit.mockRestore()
    c.input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return
      ;(c.doc.getElementById('other') as HTMLFormElement).requestSubmit()
      c.doc.body.insertAdjacentHTML('beforeend', '<div data-automation-id="activeListContainer" role="listbox"><div data-automation-id="promptOption" data-automation-label="Portland" id="p">Portland</div></div>')
    })
    c.doc.addEventListener('click', (e) => {
      if ((e.target as Element).id === 'p') c.doc.querySelector('[data-automation-id="multiSelectContainer"]')!.insertAdjacentHTML('afterbegin', '<div data-automation-id="selectedItem" data-automation-label="Portland">Portland</div>')
    })
    const result = await pick(c.widget, portland, { timeoutMs: 300, search: 'Portland' })
    expect(c.keys).toEqual(['keydown:Enter', 'keyup:Enter'])
    // The submit the page asked for was cancelled by the safety net before anything saw it; the pick fails closed.
    expect(c.submits).toEqual([])
    expect(result).toMatchObject({ status: 'failed', halt: true })
  })
})

/**
 * #136: the two presses outside a widget's options, for Workday My Experience. `pressAdd` presses only a section's
 * own Add / Add Another button; `pressToggle` ticks only "I currently work here" or a disability status box.
 */
describe('pick.ts: Add buttons and the two allowed check boxes (#136)', () => {
  function page() {
    const dom = new JSDOM(
      `<div data-automation-id="applyFlowPage">
        <div data-automation-id="workExperienceSection" id="sec">
          <div id="workExperience-1" role="group">
            <div data-automation-id="formField-currentlyWorkHere"><input type="checkbox" id="current"><label for="current">I currently work here</label></div>
            <button type="button" data-automation-id="panel-set-delete-button" id="delete">Delete</button>
          </div>
          <button type="button" data-automation-id="Add" aria-label="Add Another Work Experience" id="add">Add Another</button>
          <button type="button" id="next-in-section">Next</button>
          <button type="button" id="save-in-section" aria-label="Save">Add</button>
          <a href="/x" id="link-add">Add</a>
        </div>
        <div data-automation-id="educationSection" id="edu"><button type="button" data-automation-id="Add" id="edu-add">Add</button></div>
        <div data-automation-id="formField-acceptTermsAndAgreements"><input type="checkbox" id="terms"><label for="terms">I accept the terms</label></div>
        <div data-automation-id="formField-other"><input type="checkbox" id="other"><label for="other">Remember me</label></div>
        <div data-automation-id="pageFooter" id="footer"><button type="button" data-automation-id="Add" id="footer-add">Add</button>
          <button type="button" data-automation-id="bottom-navigation-next-button" id="next">Save and Continue</button></div>
      </div>`,
      { url: 'https://acme.wd1.myworkdayjobs.com/x/apply' }
    )
    const doc = dom.window.document
    const clicked: string[] = []
    doc.addEventListener('click', (e) => clicked.push((e.target as Element).id), true)
    const el = (id: string) => doc.getElementById(id) as HTMLElement
    return { dom, doc, el, clicked, state: () => 'same' }
  }

  it('refuses Next, Save, Delete, links, footer buttons and buttons outside the section', () => {
    const { el } = page()
    const section = el('sec')
    expect(addRefusal(el('add'), section)).toBeNull()
    expect(addRefusal(el('next-in-section'), section)).toMatch(/not named Add/)
    expect(addRefusal(el('save-in-section'), section)).toMatch(/not named Add/)
    expect(addRefusal(el('delete'), section)).toMatch(/not named Add/)
    expect(addRefusal(el('link-add'), section)).toMatch(/not a button/)
    expect(addRefusal(el('edu-add'), section)).toMatch(/outside its section/)
    expect(addRefusal(el('footer-add'), el('footer'))).toMatch(/navigation/)
    expect(addRefusal(el('next'), section)).toMatch(/outside/)
  })

  it('presses nothing it refuses, and the Add button it may, once', async () => {
    const { el, clicked, state } = page()
    for (const id of ['next-in-section', 'save-in-section', 'delete', 'edu-add', 'footer-add', 'next']) {
      expect(await pressAdd(el(id), el('sec'), () => true, { pageState: state, timeoutMs: 20 })).toMatchObject({ status: 'failed' })
    }
    expect(clicked).toEqual([])
    const result = await pressAdd(el('add'), el('sec'), () => clicked.includes('add'), { pageState: state, timeoutMs: 50 })
    expect(result).toMatchObject({ status: 'filled' })
    expect(clicked).toEqual(['add'])
  })

  it('stops when a page handler re-sends the Add press to Save and Continue, or the step changes', async () => {
    const { dom, el, clicked } = page()
    el('add').addEventListener('click', () => el('next').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    const result = await pressAdd(el('add'), el('sec'), () => true, { pageState: () => 'same', timeoutMs: 20 })
    expect(result).toMatchObject({ status: 'failed', halt: true })
    let step = 'my-experience'
    const moved = await pressAdd(el('add'), el('sec'), () => false, {
      pageState: () => {
        const now = step
        step = 'next'
        return now
      },
      timeoutMs: 20
    })
    expect(moved).toMatchObject({ status: 'failed' })
    // The re-sent click never reached Save and Continue (the net cancels it before the page sees it).
    expect(clicked.filter((id) => id === 'next')).toEqual([])
  })

  it('ticks only "I currently work here" (or a disability status box), never terms or another check box', async () => {
    const { el, state } = page()
    expect(toggleRefusal(el('terms'))).toMatch(/other than/)
    expect(toggleRefusal(el('other'))).toMatch(/other than/)
    expect(await pressToggle(el('terms') as HTMLInputElement, { pageState: state })).toMatchObject({ status: 'failed' })
    expect(await pressToggle(el('other') as HTMLInputElement, { pageState: state })).toMatchObject({ status: 'failed' })
    expect((el('terms') as HTMLInputElement).checked).toBe(false)
    expect((el('other') as HTMLInputElement).checked).toBe(false)
    expect(await pressToggle(el('current') as HTMLInputElement, { pageState: state, timeoutMs: 50 })).toMatchObject({ status: 'filled' })
    expect((el('current') as HTMLInputElement).checked).toBe(true)
    // Never unticked: a ticked box is refused.
    expect(toggleRefusal(el('current'))).toMatch(/already ticked/)
  })

  it('puts back any other check box a page handler ticks during the toggle', async () => {
    const { el, state } = page()
    el('current').addEventListener('click', () => ((el('terms') as HTMLInputElement).checked = true))
    const result = await pressToggle(el('current') as HTMLInputElement, { pageState: state, timeoutMs: 50 })
    expect(result).toMatchObject({ status: 'failed', halt: true })
    expect((el('terms') as HTMLInputElement).checked).toBe(false)
  })
})
