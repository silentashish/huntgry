import { app, ipcMain, type WebContents } from 'electron'
import { factsFromProfile, isFactKey, type FactKey } from '@shared/apply-facts'
import { APPLY_CHANNELS } from '@shared/apply-types'
import { fillValuesFrom } from '@shared/apply-values'
import { browserManager, onPopupTab } from '../browser/manager'
import { localUrlsAllowed } from '../cli/dev-urls'
import { requireCurrentWorkspace } from '../current-workspace'
import { emit } from '../events'
import { currentProfilePath } from '../profile/ipc'
import { readProfile } from '../profile/store'
import {
  clearAnswers,
  forgetFact,
  forgetQuestion,
  pageAnswers,
  readAnswers,
  rememberAnswer,
  rememberMappings,
  savedAnswers
} from './answers-store'
import { mapQuestions } from './map-questions'
import { availableMapper } from './mapper'
import { ApplyService, type AnswersDeps, type ApplyPage } from './service'

/** The service's view of a tab: its preload's messages, main-frame loads and its end. */
function pageOf(wc: WebContents): ApplyPage {
  return {
    send: (channel, payload) => {
      if (!wc.isDestroyed()) wc.send(channel, payload)
    },
    onMessage: (channel, listener) => {
      // `wc.ipc` only carries messages from this tab, never from the app window or other tabs.
      const handler = (_e: unknown, payload: unknown) => listener(payload)
      wc.ipc.on(channel, handler)
      return () => wc.ipc.removeListener(channel, handler)
    },
    onLoad: (listener) => {
      const full = () => listener(true)
      const inPage = (_e: unknown, _url: string, isMainFrame: boolean) => {
        if (isMainFrame) listener(false)
      }
      wc.on('did-finish-load', full)
      wc.on('did-navigate-in-page', inPage)
      return () => {
        if (wc.isDestroyed()) return
        wc.removeListener('did-finish-load', full)
        wc.removeListener('did-navigate-in-page', inPage)
      }
    },
    onNavigate: (listener) => {
      const navigated = (_e: unknown, url: string) => listener(url)
      wc.on('did-navigate', navigated)
      return () => {
        if (!wc.isDestroyed()) wc.removeListener('did-navigate', navigated)
      }
    },
    onNavigationStart: (listener) => {
      const started = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) listener()
      }
      wc.on('did-start-navigation', started)
      return () => {
        if (!wc.isDestroyed()) wc.removeListener('did-start-navigation', started)
      }
    },
    onClosed: (listener) => {
      wc.once('destroyed', listener)
      return () => {
        if (!wc.isDestroyed()) wc.removeListener('destroyed', listener)
      }
    }
  }
}

const workspacePath = async () => (await requireCurrentWorkspace()).path

/** Remembered answers live under userData (answers-store.ts); the model gets question text only. */
const answers: AnswersDeps = {
  load: async () => {
    const ws = await workspacePath()
    const [stored, doc] = await Promise.all([readAnswers(ws), readProfile(await currentProfilePath())])
    return pageAnswers(stored, factsFromProfile(doc.profile.contact.workAuthorization))
  },
  remember: async (answer) => {
    await rememberAnswer(await workspacePath(), answer)
  },
  rememberMappings: async (mappings) => {
    await rememberMappings(await workspacePath(), mappings)
  },
  map: async (questions) => {
    const cli = await availableMapper(await workspacePath())
    if (!cli) throw new Error('No model available to map questions.')
    return mapQuestions(questions, cli)
  }
}

const service = new ApplyService({
  workspace: workspacePath,
  values: async () => fillValuesFrom((await readProfile(await currentProfilePath())).profile),
  answers,
  openTab: (url) => browserManager().openTab(url),
  navigate: (tabId, url) => browserManager().navigate(tabId, url),
  page: (tabId) => pageOf(browserManager().getWebContents(tabId)),
  attachDebugger: (tabId) => browserManager().attachDebugger(tabId),
  emit: (session) => emit('apply:session', session),
  onTabOpened: (listener) => onPopupTab(listener),
  allowLocalEmbeds: localUrlsAllowed(app.isPackaged)
})

function requireApplicationId(id: unknown): string {
  if (typeof id !== 'string' || !id || id.length > 600) throw new Error('Invalid application id.')
  return id
}

function requireSessionId(id: unknown): string {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid apply session.')
  return id
}

function requireText(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || !v || v.length > max) throw new Error(`Invalid ${what}.`)
  return v
}

/** `{ fact }` (a known fact key) or `{ question }` (a memory key). */
function requireForgetTarget(v: unknown): { fact: FactKey } | { question: string } {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  if (isFactKey(o.fact)) return { fact: o.fact }
  return { question: requireText(o.question, 'question', 300) }
}

/** Ends any apply session (app quit). */
export function stopApply(): void {
  service.stop()
}

/**
 * Auto-apply: the renderer sends ids only; paths, profile values and pages
 * stay in main. An answer (#71) is a field id and a value, checked against
 * the field the page reported.
 */
export function registerApplyIpc(): void {
  ipcMain.handle(APPLY_CHANNELS.start, (_e, id: unknown) => service.start(requireApplicationId(id)))
  ipcMain.handle(APPLY_CHANNELS.fill, (_e, id: unknown) => service.fill(requireSessionId(id)))
  ipcMain.handle(APPLY_CHANNELS.cancel, (_e, id: unknown) => service.cancel(requireSessionId(id)))
  ipcMain.handle(APPLY_CHANNELS.current, () => service.current())
  ipcMain.handle(APPLY_CHANNELS.answer, (_e, id: unknown, fieldId: unknown, value: unknown, remember: unknown) =>
    service.answer(requireSessionId(id), requireText(fieldId, 'field', 200), requireText(value, 'answer', 500), remember === true)
  )
  ipcMain.handle(APPLY_CHANNELS.answers, async () => savedAnswers(await readAnswers(await workspacePath())))
  ipcMain.handle(APPLY_CHANNELS.forgetAnswer, async (_e, target: unknown) => {
    const t = requireForgetTarget(target)
    const ws = await workspacePath()
    return savedAnswers('fact' in t ? await forgetFact(ws, t.fact) : await forgetQuestion(ws, t.question))
  })
  ipcMain.handle(APPLY_CHANNELS.forgetAllAnswers, async () => savedAnswers(await clearAnswers(await workspacePath())))
}
