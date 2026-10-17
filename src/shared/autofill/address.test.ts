import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { FieldReport, FillReport } from '../apply-types'
import { workdayWidgets } from '../../../scripts/mock-ats/workday.mjs'
import { fillPage, pendingPicks, pickAnswers, verifyFill } from './engine'
import { matchChoiceField, matchTextField } from './match'
import type { FormControl } from './dom'
import { testValues, US_ADDRESS } from './fixtures/values'

/**
 * #136: addresses, dropdowns and typeaheads filled from the master profile.
 * The Workday fixtures run with the mock's own widget script
 * (scripts/mock-ats/workday.mjs `workdayWidgets`), Greenhouse with the mock
 * react-select, Lever with the mock site script, so the tests drive the same
 * behaviour as `node scripts/mock-ats.mjs`.
 */

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
const site = (name: string) => readFileSync(join(__dirname, '../../../scripts/mock-ats/sites', name), 'utf8')
const VALUES = testValues(US_ADDRESS)
const WORKDAY = 'https://acme.wd1.myworkdayjobs.com/en-US/AcmeCareers/job/Remote-USA/Software-Engineer_JR-1001/apply'
const GREENHOUSE = 'https://job-boards.greenhouse.io/acme/jobs/1000001'
const LEVER = 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000001/apply'

const field = (report: FillReport, label: string): FieldReport => {
  const found = report.fields.find((f) => f.label === label)
  if (!found) throw new Error(`No field "${label}" in ${report.fields.map((f) => f.label).join(' | ')}`)
  return found
}
const value = (dom: JSDOM, selector: string) => (dom.window.document.querySelector(selector) as HTMLInputElement).value

/** No submit and no form submission; returns the key events seen (target automation id or tag + key). */
function watch(dom: JSDOM) {
  const w = dom.window
  const submit = vi.spyOn(w.HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined)
  const requestSubmit = vi.spyOn(w.HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => undefined)
  const submits: string[] = []
  const keys: string[] = []
  w.document.addEventListener('submit', () => submits.push('submit'), true)
  for (const type of ['keydown', 'keypress', 'keyup']) {
    w.document.addEventListener(
      type,
      (e) => keys.push(`${type}:${(e as KeyboardEvent).key}:${(e.target as Element).getAttribute('data-automation-id') ?? (e.target as Element).tagName}`),
      true
    )
  }
  return {
    keys,
    check() {
      expect(submit).not.toHaveBeenCalled()
      expect(requestSubmit).not.toHaveBeenCalled()
      expect(submits).toEqual([])
    }
  }
}

describe('the generic matcher: address rules (#136)', () => {
  const control = (html: string): FormControl => {
    const dom = new JSDOM(`<form>${html}</form>`)
    return dom.window.document.querySelector('input, select') as FormControl
  }
  const text = (html: string) => matchTextField(control(html))?.key ?? null

  it('maps each label to its address part, in order', () => {
    const cases: Array<[string, string | null]> = [
      ['<label for="x">Address</label><input id="x">', 'addressLine1'],
      ['<label for="x">Street</label><input id="x">', 'addressLine1'],
      ['<label for="x">Address Line 1</label><input id="x">', 'addressLine1'],
      ['<input name="address1">', 'addressLine1'],
      ['<label for="x">Address Line 2</label><input id="x">', null],
      ['<label for="x">Address 2</label><input id="x">', null],
      ['<label for="x">Apt, suite, unit</label><input id="x">', null],
      ['<label for="x">City</label><input id="x">', 'city'],
      ['<label for="x">Town</label><input id="x">', 'city'],
      ['<label for="x">State</label><input id="x">', 'state'],
      ['<label for="x">Province / Region</label><input id="x">', 'state'],
      ['<label for="x">ZIP</label><input id="x">', 'postalCode'],
      ['<label for="x">Postal code</label><input id="x">', 'postalCode'],
      ['<label for="x">Post code</label><input id="x">', 'postalCode'],
      ['<label for="x">Country</label><input id="x">', 'country'],
      ['<label for="x">Country code</label><input id="x">', null],
      ['<label for="x">Phone code</label><input id="x">', null],
      ['<label for="x">Dial code</label><input id="x">', null],
      ['<label for="x">Location</label><input id="x">', 'location'],
      ['<label for="x">Where are you based?</label><input id="x">', 'location'],
      ['<label for="x">Current location</label><input id="x">', 'location'],
      ['<label for="x">City and state</label><input id="x">', 'location'],
      ['<label for="x">City, State</label><input id="x">', 'location'],
      ['<label for="x">Email address</label><input id="x">', 'email'],
      ['<label for="x">Country of citizenship</label><input id="x">', null],
      ['<input autocomplete="address-level2">', 'city'],
      ['<input autocomplete="shipping address-level1">', 'state']
    ]
    for (const [html, key] of cases) expect(text(html), html).toBe(key)
  })

  it('takes a country, state or city dropdown only when it says exactly that', () => {
    const choice = (html: string) => matchChoiceField(control(html))?.key ?? null
    expect(choice('<label for="x">Country</label><select id="x"></select>')).toBe('country')
    expect(choice('<label for="x">State / Province</label><select id="x"></select>')).toBe('state')
    expect(choice('<select name="country_id"></select>')).toBe('country')
    expect(choice('<select autocomplete="country"></select>')).toBe('country')
    expect(choice('<label for="x">Are you authorized to work in the United States?</label><select id="x"></select>')).toBeNull()
    expect(choice('<label for="x">Gender</label><select id="x"></select>')).toBeNull()
    expect(choice('<label for="x">Location</label><select id="x"></select>')).toBeNull()
  })
})

