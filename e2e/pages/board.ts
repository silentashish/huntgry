import { expect, type Locator, type Page } from '@playwright/test'
import type { BoardColumnId } from '../../src/shared/board'

/** The column headings, as `BOARD_COLUMN_LABEL` in src/shared/board.ts names them. */
export const COLUMN: Record<BoardColumnId, string> = {
  todo: 'To do',
  tailoring: 'Tailoring',
  review: 'Waiting for review',
  ready: 'Ready to apply',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected',
  archived: 'Archived'
}

/**
 * The Board page (#85): one column per stage (`<section aria-label="To do">`, …), one card per job
 * (`<article aria-label="<title>">`). Cards are addressed by their title, never by position.
 */
export class BoardPage {
  readonly heading: Locator
  readonly refreshButton: Locator
  /** The "Paste a posting link" box at the top of To do, and its Add button. */
  readonly linkInput: Locator
  readonly addButton: Locator

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Board', level: 2 })
    this.refreshButton = page.getByRole('button', { name: 'Refresh' })
    this.linkInput = this.column('todo').getByRole('textbox', { name: 'Paste a posting link' })
    this.addButton = this.column('todo').getByRole('button', { name: 'Add', exact: true })
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

  /** Waits until `title`'s card is in column `id`, and only there. */
  async expectIn(id: BoardColumnId, title: string): Promise<void> {
    await expect(this.column(id).getByRole('article', { name: title, exact: true })).toHaveCount(1)
    await expect(this.card(title)).toHaveCount(1)
  }

  /** Card titles of a column, top to bottom. */
  async titles(id: BoardColumnId): Promise<string[]> {
    return this.cards(id).evaluateAll((cards) => cards.map((c) => c.getAttribute('aria-label') ?? ''))
  }

  /** Moves a card with its Move to menu. */
  async moveTo(title: string, id: BoardColumnId): Promise<void> {
    await this.card(title).getByRole('button', { name: /^Move / }).click()
    await this.page.getByRole('menuitem', { name: COLUMN[id], exact: true }).click()
    await this.expectIn(id, title)
  }

  /** The columns a card's Move to menu offers, in order (the menu is closed again). */
  async moveTargets(title: string): Promise<string[]> {
    await this.card(title).getByRole('button', { name: /^Move / }).click()
    const items = this.page.getByRole('menuitem')
    await expect(items.first()).toBeVisible()
    const names = await items.allInnerTexts()
    await this.page.keyboard.press('Escape')
    await expect(items).toHaveCount(0)
    return names.map((n) => n.trim())
  }

  /** Drags a card onto a column (HTML5 drag and drop). */
  async drag(title: string, id: BoardColumnId): Promise<void> {
    await this.card(title).dragTo(this.column(id))
  }

  async addLink(url: string): Promise<void> {
    await this.linkInput.fill(url)
    await this.addButton.click()
  }
}
