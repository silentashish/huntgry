// Stands in for `claude -p --input-format stream-json --output-format stream-json`
// in tests. Reads user messages on stdin and answers each with one turn:
//   "WRITE_OUTPUT" in a message -> writes role/company/42/{resume.pdf,build-report.json} under cwd first
//   "WRITE_OUTPUT_AT:<role>/<company>/<id>" -> the same, into that folder
//   "SLOW" -> waits 300 ms (after writing any output) before answering
//   "RATE_LIMIT" -> prints Claude's burst-limiter error to stderr and exits 1
//   "CRASH" -> prints to stderr and exits 3
//   "USAGE_LIMIT[:<epoch seconds>]" -> rate_limit_event rejected (resetsAt = epoch, or now + 60 s), then the
//                                     "You've hit your session limit · resets 3:45pm" error result, exit 1
//   "RATE_WARN" -> a rate_limit_event allowed_warning (utilization 0.96) before a normal turn
//   "STALL" -> after init, never answers (stays silent until killed)
//   "PARTIAL_STALL" -> streams one request's assistant message (with its usage, twice, as Claude repeats it per block), then stalls
//   "ASK" -> the turn ends with a question and nothing written
//   "WRITE_NOTES" -> like WRITE_OUTPUT, plus review-notes.md in the documented format
//   "VERIFY_FAIL" -> like WRITE_NOTES, but build-report.json says ok: false with a failed hard check
//   "NO_NOTES" -> like WRITE_OUTPUT (resume.pdf + ok report) without review-notes.md
// Every mode is also honoured on a reply, so the second turn of a session can differ from the first
// ("ASK" then "WRITE_NOTES" via the reply text); "SECOND:" in a reply is stripped, so a reply can say "SECOND:VERIFY_FAIL".
// Closing stdin ends the process with code 0.
// Like the real CLI, `total_cost_usd` and `modelUsage` are the session's running totals (a resumed
// session continues them, kept in <cwd>/.fake-claude-<session>.json); `usage` is the turn's own.
// FAKE_CLAUDE_UNKNOWN=--flag in the env: behaves like an older CLI that rejects that flag.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const MODEL = 'claude-haiku-4-5-20251001'
const countsFile = `${process.cwd()}/.fake-claude-${session}.json`
let counts = { cost: 0, input: 0, output: 0 }
if (resumeIdx > 0) {
  try {
    counts = JSON.parse(readFileSync(countsFile, 'utf8'))
  } catch {
    // A new session as far as the fake knows.
  }
}
/** A `result` event: this turn's `usage` and the session's running totals. */
const result = (fields, cost, input, output) => {
  counts = { cost: counts.cost + cost, input: counts.input + input, output: counts.output + output }
  writeFileSync(countsFile, JSON.stringify(counts))
  return {
    type: 'result',
    session_id: session,
    duration_ms: 5,
    permission_denials: [],
    ...fields,
    total_cost_usd: counts.cost,
    usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output },
    modelUsage: { [MODEL]: { inputTokens: counts.input, outputTokens: counts.output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: counts.cost } }
  }
}

