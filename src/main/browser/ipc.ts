import { ipcMain } from 'electron'
import { BROWSER_CHANNELS } from '@shared/browser-types'
import { browserManager } from './manager'
import { requireRect, requireTabId, requireText } from './validate'

/**
 * The embedded browser. The renderer sends URLs, tab ids and a rectangle only;
 * sessions, webPreferences and pages stay in main.
 */
export function registerBrowserIpc(): void {
  const m = browserManager
  ipcMain.handle(BROWSER_CHANNELS.state, () => m().state())
  ipcMain.handle(BROWSER_CHANNELS.open, (_e, url: unknown, opts: unknown) => {
    const activate = (opts as { activate?: unknown } | undefined)?.activate !== false
    return m().open(requireText(url ?? ''), activate)
  })
  ipcMain.handle(BROWSER_CHANNELS.close, (_e, id: unknown) => m().close(requireTabId(id)))
  ipcMain.handle(BROWSER_CHANNELS.activate, (_e, id: unknown) => m().activate(requireTabId(id)))
  ipcMain.handle(BROWSER_CHANNELS.navigate, (_e, id: unknown, input: unknown) =>
    m().navigate(requireTabId(id), requireText(input))
  )
  ipcMain.handle(BROWSER_CHANNELS.back, (_e, id: unknown) => m().back(requireTabId(id)))
  ipcMain.handle(BROWSER_CHANNELS.forward, (_e, id: unknown) => m().forward(requireTabId(id)))
  ipcMain.handle(BROWSER_CHANNELS.reload, (_e, id: unknown) => m().reload(requireTabId(id)))
  ipcMain.handle(BROWSER_CHANNELS.stop, (_e, id: unknown) => m().stop(requireTabId(id)))
  ipcMain.handle(BROWSER_CHANNELS.openExternal, (_e, id: unknown) => m().openExternal(requireTabId(id)))
  ipcMain.handle(BROWSER_CHANNELS.setBounds, (_e, rect: unknown) => m().setBounds(requireRect(rect)))
  ipcMain.handle(BROWSER_CHANNELS.setVisible, (_e, visible: unknown) => m().setVisible(visible === true))
}
