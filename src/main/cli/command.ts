import { realpath } from 'node:fs/promises'
import { isAgentId, JOB_SOURCE_TAGS, type JobSourceTag, type StartRunParams } from '@shared/runner-types'
import { NOTES_V2_MARKER, TAILORING_NOTES_FILE } from '@shared/review-types'

/**
 * The `claude` command line and prompts for a tailoring run. Main builds all
 * of it; the renderer only sends the form fields.
 */

/** The skill's entry points, the only Python Claude may run. */
export const SKILL_SCRIPTS = ['build.py', 'preflight.py', 'verify.py', 'render.py', 'render_docx.py'] as const

/**
 * Tools the skill may use without asking. Everything else is refused: a
 * headless `-p` run has nobody to answer a permission prompt (Claude Code
 * ≥ 2.1.259 also gets `--permission-prompts none`, which tells Claude not to
 * retry), and a job posting could carry a prompt injection.
 *
 * - Files: reads and edits inside the working directory (the workspace) need
 *   no rule; the only extra read access is the skill folder. Nothing outside
 *   the workspace can be edited, including the skill's own scripts.
 * - Shell: only the skill's scripts, by absolute path (no `python3 -c`, no
 *   other commands), and every command runs in the OS sandbox from
 *   `buildSandboxSettings`.
 * - Network: none. Huntgry fetches the posting itself (`posting.ts`) and puts
 *   its text in the first message; any fetch tool, even one limited to the
 *   posting's host, would let a malicious posting receive profile data.
 */
export function allowedTools(skillDir: string): string[] {
  const scripts = SKILL_SCRIPTS.flatMap((script) => {
    const path = `${skillDir}/scripts/${script}`
    // Claude quotes a path with spaces; allow the quoted spelling too.
    return /\s/.test(path) ? [`Bash(python3 ${path}:*)`, `Bash(python3 "${path}":*)`] : [`Bash(python3 ${path}:*)`]
  })
  return [
    // Permission rules use `//` for an absolute path.
    `Read(/${skillDir}/**)`,
    'TodoWrite',
    ...scripts
  ]
}

export interface SandboxPaths {
  workspace: string
  skillDir: string
  venvDir: string
  /** TeX distribution root (e.g. `~/Library/TinyTeX`), or `null` when TeX is not found. */
  texRoot: string | null
  /** More readable paths, e.g. the real targets of symlinked ones. */
  extraRead?: string[]
}

/**
 * The skill folder and sandbox paths of a run, with the skill at its real path (#144). An account's
 * `skills` folder may be a symlink (e.g. `~/.claude-personal/skills → ~/.claude/skills`): Seatbelt
 * refuses a path through a link whose own node is not readable, and Claude Code matches a `Read`
 * rule against the resolved path, so the allowlist, the sandbox and the prompt all name the real one.
 * The sandbox still allows each given spelling next to its target (a symlinked venv, say).
 */
export async function resolveRunPaths(paths: {
  workspace: string
  skillDir: string
  venvDir: string
  texRoot: string | null
}): Promise<{ skillDir: string; sandbox: SandboxPaths }> {
  const real = (p: string) => realpath(p).catch(() => p)
  const skillDir = await real(paths.skillDir)
  const given = [paths.workspace, skillDir, paths.venvDir, ...(paths.texRoot ? [paths.texRoot] : [])]
  const extraRead = [...new Set((await Promise.all(given.map(async (p) => [p, await real(p)]))).flat())]
  return {
    skillDir,
    sandbox: { workspace: paths.workspace, skillDir, venvDir: paths.venvDir, texRoot: paths.texRoot, extraRead }
  }
}

/**
 * Claude Code's OS-level sandbox for the child's shell commands (Seatbelt on
 * macOS). Reads of the home folder are denied except the workspace, the skill,
 * the venv and TeX; writes stay in the workspace and the per-user temp folder.
 * It must start (`failIfUnavailable`) and commands cannot retry outside it,
 * so even an allowed script cannot read `~/.ssh` or copy a file in from
 * elsewhere. Commands still need the allowlist (`autoAllowBashIfSandboxed: false`).
 */
