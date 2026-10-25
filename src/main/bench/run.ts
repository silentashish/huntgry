import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AgentId, RunSummary, StartRunParams } from '@shared/runner-types'
import { rescoreApplication } from '../applications/rescore'
import { buildSystemPrompt, NUDGE_TEXT, resolveRunPaths, texRootOf } from '../cli/command'
import { buildChildEnv } from '../cli/env'
import { RunManager, type RunContext } from '../cli/runner'
import { readRun } from '../cli/runs'
import { COVER_LETTER_FILE, MASTER_PROFILE_FILE } from '../workspace/constants'
import { benchRow } from './measure'
import { benchReport } from './report'
import { RESULTS_VERSION, type BenchJob, type BenchResults, type BenchRow, type BenchSet } from './types'

/**
 * Runs a bench set unattended, one job after the other, in a fresh workspace under `<out>/<benchId>/workspace`
 * that holds a copy of the master profile and nothing else of the user's. Each run gets what an unattended
 * Tailor run gets: the same system prompt (with no reframing rules, so runs do not depend on the user's standing
 * rules), the re-score after every turn (#151), and the pipeline's one nudge when a turn ends without a build.
 * A run over the timeout is aborted and recorded as failed; a failed run is recorded and the bench goes on (no
 * retries: they would distort time and cost). Writes `results.json` after every run and `report.md` at the end.
 */

export const DEFAULT_TIMEOUT_MS = 15 * 60_000
export const DEFAULT_GAP_MS = 1500
export const RESULTS_FILE = 'results.json'
export const REPORT_FILE = 'report.md'

export interface BenchOptions {
  set: BenchSet
  /** The master profile to copy in (e.g. the real workspace's `master-profile.md`); only ever read. */
  profile: string
  /** A base `cover-letter.md` to copy in too, when the workspace has one. */
  coverLetter?: string | null
  /** The user's real workspace: `out` may not be in it (nor in the profile's or the set's folder). */
  sourceWorkspace?: string | null
  /** Where bench runs go: `<out>/<benchId>/`. */
  out: string
  label: string
  agent?: AgentId
  /** The agent's executable (`claude`; `node` with the fake script in tests). */
  command: string
  commandPrefixArgs?: string[]
  /** Passed as `--model` and recorded; `undefined` lets the CLI pick (not recommended for a comparison). */
  model?: string
  agentVersion?: string | null
  permissionPrompts?: boolean
  skillDir: string
  /** The installed skill's release tag (`skill-install.json`), when known. */
  skillTag?: string | null
  venvDir: string
  texBin: string | null
  /** The environment the child's is built from (`process.env` by default) and the login shell's PATH. */
  baseEnv?: NodeJS.ProcessEnv
  loginPath?: string
  /** Claude account folder (`CLAUDE_CONFIG_DIR`); `null`/absent keeps the one in `baseEnv`. */
  claudeConfigDir?: string | null
  /** Runs per job (each gets its own job id, `<job-id>-r2`, …); 1 by default. */
  repeat?: number
  /** Only these job ids of the set. */
  only?: string[]
  timeoutMs?: number
  /**
   * Pause between runs. The runner finds a turn's application folder among folders changed since a second
   * before the turn started (`findOutputFolder`), so a run started right after another could take its folder.
   */
  gapMs?: number
  /** Aborting stops the current run; the results so far are written. */
  signal?: AbortSignal
  now?: () => Date
  log?: (line: string) => void
}

/** `p` with its existing part resolved through symlinks (it may not exist yet). */
async function realpathLoose(p: string): Promise<string> {
  const rest: string[] = []
  let cur = resolve(p)
  for (;;) {
    try {
      return join(await realpath(cur), ...rest.reverse())
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return resolve(p)
      rest.push(basename(cur))
      cur = parent
    }
  }
}

/**
 * Refuses an `out` equal to, or inside, any of `protectedDirs` (the real workspace, the profile's folder, the set's
 * folder), compared by real path so a symlink cannot sneak the bench into a real workspace.
 */
export async function assertBenchOut(out: string, protectedDirs: readonly (string | null | undefined)[]): Promise<void> {
  const target = await realpathLoose(out)
  for (const dir of protectedDirs) {
    if (!dir) continue
    const rel = relative(await realpathLoose(dir), target)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
      throw new Error(`The bench output folder ${out} is inside ${dir}. Bench runs never write into a real workspace: pick a folder outside it (default ~/huntgry-bench).`)
  }
}

