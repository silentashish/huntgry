import { basename } from 'node:path'
import { MAX_RESUME_BYTES, resumeExtensionOf, type ResumeImportResult } from '@shared/master-profile'
import type { ResumeLine } from '../resume/types'
import { readResumeBuffer, readResumeLines, ResumeReadError } from '../resume/extract'
import { parseResume } from '../resume/parse'

async function importLines(fileName: string, read: () => Promise<ResumeLine[]>): Promise<ResumeImportResult> {
  try {
    const { profile, warnings } = parseResume(await read())
    return { ok: true, fileName, profile, warnings }
  } catch (err) {
    const reason = err instanceof ResumeReadError ? err.message : 'The file could not be read as a resume.'
    console.error('Resume import failed:', err)
    return { ok: false, cancelled: false, error: `${fileName}: ${reason}` }
  }
}

/** Reads and parses a resume picked in the native dialog (main chose the path) into a draft. Nothing is written. */
export function importResumeFrom(file: string): Promise<ResumeImportResult> {
  return importLines(basename(file), () => readResumeLines(file))
}

const refuse = (error: string): ResumeImportResult => ({ ok: false, cancelled: false, error })

/**
 * Parses a resume dropped on the window from the bytes the window sent. No path
 * crosses IPC and nothing is read from disk: `name` is only used for its extension
 * (allow-listed, case-insensitive) and in messages. IPC input is untrusted, so
 * the shape and the size cap are checked again here.
 */
export function importDroppedResume(input: unknown): Promise<ResumeImportResult> {
  const { name, bytes } = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  if (typeof name !== 'string' || !(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)) {
    return Promise.resolve(refuse('The dropped file could not be read.'))
  }
  // Display name only: drop anything that looks like a folder part.
  const fileName = name.split(/[\\/]/).pop() || 'resume'
  const ext = resumeExtensionOf(fileName)
  if (!ext) return Promise.resolve(refuse(`${fileName}: Unsupported file type. Use .docx, .pdf, .txt or .md.`))
  if (bytes.byteLength > MAX_RESUME_BYTES) return Promise.resolve(refuse(`${fileName}: The file is larger than 20 MB.`))
  const buf = bytes instanceof ArrayBuffer ? Buffer.from(bytes) : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return importLines(fileName, () => readResumeBuffer(buf, ext))
}

/** The parts of an IPC event the sender check needs (Electron's `IpcMainInvokeEvent`). */
export interface SenderEvent {
  sender: unknown
  senderFrame: { processId: number; routingId: number } | null
}

/**
 * True only for the top frame of the app window's own webContents. In-app browser
 * tabs (job sites) have their own webContents and never pass, nor do subframes.
 */
export function isAppWindowTopFrame(
  event: SenderEvent,
  appContents: { mainFrame: { processId: number; routingId: number } } | null | undefined
): boolean {
  if (!appContents || event.sender !== appContents || !event.senderFrame) return false
  const top = appContents.mainFrame
  return event.senderFrame.processId === top.processId && event.senderFrame.routingId === top.routingId
}
