import { describe, expect, it } from 'vitest'
import type { ApplicationRecord } from '@shared/applications-types'
import type { Job } from '@shared/jobs-types'
import type { MasterProfile } from '@shared/master-profile'
import type { RunSummary } from '@shared/runner-types'
import { flatten, normalize, paletteItems, scoreItem, searchPalette, wordScore, type PaletteData, type PaletteItem } from './search'

function job(over: Partial<Job> & Pick<Job, 'id' | 'title' | 'company'>): Job {
  return {
    source: 'pasted',
    sourceId: over.id.split(':')[1] ?? over.id,
    location: '',
    remote: false,
    salary: '',
    postedAt: null,
    url: `https://jobs.example.com/${over.id}`,
    boardUrl: null,
    description: 'Build things.',
    descriptionComplete: true,
    tags: [],
    fetchedAt: '2026-10-01T00:00:00Z',
    ...over
  } as Job
}

function app(over: Partial<ApplicationRecord> & Pick<ApplicationRecord, 'id' | 'company' | 'role'>): ApplicationRecord {
  return {
    jobId: '',
    jobTitle: '',
    jobUrl: null,
    createdAt: '2026-10-02T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    files: ['resume.pdf'],
    resumePages: [],
    coverPages: [],
    build: { status: 'unknown' } as unknown as ApplicationRecord['build'],
    tracking: { status: 'generated', notes: '' } as ApplicationRecord['tracking'],
    ...over
  }
}

function run(over: Partial<RunSummary> & Pick<RunSummary, 'id' | 'title' | 'status'>): RunSummary {
  return {
    params: {} as RunSummary['params'],
    agent: 'claude',
    sessionId: null,
    createdAt: '2026-10-03T00:00:00Z',
    updatedAt: '2026-10-03T00:00:00Z',
    outputFolder: null,
    outputFiles: [],
    costUsd: 0,
    ...over
  } as RunSummary
}

const profile = {
  experience: [{ company: 'Stripe', role: 'Engineering Intern', start: '2019', end: '2019', technologies: 'Ruby', location: '' }],
  projects: [{ name: 'tiny-queue', technologies: 'Go', link: '', dates: '', description: '', highlights: [] }],
  skills: [{ category: 'Languages', items: ['TypeScript', 'Postgres', 'Go'] }]
} as unknown as MasterProfile

function data(over: Partial<PaletteData> = {}): PaletteData {
  return {
    jobs: [
      job({ id: 'manual:1', title: 'Senior Backend Engineer, Payments', company: 'Stripe' }),
      job({ id: 'manual:2', title: 'Staff Frontend Engineer', company: 'Vercel', url: '' })
    ],
    applications: [app({ id: 'Senior Backend Engineer/Stripe/1', company: 'Stripe', role: 'Senior Backend Engineer', jobId: '1', jobUrl: 'https://jobs.example.com/manual:1' })],
    runs: [run({ id: 'r-1', title: 'Stripe · Senior Backend Engineer', status: 'waiting' }), run({ id: 'r-2', title: 'Globex · SRE', status: 'finished' })],
    reviewIds: new Set(),
    profile,
    scheme: 'dark',
    mod: '⌘',
    ...over
  }
}

const titles = (items: PaletteItem[]) => items.map((i) => i.title)

describe('palette ranking', () => {
  it('normalizes case, accents and separators', () => {
    expect(normalize('Café · Senior  Engineer → Board')).toBe('cafe senior engineer board')
    expect(normalize('Node.js, C++')).toBe('node.js c++')
  })

  it('scores a word start above a word inside, and letters in order lowest', () => {
    expect(wordScore('stri', 'stripe senior')).toBe(100)
    expect(wordScore('sen', 'stripe senior')).toBe(80)
    expect(wordScore('ripe', 'stripe senior')).toBe(50)
    expect(wordScore('stp', 'stripe')).toBe(15)
    expect(wordScore('st', 'sxt')).toBe(0)
    expect(wordScore('zzz', 'stripe')).toBe(0)
  })

  it('needs every query word to match, and ranks the title above the subtitle', () => {
    const item = { title: 'Stripe · Senior Backend Engineer', subtitle: 'Remote', keywords: 'payments' }
    expect(scoreItem('stripe backend', item)).toBeGreaterThan(0)
    expect(scoreItem('stripe frontend', item)).toBe(0)
    expect(scoreItem('remote', item)).toBeLessThan(scoreItem('senior', item))
    expect(scoreItem('payments', item)).toBeGreaterThan(0)
    expect(scoreItem('', item)).toBe(1)
  })

  it('ranks an exact title above a prefix above a later word', () => {
    const exact = scoreItem('jobs', { title: 'Jobs' })
    const prefix = scoreItem('jobs', { title: 'Jobs overlay' })
    const later = scoreItem('jobs', { title: 'Tailor all jobs' })
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(later)
  })
})

