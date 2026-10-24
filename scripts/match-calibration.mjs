// Calibrates the match score (#149) on a real workspace: scores its saved jobs (.huntgry/jobs/*.json) and the
// Explore list (.huntgry/explore/jobright.json) against its master-profile.md, and prints the spread (min,
// quartiles, median, max), a histogram and example jobs, to pick thresholds such as Automation's (#154) from.
// Reads the workspace only; prints titles, companies and skill names, never the profile or a description.
// Run: node scripts/match-calibration.mjs <workspace> [--json]   (Node 23+: it imports the TypeScript sources)
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The sources import without extensions and through the `@shared` alias; resolve both to the .ts files.
registerHooks({
  resolve(specifier, context, next) {
    const shared = specifier.startsWith('@shared/') ? join(root, 'src/shared', specifier.slice(8)) : null
    const relative = !shared && specifier.startsWith('.') && context.parentURL?.endsWith('.ts')
    const base = shared ?? (relative ? fileURLToPath(new URL(specifier, context.parentURL)) : null)
    if (base && !existsSync(base) && existsSync(`${base}.ts`)) return next(pathToFileURL(`${base}.ts`).href, context)
    return next(specifier, context)
  }
})

const { parseMasterProfile } = await import(pathToFileURL(join(root, 'src/main/profile/format.ts')).href)
const { profileSignals, scoreJob } = await import(pathToFileURL(join(root, 'src/shared/job-relevance.ts')).href)
const { matchScore } = await import(pathToFileURL(join(root, 'src/shared/match-score.ts')).href)

const workspace = process.argv[2]
if (!workspace) {
  console.error('usage: node scripts/match-calibration.mjs <workspace> [--json]')
  process.exit(2)
}
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const { profile } = parseMasterProfile(readFileSync(join(workspace, 'master-profile.md'), 'utf8'))
const signals = profileSignals(profile)

const jobsDir = join(workspace, '.huntgry/jobs')
const saved = existsSync(jobsDir)
  ? readdirSync(jobsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(join(jobsDir, f)))
  : []
const explorePath = join(workspace, '.huntgry/explore/jobright.json')
const explore = existsSync(explorePath) ? (readJson(explorePath).jobs ?? []) : []

/**
 * Explore rows come from the README: a title, no description and no jdCoreSkills until #150 loads the posting.
 * A title alone ("Java Developer") is not a list of requirements, so only rows with either are scored.
 */
const scoreable = (row) => Boolean(row.description?.trim()) || (row.jdCoreSkills?.length ?? 0) > 0
const exploreJob = (row) => ({ title: row.title, description: row.description ?? '', jdCoreSkills: row.jdCoreSkills ?? null })

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  return Math.round(sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo))
}

function spread(scores) {
  const s = [...scores].sort((a, b) => a - b)
  return { n: s.length, min: s[0], p25: quantile(s, 0.25), median: quantile(s, 0.5), p75: quantile(s, 0.75), p90: quantile(s, 0.9), max: s.at(-1) }
}

function histogram(scores, width = 10) {
  const bins = Array.from({ length: 100 / width }, (_, i) => ({ from: i * width, count: 0 }))
  for (const v of scores) bins[Math.min(bins.length - 1, Math.floor(v / width))].count++
  const most = Math.max(1, ...bins.map((b) => b.count))
  return bins.map((b) => {
    const label = `${String(b.from).padStart(2)}–${b.from + width === 100 ? 100 : b.from + width - 1}`.padEnd(6)
    return `${label} ${'█'.repeat(Math.round((b.count / most) * 40))} ${b.count}`
  })
}

const hasRequirements = (s) => s.match.matched.length + s.match.missing.length > 0
const all = saved.map((job) => ({ job, match: matchScore(job, signals), relevant: scoreJob(job, signals).score }))
const scored = all.filter((s) => !s.job.dismissed)
const known = scored.filter(hasRequirements)
const dismissed = all.filter((s) => s.job.dismissed && hasRequirements(s))
const exploreKnown = explore.filter(scoreable).map((row) => ({ row, match: matchScore(exploreJob(row), signals) }))
// Explore rows already added to the Jobs page: the saved copy has the posting's text.
const exploreAdded = all.filter((s) => s.job.source === 'jobright' && hasRequirements(s))

