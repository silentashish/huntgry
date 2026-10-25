#!/usr/bin/env node
// Scripted stand-in for the three agent CLIs Huntgry drives, for the e2e suite:
//
//   node agent.mjs claude …    speaks `claude -p --input-format stream-json --output-format stream-json`
//   node agent.mjs codex …     speaks `codex exec --json … -` / `codex exec resume <thread> …`
//   node agent.mjs agy …       speaks `agy --input-format stream-json --output-format stream-json … --print=`
//
// The e2e fixture (index.ts) installs one wrapper per name in the sandbox `bin`, so the
// app's real discovery, version gate, sign-in check and runner drive this script exactly
// as they would drive the real CLI. Nothing in src/ knows about it.
//
// What the "skill" does, whichever agent is asked (the single flow, #158):
//   turn 1 (the job)      gap analysis, one Read of the master profile, then it builds without
//                         asking: one Bash step, then resume.pdf, resume_data.json,
//                         build-report.json, job-description.md (copied from the file the first
//                         message names, as `build.py --jd` does) and tailoring-notes.md v2 under
//                         <CV_HOME or cwd>/<role>/<company>/<job-id>/ (role, company and job id
//                         come from the first message, as the real skill reads them)
//   any later reply       a follow-up ("make it shorter", a Review re-run): rebuilds the folder
//   caller rules (#159)   the one reframing it writes ("Owned the platform migration of billing to Go
//                         for <company>", from the fact "Led the migration of the billing service to
//                         Go") follows the PREFERRED WORDINGS / WORDINGS TO AVOID lines of the system
//                         prompt and of any later message: a preferred wording for the fact is used
//                         as written, an avoided one never (then the fact itself is used). The
//                         wording lands in resume_data.json, resume.pdf and tailoring-notes.md.
// Resuming (`--resume <id>`, `exec resume <id>`, `--conversation <id>`) reuses that session id.
//
// Behaviour switches, read from `$FAKE_AGENT_HOME/config.json` and overridden by the environment:
//   FAKE_AGENT_SCRIPT   normal (default) · slow (a pause before every event, `slowMs`)
//                       · fail (stderr + exit 3 after the first message) · exit-early (exit 0 after init)
//                       · ask (a missing prerequisite: turn 1 and the pipeline's nudge end with a
//                         question; the user's answer then builds)
//   FAKE_AGENT_SLOW_MS  the pause of `slow`, default 1500
//   claudeVersion / codexVersion / agyVersion in config.json: what `--version` prints
//
// One-shot calls (`claude -p … --json-schema …` with the prompt on stdin, `agy … --json-schema … --print=<prompt>`),
// as the Apply question mapping makes them (#71), answer one JSON result whose `structured_output.mappings` maps
// questions mentioning "gender" to `gender` and the rest to null (answering "experience with" questions Yes, reusable, #136); the answer drafting (#82, a schema with `answers`)
// drafts "interests you" questions only. The marker records `mode: 'oneshot'` and the prompt.
//
// Every spawn appends a line to `$FAKE_AGENT_HOME/invocations.jsonl` (the marker the tests
// read): `{ agent, mode: 'version' | 'auth' | 'run' | 'oneshot', pid, cwd, args, resume, at }`, then
// `{ event: 'turn-start' | 'turn-end', pid, turn, at }` around each turn of a run.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const [agent, ...args] = process.argv.slice(2)
if (!['claude', 'codex', 'agy'].includes(agent)) {
  process.stderr.write(`fake agent: unknown agent "${agent}"\n`)
  process.exit(64)
}

const home = process.env.FAKE_AGENT_HOME || null
const config = readConfig()
const script = process.env.FAKE_AGENT_SCRIPT || config.script || 'normal'
const slowMs = Number(process.env.FAKE_AGENT_SLOW_MS || config.slowMs || 1500)
const versions = {
  claude: config.claudeVersion || '9.9.9',
  codex: config.codexVersion || '0.99.0',
  agy: config.agyVersion || '1.99.0'
}

