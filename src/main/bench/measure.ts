import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TAILORING_NOTES_FILE } from '@shared/review-types'
import type { RunSummary } from '@shared/runner-types'
import { scoreApplication } from '../applications/rescore'
import { resolveApplicationFolder } from '../applications/safe-path'
import { summarizeBuild } from '../applications/scan'
import { readTracking } from '../applications/tracking'
import { readEvents } from '../cli/runs'
import { parseResultNotes, readResultNotes } from '../review/notes-file'
import { MASTER_PROFILE_FILE } from '../workspace/constants'
import { untraceableClaims } from './honesty'
import type { BenchRow } from './types'

/**
 * One bench row from what a finished run left on disk: its `run.json` totals and `events.jsonl`, the
 * application's `build-report.json`, and `huntgry.json` → `match` as the re-score after tailoring (#151) stored
 * it. Nothing here scores a resume a second way: profile fit, coverage and surfaced are read back, and the
 * honesty count takes `unbacked` from `scoreApplication`, the re-score's own read-only half.
 */

/** Files whose size the row records: the agent's biggest writes, which a faster flow would shrink. */
export const MEASURED_FILES = ['resume_data.json', TAILORING_NOTES_FILE, 'cover_data.json'] as const

/** A `build.py` call: the agent runs the skill's scripts by absolute path (`python3 <skill>/scripts/build.py …`). */
const BUILD_CALL = /(?:^|[\s/"'])scripts\/build\.py\b/

type Json = Record<string, unknown>
const rec = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {})
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** How many times the run called `build.py` (Claude's stream-json `assistant` → `tool_use` Bash events). */
export function countBuilds(events: readonly unknown[]): number {
  let builds = 0
  for (const e of events) {
    const event = rec(e)
    if (event.type !== 'assistant') continue
    const content = rec(event.message).content
    if (!Array.isArray(content)) continue
    for (const block of content.map(rec)) {
      if (block.type === 'tool_use' && block.name === 'Bash' && BUILD_CALL.test(String(rec(block.input).command ?? ''))) builds++
    }
  }
  return builds
}

/** A regular file's text, or `null`. */
async function readOwnText(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isFile()) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

export interface RowContext {
  jobId: string
  repeat: number
  nudged: boolean
}

export async function benchRow(workspace: string, run: RunSummary, ctx: RowContext): Promise<BenchRow> {
  const totals = run.totals
  const metrics = run.metrics ?? []
  const apiMs = metrics.reduce((n, m) => n + (m.apiMs ?? 0), 0)
  const activeMs = totals?.activeMs ?? 0
  const builds = countBuilds(await readEvents(workspace, run.id).catch(() => []))
  const row: BenchRow = {
    jobId: ctx.jobId,
    repeat: ctx.repeat,
    runId: run.id,
    status: run.status,
    ...(run.error ? { error: run.error } : {}),
    outputFolder: run.outputFolder,
    built: false,
    nudged: ctx.nudged,
    turns: totals?.turns ?? metrics.length,
    activeMs,
    apiMs,
    apiMsComplete: metrics.length > 0 && metrics.every((m) => m.apiMs !== undefined),
    apiShare: activeMs > 0 ? apiMs / activeMs : null,
    outputTokens: totals?.usage.outputTokens ?? 0,
    reasoningTokens: totals?.usage.reasoningTokens ?? 0,
    cacheReadTokens: totals?.usage.cacheReadTokens ?? 0,
    costUsd: totals?.estimatedCostUsd ?? 0,
    unpricedTurns: totals?.unpricedTurns ?? 0,
    reportedCostUsd: totals?.reportedCostUsd ?? null,
    hardFailures: [],
    buildOk: null,
    builds,
    rebuilds: Math.max(0, builds - 1),
    pages: null,
    targetPages: null,
    fill: null,
    profileFit: null,
    resumeCoverage: null,
    surfaced: null,
    untraceable: null,
    outputChars: {}
  }
  if (!run.outputFolder) return row
  const folder = await resolveApplicationFolder(workspace, run.outputFolder).catch(() => null)
  if (!folder) return row

  row.built = (await readOwnText(join(folder, 'resume.pdf'))) !== null
  const report = await readOwnText(join(folder, 'build-report.json'))
  const build = summarizeBuild(report)
  row.hardFailures = build.failed
  row.buildOk = build.status === 'unknown' ? null : build.status === 'pass'
  row.pages = build.resumePages
  try {
    const render = rec(rec(JSON.parse(report ?? 'null')).render)
    row.targetPages = num(render.target_pages)
    row.fill = num(render.fill)
  } catch {
    // An unreadable report: no render numbers.
  }

  const match = (await readTracking(folder)).match
  if (match) {
    row.profileFit = match.profileFit
    row.resumeCoverage = match.resumeCoverage
    row.surfaced = match.surfaced ?? null
  }

  const files = await Promise.all(MEASURED_FILES.map(async (f) => [f, await readOwnText(join(folder, f))] as const))
  for (const [f, text] of files) if (text !== null) row.outputChars[f] = text.length
  const resumeText = files.find(([f]) => f === 'resume_data.json')?.[1] ?? null

  const profile = await readOwnText(join(workspace, MASTER_PROFILE_FILE))
  if (profile !== null && (row.built || resumeText !== null)) {
    const [score, notes] = await Promise.all([
      scoreApplication(workspace, run.outputFolder).catch(() => null),
      readResultNotes(folder).catch(() => null)
    ])
    const parsed = notes ? parseResultNotes(notes) : null
    let resumeData: unknown = null
    try {
      resumeData = resumeText ? JSON.parse(resumeText) : null
    } catch {
      // Not JSON: no numbers or names to check.
    }
    row.untraceable = untraceableClaims({
      profile,
      unbacked: score?.coverage.unbacked.map((r) => r.skill) ?? [],
      reframings: parsed ? [...parsed.reframingsUsed, ...parsed.usedApprovals] : [],
      resumeData
    })
  }
  return row
}
