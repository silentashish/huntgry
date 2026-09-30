import { ipcMain } from 'electron'
import { REVIEW_CHANNELS } from '@shared/review-types'
import { contextForRun, manager } from '../cli/start'
import { requireCurrentWorkspace } from '../current-workspace'
import { emit } from '../events'
import { replyThroughQueue } from '../queue/ipc'
import { requireApprovalId } from './approvals'
import {
  approveReview,
  discardReview,
  dropAllApprovals,
  dropApproval,
  listApprovals,
  listReviews,
  requireApplicationId,
  requireApproveInput,
  requireDiscardInput,
  requireRerunInput,
  rerunReview,
  reviewDetail,
  type ReviewDeps
} from './service'

const workspace = async () => (await requireCurrentWorkspace()).path

/** The desktop's review deps; #42's gateway builds the same shape with `via: 'phone:<id>'`. */
export const reviewDeps: ReviewDeps = {
  workspace,
  reply: async (runId, text, ws) => {
    // A run the queue manages waits for a free slot like any reply; a re-run of a result whose queue
    // item is gone continues the session directly (the pipeline still settles it).
    const viaQueue = await replyThroughQueue(runId, text)
    return viaQueue ?? manager.reply(runId, text, () => contextForRun(runId, ws))
  },
  changed: () => emit('applications:changed', null)
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