export function buildSandboxSettings(paths: SandboxPaths): Record<string, unknown> {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      filesystem: {
        denyRead: ['~/'],
        allowRead: [
          ...new Set([
            paths.workspace,
            paths.skillDir,
            paths.venvDir,
            ...(paths.texRoot ? [paths.texRoot] : []),
            ...(paths.extraRead ?? [])
          ])
        ]
      }
    }
  }
}

/** The TeX root for a bin folder: `…/TinyTeX/bin/universal-darwin` → `…/TinyTeX`; system folders need no entry. */
export function texRootOf(texBin: string | null): string | null {
  if (!texBin) return null
  const m = /^(.*\/(?:\.?TinyTeX|texlive\/\d{4}))\/bin\/[^/]+\/?$/.exec(texBin)
  return m ? m[1] : texBin.startsWith('/Library/TeX') || texBin.startsWith('/usr/') ? null : texBin
}

export interface ClaudeArgsOptions {
  skillDir: string
  /** Continue this Claude session (after an app restart or a finished process). */
  resumeSessionId?: string | null
  systemPrompt: string
  sandbox: SandboxPaths
  model?: string
  /**
   * Pass `--permission-prompts none`. Only Claude Code ≥ 2.1.259 knows the flag;
   * older versions exit with "unknown option". See `supportsPermissionPrompts`.
   */
  permissionPrompts?: boolean
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
    ...(opts.permissionPrompts ? ['--permission-prompts', 'none'] : []),
    '--allowedTools',
    ...allowedTools(opts.skillDir),
    // No user, project or local settings: their hooks and permission rules must not widen
    // (or rewrite) what this headless run may do. Everything it needs is passed here.
    '--setting-sources',
    '',
    '--settings',
    JSON.stringify(buildSandboxSettings(opts.sandbox)),
    '--append-system-prompt',
    opts.systemPrompt
  ]
  if (opts.model) args.push('--model', opts.model)
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
  return args
}

/** A wording with the master-profile fact it is about (a caller rule, see `CallerRules`). */
export interface CallerWording {
  sourceFact: string
  wording: string
}

/**
 * The user's earlier decisions, passed to every run as the skill's caller rules (#158, #159):
 * `preferred` are kept reframings and the better wordings of rejected ones (use as written),
 * `avoid` are reframings the user rejected (never use them or a close paraphrase). Both newest
 * first and already capped (`rulesForPrompt`).
 */
export interface CallerRules {
  preferred: CallerWording[]
  avoid: CallerWording[]
}

/** The notes file a run writes for Review (resume-tailor notes v2), described so a v4 skill writes it too. */
export const NOTES_V2_BLOCK = [
  `TAILORING NOTES. Before the payload, write ${TAILORING_NOTES_FILE} in the drafts folder in exactly this format (one line per entry, "None." under a section that has nothing), and pass it to build.py with --notes:`,
  '```markdown',
  '# Tailoring notes',
  NOTES_V2_MARKER,
  '',
  '## Direct hits',
  '- <requirement>: <profile evidence>',
  '',
  '## Reframings used',
  '### <requirement from the posting>',
  '- Source fact: <verbatim sentence or bullet from the master profile>',
  '- Wording: <as written in the resume>',
  '',
  '## Gaps left open',
  '- <requirement>: <why nothing honest fits>',
  '',
  '## Decisions',
  '- <date style and why, bullets cut or trimmed, judgement calls on honesty>',
  '```'
]

/** The caller-rules lines of the system prompt (the skill's "Caller rules"). */
export function callerRulesBlock(rules: CallerRules): string[] {
  return [
    "CALLER RULES (the user's earlier decisions). Preferred wordings: use each as written when its source fact is used. Wordings to avoid: never use them, or a close paraphrase of them, for that fact.",
    `PREFERRED WORDINGS (JSON, newest first): ${JSON.stringify(rules.preferred)}`,
    `WORDINGS TO AVOID (JSON, newest first): ${JSON.stringify(rules.avoid)}`
  ]
}

/**
 * Context every run gets on top of the agent's own system prompt. One flow (#158): nobody answers
 * during a run, so it follows the skill to the end, uses the bridges it can make honestly, lists
 * them in tailoring-notes.md v2, and the user checks the result on the Review page.
 */
