import { renderToStaticMarkup } from 'react-dom/server'
import { MantineProvider } from '@mantine/core'
import { describe, expect, it } from 'vitest'
import type { RunSummary } from '@shared/runner-types'
import { RunList } from './RunList'

const run = (over: Partial<RunSummary>): RunSummary => ({
  id: '20260930-120000-abcdef',
  title: 'Staff Engineer · Acme',
  params: { coverLetter: false, dateStyle: 'right' },
  agent: 'claude',
  status: 'waiting',
  sessionId: 's',
  createdAt: '2026-09-30T12:00:00.000Z',
  updatedAt: '2026-09-30T12:00:00.000Z',
  outputFolder: null,
  outputFiles: [],
  costUsd: 0,
  live: false,
  ...over
})

const render = (runs: RunSummary[], selected: string | null) =>
  renderToStaticMarkup(
    <MantineProvider>
      <RunList runs={runs} selected={selected} onSelect={() => undefined} />
    </MantineProvider>
  )

describe('RunList', () => {
  it('renders every run as a real button (focusable, named by its title), the open one marked current', () => {
    const html = render([run({}), run({ id: '20260930-120100-abcdef', title: 'SRE · Globex', status: 'finished' })], '20260930-120100-abcdef')
    const buttons = html.match(/<button[^>]*type="button"[^>]*>/g) ?? []
    // "New run" plus one per run; no <a> without href.
    expect(buttons).toHaveLength(3)
    expect(html).not.toMatch(/<a\s(?![^>]*href=)/)
    expect(html).toContain('Staff Engineer · Acme')
    expect(html).toMatch(/<button[^>]*aria-current="true"[^>]*>(?:(?!<\/button>).)*SRE · Globex/s)
    expect(html).not.toMatch(/<button[^>]*aria-current="true"[^>]*>(?:(?!<\/button>).)*Staff Engineer · Acme/s)
    expect(html).toContain('1 run waiting for your reply')
  })
})