describe('palette search', () => {
  const items = paletteItems(data())

  it('opens on the pages, the general actions and the live runs', () => {
    const sections = searchPalette(items, '')
    expect(sections.map((s) => s.group)).toEqual(['goto', 'actions', 'runs'])
    expect(titles(sections[0].items)).toEqual(['Dashboard', 'Board', 'Jobs', 'Explore', 'Browser', 'Tailor', 'Review', 'Profile', 'Settings'])
    expect(titles(sections[1].items)).toEqual(['New tailored resume', 'Paste a job', 'Switch theme', 'Switch workspace'])
    expect(titles(sections[2].items)).toEqual(['Stripe · Senior Backend Engineer'])
  })

  it('groups matches with counts and lends the best job its actions (Figma 17:352)', () => {
    const sections = searchPalette(items, 'stri')
    const jobs = sections.find((s) => s.group === 'jobs')!
    expect(jobs.label).toBe('Jobs · 1')
    expect(titles(jobs.items)).toEqual(['Stripe · Senior Backend Engineer, Payments'])
    const actions = sections.find((s) => s.group === 'actions')!
    expect(titles(actions.items)).toEqual(['Tailor a resume for Stripe…', 'Open posting in Browser', 'Apply in browser'])
    expect(actions.items[0].command).toMatchObject({ kind: 'tailor-job', job: { id: 'manual:1' } })
    expect(actions.items[2].command).toEqual({ kind: 'apply', applicationId: 'Senior Backend Engineer/Stripe/1' })
    expect(sections.find((s) => s.group === 'profile')?.items.map((i) => i.title)).toEqual(['Stripe · Engineering Intern (2019–2019)'])
  })

  it('orders groups by their best match', () => {
    const sections = searchPalette(items, 'settings')
    expect(sections[0].group).toBe('goto')
    expect(titles(sections[0].items)[0]).toBe('Settings')
    expect(titles(sections[0].items)).toContain('Settings → Pricing')
  })

  it('finds pages by their keywords and the graph as a Profile view', () => {
    const graph = flatten(searchPalette(items, 'graph')).find((i) => i.id === 'view:graph')!
    expect(graph.command).toEqual({ kind: 'navigate', location: { page: 'profile', params: { view: 'graph' } } })
    expect(titles(flatten(searchPalette(items, 'kanban')))).toContain('Board')
    // Applications are browsed on the Board, not the Dashboard (#161).
    const pages = (q: string) => flatten(searchPalette(items, q)).filter((i) => i.group === 'goto').map((i) => i.title)
    expect(pages('applications')).toContain('Board')
    expect(pages('applications')).not.toContain('Dashboard')
  })

  it('opens an application in its drawer on the Board (#161)', () => {
    const stripeApp = items.find((i) => i.group === 'applications')!
    expect(stripeApp.command).toEqual({ kind: 'navigate', location: { page: 'board', params: { applicationId: 'Senior Backend Engineer/Stripe/1' } } })
  })

  it('opens a job without a URL on the Tailor form, and a waiting result on Review', () => {
    const vercel = flatten(searchPalette(items, 'vercel')).find((i) => i.group === 'jobs')!
    expect(vercel.command.kind).toBe('tailor-job')
    const reviewing = paletteItems(data({ reviewIds: new Set(['Senior Backend Engineer/Stripe/1']) }))
    const stripeApp = reviewing.find((i) => i.group === 'applications')!
    expect(stripeApp.subtitle).toMatch(/^Waiting for review/)
    expect(stripeApp.command).toEqual({ kind: 'navigate', location: { page: 'review', params: { applicationId: 'Senior Backend Engineer/Stripe/1' } } })
  })

  it('opens runs on the Tailor page and Settings sections with their section', () => {
    const globex = flatten(searchPalette(items, 'globex'))[0]
    expect(globex.command).toEqual({ kind: 'navigate', location: { page: 'tailor', params: { runId: 'r-2' } } })
    const pricing = flatten(searchPalette(items, 'pricing'))[0]
    expect(pricing.command).toEqual({ kind: 'navigate', location: { page: 'settings', params: { section: 'pricing' } } })
  })

  it('says where Switch theme goes and shows its shortcut', () => {
    const theme = paletteItems(data({ scheme: 'light', mod: 'Ctrl' })).find((i) => i.id === 'action:theme')!
    expect(theme.subtitle).toBe('to dark')
    expect(theme.shortcut).toBe('Ctrl ⇧ L')
  })

  it('caps each group and keeps ids unique', () => {
    const many = paletteItems(data({ jobs: Array.from({ length: 12 }, (_, i) => job({ id: `manual:${i}`, title: `Engineer ${i}`, company: 'Acme' })) }))
    expect(new Set(many.map((i) => i.id)).size).toBe(many.length)
    const jobs = searchPalette(many, 'acme').find((s) => s.group === 'jobs')!
    expect(jobs.items).toHaveLength(5)
    expect(jobs.label).toBe('Jobs · 12')
  })

  it('lists a skill once whatever its case, so ids stay unique', () => {
    const twice = { ...profile, skills: [{ category: 'A', items: ['React', 'Go'] }, { category: 'B', items: ['react', ' Go '] }] } as MasterProfile
    const items = paletteItems(data({ profile: twice })).filter((i) => i.id.startsWith('profile-skill:'))
    expect(items.map((i) => i.title)).toEqual(['React', 'Go'])
    const all = paletteItems(data({ profile: twice }))
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length)
  })

  it('returns nothing for a query nothing matches', () => {
    expect(searchPalette(items, 'qwxz')).toEqual([])
  })
})
