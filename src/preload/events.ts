import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENT_CHANNELS, type EventChannel, type Subscribe } from '@shared/events'

/** Allowlisted main → renderer subscriptions; the renderer never sees `ipcRenderer` itself. */
export const on: Subscribe = (channel, listener) => {
  if (!EVENT_CHANNELS.includes(channel as EventChannel)) {
    throw new Error(`Unknown event channel: ${String(channel)}`)
  }
  const handler = (_event: IpcRendererEvent, payload: unknown) => listener(payload as never)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}
