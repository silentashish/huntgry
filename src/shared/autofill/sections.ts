import { FACTS, isConsentQuestion, matchFact, normalizeText, resolveAnswer, type PageAnswers } from '../apply-facts'
import type { FieldKind, FieldReport, FillEducation, FillExperience, FillProfile, FillReport, MonthYear } from '../apply-types'
import {
  addButtonOf,
  blocksOf,
  dateInputsOf,
  dateQuestions,
  disabilityBoxes,
  fieldOf,
  NEVER_TOUCHED,
  questionOf,
  sectionOf,
  skillsField,
  type DateInputs,
  type SectionKind
} from './workday-sections'
import { highlight, kindOf, radioLabel, setNativeValue, setSelectValue, selectOptionTexts, type FormControl } from './dom'
import { pick, pillsOf, pressAdd, pressToggle, typeaheadOf, widgetOf, type PickResult } from './pick'
import { sleep } from './ready'
import { editedByUser } from './user-edits'

/**
 * Workday's repeatable sections, filled from the master profile (#136):
 * Work Experience, Education and Websites on My Experience (blocks added with
 * the section's own Add / Add Another button, then filled), the Skills prompt
 * (each skill typed and its suggestion picked), and on the answer-only steps
 * the date questions (the earliest start date) and Self Identify's
 * disability check boxes. Runs after the engine's synchronous fill, before
 * its picks; the engine leaves these controls out of its own plan
 * (`Adapter.sectionRoots`).
 *
 * Rules:
 * - Presses (Add, "I currently work here", the disability box, a degree
 *   dropdown, a prompt's suggestion) only go through pick.ts, and only with
 *   the "Pick dropdown answers automatically" switch on. Off, text is still
 *   typed into the blocks that exist and the rest goes to the user.
 * - Blocks are matched to profile entries by company (school, URL) first,
 *   then in order. A block value that differs from the profile and that the
 *   person did not type is replaced ("Replaced the site's parsed value": the
 *   resume parser's guesses); a value the person typed is kept.
 * - At most 5 jobs, 3 schools, 3 websites and 25 skills, within 40 s; the
 *   remaining work goes to the user.
 */

export interface SectionJob {
  doc: Document
  report: FillReport
  /** The profile sections main sent; null when it sent none (the sections are then left alone). */
  profile: FillProfile | null
  answers: PageAnswers
  pick: boolean
  pageState: () => string
}

const MAX = { experience: 5, education: 3, website: 3 } as const
const MAX_SKILLS = 25
/** The whole sections phase; main's Workday fill timeout (60 s) covers it with the rest of the fill. */
export const SECTIONS_BUDGET_MS = 40_000

const LABEL: Record<SectionKind, string> = { experience: 'Work experience', education: 'Education', website: 'Website' }

const pad = (n: number) => String(n).padStart(2, '0')
const show = (d: MonthYear | null) => (d ? `${pad(d.month)}/${d.year}` : '')
const same = (a: string, b: string) => normalizeText(a) === normalizeText(b)

class Filler {
  readonly lines: FieldReport[] = []
  /** Text Huntgry wrote, checked again at the end (a block added later may re-render the earlier ones). */
  private readonly written: Array<{ el: HTMLInputElement | HTMLTextAreaElement; value: string; line: FieldReport }> = []
  private readonly deadline = Date.now() + SECTIONS_BUDGET_MS
  /** The safety net caught the page acting on its own: no more presses in this fill. */
  private halted = false

  constructor(private readonly job: SectionJob) {}

  private get left(): number {
    return this.deadline - Date.now()
  }

  private get canPress(): boolean {
    return this.job.pick && !this.halted && this.left > 0
  }

  private line(label: string, kind: FieldKind, outcome: FieldReport['outcome'], extra: Partial<FieldReport> = {}): FieldReport {
    const line: FieldReport = { key: null, label: label.slice(0, 160), kind, required: false, outcome, ...extra }
    this.lines.push(line)
    return line
  }

