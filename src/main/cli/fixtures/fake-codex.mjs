// Stands in for `codex exec --json … -` / `codex exec resume <thread> --json … -` in tests.
// One turn per process: reads the whole prompt from stdin (until it is closed), answers, exits 0.
//   "WRITE_OUTPUT" -> writes software-engineer/acme/42/{resume.pdf,build-report.json} under cwd first
//   "SLOW" -> waits 300 ms before answering
//   "CRASH" -> prints to stderr and exits 3 before the turn ends
//   "FAIL_TURN" -> prints turn.failed and exits 1
//   "SILENT" -> exits 0 without ending the turn
//   "EMPTY" -> ends the turn with no item and zero output tokens, exits 0
//   "REASONING_ONLY" -> ends the turn with only a reasoning item (still zero output tokens reported)
// The agent message echoes the prompt, the cwd and whether this was a resume.
import { mkdirSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const resumeIdx = argv.indexOf('resume')
const thread = resumeIdx >= 0 ? argv[resumeIdx + 1] : 'thread-fake-1'
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`)

let text = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) text += chunk

out({ type: 'thread.started', thread_id: thread })
out({ type: 'turn.started' })
if (text.includes('CRASH')) {
  process.stderr.write('Reading additional input from stdin...\nboom: simulated codex failure\n')
  process.exit(3)
}
if (text.includes('SILENT')) process.exit(0)
if (text.includes('EMPTY') || text.includes('REASONING_ONLY')) {
  if (text.includes('REASONING_ONLY')) out({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } })
  out({ type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 0 } })
  process.exit(0)
}
if (text.includes('FAIL_TURN')) {
  out({ type: 'turn.failed', error: { message: 'stream disconnected before completion' } })
  process.exit(1)
}
if (text.includes('WRITE_OUTPUT')) {
  const dir = `${process.cwd()}/software-engineer/acme/42`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/resume.pdf`, '%PDF-1.4 fake')
  writeFileSync(`${dir}/build-report.json`, '{"ok": true}')
}
if (text.includes('SLOW')) await new Promise((r) => setTimeout(r, 300))
out({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'cat master-profile.md', status: 'in_progress' } })
out({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'cat master-profile.md', aggregated_output: 'profile text', exit_code: 0, status: 'completed' } })
out({
  type: 'item.completed',
  item: { id: 'item_1', type: 'agent_message', text: `echo: ${text.slice(0, 40)} | cwd=${process.cwd()} | resume=${resumeIdx >= 0}` }
})
out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 50 } })
process.exit(0)