const brief = ({ job, row, match, relevant }) => ({
  title: (job ?? row).title,
  company: (job ?? row).company,
  score: match.score,
  ...(relevant !== undefined ? { relevant } : {}),
  source: match.source,
  matched: match.matched.slice(0, 5).map((m) => m.skill),
  missing: match.missing.slice(0, 5).map((m) => m.skill),
  gates: match.gates.map((g) => g.reason)
})

const byScore = [...known].sort((a, b) => b.match.score - a.match.score)
const report = {
  savedJobs: {
    total: saved.length,
    notDismissed: scored.length,
    withRequirements: known.length,
    bySource: Object.fromEntries(['jobright-skills', 'description'].map((k) => [k, known.filter((s) => s.match.source === k).length])),
    dismissedSpread: dismissed.length > 0 ? spread(dismissed.map((s) => s.match.score)) : null,
    gated: known.filter((s) => s.match.gates.length > 0).length,
    gateKinds: known.flatMap((s) => s.match.gates.map((g) => g.kind)).reduce((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {}),
    spread: spread(known.map((s) => s.match.score)),
    relevantSpread: spread(known.map((s) => s.relevant)),
    requirementCount: spread(known.map((s) => s.match.matched.length + s.match.missing.length)),
    // How many not-dismissed jobs a threshold would pick, alone and with at least 4 requirements (thin postings
    // name one or two skills and score 0 or 100 on them).
    atOrAbove: Object.fromEntries(
      [50, 60, 70, 75, 80, 90].map((t) => {
        const over = known.filter((s) => s.match.score >= t)
        return [t, { jobs: over.length, withFourRequirements: over.filter((s) => s.match.matched.length + s.match.missing.length >= 4).length }]
      })
    ),
    histogram: histogram(known.map((s) => s.match.score)),
    top: byScore.slice(0, 5).map(brief),
    middle: byScore.slice(Math.floor(byScore.length / 2) - 2, Math.floor(byScore.length / 2) + 2).map(brief),
    bottom: byScore.slice(-3).map(brief),
    gatedExamples: byScore.filter((s) => s.match.gates.length > 0).slice(0, 4).map(brief)
  },
  explore: {
    total: explore.length,
    withRequirements: exploreKnown.length,
    spread: exploreKnown.length > 0 ? spread(exploreKnown.map((s) => s.match.score)) : null,
    added: exploreAdded.length,
    addedSpread: exploreAdded.length > 0 ? spread(exploreAdded.map((s) => s.match.score)) : null,
    addedJobs: [...exploreAdded].sort((a, b) => b.match.score - a.match.score).map(brief)
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const s = report.savedJobs
  console.log(`Saved jobs: ${s.total} (${s.notDismissed} not dismissed, ${s.withRequirements} with requirements)`)
  console.log(`  by source: ${JSON.stringify(s.bySource)}; gated: ${s.gated} ${JSON.stringify(s.gateKinds)}`)
  console.log(`  match:    ${JSON.stringify(s.spread)}`)
  console.log(`  relevant: ${JSON.stringify(s.relevantSpread)}`)
  if (s.dismissedSpread) console.log(`  dismissed jobs' match: ${JSON.stringify(s.dismissedSpread)}`)
  console.log(`  requirements per job: ${JSON.stringify(s.requirementCount)}`)
  console.log(`  at or above: ${JSON.stringify(s.atOrAbove)}`)
  console.log(s.histogram.map((l) => `  ${l}`).join('\n'))
  for (const [name, list] of Object.entries({ top: s.top, middle: s.middle, bottom: s.bottom, gated: s.gatedExamples })) {
    console.log(`  ${name}:`)
    for (const j of list) {
      console.log(`    ${j.score} (relevant ${j.relevant}) ${j.title} · ${j.company}`)
      console.log(`       matched ${j.matched.join(', ') || '-'} | missing ${j.missing.join(', ') || '-'}${j.gates.length ? ` | gates: ${j.gates.join('; ')}` : ''}`)
    }
  }
  const e = report.explore
  console.log(`Explore list: ${e.total} rows, ${e.withRequirements} with a description or jdCoreSkills${e.spread ? `: ${JSON.stringify(e.spread)}` : ''}`)
  console.log(`  added to Jobs: ${e.added}${e.addedSpread ? `: ${JSON.stringify(e.addedSpread)}` : ''}`)
  for (const j of e.addedJobs) {
    console.log(`    ${j.score} ${j.title} · ${j.company}`)
    console.log(`       matched ${j.matched.join(', ') || '-'} | missing ${j.missing.join(', ') || '-'}${j.gates.length ? ` | gates: ${j.gates.join('; ')}` : ''}`)
  }
}
