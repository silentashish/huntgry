import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APPROVALS_PROMPT_CAP, type StandingApproval } from '@shared/review-types'
import { addApprovals, approvalsFile, approvalsForPrompt, loadApprovals, removeAllApprovals, removeApproval } from './approvals'
import { reframingId } from './notes'

let ws: string
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-approvals-'))
})
afterEach(() => rm(ws, { recursive: true, force: true }))

const entry = (n: number, at = `2026-09-30T00:00:${String(n).padStart(2, '0')}.000Z`): Omit<StandingApproval, 'id'> => ({
  sourceFact: `fact ${n}`,
  wording: `wording ${n}`,
  approvedAt: at,
  applicationId: 'r/c/1',
  runId: '20260930-000000-aaaaaa',
  via: 'desktop'
})

describe('standing approvals store', () => {
  it('adds with recomputed ids, dedupes by id, sorts newest first and writes atomically', async () => {
    expect(await loadApprovals(ws)).toEqual([])
    const list = await addApprovals(ws, [entry(1), entry(2), { ...entry(1), approvedAt: '2030-01-01T00:00:00.000Z' }])
    expect(list.map((a) => a.sourceFact)).toEqual(['fact 2', 'fact 1'])
    expect(list[1].id).toBe(reframingId('fact 1', 'wording 1'))
    expect(list[1].approvedAt).toBe('2026-09-30T00:00:01.000Z')
    const saved = JSON.parse(await readFile(approvalsFile(ws), 'utf8'))
    expect(saved.version).toBe(1)
    expect(saved.approvals).toHaveLength(2)
    // Concurrent adds do not lose each other.
    await Promise.all([addApprovals(ws, [entry(3)]), addApprovals(ws, [entry(4)])])
    expect((await loadApprovals(ws)).map((a) => a.sourceFact)).toEqual(['fact 4', 'fact 3', 'fact 2', 'fact 1'])
  })

  it('removes one or all', async () => {
    const [a] = await addApprovals(ws, [entry(1), entry(2)])
    expect((await removeApproval(ws, a.id)).map((x) => x.id)).not.toContain(a.id)
    expect(await removeAllApprovals(ws)).toEqual([])
  })

  it('ignores a broken file and malformed entries', async () => {
    await mkdir(join(ws, '.huntgry'), { recursive: true })
    await writeFile(approvalsFile(ws), '{nope')
    expect(await loadApprovals(ws)).toEqual([])
    await writeFile(
      approvalsFile(ws),
      JSON.stringify({ version: 1, approvals: [{ id: 'short', sourceFact: 'x', wording: 'y' }, { ...entry(1), id: reframingId('fact 1', 'wording 1') }] })
    )
    expect(await loadApprovals(ws)).toHaveLength(1)
  })

  it('caps what goes into the prompt: newest first, by count and by size', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...entry(i, `2026-09-30T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`), id: 'x'.repeat(64) }))
    const { sent, leftOut } = approvalsForPrompt(many)
    expect(sent).toHaveLength(APPROVALS_PROMPT_CAP.entries)
    expect(leftOut).toBe(200 - APPROVALS_PROMPT_CAP.entries)
    expect(sent[0].sourceFact).toBe('fact 199')
    const big = Array.from({ length: 20 }, (_, i) => ({ ...entry(i), id: 'x'.repeat(64), sourceFact: 'f'.repeat(3000), wording: 'w'.repeat(3000) }))
    const capped = approvalsForPrompt(big)
    expect(Buffer.byteLength(JSON.stringify(capped.sent))).toBeLessThanOrEqual(APPROVALS_PROMPT_CAP.bytes)
    expect(capped.leftOut).toBeGreaterThan(0)
  })
})
