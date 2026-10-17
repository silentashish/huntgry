/**
 * Where Workday keeps the repeatable sections of My Experience (#136): Work
 * Experience, Education and Websites (blocks added with the section's own
 * Add / Add Another button), the Skills prompt, and the date questions and
 * disability check boxes of the answer-only steps. Pure DOM reads, no
 * presses: the Workday adapter uses them to leave these controls out of the
 * engine's plan, and `sections.ts` to fill them from the profile.
 *
 * Markup (two shapes seen in open-source Workday fillers and a rebuilt
 * reference flow): a section container `[data-automation-id="workExperienceSection"]`
 * holding blocks `#workExperience-1`, `#workExperience-2`… and the Add
 * button; or every block itself marked `workExperienceSection` with the id
 * `workExperience-N`, under a heading "Work Experience" and the Add button.
 * Fields by `formField-<name>` wrapper or by an id ending in `--<name>`.
 */

export type SectionKind = 'experience' | 'education' | 'website'

interface KindInfo {
  /** `data-automation-id` of the section (or, on some tenants, of each block). */
  sectionId: string
  /** Block ids: `workExperience-3`. */
  blockId: RegExp
  /** The section's heading text. */
  heading: RegExp
  /** The words an Add button may name ("Add Work Experience"). */
  addWords: RegExp
  /** A field every block has (for blocks without numbered ids). */
  anchor: string
}

export const KINDS: Record<SectionKind, KindInfo> = {
  experience: {
    sectionId: 'workExperienceSection',
    blockId: /^workExperience-\d+$/,
    heading: /^work experience$/i,
    addWords: /work experience/i,
    anchor: 'jobTitle'
  },
  education: {
    sectionId: 'educationSection',
    blockId: /^education-\d+$/,
    heading: /^education$/i,
    addWords: /education/i,
    anchor: 'school'
  },
  website: {
    sectionId: 'websiteSection',
    blockId: /^(website|webAddress)-\d+$/,
    heading: /^websites?$/i,
    addWords: /websites?/i,
    anchor: 'url'
  }
}

const aid = (id: string) => `[data-automation-id="${id}"]`
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

/**
 * What an Add button may be called: "Add", "Add Another", optionally naming its section ("Add Work Experience",
 * "Add Another Education", "Add Websites", "Add Language"). Anything else is never pressed (pick.ts checks it
 * again).
 */
export const ADD_NAME = /^add( another)?( work experience| education| websites?| languages?)?$/i

/** The page's own navigation: no Add button there is ever pressed (Next, Save and Continue, Back live here). */
export const NAV_AREAS = [
  aid('pageFooter'),
  '[data-automation-id^="bottom-navigation"]',
  aid('footerContainer'),
  'footer'
].join(', ')

/** The section's Add buttons: named like an Add button, for this section or no section, never in the page's navigation. */
function addButtonsIn(scope: Element, kind: SectionKind): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>('button, [role="button"]')).filter((b) => {
    const label = (b.getAttribute('aria-label') ?? '').trim()
    const shown = text(b)
    if (!shown && !label) return false
    if ((label && !ADD_NAME.test(label)) || (shown && !ADD_NAME.test(shown))) return false
    if (b.closest(NAV_AREAS)) return false
    // A button naming another section ("Add Education" in Work Experience) is that section's.
    const named = `${label} ${shown}`
    const other = (Object.keys(KINDS) as SectionKind[]).some((k) => k !== kind && KINDS[k].addWords.test(named))
    return !other
  })
}

/** The section's Add / Add Another button (the last one: Workday shows "Add Another" below the blocks). */
export function addButtonOf(section: Element, kind: SectionKind): HTMLElement | null {
  const buttons = addButtonsIn(section, kind).filter((b) => !blocksOf(section, kind).some((block) => block.contains(b)))
  return buttons.at(-1) ?? null
}

/** Field wrappers or controls of `name` inside `scope`: `formField-<name>`, or an id ending in `--<name>`. */
export function fieldOf(scope: ParentNode, names: readonly string[]): Element | null {
  for (const name of names) {
    const el = scope.querySelector(`${aid(`formField-${name}`)}, [id$="--${name}"]`)
    if (el) return el
  }
  return null
}

/** Whether `el` holds things a section never contains (the resume upload, the navigation): not a section. */
const tooBroad = (el: Element) => el.querySelector(`${aid('file-upload-input-ref')}, ${NAV_AREAS}`) !== null || el.matches(aid('applyFlowPage'))

/** Elements with an id of this kind's blocks. */
const numbered = (scope: ParentNode, kind: SectionKind) =>
  Array.from(scope.querySelectorAll('[id]')).filter((el) => KINDS[kind].blockId.test(el.id))

/**
 * The section of `kind` on the page, or null: the section container, else the smallest ancestor of its blocks
 * (or of its heading) that also holds its Add button. Never anything holding the resume upload or the navigation.
 */
