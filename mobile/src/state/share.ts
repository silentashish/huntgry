/**
 * Hands a verified application file to the OS viewer (#40): written to the app's cache
 * sandbox, then opened with the share sheet (Quick Look / "Open in…" on iOS, the chooser on
 * Android). The sandbox copies are deleted when the app starts and when it comes back to the
 * foreground, so nothing outlives the moment it was opened; the bytes themselves stay in
 * memory only. On the web (demo, screenshots) the file opens in a new tab.
 */

import { Directory, File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { Platform } from 'react-native'

const DIR = 'huntgry-files'

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
  await Sharing.shareAsync(file.uri, { mimeType, UTI: UTI[mimeType], dialogTitle: name })
}

/** Deletes every copy handed to the OS viewer. */
export function clearSharedFiles(): void {
  if (Platform.OS === 'web') return
  try {
    const dir = new Directory(Paths.cache, DIR)
    if (dir.exists) dir.delete()
  } catch {
    // Nothing there, or already gone.
  }
}
