import { BrowserWindow } from 'electron'
import type { EventChannel, HuntgryEvents } from '@shared/events'

type Listener = <K extends EventChannel>(channel: K, payload: HuntgryEvents[K]) => void

const listeners = new Set<Listener>()

/** Sends a typed event to every open window (see `src/shared/events.ts`) and to every `onEvent` listener. */
export function emit<K extends EventChannel>(channel: K, payload: HuntgryEvents[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
  for (const listener of listeners) {
    try {
      listener(channel, payload)
    } catch (err) {
      console.error(`Event listener for ${channel} failed:`, err)
    }
  }
}

/**
 * A second consumer of the same events the renderer gets (the remote gateway, ADR-0001):
 * it sees exactly the payloads the windows see. Returns the unsubscribe function.
 */
export function onEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
