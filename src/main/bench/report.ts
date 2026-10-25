import type { BenchResults, BenchRow } from './types'

/**
 * Markdown reports of bench runs: `benchReport` for one (`report.md` next to its `results.json`) and
 * `compareBench` for two, by median and per job, ending with a verdict that never calls a faster candidate
 * better when its quality dropped.
 */

/** Points of median resume coverage or surfaced a candidate may lose before it counts as a regression. */
export const DEFAULT_TOLERANCE = 2

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * The run finished, built a resume, and its `build-report.json` says `ok` with no failed hard check. A missing or
 * unreadable report proves nothing, and a failed (timed-out) run does not pass even if it left a PDF.
 */
export function passed(row: BenchRow): boolean {
  return row.status === 'finished' && row.built && row.buildOk === true && row.hardFailures.length === 0
}

/** One metric of the report: how to read it from a row and how to print it. */
interface Metric {
  label: string
  of: (row: BenchRow) => number | null
  format: (v: number) => string
  /** For the verdict: which way is better (`null` = informational). */
  better: 'lower' | 'higher' | null
}

const secs = (ms: number) => `${(ms / 1000).toFixed(0)} s`
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n.toFixed(0))
const usd = (n: number) => `$${n.toFixed(2)}`
const pct = (share: number) => `${(share * 100).toFixed(0)}%`
const plain = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

export const METRICS: readonly Metric[] = [
  { label: 'Time (active)', of: (r) => r.activeMs, format: secs, better: 'lower' },
  { label: 'API time', of: (r) => r.apiMs, format: secs, better: 'lower' },
  { label: 'API share', of: (r) => r.apiShare, format: pct, better: null },
  { label: 'Output tokens', of: (r) => r.outputTokens, format: tokens, better: 'lower' },
  { label: 'Cost', of: (r) => r.costUsd, format: usd, better: 'lower' },
  { label: 'Turns', of: (r) => r.turns, format: plain, better: 'lower' },
  { label: 'Rebuilds', of: (r) => r.rebuilds, format: plain, better: 'lower' },
  { label: 'Pages', of: (r) => r.pages, format: plain, better: null },
  { label: 'Fill', of: (r) => r.fill, format: pct, better: null },
  { label: 'Profile fit', of: (r) => r.profileFit, format: plain, better: null },
  { label: 'Resume coverage', of: (r) => r.resumeCoverage, format: plain, better: 'higher' },
  { label: 'Surfaced', of: (r) => r.surfaced, format: plain, better: 'higher' },
  { label: 'Untraceable claims', of: (r) => r.untraceable?.count ?? null, format: plain, better: 'lower' }
]

function medianOf(rows: readonly BenchRow[], of: (row: BenchRow) => number | null): number | null {
  return median(rows.map(of).filter((v): v is number => v !== null))
}

function passRate(rows: readonly BenchRow[]): number | null {
  return rows.length ? rows.filter(passed).length / rows.length : null
}

function meanUntraceable(rows: readonly BenchRow[]): number | null {
  const counts = rows.map((r) => r.untraceable?.count).filter((v): v is number => v !== undefined)
  return counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : null
}

const cell = (v: number | null, format: (v: number) => string) => (v === null ? '–' : format(v))

function header(r: BenchResults): string {
  const skill = [r.skill.tag, r.skill.sha256?.slice(0, 12)].filter(Boolean).join(' · ') || 'unknown'
  return `${r.label} (\`${r.id}\`): ${r.agent} ${r.model ?? 'default model'}${r.agentVersion ? ` (CLI ${r.agentVersion})` : ''}, skill ${skill}, set \`${r.set.sha256.slice(0, 12)}\`, ${r.rows.length} run${r.rows.length === 1 ? '' : 's'}`
}

/** The single-run report. */
export function benchReport(r: BenchResults): string {
  const lines = [`# Tailoring bench: ${r.label}`, '', header(r), '']
  if (r.interrupted) lines.push('> Interrupted: only the runs that ended are counted.', '')
  lines.push('## Medians', '', '| Metric | Median |', '| --- | ---: |')
  for (const m of METRICS) lines.push(`| ${m.label} | ${cell(medianOf(r.rows, m.of), m.format)} |`)
  lines.push(`| Pass rate | ${cell(passRate(r.rows), pct)} |`, '')
  lines.push(
    '## Runs',
    '',
    '| Job | Status | Time | API | Out tokens | Cost | Rebuilds | Pages | Fill | Fit | Coverage | Surfaced | Untraceable | Hard fails |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
  )
  for (const row of r.rows) {
    lines.push(
      `| ${row.jobId}${r.repeat > 1 ? ` #${row.repeat}` : ''}${row.nudged ? ' (nudged)' : ''} | ${row.status}${row.built ? '' : ', not built'} | ${secs(row.activeMs)} | ${secs(row.apiMs)} | ${tokens(row.outputTokens)} | ${usd(row.costUsd)} | ${row.rebuilds} | ${cell(row.pages, plain)} | ${cell(row.fill, pct)} | ${cell(row.profileFit, plain)} | ${cell(row.resumeCoverage, plain)} | ${cell(row.surfaced, plain)} | ${cell(row.untraceable?.count ?? null, plain)} | ${row.hardFailures.join(', ') || '–'} |`
    )
  }
  return `${lines.join('\n')}\n`
}

