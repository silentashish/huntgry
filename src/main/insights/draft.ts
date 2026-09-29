import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DraftRequest, EvidenceDraft } from '@shared/insights-types'
import type { MasterProfile } from '@shared/master-profile'
import { unsupportedNumbers } from '@shared/profile-insights'

/**
 * Asks Claude to word one resume bullet from the user's own notes about a
 * skill. One-shot, no tools, no settings or MCP servers, no saved session,
 * in an empty folder: it can only return text. Nothing is written here; the
 * user reviews the bullet and saves it through the profile editor path.
 */

const TIMEOUT_MS = 120_000
const SCHEMA = {
  type: 'object',
  properties: { bullet: { type: 'string', maxLength: 240 } },
  required: ['bullet'],
  additionalProperties: false
}

const SYSTEM_PROMPT = `You word one bullet for a master resume profile, from the person's own notes.
Rules, in order of importance:
1. Honesty: use only facts in the notes. Never add numbers, scale, tools, outcomes or seniority the notes do not state. If the notes are vague, the bullet stays modest.
2. Lead with what was done or achieved, name the technology, plain speech, one sentence, at most 200 characters.
3. No "responsible for", no em dashes, no adjectives doing the work a fact should do.
Return only the JSON object.`

/** The entry the bullet belongs to, for context: "Engineer at Orbital (2022 - Present)". */
export function targetLabel(profile: MasterProfile, target: DraftRequest['target']): string {
  if (target.kind === 'experience') {
    const e = profile.experience[target.index]
    if (!e) throw new Error('That experience is no longer in the profile.')
    return `${[e.role, e.company].filter(Boolean).join(' at ')} (${[e.start, e.end].filter(Boolean).join(' - ')})`
  }
  if (target.kind === 'project') {
    const p = profile.projects[target.index]
    if (!p) throw new Error('That project is no longer in the profile.')
    return `the project ${p.name}`
  }
  return 'the skills list'
}

export function draftPrompt(req: DraftRequest, label: string): string {
  return `Skill: ${req.skill}\nWhere: ${label}\nThe person's notes about how they used it:\n"""\n${req.notes.trim()}\n"""`
}

export function draftArgs(): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--permission-prompts',
    'none',
    '--json-schema',
    JSON.stringify(SCHEMA),
    '--system-prompt',
    SYSTEM_PROMPT
  ]
}

/** Reads the bullet out of `claude -p --output-format json` output. */
export function parseDraftOutput(stdout: string): { bullet: string; costUsd: number } {
  let parsed: { is_error?: boolean; result?: string; structured_output?: { bullet?: unknown }; total_cost_usd?: number }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error('Claude returned something unexpected. Try again.')
  }
  if (parsed.is_error) throw new Error(`Claude could not draft a bullet: ${String(parsed.result ?? 'unknown error')}`)
  const bullet = typeof parsed.structured_output?.bullet === 'string' ? parsed.structured_output.bullet.trim() : ''
  if (!bullet) throw new Error('Claude returned an empty bullet. Add more detail to your notes.')
  return { bullet, costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0 }
}

export async function draftEvidence(
  req: DraftRequest,
  profile: MasterProfile,
  claude: { command: string; env: NodeJS.ProcessEnv }
): Promise<EvidenceDraft> {
  if (req.notes.trim().length < 10) throw new Error('Describe what you did with it in a sentence or two first.')
  const label = targetLabel(profile, req.target)
  const cwd = await mkdtemp(join(tmpdir(), 'huntgry-draft-'))
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        claude.command,
        draftArgs(),
        { cwd, env: claude.env, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (err, out, errOut) => {
          if (err && !out) reject(new Error(`claude failed: ${(errOut || err.message).trim().slice(0, 300)}`))
          else resolve(out)
        }
      )
      child.stdin?.end(draftPrompt(req, label))
    })
    const { bullet, costUsd } = parseDraftOutput(stdout)
    return { bullet, unsupportedNumbers: unsupportedNumbers(bullet, req.notes), costUsd }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}
