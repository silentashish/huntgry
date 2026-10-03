import type { UploadState } from '../apply-types'
import type { UploadProbe } from './adapters/types'

/**
 * Default `Adapter.uploadAttached`: the input holds a file, or (the site
 * removed the input) its upload widget shows the file name; a progress bar
 * there means the site is still uploading.
 */
export function defaultUploadAttached({ input, group, fileName }: UploadProbe): UploadState {
  if (input?.isConnected && (input.files?.length ?? 0) > 0) return 'attached'
  if (group?.isConnected) {
    if ((group.textContent ?? '').includes(fileName)) return 'attached'
    if (group.querySelector('[role="progressbar"]')) return 'pending'
  }
  return 'missing'
}
