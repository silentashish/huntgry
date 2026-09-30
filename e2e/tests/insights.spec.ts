import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures/app'
import { Dashboard } from '../pages/dashboard'
import { InsightsCard } from '../pages/insights-card'
import { ProfileEditor } from '../pages/profile-editor'
import { Shell } from '../pages/shell'

/**
 * The profile insights card on the Dashboard of the `demo` workspace: the
 * skill gaps its job descriptions reveal, "Not me" persisted under .huntgry,
 * "I have this" written into master-profile.md, and the Claude draft path
 * (no agent in the sandbox) showing its unavailable state only.
 */
test.use({ workspace: 'demo' })

const profileOf = (workspace: string) => readFile(join(workspace, 'master-profile.md'), 'utf8')
const insightsFile = (workspace: string) => join(workspace, '.huntgry', 'profile-insights.json')

async function openCard(app: { window: import('@playwright/test').Page }): Promise<InsightsCard> {
  await new Shell(app.window).expectActive('dashboard')
  const card = new InsightsCard(app.window)
  await expect(card.card.getByText(/compared with 6 job descriptions/)).toBeVisible()
  return card
}

test.describe('profile insights', () => {
  test('the card lists the skills the job descriptions ask for that the profile lacks, most asked first', async ({ app }) => {
    const card = await openCard(app)
    await expect(card.card).toContainText('Updated today')
    await expect(card.card).toContainText('Asked for by jobs, missing from your profile')

    // Kafka is asked by two postings, the rest by one; the stated gap (Kubernetes) is noted, not offered.
    await expect(card.gap('Kafka')).toContainText('2 jobs')
    await expect(card.gap('Airflow')).toContainText('1 job')
    await expect(card.gap('GraphQL')).toContainText('1 job')
    await expect(card.gap('React')).toContainText('1 job')
    await expect(card.card.getByRole('button', { name: /^Show all/ })).toHaveCount(0)
    await expect(card.card).toContainText('Already in your Gaps & notes: Kubernetes')
    await expect(card.card.getByRole('button', { name: 'Not me', exact: true })).toHaveCount(5)
    // Nothing is empty in this profile: no "Empty:" badges.
    await expect(card.card.getByText('Empty:')).toHaveCount(0)

    // The job badge names the postings that ask.
    await card.gap('Kafka').getByText('2 jobs').hover()
    await expect(app.window.getByRole('tooltip', { name: /Platform Engineer/ })).toContainText('Data Engineer, Streaming')
  })

  test('"Not me" hides the gap, persists it in .huntgry/profile-insights.json and survives a relaunch; restore brings it back', async ({ app }) => {
    const card = await openCard(app)
    await card.notMe('Kafka')
    await expect(card.card.getByRole('button', { name: 'Not me', exact: true })).toHaveCount(4)

    const file = JSON.parse(await readFile(insightsFile(app.workspace!), 'utf8')) as { dismissed: Array<Record<string, string>> }
    expect(file.dismissed).toHaveLength(1)
    expect(file.dismissed[0]).toMatchObject({ key: 'kafka', skill: 'Kafka' })
    expect(file.dismissed[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    await app.relaunch()
    const again = await openCard(app)
    await expect(again.gap('Airflow')).toBeVisible()
    await expect(again.card.getByText('Kafka', { exact: true }).filter({ visible: true })).toHaveCount(0)

    await again.dismissedToggle.click()
    await expect(again.dismissedToggle).toHaveText(/^Hide 1 marked/)
    await again.card.getByText('Kafka', { exact: true }).locator('xpath=..').getByRole('button', { name: 'restore' }).click()
    await expect(again.gap('Kafka')).toContainText('2 jobs')
    await expect.poll(async () => JSON.parse(await readFile(insightsFile(app.workspace!), 'utf8'))).toEqual({ dismissed: [] })
  })

  test('"I have this" previews the change and saves the evidence into the chosen experience', async ({ app }) => {
    const card = await openCard(app)
    const before = await profileOf(app.workspace!)
    const modal = await card.haveThis('GraphQL')

    // The first experience is preselected; the preview shows only the technology line so far.
    await expect(modal.getByRole('combobox', { name: 'Where did you use it?' })).toHaveValue('Senior Backend Engineer · Acme Corp')
    await expect(modal.getByRole('checkbox', { name: "List GraphQL in this entry's technologies" })).toBeChecked()
    await expect(modal.getByText('Change to master-profile.md')).toBeVisible()
    await expect(modal.getByText('+ Technologies: Go, PostgreSQL, AWS, GraphQL')).toBeVisible()

    // Pick the other experience and write the bullet by hand.
    await modal.getByRole('combobox', { name: 'Where did you use it?' }).click()
    await app.window.getByRole('option', { name: 'Software Engineer · Globex Corporation' }).click()
    await modal.getByLabel('Highlight to add').fill('Exposed the reporting data through a GraphQL API used by two internal tools.')
    await expect(modal.getByText('+ Technologies: Python, Django, Redis, GraphQL')).toBeVisible()
    await expect(modal.getByText('+ - Exposed the reporting data through a GraphQL API used by two internal tools.')).toBeVisible()
    expect(await profileOf(app.workspace!)).toBe(before)

    await modal.getByRole('button', { name: 'Save to master profile' }).click()
    await expect(modal).toBeHidden()
    await expect(card.card.getByText('GraphQL', { exact: true })).toHaveCount(0)
    await expect(card.card.getByRole('button', { name: 'Not me', exact: true })).toHaveCount(4)

    const after = await profileOf(app.workspace!)
    expect(after).toContain('### Globex Corporation')
    expect(after).toContain('- Technologies: Python, Django, Redis, GraphQL')
    expect(after).toContain('  - Exposed the reporting data through a GraphQL API used by two internal tools.')
    expect(after).toContain('- Technologies: Go, PostgreSQL, AWS\n')
    // The Skills card on the dashboard follows without a reload: GraphQL is no longer a gap.
    const skills = app.window
      .locator('div')
      .filter({ has: app.window.getByRole('heading', { name: 'Skills', level: 4 }) })
      .filter({ hasText: 'Strongest evidence' })
      .last()
    await expect(skills.getByText('GraphQL · 3.5y')).toBeVisible()
    await expect(skills.getByText('GraphQL · 1 job')).toHaveCount(0)
    await expect(skills.getByText('Kafka · 2 jobs')).toBeVisible()

    // The editor shows the evidence too.
    await new Shell(app.window).goTo('profile')
    const editor = new ProfileEditor(app.window)
    await editor.openTab(/^Experience \(2\)/)
    await editor.entry('Software Engineer · Globex Corporation · Jun 2018 – Dec 2021').click()
    await expect(editor.field('Technologies')).toHaveValue('Python, Django, Redis, GraphQL')
    await expect(editor.field('Highlights')).toHaveValue(/GraphQL API used by two internal tools\.$/)
  })

  test('"I have this" can list the skill in a skills group instead', async ({ app }) => {
    const card = await openCard(app)
    const modal = await card.haveThis('Airflow')
    await modal.getByRole('combobox', { name: 'Where did you use it?' }).click()
    await app.window.getByRole('option', { name: 'Only list it in my skills' }).click()
    await expect(modal.getByLabel('Skill group')).toHaveValue('Languages')
    await modal.getByLabel('Skill group').fill('Data')
    await expect(modal.getByText('+ Skills · Data: Airflow')).toBeVisible()
    await modal.getByRole('button', { name: 'Save to master profile' }).click()
    await expect(modal).toBeHidden()
    await expect(card.card.getByText('Airflow', { exact: true })).toHaveCount(0)
    expect(await profileOf(app.workspace!)).toContain('- Data: Airflow')
  })

  test('the Claude draft is unavailable without an agent in the sandbox, and says so', async ({ app }) => {
    const card = await openCard(app)
    const modal = await card.haveThis('Kafka')
    const draft = modal.getByRole('button', { name: 'Draft a bullet with Claude' })
    await expect(draft).toBeDisabled()
    await modal.getByLabel('Your notes (for Claude)').fill('Moved the billing events onto Kafka topics at Acme.')
    await expect(draft).toBeEnabled()
    await draft.click()
    await expect(modal.getByRole('alert')).toHaveText('The claude CLI was not found. See Settings.')
    await expect(draft).toBeEnabled()
    await expect(modal.getByLabel('Highlight to add')).toHaveValue('')
    // Nothing was written by the attempt.
    await modal.getByRole('button', { name: 'Cancel' }).click()
    await expect(modal).toBeHidden()
    expect(await profileOf(app.workspace!)).not.toContain('Kafka')
  })

  test('an empty section is offered as a badge that deep-links into that tab of the editor', async ({ app }) => {
    const card = await openCard(app)
    await expect(card.card.getByText('Empty:')).toHaveCount(0)

    // Remove the only project through the editor and save.
    await new Shell(app.window).goTo('profile')
    const editor = new ProfileEditor(app.window)
    await editor.openTab(/^Projects \(1\)/)
    await editor.entry('tiny-queue').locator('xpath=..').getByRole('button', { name: 'Remove' }).click()
    await expect(editor.tab(/^Projects \(0\)/)).toBeVisible()
    await editor.save()
    expect(await profileOf(app.workspace!)).not.toContain('### tiny-queue')

    await new Shell(app.window).goTo('dashboard')
    const dash = new Dashboard(app.window)
    await expect(dash.heading).toBeVisible()
    await expect(card.card.getByText('Empty:')).toBeVisible()
    await card.emptyBadge('Projects').click()
    await new Shell(app.window).expectActive('profile')
    await editor.expectTabSelected(/^Projects \(0\)/)
    await expect(app.window.getByText('No projects yet.')).toBeVisible()

    // "Open" on the card lands on the editor's first tab.
    await new Shell(app.window).goTo('dashboard')
    await card.openButton.click()
    await new Shell(app.window).expectActive('profile')
    await editor.expectTabSelected('Contact')
  })
})