  private noted(result: PickResult): PickResult {
    if (result.status === 'failed' && result.halt) this.halted = true
    return result
  }

  /**
   * One text field of a block: written when empty or holding another value the person did not type (the site's
   * parser), kept when the person typed it.
   */
  text(label: string, el: Element | null, value: string): void {
    const control = el && controlIn(el)
    if (!control) return
    const kind = kindOf(control)
    if (!value.trim()) {
      if (!control.value.trim()) this.line(label, kind, 'skipped-no-value', { reason: 'Not in your master profile.' })
      return
    }
    const current = control.value.trim()
    if (same(current, value)) {
      this.line(label, kind, 'filled', { value: value.slice(0, 200) })
      return
    }
    if (editedByUser(control)) {
      this.line(label, kind, 'kept', { value: current.slice(0, 200), reason: 'You changed it; left as is.' })
      return
    }
    const ok = setNativeValue(control, value)
    const line = this.line(label, kind, ok ? 'filled' : 'rejected', { value: value.slice(0, 200) })
    if (ok) {
      if (current) line.reason = "Replaced the site's parsed value."
      highlight(control, 'done')
      this.written.push({ el: control, value, line })
    } else {
      line.reason = control.value ? `The site changed it to "${control.value.slice(0, 80)}".` : 'The site cleared it.'
      highlight(control, 'attention')
    }
  }

  /** A month / year date (Workday's spinbuttons): "01" and "2022", each read back. A year-only date gets the year. */
  date(label: string, field: Element | null, value: MonthYear | null): void {
    const inputs = field && dateInputsOf(field)
    if (!inputs) return
    if (!value) {
      if (!inputs.year?.value.trim()) this.line(label, 'other', 'skipped-no-value', { reason: 'Not in your master profile.' })
      return
    }
    this.writeDate(label, inputs, { month: pad(value.month), year: String(value.year) }, show(value))
  }

  /** Writes the parts of a date; replaced like text (a part the person typed keeps the whole date). */
  writeDate(label: string, inputs: DateInputs, parts: { month?: string; day?: string; year: string }, shown: string): void {
    const pairs = (['month', 'day', 'year'] as const)
      .map((part) => [inputs[part], parts[part]] as const)
      .filter((p): p is readonly [HTMLInputElement, string] => p[0] !== null && p[1] !== undefined)
    const holds = () => pairs.every(([el, v]) => Number(el.value.trim()) === Number(v) && el.value.trim() !== '')
    if (holds()) {
      this.line(label, 'other', 'filled', { value: shown })
      return
    }
    const current = pairs.map(([el]) => el.value.trim()).filter(Boolean).join('/')
    if (pairs.some(([el]) => editedByUser(el))) {
      this.line(label, 'other', 'kept', { value: current, reason: 'You changed it; left as is.' })
      return
    }
    for (const [el, v] of pairs) if (Number(el.value.trim()) !== Number(v) || !el.value.trim()) setNativeValue(el, v)
    const ok = holds()
    const line = this.line(label, 'other', ok ? 'filled' : 'rejected', { value: shown })
    if (ok) {
      if (current) line.reason = "Replaced the site's parsed value."
      for (const [el, v] of pairs) this.written.push({ el, value: v, line })
      highlight(inputs.wrapper, 'done')
    } else {
      line.reason = 'The site did not take the date; enter it yourself.'
      highlight(inputs.wrapper, 'attention')
    }
  }

