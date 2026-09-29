import type { StartRunParams } from '@shared/runner-types'

/**
 * The `claude` command line and prompts for a tailoring run. Main builds all
 * of it; the renderer only sends the form fields.
 */

/** The skill's entry points, the only Python Claude may run. */
export const SKILL_SCRIPTS = ['build.py', 'preflight.py', 'verify.py', 'render.py', 'render_docx.py'] as const

/**
 * Tools the skill may use without asking. Everything else is refused
 * (`--permission-prompts none`): a headless run has nobody to answer a
 * permission prompt.
 *
 * - File edits are not listed: `acceptEdits` auto-approves them inside the
 *   working directory (the workspace) only, so Claude cannot write elsewhere,
 *   including into the skill's own scripts.
 * - Python is limited to the skill's scripts by absolute path; no `python3 -c`
 *   or arbitrary scripts, since a job posting could carry a prompt injection.
 * - Shell access is otherwise read-only helpers the skill uses.
 */
export function allowedTools(skillDir: string): string[] {
  const scripts = SKILL_SCRIPTS.flatMap((script) => {
    const path = `${skillDir}/scripts/${script}`
    // Claude quotes a path with spaces; allow the quoted spelling too.
    return /\s/.test(path) ? [`Bash(python3 ${path}:*)`, `Bash(python3 "${path}":*)`] : [`Bash(python3 ${path}:*)`]
  })
  return [
    'Skill',
    'Read',
    'Glob',
    'Grep',
    'WebFetch',
    'WebSearch',
    'TodoWrite',
    ...scripts,
    'Bash(mkdir:*)',
    'Bash(ls:*)',
    'Bash(pdftotext:*)',
    'Bash(pdftoppm:*)',
    'Bash(pdfinfo:*)'
  ]
}

export interface ClaudeArgsOptions {
  skillDir: string
  /** Continue this Claude session (after an app restart or a finished process). */
  resumeSessionId?: string | null
  systemPrompt: string
  model?: string
}

export function buildClaudeArgs(opts: ClaudeArgsOptions): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    '--permission-prompts',
    'none',
    '--allowedTools',
    ...allowedTools(opts.skillDir),
    '--append-system-prompt',
    opts.systemPrompt
  ]
  if (opts.model) args.push('--model', opts.model)
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
  return args
}

/** Context every run gets on top of Claude Code's own system prompt. */
export function buildSystemPrompt(opts: { workspace: string; masterProfile: string; skillDir: string }): string {
  return [
    'You are running inside Huntgry, a desktop app around the resume-tailor skill.',
    'The user reads your messages in a chat panel and answers there; they cannot see tool output unless you summarise it.',
    `CV_HOME is already set in the environment to the workspace: ${opts.workspace}`,
    `The master profile is ${opts.workspace}/${opts.masterProfile}. It is the only source of facts about the user.`,
    `The resume-tailor skill is installed at ${opts.skillDir}. Run its scripts only as \`python3 ${opts.skillDir}/scripts/<script>.py …\` with that absolute path, from the workspace, one command per call (no cd, no &&, no environment-variable prefixes). python3, pdflatex and poppler are on PATH. Other shell commands, inline Python and writing files outside the workspace are blocked.`,
    'Follow the skill exactly, including its honesty rule and step 3: stop after the gap analysis, show the proposed reframings and bullets, and wait for the user to approve before writing resume_data.json.',
    'Keep role, company and job-id as short lowercase slugs so the output lands in CV_HOME/<role>/<company>/<job-id>/.',
    `Write draft payloads (resume_data.json, cover_data.json) under ${opts.workspace}/.huntgry/drafts/<role>-<company>-<job-id>/, not elsewhere in the workspace; build.py copies what it needs into the application folder.`,
    'When the build is done, end your message with the absolute path of the application folder and the files it contains.'
  ].join('\n')
}

/** The first message of a run: the job plus the user's choices, as the user would have typed them. */
export function buildFirstPrompt(params: StartRunParams): string {
  const lines = ['Use the resume-tailor skill to tailor my resume and cover letter for this job.', '']
  if (params.jobUrl) lines.push(`Job posting URL: ${params.jobUrl}`)
  if (params.company) lines.push(`Company: ${params.company}`)
  if (params.role) lines.push(`Role: ${params.role}`)
  if (params.jobId) lines.push(`Job id: ${params.jobId}`)
  lines.push(`Cover letter: ${params.coverLetter ? 'yes' : 'no, resume only'}`)
  lines.push(
    `Date style: ${params.dateStyle} (${params.dateStyle === 'inline' ? 'large-company ATS first' : 'a human reads it first'})`
  )
  if (params.notes?.trim()) lines.push('', 'Notes from me:', params.notes.trim())
  if (params.jobDescription?.trim()) {
    lines.push(
      '',
      'Job description (save it verbatim as job-description.md):',
      '',
      '<job_description>',
      params.jobDescription.trim(),
      '</job_description>'
    )
  } else if (params.jobUrl) {
    lines.push('', 'Fetch the posting from the URL above and save it verbatim as job-description.md.')
  }
  return lines.join('\n')
}

/** Short title for the run list, e.g. `Senior Engineer · Stripe`. */
export function runTitle(params: StartRunParams): string {
  const parts = [params.role, params.company].map((s) => s?.trim()).filter(Boolean)
  if (parts.length > 0) return parts.join(' · ')
  if (params.jobUrl) {
    try {
      return new URL(params.jobUrl).hostname.replace(/^www\./, '')
    } catch {
      // fall through
    }
  }
  const firstLine =
    params.jobDescription
      ?.trim()
      .split('\n')[0]
      ?.replace(/^#+\s*/, '') ?? ''
  return firstLine.slice(0, 60) || 'Untitled job'
}

/** Longest job description or reply accepted over IPC. */
export const MAX_TEXT = 200_000

function optionalText(v: unknown, field: string, max = 2000): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' || v.length > max) throw new Error(`Invalid ${field}.`)
  return v
}

/** Shape check of the Tailor form; IPC input is untrusted even from our renderer. */
export function requireStartParams(input: unknown): StartRunParams {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid run parameters.')
  const p = input as Record<string, unknown>
  const params: StartRunParams = {
    jobDescription: optionalText(p.jobDescription, 'job description', MAX_TEXT),
    jobUrl: optionalText(p.jobUrl, 'job URL'),
    company: optionalText(p.company, 'company', 200),
    role: optionalText(p.role, 'role', 200),
    jobId: optionalText(p.jobId, 'job id', 200),
    notes: optionalText(p.notes, 'notes', 20_000),
    coverLetter: p.coverLetter === true,
    dateStyle: p.dateStyle === 'inline' ? 'inline' : 'right'
  }
  if (params.jobUrl && !/^https?:\/\//i.test(params.jobUrl))
    throw new Error('The job URL must start with http:// or https://.')
  if (!params.jobDescription?.trim() && !params.jobUrl)
    throw new Error('Paste a job description or enter the posting URL.')
  return params
}

/** One stream-json user message on stdin. */
export function userMessageLine(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`
}
