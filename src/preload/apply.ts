import { ipcRenderer } from 'electron'
import { APPLY_CHANNELS, type ApplyApi } from '@shared/apply-types'

export const apply: ApplyApi = {
  start: (applicationId) => ipcRenderer.invoke(APPLY_CHANNELS.start, applicationId),
  fill: (sessionId) => ipcRenderer.invoke(APPLY_CHANNELS.fill, sessionId),
  cancel: (sessionId) => ipcRenderer.invoke(APPLY_CHANNELS.cancel, sessionId),
  current: () => ipcRenderer.invoke(APPLY_CHANNELS.current),
  answer: (sessionId, fieldId, value, remember) => ipcRenderer.invoke(APPLY_CHANNELS.answer, sessionId, fieldId, value, remember),
  answers: () => ipcRenderer.invoke(APPLY_CHANNELS.answers),
  forgetAnswer: (target) => ipcRenderer.invoke(APPLY_CHANNELS.forgetAnswer, target),
  forgetAllAnswers: () => ipcRenderer.invoke(APPLY_CHANNELS.forgetAllAnswers),
  pickSetting: () => ipcRenderer.invoke(APPLY_CHANNELS.pickSetting),
  setPickSetting: (on) => ipcRenderer.invoke(APPLY_CHANNELS.setPickSetting, on)
}
