import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunSummary } from '@shared/runner-types'
import { readTracking } from '../applications/tracking'
import { getReview, setReviewAuthorityRoot, updateReview, type RecordedReview } from './authority'
import { RunManager, type RunContext } from '../cli/runner'
import { readEvents, saveRun } from '../cli/runs'
import { approvalsFile, loadApprovals } from './approvals'
import { reframingId } from './notes'
import {
  approvalDrift,
  approveReview,
  MAX_NOTES_BYTES,
  MAX_REPORT_BYTES,
  discardReview,
  listReviews,
  requireApproveInput,
  requireRerunInput,
  rerunMessage,
  rerunReview,
  REVIEW_AUDIT_FILE,
  reviewDetail,
  type ReviewDeps
} from './service'

const FAKE = join(__dirname, '../cli/fixtures/fake-claude.mjs')
const RUN = '20260930-120000-abcdef'
const ID = 'software-engineer/acme/42'
const NOTES = `# Review notes
<!-- huntgry-review v1 · run ${RUN} · unattended -->

## Used standing approvals
None.

## Proposed reframings (not used)
### R1 · Kafka streaming
- Source fact: Built an event pipeline on RabbitMQ
- Proposed wording: Built event-streaming pipelines (RabbitMQ; Kafka-adjacent)
- Why unsure: Kafka was never used

### R2 · Leadership
- Source fact: Mentored two juniors
- Proposed wording: Led a team of two engineers
- Why unsure: mentoring is not leading

## Open gaps
- Go: nothing honest to say

## Notes
Fake.
`

let ws: string
let replies: { runId: string; text: string }[]
let deps: ReviewDeps

async function application(
  id = ID,
  over: { notes?: string | null; review?: Record<string, unknown> | null; report?: string } = {}
): Promise<string> {
  const dir = join(ws, ...id.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'job-description.md'), 'Engineer\nhttps://jobs.example.com/42\n')
  await writeFile(join(dir, 'resume.pdf'), '%PDF-1.4 fake')
  await writeFile(join(dir, 'resume-page-1.jpg'), 'jpg')
  await writeFile(join(dir, 'build-report.json'), over.report ?? '{"ok": true}')
  if (over.notes !== null) await writeFile(join(dir, 'review-notes.md'), over.notes ?? NOTES)
  const review = over.review === undefined ? { state: 'unreviewed', runId: RUN, at: '2026-09-30T01:00:00.000Z' } : over.review
  await writeFile(join(dir, 'huntgry.json'), JSON.stringify({ status: 'generated', notes: '' }))
  // The review state is main's (the authority store), as the pipeline records it.
  if (review) await updateReview(ws, id, () => review as unknown as RecordedReview)
  return dir
}

const recorded = (id = ID) => getReview(ws, id)

let authority: string

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-review-'))
  authority = await mkdtemp(join(tmpdir(), 'huntgry-authority-'))
  setReviewAuthorityRoot(authority)
  replies = []
  deps = {
    workspace: async () => ws,
    reply: async (runId, text) => {
      replies.push({ runId, text })
      return 'held'
    },
    now: () => new Date('2026-09-30T02:00:00.000Z')
  }
})
afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
  await rm(authority, { recursive: true, force: true })
})

