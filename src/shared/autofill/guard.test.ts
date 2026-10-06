import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { FillValues } from '../apply-types'
import { fillPage, scanPage } from './engine'
import { pick, refusal, widgetOf } from './pick'

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
    join(ROOT, 'src/main/apply/upload.ts')
  ]
}

describe('no-submit guard', () => {
  it('covers the engine, the page preload and the apply service', () => {
    expect(pageSources().length).toBeGreaterThanOrEqual(14)
    expect(pageSources().some((f) => f.endsWith('adapters/greenhouse.ts'))).toBe(true)
  })

  for (const file of pageSources()) {
    it(`${file.slice(ROOT.length + 1)} cannot submit, click or type`, () => {
      const source = readFileSync(file, 'utf8')
      for (const pattern of file === PICK_MODULE ? PICK_FORBIDDEN : FORBIDDEN) expect(source, `${pattern} in ${file}`).not.toMatch(pattern)
    })
  }
})

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
const VALUES: FillValues = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+1 555 123 4567',
  location: 'London',
  linkedin: 'https://www.linkedin.com/in/ada',
  github: '',
  website: '',
  currentCompany: ''
}

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
  function page(menu: string) {
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
      doc.getElementById('g')!.setAttribute('aria-controls', 'g-listbox')
      doc.body.insertAdjacentHTML('beforeend', menu)
    })
    const widget = widgetOf(doc.getElementById('g')!)!
    return { doc, widget, fired, submit, requestSubmit }
  }

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
})
