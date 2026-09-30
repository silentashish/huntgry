import { cp, lstat, mkdir, readlink, realpath, rm, stat, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AgentId } from '@shared/runner-types'
import { SKILL_NAME } from '../../workspace/constants'
import { findSkillDir, skillSearchRoots } from '../env'
import { adapterFor } from './index'

/**
 * Whether an agent can see the resume-tailor skill, and making it visible.
 * Claude finds it anywhere below ~/.claude/skills (synced copies included);
 * Codex and Antigravity only load `<root>/resume-tailor/SKILL.md` directly
 * under their skill roots, so Huntgry links the Claude copy there. Pure fs:
 * `home` is a parameter so tests use a temp folder.
 */

export interface SkillStatus {
  /** The resume-tailor folder the agent loads, or `null`. */
  path: string | null
  /** Where `installAgentSkill` puts it. */
  target: string
}

async function hasSkillMd(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, 'SKILL.md'))).isFile()
  } catch {
    return false
  }
}

export async function skillStatus(agent: AgentId, home: string): Promise<SkillStatus> {
  const roots = adapterFor(agent).skillRoots(home)
  const target = join(roots[0], SKILL_NAME)
  if (agent === 'claude') return { path: await findSkillDir(skillSearchRoots(home)), target }
  for (const root of roots) {
    const dir = join(root, SKILL_NAME)
    if (await hasSkillMd(dir)) return { path: dir, target }
  }
  return { path: null, target }
}

export interface LinkResult {
  ok: boolean
  path?: string
  /** `link` = a symlink to the Claude copy; `copy` when a link could not be made. */
  how?: 'link' | 'copy' | 'present'
  error?: string
}

/**
 * Makes the Claude copy of the skill (`source`) visible to `agent`: a symlink
 * `<first root>/resume-tailor → source` (one copy to update), or a recursive
 * copy when the link cannot be created. Never replaces a folder it did not
 * make: an existing real folder without SKILL.md is left alone with an error;
 * a dangling link of ours is replaced.
 */
export async function installAgentSkill(
  agent: AgentId,
  source: string | null,
  home: string,
  opts: { symlink?: typeof symlink } = {}
): Promise<LinkResult> {
  if (agent === 'claude') return { ok: false, error: 'Use "Install resume-tailor skill" for Claude.' }
  if (!source || !(await hasSkillMd(source)))
    return { ok: false, error: 'Install the resume-tailor skill for Claude first; the other agents use that copy.' }
  const current = await skillStatus(agent, home)
  if (current.path) return { ok: true, path: current.path, how: 'present' }

  const target = current.target
  const existing = await lstat(target).catch(() => null)
  if (existing) {
    if (!existing.isSymbolicLink())
      return { ok: false, error: `${target} already exists and is not the skill. Move it away, then try again.` }
    // A link whose target is gone (e.g. the Claude copy was reinstalled elsewhere): replace it.
    const to = resolve(dirname(target), await readlink(target))
    if (await hasSkillMd(to)) return { ok: true, path: target, how: 'present' }
    await rm(target, { force: true })
  }
  await mkdir(dirname(target), { recursive: true })
  const real = await realpath(source).catch(() => source)
  try {
    await (opts.symlink ?? symlink)(real, target, 'dir')
    return { ok: true, path: target, how: 'link' }
  } catch {
    try {
      await cp(real, target, { recursive: true, dereference: true, errorOnExist: true, force: false })
      return { ok: true, path: target, how: 'copy' }
    } catch (err) {
      return { ok: false, error: `Could not install the skill for ${agent}: ${(err as Error).message}` }
    }
  }
}
