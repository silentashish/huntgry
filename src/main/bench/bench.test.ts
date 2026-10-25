import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NUDGE_TEXT } from '../cli/command'
import { readEvents, readRun } from '../cli/runs'
import { readTracking } from '../applications/tracking'
import { assertBenchOut, assertDistinctApplications, RESULTS_FILE, REPORT_FILE, runBench, type BenchOptions } from './run'
import { compareBench } from './report'
import { loadBenchSet } from './set'
import type { BenchResults } from './types'

/**
 * The bench end to end with the fake agent (no network, no cost): the runner, the isolation from the real
 * workspace, every row metric and the comparison report. A real (paid) bench never runs here.
 */

const FAKE = join(__dirname, '../cli/fixtures/fake-claude.mjs')
const FIXTURES = join(__dirname, 'fixtures')

let root: string
let source: string
let out: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'huntgry-bench-'))
  // The "real" workspace: its profile is copied, never written.
  source = join(root, 'real-workspace')
  await mkdir(join(source, '.huntgry'), { recursive: true })
  await copyFile(join(FIXTURES, 'master-profile.md'), join(source, 'master-profile.md'))
  await writeFile(join(source, '.huntgry', 'keep.json'), '{"untouched": true}')
  out = join(root, 'bench-out')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function options(extra: Partial<BenchOptions> = {}): Promise<BenchOptions> {
  return {
    set: await loadBenchSet(join(FIXTURES, 'set')),
    profile: join(source, 'master-profile.md'),
    sourceWorkspace: source,
    out,
    label: 'ci',
    command: process.execPath,
    commandPrefixArgs: [FAKE],
    model: 'claude-haiku-4-5',
    skillDir: join(root, 'skill'),
    venvDir: join(root, 'venv'),
    texBin: null,
    baseEnv: { ...process.env },
    timeoutMs: 20_000,
    ...extra
  }
}

