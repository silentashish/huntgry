import { expect, test } from '../fixtures/app'
import { GraphPage } from '../pages/graph'
import { ProfileEditor } from '../pages/profile-editor'
import { Shell } from '../pages/shell'

/**
 * Knowledge graph flows on the `demo` workspace. The force-directed canvas is
 * never inspected: nodes are asserted through the "Jump to…" list (every node
 * as `<Kind>: <label>`), skills through the Skills table view, and the node
 * panel through its markup.
 */
test.use({ workspace: 'demo' })

async function openGraph(app: { window: import('@playwright/test').Page }): Promise<GraphPage> {
  await new Shell(app.window).goTo('graph')
  const graph = new GraphPage(app.window)
  await graph.expectVisible()
  return graph
}

test.describe('knowledge graph', () => {
  test('the graph has a node for the person, every role, company, project and skill, and the jobs overlay', async ({ app }) => {
    const graph = await openGraph(app)
    await expect(graph.viewSwitch.getByRole('radio', { name: 'Graph' })).toBeChecked()
    await expect(graph.jobsOverlayChip).toHaveText('Jobs overlay (5)')
    await expect(graph.jobsOverlay).toBeChecked()
    // The legend lists the kinds drawn, gaps included.
    for (const kind of ['You', 'Role', 'Company', 'Project', 'Skill', 'Education', 'Certification', 'Job', 'Gap (asked for, not in profile)']) {
      await expect(app.window.getByText(kind, { exact: true })).toBeVisible()
    }

    const nodes = await graph.nodeLabels()
    expect(nodes).toEqual(
      expect.arrayContaining([
        'You: Alex Rivera',
        'Role: Senior Backend Engineer',
        'Role: Software Engineer',
        'Company: Acme Corp',
        'Company: Globex Corporation',
        'Project: tiny-queue',
        'Education: State University',
        'Certification: Cloud Practitioner',
        'Skill: Go',
        'Skill: PostgreSQL',
        'Skill: Terraform',
        'Skill: Kafka',
        'Job: Platform Engineer',
        'Job: Data Engineer, Streaming',
        'Job: Frontend Engineer'
      ])
    )
    const count = (kind: string) => nodes.filter((n) => n.startsWith(`${kind}: `)).length
    expect(count('Role')).toBe(2)
    expect(count('Company')).toBe(2)
    expect(count('Job')).toBe(5)
    expect(count('Skill')).toBeGreaterThanOrEqual(12)
    expect(nodes.length).toBe(count('You') + count('Role') + count('Company') + count('Project') + count('Education') + count('Certification') + count('Skill') + count('Job'))

    // With the overlay off, jobs and gaps are not in the graph at all.
    await graph.toggleJobsOverlay(false)
    const without = await graph.nodeLabels()
    expect(without.filter((n) => n.startsWith('Job: '))).toEqual([])
    expect(without).not.toContain('Skill: Kafka')
    expect(without).toContain('Skill: Go')
    await expect(app.window.getByText('Gap (asked for, not in profile)')).toHaveCount(0)
  })

  test('the Skills table lists every skill with its years, evidence and jobs asking, and the overlay marks the gaps', async ({ app }) => {
    const appYear = () => app.electronApp.evaluate(() => {
      const now = new Date()
      return now.getFullYear() + now.getMonth() / 12
    })
    const started = await appYear()
    const graph = await openGraph(app)
    await graph.showView('Skills')
    await expect(graph.skillsTable.getByRole('columnheader', { name: /^Skill/ })).toBeVisible()
    await expect(graph.skillsTable.getByRole('columnheader', { name: /^Jobs asking/ })).toBeVisible()

    // Acme's Go experience runs from Jan 2022 to Present. The value rounds to half-years,
    // so it changes at month boundaries; accept either side if the test crosses one.
    const go = graph.skillRow('Go')
    await expect(go.getByRole('cell').nth(1)).toHaveText('Languages')
    const expectedYears = (year: number): string => String(Math.round((year - 2022) * 2) / 2)
    expect([expectedYears(started), expectedYears(await appYear())]).toContain((await go.getByRole('cell').nth(2).innerText()).trim())
    await expect(go.getByRole('cell').nth(3)).toHaveText('2')
    await expect(go.getByRole('cell').nth(4)).toHaveText('2')
    await expect(go.getByText('gap')).toHaveCount(0)

    // A gap: asked for by the Initech and Umbrella postings, no evidence, no years.
    const kafka = graph.skillRow('Kafka')
    await expect(kafka.getByText('gap', { exact: true })).toBeVisible()
    await expect(kafka.getByRole('cell').nth(2)).toHaveText('–')
    await expect(kafka.getByRole('cell').nth(3)).toHaveText('–')
    await expect(kafka.getByRole('cell').nth(4)).toHaveText('2')
    for (const gap of ['Airflow', 'GraphQL', 'React', 'Spark', 'Kubernetes']) {
      await expect(graph.skillRow(gap).getByText('gap', { exact: true })).toBeVisible()
    }

    // The filter narrows by name or group.
    await graph.searchInput.fill('Cloud')
    await expect(graph.skillRow('AWS')).toBeVisible()
    await expect(graph.skillRow('Go')).toHaveCount(0)
    await graph.searchInput.fill('')

    // Overlay off: the gap rows are gone, the profile's skills stay.
    await graph.toggleJobsOverlay(false)
    await expect(graph.skillRow('Kafka')).toHaveCount(0)
    await expect(graph.skillRow('Go')).toBeVisible()
    await expect(go.getByRole('cell').nth(4)).toHaveText('–')
  })

  test('clicking a skill row opens its panel; "Edit in master profile" deep-links to the Summary & skills tab', async ({ app }) => {
    const graph = await openGraph(app)
    await graph.showView('Skills')

    await graph.skillRow('Kafka').getByRole('button', { name: 'Show details for Kafka' }).click()
    const kafka = graph.nodePanel('Kafka')
    await expect(kafka).toContainText('Gap')
    await expect(kafka).toContainText('2 jobs ask')
    await expect(kafka).toContainText('Saved job descriptions ask for Kafka, but your master profile never mentions it.')

    await graph.skillRow('PostgreSQL').getByRole('button', { name: 'Show details for PostgreSQL' }).click()
    const pg = graph.nodePanel('PostgreSQL')
    await expect(pg).toContainText('8.5 years')
    await expect(pg).toContainText('Senior Backend Engineer · Acme Corp')
    await expect(pg).toContainText('Software Engineer · Globex Corporation')
    await expect(pg).toContainText('Migrated nightly reports to PostgreSQL')

    await pg.getByRole('button', { name: 'Edit in master profile' }).click()
    await new Shell(app.window).expectActive('profile')
    const editor = new ProfileEditor(app.window)
    await editor.expectTabSelected('Summary & skills')
    await expect(editor.field('Summary')).toContainText('Backend engineer with seven years')
  })
})