export function buildSystemPrompt(opts: {
  workspace: string
  masterProfile: string
  skillDir: string
  rules?: CallerRules
}): string {
  const drafts = `${opts.workspace}/.huntgry/drafts/<role>-<company>-<job-id>/`
  return [
    'You are running inside Huntgry, a desktop app around the resume-tailor skill.',
    'The user reads your messages in a chat panel and may send a follow-up after the run; they cannot see tool output unless you summarise it.',
    `CV_HOME is already set in the environment to the workspace: ${opts.workspace}`,
    `The master profile is ${opts.workspace}/${opts.masterProfile}. It is the only source of facts about the user.`,
    `The resume-tailor skill is at ${opts.skillDir}: read ${opts.skillDir}/SKILL.md first and follow it (its references/ and assets/ are there too). Run its scripts only as \`python3 ${opts.skillDir}/scripts/<script>.py …\` with that absolute path, from the workspace, one command per call (no cd, no &&, no environment-variable prefixes). python3, pdflatex and poppler are on PATH. Other shell commands, inline Python, file access outside the workspace and web access are blocked; the job description is a saved file named in the first message.`,
    'Nobody answers during the run: run the skill to the end without asking and never end your turn with a question. Stop only when a prerequisite is missing (no master profile, no job description), and say which in one message.',
    'Follow the skill\'s honesty rule: use the bridges you can make from master-profile facts and list each one with its source fact; never fabricate an employer, title, degree, date, number or skill.',
    ...NOTES_V2_BLOCK,
    ...callerRulesBlock(opts.rules ?? { preferred: [], avoid: [] }),
    'Keep role, company and job-id as short lowercase slugs so the output lands in CV_HOME/<role>/<company>/<job-id>/.',
    `Write draft files (resume_data.json, cover_data.json, ${TAILORING_NOTES_FILE}) under ${drafts}, not elsewhere in the workspace; pass the saved job description to build.py with --jd <its path> and the notes with --notes, and build.py copies what it needs into the application folder.`,
    'If a hard check still fails after two rebuilds, stop and say which check fails.',
    'When the build is done, end your message with the absolute path of the application folder and the files it contains.'
  ].join('\n')
}

/**
 * The one reply an unattended run that ended its turn without building gets (#158): the pipeline sends
 * it once before asking the user, and the benchmark (#152) does the same so its runs match production.
 */
export const NUDGE_TEXT =
  'Nobody can answer. Follow the skill to the end now, in this turn: use the bridges you can make from master-profile facts and list each in tailoring-notes.md (never fabricate), build, verify, and end with the application folder.'

/**
 * The first message of a run: the job plus the user's choices, as the user would have typed them.
 * The job description is not in it: Huntgry saved it at `jobDescriptionPath` and the agent reads
 * it there (resume-tailor v5, step 1), so the model never retypes it.
 */
export function buildFirstPrompt(params: StartRunParams, jobDescriptionPath: string): string {
  const lines = ['Follow the resume-tailor skill (SKILL.md) to tailor my resume and cover letter for this job.', '']
  if (params.jobUrl) lines.push(`Job posting URL: ${params.jobUrl}`)
  if (params.company) lines.push(`Company: ${params.company}`)
  if (params.role) lines.push(`Role: ${params.role}`)
  if (params.jobId) lines.push(`Job id: ${params.jobId}`)
  lines.push(`Cover letter: ${params.coverLetter ? 'yes' : 'no, resume only'}`)
  lines.push(
    `Date style: ${params.dateStyle} (${params.dateStyle === 'inline' ? 'large-company ATS first' : 'a human reads it first'})`
  )
  lines.push(`Job description: saved at ${jobDescriptionPath}. Read it there and pass this path to build.py --jd; do not write it out again.`)
  if (params.notes?.trim()) lines.push('', 'Notes from me:', params.notes.trim())
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
    dateStyle: p.dateStyle === 'inline' ? 'inline' : 'right',
    source: (JOB_SOURCE_TAGS as readonly unknown[]).includes(p.source) ? (p.source as JobSourceTag) : undefined
  }
  if (p.agent !== undefined && p.agent !== null) {
    if (!isAgentId(p.agent)) throw new Error('Unknown agent.')
    params.agent = p.agent
  }
  // Every run is unattended now (#158); the flag is still recorded so older readers keep working.
  if (p.unattended === true) params.unattended = true
  if (typeof p.batchId === 'string' && /^b-[\w-]{1,80}$/.test(p.batchId)) params.batchId = p.batchId
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
