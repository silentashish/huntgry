import { ipcMain } from 'electron'
import {
  REVIEW_CHANNELS,
  type ApproveReviewInput,
  type DiscardReviewInput,
  type RerunReviewInput,
  type ReviewDetail,
  type ReviewItem,
  type ReviewOutcome,
  type ReviewVia
} from '@shared/review-types'
import { WorkspaceChangedError } from '../workspace/changed'
import { manager } from '../cli/start'
import { requireCurrentWorkspace } from '../current-workspace'
import { emit } from '../events'
import { pipeline } from '../pipeline/ipc'
import { queue, replyThroughQueue } from '../queue/ipc'
import { requireApprovalId } from './approvals'
import {
  approveReview,
  discardReview,
  dropAllApprovals,
  dropApproval,
  isSettledReview,
  listApprovals,
  listReviews,
  openGapCount,
  requireApplicationId,
  requireApproveInput,
  requireDiscardInput,
  requireRerunInput,
  rerunReview,
  reviewDetail,
  type ReviewDeps
} from './service'

const workspace = async () => (await requireCurrentWorkspace()).path

/**
 * After every review decision (Approve, Discard, Re-run), whoever made it: the desktop re-lists,
 * and the queue items, pipeline counts and dock badge take the new state (#72). #42's gateway
 * `ReviewDeps.changed` must call this too, so a phone decision refreshes the Tailor page.
 */
export function afterReviewDecision(): void {
  unreviewedCache = null
  emit('applications:changed', null)
  void pipeline.syncReviews().catch((err: unknown) => console.error('Syncing review states into the queue failed:', err))
}

/** The desktop's review deps; #42's gateway builds the same shape with `via: 'phone:<id>'`. */
export const reviewDeps: ReviewDeps = {
  workspace,
  reply: async (runId, text) => {
    // Always through the queue (it takes back a result whose item was removed): the process cap,
    // the pipeline's policy and the verify gate apply to a re-run like to any job. Never directly.
    const viaQueue = await replyThroughQueue(runId, text)
    if (viaQueue === null) throw new Error('This result cannot be re-run now (another workspace is open, or the app is quitting).')
    return viaQueue
  },
  changed: afterReviewDecision,
  busy: (runId) =>
    manager.liveRun(runId)?.status === 'running' ||
    queue.state().items.some((i) => i.runId === runId && (i.status === 'queued' || i.status === 'preparing' || i.status === 'running'))
}

/**
 * The desktop's review deps bound to one workspace, for the phone's gateway (#42): another open
 * workspace throws `WorkspaceChangedError` instead of deciding there, and a re-run's answers go
 * through the queue (process cap, pipeline policy, verify gate) like the desktop's, refusing
 * another workspace's queue. `changed` is `afterReviewDecision`, so a phone decision refreshes
 * the Tailor page, the counts and the dock badge exactly like a desktop one.
 */
export function reviewDepsFor(ws: string): ReviewDeps {
  return {
    ...reviewDeps,
    workspace: async () => {
      if ((await workspace()) !== ws) throw new WorkspaceChangedError()
      return ws
    },
    reply: async (runId, text) => {
      const viaQueue = await queue.reply(runId, text, ws)
      if (viaQueue === null) throw new Error('This result cannot be re-run now (another workspace is open, or the app is quitting).')
      return viaQueue
    }
  }
}

/** Results waiting for review per workspace, for the phone's status (cached briefly; a decision clears it). */
let unreviewedCache: { ws: string; at: number; count: Promise<number> } | null = null

/** Review for the phone's gateway (#42): the same service calls as the handlers below, bound to the checked workspace. */
export const reviewForRemote = {
  list: async (ws: string): Promise<{ item: ReviewItem; openGaps: number }[]> => {
    const items = await listReviews(ws)
    return Promise.all(items.map(async (item) => ({ item, openGaps: await openGapCount(ws, item.applicationId) })))
  },
  detail: (ws: string, applicationId: string): Promise<ReviewDetail> => reviewDetail(ws, applicationId),
  approve: (ws: string, input: ApproveReviewInput, via: ReviewVia): Promise<ReviewOutcome> => approveReview(reviewDepsFor(ws), input, via),
  rerun: (ws: string, input: RerunReviewInput, via: ReviewVia): Promise<ReviewOutcome> => rerunReview(reviewDepsFor(ws), input, via),
  discard: (ws: string, input: DiscardReviewInput, via: ReviewVia): Promise<ReviewOutcome> => discardReview(reviewDepsFor(ws), input, via),
  unreviewed: (ws: string): Promise<number> => {
    const now = Date.now()
    if (unreviewedCache?.ws === ws && now - unreviewedCache.at < 5000) return unreviewedCache.count
    const count = listReviews(ws).then((items) => items.filter(isSettledReview).length)
    unreviewedCache = { ws, at: now, count }
    count.catch(() => {
      if (unreviewedCache?.count === count) unreviewedCache = null
    })
    return count
  }
}

/** Review of unattended results: list, detail, approve / re-run / discard bound to a revision, standing approvals. */
export function registerReviewIpc(): void {
  ipcMain.handle(REVIEW_CHANNELS.list, async () => listReviews(await workspace()))
  ipcMain.handle(REVIEW_CHANNELS.get, async (_e, id: unknown) => reviewDetail(await workspace(), requireApplicationId(id)))
  ipcMain.handle(REVIEW_CHANNELS.approve, (_e, input: unknown) => approveReview(reviewDeps, requireApproveInput(input), 'desktop'))
  ipcMain.handle(REVIEW_CHANNELS.rerun, (_e, input: unknown) => rerunReview(reviewDeps, requireRerunInput(input), 'desktop'))
  ipcMain.handle(REVIEW_CHANNELS.discard, (_e, input: unknown) => discardReview(reviewDeps, requireDiscardInput(input), 'desktop'))
  ipcMain.handle(REVIEW_CHANNELS.approvals, async () => listApprovals(await workspace()))
  ipcMain.handle(REVIEW_CHANNELS.removeApproval, async (_e, id: unknown) => dropApproval(await workspace(), requireApprovalId(id)))
  ipcMain.handle(REVIEW_CHANNELS.removeAllApprovals, async () => dropAllApprovals(await workspace()))
}