  /** Adds blocks with the section's Add button until it has `wanted`; returns the blocks. */
  async grow(kind: SectionKind, wanted: number): Promise<Element[]> {
    let section = sectionOf(this.job.doc, kind)
    if (!section) return []
    let blocks = blocksOf(section, kind)
    while (blocks.length < wanted && this.canPress) {
      const button = addButtonOf(section, kind)
      if (!button) break
      const before = blocks.length
      const at = section
      const result = this.noted(
        await pressAdd(button, at, () => blocksOf(at, kind).length > before, {
          pageState: this.job.pageState,
          timeoutMs: Math.min(3000, Math.max(200, this.left))
        })
      )
      section = sectionOf(this.job.doc, kind) ?? section
      blocks = blocksOf(section, kind)
      if (result.status === 'failed') {
        this.line(`${LABEL[kind]}: Add`, 'other', 'rejected', { reason: `Huntgry could not add a block (${result.reason.slice(0, 120)}); press Add yourself.` })
        break
      }
    }
    for (let i = blocks.length; i < wanted; i++) {
      this.line(`${LABEL[kind]} ${i + 1}`, 'other', 'skipped-unsupported', {
        reason: this.job.pick ? 'No room for it on the page; press Add and fill it in yourself.' : 'Press Add in the page and fill it in yourself.'
      })
    }
    return blocks
  }

  /** "I currently work here": ticked (through pick.ts) for a current job when unticked; never unticked. */
  async current(label: string, block: Element, entry: FillExperience): Promise<void> {
    const field = fieldOf(block, ['currentlyWorkHere'])
    const box = field && (field.matches('input[type="checkbox"]') ? field : field.querySelector('input[type="checkbox"]'))
    if (!box) return
    const input = box as HTMLInputElement
    if (!entry.current) {
      if (input.checked) this.line(label, 'checkbox', 'kept', { value: 'Ticked', reason: 'Ticked on the page; your profile gives an end date. Untick it yourself if it is wrong.' })
      return
    }
    if (input.checked) {
      this.line(label, 'checkbox', 'filled', { value: 'Ticked' })
      return
    }
    if (editedByUser(input)) {
      this.line(label, 'checkbox', 'kept', { value: 'Not ticked', reason: 'You changed it; left as is.' })
      return
    }
    if (!this.canPress) {
      this.line(label, 'checkbox', 'skipped-unsupported', { reason: 'Tick it yourself: this is your current job.' })
      return
    }
    const result = this.noted(await pressToggle(input, { pageState: this.job.pageState, timeoutMs: Math.min(1000, Math.max(100, this.left)) }))
    if (result.status === 'filled') this.line(label, 'checkbox', 'filled', { value: 'Ticked' })
    else this.line(label, 'checkbox', 'rejected', { reason: `Huntgry could not tick it (${result.status === 'failed' ? result.reason.slice(0, 120) : ''}); tick it yourself.` })
  }

  /** A typeahead (Workday prompt) or a plain input, for a value from the profile (school, field of study). */
  async prompt(label: string, field: Element | null, value: string, choose: (options: string[]) => string | null): Promise<void> {
    if (!field) return
    const control = controlIn(field)
    if (!control) return
    const search = field.querySelector<HTMLInputElement>('[data-automation-id="multiSelectContainer"] input[data-automation-id="searchBox"]')
    if (!search) {
      this.text(label, control, value)
      return
    }
    if (!value.trim()) {
      this.line(label, 'text', 'skipped-no-value', { reason: 'Not in your master profile.' })
      return
    }
    const widget = typeaheadOf(search)
    if (!widget) return
    const pills = pillsOf(widget)
    if (pills.length) {
      const fits = pills.some((p) => choose([p]) !== null)
      this.line(label, 'text', fits ? 'filled' : 'kept', { value: pills[0].slice(0, 200), ...(fits ? {} : { reason: 'Already chosen; left as is.' }) })
      return
    }
    if (!this.canPress) {
      this.line(label, 'text', 'skipped-unsupported', { reason: `This picker takes a click: choose "${value.slice(0, 80)}" yourself.` })
      return
    }
    const result = this.noted(
      await pick(widget, choose, {
        timeoutMs: Math.min(1500, Math.max(100, Math.floor(this.left / 3))),
        touched: () => editedByUser(search),
        pageState: this.job.pageState,
        search: value,
        enterAfterMs: 200
      })
    )
    this.picked(label, 'text', result, value, widget.scope)
  }

