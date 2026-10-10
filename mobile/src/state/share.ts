/**
 * Hands a verified application file to the OS viewer (#40): written to the app's cache
 * sandbox, then opened with the share sheet (Quick Look / "Open in…" on iOS, the chooser on
 * Android). The sandbox copies are deleted when the app starts, and when it comes back to the
 * foreground once they are a few minutes old (`SHARE_GRACE_MS`: the app that received one may
 * still be reading it after Huntgry is back); the bytes themselves stay in memory only. On the web (demo, screenshots) the file opens in a new tab.
 */

import { Directory, File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { Platform } from 'react-native'

const DIR = 'huntgry-files'

/** How long a copy handed over stays when the app comes back to the foreground. */
export const SHARE_GRACE_MS = 5 * 60_000

/** When each copy of this launch was handed to the viewer (file name → ms). */
const handedAt = new Map<string, number>()

const UTI: Record<string, string> = { 'application/pdf': 'com.adobe.pdf', 'image/jpeg': 'public.jpeg', 'text/markdown': 'net.daringfireball.markdown' }

/** "Figma · EM, Platform" + "resume.pdf" → "figma-em-platform-resume.pdf" */
export function shareName(title: string, file: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug ? `${slug}-${file}` : file
}

export async function openFile(name: string, data: Uint8Array, mimeType: string): Promise<void> {
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mimeType }))
    globalThis.open?.(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return
  }
  if (!(await Sharing.isAvailableAsync())) throw new Error('This phone cannot open files from Huntgry.')
  const dir = new Directory(Paths.cache, DIR)
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
  const file = new File(dir, name)
  if (file.exists) file.delete()
  file.create()
  file.write(data)
  handedAt.set(name, Date.now())
  await Sharing.shareAsync(file.uri, { mimeType, UTI: UTI[mimeType], dialogTitle: name })
}

/**
 * Deletes the copies handed to the OS viewer: all of them (at launch), or with `graceMs` only
 * those handed over longer ago than that (on returning to the foreground).
 */
export function clearSharedFiles(graceMs = 0, now = Date.now()): void {
  if (Platform.OS === 'web') return
  try {
    const dir = new Directory(Paths.cache, DIR)
    if (!dir.exists) return
    if (graceMs <= 0) {
      dir.delete()
      handedAt.clear()
      return
    }
    for (const entry of dir.list()) {
      const at = handedAt.get(entry.name)
      if (at !== undefined && now - at < graceMs) continue
      entry.delete()
      handedAt.delete(entry.name)
    }
  } catch {
    // Nothing there, or already gone.
  }
}