describe('generic forms: address fields (#136)', () => {
  const FORM = `<form id="f">
    <label for="a1">Street address</label><input id="a1" name="addr1">
    <label for="a2">Address line 2</label><input id="a2" name="addr2">
    <label for="apt">Apt / Suite</label><input id="apt" name="apt">
    <label for="city">City</label><input id="city" name="city">
    <label for="st">State</label><select id="st" name="st"><option value="">Select…</option><option value="ME">ME</option><option value="OR">OR</option></select>
    <label for="zip">Zip code</label><input id="zip" name="zip">
    <label for="ctry">Country</label><select id="ctry" name="ctry"><option value="">Choose</option><option>Canada</option><option>United States of America</option></select>
    <label for="cc">Phone country code</label><input id="cc" name="phone_cc">
    <label for="where">Location (city, state)</label><input id="where" name="where">
    <label for="auth">Are you legally authorized to work in the United States?</label><select id="auth"><option value="">Select</option><option>Yes</option><option>No</option></select>
    <button type="submit">Apply</button></form>`
  const page = () => new JSDOM(FORM, { url: 'https://careers.example.com/jobs/1/apply' })

  it('fills street, city, state, zip, country and location, never line 2 or the phone code', () => {
    const dom = page()
    const w = watch(dom)
    const report = fillPage(dom.window.document, VALUES)
    expect(field(report, 'Street address')).toMatchObject({ key: 'addressLine1', outcome: 'filled', value: '1 Main St' })
    expect(field(report, 'City')).toMatchObject({ key: 'city', outcome: 'filled', value: 'Portland' })
    // The bug in the issue: a City field never gets the whole location line.
    expect(value(dom, '#city')).toBe('Portland')
    expect(field(report, 'Zip code')).toMatchObject({ key: 'postalCode', outcome: 'filled', value: '97201' })
    expect(field(report, 'Location (city, state)')).toMatchObject({ key: 'location', outcome: 'filled', value: 'Portland, OR' })
    // Native selects: the option that is the value (OR for Oregon, United States of America for United States).
    expect(field(report, 'State')).toMatchObject({ key: 'state', kind: 'select', outcome: 'filled', value: 'OR' })
    expect(value(dom, '#st')).toBe('OR')
    expect(field(report, 'Country')).toMatchObject({ key: 'country', kind: 'select', outcome: 'filled', value: 'United States of America' })
    expect(field(report, 'Address line 2')).toMatchObject({ key: null, outcome: 'unmatched' })
    expect(field(report, 'Apt / Suite')).toMatchObject({ key: null, outcome: 'unmatched' })
    expect(field(report, 'Phone country code')).toMatchObject({ key: null, outcome: 'unmatched' })
    for (const id of ['#a2', '#apt', '#cc']) expect(value(dom, id), id).toBe('')
    // A question that mentions the United States is not a country dropdown.
    expect(field(report, 'Are you legally authorized to work in the United States?')).toMatchObject({ key: null, outcome: 'skipped-unsupported' })
    expect(value(dom, '#auth')).toBe('')
    w.check()
  })

  it('matches by autocomplete tokens', () => {
    const dom = new JSDOM(
      `<form><input id="x1" autocomplete="address-line1"><input id="x2" autocomplete="address-line2"><input id="x3" autocomplete="address-level2">
       <input id="x4" autocomplete="address-level1"><input id="x5" autocomplete="postal-code"><input id="x6" autocomplete="country-name"></form>`,
      { url: 'https://careers.example.com/apply' }
    )
    const report = fillPage(dom.window.document, VALUES)
    expect(report.fields.map((f) => [f.key, f.outcome])).toEqual([
      ['addressLine1', 'filled'],
      [null, 'unmatched'],
      ['city', 'filled'],
      ['state', 'filled'],
      ['postalCode', 'filled'],
      ['country', 'filled']
    ])
    expect(value(dom, '#x4')).toBe('Oregon')
  })

  it('keeps a select that already shows another answer, and a value the profile lacks is reported', () => {
    const dom = page()
    ;(dom.window.document.getElementById('ctry') as HTMLSelectElement).value = 'Canada'
    const report = fillPage(dom.window.document, testValues({ ...US_ADDRESS, state: '' }))
    expect(field(report, 'Country')).toMatchObject({ outcome: 'kept', value: 'Canada' })
    expect(field(report, 'State')).toMatchObject({ key: 'state', outcome: 'skipped-no-value' })
    expect(value(dom, '#st')).toBe('')
  })
})