function delta(base: number | null, cand: number | null, format: (v: number) => string): { abs: string; rel: string } {
  if (base === null || cand === null) return { abs: '–', rel: '–' }
  const d = cand - base
  // The sign of what is printed: a change too small to show reads as none.
  const sign = (shown: string, zero: string) => (shown === zero ? '±' : d > 0 ? '+' : '−')
  const absShown = format(Math.abs(d))
  const abs = `${sign(absShown, format(0))}${absShown}`
  const relShown = `${Math.abs((d / base) * 100).toFixed(0)}%`
  const rel = base === 0 ? '–' : `${sign(relShown, '0%')}${relShown}`
  return { abs, rel }
}

export interface Verdict {
  /** The runs share at least one job; without one there is no verdict on time or quality. */
  comparable: boolean
  /** The candidate's median time is lower than the base's. */
  faster: boolean
  /** Why the candidate is not better, empty when quality held. */
  regressions: string[]
  text: string
}

/**
 * The two runs' rows of the jobs both ran: medians of different job mixes would compare the jobs, not the
 * versions. Empty when they share none (or either has no run): then nothing is compared.
 */
export function sharedRows(base: BenchResults, cand: BenchResults): { base: BenchRow[]; cand: BenchRow[]; shared: string[] } {
  const ids = new Set(cand.rows.map((r) => r.jobId))
  const shared = [...new Set(base.rows.map((r) => r.jobId))].filter((id) => ids.has(id)).sort()
  const keep = (rows: BenchRow[]) => rows.filter((r) => shared.includes(r.jobId))
  return { base: keep(base.rows), cand: keep(cand.rows), shared }
}

/**
 * Over the jobs both runs ran (`sharedRows`), quality holds when the candidate's median resume coverage and surfaced drop by at most `tolerance` points, its
 * mean untraceable count per run does not rise, and its pass rate does not drop. Only then is faster better.
 */
export function verdict(baseRun: BenchResults, candRun: BenchResults, tolerance = DEFAULT_TOLERANCE): Verdict {
  const rows = sharedRows(baseRun, candRun)
  if (rows.shared.length === 0) {
    const ids = (r: BenchResults) => [...new Set(r.rows.map((x) => x.jobId))].join(', ') || 'none'
    return {
      comparable: false,
      faster: false,
      regressions: [],
      text: `**Not comparable**: the two runs share no job (base: ${ids(baseRun)}; candidate: ${ids(candRun)}), so there is no verdict on time or quality. Run both on the same jobs.`
    }
  }
  const base = { rows: rows.base }
  const cand = { rows: rows.cand }
  const regressions: string[] = []
  for (const [label, of] of [
    ['resume coverage', (r: BenchRow) => r.resumeCoverage],
    ['surfaced', (r: BenchRow) => r.surfaced]
  ] as const) {
    const b = medianOf(base.rows, of)
    const c = medianOf(cand.rows, of)
    if (b !== null && (c === null || b - c > tolerance)) regressions.push(`median ${label} ${b} → ${c ?? '–'} (more than ${tolerance} points)`)
  }
  const bu = meanUntraceable(base.rows)
  const cu = meanUntraceable(cand.rows)
  if (cu !== null && cu > (bu ?? 0)) regressions.push(`untraceable claims per run ${plain(bu ?? 0)} → ${plain(cu)}`)
  const bp = passRate(base.rows)
  const cp = passRate(cand.rows)
  if (bp !== null && cp !== null && cp < bp) regressions.push(`pass rate ${pct(bp)} → ${pct(cp)}`)

  const bt = medianOf(base.rows, (r) => r.activeMs)
  const ct = medianOf(cand.rows, (r) => r.activeMs)
  const faster = bt !== null && ct !== null && ct < bt
  const time = bt !== null && ct !== null ? `median time ${secs(bt)} → ${secs(ct)} (${delta(bt, ct, secs).rel})` : 'no time to compare'
  const bc = medianOf(base.rows, (r) => r.costUsd)
  const cc = medianOf(cand.rows, (r) => r.costUsd)
  const cost = bc !== null && cc !== null ? `, median cost ${usd(bc)} → ${usd(cc)}` : ''
  let text: string
  if (regressions.length > 0) text = `**Quality regression**: ${regressions.join('; ')}. Not better, whatever the time (${time}${cost}).`
  else if (faster) text = `**Faster at equal quality**: ${time}${cost}.`
  else if (bt !== null && ct !== null && ct > bt) text = `**Slower**, quality held: ${time}${cost}.`
  else text = `**No faster**, quality held: ${time}${cost}.`
  return { comparable: true, faster, regressions, text }
}

