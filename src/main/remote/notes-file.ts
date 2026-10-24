import { REVIEW_NOTES_FILE, TAILORING_NOTES_FILE } from '@shared/review-types'
import { resolveApplicationFile, resolveApplicationFolder } from '../applications/safe-path'
import { hasNotesV2 } from '../review/notes-file'

/**
 * The phone's file resolver (#42, #158). The phone protocol names the notes `review-notes.md`;
 * results since #158 carry `tailoring-notes.md` v2 instead. When the phone asks for
 * `review-notes.md` and the folder has none but has v2 tailoring notes, it gets those, so the
 * protocol (`src/shared/remote/*`) stays as it is. Every other file resolves as before.
 */
export async function resolveRemoteFile(workspace: string, id: string, file: string): Promise<string> {
  if (file !== REVIEW_NOTES_FILE) return resolveApplicationFile(workspace, id, file)
  try {
    return await resolveApplicationFile(workspace, id, file)
  } catch (err) {
    const folder = await resolveApplicationFolder(workspace, id)
    if (!(await hasNotesV2(folder))) throw err
    return resolveApplicationFile(workspace, id, TAILORING_NOTES_FILE)
  }
}