function readConfig() {
  if (!home) return {}
  try {
    return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

function mark(record) {
  // A process spawned right before the app quit may boot after the sandbox was removed: never recreate it.
  if (!home || !existsSync(home)) return
  appendFileSync(join(home, 'invocations.jsonl'), `${JSON.stringify({ agent, pid: process.pid, at: Date.now(), ...record })}\n`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pause = () => (script === 'slow' ? sleep(slowMs) : Promise.resolve())

// --- one-shot commands ------------------------------------------------------------------

if (args.includes('--version') || args.includes('-V')) {
  mark({ mode: 'version', args })
  const v = versions[agent]
  process.stdout.write(agent === 'claude' ? `${v} (Claude Code)\n` : agent === 'codex' ? `codex-cli ${v}\n` : `agy ${v}\n`)
  process.exit(0)
}

if (agent === 'claude' && args[0] === 'auth' && args[1] === 'status') {
  mark({ mode: 'auth', args })
  process.stdout.write(
    `${JSON.stringify({ loggedIn: true, email: 'fake@example.com', authMethod: 'claude.ai', subscriptionType: 'max' })}\n`
  )
  process.exit(0)
}

// --- a one-shot structured call (the Apply question mapping, #71) ----------------------------

const printArg = args.find((a) => a.startsWith('--print='))
if (args.includes('--json-schema') && (args.includes('-p') || (agent === 'agy' && printArg && printArg !== '--print='))) {
  let prompt = printArg && printArg !== '--print=' ? printArg.slice('--print='.length) : ''
  if (!prompt) {
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) prompt += chunk
  }
  mark({ mode: 'oneshot', args, cwd: process.cwd(), prompt })
  let questions = []
  try {
    // The questions list is last in both prompts (the draft prompt has the job description and resume before it).
    const list = prompt.slice(prompt.lastIndexOf('Questions:'))
    questions = JSON.parse(list.slice(list.indexOf('['), list.lastIndexOf(']') + 1))
  } catch {
    // Not a mapping prompt: no mappings.
  }
  const schema = args[args.indexOf('--json-schema') + 1] ?? ''
  if (schema.includes('"answers"')) {
    // The Apply answer drafting (#82): a draft for "interests you" questions, null for the rest.
    const answers = questions.map((q) => ({
      id: String(q.id),
      answer: /interests you/i.test(String(q.question)) ? `Fake draft: ${String(q.question)}` : null
    }))
    process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { answers }, total_cost_usd: 0.02 })}\n`)
    process.exit(0)
  }
  // The mapping also gives probable answers since #136: "experience with" questions are answered Yes.
  const mappings = questions.map((q) => ({
    id: String(q.id),
    factKey: /gender/i.test(String(q.question)) ? 'gender' : null,
    answer: /experience with/i.test(String(q.question)) ? 'Yes' : null,
    // An answer about the applicant's skills is the same at any employer (#136).
    reusable: /experience with/i.test(String(q.question))
  }))
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { mappings }, total_cost_usd: 0.017 })}\n`)
  process.exit(0)
}

// --- a run --------------------------------------------------------------------------------

const resume = resumeId()
const session = resume ?? `${agent}-session-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`
mark({ mode: 'run', args, cwd: process.cwd(), resume, session })

function resumeId() {
  if (agent === 'claude') {
    const i = args.indexOf('--resume')
    return i >= 0 ? args[i + 1] : null
  }
  if (agent === 'codex') {
    const i = args.indexOf('resume')
    return args[0] === 'exec' && i === 1 ? args[2] : null
  }
  const i = args.indexOf('--conversation')
  return i >= 0 ? args[i + 1] : null
}