/** Per-job value: the median over a job's repeats. */
function byJob(rows: readonly BenchRow[]): Map<string, BenchRow[]> {
  const map = new Map<string, BenchRow[]>()
  for (const row of rows) map.set(row.jobId, [...(map.get(row.jobId) ?? []), row])
  return map
}

/** The comparison of two bench runs, `base` first. */
export function compareBench(base: BenchResults, cand: BenchResults, opts: { tolerance?: number } = {}): string {
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE
  const lines = ['# Tailoring bench comparison', '', `- **Base**: ${header(base)}`, `- **Candidate**: ${header(cand)}`, '']
  if (base.set.sha256 !== cand.set.sha256)
    lines.push('> **Warning**: the two runs used different bench sets (set hashes differ); the medians are not comparable.', '')
  if (base.profile.sha256 !== cand.profile.sha256)
    lines.push('> **Warning**: the two runs used different master profiles; quality numbers are not comparable.', '')
  if (base.interrupted || cand.interrupted) lines.push('> **Warning**: a run was interrupted; only the runs that ended are counted.', '')

  const v = verdict(base, cand, tolerance)
  lines.push(`**Verdict**: ${v.text}`, '')

  const rows = sharedRows(base, cand)
  const b = byJob(base.rows)
  const c = byJob(cand.rows)
  // Without a shared job there is nothing to put side by side: no medians, no deltas.
  if (v.comparable) {
    const scope = `Over the ${rows.shared.length} job${rows.shared.length === 1 ? '' : 's'} both runs ran (${rows.base.length} and ${rows.cand.length} runs).`
    lines.push('## Medians', '', scope, '', '| Metric | Base | Candidate | Δ | Δ % |', '| --- | ---: | ---: | ---: | ---: |')
    for (const m of METRICS) {
      const bm = medianOf(rows.base, m.of)
      const cm = medianOf(rows.cand, m.of)
      const d = delta(bm, cm, m.format)
      lines.push(`| ${m.label} | ${cell(bm, m.format)} | ${cell(cm, m.format)} | ${d.abs} | ${d.rel} |`)
    }
    const bp = passRate(rows.base)
    const cp = passRate(rows.cand)
    const dp = delta(bp, cp, pct)
    lines.push(`| Pass rate | ${cell(bp, pct)} | ${cell(cp, pct)} | ${dp.abs} | – |`, '')

    const shared = [...b.keys()].filter((id) => c.has(id)).sort()
    const pair = (rows: BenchRow[] | undefined, of: (r: BenchRow) => number | null, format: (v: number) => string) =>
      cell(rows ? medianOf(rows, of) : null, format)
    lines.push(
      '## Per job',
      '',
      '| Job | Time | Cost | Coverage | Surfaced | Untraceable | Hard fails |',
      '| --- | --- | --- | --- | --- | --- | --- |'
    )
    for (const id of shared) {
      const x = b.get(id)
      const y = c.get(id)
      const side = (of: (r: BenchRow) => number | null, format: (v: number) => string) => `${pair(x, of, format)} → ${pair(y, of, format)}`
      const fails = (rows: BenchRow[] | undefined) => [...new Set((rows ?? []).flatMap((r) => r.hardFailures))].join(', ') || '–'
      lines.push(
        `| ${id} | ${side((r) => r.activeMs, secs)} | ${side((r) => r.costUsd, usd)} | ${side((r) => r.resumeCoverage, plain)} | ${side((r) => r.surfaced, plain)} | ${side((r) => r.untraceable?.count ?? null, plain)} | ${fails(x)} → ${fails(y)} |`
      )
    }
  }
  const onlyBase = [...b.keys()].filter((id) => !c.has(id)).sort()
  const onlyCand = [...c.keys()].filter((id) => !b.has(id)).sort()
  if (onlyBase.length || onlyCand.length) {
    lines.push('', '## Jobs in only one run', '')
    if (onlyBase.length) lines.push(`- Base only: ${onlyBase.join(', ')}`)
    if (onlyCand.length) lines.push(`- Candidate only: ${onlyCand.join(', ')}`)
  }
  return `${lines.join('\n')}\n`
}
