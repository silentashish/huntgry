import { watch, type FSWatcher } from 'node:fs'

/**
 * Watches one workspace (recursively; FSEvents on macOS) and calls `onChange`
 * at most once per `delayMs` burst. Changes to hidden entries (`.huntgry`,
 * `.git`, temp files) are ignored.
 */
export class WorkspaceWatcher {
  private watcher: FSWatcher | null = null
  private path: string | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    private onChange: () => void,
    private delayMs = 600
  ) {}

  /** Starts watching `path`, replacing any previous workspace. No-op if already watching it. */
  watch(path: string): void {
    if (this.path === path && this.watcher) return
    this.close()
    this.path = path
    try {
      this.watcher = watch(path, { recursive: true }, (_event, name) => {
        if (name && isHidden(String(name))) return
        this.schedule()
      })
      this.watcher.on('error', () => this.close())
    } catch {
      // Recursive watch unsupported or folder gone: the dashboard still refreshes on focus.
      this.watcher = null
    }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
    this.path = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.onChange()
    }, this.delayMs)
  }
}

/** Any path segment starting with a dot. */
export function isHidden(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((p) => p.startsWith('.'))
}