const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`)
let turn = 0

/**
 * Like the real CLIs, Claude's cost / modelUsage and Codex's usage are the session's running
 * totals, continued by a resume: kept in FAKE_AGENT_HOME between processes (in memory without one).
 */
const countersFile = home ? join(home, `counters-${agent}-${session.replace(/[^\w-]/g, '_')}.json`) : null
let counters = { input: 0, output: 0, cost: 0 }
try {
  if (resume && countersFile) counters = JSON.parse(readFileSync(countersFile, 'utf8'))
} catch {
  // A session the fake has not seen: start from zero.
}
function count(input, output, cost) {
  counters = { input: counters.input + input, output: counters.output + output, cost: counters.cost + cost }
  if (countersFile && existsSync(home)) writeFileSync(countersFile, JSON.stringify(counters))
  return counters
}
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'
let step = 0
let messageN = 0

/** The three protocols, behind one small vocabulary. */
const protocol = {
  claude: {
    init() {
      out({ type: 'system', subtype: 'hook_started', session_id: session, hook_name: 'SessionStart' })
      out({
        type: 'system',
        subtype: 'init',
        session_id: session,
        cwd: process.cwd(),
        model: CLAUDE_MODEL,
        tools: ['Read', 'Bash', 'TodoWrite'],
        permissionMode: 'acceptEdits'
      })
    },
    text(text) {
      const id = `msg_${++messageN}`
      out({ type: 'assistant', session_id: session, message: { id, role: 'assistant', content: [{ type: 'text', text }] } })
    },
    tool(name, input, output) {
      const id = `toolu_${++messageN}`
      out({
        type: 'assistant',
        session_id: session,
        message: { id: `msg_${messageN}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
      })
      out({
        type: 'user',
        session_id: session,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] }
      })
    },
    result(text, ms) {
      // 2300 input + 2000 output tokens of Haiku 4.5 = $0.0123 a turn: the estimate matches the CLI's figure.
      const total = count(2300, 2000, 0.0123)
      out({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: text,
        session_id: session,
        total_cost_usd: total.cost,
        usage: { input_tokens: 2300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2000 },
        modelUsage: {
          [CLAUDE_MODEL]: { inputTokens: total.input, outputTokens: total.output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: total.cost }
        },
        duration_ms: ms,
        num_turns: turn,
        permission_denials: []
      })
    },
    fail() {
      process.stderr.write('boom: simulated agent failure\n')
      process.exit(3)
    }
  },
  codex: {
    init() {
      out({ type: 'thread.started', thread_id: session })
      out({ type: 'turn.started' })
    },
    text(text) {
      out({ type: 'item.completed', item: { id: `item_${++messageN}`, type: 'agent_message', text } })
    },
    tool(name, input, output) {
      const id = `item_${++messageN}`
      const command = name === 'Read' ? `cat ${input.file_path}` : input.command
      out({ type: 'item.started', item: { id, type: 'command_execution', command, status: 'in_progress' } })
      out({
        type: 'item.completed',
        item: { id, type: 'command_execution', command, aggregated_output: output, exit_code: 0, status: 'completed' }
      })
    },
    result() {
      const total = count(1200, 80, 0)
      out({ type: 'turn.completed', usage: { input_tokens: total.input, cached_input_tokens: 0, output_tokens: total.output } })
    },
    fail() {
      out({ type: 'turn.failed', error: { message: 'boom: simulated agent failure' } })
      process.stderr.write('boom: simulated agent failure\n')
      process.exit(3)
    }
  },
  agy: {
    init() {
      out({
        event: 'init',
        conversation_id: session,
        init: { cwd: process.cwd(), tools: ['run_command', 'view_file'], permission_mode: 'accept-edits' }
      })
    },
    text(text) {
      const index = step++
      const cut = Math.max(1, Math.floor(text.length / 2))
      const update = (state, delta) =>
        out({ event: 'step_update', step_update: { conversation_id: session, step_index: index, state, step_type: 'agent_response', text_delta: delta } })
      update('ACTIVE', text.slice(0, cut))
      update('DONE', text.slice(cut))
    },
    tool(name, input, output) {
      const index = step++
      const tool = name === 'Read' ? { tool_name: 'view_file', parameters: { AbsolutePath: input.file_path } } : { tool_name: 'run_command', parameters: { CommandLine: input.command } }
      const update = (state, extra) =>
        out({
          event: 'step_update',
          step_update: { conversation_id: session, step_index: index, state, step_type: 'tool', tool_name: tool.tool_name, tool_info: { name: tool.tool_name, parameters: tool.parameters, ...extra } }
        })
      update('ACTIVE', {})
      update('DONE', { output })
    },
    result(text, ms) {
      out({
        event: 'result',
        result: { conversation_id: session, status: 'SUCCESS', response: text, duration_seconds: ms / 1000, num_turns: turn, usage: { input_tokens: 1500, output_tokens: 90 } }
      })
    },
    fail() {
      out({ event: 'result', result: { conversation_id: session, status: 'ERROR', response: '', error: 'boom: simulated agent failure', duration_seconds: 0, num_turns: turn, usage: { input_tokens: 0, output_tokens: 0 } } })
      process.stderr.write('boom: simulated agent failure\nAGY_ERROR: {"short_error":"boom: simulated agent failure","status":"INTERNAL","error_code":500}\n')
      process.exit(3)
    }
  }
}[agent]

