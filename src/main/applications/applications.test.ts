import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applicationFileUrl } from '@shared/applications-types'
import {
  applicationFolder,
  firstUrl,
  humanize,
  isServableFile,
  jobTitleOf,
  parseFileUrl,
  scanApplications,
  summarizeBuild
} from './scan'
import { normalizeTracking, readTracking, recordJobSource, updateTracking } from './tracking'
import { isHidden } from './watch'

let ws: string
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-apps-'))
})
afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
})

async function app(rel: string, files: Record<string, string>): Promise<string> {
  const dir = join(ws, rel)
  await mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
  return dir
}

const REPORT = JSON.stringify({
  ok: false,
  render: { pages: 2, target_pages: 1 },
  verify: {
    ok: false,
    results: [
      { check: 'text_extractable', passed: true, hard: true },
      { check: 'fits_target_pages', passed: false, hard: true },
      { check: 'dates_stay_with_employer', passed: false, hard: false }
    ]
  },
  style_warnings: ['x']
})

describe('scanApplications', () => {
  it('lists <role>/<company>/<job-id> folders with their files, build and posting URL', async () => {
    await app('backend-engineer/northwind-analytics/nw-001', {
      'job-description.md': 'Backend Engineer, Data Platform - Northwind\n\nApply at https://jobs.example.com/nw/1.\n',
      'resume.pdf': '%PDF',
      'cover.pdf': '%PDF',
      'build-report.json': JSON.stringify({ ok: true, render: { pages: 1 }, verify: { results: [] } }),
      'resume-page-2.jpg': 'j',
      'resume-page-1.jpg': 'j',
      'cover-page-1.jpg': 'j',
      'notes.txt': 'ignored'
    })
    await app('sre/acme/42', { 'resume_data.json': '{}', 'build-report.json': REPORT })
    const { applications, truncated } = await scanApplications(ws)
    expect(truncated).toBe(false)
    expect(applications).toHaveLength(2)
    const nw = applications.find((a) => a.jobId === 'nw-001')!
    expect(nw).toMatchObject({
      id: 'backend-engineer/northwind-analytics/nw-001',
      role: 'Backend Engineer',
      company: 'Northwind Analytics',
      jobTitle: 'Backend Engineer, Data Platform - Northwind',
      jobUrl: 'https://jobs.example.com/nw/1',
      files: ['build-report.json', 'cover.pdf', 'job-description.md', 'resume.pdf'],
      resumePages: ['resume-page-1.jpg', 'resume-page-2.jpg'],
      coverPages: ['cover-page-1.jpg'],
      build: { status: 'pass', failed: [] },
      tracking: { status: 'generated', notes: '' }
    })
    const acme = applications.find((a) => a.jobId === '42')!
    expect(acme.role).toBe('SRE')
    expect(acme.build).toEqual({ status: 'fail', failed: ['fits_target_pages'], warnings: 2, resumePages: 2 })
    expect(acme.jobUrl).toBeNull()
  })

  it('ignores hidden folders, non-application folders, wrong depths and symlinked directories', async () => {
    await app('.huntgry/runs/20260101-000000-abcdef', { 'resume.pdf': 'x' })
    await app('eng/co', { 'resume.pdf': 'x' })
    await app('eng/co/1/deeper', { 'resume.pdf': 'x' })
    await app('eng/co/2', { 'README.md': 'not a marker' })
    const real = await app('eng/co/3', { 'job-description.md': 'Job' })
    await mkdir(join(ws, 'linked/co'), { recursive: true })
    await symlink(real, join(ws, 'linked/co/4'))
    const { applications } = await scanApplications(ws)
    expect(applications.map((a) => a.id)).toEqual(['eng/co/3'])
  })

  it('survives broken files and an empty workspace', async () => {
    expect((await scanApplications(ws)).applications).toEqual([])
    await app('a/b/c', { 'build-report.json': '{not json', 'huntgry.json': 'nope', 'job-description.md': '' })
    const [rec] = (await scanApplications(ws)).applications
    expect(rec.build.status).toBe('unknown')
    expect(rec.tracking.status).toBe('generated')
  })
})

