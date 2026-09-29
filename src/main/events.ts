import { BrowserWindow } from 'electron'
import type { EventChannel, HuntgryEvents } from '@shared/events'

/** Sends a typed event to every open window (see `src/shared/events.ts`). */
export function emit<K extends EventChannel>(channel: K, payload: HuntgryEvents[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
