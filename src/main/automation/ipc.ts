import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { matchOf } from '@shared/automation-select'
import {
  AUTOMATION_CHANNELS,
  AUTOMATION_LOG_LIMIT,
  requireCandidateKey,
  requireSettingsPatch
} from '@shared/automation-types'
import { DEFAULT_EXPLORE_CATEGORY } from '@shared/explore-types'
import { profileSignals, scoreJob } from '@shared/job-relevance'
import { resolveApplicationFolder } from '../applications/safe-path'
import { scanApplications } from '../applications/scan'
import { updateTracking } from '../applications/tracking'
import { applyForAutomation } from '../apply/ipc'
import { listRuns, readRun } from '../cli/runs'
import { defaultAgent } from '../cli/start'
import { requireCurrentWorkspace, settingsFile } from '../current-workspace'
import { emit, onEvent } from '../events'
import { linkDeps, exploreDeps } from '../explore/deps'
import { exploreSource } from '../explore/source'
import { resolveJobrightCopies } from '../explore/employer-link'
import { addExplore, readCache, toJob } from '../explore/service'
import { loadAndExtract } from '../jobs/loader'
import type { Loader } from '../jobs/service'
import { readPrefs } from '../jobs/prefs'
import { fetchDetails, updateJob } from '../jobs/service'
import { findCanonical, listJobs } from '../jobs/store'
import { notify } from '../pipeline/notify'
import { pipeline } from '../pipeline/ipc'
import { readProfile } from '../profile/store'
import { queue } from '../queue/ipc'
import { approveReview, reviewDetail } from '../review/service'
import { reviewDepsFor } from '../review/ipc'
import { inspectWorkspace } from '../workspace/inspect'
import { Automation, PageBoundError, type LinkOutcome, type PageBudget } from './service'
import { readAutomationSettings, updateAutomationSettings } from './settings'
import { exploreCandidates, jobsSource, type CandidateSource } from './sources'
import { appendLog, readLog, readPrepared, readState, readTrusted, writePrepared, writeState, writeTrusted } from './store'
import { pipelineTailor } from './tailor'

const workspace = async () => (await requireCurrentWorkspace()).path

/** The workspace's own master profile as selection signals (not whichever profile is open in the editor). */
async function signalsOf(ws: string) {
  const inspection = await inspectWorkspace(ws)
  if (!inspection.masterProfile) throw new Error('This workspace has no master profile.')
  return profileSignals((await readProfile(join(inspection.path, inspection.masterProfile))).profile)
}

/** Jobright's hosts (the mock's too in e2e): the pages the run's allowance counts. */
const jobrightHost = (url: string): boolean => {
  try {
    return exploreSource(app.isPackaged).hosts.includes(new URL(url).host.toLowerCase())
  } catch {
    return false
  }
}

/** The posting loader with the run's Jobright allowance in front of it: every Jobright page takes one, aliases too. */
const counted =
  (pages: PageBudget): Loader =>
  (url, extract) => {
    if (jobrightHost(url) && !pages.take()) return Promise.reject(new PageBoundError())
    return loadAndExtract(url, extract)
  }

/** The allowance, remembering whether it refused a page. */
const watched = (pages: PageBudget): PageBudget & { refused: boolean } => {
  const w = {
    refused: false,
    take: () => {
      const ok = pages.take()
      if (!ok) w.refused = true
      return ok
    }
  }
  return w
}

const jobs = jobsSource({ listJobs })
const explore = exploreCandidates({
  // The cache as it is: Automation never fetches the list (no refresh on a timer, #154 Q4). It reads the
  // default category (#169), the one the README list used to be.
  rows: async (ws) => (await readCache(ws, DEFAULT_EXPLORE_CATEGORY, exploreDeps()))?.jobs ?? [],
  toJob,
  savedJobs: listJobs,
  // Saved without the employer-link lookup: the link step does it, counted and with its failure reported.
  add: (ws, id) => addExplore(ws, id, DEFAULT_EXPLORE_CATEGORY, { ...exploreDeps(), link: undefined })
})

/** Where Automation keeps what controls spending, per workspace (`store.ts` `trustedFile`). */
const trustedRoot = () => join(app.getPath('userData'), 'automation')

