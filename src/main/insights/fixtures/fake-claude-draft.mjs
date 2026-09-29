#!/usr/bin/env node
// Stands in for `claude -p --output-format json` in tests: echoes argv checks and the prompt.
let input = ''
process.stdin.on('data', (c) => (input += c))
process.stdin.on('end', () => {
  const args = process.argv.slice(2)
  const tools = args[args.indexOf('--tools') + 1]
  if (process.env.FAKE_DRAFT === 'error') {
    console.log(JSON.stringify({ type: 'result', is_error: true, result: 'rate limited' }))
    return
  }
  const bullet = tools === '' ? `Wrote Kafka consumers (${input.includes('12 topics') ? '12' : '40'} topics) in Go.` : 'TOOLS WERE ENABLED'
  console.log(JSON.stringify({ type: 'result', is_error: false, structured_output: { bullet }, total_cost_usd: 0.002 }))
})
