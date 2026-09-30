import { expect, type Locator, type Page } from '@playwright/test'

/** The "Master profile" card on the Dashboard: empty sections, skill gaps with "I have this" / "Not me". */
export class InsightsCard {
  readonly card: Locator
  readonly openButton: Locator
  readonly evidenceModal: Locator

  constructor(readonly page: Page) {
    // The card: the innermost element holding both the heading and the gaps list (the heading's own row has no list).
    this.card = page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: 'Master profile', level: 4 }) })
      .filter({ hasText: 'Asked for by jobs, missing from your profile' })
      .last()
    this.openButton = this.card.getByRole('button', { name: 'Open', exact: true })
    this.evidenceModal = page.getByRole('dialog', { name: /^Add evidence for / })
  }

  /** The line of one gap skill: its name, the job count badge and the two buttons. */
  gap(skill: string): Locator {
    return this.card.getByText(skill, { exact: true }).locator('xpath=ancestor::*[.//button][1]')
  }

  /** The "Empty:" badge that deep-links into a profile section. */
  emptyBadge(section: string): Locator {
    return this.card.getByRole('button', { name: section, exact: true })
  }

  async haveThis(skill: string): Promise<Locator> {
    await this.gap(skill).getByRole('button', { name: 'I have this' }).click()
    await expect(this.evidenceModal).toBeVisible()
    await expect(this.evidenceModal.getByRole('heading', { name: `Add evidence for ${skill}` })).toBeVisible()
    return this.evidenceModal
  }

  /** Dismisses a gap. The skill then only appears in the collapsed "marked not me" list, which stays mounted but hidden. */
  async notMe(skill: string): Promise<void> {
    await this.gap(skill).getByRole('button', { name: 'Not me', exact: true }).click()
    await expect(this.card.getByText(skill, { exact: true }).filter({ visible: true })).toHaveCount(0)
  }

  /** The "Show N marked “not me”" toggle. */
  get dismissedToggle(): Locator {
    return this.card.getByRole('button', { name: /^(Show|Hide) \d+ marked/ })
  }
}