describe('Workday My Information: address and phone dropdowns (#136)', () => {
  function workday(name: string): JSDOM {
    const dom = new JSDOM(fixture(name), { url: WORKDAY, runScripts: 'outside-only' })
    dom.window.eval(`(${workdayWidgets.toString()})()`)
    return dom
  }
  const buttonText = (dom: JSDOM, selector: string) => dom.window.document.querySelector(selector)!.textContent

  const tenants: Array<[string, Record<string, string>]> = [
    [
      'workday-my-information.html',
      { addressLine1: '#address--addressLine1', city: '#address--city', postalCode: '#address--postalCode', state: '#address--countryRegion', phoneType: '#phoneNumber--phoneType' }
    ],
    [
      'workday-my-information-legacy.html',
      {
        addressLine1: '[data-automation-id="addressSection_addressLine1"]',
        city: '[data-automation-id="addressSection_city"]',
        postalCode: '[data-automation-id="addressSection_postalCode"]',
        state: '[data-automation-id="addressSection_countryRegion"]',
        phoneType: '[data-automation-id="phone-device-type"]'
      }
    ]
  ]

  for (const [name, sel] of tenants) {
    it(`${name}: fills the address, picks State, keeps Country, picks Phone Device Type and Country Phone Code`, async () => {
      const dom = workday(name)
      const doc = dom.window.document
      const w = watch(dom)
      const report = fillPage(doc, VALUES, { pick: true })
      expect(value(dom, sel.addressLine1)).toBe('1 Main St')
      expect(value(dom, sel.city)).toBe('Portland')
      expect(value(dom, sel.postalCode)).toBe('97201')
      expect(pendingPicks(report).map((p) => p.line.label)).toEqual(['State', 'Phone Device Type', 'Country Phone Code'])
      await pickAnswers(report)
      expect(field(report, 'State')).toMatchObject({ key: 'state', outcome: 'filled', value: 'Oregon' })
      expect(buttonText(dom, sel.state)).toBe('Oregon')
      expect(field(report, 'Country')).toMatchObject({ key: 'country', outcome: 'filled', value: 'United States of America' })
      expect(field(report, 'Phone Device Type')).toMatchObject({ key: null, outcome: 'filled', value: 'Mobile' })
      expect(buttonText(dom, sel.phoneType)).toBe('Mobile')
      expect(field(report, 'Country Phone Code')).toMatchObject({ outcome: 'filled', value: 'United States of America (+1)' })
      // Every popup closed; How Did You Hear (no profile value, nothing remembered) was never opened.
      expect(doc.querySelectorAll('[role="listbox"]')).toHaveLength(0)
      expect(field(report, 'How Did You Hear About Us?')).toMatchObject({ outcome: 'skipped-unsupported' })
      // The prompt (newer tenants) got one Enter in its search box; nothing else got a key.
      expect(w.keys).toEqual(name.includes('legacy') ? [] : ['keydown:Enter:searchBox', 'keyup:Enter:searchBox'])
      expect(buttonText(dom, '[data-automation-id="bottom-navigation-next-button"]')).toBe('Save and Continue')
      w.check()

      // The verify pass reads the picks back and keeps them; nothing is pressed again.
      const clicks: string[] = []
      doc.addEventListener('click', (e) => clicks.push((e.target as Element).tagName), true)
      await verifyFill(doc, VALUES, report, { settleMs: 1 })
      expect(clicks).toEqual([])
      for (const label of ['State', 'Country', 'Phone Device Type', 'Country Phone Code']) expect(field(report, label).outcome, label).toBe('filled')
    })
  }

  it('picks the phone code of the profile country (Canada), not the first +1 entry', async () => {
    const dom = workday('workday-my-information.html')
    const doc = dom.window.document
    const report = fillPage(doc, testValues({ ...US_ADDRESS, location: 'Toronto, ON', state: 'Ontario', country: 'Canada' }), { pick: true })
    // The page shows the United States as its country: another answer, kept.
    expect(field(report, 'Country')).toMatchObject({ outcome: 'kept', value: 'United States of America' })
    await pickAnswers(report)
    expect(field(report, 'Country Phone Code')).toMatchObject({ outcome: 'filled', value: 'Canada (+1)' })
    // Ontario is not in the (US) State list: reported for the user, nothing chosen.
    expect(field(report, 'State')).toMatchObject({ outcome: 'rejected' })
    expect(doc.getElementById('address--countryRegion')!.textContent).toBe('Select One')
  })

  it('leaves a prompt whose search finds nothing to the user, with the typed text cleared', async () => {
    const dom = workday('workday-my-information.html')
    const doc = dom.window.document
    const report = fillPage(doc, testValues({ ...US_ADDRESS, country: 'Narnia', state: '' }), { pick: true })
    await pickAnswers(report)
    expect(field(report, 'Country Phone Code')).toMatchObject({ outcome: 'rejected', reason: expect.stringMatching(/could not pick "Narnia"/) })
    expect(value(dom, '#phoneNumber--countryPhoneCode')).toBe('')
    expect(doc.querySelector('[data-automation-id="selectedItem"]')).toBeNull()
  })

  it('without the pick switch nothing is opened, typed or keyed', async () => {
    const dom = workday('workday-my-information.html')
    const w = watch(dom)
    const report = fillPage(dom.window.document, VALUES, { pick: false })
    expect(pendingPicks(report)).toEqual([])
    expect(field(report, 'State')).toMatchObject({ outcome: 'skipped-unsupported', reason: expect.stringContaining('"Oregon"') })
    expect(value(dom, '#phoneNumber--countryPhoneCode')).toBe('')
    expect(w.keys).toEqual([])
  })
})

