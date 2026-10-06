import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures/app'
import { withFakeAgents } from '../fixtures/fake-agent'
import { Shell } from '../pages/shell'
import { TailorPage } from '../pages/tailor'
import { UsagePage } from '../pages/usage'

/**
 * Run observability (#44) through the real runner and the scripted Claude: every turn records its
 * time, model, tokens and price; the Tailor page shows them per run and per turn; the Dashboard's
 * Usage card totals them; a price changed in Settings reprices the runs without re-running.
 *
 * The fake Claude reports Claude Haiku 4.5 and, per turn, 2300 input + 2000 output tokens and
 * $0.0123 (the session's running total grows by that much, as the real CLI's does): the table's
 * estimate for those tokens is the same $0.0123, shown as $0.01 (two decimals from a cent up).
 */

const JOB = {
  description: '# Staff Engineer\n\nAcme Corp is hiring a Staff Engineer for its platform team. Go, PostgreSQL, Kubernetes.',
  company: 'Acme Corp',
  role: 'Staff Engineer',
  jobId: 'A-42'
}

test.describe('run observability', () => {
  test.use({ workspace: 'demo', prepare: withFakeAgents({ script: 'slow', slowMs: 400 }) })

  test('a run shows time, model, tokens and est. cost per run and per turn; the Dashboard totals them; Pricing reprices', async ({ app }) => {
    const shell = new Shell(app.window)
    const tailor = new TailorPage(app.window)
    const usage = new UsagePage(app.window)
    await shell.goTo('tailor')
    await tailor.start(JOB)

    // First turn: the strip and the turn's footer read the same figures.
    await expect(tailor.turnResults).toHaveCount(1)
    await tailor.expectStatus('Waiting for you')
    await expect(usage.runMetric('model')).toHaveText('claude-haiku-4-5-20251001')
    await expect(usage.runMetric('tokens')).toHaveText('4.3k')
    await expect(usage.runMetric('cost')).toHaveText('$0.01')
    await expect(tailor.turnResults.first()).toContainText('2.3k in · 2.0k out · $0.01')
    await expect(usage.runMetric('active')).toHaveText(/^\d+s$/)

    // Second turn: the running total is split per turn, not added up again.
    await tailor.reply('Approved')
    await expect(tailor.turnResults).toHaveCount(2)
    await tailor.expectStatus('Waiting for you')
    await expect(usage.runMetric('tokens')).toHaveText('8.6k')
    await expect(usage.runMetric('cost')).toHaveText('$0.02')
    await usage.perTurnToggle.click()
    await expect(usage.turnTable.getByRole('row')).toHaveCount(3)
    await expect(usage.runListBadges.first()).toContainText('8.6k tok · $0.02')

    // run.json keeps the raw per-turn numbers.
    const [id] = await readdir(join(app.workspace!, '.huntgry/runs'))
    const run = JSON.parse(await readFile(join(app.workspace!, '.huntgry/runs', id, 'run.json'), 'utf8'))
    expect(run.metrics).toHaveLength(2)
    expect(run.metrics.map((m: { usage: { inputTokens: number; outputTokens: number } }) => [m.usage.inputTokens, m.usage.outputTokens])).toEqual([
      [2300, 2000],
      [2300, 2000]
    ])
    expect(run.costUsd).toBeCloseTo(0.0246, 6)
    for (const m of run.metrics) expect(m.activeMs).toBeGreaterThan(0)

    // The Dashboard totals the run.
    await shell.goTo('dashboard')
    await expect(usage.card).toBeVisible()
    await expect(usage.kpi('runs')).toHaveText('1')
    await expect(usage.kpi('tokens')).toHaveText('8.6k')
    await expect(usage.kpi('cost')).toHaveText('$0.02')
    await expect(usage.breakdown.getByRole('row').filter({ hasText: 'claude-haiku-4-5-20251001' })).toContainText('Claude')

    // Settings → Pricing: Haiku input at $2 instead of $1 → 2 × (2300 × 2 + 2000 × 5) / 1M = $0.0292.
    await shell.goTo('settings')
    await expect(usage.priceRow('claude-haiku-4-5')).toContainText('$1')
    await usage.editPrice('claude-haiku-4-5').click()
    const input = usage.priceDialog.getByRole('textbox', { name: 'Input', exact: true })
    await input.fill('2')
    await usage.priceDialog.getByRole('button', { name: 'Save' }).click()
    await expect(usage.priceDialog).toHaveCount(0)
    await expect(usage.priceRow('claude-haiku-4-5')).toContainText('changed')
    const settings = JSON.parse(await readFile(join(app.userData, 'settings.json'), 'utf8'))
    expect(settings.pricing.models).toEqual([expect.objectContaining({ id: 'claude-haiku-4-5', input: 2 })])

    await shell.goTo('dashboard')
    await expect(usage.kpi('cost')).toHaveText('$0.03')

    // Reset goes back to the bundled table.
    await shell.goTo('settings')
    await usage.pricingCard.getByRole('button', { name: 'Reset to defaults' }).click()
    await expect(usage.priceRow('claude-haiku-4-5')).not.toContainText('changed')
    await shell.goTo('dashboard')
    await expect(usage.kpi('cost')).toHaveText('$0.02')
  })
})
