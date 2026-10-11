import { ipcRenderer } from 'electron'
import { MAX_RESUME_BYTES, resumeExtensionOf, type DroppedResume, type ResumeImportResult } from '@shared/master-profile'
import { IPC_CHANNELS, type ProfileApi, type WorkspaceApi } from '@shared/workspace-types'

export const workspace: WorkspaceApi = {
  pickDirectory: (mode) => ipcRenderer.invoke(IPC_CHANNELS.pickDirectory, mode),
  inspect: (path) => ipcRenderer.invoke(IPC_CHANNELS.inspect, path),
  create: (path, options) => ipcRenderer.invoke(IPC_CHANNELS.create, path, options),
  open: (path) => ipcRenderer.invoke(IPC_CHANNELS.open, path),
  getCurrent: () => ipcRenderer.invoke(IPC_CHANNELS.getCurrent)
}

/** Sends a dropped resume's contents (never its path) to main, which checks name and size again. */
async function importResumeFile(file: File): Promise<ResumeImportResult> {
  if (!resumeExtensionOf(file.name)) {
    return { ok: false, cancelled: false, error: `${file.name}: Unsupported file type. Use .docx, .pdf, .txt or .md.` }
  }
  if (file.size > MAX_RESUME_BYTES) {
    return { ok: false, cancelled: false, error: `${file.name}: The file is larger than 20 MB.` }
  }
  const dropped: DroppedResume = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
  return ipcRenderer.invoke(IPC_CHANNELS.profileImportResumeFile, dropped)
}

export const profile: ProfileApi = {
  read: () => ipcRenderer.invoke(IPC_CHANNELS.profileRead),
  save: (doc, version) => ipcRenderer.invoke(IPC_CHANNELS.profileSave, doc, version),
  importResume: () => ipcRenderer.invoke(IPC_CHANNELS.profileImportResume),
  importResumeFile,
  openInEditor: () => ipcRenderer.invoke(IPC_CHANNELS.profileOpenInEditor),
  reveal: () => ipcRenderer.invoke(IPC_CHANNELS.profileReveal)
}