describe('location typeaheads (#136)', () => {
  function greenhouse(): JSDOM {
    const dom = new JSDOM(fixture('greenhouse-form.html'), { url: GREENHOUSE, runScripts: 'outside-only' })
    const container = dom.window.document.getElementById('candidate-location')!.closest('.select__container') as HTMLElement
    container.dataset.mockAsyncOptions = 'Portland, Maine, United States|Portland, Oregon, United States|Portsmouth, New Hampshire, United States'
    container.dataset.mockDelay = '50'
    const country = dom.window.document.getElementById('country')!.closest('.select__container') as HTMLElement
    country.dataset.mockOptions = 'Canada +1|India +91|United States +1'
    dom.window.eval(site('react-select.js'))
    return dom
  }
  const shown = (dom: JSDOM) =>
    dom.window.document.getElementById('candidate-location')!.closest('.select__container')!.querySelector('.select__single-value')?.textContent ?? ''

  it('Greenhouse: types the city, waits for the suggestions and picks the one in the profile state', async () => {
    const dom = greenhouse()
    const w = watch(dom)
    const report = fillPage(dom.window.document, VALUES, { pick: true })
    expect(pendingPicks(report).map((p) => [p.line.label, p.search])).toContainEqual(['Location (City)', 'Portland'])
    await pickAnswers(report)
    expect(field(report, 'Location (City)')).toMatchObject({ key: 'location', outcome: 'filled', value: 'Portland, Oregon, United States' })
    expect(shown(dom)).toBe('Portland, Oregon, United States')
    // The phone's Country picker takes the profile's country, whatever dial code the site appends.
    expect(field(report, 'Country')).toMatchObject({ key: 'country', outcome: 'filled', value: 'United States +1' })
    // The free-text question still gets the profile's location line.
    expect(field(report, "What's your current location (both city and state)?")).toMatchObject({ key: 'location', outcome: 'filled' })
    expect(w.keys).toEqual([])
    w.check()
    await verifyFill(dom.window.document, VALUES, report, { settleMs: 1 })
    expect(field(report, 'Location (City)')).toMatchObject({ outcome: 'filled', value: 'Portland, Oregon, United States' })
  })

  it('Greenhouse: no suggestion fits (another state only): nothing picked, the text cleared, left to the user', async () => {
    const dom = greenhouse()
    const doc = dom.window.document
    const pressed: string[] = []
    doc.addEventListener('click', (e) => {
      const target = e.target as Element
      if (target.getAttribute('role') === 'option' && target.id.includes('candidate-location')) pressed.push(target.textContent ?? '')
    }, true)
    const report = fillPage(doc, testValues({ location: 'Portland, TX', city: 'Portland', state: 'Texas', country: 'United States' }), { pick: true })
    await pickAnswers(report)
    expect(pressed).toEqual([])
    expect(field(report, 'Location (City)')).toMatchObject({ outcome: 'rejected', reason: expect.stringMatching(/None of the suggestions fits/) })
    expect(shown(dom)).toBe('')
    expect(value(dom, '#candidate-location')).toBe('')
  })

  function lever(): JSDOM {
    const dom = new JSDOM(fixture('lever-form.html'), { url: LEVER, runScripts: 'outside-only' })
    dom.window.eval(site('lever.js'))
    return dom
  }

  it('Lever: types the city and picks the matching suggestion (input and hidden value set)', async () => {
    const dom = lever()
    const w = watch(dom)
    const report = fillPage(dom.window.document, VALUES, { pick: true })
    await pickAnswers(report)
    expect(field(report, 'Current location')).toMatchObject({ key: 'location', kind: 'text', outcome: 'filled', value: 'Portland, OR, United States' })
    expect(value(dom, '#location-input')).toBe('Portland, OR, United States')
    expect(JSON.parse(value(dom, '#selected-location'))).toEqual({ name: 'Portland, OR, United States' })
    expect(w.keys).toEqual([])
    w.check()
    // The verify pass keeps the picked suggestion (it never types the profile's "Portland, OR" over it).
    await verifyFill(dom.window.document, VALUES, report, { settleMs: 1 })
    expect(field(report, 'Current location')).toMatchObject({ outcome: 'filled', value: 'Portland, OR, United States' })
    expect(value(dom, '#location-input')).toBe('Portland, OR, United States')
  })

  it('Lever: a location with no suggestion is left empty for the user', async () => {
    const dom = lever()
    const report = fillPage(dom.window.document, testValues({ location: 'Springfield, IL', city: 'Springfield', state: 'Illinois' }), { pick: true })
    await pickAnswers(report)
    expect(field(report, 'Current location')).toMatchObject({ outcome: 'rejected', reason: expect.stringMatching(/No suggestions appeared/) })
    expect(value(dom, '#location-input')).toBe('')
  })

  it('Lever: a picked location the page clears later is reported, not typed again', async () => {
    const dom = lever()
    const doc = dom.window.document
    const report = fillPage(doc, VALUES, { pick: true })
    await pickAnswers(report)
    ;(doc.getElementById('location-input') as HTMLInputElement).value = ''
    await verifyFill(doc, VALUES, report, { settleMs: 1 })
    expect(field(report, 'Current location')).toMatchObject({ outcome: 'rejected' })
    expect(value(dom, '#location-input')).toBe('')
  })
})