if (agent === 'agy' && !args.includes('--print=')) {
  process.stderr.write('fake agy: expected --print= (the prompt comes from stdin)\n')
  process.exit(2)
}

protocol.init()
if (script === 'exit-early') process.exit(0)

// --- the job -----------------------------------------------------------------------------

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/**
 * Role, company and job id as the first message states them, and the job description Huntgry saved
 * (the first message names the file: see buildFirstPrompt in src/main/cli/command.ts).
 */
function parseJob(text) {
  const pick = (label) => new RegExp(`^${label}:\\s*(.+?)\\s*$`, 'm').exec(text)?.[1] ?? ''
  const jdPath = /^Job description: saved at (.+?\.md)\./m.exec(text)?.[1] ?? null
  return {
    role: slug(pick('Role')) || 'software-engineer',
    company: slug(pick('Company')) || 'acme',
    jobId: slug(pick('Job id')) || 'job',
    jdPath
  }
}

/** A resumed process (codex runs one per turn) reads the job it was started with. */
function rememberJob(job) {
  if (!home || !existsSync(home)) return
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(join(home, 'sessions', `${session}.json`), JSON.stringify(job))
}
function recallJob() {
  if (!home) return null
  const file = join(home, 'sessions', `${session}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

let job = resume ? recallJob() : null

// --- caller rules (#159) ------------------------------------------------------------------------

/** The one reframing the fake writes, and its source fact in the demo master profile. */
const FACT = 'Led the migration of the billing service to Go'
const defaultWording = (company) => `Owned the platform migration of billing to Go for ${company}`

/** The rules as Huntgry last stated them (the system prompt, then a re-run message repeating them). */
const rules = { preferred: [], avoid: [] }
function readRules(text) {
  const list = (label) => {
    const m = new RegExp(`^${label} \\(JSON[^)]*\\): (.*)$`, 'm').exec(text)
    if (!m) return null
    try {
      const v = JSON.parse(m[1])
      return Array.isArray(v) ? v : null
    } catch {
      return null
    }
  }
  const preferred = list('PREFERRED WORDINGS')
  const avoid = list('WORDINGS TO AVOID')
  if (preferred) rules.preferred = preferred
  if (avoid) rules.avoid = avoid
}
readRules(args.join('\n'))

const same = (a, b) => String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim()
/** The wording for FACT the rules allow: a preferred one, else the default unless avoided, else the fact itself. */
function wordingFor(company) {
  const avoided = (w) => rules.avoid.some((r) => same(r.sourceFact, FACT) && same(r.wording, w))
  const preferred = rules.preferred.find((r) => same(r.sourceFact, FACT) && !avoided(r.wording))
  if (preferred) return preferred.wording
  return avoided(defaultWording(company)) ? FACT : defaultWording(company)
}

/**
 * A structurally valid one-page PDF: every object at its recorded offset in the
 * cross-reference table, a trailer with /Size and /Root, and startxref. Small
 * enough to read here, real enough for a PDF parser (checked in agent.test.ts).
 */
function tinyPdf(text) {
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return out
}

function build(j) {
  const dir = join(process.env.CV_HOME || process.cwd(), j.role, j.company, j.jobId)
  mkdirSync(dir, { recursive: true })
  const wording = wordingFor(j.company)
  writeFileSync(join(dir, 'resume.pdf'), tinyPdf(`Alex Rivera - ${j.role} at ${j.company}. ${wording}`))
  writeFileSync(
    join(dir, 'resume_data.json'),
    `${JSON.stringify(
      {
        contact: { name: 'Alex Rivera', email: 'alex.rivera@example.com' },
        summary: `Engineer tailored for ${j.role} at ${j.company} by the fake agent.`,
        skills: [{ category: 'Languages', items: ['Go', 'TypeScript'] }],
        experience: [{ company: 'Initrode', title: 'Software Engineer', bullets: [wording] }]
      },
      null,
      2
    )}\n`
  )
  writeFileSync(
    join(dir, 'build-report.json'),
    `${JSON.stringify({ ok: true, verify: { results: [{ check: 'one_page', passed: true, hard: true }], warnings: 0 }, render: { pages: 1 }, style_warnings: [] }, null, 2)}\n`
  )
  // build.py --jd <saved path> copies the posting into the folder; the model never retypes it.
  writeFileSync(join(dir, 'job-description.md'), j.jdPath && existsSync(j.jdPath) ? readFileSync(j.jdPath) : `# ${j.role} at ${j.company}\n`)
  // build.py --notes tailoring-notes.md: the notes Review reads (resume-tailor notes v2).
  writeFileSync(
    join(dir, 'tailoring-notes.md'),
    [
      '# Tailoring notes',
      '<!-- resume-tailor notes v2 -->',
      '',
      '## Direct hits',
      '- TypeScript: five years of TypeScript in the master profile',
      '',
      '## Reframings used',
      '### Platform ownership',
      `- Source fact: ${FACT}`,
      `- Wording: ${wording}`,
      '',
      '## Gaps left open',
      '- Kubernetes: nothing in the profile',
      '',
      '## Decisions',
      '- Right-aligned dates: a human reads it first.',
      ''
    ].join('\n')
  )
  return dir
}

