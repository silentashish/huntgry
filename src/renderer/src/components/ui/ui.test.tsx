import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button, MantineProvider } from '@mantine/core'
import { describe, expect, it } from 'vitest'
import { cssVariablesResolver, theme } from '../../theme/theme'
import { CompanyAvatar, EmptyState, KpiTile, MonoLabel, PageHeader, ProgressBar, ScoreRing, SectionCard, StatusPill, avatarToneOf, initialsOf, scoreTone } from '.'

const render = (ui: ReactElement): string =>
  renderToStaticMarkup(
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} forceColorScheme="dark">
      {ui}
    </MantineProvider>
  )

describe('PageHeader', () => {
  it('renders the eyebrow, an h2 title, the subtitle and the actions', () => {
    const html = render(<PageHeader eyebrow="The scent board · 31 saved" title="Jobs" subtitle="Ranked by scent." actions={<Button variant="primary">Tailor all (3)</Button>} />)
    expect(html).toContain('The scent board · 31 saved')
    expect(html).toMatch(/<h2[^>]*>Jobs<\/h2>/)
    expect(html).toContain('Ranked by scent.')
    expect(html).toContain('data-variant="primary"')
  })

  it('can render an h1 and leaves out what it is not given', () => {
    const html = render(<PageHeader title="Welcome" titleOrder={1} />)
    expect(html).toMatch(/<h1[^>]*>Welcome<\/h1>/)
    expect(html).not.toContain('<p')
  })
})

describe('KpiTile', () => {
  it('is a toggle button when clickable, pressed when selected', () => {
    const html = render(<KpiTile label="Total" value={24} selected onClick={() => {}} />)
    expect(html).toMatch(/<button[^>]*type="button"/)
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('data-selected="true"')
    expect(html).toContain('>24<')
  })

  it('is a plain button, not a toggle, when clickable without a selected state', () => {
    const html = render(<KpiTile label="Applied" value={3} onClick={() => {}} />)
    expect(html).toMatch(/<button[^>]*type="button"/)
    expect(html).not.toContain('aria-pressed')
  })

  it('is a plain block otherwise, with its sub line', () => {
    const html = render(<KpiTile label="Est. API cost" value="$14.20" sub="$0.37/run" size="sm" />)
    expect(html).not.toContain('<button')
    expect(html).toContain('data-size="sm"')
    expect(html).toContain('$0.37/run')
  })
})

describe('StatusPill', () => {
  it('carries its tone, variant and dot', () => {
    const html = render(
      <StatusPill tone="success" variant="outline" dot>
        Approved
      </StatusPill>
    )
    expect(html).toContain('data-tone="success"')
    expect(html).toContain('data-variant="outline"')
    expect(html).toContain('--tone-fg:var(--hg-status-success)')
    expect(html).toContain('Approved')
  })

  it('defaults to a soft neutral pill without a dot', () => {
    const html = render(<StatusPill>Generated</StatusPill>)
    expect(html).toContain('data-tone="neutral"')
    expect(html).toContain('data-variant="soft"')
    expect(html).not.toContain('aria-hidden')
  })
})

describe('ScoreRing', () => {
  it('colours the score: strong Ember, fair warning, faint neutral', () => {
    expect([92, 80, 79, 60, 59, 0].map(scoreTone)).toEqual(['accent', 'accent', 'warning', 'warning', 'neutral', 'neutral'])
  })

  it('shows the clamped score with an accessible name and caption', () => {
    const html = render(<ScoreRing value={104.4} caption="scent" />)
    expect(html).toContain('aria-label="Scent 100 of 100"')
    expect(html).toContain('>100<')
    expect(html).toContain('scent')
  })

  it('has a done mode with a check and an initial mode with a letter', () => {
    const done = render(<ScoreRing mode="done" />)
    expect(done).toContain('aria-label="Done"')
    expect(done).toContain('data-tone="success"')
    expect(done).toContain('<svg')
    const initial = render(<ScoreRing mode="initial" letter="Stripe" />)
    expect(initial).toContain('>St<')
    // An astral character counts as one letter, not two halves of a surrogate pair.
    expect(render(<ScoreRing mode="initial" letter="🦊x" />)).toContain('>🦊x<')
    expect(initial).toContain('data-tone="neutral"')
  })
})

describe('CompanyAvatar', () => {
  it('takes two initials from a name', () => {
    expect(initialsOf('Stripe')).toBe('St')
    expect(initialsOf('Ashish Gautam')).toBe('AG')
    expect(initialsOf('  ')).toBe('?')
    expect(initialsOf('é')).toBe('É')
  })

  it('keeps a stable tone per name and labels the image with the name', () => {
    expect(avatarToneOf('Vercel')).toBe(avatarToneOf(' vercel '))
    const html = render(<CompanyAvatar name="Linear" tone="review" />)
    expect(html).toContain('aria-label="Linear"')
    expect(html).toContain('data-tone="review"')
    expect(html).toContain('>Li<')
  })
})

describe('MonoLabel, SectionCard, EmptyState, ProgressBar', () => {
  it('renders a mono label with its size and tone', () => {
    expect(render(<MonoLabel size="xs" tone="accent">4m 12s</MonoLabel>)).toMatch(/<span[^>]*data-size="xs"[^>]*data-tone="accent"[^>]*>4m 12s<\/span>/)
  })

  it('renders a Mantine card with a titled header', () => {
    const html = render(
      <SectionCard title="Last unattended pipeline" badge={<StatusPill tone="success">Finished</StatusPill>} accent="trail">
        body
      </SectionCard>
    )
    expect(html).toContain('mantine-Card-root')
    expect(html).toMatch(/<h3[^>]*>Last unattended pipeline<\/h3>/)
    expect(html).toContain('data-accent="trail"')
    expect(html).toContain('body')
  })

  it('renders an empty state with its heading, description and actions', () => {
    const html = render(<EmptyState title="Nothing to review" description="The hound is sleeping." actions={<Button>Find jobs</Button>} />)
    expect(html).toMatch(/<h3[^>]*>Nothing to review<\/h3>/)
    expect(html).toContain('The hound is sleeping.')
    expect(html).toContain('Find jobs')
  })

  it('renders a progress bar clamped to 0–100', () => {
    const html = render(<ProgressBar value={140} tone="trail" aria-label="5 of 20 jobs" />)
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="100"')
    expect(html).toContain('width:100%')
    expect(html).toContain('aria-label="5 of 20 jobs"')
  })
})
