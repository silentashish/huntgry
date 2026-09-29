import { opendir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { JobText } from '@shared/knowledge-graph'
import { APPLICATION_DEPTH, IGNORED_ENTRIES, MAX_SCAN_ENTRIES } from '../workspace/constants'

/** Longest job description read for the overlay; postings are far shorter. */
const MAX_JD_BYTES = 256 * 1024

/**
 * Reads `<role>/<company>/<job-id>/job-description.md` from every application
 * folder (bounded, hidden folders and symlinks skipped). Title = first heading
 * or line. Unreadable files are skipped.
 */
export async function readJobDescriptions(workspace: string): Promise<JobText[]> {
  const out: JobText[] = []
  let visited = 0
  async function walk(dir: string, depth: number): Promise<void> {
    let handle
    try {
      handle = await opendir(dir)
    } catch {
      return
    }
    const subdirs: string[] = []
    for await (const e of handle) {
      if (++visited > MAX_SCAN_ENTRIES) break
      if (IGNORED_ENTRIES.has(e.name) || e.name.startsWith('.')) continue
      if (depth === APPLICATION_DEPTH) {
        if (e.isFile() && e.name === 'job-description.md') {
          try {
            const text = (await readFile(join(dir, e.name), 'utf8')).slice(0, MAX_JD_BYTES)
            const id = relative(workspace, dir).split(sep).join('/')
            const first =
              text
                .split('\n')
                .map((l) => l.trim())
                .find(Boolean) ?? id
            out.push({
              id,
              title: first
                .replace(/^#+\s*/, '')
                .replace(/[*_`]/g, '')
                .slice(0, 120),
              text
            })
          } catch {
            // skip unreadable
          }
        }
      } else if (e.isDirectory()) {
        subdirs.push(join(dir, e.name))
      }
    }
    for (const sub of subdirs) await walk(sub, depth + 1)
  }
  await walk(workspace, 0)
  return out.sort((a, b) => a.id.localeCompare(b.id))
}