  /** A dropdown (listbox button, or a native select) chosen from the profile. */
  async dropdown(label: string, field: Element | null, value: string, choose: (options: string[]) => string | null): Promise<void> {
    if (!field) return
    const select = field.matches('select') ? (field as HTMLSelectElement) : field.querySelector('select')
    if (select) {
      if (!value.trim()) return
      const chosen = choose(selectOptionTexts(select))
      const shown = select.selectedOptions?.[0]?.text.trim() ?? ''
      if (chosen && same(shown, chosen)) this.line(label, 'select', 'filled', { value: chosen })
      else if (editedByUser(select)) this.line(label, 'select', 'kept', { value: shown, reason: 'You changed it; left as is.' })
      else if (chosen && setSelectValue(select, chosen)) this.line(label, 'select', 'filled', { value: chosen })
      else this.line(label, 'select', 'rejected', { reason: `None of its options is "${value.slice(0, 80)}"; pick it yourself.` })
      return
    }
    const button = field.matches('button[aria-haspopup="listbox"]') ? field : field.querySelector('button[aria-haspopup="listbox"]')
    const widget = button && widgetOf(button)
    if (!widget) return
    if (!value.trim()) {
      this.line(label, 'combobox', 'skipped-no-value', { reason: 'Not in your master profile.' })
      return
    }
    if (!this.canPress) {
      this.line(label, 'combobox', 'skipped-unsupported', { reason: `This picker takes a click: choose "${value.slice(0, 80)}" yourself.` })
      return
    }
    const result = this.noted(
      await pick(widget, choose, {
        timeoutMs: Math.min(1500, Math.max(100, Math.floor(this.left / 2))),
        touched: () => editedByUser(button),
        pageState: this.job.pageState
      })
    )
    this.picked(label, 'combobox', result, value, widget.scope)
  }

  private picked(label: string, kind: FieldKind, result: PickResult, value: string, scope: Element): void {
    if (result.status === 'filled') {
      this.line(label, kind, 'filled', { value: result.value.slice(0, 200) })
      highlight(scope, 'done')
    } else if (result.status === 'kept') {
      this.line(label, kind, 'kept', { value: result.value.slice(0, 200), reason: 'Already chosen; left as is.' })
    } else {
      this.line(label, kind, 'rejected', { reason: `Huntgry could not pick "${value.slice(0, 80)}" (${result.reason.slice(0, 120)}); pick it yourself.` })
      highlight(scope, 'attention')
    }
  }

  async experience(entries: FillExperience[]): Promise<void> {
    const list = entries.slice(0, MAX.experience)
    if (list.length === 0 || !sectionOf(this.job.doc, 'experience')) return
    const blocks = await this.grow('experience', list.length)
    const pairs = matchBlocks(blocks, list, (b) => controlIn(fieldOf(b, ['companyName', 'company']))?.value ?? '', (e) => e.company)
    for (const [block, entry, n] of pairs) {
      const at = `Work experience ${n + 1} ·`
      this.text(`${at} Job title`, fieldOf(block, ['jobTitle']), entry.role)
      this.text(`${at} Company`, fieldOf(block, ['companyName', 'company']), entry.company)
      this.text(`${at} Location`, fieldOf(block, ['location']), entry.location)
      await this.current(`${at} I currently work here`, block, entry)
      this.date(`${at} From`, fieldOf(block, ['startDate']), entry.start)
      // A current job has no end date (Workday hides it once "I currently work here" is ticked).
      if (!entry.current) this.date(`${at} To`, fieldOf(block, ['endDate']), entry.end)
      this.text(`${at} Role description`, fieldOf(block, ['roleDescription', 'description']), entry.description)
    }
    this.extraBlocks('experience', blocks, pairs.length)
  }

