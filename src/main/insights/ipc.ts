import { app, ipcMain } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { INSIGHTS_CHANNELS, type DraftRequest, type EvidenceTarget, type ProfileInsights } from '@shared/insights-types'
import { computeGaps, emptySections } from '@shared/profile-insights'
import { requireCurrentWorkspace } from '../current-workspace'
import { buildChildEnv, loginShellPath } from '../cli/env'
import { discoverRuntime } from '../cli/environment'
import { readProfile } from '../profile/store'
import { draftEvidence } from './draft'
import { collectJobTexts } from './jobs'
import { dismissGap, readDismissed, restoreGap } from './store'

async function insights(): Promise<ProfileInsights> {
  const ws = await requireCurrentWorkspace()
  const profilePath = join(ws.path, ws.masterProfile)
  const [doc, jobs, dismissed, info] = await Promise.all([
    readProfile(profilePath),
    collectJobTexts(ws.path),
    readDismissed(ws.path),
    stat(profilePath).catch(() => null)
  ])
  const { gaps, noted } = computeGaps(doc.profile, jobs, new Set(dismissed.map((d) => d.key)))
  return {
    gaps,
    dismissed,
    noted,
    jobCount: jobs.length,
    profile: { updatedAt: info ? info.mtime.toISOString() : null, emptySections: emptySections(doc.profile) }
  }
}

function requireText(input: unknown, what: string, max: number): string {
  if (typeof input !== 'string' || !input.trim() || input.length > max) throw new Error(`Invalid ${what}.`)
  return input.trim()
}

function requireTarget(input: unknown): EvidenceTarget {
  const t = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  if ((t.kind === 'experience' || t.kind === 'project') && Number.isInteger(t.index) && (t.index as number) >= 0)
    return { kind: t.kind, index: t.index as number }
  if (t.kind === 'skills' && typeof t.category === 'string') return { kind: 'skills', category: t.category.slice(0, 200) }
  throw new Error('Invalid profile entry.')
}

/** Gap insights and the Claude-drafted evidence bullet. Profile changes go through `profile.save`. */
export function registerInsightsIpc(): void {
  ipcMain.handle(INSIGHTS_CHANNELS.get, () => insights())
  ipcMain.handle(INSIGHTS_CHANNELS.dismiss, async (_e, key: unknown, skill: unknown) => {
    await dismissGap((await requireCurrentWorkspace()).path, requireText(key, 'skill', 200), requireText(skill, 'skill', 200))
    return insights()
  })
  ipcMain.handle(INSIGHTS_CHANNELS.restore, async (_e, key: unknown) => {
    await restoreGap((await requireCurrentWorkspace()).path, requireText(key, 'skill', 200))
    return insights()
  })
  ipcMain.handle(INSIGHTS_CHANNELS.draft, async (_e, input: unknown) => {
    const r = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
    const req: DraftRequest = {
      skill: requireText(r.skill, 'skill', 200),
      target: requireTarget(r.target),
      notes: requireText(r.notes, 'notes', 4000)
    }
    const ws = await requireCurrentWorkspace()
    const [doc, runtime, loginPath] = await Promise.all([
      readProfile(join(ws.path, ws.masterProfile)),
      discoverRuntime(),
      loginShellPath()
    ])
    if (!runtime.claudePath) throw new Error('The claude CLI was not found. See Settings.')
    const env = buildChildEnv({
      base: process.env,
      workspace: ws.path,
      venvDir: join(app.getPath('userData'), 'skill-venv'),
      texBin: null,
      loginPath
    })
    return draftEvidence(req, doc.profile, { command: runtime.claudePath, env })
  })
}
