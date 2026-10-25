import { expect, type Locator, type Page } from '@playwright/test'
import type { BoardColumnId } from '../../src/shared/board'

/** The column headings, as `BOARD_COLUMN_LABEL` in src/shared/board.ts names them. */
export const COLUMN: Record<BoardColumnId, string> = {
  todo: 'To do',
  tailoring: 'Tailoring',
  review: 'Needs review',
  submit: 'Ready to submit',
  ready: 'Ready to apply',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected',
  archived: 'Archived'
}

/** The Move to menu's last item, which moves a card to Archived: "Archive", or "Dismiss job" on a saved job's card (#110). */
export type ArchiveItem = 'Archive' | 'Dismiss job'

/**
 * The Board page (#85): one column per stage (`<section aria-label="To do">`, …), one card per job
 * (`<article aria-label="<title>">`). Cards are addressed by their title, never by position.
 * Inside a column, cards sit in week groups (`<div role="group" aria-label="Last week">`) whose
 * header button folds them; a folded group renders no cards (#160).
 */
export class BoardPage {
  readonly heading: Locator
  readonly refreshButton: Locator
  /** The "Paste a posting link" box at the top of To do, and its Add button. */
  readonly linkInput: Locator
  readonly addButton: Locator
  /** The search box and the source filter above the columns (#160). */
  readonly search: Locator
  readonly sourceFilter: Locator
  /** The application drawer (and the saved job's drawer) a card opens. */
  readonly drawer: Locator

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Board', level: 2 })
    this.refreshButton = page.getByRole('button', { name: 'Refresh' })
    this.linkInput = this.column('todo').getByRole('textbox', { name: 'Paste a posting link' })
    this.addButton = this.column('todo').getByRole('button', { name: 'Add', exact: true })
    this.search = page.getByRole('textbox', { name: 'Search the board' })
    this.sourceFilter = page.getByRole('combobox', { name: 'Source', exact: true })
    this.drawer = page.getByRole('dialog')
  }

  /**
   * An application's card by its company (the card's subtitle), wherever it is: the board is
   * searched for the company and every folded week opened (#161: what the Dashboard table's rows were).
   */
  async application(company: string): Promise<Locator> {
    await this.search.fill(company)
    const card = this.page.locator('article[data-kind="application"]').filter({ has: this.page.getByText(company, { exact: true }) })
    await expect(async () => {
      await this.openAllWeeks()
      await expect(card).toHaveCount(1, { timeout: 1000 })
    }).toPass()
    return card
  }

  /** Opens the drawer of an application by clicking its card's title (hovered first, for a compact card). */
  async openApplication(company: string): Promise<Locator> {
    const card = await this.application(company)
    await card.hover()
    await card.getByRole('heading', { level: 4 }).click()
    await expect(this.drawer).toBeVisible()
    await expect(this.drawer.getByRole('heading', { level: 2 })).toContainText(company)
    // The drawer slides in from the right: wait until it stops, so a hover lands where it aims.
    const left = async () => (await this.drawer.boundingBox())?.x
    await expect
      .poll(async () => {
        const before = await left()
        await this.page.waitForTimeout(100)
        return before !== undefined && before === (await left())
      })
      .toBe(true)
    return this.drawer
  }

  /** Starts Apply for an application from its drawer ("Apply in browser"); the Browser page opens. */
  async applyFrom(company: string): Promise<void> {
    const drawer = await this.openApplication(company)
    await drawer.getByRole('button', { name: 'Apply in browser' }).click()
  }

  async closeDrawer(): Promise<void> {
    await this.page.keyboard.press('Escape')
    await expect(this.drawer).toBeHidden()
  }

  /** Picks a value in a Mantine Select (the drawer's Status): open it, click the option, wait for the value. */
  async pick(select: Locator, value: string): Promise<void> {
    await select.click()
    await this.page.getByRole('option', { name: value, exact: true }).click()
    await expect(select).toHaveValue(value)
  }

  /** A tooltip with this text. A disabled control gets no mouseleave, so its tooltip may stay open: match by text. */
  tooltip(text: string | RegExp): Locator {
    return this.page.getByRole('tooltip', { name: text }).filter({ visible: true })
  }

  /** A week group of a column, by its label ("This week", "Last week", "Oct 5 – 11"). */
  week(id: BoardColumnId, label: string): Locator {
    return this.column(id).getByRole('group', { name: label, exact: true })
  }

  /** The header button that folds and opens a week group. */
  weekToggle(id: BoardColumnId, label: string): Locator {
    return this.week(id, label).getByRole('button').first()
  }

  /** Week labels of a column, top to bottom. */
  async weeks(id: BoardColumnId): Promise<string[]> {
    return this.column(id).getByRole('group').evaluateAll((gs) => gs.map((g) => g.getAttribute('aria-label') ?? ''))
  }

  /** Opens every folded week group of a column (of every column when none is named), so all its cards are on the page. */
  async openAllWeeks(id?: BoardColumnId): Promise<void> {
    const scope = id ? this.column(id) : this.page.getByRole('region')
    const folded = scope.locator('button[aria-expanded="false"]')
    while ((await folded.count()) > 0) await folded.first().click()
  }

  /** Picks sources in the source filter (on top of those already picked). */
  async filterSources(...labels: string[]): Promise<void> {
    await this.sourceFilter.click()
    for (const label of labels) await this.page.getByRole('option', { name: label, exact: true }).click()
    await this.page.keyboard.press('Escape')
  }

  column(id: BoardColumnId): Locator {
    return this.page.getByRole('region', { name: COLUMN[id], exact: true })
  }

  /** Every card of a column. */
  cards(id: BoardColumnId): Locator {
    return this.column(id).getByRole('article')
  }

  /** A card by its title (the job's title, or the application's job title), anywhere on the board. */
  card(title: string): Locator {
    return this.page.getByRole('article', { name: title, exact: true })
  }

  /** Waits until `title`'s card is in column `id`, and only there; opens the column's folded weeks to look. */
  async expectIn(id: BoardColumnId, title: string): Promise<void> {
    // A moved card can land in a folded week after the first look: open and look again until it is there.
    await expect(async () => {
      await this.openAllWeeks(id)
      await expect(this.column(id).getByRole('article', { name: title, exact: true })).toHaveCount(1, { timeout: 1000 })
    }).toPass()
    await expect(this.card(title)).toHaveCount(1)
  }

  /** Card titles of a column, top to bottom. */
  async titles(id: BoardColumnId): Promise<string[]> {
    return this.cards(id).evaluateAll((cards) => cards.map((c) => c.getAttribute('aria-label') ?? ''))
  }

  /**
   * Moves a card with its Move to menu. Archived is reached by the menu's last item, so name it:
   * `'Archive'` for an application, `'Dismiss job'` for a saved job.
   */
  async moveTo(title: string, id: Exclude<BoardColumnId, 'archived'>): Promise<void>
  async moveTo(title: string, id: 'archived', item: ArchiveItem): Promise<void>
  async moveTo(title: string, id: BoardColumnId, item?: ArchiveItem): Promise<void> {
    await this.openMenu(title)
    await this.page.getByRole('menuitem', { name: id === 'archived' ? item : COLUMN[id], exact: true }).click()
    await this.expectIn(id, title)
  }

  /**
   * Opens a card's Move to menu. The card is hovered first: a compact card of a past week (#160)
   * becomes the full card on hover, which moves the button.
   */
  async openMenu(title: string): Promise<void> {
    await this.card(title).hover()
    await this.card(title).getByRole('button', { name: /^Move / }).click()
  }

  /** The card's own column in its open Move to menu: a disabled item named "<column> (current column)". */
  currentColumnItem(id: BoardColumnId): Locator {
    return this.page.getByRole('menuitem', { name: `${COLUMN[id]} (current column)`, exact: true })
  }

  /**
   * The menu items of a card's Move to menu, in order (the menu is closed again): the columns it can
   * go to, then "Archive" / "Dismiss job". The current column's disabled item is left out.
   */
  async moveTargets(title: string): Promise<string[]> {
    await this.openMenu(title)
    const items = this.page.getByRole('menuitem')
    await expect(items.first()).toBeVisible()
    const names = await items.and(this.page.locator(':not([data-disabled])')).allInnerTexts()
    await this.page.keyboard.press('Escape')
    await expect(items).toHaveCount(0)
    return names.map((n) => n.trim())
  }

  /**
   * Drags a card onto a column (HTML5 drag and drop) with the mouse.
   *
   * Not `dragTo`: it presses the mouse on the card, then scrolls the target column into view, and
   * only then moves. Chromium picks the drag source at that first move by hit-testing where the
   * mouse went down, and after the board has scrolled sideways that is no longer the card, so no
   * drag starts. Here the drag starts on the card first (a few pixels' move); the board scrolls after.
   */
  async drag(title: string, id: BoardColumnId): Promise<void> {
    const card = this.card(title)
    const column = this.column(id)
    await card.hover()
    await this.page.mouse.down()
    const from = await card.boundingBox()
    if (!from) throw new Error(`card "${title}" has no box`)
    await this.page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10)
    // The board dims the card it is dragging: the drag started on this card.
    await expect(card).toHaveCSS('opacity', '0.5')
    await column.scrollIntoViewIfNeeded()
    const to = await column.boundingBox()
    if (!to) throw new Error(`column "${COLUMN[id]}" has no box`)
    await this.page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 })
    await this.page.mouse.up()
  }

  async addLink(url: string): Promise<void> {
    await this.linkInput.fill(url)
    await this.addButton.click()
  }
}
