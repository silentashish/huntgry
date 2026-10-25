import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RULES_PROMPT_CAP } from '@shared/review-types'
import {
  addRules,
  legacyApprovalsFile,
  loadRules,
  mergeRules,
  removeAllRules,
  removeRule,
  rulesFile,
  rulesForPrompt,
  type RuleEntry
} from './approvals'
import { authorityDir, setReviewAuthorityRoot } from './authority'
import { reframingId } from './notes'

let ws: string
let authority: string
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-rules-'))
  authority = await mkdtemp(join(tmpdir(), 'huntgry-authority-'))
  setReviewAuthorityRoot(authority)
})
afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
  await rm(authority, { recursive: true, force: true })
})

const at = (n: number) => `2026-09-30T00:00:${String(n).padStart(2, '0')}.000Z`
const entry = (n: number, over: Partial<RuleEntry> = {}): RuleEntry => ({
  kind: 'preferred',
  sourceFact: `fact ${n}`,
  wording: `wording ${n}`,
  at: at(n),
  applicationId: 'r/c/1',
  runId: '20260930-000000-aaaaaa',
  via: 'desktop',
  ...over
})

/** A standing approval as the pre-#159 store (`approvals.json`, version 1) kept it. */
const approval = (n: number) => ({
  id: reframingId(`fact ${n}`, `wording ${n}`),
  sourceFact: `fact ${n}`,
  wording: `wording ${n}`,
  ...(n === 1 ? { requirement: 'Kafka' } : {}),
  approvedAt: at(n),
  applicationId: 'r/c/1',
  runId: '20260930-000000-aaaaaa',
  via: n === 2 ? 'phone:dev1' : 'desktop'
})

describe('reframing rules store', () => {
  it('adds with recomputed ids, dedupes by pair, sorts newest first and writes atomically', async () => {
    expect(await loadRules(ws)).toEqual([])
    const list = await addRules(ws, [entry(1), entry(2), entry(1, { at: '2030-01-01T00:00:00.000Z' })])
    expect(list.map((a) => a.sourceFact)).toEqual(['fact 2', 'fact 1'])
    expect(list[1].id).toBe(reframingId('fact 1', 'wording 1'))
    // A preferred wording kept again stays the older entry.
    expect(list[1].at).toBe(at(1))
    const saved = JSON.parse(await readFile(rulesFile(ws), 'utf8'))
    expect(saved.version).toBe(1)
    expect(saved.rules).toHaveLength(2)
    // Concurrent adds do not lose each other.
    await Promise.all([addRules(ws, [entry(3)]), addRules(ws, [entry(4)])])
    expect((await loadRules(ws)).map((a) => a.sourceFact)).toEqual(['fact 4', 'fact 3', 'fact 2', 'fact 1'])
  })

  it('keeps one rule per pair: the latest decision about it wins', () => {
    const kept = mergeRules([], [entry(1)])
    const rejected = mergeRules(kept, [entry(1, { kind: 'rejected', at: at(5), betterWording: '  Contributed to  wording 1 ' })])
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ kind: 'rejected', at: at(5), betterWording: 'Contributed to  wording 1' })
    // Rejected again, without a better wording: the old one goes.
    const again = mergeRules(rejected, [entry(1, { kind: 'rejected', at: at(6) })])
    expect(again[0].betterWording).toBeUndefined()
    // Kept after a rejection: preferred again.
    const keptAgain = mergeRules(again, [entry(1, { at: at(7) })])
    expect(keptAgain[0]).toMatchObject({ kind: 'preferred', at: at(7) })
    expect(keptAgain[0].betterWording).toBeUndefined()
    // A preferred entry never carries a better wording.
    expect(mergeRules([], [entry(2, { betterWording: 'x' })])[0].betterWording).toBeUndefined()
  })

  it('removes one or all', async () => {
    const [a] = await addRules(ws, [entry(1), entry(2, { kind: 'rejected' })])
    expect((await removeRule(ws, a.id)).map((x) => x.id)).not.toContain(a.id)
    expect(await removeAllRules(ws)).toEqual([])
  })

  it('lives outside the workspace; a rules file an agent wrote into the workspace is not a rule', async () => {
    expect(rulesFile(ws).startsWith(authority)).toBe(true)
    expect(rulesFile(ws).startsWith(ws)).toBe(false)
    await mkdir(join(ws, '.huntgry'), { recursive: true })
    const forged = JSON.stringify({ version: 1, rules: [{ ...entry(9), id: reframingId('fact 9', 'wording 9') }] })
    await writeFile(join(ws, '.huntgry', 'reframing-rules.json'), forged)
    await writeFile(join(ws, '.huntgry', 'approvals.json'), JSON.stringify({ version: 1, approvals: [approval(9)] }))
    expect(await loadRules(ws)).toEqual([])
    expect(rulesForPrompt(await loadRules(ws))).toEqual({ preferred: [], avoid: [], leftOut: 0 })
  })

  it('reads a null, primitive or array root, or another version, as empty (and can still be written)', async () => {
    await mkdir(authorityDir(ws), { recursive: true })
    for (const root of ['null', '42', '"x"', '[]', '{"version": 2, "rules": []}', '{"version": 1}', '{nope']) {
      await writeFile(rulesFile(ws), root)
      expect(await loadRules(ws), root).toEqual([])
    }
    await writeFile(rulesFile(ws), 'null')
    expect(await removeAllRules(ws)).toEqual([])
    expect((await addRules(ws, [entry(1)])).map((a) => a.sourceFact)).toEqual(['fact 1'])
  })

  it('ignores malformed entries', async () => {
    await mkdir(authorityDir(ws), { recursive: true })
    const ok = { ...entry(1), id: reframingId('fact 1', 'wording 1') }
    await writeFile(
      rulesFile(ws),
      JSON.stringify({
        version: 1,
        rules: [{ id: 'short', sourceFact: 'x', wording: 'y' }, { ...ok, kind: 'maybe' }, { ...ok, betterWording: 'only on a rejection' }, ok]
      })
    )
    expect(await loadRules(ws)).toEqual([ok])
  })
})