  async education(entries: FillEducation[]): Promise<void> {
    const list = entries.slice(0, MAX.education)
    if (list.length === 0 || !sectionOf(this.job.doc, 'education')) return
    const blocks = await this.grow('education', list.length)
    const schoolOf = (b: Element) => {
      const field = fieldOf(b, ['schoolName', 'school', 'schoolItem'])
      const widget = field?.querySelector('input[data-automation-id="searchBox"]')
      return widget ? (pillsOf(typeaheadOf(widget)!)[0] ?? '') : (field && controlIn(field)?.value) || ''
    }
    const pairs = matchBlocks(blocks, list, schoolOf, (e) => e.school)
    for (const [block, entry, n] of pairs) {
      if (this.left <= 0) break
      const at = `Education ${n + 1} ·`
      await this.prompt(`${at} School`, fieldOf(block, ['schoolName', 'school', 'schoolItem']), entry.school, (o) => bestMatch(entry.school, o))
      await this.dropdown(`${at} Degree`, fieldOf(block, ['degree']), entry.degree, (o) => degreeOption(entry.degree, o))
      await this.prompt(`${at} Field of study`, fieldOf(block, ['fieldOfStudy', 'field-of-study']), entry.field, (o) => bestMatch(entry.field, o))
      this.text(`${at} GPA`, fieldOf(block, ['gpa', 'gradeAverage']), entry.gpa)
      this.date(`${at} From`, fieldOf(block, ['firstYearAttended', 'startDate']), entry.start)
      this.date(`${at} To`, fieldOf(block, ['lastYearAttended', 'endDate']), entry.end)
    }
    this.extraBlocks('education', blocks, pairs.length)
  }

  async websites(urls: string[]): Promise<void> {
    const list = urls.slice(0, MAX.website)
    if (list.length === 0 || !sectionOf(this.job.doc, 'website')) return
    const blocks = await this.grow('website', list.length)
    const urlField = (b: Element) => fieldOf(b, ['url', 'webAddress']) ?? b.querySelector('input[type="text"], input[type="url"], input:not([type])')
    const pairs = matchBlocks(blocks, list, (b) => controlIn(urlField(b))?.value ?? '', (u) => u)
    for (const [block, url, n] of pairs) this.text(`Website ${n + 1} · URL`, urlField(block), url)
    this.extraBlocks('website', blocks, pairs.length)
  }

  private extraBlocks(kind: SectionKind, blocks: Element[], used: number): void {
    if (blocks.length > used) {
      this.line(`${LABEL[kind]}: ${blocks.length - used} more on the page`, 'other', 'kept', { reason: 'Not in your master profile; left as is.' })
    }
  }

  /** Each profile skill typed into the Skills prompt and its suggestion picked; skills already shown are skipped. */
  async skills(skills: string[]): Promise<void> {
    const field = skillsField(this.job.doc)
    if (!field || skills.length === 0) return
    const search = field.querySelector<HTMLInputElement>('[data-automation-id="multiSelectContainer"] input[data-automation-id="searchBox"]')
    const widget = search && typeaheadOf(search)
    if (!search || !widget) return
    const list = skills.slice(0, MAX_SKILLS)
    let added = 0
    let present = 0
    const missing: string[] = []
    let left = 0
    for (const [i, skill] of list.entries()) {
      if (pillsOf(widget).some((p) => same(p, skill))) {
        present++
        continue
      }
      if (!this.canPress || editedByUser(search)) {
        left = list.length - i
        break
      }
      const result = this.noted(
        await pick(widget, (options) => skillOption(skill, options), {
          timeoutMs: Math.min(1500, Math.max(100, Math.floor(this.left / 3))),
          touched: () => editedByUser(search),
          pageState: this.job.pageState,
          search: skill,
          multi: true,
          enterAfterMs: 200
        })
      )
      if (result.status === 'filled') added++
      else missing.push(skill)
    }
    const parts = [`${added} added`, ...(present ? [`${present} already there`] : []), ...(missing.length ? [`${missing.length} not found`] : [])]
    const line = this.line(`Skills: ${parts.join(', ')}`, 'combobox', added + present > 0 ? 'filled' : 'rejected', {
      value: pillsOf(widget).join(', ').slice(0, 200)
    })
    const notes = [
      ...(missing.length ? [`Not in the site's list: ${missing.join(', ')}.`] : []),
      ...(left ? [this.job.pick ? `${left} left for you (time limit).` : 'Add your skills yourself (picking is off in Settings).'] : [])
    ]
    if (notes.length) line.reason = notes.join(' ').slice(0, 200)
    if (added + present > 0) highlight(widget.scope, 'done')
  }

