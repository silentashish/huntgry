import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RULES_PROMPT_CAP, type ReframingRule } from '@shared/review-types'
import type { CallerRules, CallerWording } from '../cli/command'
import { authorityDir, serialized, writeAuthorityFile } from './authority'
import { normalizeText, reframingId } from './notes'

/**
 * The reframing rules (#159): the source fact → wording pairs the user kept (preferred) or
 * rejected on the Review page, which every later run gets as caller rules. Kept in the review
 * authority folder under the app's userData (`authority.ts`), never in the workspace, which every
 * agent can write: a file an agent wrote there is not a rule. Only the review service (desktop)
 * and #42's gateway write it, and only with pairs read from disk; the one piece of user text is a
 * rejection's better wording, typed by the user on the Review page or the phone.
 *
 * Before #159 the store held standing approvals only (`approvals.json`, version 1). The first read
 * without a rules file takes them over as preferred rules; `approvals.json` is left as it was, so
 * an older Huntgry still finds its approvals after a rollback.
 */

export const RULES_FILE = 'reframing-rules.json'
const VERSION = 1
/** The pre-#159 store: `{ version: 1, approvals: StandingApproval[] }`. Read for the migration only. */
export const LEGACY_APPROVALS_FILE = 'approvals.json'

export const rulesFile = (workspace: string): string => join(authorityDir(workspace), RULES_FILE)
export const legacyApprovalsFile = (workspace: string): string => join(authorityDir(workspace), LEGACY_APPROVALS_FILE)

const HEX64 = /^[0-9a-f]{64}$/

const byNewest = (a: ReframingRule, b: ReframingRule) => b.at.localeCompare(a.at)

function common(o: Record<string, unknown>): boolean {
  return (
    typeof o.id === 'string' &&
    HEX64.test(o.id) &&
    typeof o.sourceFact === 'string' &&
    typeof o.wording === 'string' &&
    typeof o.applicationId === 'string' &&
    typeof o.runId === 'string' &&
    typeof o.via === 'string' &&
    (o.requirement === undefined || typeof o.requirement === 'string')
  )
}

function validRule(v: unknown): v is ReframingRule {
  const o = v as Record<string, unknown>
  return (
    typeof o === 'object' &&
    o !== null &&
    common(o) &&
    (o.kind === 'preferred' || o.kind === 'rejected') &&
    typeof o.at === 'string' &&
    (o.betterWording === undefined || (o.kind === 'rejected' && typeof o.betterWording === 'string'))
  )
}

/** A pre-#159 standing approval as a preferred rule; `null` when the entry is malformed. */
function fromApproval(v: unknown): ReframingRule | null {
  const o = v as Record<string, unknown>
  if (typeof o !== 'object' || o === null || !common(o) || typeof o.approvedAt !== 'string') return null
  return {
    id: o.id as string,
    kind: 'preferred',
    sourceFact: o.sourceFact as string,
    wording: o.wording as string,
    ...(typeof o.requirement === 'string' ? { requirement: o.requirement } : {}),
    at: o.approvedAt,
    applicationId: o.applicationId as string,
    runId: o.runId as string,
    via: o.via as ReframingRule['via']
  }
}

async function readJson(file: string): Promise<{ missing: true } | { missing: false; value: unknown }> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true }
    return { missing: false, value: null }
  }
  try {
    return { missing: false, value: JSON.parse(text) }
  } catch {
    return { missing: false, value: null }
  }
}

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** The standing approvals of the pre-#159 store, as preferred rules (empty when there is none or it is broken). */
async function legacyRules(workspace: string): Promise<ReframingRule[]> {
  const file = await readJson(legacyApprovalsFile(workspace))
  const root = file.missing ? null : record(file.value)
  if (!root || root.version !== 1 || !Array.isArray(root.approvals)) return []
  return root.approvals.map(fromApproval).filter((r): r is ReframingRule => r !== null)
}

/**
 * Newest first. No rules file yet: the pre-#159 standing approvals, as preferred rules. A broken
 * rules file (invalid JSON, a non-object root, another version) reads as empty.
 */
export async function loadRules(workspace: string): Promise<ReframingRule[]> {
  const file = await readJson(rulesFile(workspace))
  if (file.missing) return (await legacyRules(workspace)).sort(byNewest)
  const root = record(file.value)
  if (!root || root.version !== VERSION || !Array.isArray(root.rules)) return []
  return root.rules.filter(validRule).sort(byNewest)
}