/** Every file under `dir` with its sha256, to prove a folder unchanged. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files[relative(dir, path)] = createHash('sha256').update(await readFile(path)).digest('hex')
  }
  return files
}

describe('runBench with the fake agent', () => {
  it('runs every job unattended in its own workspace and records time, cost and quality per run', async () => {
    const before = await snapshot(source)
    const { dir, results } = await runBench(await options())

    // Isolation: the runs wrote only under <out>/<benchId>/, the profile was copied in, the source is unchanged.
    expect(relative(out, dir)).toBe(results.id)
    expect(results.workspace).toBe(join(dir, 'workspace'))
    expect(await readFile(join(results.workspace, 'master-profile.md'), 'utf8')).toBe(await readFile(join(FIXTURES, 'master-profile.md'), 'utf8'))
    expect(await snapshot(source)).toEqual(before)
    expect((await readdir(out)).sort()).toEqual([results.id])
    expect((await readdir(dir)).sort()).toEqual([REPORT_FILE, RESULTS_FILE, 'workspace'])

    // results.json on disk is what runBench returned.
    const saved = JSON.parse(await readFile(join(dir, RESULTS_FILE), 'utf8')) as BenchResults
    expect(saved).toEqual(results)
    expect(saved).toMatchObject({ version: 1, label: 'ci', model: 'claude-haiku-4-5', interrupted: false, set: { jobs: 2 } })
    expect(saved.rows.map((r) => r.jobId)).toEqual(['backend', 'platform'])

    for (const row of saved.rows) {
      const run = await readRun(results.workspace, row.runId!)
      // Row metrics are the run's own numbers.
      expect(row.status).toBe('finished')
      expect(row.activeMs).toBe(run.totals!.activeMs)
      expect(row.activeMs).toBeGreaterThan(0)
      expect(row.apiMs).toBe(run.metrics!.reduce((n, m) => n + (m.apiMs ?? 0), 0))
      expect(row.apiMs).toBe(4 * row.turns)
      expect(row.apiMsComplete).toBe(true)
      expect(row.outputTokens).toBe(run.totals!.usage.outputTokens)
      expect(row.outputTokens).toBe(1800 * row.turns)
      expect(row.costUsd).toBe(run.totals!.estimatedCostUsd)
      expect(row.costUsd).toBeCloseTo(0.01 * row.turns)
      // build-report.json and events.jsonl.
      expect(row).toMatchObject({ built: true, buildOk: true, hardFailures: [], builds: 2, rebuilds: 1, pages: 1, targetPages: 1, fill: 0.93 })
      // Quality is the re-score's (#151): huntgry.json → match, as main stored it.
      const match = (await readTracking(join(results.workspace, row.outputFolder!))).match!
      expect(match.runId).toBe(row.runId)
      expect(row).toMatchObject({ profileFit: match.profileFit, resumeCoverage: match.resumeCoverage, surfaced: match.surfaced })
      expect(row.profileFit).toBeGreaterThan(0)
      // The unsourced reframing (RabbitMQ) counts; the sourced one does not.
      expect(row.untraceable).toEqual({
        count: 1,
        byKind: { unbacked: 0, reframing: 1, number: 0, identity: 0 },
        items: [{ kind: 'reframing', text: 'Built an event pipeline on RabbitMQ' }]
      })
      expect(row.outputChars['resume_data.json']).toBeGreaterThan(0)
      expect(row.outputChars['tailoring-notes.md']).toBeGreaterThan(0)
    }

    // Built in its first turn: no nudge. Asked instead of building: exactly one nudge, then built.
    const [backend, platform] = saved.rows
    expect(backend).toMatchObject({ nudged: false, turns: 1 })
    expect(platform).toMatchObject({ nudged: true, turns: 2 })
    const sent = (await readEvents(results.workspace, platform.runId!)).filter((e) => (e as { subtype?: string }).subtype === 'user_message')
    expect(sent.map((e) => (e as { text: string }).text).filter((t) => t === NUDGE_TEXT)).toHaveLength(1)

    // The single-run report.
    const report = await readFile(join(dir, REPORT_FILE), 'utf8')
    expect(report).toContain('# Tailoring bench: ci')
    expect(report).toContain('| Rebuilds | 1 |')
    expect(report).toContain('| platform (nudged) | finished |')
  }, 30_000)

  it('aborts a run over the timeout, records it failed and goes on', async () => {
    const set = join(root, 'set')
    await mkdir(set)
    await writeFile(join(set, 'a-stall.json'), JSON.stringify({ description: 'Stuck job. STALL' }))
    await writeFile(join(set, 'b-ok.json'), JSON.stringify({ description: (await readFile(join(FIXTURES, 'set/backend.md'), 'utf8')) }))
    const { results } = await runBench(await options({ set: await loadBenchSet(set), timeoutMs: 600 }))
    const [stalled, ok] = results.rows
    expect(stalled).toMatchObject({ jobId: 'a-stall', status: 'failed', built: false })
    expect(stalled.error).toMatch(/Bench timeout/)
    expect(ok).toMatchObject({ jobId: 'b-ok', status: 'finished', built: true })
  }, 30_000)

  it('stops on an interrupt and keeps the results so far', async () => {
    const set = join(root, 'set')
    await mkdir(set)
    await writeFile(join(set, 'a-stall.json'), JSON.stringify({ description: 'Stuck job. STALL' }))
    await writeFile(join(set, 'b-next.json'), JSON.stringify({ description: 'Never started.' }))
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 500)
    const { dir, results } = await runBench(await options({ set: await loadBenchSet(set), signal: abort.signal }))
    expect(results.interrupted).toBe(true)
    expect(results.rows.map((r) => [r.jobId, r.status])).toEqual([['a-stall', 'stopped']])
    expect(JSON.parse(await readFile(join(dir, RESULTS_FILE), 'utf8')).rows).toHaveLength(1)
    expect(await readFile(join(dir, REPORT_FILE), 'utf8')).toContain('> Interrupted')
  }, 30_000)

  it('repeats each job into its own application folder and runs only the jobs asked for', async () => {
    const { results } = await runBench(await options({ repeat: 2, only: ['backend'] }))
    expect(results.rows.map((r) => [r.jobId, r.repeat, r.outputFolder])).toEqual([
      ['backend', 1, 'backend-engineer/acme/backend-r1'],
      ['backend', 2, 'backend-engineer/acme/backend-r2']
    ])
    await expect(runBench(await options({ only: ['nope'] }))).rejects.toThrow(/Not in the bench set: nope/)
  }, 30_000)

  it('refuses an output folder equal to or inside the real workspace or the profile folder', async () => {
    for (const bad of [source, join(source, 'bench'), join(source, '.huntgry', 'bench')]) {
      await expect(runBench(await options({ out: bad }))).rejects.toThrow(/inside .*real workspace|never write into a real workspace/)
    }
    // Through a symlink too.
    await symlink(source, join(root, 'link'))
    await expect(runBench(await options({ out: join(root, 'link', 'bench') }))).rejects.toThrow(/never write into a real workspace/)
    // The profile's own folder, when it is not the workspace.
    const profiles = join(root, 'profiles')
    await mkdir(profiles)
    await copyFile(join(FIXTURES, 'master-profile.md'), join(profiles, 'me.md'))
    await expect(runBench(await options({ profile: join(profiles, 'me.md'), out: join(profiles, 'x') }))).rejects.toThrow(/never write/)
    // Nothing was created.
    expect(await stat(join(source, 'bench')).catch(() => null)).toBeNull()
    expect((await readdir(source)).sort()).toEqual(['.huntgry', 'master-profile.md'])
  })

  it('compares two bench runs by median and per job', async () => {
    const { results: base } = await runBench(await options({ label: 'base' }))
    const { results: cand } = await runBench(await options({ label: 'candidate', only: ['backend'] }))
    const md = compareBench(base, cand)
    expect(md).toContain('# Tailoring bench comparison')
    expect(md).toMatch(/\| Time \(active\) \| \d+ s \| \d+ s \|/)
    expect(md).toContain('| Rebuilds | 1 | 1 | ±0 | ±0% |')
    expect(md).toContain('| Untraceable claims | 1 | 1 | ±0 | ±0% |')
    expect(md).toMatch(/\| backend \| \d+ s → \d+ s \| \$0\.01 → \$0\.01 \|/)
    expect(md).toContain('- Base only: platform')
    expect(md).toContain('**Verdict**:')
    expect(md).not.toContain('different bench sets')
  }, 30_000)
})

describe('runBench safety (review of #177)', () => {
  it('treats a child named "..bench" as inside the workspace, as typed or through ".." segments', async () => {
    await expect(assertBenchOut(join(source, '..bench'), [source])).rejects.toThrow(/never write into a real workspace/)
    await expect(assertBenchOut(`${source}/x/../..bench`, [source])).rejects.toThrow(/never write/)
    await symlink(source, join(root, 'alias'))
    await expect(assertBenchOut(join(root, 'alias', '..bench'), [source])).rejects.toThrow(/never write/)
    // A sibling of the workspace is still fine.
    await expect(assertBenchOut(join(root, '..bench'), [source])).resolves.toBeUndefined()
    await expect(runBench(await options({ out: join(source, '..bench') }))).rejects.toThrow(/never write/)
    expect((await readdir(source)).sort()).toEqual(['.huntgry', 'master-profile.md'])
  })

  it("protects the real folder of a symlinked profile, even without a source workspace", async () => {
    await mkdir(join(root, 'alias'))
    await symlink(join(source, 'master-profile.md'), join(root, 'alias', 'profile.md'))
    await expect(
      runBench(await options({ sourceWorkspace: null, profile: join(root, 'alias', 'profile.md'), out: join(source, 'bench') }))
    ).rejects.toThrow(/never write into a real workspace/)
    expect((await readdir(source)).sort()).toEqual(['.huntgry', 'master-profile.md'])
  })

  it('never reuses an existing bench folder: a symlink there is not followed, and the same label and second get their own', async () => {
    const before = await snapshot(source)
    const now = () => new Date(2026, 9, 24, 12, 0, 0)
    // A planted <out>/<bench-id> link to the real workspace, with another profile to copy over its own.
    await mkdir(out)
    await symlink(source, join(out, 'bench-20261024-120000-ci'))
    const other = join(root, 'other')
    await mkdir(other)
    await writeFile(join(other, 'master-profile.md'), '# Someone else\n')
    const first = await runBench(await options({ now, profile: join(other, 'master-profile.md'), only: ['backend'] }))
    expect(first.results.id).toBe('bench-20261024-120000-ci-2')
    expect(await snapshot(source)).toEqual(before)
    const second = await runBench(await options({ now, only: ['backend'] }))
    expect(second.results.id).toBe('bench-20261024-120000-ci-3')
    // The first bench's results are intact.
    expect(JSON.parse(await readFile(join(first.dir, RESULTS_FILE), 'utf8')).rows).toHaveLength(1)
  }, 30_000)

  it('does not start the next run after a Ctrl-C during the pause between runs', async () => {
    const abort = new AbortController()
    const { results } = await runBench(
      await options({
        gapMs: 1500,
        signal: abort.signal,
        log: (line) => {
          if (line.startsWith('backend: finished')) setTimeout(() => abort.abort(), 100)
        }
      })
    )
    expect(results.interrupted).toBe(true)
    expect(results.rows.map((r) => r.jobId)).toEqual(['backend'])
  }, 30_000)

  it('refuses jobs that would build into the same application folder, repeats included', async () => {
    const set = join(root, 'set')
    await mkdir(set)
    await writeFile(join(set, 'a.json'), JSON.stringify({ description: 'd', jobId: 'same' }))
    await writeFile(join(set, 'b.json'), JSON.stringify({ description: 'd', jobId: 'same' }))
    await expect(loadBenchSet(set)).rejects.toThrow(/Jobs "a" and "b" would both write role\/company\/same/)
    const job = (id: string, jobId: string) => ({ id, role: 'r', company: 'c', jobId, description: 'd', coverLetter: false, dateStyle: 'right' as const })
    expect(() => assertDistinctApplications([job('a', 'x'), job('b', 'x-r1')], 2)).not.toThrow()
    expect(() => assertDistinctApplications([job('a', 'x'), job('b', 'x')], 2)).toThrow(/Jobs "a" and "b" would both write r\/c\/x-r1/)
    // runBench checks the jobs it was given (a set built in code, or loaded before an edit).
    const set2 = { ...(await loadBenchSet(join(FIXTURES, 'set'))) }
    set2.jobs = set2.jobs.map((j) => ({ ...j, role: 'r', company: 'c', jobId: 'same' }))
    await expect(runBench(await options({ set: set2 }))).rejects.toThrow(/would both write r\/c\/same/)
    expect(await stat(out).catch(() => null)).toBeNull()
  })
})