out({ type: 'system', subtype: 'hook_started', session_id: session })
out({ type: 'system', subtype: 'init', session_id: session, cwd: process.cwd(), model: MODEL })

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue
  const msg = JSON.parse(line)
  let text = String(msg.message?.content ?? '')
  turn++
  // "SECOND:" marks the mode words meant for this turn (the rest of the reply is kept, e.g. WRITE_OUTPUT_AT).
  if (text.includes('SECOND:')) text = text.replace(/SECOND:/g, '')
  if (text.includes('CRASH')) {
    process.stderr.write('boom: simulated failure\n')
    process.exit(3)
  }
  if (text.includes('RATE_LIMIT')) {
    process.stderr.write('API Error: Server is temporarily limiting requests (not your usage limit)\n')
    process.exit(1)
  }
  if (text.includes('PARTIAL_STALL')) {
    const usage = { input_tokens: 10, cache_creation_input_tokens: 800, cache_read_input_tokens: 1200, cache_creation: { ephemeral_1h_input_tokens: 800 }, output_tokens: 3 }
    for (const block of [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Working on it…' }])
      out({ type: 'assistant', message: { id: `p${turn}`, model: MODEL, role: 'assistant', content: [block], usage } })
  }
  if (text.includes('STALL')) {
    await new Promise(() => undefined)
  }
  if (text.includes('USAGE_LIMIT')) {
    const epoch = Number(/USAGE_LIMIT:(\d+)/.exec(text)?.[1] ?? Math.floor(Date.now() / 1000) + 60)
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: epoch, rateLimitType: 'five_hour', utilization: 1 }, uuid: 'u1', session_id: session })
    out(result({ subtype: 'success', is_error: true, api_error_status: 429, result: "You've hit your session limit · resets 3:45pm" }, 0, 0, 0))
    process.stderr.write("You've hit your session limit · resets 3:45pm\n")
    process.exit(1)
  }
  if (text.includes('RATE_WARN')) {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour', utilization: 0.96 }, uuid: 'u2', session_id: session })
  }
  const jobDir = () => {
    const at = /WRITE_OUTPUT_AT:([\w/-]+)/.exec(text)?.[1] ?? /Job id: ([\w-]+)/.exec(text)?.[1]?.replace(/^(.*)$/, 'software-engineer/acme/$1') ?? 'software-engineer/acme/42'
    const dir = `${process.cwd()}/${at}`
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const notes = (dir) =>
    writeFileSync(
      `${dir}/review-notes.md`,
      `# Review notes\n<!-- huntgry-review v1 · run fake · unattended -->\n\n## Used standing approvals\nNone.\n\n## Proposed reframings (not used)\n### R1 · Kafka streaming\n- Source fact: Built an event pipeline on RabbitMQ\n- Proposed wording: Built event-streaming pipelines (RabbitMQ; Kafka-adjacent)\n- Why unsure: Kafka was never used\n\n## Open gaps\n- Go: nothing honest to say\n\n## Notes\nFake run.\n`
    )
  if (text.includes('WRITE_OUTPUT') || text.includes('NO_NOTES')) {
    const dir = jobDir()
    writeFileSync(`${dir}/resume.pdf`, '%PDF-1.4 fake')
    writeFileSync(`${dir}/build-report.json`, '{"ok": true}')
  }
  if (text.includes('WRITE_NOTES')) {
    const dir = jobDir()
    writeFileSync(`${dir}/resume.pdf`, '%PDF-1.4 fake')
    writeFileSync(`${dir}/build-report.json`, '{"ok": true, "verify": {"results": [{"check": "page_count", "passed": true, "hard": true}]}}')
    notes(dir)
  }
  if (text.includes('VERIFY_FAIL')) {
    const dir = jobDir()
    writeFileSync(`${dir}/resume.pdf`, '%PDF-1.4 fake')
    writeFileSync(`${dir}/build-report.json`, '{"ok": false, "verify": {"results": [{"check": "page_count", "passed": false, "hard": true}, {"check": "email", "passed": true, "hard": true}]}}')
    notes(dir)
  }
  if (text.includes('NO_REPORT')) {
    // Built without a build-report.json: the verify gate runs verify.py itself.
    const dir = jobDir()
    writeFileSync(`${dir}/resume.pdf`, '%PDF-1.4 fake')
    notes(dir)
  }
  if (text.includes('BUILT_THEN_ERROR')) {
    // Builds (with a failing check), then the turn ends with an error result and the process exits.
    const dir = jobDir()
    writeFileSync(`${dir}/resume.pdf`, '%PDF-1.4 fake')
    writeFileSync(`${dir}/build-report.json`, '{"ok": false, "verify": {"results": [{"check": "page_count", "passed": false, "hard": true}]}}')
    notes(dir)
    out(result({ subtype: 'error_during_execution', is_error: true, result: 'API Error: 500 Internal server error' }, 0.01, 1000, 100))
    process.stderr.write('API Error: 500 Internal server error\n')
    process.exit(1)
  }
  if (text.includes('SLOW')) await new Promise((r) => setTimeout(r, 300))
  out({ type: 'assistant', message: { id: `m${turn}`, role: 'assistant', content: [{ type: 'tool_use', id: `t${turn}`, name: 'Read', input: { file_path: '/ws/master-profile.md' } }] } })
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${turn}`, content: 'profile text' }] } })
  // A partial line split across writes must still parse.
  const answer = text.includes('ASK') ? 'Before I build: is "led the migration" honest for your role?' : `echo: ${text.slice(0, 40)}`
  const reply = JSON.stringify({ type: 'assistant', message: { id: `m${turn}b`, role: 'assistant', content: [{ type: 'text', text: answer }] } })
  process.stdout.write(reply.slice(0, 10))
  await new Promise((r) => setTimeout(r, 5))
  process.stdout.write(`${reply.slice(10)}\n`)
  // 1000 input + 1800 output tokens of Haiku 4.5 = $0.01, so the estimate matches the reported cost.
  out(result({ subtype: 'success', is_error: false, result: 'done' }, 0.01, 1000, 1800))
}
process.exit(0)
