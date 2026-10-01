// Writes the pass/fail counts and duration of a Playwright run to the GitHub job summary.
// Usage: node .github/scripts/e2e-summary.mjs e2e/.results/results.json
// Reads the JSON reporter's output (`stats`, `errors`), which the config writes when CI is set.
// Never fails the step: a missing or unreadable file becomes a summary line and exit code 0.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const file = process.argv[2] ?? 'e2e/.results/results.json'
const summaryFile = process.env.GITHUB_STEP_SUMMARY

function emit(lines) {
  const text = lines.join('\n')
  console.log(text)
  if (summaryFile) appendFileSync(summaryFile, text)
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

if (!existsSync(file)) {
  emit(['## e2e', '', `No results file at \`${file}\`: the run did not get as far as the tests.`, ''])
  process.exit(0)
}

// Playwright killed while writing the report (runner timeout, OOM, SIGKILL) leaves an empty or truncated file.
let report
try {
  report = JSON.parse(readFileSync(file, 'utf8'))
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err)
  emit(['## e2e: ⚠️ unreadable results', '', `The results file \`${file}\` could not be read or parsed (${reason}): the run probably ended before Playwright finished writing it. Check the "Playwright e2e" step log.`, ''])
  process.exit(0)
}

const stats = report?.stats ?? {}
const errors = report?.errors
const failed = stats.unexpected ?? 0
const runErrors = Array.isArray(errors) ? errors.length : 0
const hasFailure = failed > 0 || runErrors > 0
const passed = stats.expected ?? 0
const flaky = stats.flaky ?? 0
const skipped = stats.skipped ?? 0
const noTestsPassed = !hasFailure && passed === 0 && flaky === 0
const seconds = Math.round((stats.duration ?? 0) / 1000)
const minutes = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`

// "1 test failed", "2 tests failed, 1 run error": only the non-zero parts, singular or plural.
const parts = []
if (failed > 0) parts.push(`${plural(failed, 'test')} failed`)
if (runErrors > 0) parts.push(`${runErrors} run ${runErrors === 1 ? 'error' : 'errors'}`)
const heading = hasFailure ? `❌ ${parts.join(', ')}` : noTestsPassed ? '⚠️ no tests passed' : '✅ passed'

const lines = [
  `## e2e: ${heading}`,
  '',
  '| Passed | Failed | Run errors | Flaky | Skipped | Duration |',
  '| ---: | ---: | ---: | ---: | ---: | ---: |',
  `| ${passed} | ${failed} | ${runErrors} | ${flaky} | ${skipped} | ${minutes} |`,
  ''
]
if (hasFailure) {
  lines.push(
    'The HTML report (`e2e-html-report-*`) and the traces of the failed tests (`e2e-traces-*`) are',
    'attached to this run as artifacts; see docs/testing/e2e.md "CI".',
    ''
  )
} else if (flaky > 0) {
  lines.push(`${plural(flaky, 'test')} passed on retry; the traces are attached as \`e2e-traces-*\`.`, '')
}
emit(lines)
