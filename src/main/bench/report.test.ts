import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countBuilds } from './measure'
import { benchReport, compareBench, median, verdict } from './report'
import { loadBenchSet } from './set'
import type { BenchResults, BenchRow } from './types'

function row(jobId: string, over: Partial<BenchRow> = {}): BenchRow {
  return {
    jobId,
    repeat: 1,
    runId: `run-${jobId}`,
    status: 'finished',
    outputFolder: `engineer/acme/${jobId}`,
    built: true,
    nudged: false,
    turns: 1,
    activeMs: 200_000,
    apiMs: 194_000,
    apiMsComplete: true,
    apiShare: 0.97,
    outputTokens: 21_000,
    reasoningTokens: 4_400,
    cacheReadTokens: 1_250_000,
    costUsd: 1.3,
    unpricedTurns: 0,
    reportedCostUsd: 1.3,
    hardFailures: [],
    buildOk: true,
    builds: 2,
    rebuilds: 1,
    pages: 1,
    targetPages: 1,
    fill: 0.93,
    profileFit: 87,
    resumeCoverage: 67,
    surfaced: 77,
    untraceable: { count: 1, byKind: { unbacked: 0, reframing: 1, number: 0, identity: 0 }, items: [] },
    outputChars: {},
    ...over
  }
}

function results(label: string, rows: BenchRow[], over: Partial<BenchResults> = {}): BenchResults {
  return {
    version: 1,
    id: `bench-20261024-120000-${label}`,
    label,
    startedAt: '2026-10-24T12:00:00.000Z',
    endedAt: '2026-10-24T12:30:00.000Z',
    interrupted: false,
    agent: 'claude',
    model: 'claude-opus-5-5',
    agentVersion: '2.3.0',
    skill: { dir: '/skills/resume-tailor', tag: 'v5.2.0', sha256: 'a'.repeat(64) },
    set: { dir: '/set', sha256: 'b'.repeat(64), jobs: rows.length },
    profile: { sha256: 'c'.repeat(64) },
    environment: { venvDir: '/venv', texBin: null, command: 'claude' },
    timeoutMs: 900_000,
    repeat: 1,
    workspace: '/out/ws',
    rows,
    ...over
  }
}

const BASE = results('base', [row('a', { activeMs: 180_000 }), row('b', { activeMs: 200_000 }), row('c', { activeMs: 220_000 })])

describe('median', () => {
  it('is the middle value, or the mean of the two middle ones', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNull()
  })
})

describe('verdict', () => {
  it('calls a faster candidate with the same quality better', () => {
    const cand = results('fast', BASE.rows.map((r) => ({ ...r, activeMs: r.activeMs / 2, costUsd: 0.8 })))
    const v = verdict(BASE, cand)
    expect(v).toMatchObject({ faster: true, regressions: [] })
    expect(v.text).toBe('**Faster at equal quality**: median time 200 s → 100 s (−50%), median cost $1.30 → $0.80.')
  })

  it('tolerates a coverage drop of up to 2 points', () => {
    const cand = results('fast', BASE.rows.map((r) => ({ ...r, activeMs: 1000, resumeCoverage: 65, surfaced: 75 })))
    expect(verdict(BASE, cand).regressions).toEqual([])
  })

  it('never calls a faster candidate better when coverage or surfaced drop, untraceable rises or the pass rate drops', () => {
    const fast = (over: Partial<BenchRow>) => results('fast', BASE.rows.map((r) => ({ ...r, activeMs: 1000, ...over })))
    const coverage = verdict(BASE, fast({ resumeCoverage: 60 }))
    expect(coverage.faster).toBe(true)
    expect(coverage.regressions).toEqual(['median resume coverage 67 → 60 (more than 2 points)'])
    expect(coverage.text).toMatch(/^\*\*Quality regression\*\*: median resume coverage 67 → 60 .*Not better, whatever the time/)
    expect(verdict(BASE, fast({ surfaced: 70 })).regressions).toEqual(['median surfaced 77 → 70 (more than 2 points)'])
    const more = { count: 2, byKind: { unbacked: 0, reframing: 2, number: 0, identity: 0 }, items: [] }
    expect(verdict(BASE, fast({ untraceable: more })).regressions).toEqual(['untraceable claims per run 1 → 2'])
    const failing = results('fast', [...BASE.rows.slice(0, 2), row('c', { activeMs: 1000, hardFailures: ['page_count'], buildOk: false })])
    expect(verdict(BASE, failing).regressions).toEqual(['pass rate 100% → 67%'])
  })

  it('says slower when the candidate takes longer at the same quality', () => {
    const cand = results('slow', BASE.rows.map((r) => ({ ...r, activeMs: r.activeMs + 60_000 })))
    expect(verdict(BASE, cand).text).toMatch(/^\*\*Slower\*\*, quality held: median time 200 s → 260 s \(\+30%\)/)
  })
})