  /**
   * The answer-only steps' date questions: the earliest start date goes in when the stored answer is a full date;
   * otherwise it is a suggestion. Other dates (and the Self Identify signature date) are left alone.
   */
  dates(): void {
    const never = NEVER_TOUCHED.flatMap((s) => Array.from(this.job.doc.querySelectorAll(s)))
    for (const field of dateQuestions(this.job.doc)) {
      if (never.some((n) => n === field || n.contains(field) || field.contains(n))) continue
      if (['experience', 'education', 'website'].some((k) => sectionOf(this.job.doc, k as SectionKind)?.contains(field))) continue
      const inputs = dateInputsOf(field)
      if (!inputs) continue
      const label = questionOf(field) || 'Date'
      if (isConsentQuestion(label) || matchFact(label) !== 'earliestStart') continue
      const stored = this.job.answers.facts.earliestStart?.trim() ?? ''
      if (!stored) {
        this.line(label, 'other', 'skipped-no-value', { reason: 'Answer it once in Settings > Saved application answers (earliest start date).' })
        continue
      }
      const date = fullDate(stored)
      if (!date || !inputs.month) {
        this.line(label, 'other', 'skipped-unsupported', { reason: `Your saved answer is "${stored.slice(0, 60)}"; enter the date yourself.` })
        continue
      }
      this.writeDate(
        label,
        inputs,
        { month: pad(date.month), ...(inputs.day ? { day: pad(date.day) } : {}), year: String(date.year) },
        `${pad(date.month)}/${inputs.day ? `${pad(date.day)}/` : ''}${date.year}`
      )
    }
  }

