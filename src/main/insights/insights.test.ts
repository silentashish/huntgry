import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyExperience, emptyProfile } from '@shared/master-profile'
import type { Job } from '@shared/jobs-types'
import { draftArgs, draftEvidence, parseDraftOutput } from './draft'
import { collectJobTexts, sameJobUrl } from './jobs'
import { dismissGap, readDismissed, restoreGap } from './store'

let ws: string
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-insights-'))
})
afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
})

describe('dismissed gaps store', () => {
  it('dismisses, replaces and restores, surviving concurrent writes', async () => {
    expect(await readDismissed(ws)).toEqual([])
    await Promise.all([dismissGap(ws, 'kafka', 'Kafka'), dismissGap(ws, 'rust', 'Rust'), dismissGap(ws, 'kafka', 'Kafka')])
    expect((await readDismissed(ws)).map((d) => d.key).sort()).toEqual(['kafka', 'rust'])
    await restoreGap(ws, 'kafka')
    expect((await readDismissed(ws)).map((d) => d.key)).toEqual(['rust'])
    const raw = JSON.parse(await readFile(join(ws, '.huntgry/profile-insights.json'), 'utf8'))
    expect(raw.dismissed[0]).toMatchObject({ key: 'rust', skill: 'Rust' })
  })

  it('treats a corrupt file as empty', async () => {
    await mkdir(join(ws, '.huntgry'))
    await writeFile(join(ws, '.huntgry/profile-insights.json'), '{nope')
    expect(await readDismissed(ws)).toEqual([])
    await writeFile(join(ws, '.huntgry/profile-insights.json'), JSON.stringify({ dismissed: [{ key: 1 }, { key: 'go', skill: 'Go', at: 'x' }] }))
    expect((await readDismissed(ws)).map((d) => d.key)).toEqual(['go'])
  })
})

describe('Claude draft', () => {
  const profile = { ...emptyProfile(), experience: [{ ...emptyExperience(), company: 'Orbital', role: 'Engineer' }] }
  const fake = { command: process.execPath, env: { ...process.env } }
  const req = (notes: string) => ({ skill: 'Kafka', target: { kind: 'experience' as const, index: 0 }, notes })

  it('runs without tools, settings, MCP servers or a saved session', () => {
    const args = draftArgs()
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--no-session-persistence')
    expect(args).not.toContain('--dangerously-skip-permissions')
    // Claude Code < 2.1.259 rejects --permission-prompts.
    expect(args).not.toContain('--permission-prompts')
    const newer = draftArgs({ permissionPrompts: true })
    expect(newer[newer.indexOf('--permission-prompts') + 1]).toBe('none')
  })

  it('returns the bullet and flags numbers the notes do not contain', async () => {
    // A Node script standing in for `claude`, run through node so it works on every platform.
    const script = join(__dirname, 'fixtures/fake-claude-draft.mjs')
    const withScript = (notes: string) =>
      draftEvidence(req(notes), profile, { command: process.execPath, args: [script], env: fake.env })
    const honest = await withScript('I wrote consumers for 12 topics in Go')
    expect(honest).toMatchObject({ bullet: 'Wrote Kafka consumers (12 topics) in Go.', unsupportedNumbers: [], costUsd: 0.002 })
    const invented = await withScript('I wrote some consumers in Go')
    expect(invented.unsupportedNumbers).toEqual(['40'])
  })

  it('refuses empty notes and reports Claude errors', async () => {
    await expect(draftEvidence(req('kafka'), profile, fake)).rejects.toThrow(/sentence or two/)
    expect(() => parseDraftOutput(JSON.stringify({ is_error: true, result: 'rate limited' }))).toThrow(/rate limited/)
    expect(() => parseDraftOutput('not json')).toThrow(/unexpected/)
    expect(() => parseDraftOutput(JSON.stringify({ structured_output: { bullet: ' ' } }))).toThrow(/empty/)
  })
})

describe('job texts for gap insights', () => {
  const saved = (id: string, url: string, extra: Partial<Job> = {}): Job =>
    ({ id, source: 'hiring.cafe', sourceId: id, title: `Job ${id}`, company: 'Acme', location: '', remote: false, salary: '', postedAt: null, url, boardUrl: null, description: 'Kafka and Go.', descriptionComplete: false, tags: ['Terraform'], fetchedAt: '2030-01-01T00:00:00Z', ...extra }) as Job

  it('combines applications and saved jobs, skipping dismissed and already-applied ones', async () => {
    const texts = await collectJobTexts('/ws', {
      applications: async () => [{ id: 'eng/acme/1', title: 'Backend', text: 'Python' }],
      urls: async () => ['https://www.jobs.example.com/a/?utm_source=x#top', null],
      saved: async () => [
        saved('hiring.cafe:a', 'https://jobs.example.com/a'),
        saved('hiring.cafe:b', 'https://jobs.example.com/b'),
        saved('hiring.cafe:c', 'https://jobs.example.com/c', { dismissed: true })
      ]
    })
    expect(texts.map((t) => [t.id, t.kind])).toEqual([
      ['eng/acme/1', 'application'],
      ['hiring.cafe:b', 'saved']
    ])
    expect(texts[1].text).toContain('Kafka and Go.')
    expect(texts[1].text).toContain('Terraform')
    expect(texts[1].title).toBe('Job hiring.cafe:b · Acme')
  })

  it('still works when a source fails', async () => {
    const texts = await collectJobTexts('/ws', {
      applications: async () => {
        throw new Error('EACCES')
      },
      urls: async () => {
        throw new Error('EACCES')
      },
      saved: async () => [saved('hiring.cafe:b', 'https://jobs.example.com/b')]
    })
    expect(texts.map((t) => t.id)).toEqual(['hiring.cafe:b'])
  })

  it('compares posting URLs loosely', () => {
    expect(sameJobUrl('https://WWW.Example.com/j/1/?gh_src=a&id=2#x')).toBe(sameJobUrl('https://example.com/j/1?id=2'))
    expect(sameJobUrl('https://example.com/j/1?id=2')).not.toBe(sameJobUrl('https://example.com/j/1?id=3'))
  })
})
