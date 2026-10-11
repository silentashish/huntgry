import { basename, extname, isAbsolute } from 'node:path'
import type { ResumeImportResult } from '@shared/master-profile'
import { readResumeLines, RESUME_EXTENSIONS, ResumeReadError } from '../resume/extract'
import { parseResume } from '../resume/parse'

/** Reads and parses a resume the user chose (picked or dropped) into a profile draft. Nothing is written. */
export async function importResumeFrom(file: string): Promise<ResumeImportResult> {
  try {
    const { profile, warnings } = parseResume(await readResumeLines(file))
    return { ok: true, fileName: basename(file), profile, warnings }
  } catch (err) {
    const reason = err instanceof ResumeReadError ? err.message : 'The file could not be read as a resume.'
    console.error('Resume import failed:', err)
    return { ok: false, cancelled: false, error: `${basename(file)}: ${reason}` }
  }
}

/**
 * Checks the path of a resume dropped on the window. The preload resolves it from
 * the dropped `File` (renderer code cannot forge one), but IPC input stays untrusted:
 * only an absolute path to one of the resume formats is accepted.
 */
export function droppedResumePath(input: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof input !== 'string' || input === '' || !isAbsolute(input)) {
    return { ok: false, error: 'Only files from this computer can be imported.' }
  }
  const ext = extname(input).slice(1).toLowerCase()
  if (!(RESUME_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, error: `${basename(input)}: Unsupported file type. Use .docx, .pdf, .txt or .md.` }
  }
  return { ok: true, path: input }
}