/** A decision about one pair, as the review service makes it (the id is recomputed from the pair). */
export type RuleEntry = Omit<ReframingRule, 'id'>

/**
 * `list` with `entries` applied, newest first. One rule per pair: a rejection replaces whatever
 * stood for the pair, a preferred wording replaces a rejection, and a preferred wording already
 * kept stays as it was (the older entry).
 */
export function mergeRules(list: readonly ReframingRule[], entries: readonly RuleEntry[]): ReframingRule[] {
  const byId = new Map(list.map((r) => [r.id, r]))
  for (const e of entries) {
    const id = reframingId(e.sourceFact, e.wording)
    const current = byId.get(id)
    if (current && e.kind === 'preferred' && current.kind === 'preferred') continue
    const betterWording = e.kind === 'rejected' ? e.betterWording?.trim() || undefined : undefined
    const { betterWording: _, ...rest } = e
    byId.set(id, { ...rest, id, sourceFact: e.sourceFact.trim(), wording: e.wording.trim(), ...(betterWording ? { betterWording } : {}) })
  }
  return [...byId.values()].sort(byNewest)
}

/** Read-merge-write, serialised with every other write of the workspace's authority store. */
function write(workspace: string, update: (list: ReframingRule[]) => ReframingRule[]): Promise<ReframingRule[]> {
  return serialized(workspace, async () => {
    const next = update(await loadRules(workspace)).sort(byNewest)
    await writeAuthorityFile(workspace, RULES_FILE, { version: VERSION, rules: next })
    return next
  })
}

export function addRules(workspace: string, entries: RuleEntry[]): Promise<ReframingRule[]> {
  return write(workspace, (list) => mergeRules(list, entries))
}

export function removeRule(workspace: string, id: string): Promise<ReframingRule[]> {
  return write(workspace, (list) => list.filter((r) => r.id !== id))
}

export function removeAllRules(workspace: string): Promise<ReframingRule[]> {
  return write(workspace, () => [])
}

/**
 * The caller rules a run gets: newest first, capped by count and JSON size (preferred and avoid
 * together). A rejected rule sends its wording to `avoid` and its better wording, if any, to
 * `preferred` for the same fact. A wording is decided once, by the newest rule that names it, so
 * it is never both preferred and avoided: rejecting A with B and later rejecting B (with C or
 * nothing) sends B to `avoid` only. `leftOut` = how many older rules are not sent.
 */
export function rulesForPrompt(list: readonly ReframingRule[]): CallerRules & { leftOut: number } {
  const sorted = [...list].sort(byNewest)
  const preferred: CallerWording[] = []
  const avoid: CallerWording[] = []
  /** `fact \n wording` pairs a newer rule already decided. */
  const decided = new Set<string>()
  const keyOf = (w: CallerWording) => `${w.sourceFact}\n${w.wording}`
  let entries = 0
  let bytes = 4
  let sent = 0
  for (const r of sorted) {
    const sourceFact = normalizeText(r.sourceFact)
    const candidates: [CallerWording[], CallerWording][] =
      r.kind === 'preferred'
        ? [[preferred, { sourceFact, wording: normalizeText(r.wording) }]]
        : [
            [avoid, { sourceFact, wording: normalizeText(r.wording) }],
            ...(r.betterWording ? [[preferred, { sourceFact, wording: normalizeText(r.betterWording) }] as [CallerWording[], CallerWording]] : [])
          ]
    const pairs = candidates.filter(([, pair]) => !decided.has(keyOf(pair)))
    const size = pairs.reduce((n, [, pair]) => n + Buffer.byteLength(JSON.stringify(pair)) + 1, 0)
    if (entries + pairs.length > RULES_PROMPT_CAP.entries || bytes + size > RULES_PROMPT_CAP.bytes) break
    entries += pairs.length
    bytes += size
    sent++
    for (const [into, pair] of pairs) {
      into.push(pair)
      decided.add(keyOf(pair))
    }
  }
  return { preferred, avoid, leftOut: sorted.length - sent }
}

export function requireRuleId(id: unknown): string {
  if (typeof id !== 'string' || !HEX64.test(id)) throw new Error('Invalid rule id.')
  return id
}
