import { type Locator, type Page } from '@playwright/test'

/**
 * Run observability (#44): the metrics strip of the open run (Tailor page), the Dashboard's Usage
 * card and Settings → Pricing. The figures are found by test id (listed in the #44 PR): they are
 * bare values next to a label, with no accessible name of their own.
 */
export class UsagePage {
  constructor(readonly page: Page) {}

  /** A value of the open run's strip: `active`, `waiting`, `model`, `tokens`, `cost`. */
  runMetric(name: 'active' | 'waiting' | 'model' | 'tokens' | 'cost'): Locator {
    return this.page.getByTestId('run-metrics').getByTestId(`metric-${name}`)
  }

  get perTurnToggle(): Locator {
    return this.page.getByTestId('run-metrics').getByRole('button', { name: /^Per turn/ })
  }

  get turnTable(): Locator {
    return this.page.getByTestId('turn-metrics')
  }

  /** The "2m 14s · 48k tok · $0.31" line of each run in the run list. */
  get runListBadges(): Locator {
    return this.page.getByTestId('run-usage')
  }

  get card(): Locator {
    return this.page.getByTestId('usage-card')
  }

  /** A KPI tile of the Usage card: `runs`, `active`, `tokens`, `cost`. */
  kpi(name: 'runs' | 'active' | 'tokens' | 'cost'): Locator {
    return this.card.getByTestId(`usage-${name}`)
  }

  get breakdown(): Locator {
    return this.card.getByTestId('usage-breakdown')
  }

  get pricingCard(): Locator {
    return this.page.getByTestId('pricing-card')
  }

  /** The row of one model in Settings → Pricing. */
  priceRow(id: string): Locator {
    return this.page.getByTestId(`price-${id}`)
  }

  editPrice(id: string): Locator {
    return this.pricingCard.getByRole('button', { name: `Edit ${id}` })
  }

  get priceDialog(): Locator {
    return this.page.getByRole('dialog')
  }
}
