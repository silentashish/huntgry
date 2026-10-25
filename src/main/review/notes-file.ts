import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { NOTES_V2_MARKER, REVIEW_NOTES_FILE, TAILORING_NOTES_FILE, type NotesFormat, type ReviewNotes } from '@shared/review-types'
import { parseReviewNotes, parseTailoringNotes } from './notes'

/**
 * Which notes file of an application folder Review reads (#158): `tailoring-notes.md` when it
 * carries the v2 marker, else `review-notes.md` (v1, older unattended results), else a
 * `tailoring-notes.md` without the marker (read so its raw text shows, with a parse warning).
 * One place for the verify gate, the Review service, the scan and the phone's file mapping.
 */

/** Largest notes file read; bigger ones are reported, not parsed. */
export const MAX_NOTES_BYTES = 256 * 1024

/** Bytes read from the top of `tailoring-notes.md` to look for the v2 marker. */
const MARKER_PROBE_BYTES = 1024

export type NotesFileName = typeof REVIEW_NOTES_FILE | typeof TAILORING_NOTES_FILE

export interface ResultNotes {
  file: NotesFileName
  format: NotesFormat
  /** The text, or `null` when the file is larger than the limit (`tooLarge` holds its size). */
  text: string | null
  tooLarge?: number
}

/** A text file read only when it is at most `max` bytes: `{ text }`, `{ tooLarge }` or `null` when missing. */
export async function boundedText(path: string, max: number): Promise<{ text: string } | { tooLarge: number } | null> {
  const s = await stat(path).catch(() => null)
  if (!s || !s.isFile()) return null
  if (s.size > max) return { tooLarge: s.size }
  const text = await readFile(path, 'utf8').catch(() => null)
  return text === null ? null : { text }
}

/** Whether `tailoring-notes.md` in `folder` is a v2 file (reads its first KiB only). */
export async function hasNotesV2(folder: string): Promise<boolean> {
  let handle
  try {
    handle = await open(join(folder, TAILORING_NOTES_FILE), 'r')
    if (!(await handle.stat()).isFile()) return false
    const buf = Buffer.alloc(MARKER_PROBE_BYTES)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead).toString('utf8').includes(NOTES_V2_MARKER)
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Which notes file `folder` carries (see above), or `null`. `files` limits the look to listed names. */
export async function notesFileOf(folder: string, files?: readonly string[]): Promise<{ file: NotesFileName; format: NotesFormat } | null> {
  const listed = (name: string) => !files || files.includes(name)
  if (listed(TAILORING_NOTES_FILE) && (await hasNotesV2(folder))) return { file: TAILORING_NOTES_FILE, format: 'v2' }
  if (listed(REVIEW_NOTES_FILE) && (await stat(join(folder, REVIEW_NOTES_FILE)).catch(() => null))?.isFile())
    return { file: REVIEW_NOTES_FILE, format: 'v1' }
  if (listed(TAILORING_NOTES_FILE) && (await stat(join(folder, TAILORING_NOTES_FILE)).catch(() => null))?.isFile())
    return { file: TAILORING_NOTES_FILE, format: 'v2' }
  return null
}

/** The notes of a result, read (bounded), or `null` when it has none. */
export async function readResultNotes(folder: string, files?: readonly string[], max = MAX_NOTES_BYTES): Promise<ResultNotes | null> {
  const which = await notesFileOf(folder, files)
  if (!which) return null
  const read = await boundedText(join(folder, which.file), max)
  if (!read) return null
  return 'text' in read ? { ...which, text: read.text } : { ...which, text: null, tooLarge: read.tooLarge }
}

export function parseResultNotes(notes: Pick<ResultNotes, 'format' | 'text'>): ReviewNotes {
  return notes.format === 'v2' ? parseTailoringNotes(notes.text ?? '') : parseReviewNotes(notes.text ?? '')
}
