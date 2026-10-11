import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures/app'
import { GraphPage } from '../pages/graph'
import { ProfileEditor } from '../pages/profile-editor'
import { Shell } from '../pages/shell'

/**
 * Knowledge graph flows on the `demo` workspace, reached through Profile → Knowledge graph
 * (#95: the graph is a view of the Profile page). The force-directed canvas is never
 * inspected: nodes are asserted through the "Jump to…" list (every node as
 * `<Kind>: <label>`), skills through the Skills view's table, and the node panel through
 * its markup.
 */
test.use({ workspace: 'demo' })

async function openGraph(app: { window: import('@playwright/test').Page }): Promise<GraphPage> {
  const graph = new GraphPage(app.window)
  await graph.open()
  return graph
}

test.describe('knowledge graph', () => {
  test('the graph has a node for the person, every role, company, project and skill, and the jobs overlay', async ({ app }) => {
    const graph = await openGraph(app)
    await expect(graph.view('Knowledge graph')).toBeChecked()
    await expect(graph.jobsOverlayChip).toHaveText('Jobs overlay (5)')
    await expect(graph.jobsOverlay).toBeChecked()
    // The legend lists the kinds drawn, gaps included.
    for (const kind of ['You', 'Role', 'Company', 'Project', 'Skill', 'Education', 'Certification', 'Job', 'Gap']) {
      await expect(graph.legend.getByText(kind, { exact: true })).toBeVisible()
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
    await expect(graph.legend.getByText('Gap', { exact: true })).toHaveCount(0)
    await expect(graph.legend.getByText('Skill', { exact: true })).toBeVisible()
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
    const expectedYears = (year: number): string => `${Math.round((year - 2022) * 2) / 2}y`
    expect([expectedYears(started), expectedYears(await appYear())]).toContain((await go.getByRole('cell').nth(2).innerText()).trim())
    // Evidence by where it comes from: the Acme role (its Technologies) besides the skills list.
    await expect(go.getByRole('cell').nth(3)).toHaveText('1 role')
    await expect(go.getByRole('cell').nth(4)).toHaveText('2')
    await expect(go.getByText('gap')).toHaveCount(0)

    // A gap: asked for by the Initech and Umbrella postings, no evidence, no years.
    const kafka = graph.skillRow('Kafka')
    await expect(kafka.getByText('gap', { exact: true })).toBeVisible()
    await expect(kafka.getByRole('cell').nth(2)).toHaveText('–')
    await expect(kafka.getByRole('cell').nth(3)).toHaveText('no evidence')
    await expect(kafka.getByRole('cell').nth(4)).toHaveText('2')
    for (const gap of ['Airflow', 'GraphQL', 'React', 'Spark', 'Kubernetes']) {
      await expect(graph.skillRow(gap).getByText('gap', { exact: true })).toBeVisible()
    }

    // The filter narrows by name or group.
    await graph.searchInput.fill('Cloud')
    await expect(graph.skillRow('AWS')).toBeVisible()
    await expect(graph.skillRow('Go')).toHaveCount(0)
    await graph.searchInput.fill('')

    // Gaps only, then everything again.
    await graph.skillFilter.getByText(/^Gaps \(\d+\)$/).click()
    await expect(graph.skillRow('Kafka')).toBeVisible()
    await expect(graph.skillRow('Go')).toHaveCount(0)
    await graph.skillFilter.getByText(/^All \(\d+\)$/).click()
    await expect(graph.skillRow('Go')).toBeVisible()

    // A sortable header sorts by its column; clicking it again flips the order.
    const firstRow = graph.skillsTable.getByRole('row').nth(1)
    await graph.sortHeaderButton('Skill').click()
    await expect(graph.sortHeader('Skill')).toHaveAttribute('aria-sort', 'ascending')
    await expect(firstRow).toContainText('Airflow')
    await graph.sortHeaderButton('Skill').click()
    await expect(graph.sortHeader('Skill')).toHaveAttribute('aria-sort', 'descending')
    await expect(firstRow).toContainText('TypeScript')
    await graph.sortHeaderButton('Jobs asking').click()
    await expect(graph.sortHeader('Jobs asking')).toHaveAttribute('aria-sort', 'descending')
    await expect(graph.sortHeader('Skill')).not.toHaveAttribute('aria-sort', /./)

    // Overlay off: the gap rows are gone, the profile's skills stay.
    await graph.toggleJobsOverlay(false)
    await expect(graph.skillRow('Kafka')).toHaveCount(0)
    await expect(graph.skillRow('Go')).toBeVisible()
    await expect(go.getByRole('cell').nth(4)).toHaveText('–')
  })

  test('clicking a skill row opens its panel; "Edit in master profile" deep-links to the Summary & skills section of the Editor', async ({ app }) => {
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

    // The selection follows into the Knowledge graph view.
    await graph.showView('Knowledge graph')
    await expect(graph.nodePanel('PostgreSQL')).toContainText('8.5 years')

    await graph.nodePanel('PostgreSQL').getByRole('button', { name: 'Edit in master profile' }).click()
    await new Shell(app.window).expectActive('profile')
    const editor = new ProfileEditor(app.window)
    await editor.expectView('Editor')
    await editor.expectTabSelected('Summary & skills')
    await expect(editor.field('Summary')).toContainText('Backend engineer with seven years')
  })

  test('the graph follows a save from the save bar, and Refresh picks up edits made on disk', async ({ app }) => {
    const editor = new ProfileEditor(app.window)
    await new Shell(app.window).goTo('profile')
    await editor.field('Full name').fill('Alex Q. Rivera')
    const graph = new GraphPage(app.window)
    await graph.showView('Knowledge graph')
    // The graph is built from the file, so it shows the saved name until the save.
    expect(await graph.nodeLabels()).toContain('You: Alex Rivera')
    await editor.save()
    await expect.poll(() => graph.nodeLabels()).toContain('You: Alex Q. Rivera')

    // Someone edits master-profile.md outside the app: Refresh reads it again.
    const path = join(app.workspace!, 'master-profile.md')
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace('- Languages: Go, Python, TypeScript, SQL', '- Languages: Go, Python, TypeScript, SQL, Elixir'))
    expect(await graph.nodeLabels()).not.toContain('Skill: Elixir')
    await graph.refreshButton.click()
    await expect.poll(() => graph.nodeLabels()).toContain('Skill: Elixir')
  })
})