  /** Self Identify's disability check boxes, from the stored fact (decline → "I do not want to answer"). */
  async disability(): Promise<void> {
    const field = disabilityBoxes(this.job.doc)
    if (!field) return
    const boxes = Array.from(field.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    const options = boxes.map(radioLabel)
    const label = questionOf(field) || FACTS.disabilityStatus.label
    const ticked = boxes.find((b) => b.checked)
    if (ticked) {
      this.line(label, 'radio', 'kept', { value: radioLabel(ticked), reason: 'Already answered; left as is.' })
      return
    }
    const stored = this.job.answers.facts.disabilityStatus
    if (!stored) {
      this.line(label, 'radio', 'skipped-unsupported', { reason: 'Answer it once in the page; Huntgry remembers it from your saved answers.' })
      return
    }
    const answer = resolveAnswer('disabilityStatus', stored, 'radio', options)
    const target = answer ? boxes[options.indexOf(answer)] : undefined
    if (!target) {
      this.line(label, 'radio', 'rejected', { reason: "Your saved answer is not one of this question's options; pick it yourself." })
      return
    }
    if (!this.canPress) {
      this.line(label, 'radio', 'skipped-unsupported', { reason: `This picker takes a click: choose "${answer!.slice(0, 80)}" yourself.` })
      return
    }
    const result = this.noted(await pressToggle(target, { pageState: this.job.pageState, timeoutMs: Math.min(1000, Math.max(100, this.left)) }))
    if (result.status === 'filled') this.line(label, 'radio', 'filled', { value: answer! })
    else this.line(label, 'radio', 'rejected', { reason: `Huntgry could not pick "${answer!.slice(0, 80)}"; pick it yourself.` })
  }

  /** Text written earlier that a later re-render wiped: written once more and read back; the person's edits are kept. */
  async recheck(): Promise<void> {
    const lost = this.written.filter(({ el, value }) => !el.isConnected || !sameValue(el, value))
    if (lost.length === 0) return
    for (const { el, value, line } of lost) {
      if (!el.isConnected) continue
      if (editedByUser(el)) {
        line.outcome = 'kept'
        line.value = el.value.trim().slice(0, 200)
        line.reason = 'You changed it after Huntgry filled it; left as is.'
      } else setNativeValue(el, value)
    }
    await sleep(this.job.doc, 200)
    for (const { el, value, line } of lost) {
      if (line.outcome === 'kept') continue
      if (!el.isConnected || !sameValue(el, value)) {
        line.outcome = 'rejected'
        line.reason = 'The page cleared it after filling; fill it in.'
      }
    }
  }
}

/** Dates compare as numbers ("1" is "01"), text as trimmed text. */
const sameValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  /^\d+$/.test(value) ? Number(el.value.trim()) === Number(value) && el.value.trim() !== '' : same(el.value, value)

/** The text control of a field wrapper (or the control itself), never a check box. */
function controlIn(el: Element | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (!el) return null
  const tag = el.tagName.toLowerCase()
  if (tag === 'textarea') return el as HTMLTextAreaElement
  if (tag === 'input') return kindOf(el as FormControl) === 'text' ? (el as HTMLInputElement) : null
  const inner = el.querySelector<HTMLInputElement | HTMLTextAreaElement>('textarea, input[type="text"], input[type="url"], input:not([type])')
  return inner && (inner.tagName.toLowerCase() === 'textarea' || kindOf(inner as FormControl) === 'text') ? inner : null
}

/**
 * Pairs blocks with entries: a block whose key (company, school, URL) names an entry gets that entry, the rest go in
 * order. Returns `[block, entry, entry index]`, in block order.
 */
export function matchBlocks<T>(blocks: Element[], entries: T[], blockKey: (b: Element) => string, entryKey: (e: T) => string): Array<[Element, T, number]> {
  const out = new Map<Element, number>()
  const used = new Set<number>()
  for (const block of blocks) {
    const key = normalizeText(blockKey(block))
    if (!key) continue
    const i = entries.findIndex((e, n) => {
      const k = normalizeText(entryKey(e))
      return !used.has(n) && k !== '' && (k === key || k.startsWith(`${key} `) || key.startsWith(`${k} `))
    })
    if (i >= 0) {
      out.set(block, i)
      used.add(i)
    }
  }
  const free = entries.map((_, i) => i).filter((i) => !used.has(i))
  for (const block of blocks) {
    if (out.has(block)) continue
    const i = free.shift()
    if (i === undefined) break
    out.set(block, i)
  }
  return blocks.filter((b) => out.has(b)).map((b) => [b, entries[out.get(b)!], out.get(b)!])
}

/** The suggestion that is `value`: the same text, else one starting with it, else the shortest one containing it. */
export function bestMatch(value: string, options: string[]): string | null {
  const n = normalizeText(value)
  if (!n) return null
  const exact = options.find((o) => normalizeText(o) === n)
  if (exact) return exact
  const starts = options.filter((o) => normalizeText(o).startsWith(`${n} `))
  if (starts.length) return starts.sort((a, b) => a.length - b.length)[0]
  const within = options.filter((o) => ` ${normalizeText(o)} `.includes(` ${n} `))
  return within.length ? within.sort((a, b) => a.length - b.length)[0] : null
}

/** A skill's suggestion: the same name ("Go"), else one that starts with it ("Go (Programming Language)"). */
export function skillOption(skill: string, options: string[]): string | null {
  return bestMatch(skill, options)
}

/** Degree wordings that mean the same degree. */
const DEGREES: Array<[RegExp, RegExp, RegExp]> = [
  [/\b(bachelor|bachelors|bs|b s|bsc|b sc|ba|b a|bachelor of (science|arts|engineering))\b/, /\b(bachelor|bachelors|bs|b s|bsc|ba|b a|undergraduate)\b/, /\bbachelors?\b/],
  [/\b(master|masters|ms|m s|msc|m sc|ma|m a|mba|master of (science|arts|engineering|business))\b/, /\b(master|masters|ms|m s|msc|ma|m a|mba)\b/, /\bmasters?\b/],
  [/\b(phd|ph d|doctor|doctorate|doctoral|doctor of philosophy)\b/, /\b(phd|ph d|doctor|doctorate|doctoral)\b/, /\b(doctor\w*|phd)\b/],
  [/\b(associate|associates|as|a s|aa|a a)\b/, /\b(associate|associates)\b/, /\bassociates?\b/],
  [/\b(high school|ged|secondary)\b/, /\b(high school|ged|secondary)\b/, /\bhigh school\b/]
]

/**
 * The degree option for the profile's degree: the same text; else the level it names (Bachelor's ↔ BS / B.S. /
 * Bachelor of Science; Master's ↔ MS / M.S. / Master of Science; PhD ↔ Doctorate), when exactly one option has it
 * (preferring one that also names science / arts as the profile does).
 */
export function degreeOption(degree: string, options: string[]): string | null {
  const n = normalizeText(degree)
  if (!n) return null
  const exact = options.find((o) => normalizeText(o) === n)
  if (exact) return exact
  const level = DEGREES.find(([profile]) => profile.test(n))
  if (!level) return bestMatch(degree, options)
  const hits = options.filter((o) => level[1].test(normalizeText(o)) || level[0].test(normalizeText(o)))
  if (hits.length <= 1) return hits[0] ?? null
  const flavour = /\b(science|arts|engineering|business)\b/.exec(n)?.[1] ?? (/\b(bs|b s|bsc|ms|m s|msc)\b/.test(n) ? 'science' : /\b(ba|b a|ma|m a)\b/.test(n) ? 'arts' : null)
  const fine = flavour ? hits.filter((o) => normalizeText(o).includes(flavour)) : []
  if (fine.length === 1) return fine[0]
  // "Master's" fits "Master's Degree" better than "MBA": the option that names the level in words.
  const worded = (fine.length ? fine : hits).filter((o) => level[2].test(normalizeText(o)))
  return worded.length === 1 ? worded[0] : null
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** A full date (day, month, year) from a stored answer: "2027-03-01", "03/01/2027", "March 1, 2027", "1 March 2027". */
export function fullDate(text: string): { day: number; month: number; year: number } | null {
  const t = text.trim().toLowerCase()
  const ok = (month: number, day: number, year: number) => {
    if (month < 1 || month > 12 || day < 1 || year < 1900 || year > 2100) return null
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return day <= days ? { day, month, year } : null
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  if (m) return ok(Number(m[2]), Number(m[3]), Number(m[1]))
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t)
  if (m) return ok(Number(m[1]), Number(m[2]), Number(m[3]))
  m = /^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(t)
  if (m && MONTH_NAMES.includes(m[1].slice(0, 3))) return ok(MONTH_NAMES.indexOf(m[1].slice(0, 3)) + 1, Number(m[2]), Number(m[3]))
  m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})\.?,? (\d{4})$/.exec(t)
  if (m && MONTH_NAMES.includes(m[2].slice(0, 3))) return ok(MONTH_NAMES.indexOf(m[2].slice(0, 3)) + 1, Number(m[1]), Number(m[3]))
  return null
}

/**
 * Fills Workday's sections for one fill (see the module comment). Returns the report lines: one per block field
 * ("Work experience 1 · Job title"), one for the skills ("Skills: 8 added"), one per date question or disability
 * question it handled.
 */
export async function runSections(job: SectionJob): Promise<FieldReport[]> {
  const filler = new Filler(job)
  if (job.profile) {
    await filler.experience(job.profile.experience)
    await filler.education(job.profile.education)
    await filler.websites(job.profile.websites)
    await filler.skills(job.profile.skills)
  }
  filler.dates()
  await filler.disability()
  await filler.recheck()
  return filler.lines
}