/** The app's one Automation, over the app's services. */
export const automation = new Automation({
  workspace,
  settings: () => readAutomationSettings(settingsFile()),
  sources: (settings) => [settings.sources.jobs ? jobs : null, settings.sources.explore ? explore : null].filter((s): s is CandidateSource => s !== null),
  selection: async (ws) => {
    const [signals, prefs, scan] = await Promise.all([signalsOf(ws), readPrefs(ws), scanApplications(ws)])
    return { signals, filters: prefs.filters, applications: scan.applications }
  },
  findJob: findCanonical,
  linkConnected: () => linkDeps().connected(),
  onJobright: (job) => job.source === 'jobright' && !!job.boardUrl && job.url === job.boardUrl,
  resolveLink: async (ws, id, pages) => {
    const budget = watched(pages)
    const outcomes: LinkOutcome[] = []
    await resolveJobrightCopies(ws, id, { ...linkDeps(), load: counted(budget) }, (o) => outcomes.push(o))
    if (outcomes.includes('resolved')) return 'resolved'
    // A page refused for the allowance is not a lookup that failed: the job waits for the next run.
    if (budget.refused) throw new PageBoundError()
    for (const o of ['failed', 'signed-out', 'no-link'] as const) if (outcomes.includes(o)) return o
    return 'skipped'
  },
  fetchDetails: async (ws, id, pages) => {
    const budget = watched(pages)
    try {
      return await fetchDetails(ws, id, counted(budget))
    } catch (err) {
      // fetchDetails reports a refused page as a load that failed; it is the allowance.
      if (budget.refused) throw new PageBoundError()
      throw err
    }
  },
  score: async (ws, job) => {
    const scored = scoreJob(job, await signalsOf(ws))
    return { ...(scored.excluded ? { excluded: scored.excluded } : {}), match: matchOf(scored.match) }
  },
  tailor: pipelineTailor({
    pipeline,
    queue,
    onQueueChange: (listener) =>
      onEvent((channel, payload) => {
        if (channel === 'queue:changed') listener(payload as Parameters<typeof listener>[0])
      }),
    agent: defaultAgent,
    options: (coverLetter) => ({ coverLetter, dateStyle: 'right' }),
    listRuns,
    readRun: (ws, id) => readRun(ws, id).catch(() => null)
  }),
  apply: applyForAutomation,
  approve: async (ws, applicationId) => {
    const detail = await reviewDetail(ws, applicationId)
    if (detail.state === 'approved') return
    const outcome = await approveReview(reviewDepsFor(ws), { applicationId, revision: detail.revision }, 'desktop')
    if (!outcome.ok) throw new Error(outcome.message)
  },
  markApplied: async (ws, applicationId) => {
    await updateTracking(await resolveApplicationFolder(ws, applicationId), { status: 'applied' })
    emit('applications:changed', null)
  },
  dismissJob: async (ws, jobId) => {
    await updateJob(ws, jobId, { dismissed: true })
  },
  readState,
  writeState,
  readTrusted: (ws) => readTrusted(trustedRoot(), ws),
  writeTrusted: (ws, usage) => writeTrusted(trustedRoot(), ws, usage),
  appendLog,
  writePrepared,
  readPrepared,
  emit: (state) => emit('automation:changed', state),
  emitStep: (entry) => emit('automation:step', entry),
  notify: (title, body) => notify('pipeline-finished', title, body)
})

onEvent((channel, payload) => {
  if (channel === 'apply:session') void automation.onApplySession(payload as Parameters<Automation['onApplySession']>[0]).catch(() => undefined)
})

/** After the window and the pipeline are up: the open workspace's state, an interrupted run ended, the window's tick. */
export function initAutomation(): void {
  void automation.init().catch((err: unknown) => console.error('Automation init failed:', err))
}

/** Before quit: no new step starts. */
export function stopAutomation(): void {
  automation.shutdown()
}

function requireLogOptions(v: unknown): { limit: number; key?: string } {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  const limit = typeof o.limit === 'number' && Number.isInteger(o.limit) && o.limit > 0 ? Math.min(o.limit, 1000) : AUTOMATION_LOG_LIMIT
  return { limit, ...(o.key !== undefined ? { key: requireCandidateKey(o.key) } : {}) }
}

export function registerAutomationIpc(): void {
  ipcMain.handle(AUTOMATION_CHANNELS.state, () => automation.getState())
  ipcMain.handle(AUTOMATION_CHANNELS.settings, () => readAutomationSettings(settingsFile()))
  ipcMain.handle(AUTOMATION_CHANNELS.updateSettings, async (_e, patch: unknown) => {
    const next = await updateAutomationSettings(settingsFile(), requireSettingsPatch(patch))
    // The window may have moved: the page's "next opening" follows at once.
    void automation.tick().catch(() => undefined)
    return next
  })
  ipcMain.handle(AUTOMATION_CHANNELS.setEnabled, (_e, on: unknown) => {
    if (typeof on !== 'boolean') throw new Error('Invalid setting.')
    return automation.setEnabled(on)
  })
  ipcMain.handle(AUTOMATION_CHANNELS.pause, () => automation.pause())
  ipcMain.handle(AUTOMATION_CHANNELS.resume, () => automation.resume())
  ipcMain.handle(AUTOMATION_CHANNELS.runNow, () => automation.runNow())
  ipcMain.handle(AUTOMATION_CHANNELS.stop, () => automation.stop())
  ipcMain.handle(AUTOMATION_CHANNELS.preview, () => automation.preview())
  ipcMain.handle(AUTOMATION_CHANNELS.retry, (_e, key: unknown) => automation.retry(requireCandidateKey(key)))
  ipcMain.handle(AUTOMATION_CHANNELS.dismiss, (_e, key: unknown) => automation.dismiss(requireCandidateKey(key)))
  ipcMain.handle(AUTOMATION_CHANNELS.log, async (_e, options: unknown) => readLog(await workspace(), requireLogOptions(options)))
  ipcMain.handle(AUTOMATION_CHANNELS.prepared, (_e, key: unknown) => automation.prepared(requireCandidateKey(key)))
  ipcMain.handle(AUTOMATION_CHANNELS.openPrepared, (_e, key: unknown) => automation.openPrepared(requireCandidateKey(key)))
}
