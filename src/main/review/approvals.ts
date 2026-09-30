import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APPROVALS_PROMPT_CAP, type StandingApproval } from '@shared/review-types'
import { HUNTGRY_DIR } from '../workspace/constants'
import { normalizeText, reframingId } from './notes'

/**
 * `<workspace>/.huntgry/approved-reframings.json`: the reframings the user
 * approved on the Review page, which later unattended runs may reuse as they
 * are. Pure fs; only the review service (desktop) and #42's gateway write it,
 * and only with source-fact → wording pairs read from disk, never free text.
 */

export const APPROVALS_FILE = 'approved-reframings.json'
const VERSION = 1

export const approvalsFile = (workspace: string): string => join(workspace, HUNTGRY_DIR, APPROVALS_FILE)

const HEX64 = /^[0-9a-f]{64}$/

function valid(v: unknown): v is StandingApproval {
  const o = v as Record<string, unknown>
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof o.id === 'string' &&
    HEX64.test(o.id) &&
    typeof o.sourceFact === 'string' &&
    typeof o.wording === 'string' &&
    typeof o.approvedAt === 'string' &&
    typeof o.applicationId === 'string' &&
    typeof o.runId === 'string' &&
    typeof o.via === 'string'
  )
}

/** Newest first. A missing or broken file reads as empty. */
export async function loadApprovals(workspace: string): Promise<StandingApproval[]> {
  let raw: { version?: unknown; approvals?: unknown }
  try {
    raw = JSON.parse(await readFile(approvalsFile(workspace), 'utf8'))
  } catch {
    return []
  }
  const list = Array.isArray(raw.approvals) ? raw.approvals.filter(valid) : []
  return list.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt))
}

const saving = new Map<string, Promise<void>>()

/** Serialises writes per workspace: read-merge-write, temp file + rename. */
function write(workspace: string, update: (list: StandingApproval[]) => StandingApproval[]): Promise<StandingApproval[]> {
  const previous = saving.get(workspace) ?? Promise.resolve()
  let result: StandingApproval[] = []
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      const next = update(await loadApprovals(workspace)).sort((a, b) => b.approvedAt.localeCompare(a.approvedAt))
      const file = approvalsFile(workspace)
      await mkdir(join(workspace, HUNTGRY_DIR), { recursive: true })
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(tmp, `${JSON.stringify({ version: VERSION, approvals: next }, null, 2)}\n`, 'utf8')
      await rename(tmp, file)
      result = next
    })
  const tail = run.catch(() => undefined)
  saving.set(workspace, tail)
  void tail.then(() => {
    if (saving.get(workspace) === tail) saving.delete(workspace)
  })
  return run.then(() => result)
}

/** Adds entries (id recomputed from the pair; duplicates by id keep the older entry). */
export function addApprovals(
  workspace: string,
  entries: Omit<StandingApproval, 'id'>[]
): Promise<StandingApproval[]> {
  return write(workspace, (list) => {
    const known = new Set(list.map((a) => a.id))
    for (const e of entries) {
      const id = reframingId(e.sourceFact, e.wording)
      if (known.has(id)) continue
      known.add(id)
      list.push({ ...e, id, sourceFact: e.sourceFact.trim(), wording: e.wording.trim() })
    }
    return list
  })
}

export function removeApproval(workspace: string, id: string): Promise<StandingApproval[]> {
  return write(workspace, (list) => list.filter((a) => a.id !== id))
}

export function removeAllApprovals(workspace: string): Promise<StandingApproval[]> {
  return write(workspace, () => [])
}

/** The pairs an unattended run gets: newest first, capped by count and JSON size. `leftOut` = how many older ones are not sent. */
export function approvalsForPrompt(list: StandingApproval[]): {
  sent: { sourceFact: string; wording: string }[]
  leftOut: number
} {
  const sorted = [...list].sort((a, b) => b.approvedAt.localeCompare(a.approvedAt))
  const sent: { sourceFact: string; wording: string }[] = []
  let bytes = 2
  for (const a of sorted) {
    if (sent.length >= APPROVALS_PROMPT_CAP.entries) break
    const pair = { sourceFact: normalizeText(a.sourceFact), wording: normalizeText(a.wording) }
    const size = Buffer.byteLength(JSON.stringify(pair)) + 1
    if (bytes + size > APPROVALS_PROMPT_CAP.bytes) break
    bytes += size
    sent.push(pair)
  }
  return { sent, leftOut: sorted.length - sent.length }
}

export function requireApprovalId(id: unknown): string {
  if (typeof id !== 'string' || !HEX64.test(id)) throw new Error('Invalid approval id.')
  return id
}
