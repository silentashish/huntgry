import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DismissedGap } from '@shared/insights-types'
import { HUNTGRY_DIR } from '../workspace/constants'

/**
 * `<workspace>/.huntgry/profile-insights.json`: gaps the user said they do not
 * have. Small, rewritten whole, atomically (temp file + rename), one write at a
 * time per workspace.
 */

interface InsightsFile {
  dismissed: DismissedGap[]
}

const fileOf = (workspace: string) => join(workspace, HUNTGRY_DIR, 'profile-insights.json')
const locks = new Map<string, Promise<unknown>>()

/** Dismissed gaps; a missing or corrupt file means none. */
export async function readDismissed(workspace: string): Promise<DismissedGap[]> {
  try {
    const parsed = JSON.parse(await readFile(fileOf(workspace), 'utf8')) as Partial<InsightsFile>
    return Array.isArray(parsed.dismissed)
      ? parsed.dismissed.filter(
          (d): d is DismissedGap =>
            typeof d === 'object' && d !== null && typeof d.key === 'string' && typeof d.skill === 'string'
        )
      : []
  } catch {
    return []
  }
}

function update(workspace: string, change: (list: DismissedGap[]) => DismissedGap[]): Promise<DismissedGap[]> {
  const run = (locks.get(workspace) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const next = change(await readDismissed(workspace))
      await mkdir(join(workspace, HUNTGRY_DIR), { recursive: true })
      const file = fileOf(workspace)
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, `${JSON.stringify({ dismissed: next } satisfies InsightsFile, null, 2)}\n`, 'utf8')
      await rename(tmp, file)
      return next
    })
  locks.set(workspace, run)
  return run
}

export function dismissGap(workspace: string, key: string, skill: string, now = new Date()): Promise<DismissedGap[]> {
  return update(workspace, (list) => [
    ...list.filter((d) => d.key !== key),
    { key, skill, at: now.toISOString() }
  ])
}

export function restoreGap(workspace: string, key: string): Promise<DismissedGap[]> {
  return update(workspace, (list) => list.filter((d) => d.key !== key))
}
