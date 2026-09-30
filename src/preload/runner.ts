import { ipcRenderer } from 'electron'
import { RUNNER_CHANNELS, type RunnerApi } from '@shared/runner-types'

export const runner: RunnerApi = {
  environment: () => ipcRenderer.invoke(RUNNER_CHANNELS.environment),
  installPythonDeps: () => ipcRenderer.invoke(RUNNER_CHANNELS.installPythonDeps),
  installClaude: () => ipcRenderer.invoke(RUNNER_CHANNELS.installClaude),
  updateClaude: () => ipcRenderer.invoke(RUNNER_CHANNELS.updateClaude),
  installSkill: (replace) => ipcRenderer.invoke(RUNNER_CHANNELS.installSkill, replace === true),
  listRuns: () => ipcRenderer.invoke(RUNNER_CHANNELS.listRuns),
  getRun: (id) => ipcRenderer.invoke(RUNNER_CHANNELS.getRun, id),
  start: (params) => ipcRenderer.invoke(RUNNER_CHANNELS.start, params),
  reply: (id, text) => ipcRenderer.invoke(RUNNER_CHANNELS.reply, id, text),
  stop: (id) => ipcRenderer.invoke(RUNNER_CHANNELS.stop, id),
  finish: (id) => ipcRenderer.invoke(RUNNER_CHANNELS.finish, id),
  openOutput: (id, file) => ipcRenderer.invoke(RUNNER_CHANNELS.openOutput, id, file),
  revealOutput: (id) => ipcRenderer.invoke(RUNNER_CHANNELS.revealOutput, id)
}
