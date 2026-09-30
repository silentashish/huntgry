// Stands in for `agy --input-format stream-json --output-format stream-json … --print=` in tests.
// Reads {"event":"user","message":{"content":…}} lines on stdin and answers each with one turn:
//   "WRITE_OUTPUT" -> writes software-engineer/acme/<job id from the prompt, else 42>/{resume.pdf,build-report.json} under cwd first
//   "QUOTA" -> a result with status ERROR, then AGY_ERROR (429) on stderr and exit 3, like a used-up quota
//   "CRASH" -> prints to stderr and exits 2
//   "USAGE_LIMIT" -> like QUOTA, with a relative reset ("Resets in 0h1m0s")
// Closing stdin ends the process with code 0.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const convIdx = process.argv.indexOf('--conversation')
const conv = convIdx > 0 ? process.argv[convIdx + 1] : 'conv-fake-1'
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`)
const step = (s) => out({ event: 'step_update', step_update: { conversation_id: conv, ...s } })
let index = 0

if (!process.argv.includes('--print=')) {
  process.stderr.write('fake agy: expected --print=\n')
  process.exit(1)
}
out({ event: 'init', conversation_id: conv, init: { cwd: process.cwd(), tools: ['run_command'], permission_mode: 'request-review' } })

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue
  const msg = JSON.parse(line)
  if (msg.event !== 'user') {
    process.stderr.write('error: stream input message is missing the "event" field\n')
    process.exit(1)
  }
  const text = String(msg.message?.content ?? '')
  step({ step_index: index++, state: 'DONE', step_type: 'user_input' })
  if (text.includes('CRASH')) {
    process.stderr.write('panic: simulated agy failure\n')
    process.exit(2)
  }
  if (text.includes('QUOTA') || text.includes('USAGE_LIMIT')) {
    const msg = text.includes('USAGE_LIMIT') ? 'Individual quota reached. Resets in 0h1m0s.' : 'Individual quota reached.'
    step({ step_index: index++, state: 'DONE', step_type: 'error_message' })
    out({ event: 'result', result: { conversation_id: conv, status: 'ERROR', response: '', error: msg, duration_seconds: 0, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0 } } })
    process.stderr.write(`error: ${msg}\nAGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): ${msg}","status":"RESOURCE_EXHAUSTED","error_code":429,"retryable":true}\n`)
    process.exit(3)
  }
  if (text.includes('WRITE_OUTPUT')) {
    const dir = `${process.cwd()}/software-engineer/acme/${/Job id: ([\w-]+)/.exec(text)?.[1] ?? '42'}`
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/resume.pdf`, '%PDF-1.4 fake')
    writeFileSync(`${dir}/build-report.json`, '{"ok": true}')
  }
  const tool = index++
  step({ step_index: tool, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/ws/master-profile.md' } } })
  step({ step_index: tool, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/ws/master-profile.md' }, output: 'profile text' } })
  const reply = index++
  step({ step_index: reply, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'echo: ' })
  step({ step_index: reply, state: 'DONE', step_type: 'agent_response', text_delta: text.slice(0, 40) })
  out({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: `echo: ${text.slice(0, 40)}`, duration_seconds: 0.1, num_turns: 1, usage: { input_tokens: 2000, output_tokens: 70 } } })
}
process.exit(0)
