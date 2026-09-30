// Stands in for `claude -p --input-format stream-json --output-format stream-json`
// in tests. Reads user messages on stdin and answers each with one turn:
//   "WRITE_OUTPUT" in a message -> writes role/company/42/{resume.pdf,build-report.json} under cwd first
//   "WRITE_OUTPUT_AT:<role>/<company>/<id>" -> the same, into that folder
//   "SLOW" -> waits 300 ms (after writing any output) before answering
//   "RATE_LIMIT" -> prints Claude's burst-limiter error to stderr and exits 1
//   "CRASH" -> prints to stderr and exits 3
// Closing stdin ends the process with code 0.
// FAKE_CLAUDE_UNKNOWN=--flag in the env: behaves like an older CLI that rejects that flag.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const unknown = process.env.FAKE_CLAUDE_UNKNOWN
if (unknown && process.argv.includes(unknown)) {
  process.stderr.write(`error: unknown option '${unknown}'\n`)
  process.exit(1)
}

const resumeIdx = process.argv.indexOf('--resume')
const session = resumeIdx > 0 ? process.argv[resumeIdx + 1] : 'sess-fake-1'
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`)
let turn = 0

out({ type: 'system', subtype: 'hook_started', session_id: session })
out({ type: 'system', subtype: 'init', session_id: session, cwd: process.cwd(), model: 'fake' })

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue
  const msg = JSON.parse(line)
  const text = String(msg.message?.content ?? '')
  turn++
  if (text.includes('CRASH')) {
    process.stderr.write('boom: simulated failure\n')
    process.exit(3)
  }
  if (text.includes('RATE_LIMIT')) {
    process.stderr.write('API Error: Server is temporarily limiting requests (not your usage limit)\n')
    process.exit(1)
  }
  if (text.includes('WRITE_OUTPUT')) {
    const at = /WRITE_OUTPUT_AT:([\w/-]+)/.exec(text)?.[1] ?? 'software-engineer/acme/42'
    const dir = `${process.cwd()}/${at}`
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/resume.pdf`, '%PDF-1.4 fake')
    writeFileSync(`${dir}/build-report.json`, '{"ok": true}')
  }
  if (text.includes('SLOW')) await new Promise((r) => setTimeout(r, 300))
  out({ type: 'assistant', message: { id: `m${turn}`, role: 'assistant', content: [{ type: 'tool_use', id: `t${turn}`, name: 'Read', input: { file_path: '/ws/master-profile.md' } }] } })
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${turn}`, content: 'profile text' }] } })
  // A partial line split across writes must still parse.
  const reply = JSON.stringify({ type: 'assistant', message: { id: `m${turn}b`, role: 'assistant', content: [{ type: 'text', text: `echo: ${text.slice(0, 40)}` }] } })
  process.stdout.write(reply.slice(0, 10))
  await new Promise((r) => setTimeout(r, 5))
  process.stdout.write(`${reply.slice(10)}\n`)
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: session, total_cost_usd: 0.01, duration_ms: 5, permission_denials: [] })
}
process.exit(0)
