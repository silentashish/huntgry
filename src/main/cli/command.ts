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
 * permission prompt, and a job posting could carry a prompt injection.
 *
 * - Files: reads and edits inside the working directory (the workspace) need
 *   no rule; the only extra read access is the skill folder. Nothing outside
 *   the workspace can be edited, including the skill's own scripts.
 * - Shell: only the skill's scripts, by absolute path (no `python3 -c`, no
 *   other commands), and every command runs in the OS sandbox from
 *   `buildSandboxSettings`.
 * - Network: WebFetch only to the job posting's host (`fetchHosts`); no
 *   WebSearch.
 */
export function allowedTools(skillDir: string, fetchHosts: readonly string[] = []): string[] {
  const scripts = SKILL_SCRIPTS.flatMap((script) => {
    const path = `${skillDir}/scripts/${script}`
    // Claude quotes a path with spaces; allow the quoted spelling too.
    return /\s/.test(path) ? [`Bash(python3 ${path}:*)`, `Bash(python3 "${path}":*)`] : [`Bash(python3 ${path}:*)`]
  })
  return [
    // Permission rules use `//` for an absolute path.
    `Read(/${skillDir}/**)`,
    // The network is limited to the posting's own site: an unrestricted fetch could
    // carry master-profile data to any host a prompt-injected posting names.
    ...fetchHosts.map((host) => `WebFetch(domain:${host})`),
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
  /** Hosts WebFetch may reach without asking: the job posting's site. */
  fetchHosts?: readonly string[]
  model?: string
}

/** The host of a job posting URL, for the WebFetch rule; `null` for anything but http(s). */
export function fetchHostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname : null
  } catch {
    return null
  }
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
    ...allowedTools(opts.skillDir, opts.fetchHosts),
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

/** Context every run gets on top of Claude Code's own system prompt. */
export function buildSystemPrompt(opts: { workspace: string; masterProfile: string; skillDir: string }): string {
  return [
    'You are running inside Huntgry, a desktop app around the resume-tailor skill.',
    'The user reads your messages in a chat panel and answers there; they cannot see tool output unless you summarise it.',
    `CV_HOME is already set in the environment to the workspace: ${opts.workspace}`,
    `The master profile is ${opts.workspace}/${opts.masterProfile}. It is the only source of facts about the user.`,
    `The resume-tailor skill is at ${opts.skillDir}: read ${opts.skillDir}/SKILL.md first and follow it (its references/ and assets/ are there too). Run its scripts only as \`python3 ${opts.skillDir}/scripts/<script>.py …\` with that absolute path, from the workspace, one command per call (no cd, no &&, no environment-variable prefixes). python3, pdflatex and poppler are on PATH. Other shell commands, inline Python, file access outside the workspace and web access beyond the job posting's site are blocked.`,
    'Follow the skill exactly, including its honesty rule and step 3: stop after the gap analysis, show the proposed reframings and bullets, and wait for the user to approve before writing resume_data.json.',
    'Keep role, company and job-id as short lowercase slugs so the output lands in CV_HOME/<role>/<company>/<job-id>/.',
    `Write draft payloads (resume_data.json, cover_data.json) under ${opts.workspace}/.huntgry/drafts/<role>-<company>-<job-id>/, not elsewhere in the workspace; build.py copies what it needs into the application folder.`,
    'When the build is done, end your message with the absolute path of the application folder and the files it contains.'
  ].join('\n')
}

/** The first message of a run: the job plus the user's choices, as the user would have typed them. */
export function buildFirstPrompt(params: StartRunParams): string {
  const lines = ['Follow the resume-tailor skill (SKILL.md) to tailor my resume and cover letter for this job.', '']
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
