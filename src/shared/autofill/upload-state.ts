import type { UploadState } from '../apply-types'
import type { UploadProbe } from './adapters/types'

/**
 * What a site's upload widget (`group`) shows: the file name means the site
 * took the file, a progress bar that it is still uploading. Says nothing
 * about the native input: CDP fills `input.files` even when the site's
 * handler never ran or rejected the file.
 */
export function widgetState(group: Element | null, fileName: string): UploadState {
  if (!group?.isConnected) return 'missing'
  if ((group.textContent ?? '').includes(fileName)) return 'attached'
  if (group.querySelector('[role="progressbar"]')) return 'pending'
  return 'missing'
}

/**
 * Default `Adapter.uploadAttached`, for plain forms that keep the file in a
 * native input until the person submits: the widget's evidence first, then
 * the input holding a file. ATS adapters whose widget reacts to the file
 * (Greenhouse, Lever) must not use the input fallback.
 */
export function defaultUploadAttached({ input, group, fileName }: UploadProbe): UploadState {
  const widget = widgetState(group, fileName)
  if (widget !== 'missing') return widget
  if (input?.isConnected && (input.files?.length ?? 0) > 0) return 'attached'
  return 'missing'
}
