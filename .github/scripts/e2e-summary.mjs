// Writes the pass/fail counts and duration of a Playwright run to the GitHub job summary.
// Usage: node .github/scripts/e2e-summary.mjs e2e/.results/results.json
// Reads the JSON reporter's output (`stats`), which the config writes when CI is set.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const file = process.argv[2] ?? 'e2e/.results/results.json'
const summaryFile = process.env.GITHUB_STEP_SUMMARY
const lines = []

if (!existsSync(file)) {
  lines.push('## e2e', '', `No results file at \`${file}\`: the run did not get as far as the tests.`, '')
} else {
  const { stats = {}, errors = [] } = JSON.parse(readFileSync(file, 'utf8'))
  const failed = stats.unexpected ?? 0
  const runErrors = Array.isArray(errors) ? errors.length : 0
  const hasFailure = failed > 0 || runErrors > 0
  const passed = stats.expected ?? 0
  const flaky = stats.flaky ?? 0
  const skipped = stats.skipped ?? 0
  const noTestsPassed = !hasFailure && passed === 0 && flaky === 0
  const seconds = Math.round((stats.duration ?? 0) / 1000)
  const minutes = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  const heading = hasFailure
    ? `❌ ${failed} tests failed, ${runErrors} run ${runErrors === 1 ? 'error' : 'errors'}`
    : noTestsPassed ? '⚠️ no tests passed' : '✅ passed'
  lines.push(
    `## e2e: ${heading}`,
    '',
    '| Passed | Failed | Run errors | Flaky | Skipped | Duration |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${passed} | ${failed} | ${runErrors} | ${flaky} | ${skipped} | ${minutes} |`,
    ''
  )
  if (hasFailure) {
    lines.push(
      'When available, the HTML report and traces of failed tests are attached as artifacts',
      '(`e2e-html-report-*`, `e2e-traces-*`); see docs/testing/e2e.md "CI".',
      ''
    )
  }
}

const text = lines.join('\n')
console.log(text)
if (summaryFile) appendFileSync(summaryFile, text)