export function sectionOf(doc: Document, kind: SectionKind): Element | null {
  const info = KINDS[kind]
  const marked = Array.from(doc.querySelectorAll(aid(info.sectionId)))
  const container = marked.find((el) => !info.blockId.test(el.id) && !tooBroad(el))
  if (container) return container
  const starts = numbered(doc, kind)
  if (starts.length === 0) {
    const heading = Array.from(doc.querySelectorAll('h2, h3, h4')).find((h) => info.heading.test(text(h)))
    if (heading) starts.push(heading)
  }
  if (starts.length === 0) return null
  let scope: Element | null = starts[0].parentElement
  for (let i = 0; scope && i < 5; i++, scope = scope.parentElement) {
    if (tooBroad(scope)) return null
    const all = starts.every((s) => scope!.contains(s))
    if (all && addButtonsIn(scope, kind).length > 0) return scope
  }
  // Blocks without an Add button in reach: their common parent, when it is not too broad.
  const parent = starts[0].parentElement
  return parent && starts.every((s) => parent.contains(s)) && !tooBroad(parent) && numbered(doc, kind).length > 0 ? parent : null
}

/**
 * The blocks of a section, in page order: elements with this kind's numbered id (the outermost of duplicates:
 * Workday repeats the id on wrappers and inputs), else one container per anchor field ("formField-jobTitle").
 */
export function blocksOf(section: Element, kind: SectionKind): Element[] {
  const info = KINDS[kind]
  const ids = numbered(section, kind).filter((el) => el.tagName.toLowerCase() !== 'input')
  const outer = ids.filter((el) => !ids.some((other) => other !== el && other.contains(el)))
  if (section.id && info.blockId.test(section.id)) return [section]
  if (outer.length) return outer
  const anchors = Array.from(section.querySelectorAll(aid(`formField-${info.anchor}`)))
  return anchors.map((a) => {
    let block: Element = a
    while (block.parentElement && block.parentElement !== section && block.parentElement.querySelectorAll(aid(`formField-${info.anchor}`)).length === 1) {
      block = block.parentElement
    }
    return block
  })
}

/** The Skills prompt's field (`formField-skills`, or the `skills--skills` id), with its search box. */
export function skillsField(doc: Document): Element | null {
  const field = doc.querySelector(`${aid('formField-skills')}, [id="skills--skills"]`)
  if (!field) return null
  const wrapper = field.closest('[data-automation-id^="formField-"]') ?? field
  return wrapper.querySelector(`${aid('multiSelectContainer')} input${aid('searchBox')}`) ? wrapper : null
}

/** Workday's month / day / year spinbuttons of one date (`dateInputWrapper`). */
export interface DateInputs {
  wrapper: Element
  month: HTMLInputElement | null
  day: HTMLInputElement | null
  year: HTMLInputElement | null
}

export function dateInputsOf(scope: Element): DateInputs | null {
  const wrapper = scope.matches(aid('dateInputWrapper')) ? scope : scope.querySelector(aid('dateInputWrapper'))
  if (!wrapper) return null
  const input = (part: string) =>
    wrapper.querySelector<HTMLInputElement>(`input${aid(`dateSection${part}-input`)}`)
  const out = { wrapper, month: input('Month'), day: input('Day'), year: input('Year') }
  return out.year ? out : null
}

/** The date questions of a step (outside the sections): their field wrapper, or the date wrapper itself. */
export function dateQuestions(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll(aid('dateInputWrapper'))).map(
    (w) => w.closest('[data-automation-id^="formField-"]') ?? w
  )
}

/** Self Identify's disability check boxes (some tenants use check boxes, not radios), or null. */
export function disabilityBoxes(doc: Document): Element | null {
  const field = doc.querySelector(aid('formField-disabilityStatus'))
  return field?.querySelector('input[type="checkbox"]') ? field : null
}

/**
 * The Self Identify signature block, never touched: the person's name and the date they sign on (Huntgry never
 * signs for anyone). Also the terms and agreements check boxes.
 */
export const NEVER_TOUCHED = [
  aid('formField-name'),
  aid('formField-dateSignedOn'),
  '[id^="selfIdentifiedDisabilityData--name"]',
  '[id^="selfIdentifiedDisabilityData--dateSignedOn"]',
  aid('formField-acceptTermsAndAgreements'),
  aid('agreementCheckbox')
]

/** Every container `sections.ts` fills, so the engine leaves them out of its own plan. */
export function sectionRoots(doc: Document): Element[] {
  const roots: Element[] = []
  for (const kind of Object.keys(KINDS) as SectionKind[]) {
    const section = sectionOf(doc, kind)
    if (section) roots.push(section)
  }
  const skills = skillsField(doc)
  if (skills) roots.push(skills)
  roots.push(...dateQuestions(doc))
  const disability = disabilityBoxes(doc)
  if (disability) roots.push(disability)
  return roots.filter((r, i) => !roots.some((other, j) => j !== i && other !== r && other.contains(r)))
}

/** A field wrapper's question text: its legend or label, without the required marker. */
export function questionOf(field: Element): string {
  const legend = field.querySelector('legend')
  const label = legend ?? field.querySelector('label')
  return text(label).replace(/[*✱]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
}
