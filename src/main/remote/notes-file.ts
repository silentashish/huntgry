import { REVIEW_NOTES_FILE, TAILORING_NOTES_FILE } from '@shared/review-types'
import { resolveApplicationFile, resolveApplicationFolder } from '../applications/safe-path'
import { hasNotesV2, notesFileOf } from '../review/notes-file'

/**
 * The phone's file resolver (#42, #158). The phone protocol names the notes `review-notes.md`;
 * results since #158 carry `tailoring-notes.md` v2 instead. A request for `review-notes.md` gets
 * the notes the Review detail reads (`notesFileOf`: v2 with its marker first, then v1), so the
 * file always matches the gaps, reframings and revision the phone was shown, also in a folder of an
 * older v1 result continued since (both files). Free-form tailoring notes are never served. The
 * protocol (`src/shared/remote/*`) stays as it is; every other file resolves as before.
 */
export async function resolveRemoteFile(workspace: string, id: string, file: string): Promise<string> {
  if (file !== REVIEW_NOTES_FILE) return resolveApplicationFile(workspace, id, file)
  const folder = await resolveApplicationFolder(workspace, id)
  const notes = await notesFileOf(folder)
  if (notes?.file === TAILORING_NOTES_FILE && (await hasNotesV2(folder))) return resolveApplicationFile(workspace, id, TAILORING_NOTES_FILE)
  // v1 notes, or none (the usual "does not exist" refusal).
  return resolveApplicationFile(workspace, id, REVIEW_NOTES_FILE)
}