describe('compareBench', () => {
  it('has the medians table, the per-job table, the jobs in only one run and the verdict', () => {
    const cand = results('cand', [row('a', { activeMs: 90_000, costUsd: 0.6 }), row('b', { activeMs: 100_000, costUsd: 0.7, resumeCoverage: 70 }), row('d')])
    const md = compareBench(BASE, cand)
    expect(md).toContain('- **Base**: base (`bench-20261024-120000-base`): claude claude-opus-5-5 (CLI 2.3.0), skill v5.2.0 · aaaaaaaaaaaa, set `bbbbbbbbbbbb`, 3 runs')
    // Medians and verdict over the jobs both ran (a, b): c and d would compare the job mix, not the versions.
    expect(md).toContain('**Verdict**: **Faster at equal quality**: median time 190 s → 95 s (−50%), median cost $1.30 → $0.65.')
    expect(md).toContain('Over the 2 jobs both runs ran (2 and 2 runs).')
    expect(md).toContain('| Metric | Base | Candidate | Δ | Δ % |')
    expect(md).toContain('| Time (active) | 190 s | 95 s | −95 s | −50% |')
    expect(md).toContain('| Output tokens | 21.0K | 21.0K | ±0 | ±0% |')
    expect(md).toContain('| Cost | $1.30 | $0.65 | −$0.65 | −50% |')
    expect(md).toContain('| Resume coverage | 67 | 68.5 | +1.5 | +2% |')
    expect(md).toContain('| Pass rate | 100% | 100% | ±0% | – |')
    expect(md).toContain('| Job | Time | Cost | Coverage | Surfaced | Untraceable | Hard fails |')
    expect(md).toContain('| a | 180 s → 90 s | $1.30 → $0.60 | 67 → 67 | 77 → 77 | 1 → 1 | – → – |')
    expect(md).toContain('| b | 200 s → 100 s | $1.30 → $0.70 | 67 → 70 | 77 → 77 | 1 → 1 | – → – |')
    expect(md).not.toMatch(/^\| [cd] \|/m)
    expect(md).toContain('## Jobs in only one run\n\n- Base only: c\n- Candidate only: d')
    expect(md).not.toContain('Warning')
  })

  it('warns when the two runs used different sets or profiles', () => {
    const cand = results('cand', BASE.rows, { set: { dir: '/set', sha256: 'd'.repeat(64), jobs: 3 }, profile: { sha256: 'e'.repeat(64) } })
    const md = compareBench(BASE, cand)
    expect(md).toContain('> **Warning**: the two runs used different bench sets (set hashes differ); the medians are not comparable.')
    expect(md).toContain('> **Warning**: the two runs used different master profiles; quality numbers are not comparable.')
  })
})

describe('benchReport', () => {
  it('lists the medians and every run', () => {
    const md = benchReport(results('one', [row('a'), row('b', { status: 'failed', built: false, hardFailures: ['page_count'], nudged: true })]))
    expect(md).toContain('# Tailoring bench: one')
    expect(md).toContain('| Time (active) | 200 s |')
    expect(md).toContain('| Pass rate | 50% |')
    expect(md).toContain('| b (nudged) | failed, not built | 200 s | 194 s | 21.0K | $1.30 | 1 | 1 | 93% | 87 | 67 | 77 | 1 | page_count |')
  })
})

describe('countBuilds', () => {
  const bash = (command: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
  it('counts Bash calls of the skill’s build.py only', () => {
    expect(
      countBuilds([
        bash('python3 /skills/resume-tailor/scripts/build.py --jd a.md'),
        bash('python3 "/Users/me/skills/resume tailor/scripts/build.py" --notes n.md'),
        bash('python3 /skills/resume-tailor/scripts/verify.py x'),
        bash('python3 /skills/resume-tailor/scripts/build.pyc'),
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/s/scripts/build.py' } }] } },
        { type: 'user', message: { content: 'scripts/build.py' } }
      ])
    ).toBe(2)
  })
})

describe('loadBenchSet', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huntgry-set-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads job files with defaults, from the folder or its jobs/ subfolder, and hashes them', async () => {
    await writeFile(join(dir, 'x.json'), JSON.stringify({ description: 'Backend role' }))
    const set = await loadBenchSet(dir)
    expect(set.jobs).toEqual([{ id: 'x', role: 'role', company: 'company', jobId: 'x', description: 'Backend role', coverLetter: true, dateStyle: 'right' }])
    await writeFile(join(dir, 'x.json'), JSON.stringify({ description: 'Backend role, edited' }))
    expect((await loadBenchSet(dir)).sha256).not.toBe(set.sha256)
    await mkdir(join(dir, 'jobs'))
    await writeFile(join(dir, 'jobs', 'y.json'), JSON.stringify({ id: 'y', descriptionFile: 'y.md' }))
    await writeFile(join(dir, 'jobs', 'y.md'), '# Platform role\n')
    expect((await loadBenchSet(dir)).jobs.map((j) => [j.id, j.description])).toEqual([['y', '# Platform role']])
  })

  it('refuses a set without jobs, a job without a description, a bad slug, a duplicate id and a description outside the set', async () => {
    await expect(loadBenchSet(dir)).rejects.toThrow(/No job files/)
    await writeFile(join(dir, 'a.json'), JSON.stringify({ role: 'x' }))
    await expect(loadBenchSet(dir)).rejects.toThrow(/needs "description"/)
    await writeFile(join(dir, 'a.json'), JSON.stringify({ description: 'd', company: 'Acme Inc' }))
    await expect(loadBenchSet(dir)).rejects.toThrow(/company "acme inc" must be a lowercase slug/)
    await writeFile(join(dir, 'a.json'), JSON.stringify({ description: 'd', descriptionFile: '../secret.md', id: 'a' }))
    await writeFile(join(dir, 'b.json'), JSON.stringify({ description: 'd', id: 'a' }))
    await expect(loadBenchSet(dir)).rejects.toThrow(/Two jobs have the id "a"/)
    await writeFile(join(dir, 'b.json'), JSON.stringify({ descriptionFile: '../secret.md' }))
    await expect(loadBenchSet(dir)).rejects.toThrow(/descriptionFile must be inside the set folder/)
  })
})