describe('review service', () => {
  it('lists unreviewed and needs-attention results newest first', async () => {
    await application('a/b/1', { review: { state: 'unreviewed', runId: RUN, at: '2026-09-30T01:00:00.000Z' } })
    await application('a/b/2', { review: { state: 'needs-attention', runId: RUN, at: '2026-09-30T03:00:00.000Z', reason: 'page_count' } })
    await application('a/b/3', { review: { state: 'approved', runId: RUN, at: '2026-09-30T04:00:00.000Z' } })
    // An attended result (no review notes, no review state) is not listed.
    await application('a/b/4', { review: null, notes: null })
    const list = await listReviews(ws)
    expect(list.map((r) => [r.applicationId, r.state])).toEqual([
      ['a/b/2', 'needs-attention'],
      ['a/b/1', 'unreviewed']
    ])
    expect(list[0]).toMatchObject({ reason: 'page_count', title: 'A · B', build: { status: 'pass' }, hasCover: false })
  })

  it('builds the detail with reframing ids, verify report, artifact hashes and a stable revision', async () => {
    await application()
    const d = await reviewDetail(ws, ID)
    expect(d.runId).toBe(RUN)
    expect(d.proposedReframings.map((p) => p.id)).toEqual([
      reframingId('Built an event pipeline on RabbitMQ', 'Built event-streaming pipelines (RabbitMQ; Kafka-adjacent)'),
      reframingId('Mentored two juniors', 'Led a team of two engineers')
    ])
    expect(d.openGaps).toEqual(['Go: nothing honest to say'])
    expect(d.verify).toEqual({ ok: true, report: '{"ok": true}' })
    expect(d.artifacts.map((a) => a.file)).toEqual(['resume.pdf', 'resume-page-1.jpg'])
    expect(d.artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(d.reviewNotes).toBe(NOTES)
    expect(d.revision).toMatch(/^[0-9a-f]{64}$/)
    expect((await reviewDetail(ws, ID)).revision).toBe(d.revision)
    // A regenerated PDF changes the revision.
    await writeFile(join(ws, ID, 'resume.pdf'), '%PDF-1.4 other')
    expect((await reviewDetail(ws, ID)).revision).not.toBe(d.revision)
  })

  it('shows a warning instead of reframings when the notes are missing or unparsable', async () => {
    await application(ID, { notes: null })
    expect((await reviewDetail(ws, ID)).parseWarning).toMatch(/no review-notes\.md/)
    await application('a/b/x', { notes: 'free prose' })
    const d = await reviewDetail(ws, 'a/b/x')
    expect(d.proposedReframings).toEqual([])
    expect(d.parseWarning).toMatch(/format/)
    await expect(reviewDetail(ws, '../x')).rejects.toThrow()
    await application('a/b/y', { review: null, notes: null })
    await expect(reviewDetail(ws, 'a/b/y')).rejects.toThrow(/no unattended result/)
  })

  it('approve writes only the ticked on-disk pairs as standing approvals and clears the gate', async () => {
    await application()
    const d = await reviewDetail(ws, ID)
    const [r1] = d.proposedReframings
    const out = await approveReview(deps, { applicationId: ID, revision: d.revision, approvedReframingIds: [r1.id] }, 'desktop')
    expect(out.ok).toBe(true)
    const approvals = await loadApprovals(ws)
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({
      id: r1.id,
      sourceFact: 'Built an event pipeline on RabbitMQ',
      wording: 'Built event-streaming pipelines (RabbitMQ; Kafka-adjacent)',
      requirement: 'Kafka streaming',
      applicationId: ID,
      runId: RUN,
      via: 'desktop',
      approvedAt: '2026-09-30T02:00:00.000Z'
    })
    expect(await recorded()).toMatchObject({ state: 'approved', runId: RUN, reviewedAt: '2026-09-30T02:00:00.000Z', via: 'desktop' })
    // The approval vouches for these files: Apply's drift check passes now.
    expect(await approvalDrift(ws, ID)).toBeNull()
    const audit = (await readFile(join(ws, '.huntgry', REVIEW_AUDIT_FILE), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    expect(audit).toEqual([expect.objectContaining({ action: 'approve', applicationId: ID, ids: [r1.id], via: 'desktop' })])
    // Approving without ticks saves nothing new.
    await application('a/b/2')
    const d2 = await reviewDetail(ws, 'a/b/2')
    await approveReview(deps, { applicationId: 'a/b/2', revision: d2.revision }, 'phone:dev1')
    expect(await loadApprovals(ws)).toHaveLength(1)
    expect((await recorded('a/b/2'))?.via).toBe('phone:dev1')
  })

  it('refuses a stale revision, a forged id and an id from another application without writing', async () => {
    await application()
    await application('other/co/7', { notes: NOTES.replace('Mentored two juniors', 'Ran the on-call rota') })
    const d = await reviewDetail(ws, ID)
    const other = await reviewDetail(ws, 'other/co/7')
    const foreign = other.proposedReframings[1].id
    expect(foreign).not.toBe(d.proposedReframings[1].id)

    const forged = await approveReview(deps, { applicationId: ID, revision: d.revision, approvedReframingIds: ['f'.repeat(64)] }, 'desktop')
    expect(forged).toMatchObject({ ok: false, error: 'invalid' })
    const crossed = await approveReview(deps, { applicationId: ID, revision: d.revision, approvedReframingIds: [foreign] }, 'desktop')
    expect(crossed).toMatchObject({ ok: false, error: 'invalid' })
    const stale = await approveReview(deps, { applicationId: ID, revision: 'a'.repeat(64), approvedReframingIds: [d.proposedReframings[0].id] }, 'desktop')
    expect(stale).toMatchObject({ ok: false, error: 'stale' })
    // The PDF was regenerated after the phone fetched the detail: the old revision no longer applies.
    await writeFile(join(ws, ID, 'resume.pdf'), '%PDF-1.4 regenerated')
    const regenerated = await approveReview(deps, { applicationId: ID, revision: d.revision, approvedReframingIds: [d.proposedReframings[0].id] }, 'desktop')
    expect(regenerated).toMatchObject({ ok: false, error: 'stale' })

    await expect(readFile(approvalsFile(ws))).rejects.toThrow()
    expect((await recorded())?.state).toBe('unreviewed')
    expect(replies).toEqual([])
    await expect(discardReview(deps, { applicationId: ID, revision: 'b'.repeat(64) }, 'desktop')).resolves.toMatchObject({ ok: false, error: 'stale' })
    await expect(rerunReview(deps, { applicationId: ID, revision: 'b'.repeat(64), answers: 'x' }, 'desktop')).resolves.toMatchObject({ ok: false, error: 'stale' })
  })

  it('a revision shown before a re-run is stale afterwards, even before any file changes', async () => {
    await application()
    const before = await reviewDetail(ws, ID)
    expect((await rerunReview(deps, { applicationId: ID, revision: before.revision, answers: 'Drop R2.' }, 'desktop')).ok).toBe(true)
    const late = await approveReview(deps, { applicationId: ID, revision: before.revision, approvedReframingIds: [] }, 'desktop')
    expect(late).toMatchObject({ ok: false, error: 'stale' })
    expect((await recorded())?.state).toBe('unreviewed')
  })

  it('tells the app after every decision that went through, and never after a refused one (#72: the Tailor page syncs on it)', async () => {
    let changed = 0
    const counting: ReviewDeps = { ...deps, changed: () => changed++ }
    await application()
    await application('a/b/2')
    await application('a/b/3')
    const stale = 'c'.repeat(64)
    await approveReview(counting, { applicationId: ID, revision: stale }, 'desktop')
    await discardReview(counting, { applicationId: ID, revision: stale }, 'desktop')
    await rerunReview(counting, { applicationId: ID, revision: stale, answers: 'x' }, 'desktop')
    await approveReview(counting, { applicationId: ID, revision: (await reviewDetail(ws, ID)).revision, approvedReframingIds: ['f'.repeat(64)] }, 'desktop')
    expect(changed).toBe(0)
    expect((await approveReview(counting, { applicationId: ID, revision: (await reviewDetail(ws, ID)).revision }, 'desktop')).ok).toBe(true)
    expect(changed).toBe(1)
    expect((await discardReview(counting, { applicationId: 'a/b/2', revision: (await reviewDetail(ws, 'a/b/2')).revision }, 'desktop')).ok).toBe(true)
    expect(changed).toBe(2)
    expect((await rerunReview(counting, { applicationId: 'a/b/3', revision: (await reviewDetail(ws, 'a/b/3')).revision, answers: 'x' }, 'desktop')).ok).toBe(true)
    expect(changed).toBe(3)
  })

  it('refuses approve and re-run while the run is still working on the result; discard still works', async () => {
    await application()
    const busy: ReviewDeps = { ...deps, busy: (runId) => runId === RUN }
    const d = await reviewDetail(ws, ID)
    await expect(approveReview(busy, { applicationId: ID, revision: d.revision, approvedReframingIds: [] }, 'desktop')).rejects.toThrow(
      /still being tailored/
    )
    await expect(rerunReview(busy, { applicationId: ID, revision: d.revision, answers: 'x' }, 'desktop')).rejects.toThrow(/still being tailored/)
    expect(replies).toEqual([])
    expect((await recorded())?.state).toBe('unreviewed')
    expect((await discardReview(busy, { applicationId: ID, revision: d.revision }, 'desktop')).ok).toBe(true)
  })

  it('notes without a review state (a stopped or crashed run) read as Unreviewed and can be approved', async () => {
    await application(ID, { review: null })
    const [item] = await listReviews(ws)
    expect(item).toMatchObject({ applicationId: ID, state: 'unreviewed', reason: expect.stringContaining('never checked') })
    const d = await reviewDetail(ws, ID)
    expect(d.state).toBe('unreviewed')
    await expect(rerunReview(deps, { applicationId: ID, revision: d.revision, answers: 'x' }, 'desktop')).rejects.toThrow(/no run to continue/)
    expect((await approveReview(deps, { applicationId: ID, revision: d.revision, approvedReframingIds: [] }, 'desktop')).ok).toBe(true)
    expect((await recorded())?.state).toBe('approved')
  })

  it('a review state an agent wrote into huntgry.json never unlocks anything (fails closed)', async () => {
    const dir = await application(ID, { review: null })
    // The agent forges "approved" in the workspace file; main recorded nothing.
    await writeFile(join(dir, 'huntgry.json'), JSON.stringify({ status: 'generated', review: { state: 'approved', runId: RUN, at: '2026-09-30T05:00:00.000Z' } }))
    const [item] = await listReviews(ws)
    expect(item).toMatchObject({ applicationId: ID, state: 'needs-attention', reason: expect.stringContaining('did not record') })
    expect(await recorded()).toBeUndefined()
    // Recorded Unreviewed by main, forged Approved in the workspace: main's state wins.
    await updateReview(ws, ID, () => ({ state: 'unreviewed', runId: RUN, at: '2026-09-30T01:00:00.000Z' }))
    expect((await reviewDetail(ws, ID)).state).toBe('unreviewed')
    // A forged "approved" in main's own format, but inside the workspace, is ignored too.
    await mkdir(join(ws, '.huntgry'), { recursive: true })
    await writeFile(join(ws, '.huntgry', 'reviews.json'), JSON.stringify({ version: 1, reviews: { [ID]: { state: 'approved', runId: RUN, at: 'x' } } }))
    expect((await reviewDetail(ws, ID)).state).toBe('unreviewed')
  })

  it('serialises decisions: concurrent approve and re-run on one revision, exactly one wins', async () => {
    await application()
    const d = await reviewDetail(ws, ID)
    const [r1] = d.proposedReframings
    const [approve, rerun] = await Promise.all([
      approveReview(deps, { applicationId: ID, revision: d.revision, approvedReframingIds: [r1.id] }, 'desktop'),
      rerunReview(deps, { applicationId: ID, revision: d.revision, answers: 'Drop R2.' }, 'desktop')
    ])
    expect([approve.ok, rerun.ok]).toEqual([true, false])
    expect(rerun).toMatchObject({ ok: false, error: 'stale' })
    expect(replies).toEqual([])
    expect((await recorded())?.state).toBe('approved')
    // And the other order: the re-run wins, the approval is stale and writes no standing approval.
    await application('a/b/2')
    const d2 = await reviewDetail(ws, 'a/b/2')
    const [rerun2, approve2] = await Promise.all([
      rerunReview(deps, { applicationId: 'a/b/2', revision: d2.revision, answers: 'Drop R2.' }, 'desktop'),
      approveReview(deps, { applicationId: 'a/b/2', revision: d2.revision, approvedReframingIds: [d2.proposedReframings[1].id] }, 'desktop')
    ])
    expect(rerun2.ok).toBe(true)
    expect(approve2).toMatchObject({ ok: false, error: 'stale' })
    expect((await recorded('a/b/2'))?.state).toBe('unreviewed')
    expect((await loadApprovals(ws)).map((a) => a.id)).toEqual([r1.id])
  })

  it('an approval stops holding once the files change (Apply drift check)', async () => {
    await application()
    const d = await reviewDetail(ws, ID)
    expect((await approveReview(deps, { applicationId: ID, revision: d.revision, approvedReframingIds: [] }, 'desktop')).ok).toBe(true)
    expect(await approvalDrift(ws, ID)).toBeNull()
    await writeFile(join(ws, ID, 'resume.pdf'), '%PDF-1.4 rewritten after approval')
    expect(await approvalDrift(ws, ID)).toMatch(/changed since you approved/)
  })

  it('keeps verify.py\'s report of a report-less result through approve and discard, so the approval still holds', async () => {
    const verify = { ok: true, report: 'page_count: pass' }
    for (const id of [ID, 'a/b/2']) {
      await application(id)
      await rm(join(ws, id, 'build-report.json'))
      await updateReview(ws, id, () => ({ state: 'unreviewed', runId: RUN, at: '2026-09-30T01:00:00.000Z', verify }))
    }
    const d = await reviewDetail(ws, ID)
    expect(d.verify).toEqual(verify)
    expect((await approveReview(deps, { applicationId: ID, revision: d.revision, approvedReframingIds: [] }, 'desktop')).ok).toBe(true)
    expect(await recorded()).toMatchObject({ state: 'approved', verify })
    expect((await reviewDetail(ws, ID)).verify).toEqual(verify)
    // Apply's check: the files and the report are what was approved.
    expect(await approvalDrift(ws, ID)).toBeNull()
    const d2 = await reviewDetail(ws, 'a/b/2')
    expect((await discardReview(deps, { applicationId: 'a/b/2', revision: d2.revision }, 'desktop')).ok).toBe(true)
    expect(await recorded('a/b/2')).toMatchObject({ state: 'discarded', verify })
  })

  it('a re-run does not keep the report of the previous build', async () => {
    await application()
    await rm(join(ws, ID, 'build-report.json'))
    await updateReview(ws, ID, () => ({ state: 'unreviewed', runId: RUN, at: '2026-09-30T01:00:00.000Z', verify: { ok: true, report: 'old' } }))
    const d = await reviewDetail(ws, ID)
    expect((await rerunReview(deps, { applicationId: ID, revision: d.revision, answers: 'x' }, 'desktop')).ok).toBe(true)
    expect((await recorded())?.verify).toBeUndefined()
  })

  it('a re-run whose reply fails puts back the previous state', async () => {
    await application()
    const d = await reviewDetail(ws, ID)
    const failing: ReviewDeps = { ...deps, reply: async () => { throw new Error('no session') } }
    await expect(rerunReview(failing, { applicationId: ID, revision: d.revision, answers: 'x' }, 'desktop')).rejects.toThrow(/no session/)
    expect(await recorded()).toMatchObject({ state: 'unreviewed', at: '2026-09-30T01:00:00.000Z' })
  })

  it('reads oversized notes and reports without parsing them, and says so', async () => {
    await application(ID, { notes: `${NOTES}\n${'x'.repeat(MAX_NOTES_BYTES)}`, report: `{"ok": true, "pad": "${'y'.repeat(MAX_REPORT_BYTES)}"}` })
    const d = await reviewDetail(ws, ID)
    expect(d.proposedReframings).toEqual([])
    expect(d.reviewNotes).toBeNull()
    expect(d.parseWarning).toMatch(/review-notes\.md is too large/)
    expect(d.parseWarning).toMatch(/build-report\.json is too large/)
    expect(d.revision).toMatch(/^[0-9a-f]{64}$/)
  })

  it('re-run sends the decisions and the ticked reframings to the run and makes the result unreviewed again', async () => {
    await application()
    const d = await reviewDetail(ws, ID)
    const [r1] = d.proposedReframings
    const out = await rerunReview(
      deps,
      { applicationId: ID, revision: d.revision, answers: 'Drop R2. Mention the on-call work.', approvedReframingIds: [r1.id] },
      'desktop'
    )
    expect(out.ok).toBe(true)
    expect(replies).toHaveLength(1)
    expect(replies[0].runId).toBe(RUN)
    expect(replies[0].text).toBe(
      rerunMessage('Drop R2. Mention the on-call work.', [{ sourceFact: r1.sourceFact, wording: r1.wording }])
    )
    expect(replies[0].text).toContain('Decisions: Drop R2. Mention the on-call work.')
    expect(replies[0].text).toContain('Wording: Built event-streaming pipelines (RabbitMQ; Kafka-adjacent)')
    expect(replies[0].text).toContain('update review-notes.md')
    expect((await loadApprovals(ws)).map((a) => a.id)).toEqual([r1.id])
    expect(await recorded()).toMatchObject({ state: 'unreviewed', runId: RUN, reason: 'Re-running with your answers.' })
    expect((await recorded())?.at).toBe('2026-09-30T02:00:00.000Z')
  })

  it('re-run against a real fake-claude session echoes the decisions on the same session', async () => {
    const dir = await application()
    const manager = new RunManager({ onEvent: () => undefined, onRun: () => undefined })
    const ctx: RunContext = {
      workspace: ws,
      skillDir: '/skills/resume-tailor',
      sandbox: { workspace: ws, skillDir: '/skills/resume-tailor', venvDir: '/venv', texRoot: null },
      command: process.execPath,
      commandPrefixArgs: [FAKE],
      env: { ...process.env },
      systemPrompt: 'test'
    }
    const run: RunSummary = {
      id: RUN,
      title: 'x',
      params: { jobDescription: 'x', coverLetter: false, dateStyle: 'right', unattended: true },
      agent: 'claude',
      status: 'waiting',
      sessionId: 'sess-old',
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
      outputFolder: ID,
      outputFiles: ['resume.pdf'],
      costUsd: 0,
      live: false,
      unattended: true
    }
    await saveRun(ws, run)
    const real: ReviewDeps = { ...deps, reply: (runId, text) => manager.reply(runId, text, async () => ctx) }
    const d = await reviewDetail(ws, ID)
    const out = await rerunReview(real, { applicationId: ID, revision: d.revision, answers: 'Keep R1 only.' }, 'desktop')
    expect(out.ok).toBe(true)
    manager.finish(RUN)
    await manager.whenIdle()
    const events = await readEvents(ws, RUN)
    const user = events.find((e) => (e as { subtype?: string }).subtype === 'user_message') as { text: string }
    expect(user.text).toContain('Decisions: Keep R1 only.')
    expect(JSON.stringify(events)).toContain('echo: The user reviewed the notes.')
    expect(dir).toBeDefined()
  })

  it('discard keeps the files, archives the application and blocks Apply', async () => {
    const dir = await application()
    const d = await reviewDetail(ws, ID)
    const out = await discardReview(deps, { applicationId: ID, revision: d.revision }, 'desktop')
    expect(out.ok).toBe(true)
    expect(await readTracking(dir)).toMatchObject({ status: 'archived' })
    expect(await recorded()).toMatchObject({ state: 'discarded', reviewedAt: '2026-09-30T02:00:00.000Z' })
    await expect(readFile(join(dir, 'resume.pdf'), 'utf8')).resolves.toBe('%PDF-1.4 fake')
  })

  it('validates what the renderer (or the phone) sends', () => {
    expect(() => requireApproveInput({ applicationId: 'a/b/c', revision: 'zz' })).toThrow(/revision/)
    expect(() => requireApproveInput({ applicationId: 'a/b/c', revision: 'a'.repeat(64), approvedReframingIds: ['x'] })).toThrow(/reframing id/)
    expect(requireApproveInput({ applicationId: 'a/b/c', revision: 'a'.repeat(64), approvedReframingIds: ['b'.repeat(64), 'b'.repeat(64)] }).approvedReframingIds).toEqual(['b'.repeat(64)])
    expect(() => requireRerunInput({ applicationId: 'a/b/c', revision: 'a'.repeat(64), answers: '   ' })).toThrow(/decisions/)
    expect(() => requireRerunInput({ applicationId: 'a/b/c', revision: 'a'.repeat(64), answers: 'x'.repeat(200_001) })).toThrow(/too long/)
    expect(requireRerunInput({ applicationId: 'a/b/c', revision: 'a'.repeat(64), answers: ' ok ' }).answers).toBe('ok')
  })
})
