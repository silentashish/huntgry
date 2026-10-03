import { app, Notification } from 'electron'

/**
 * macOS notifications and the dock badge for the pipeline. Notifications
 * need a signed app to show (dev builds may not); nothing here throws.
 */

export type NotificationCategory = 'needs-reply' | 'usage-limit' | 'pipeline-finished' | 'needs-review' | 'failed' | 'budget'

export function notify(_category: NotificationCategory, title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return
    new Notification({ title, body, silent: false }).show()
  } catch (err) {
    console.warn('Notification failed:', err)
  }
}

export function setBadge(count: number): void {
  try {
    if (process.platform !== 'darwin') return
    app.dock?.setBadge(count > 0 ? String(count) : '')
  } catch (err) {
    console.warn('Dock badge failed:', err)
  }
}
