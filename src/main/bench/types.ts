import type { AgentId, DateStyle, RunStatus } from '@shared/runner-types'

/**
 * The tailoring benchmark (#152): a fixed set of jobs run unattended in a throwaway workspace, one row of
 * time, cost and quality per run, and a report that compares two bench runs. Electron-free: the
 * `scripts/bench-tailor.mjs` CLI loads these files with plain Node, and vitest runs them with the fake agent.
 */

/** One job of a bench set: `<set>/<name>.json` (or `<set>/jobs/<name>.json`). */
export interface BenchJob {
  /** Stable id the report pairs runs by; the file name without `.json` when absent. */
  id: string
  role: string
  company: string
  /** The application folder's last part (`<role>/<company>/<job-id>`); `id` when absent. */
  jobId: string
  /** The posting's text, inline or read from `descriptionFile` (relative to the set folder). */
  description: string
  /** Posting URL: recorded as the application's `jobUrl`, as a queued Board job would be. */
  url?: string
  coverLetter: boolean
  dateStyle: DateStyle
  /** Free labels for reading the report (e.g. `senior`, `backend`); not sent to the agent. */
  seniority?: string
  stack?: string[]
}

export interface BenchSet {
  /** Absolute path of the set folder. */
  dir: string
  /** sha256 over every job file and description file, sorted by name: equal sets compare. */
  sha256: string
  jobs: BenchJob[]
}

/** Claims of a tailored resume the master profile does not back (see `honesty.ts`). */
export type UntraceableKind = 'unbacked' | 'reframing' | 'number' | 'identity'

export interface Untraceable {
  /** Every untraceable claim found, all kinds together. */
  count: number
  byKind: Record<UntraceableKind, number>
  /** The first `MAX_UNTRACEABLE_ITEMS`, for spot checks (kept in `results.json`, not the report). */
  items: { kind: UntraceableKind; text: string }[]
}

/** One run of one job (`results.json` → `rows[]`). Quality numbers are `null` when there is nothing to score. */
export interface BenchRow {
  jobId: string
  /** 1-based, when the bench repeats each job (`--repeat`). */
  repeat: number
  runId: string | null
  status: RunStatus | 'not-started'
  error?: string
  outputFolder: string | null
  /** A resume was built (`resume.pdf` in the application folder). */
  built: boolean
  /** The run ended its first turn without building and got the one `NUDGE_TEXT` reply. */
  nudged: boolean
  turns: number
  /** `run.totals.activeMs`: time the agent worked, every turn. */
  activeMs: number
  /** Σ `metrics[].apiMs` (Claude's `duration_api_ms`): time spent waiting on the model API. */
  apiMs: number
  /** `false` when a turn did not report its API time (then `apiMs` is a lower bound). */
  apiMsComplete: boolean
  /** `apiMs / activeMs`, 0–1; `null` without active time. */
  apiShare: number | null
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  /** `run.totals.estimatedCostUsd`: tokens × the bundled price table (`unpricedTurns` are left out of it). */
  costUsd: number
  /** Turns whose model has no price; when not 0, `costUsd` is a lower bound. */
  unpricedTurns: number
  /** What the CLI itself reported (`totals.reportedCostUsd`), when it did. */
  reportedCostUsd: number | null
  /** `summarizeBuild(build-report.json).failed`: hard verify checks that failed. */
  hardFailures: string[]
  /** `build-report.json` → `ok`. */
  buildOk: boolean | null
  /** `build.py` calls in the run's events. */
  builds: number
  /** `builds - 1`, at least 0. */
  rebuilds: number
  /** `build-report.json` → `render.pages` / `render.target_pages` / `render.fill` (0–1). */
  pages: number | null
  targetPages: number | null
  fill: number | null
  /** `huntgry.json` → `match`, as the re-score after tailoring (#151) stored it. */
  profileFit: number | null
  resumeCoverage: number | null
  surfaced: number | null
  untraceable: Untraceable | null
  /** Characters of the biggest files the agent writes (the issue's largest outputs). */
  outputChars: Record<string, number>
}

export const RESULTS_VERSION = 1

/** `<out>/<benchId>/results.json`. */
export interface BenchResults {
  version: typeof RESULTS_VERSION
  /** `bench-YYYYMMDD-HHMMSS-<label>`, the folder name under `<out>`. */
  id: string
  label: string
  startedAt: string
  endedAt: string | null
  /** Stopped early (Ctrl-C): the rows are the runs that ended. */
  interrupted: boolean
  agent: AgentId
  /** The model asked for (`--model`); each run's own model is in its `run.json`. */
  model: string | null
  agentVersion: string | null
  skill: { dir: string; tag: string | null; sha256: string | null }
  set: { dir: string; sha256: string; jobs: number }
  profile: { sha256: string }
  environment: { venvDir: string; texBin: string | null; command: string }
  timeoutMs: number
  repeat: number
  /** The bench workspace the runs wrote to (kept for inspection). */
  workspace: string
  rows: BenchRow[]
}