const FILES = 'resume.pdf, resume_data.json, build-report.json, job-description.md, tailoring-notes.md'

/** The build step: one Bash call, the folder, the closing message with its path. */
async function buildTurn(started, opening) {
  protocol.text(opening)
  await pause()
  protocol.tool(
    'Bash',
    { command: `python3 ${skillDir()}/scripts/build.py resume_data.json --jd ${job.jdPath ?? 'job-description.md'} --notes tailoring-notes.md`, description: 'Build the resume PDF' },
    'build.py: resume.pdf written (1 page)'
  )
  const dir = build(job)
  await pause()
  protocol.text(`Done. The application folder is ${dir} and it contains ${FILES}.`)
  mark({ event: 'turn-end', turn })
  protocol.result(`Built ${dir}`, Date.now() - started)
}

/** A missing prerequisite (`ask`): the turn ends with a question. */
function askTurn(started) {
  const question = 'I cannot find the job requirements I need in the saved posting. Which role should I tailor for?'
  protocol.text(question)
  mark({ event: 'turn-end', turn })
  protocol.result(question, Date.now() - started)
}

async function runTurn(text) {
  turn++
  const started = Date.now()
  mark({ event: 'turn-start', turn })
  if (!job) {
    job = parseJob(text)
    rememberJob(job)
  }
  readRules(text)
  await pause()
  if (turn === 1 && !resume) {
    protocol.text(`Gap analysis for ${job.role} at ${job.company} (job ${job.jobId}): reading the master profile first.`)
    if (script === 'fail') protocol.fail()
    await pause()
    protocol.tool('Read', { file_path: join(process.cwd(), 'master-profile.md') }, 'profile text')
    await pause()
    if (script === 'ask') return askTurn(started)
    return buildTurn(started, 'Bridges chosen and listed in tailoring-notes.md. Building the application folder now.')
  }
  protocol.text(`Noted: ${text.slice(0, 80)}`)
  if (script === 'fail') protocol.fail()
  await pause()
  // The pipeline's one nudge gets the same question; the user's own answer builds.
  if (script === 'ask' && /^Nobody can answer/.test(text)) return askTurn(started)
  return buildTurn(started, 'Rebuilding the application folder with that change.')
}

/** Where the app told the agent the skill is (only for the Bash step's command line). */
function skillDir() {
  const i = args.indexOf('--add-dir')
  if (agent === 'agy' && i >= 0) return args[i + 1]
  const read = args.find((a) => a.startsWith('Read(/'))
  return read ? read.slice('Read(/'.length).replace(/\/\*\*\)$/, '') : `${process.env.HOME}/.claude/skills/resume-tailor`
}

// --- input ---------------------------------------------------------------------------------

if (agent === 'codex') {
  // One turn per process: the whole prompt until stdin closes.
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  await runTurn(text)
  process.exit(0)
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    process.stderr.write('fake agent: stdin is not JSON\n')
    process.exit(2)
  }
  if (agent === 'agy' && msg.event !== 'user') {
    process.stderr.write('error: stream input message is missing the "event" field\n')
    process.exit(2)
  }
  if (agent === 'claude' && msg.type !== 'user') {
    process.stderr.write('error: expected a user message\n')
    process.exit(2)
  }
  const content = msg.message?.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : ''
  await runTurn(text)
}
// stdin closed: the conversation is over.
process.exit(0)
