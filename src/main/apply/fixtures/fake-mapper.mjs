#!/usr/bin/env node
// Stands in for the one-shot question mapping call (#71) in tests, as `claude -p … --json-schema` (prompt on stdin)
// or `agy … --print=<prompt>` (FAKE_MAPPER_AGENT=agy). It appends { args, stdin } to $FAKE_MAPPER_LOG and answers
// by $FAKE_MAPPER: ok (default: "gender"/"sponsor" questions mapped, others null) · bad (not JSON) · unknown (an
// unknown fact key and an unknown id) · error (is_error) · stall (never answers).
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
const mode = process.env.FAKE_MAPPER || 'ok'
let input = ''
process.stdin.on('data', (c) => (input += c))
process.stdin.on('end', async () => {
  if (process.env.FAKE_MAPPER_LOG) appendFileSync(process.env.FAKE_MAPPER_LOG, `${JSON.stringify({ args, stdin: input })}\n`)
  if (mode === 'stall') await new Promise(() => setInterval(() => undefined, 1000))
  if (mode === 'bad') return void console.log('Sure! Here are the mappings: gender')
  if (mode === 'error') return void console.log(JSON.stringify({ type: 'result', is_error: true, result: 'rate limited' }))
  const tools = args.indexOf('--tools')
  if (tools >= 0 && args[tools + 1] !== '') return void console.log(JSON.stringify({ type: 'result', is_error: true, result: 'TOOLS WERE ENABLED' }))
  const prompt = input || (args.find((a) => a.startsWith('--print=')) ?? '').slice('--print='.length)
  const questions = JSON.parse(prompt.slice(prompt.indexOf('['), prompt.lastIndexOf(']') + 1))
  const mappings = questions.map((q) => ({
    id: q.id,
    factKey: /gender/i.test(q.question) ? 'gender' : /sponsor/i.test(q.question) ? 'needsSponsorship' : null
  }))
  if (mode === 'unknown') mappings.push({ id: 'q999', factKey: 'gender' }, { id: questions[0].id, factKey: 'favouriteColour' })
  if (mode === 'unknown') mappings.reverse()
  console.log(JSON.stringify({ type: 'result', is_error: false, structured_output: { mappings }, total_cost_usd: 0.017 }))
})