describe('tracking', () => {
  it('merges updates, stamps appliedAt once, and keeps the skill files untouched', async () => {
    const dir = await app('eng/acme/1', { 'resume.pdf': 'original' })
    const t1 = await updateTracking(dir, { status: 'applied' }, new Date('2026-09-29T10:00:00Z'))
    expect(t1).toEqual({ status: 'applied', notes: '', appliedAt: '2026-09-29' })
    const t2 = await updateTracking(dir, { notes: 'Recruiter: Sam', status: 'interviewing' })
    expect(t2).toMatchObject({ status: 'interviewing', appliedAt: '2026-09-29', notes: 'Recruiter: Sam' })
    const t3 = await updateTracking(dir, { appliedAt: '' })
    expect(t3.appliedAt).toBeUndefined()
    expect(await readFile(join(dir, 'resume.pdf'), 'utf8')).toBe('original')
    expect(JSON.parse(await readFile(join(dir, 'huntgry.json'), 'utf8'))).toEqual(t3)
  })

  it('records the job source without resetting status or notes', async () => {
    const dir = await app('eng/acme/2', {})
    await updateTracking(dir, { status: 'offer', notes: 'yay' })
    await recordJobSource(dir, 'https://www.indeed.com/viewjob?jk=1', 'indeed')
    expect(await readTracking(dir)).toMatchObject({
      status: 'offer',
      notes: 'yay',
      source: 'indeed',
      jobUrl: 'https://www.indeed.com/viewjob?jk=1'
    })
  })

  it('drops invalid fields', () => {
    expect(
      normalizeTracking({ status: 'hired', appliedAt: 'yesterday', jobUrl: 'javascript:alert(1)', extra: 1 })
    ).toEqual({
      status: 'generated',
      notes: ''
    })
  })
})

describe('helpers', () => {
  it('humanizes slugs and leaves other names alone', () => {
    expect(humanize('ml-engineer')).toBe('ML Engineer')
    expect(humanize('stripe')).toBe('Stripe')
    expect(humanize('Already Nice')).toBe('Already Nice')
    expect(humanize('web3-co')).toBe('Web3 Co')
  })

  it('finds job titles and URLs', () => {
    expect(jobTitleOf('\n# **Senior Engineer**\n\nbody')).toBe('Senior Engineer')
    expect(jobTitleOf('---\nPlain first line\n')).toBe('Plain first line')
    expect(firstUrl('See [the posting](https://example.com/jobs/1).')).toBe('https://example.com/jobs/1')
    expect(firstUrl('no link')).toBeNull()
  })

  it('summarizes a missing report as unknown', () => {
    expect(summarizeBuild(null).status).toBe('unknown')
  })

  it('confines application ids to <role>/<company>/<job-id> inside the workspace', () => {
    expect(applicationFolder('/ws', 'a/b/c')).toBe('/ws/a/b/c')
    for (const bad of ['../b/c', 'a/b', 'a/b/c/d', 'a/../c', '.huntgry/runs/x', 'a//c', '/etc/passwd/x']) {
      expect(() => applicationFolder('/ws', bad)).toThrow()
    }
  })

  it('round-trips file URLs and refuses anything else', () => {
    const url = applicationFileUrl('ml engineer/acme & co/7', 'resume-page-1.jpg')
    expect(parseFileUrl(url)).toEqual({ id: 'ml engineer/acme & co/7', file: 'resume-page-1.jpg' })
    expect(parseFileUrl('huntgry-file://app/a/b/c')).toBeNull()
    expect(parseFileUrl('huntgry-file://other/a/b/c/d')).toBeNull()
    expect(parseFileUrl('file:///a/b/c/d')).toBeNull()
    expect(parseFileUrl('huntgry-file://app/a/b/c/%2E%2E%2Fx')).toBeNull()
    expect(isServableFile('resume-page-3.jpg')).toBe(true)
    expect(isServableFile('huntgry.json')).toBe(false)
    expect(isServableFile('../../etc/passwd')).toBe(false)
  })

  it('treats dot paths as hidden for the watcher', () => {
    expect(isHidden('.huntgry/runs/x/events.jsonl')).toBe(true)
    expect(isHidden('eng/acme/1/.huntgry.json.ab12.tmp')).toBe(true)
    expect(isHidden('eng/acme/1/resume.pdf')).toBe(false)
  })
})
