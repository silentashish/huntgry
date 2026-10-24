import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApplicationStatus } from '../../src/shared/applications-types'

/**
 * Many applications at once, for the Board's week groups (#160): each folder gets a
 * `job-description.md` (its title) and `huntgry.json` (status, notes, source). The scan takes an
 * application's last change from its files' mtimes (src/main/applications/scan.ts), so the job
 * description's mtime is set to `at`.
 */

export interface SeedApplication {
  /** `<role>/<company>/<job id>`, relative to the workspace. */
  folder: string
  title: string
  status: ApplicationStatus
  at: Date
  notes?: string
  source?: string
}

export async function seedApplications(workspace: string, apps: readonly SeedApplication[]): Promise<void> {
  for (const a of apps) {
    const dir = join(workspace, ...a.folder.split('/'))
    await mkdir(dir, { recursive: true })
    const jd = join(dir, 'job-description.md')
    await writeFile(jd, `# ${a.title}\n\nSeeded by e2e.\nhttps://jobs.example.com/${a.folder.split('/').at(-1)}\n`)
    await writeFile(
      join(dir, 'huntgry.json'),
      JSON.stringify({ status: a.status, notes: a.notes ?? '', ...(a.source ? { source: a.source } : {}) }, null, 2)
    )
    await utimes(jd, a.at, a.at)
  }
}

const DAY = 24 * 60 * 60 * 1000

/**
 * `count` Applied applications, `perWeek` a week going back from `now` (the first `perWeek` this
 * week, the next last week, …), titled "Applied role <n>" at "Company <n>".
 */
export function appliedBacklog(count: number, perWeek: number, now = new Date()): SeedApplication[] {
  return Array.from({ length: count }, (_, i) => {
    const week = Math.floor(i / perWeek)
    const n = String(i + 1).padStart(2, '0')
    // Spread inside the week without crossing into the next: a week's cards sit seconds apart.
    const offset = week === 0 ? (i % perWeek) * 1000 : week * 7 * DAY + (i % perWeek) * 1000
    return {
      folder: `backlog-engineer/company-${n}/backlog-${n}`,
      title: `Applied role ${n}`,
      status: 'applied',
      at: new Date(now.getTime() - offset)
    }
  })
}
