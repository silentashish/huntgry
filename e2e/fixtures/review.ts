import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Unattended results (#31) as the pipeline leaves them: the application folder
 * the agent built, and the review state main records in its authority store
 * under userData (`<userData>/review/<sha256(workspace)[0..32]>/reviews.json`),
 * never in the workspace.
 */

/** A built result: job description, resume, a passing build report, review notes and tracking. */
export async function seedResult(workspace: string, folder: string, job: { role: string; company: string; runId: string }): Promise<void> {
  const dir = join(workspace, ...folder.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'job-description.md'), `# ${job.role}\n\n${job.company} is hiring.\nhttps://jobs.example.com/${folder.split('/').at(-1)}\n`)
  await writeFile(join(dir, 'resume.pdf'), '%PDF-1.4 e2e')
  await writeFile(join(dir, 'build-report.json'), '{"ok": true}')
  await writeFile(
    join(dir, 'review-notes.md'),
    `# Review notes\n<!-- huntgry-review v1 · run ${job.runId} · unattended -->\n\n## Used standing approvals\nNone.\n\n## Proposed reframings (not used)\nNone.\n\n## Open gaps\nNone.\n\n## Notes\nSeeded by e2e.\n`
  )
  await writeFile(join(dir, 'huntgry.json'), JSON.stringify({ status: 'generated', notes: '' }, null, 2))
}

/** Records review states the way main does (folder → state, run, time). */
export async function seedReviews(userData: string, workspace: string, reviews: Record<string, { state: string; runId: string }>): Promise<void> {
  const dir = join(userData, 'review', createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 32))
  await mkdir(dir, { recursive: true })
  const at = '2026-10-05T06:00:00.000Z'
  const out = Object.fromEntries(Object.entries(reviews).map(([folder, r]) => [folder, { ...r, at }]))
  await writeFile(join(dir, 'reviews.json'), JSON.stringify({ version: 1, reviews: out }, null, 2))
}
