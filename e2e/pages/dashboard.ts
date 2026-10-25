import type { Locator, Page } from '@playwright/test'

/**
 * The Dashboard page: the "Needs you" strip, the stat tiles and the side cards. It lists no
 * applications since #161: they are browsed on the Board (e2e/pages/board.ts), which the stat
 * tiles and "Ready to apply" open.
 */
export type StatLabel = 'Total' | 'Generated' | 'Applied' | 'Interviewing' | 'Offer' | 'Rejected'

export class Dashboard {
  readonly heading: Locator
  readonly refreshButton: Locator
  readonly needsYou: Locator
  readonly emptyState: Locator

  constructor(readonly page: Page) {
    // The visible h2 is the greeting ("Good morning, Alex." / "Welcome to the den."); its accessible
    // name starts with a visually hidden "Dashboard:", so the page still announces itself by name.
    this.heading = page.getByRole('heading', { name: /^Dashboard:/, level: 2 })
    this.refreshButton = page.getByRole('button', { name: 'Refresh' })
    this.needsYou = page.getByRole('region', { name: 'Needs you' })
    this.emptyState = page.getByRole('heading', { name: 'No applications yet' })
  }

  /** The stat tile of a status ("Total", "Applied", …): a button named "<label>: <count>…. Open on the Board". */
  statCard(label: StatLabel): Locator {
    return this.page.getByRole('group', { name: 'Applications by status' }).getByRole('button', { name: new RegExp(`^${label}: `) })
  }

  /** The count shown on a stat tile. */
  statValue(label: StatLabel): Locator {
    return this.statCard(label).getByTestId('stat-value')
  }
}