/** sha256 over the skill's `SKILL.md` and `scripts/*.py`, so a hand-edited copy reads as another version. */
export async function skillHash(skillDir: string): Promise<string | null> {
  const scripts = await readdir(join(skillDir, 'scripts')).catch(() => [] as string[])
  const files = ['SKILL.md', ...scripts.filter((f) => f.endsWith('.py')).sort().map((f) => `scripts/${f}`)]
  const hash = createHash('sha256')
  let any = false
  for (const f of files) {
    const data = await readFile(join(skillDir, f)).catch(() => null)
    if (!data) continue
    any = true
    hash.update(`${f}\n`).update(data)
  }
  return any ? hash.digest('hex') : null
}

const pad = (n: number) => String(n).padStart(2, '0')
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'run'

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function runBench(opts: BenchOptions): Promise<{ dir: string; results: BenchResults }> {
  const now = opts.now ?? (() => new Date())
  const log = opts.log ?? (() => undefined)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const repeat = Math.max(1, Math.floor(opts.repeat ?? 1))
  const jobs = opts.only?.length ? opts.set.jobs.filter((j) => opts.only!.includes(j.id)) : opts.set.jobs
  const unknown = (opts.only ?? []).filter((id) => !opts.set.jobs.some((j) => j.id === id))
  if (unknown.length > 0) throw new Error(`Not in the bench set: ${unknown.join(', ')}.`)

  await assertBenchOut(opts.out, [opts.sourceWorkspace, dirname(resolve(opts.profile)), opts.set.dir])
  const profileText = await readFile(opts.profile)
  const startedAt = now()
  const id = `bench-${stamp(startedAt)}-${slug(opts.label)}`
  const dir = join(resolve(opts.out), id)
  const workspace = join(dir, 'workspace')
  await mkdir(workspace, { recursive: true })
  await copyFile(opts.profile, join(workspace, MASTER_PROFILE_FILE))
  if (opts.coverLetter) await copyFile(opts.coverLetter, join(workspace, COVER_LETTER_FILE)).catch(() => undefined)

  const { skillDir, sandbox } = await resolveRunPaths({
    workspace,
    skillDir: opts.skillDir,
    venvDir: opts.venvDir,
    texRoot: texRootOf(opts.texBin)
  })
  const ctx: RunContext = {
    agent: opts.agent ?? 'claude',
    workspace,
    skillDir,
    sandbox,
    command: opts.command,
    commandPrefixArgs: opts.commandPrefixArgs,
    env: buildChildEnv({
      base: opts.baseEnv ?? process.env,
      workspace,
      venvDir: opts.venvDir,
      texBin: opts.texBin,
      loginPath: opts.loginPath ?? '',
      claudeConfigDir: opts.claudeConfigDir ?? null
    }),
    model: opts.model,
    expectedModel: opts.model ?? null,
    claudeVersion: opts.agentVersion ?? null,
    permissionPrompts: opts.permissionPrompts,
    // No caller rules: a bench run must not depend on the user's standing reframing rules (#159).
    systemPrompt: buildSystemPrompt({ workspace, masterProfile: MASTER_PROFILE_FILE, skillDir, rules: { preferred: [], avoid: [] } })
  }
  const manager = new RunManager({
    onEvent: () => undefined,
    onRun: () => undefined,
    // The re-score after tailoring, as `start.ts` wires it: the quality numbers are the app's own.
    afterOutput: async (run, ws) => {
      if (run.outputFolder) await rescoreApplication(ws, run.outputFolder, { runId: run.id })
    }
  })

  const results: BenchResults = {
    version: RESULTS_VERSION,
    id,
    label: opts.label,
    startedAt: startedAt.toISOString(),
    endedAt: null,
    interrupted: false,
    agent: ctx.agent ?? 'claude',
    model: opts.model ?? null,
    agentVersion: opts.agentVersion ?? null,
    skill: { dir: skillDir, tag: opts.skillTag ?? null, sha256: await skillHash(skillDir) },
    set: { dir: opts.set.dir, sha256: opts.set.sha256, jobs: jobs.length },
    profile: { sha256: createHash('sha256').update(profileText).digest('hex') },
    environment: { venvDir: opts.venvDir, texBin: opts.texBin, command: [opts.command, ...(opts.commandPrefixArgs ?? [])].join(' ') },
    timeoutMs,
    repeat,
    workspace,
    rows: []
  }
  const save = () => writeAtomic(join(dir, RESULTS_FILE), `${JSON.stringify(results, null, 2)}\n`)
  await save()

  const onAbort = () => manager.stopAll()
  opts.signal?.addEventListener('abort', onAbort)
  try {
    outer: for (let r = 1; r <= repeat; r++) {
      for (const job of jobs) {
        if (opts.signal?.aborted) break outer
        if (results.rows.length > 0) await sleep(opts.gapMs ?? DEFAULT_GAP_MS)
        log(`${job.id}${repeat > 1 ? ` (run ${r}/${repeat})` : ''}: running…`)
        const row = await runOne(manager, ctx, job, r, repeat, timeoutMs)
        results.rows.push(row)
        await save()
        log(`${job.id}: ${row.status}, ${(row.activeMs / 1000).toFixed(0)} s, $${row.costUsd.toFixed(2)}${row.error ? ` (${row.error.split('\n')[0]})` : ''}`)
      }
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    manager.stopAll()
    await manager.whenIdle()
    results.interrupted = opts.signal?.aborted ?? false
    results.endedAt = now().toISOString()
    await save()
    await writeAtomic(join(dir, REPORT_FILE), benchReport(results))
  }
  return { dir, results }
}

/** The run's state once its turn is over: live and waiting, or ended (read back once every write is on disk). */
async function turnOver(manager: RunManager, workspace: string, id: string): Promise<RunSummary> {
  for (;;) {
    const live = manager.liveRun(id)
    if (!live) {
      await manager.whenIdle()
      return readRun(workspace, id)
    }
    if (live.status !== 'running') return live
    await sleep(50)
  }
}

async function runOne(manager: RunManager, ctx: RunContext, job: BenchJob, repeat: number, repeats: number, timeoutMs: number): Promise<BenchRow> {
  // Each repeat builds its own application folder, so no run reads another's output.
  const jobId = repeats > 1 ? `${job.jobId}-r${repeat}` : job.jobId
  const params: StartRunParams = {
    jobDescription: job.description,
    role: job.role,
    company: job.company,
    jobId,
    coverLetter: job.coverLetter,
    dateStyle: job.dateStyle,
    ...(job.url ? { jobUrl: job.url, source: 'url' as const } : { source: 'pasted' as const }),
    agent: ctx.agent,
    unattended: true
  }
  let started: RunSummary
  try {
    started = await manager.start(params, ctx)
  } catch (err) {
    return notStarted(job, repeat, err)
  }
  const id = started.id
  const timer = setTimeout(() => manager.abort(id, `Bench timeout: the run took over ${Math.round(timeoutMs / 60_000)} min.`), timeoutMs)
  let nudged = false
  try {
    let run = await turnOver(manager, ctx.workspace, id)
    // The pipeline's verify gate (#158): a turn that ends without a resume gets one nudge, then the run is judged.
    if (run.status === 'waiting' && !run.outputFiles.includes('resume.pdf')) {
      nudged = true
      await manager.reply(id, NUDGE_TEXT, async () => ctx)
      run = await turnOver(manager, ctx.workspace, id)
    }
    if (run.status === 'waiting') manager.finish(id)
    await manager.whenIdle()
  } finally {
    clearTimeout(timer)
  }
  return benchRow(ctx.workspace, await readRun(ctx.workspace, id), { jobId: job.id, repeat, nudged })
}

function notStarted(job: BenchJob, repeat: number, err: unknown): BenchRow {
  return {
    jobId: job.id,
    repeat,
    runId: null,
    status: 'not-started',
    error: err instanceof Error ? err.message : String(err),
    outputFolder: null,
    built: false,
    nudged: false,
    turns: 0,
    activeMs: 0,
    apiMs: 0,
    apiMsComplete: false,
    apiShare: null,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    unpricedTurns: 0,
    reportedCostUsd: null,
    hardFailures: [],
    buildOk: null,
    builds: 0,
    rebuilds: 0,
    pages: null,
    targetPages: null,
    fill: null,
    profileFit: null,
    resumeCoverage: null,
    surfaced: null,
    untraceable: null,
    outputChars: {}
  }
}