describe('migration from standing approvals (pre-#159 approvals.json)', () => {
  async function legacy(content: string): Promise<void> {
    await mkdir(authorityDir(ws), { recursive: true })
    await writeFile(legacyApprovalsFile(ws), content)
  }

  it('reads every standing approval as a preferred wording, with nothing lost', async () => {
    const old = [approval(1), approval(2), approval(3)]
    await legacy(JSON.stringify({ version: 1, approvals: old }))
    const rules = await loadRules(ws)
    expect(rules.map((r) => r.sourceFact)).toEqual(['fact 3', 'fact 2', 'fact 1'])
    for (const a of old) {
      const { approvedAt, ...rest } = a
      expect(rules.find((r) => r.id === a.id)).toEqual({ ...rest, kind: 'preferred', at: approvedAt })
    }
    // And runs get them as preferred wordings, as before #159.
    expect(rulesForPrompt(rules)).toEqual({
      preferred: [3, 2, 1].map((n) => ({ sourceFact: `fact ${n}`, wording: `wording ${n}` })),
      avoid: [],
      leftOut: 0
    })
  })

  it('writes them into the rules file on the first change and leaves approvals.json as it was', async () => {
    const before = JSON.stringify({ version: 1, approvals: [approval(1), approval(2)] })
    await legacy(before)
    await addRules(ws, [entry(3, { kind: 'rejected', betterWording: 'better 3' })])
    const saved = JSON.parse(await readFile(rulesFile(ws), 'utf8'))
    expect(saved.rules.map((r: { sourceFact: string; kind: string }) => [r.sourceFact, r.kind])).toEqual([
      ['fact 3', 'rejected'],
      ['fact 2', 'preferred'],
      ['fact 1', 'preferred']
    ])
    expect(await readFile(legacyApprovalsFile(ws), 'utf8')).toBe(before)
    // Once the rules file exists, the old file is not read again: removing a migrated rule sticks.
    await removeRule(ws, approval(1).id)
    expect((await loadRules(ws)).map((r) => r.sourceFact)).toEqual(['fact 3', 'fact 2'])
    await removeAllRules(ws)
    expect(await loadRules(ws)).toEqual([])
  })

  it('migrates nothing from a broken or other-version approvals.json, and skips malformed entries', async () => {
    for (const root of ['{nope', 'null', '[]', '{"version": 2, "approvals": []}']) {
      await legacy(root)
      expect(await loadRules(ws), root).toEqual([])
    }
    await legacy(JSON.stringify({ version: 1, approvals: [{ id: 'short' }, { ...approval(1), approvedAt: 7 }, approval(2)] }))
    expect((await loadRules(ws)).map((r) => r.sourceFact)).toEqual(['fact 2'])
  })
})

describe('rules for the prompt', () => {
  it('sends kept wordings as preferred and rejected ones as avoid, a better wording as preferred for the fact', () => {
    const rules = mergeRules([], [
      entry(1),
      entry(2, { kind: 'rejected', wording: 'Led   a team', betterWording: 'Mentored two engineers' }),
      entry(3, { kind: 'rejected' })
    ])
    expect(rulesForPrompt(rules)).toEqual({
      preferred: [
        { sourceFact: 'fact 2', wording: 'Mentored two engineers' },
        { sourceFact: 'fact 1', wording: 'wording 1' }
      ],
      avoid: [
        { sourceFact: 'fact 3', wording: 'wording 3' },
        { sourceFact: 'fact 2', wording: 'Led a team' }
      ],
      leftOut: 0
    })
  })

  it('caps what goes into the prompt: newest first, by count and by size', () => {
    const stamp = (i: number) => `2026-09-30T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`
    const many = Array.from({ length: 200 }, (_, i) => ({ ...entry(i, { at: stamp(i) }), id: 'x'.repeat(64) }))
    const { preferred, leftOut } = rulesForPrompt(many)
    expect(preferred).toHaveLength(RULES_PROMPT_CAP.entries)
    expect(leftOut).toBe(200 - RULES_PROMPT_CAP.entries)
    expect(preferred[0].sourceFact).toBe('fact 199')
    // A rejection with a better wording counts as two entries, and is sent whole or not at all.
    const pairs = Array.from({ length: 100 }, (_, i) => ({ ...entry(i, { at: stamp(i), kind: 'rejected', betterWording: `better ${i}` }), id: 'x'.repeat(64) }))
    const two = rulesForPrompt(pairs)
    expect(two.avoid).toHaveLength(RULES_PROMPT_CAP.entries / 2)
    expect(two.preferred).toHaveLength(RULES_PROMPT_CAP.entries / 2)
    const big = Array.from({ length: 20 }, (_, i) => ({ ...entry(i), id: 'x'.repeat(64), sourceFact: 'f'.repeat(3000), wording: 'w'.repeat(3000) }))
    const capped = rulesForPrompt(big)
    expect(Buffer.byteLength(JSON.stringify(capped.preferred)) + Buffer.byteLength(JSON.stringify(capped.avoid))).toBeLessThanOrEqual(RULES_PROMPT_CAP.bytes)
    expect(capped.leftOut).toBeGreaterThan(0)
  })
})
