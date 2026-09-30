/**
 * Puts a local file into a page's `<input type=file>` over the Chrome DevTools
 * Protocol, the way Puppeteer's `uploadFile` does: a page cannot do this
 * itself, and the page never sees the path. The debugger is attached only for
 * these three commands and always detached afterwards, also on error.
 */

/** The part of Electron's `Debugger` this needs. */
export interface Cdp {
  sendCommand(method: string, params?: object): Promise<unknown>
  isAttached(): boolean
  detach(): void
}

export const UPLOAD_TIMEOUT_MS = 10_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The page did not respond to the upload.')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const nodeIdOf = (result: unknown, path: 'root' | 'self'): number => {
  const r = result as { root?: { nodeId?: unknown }; nodeId?: unknown } | null
  const id = path === 'root' ? r?.root?.nodeId : r?.nodeId
  return typeof id === 'number' ? id : 0
}

/** Attaches `files` to the element matching `selector` in the top frame. */
export async function uploadFile(
  attach: () => Cdp,
  selector: string,
  files: string[],
  timeoutMs = UPLOAD_TIMEOUT_MS
): Promise<void> {
  const dbg = attach()
  try {
    const root = nodeIdOf(await withTimeout(dbg.sendCommand('DOM.getDocument', { depth: 0 }), timeoutMs), 'root')
    if (!root) throw new Error('Could not read the page.')
    const nodeId = nodeIdOf(
      await withTimeout(dbg.sendCommand('DOM.querySelector', { nodeId: root, selector }), timeoutMs),
      'self'
    )
    if (!nodeId) throw new Error('The upload field is no longer on the page.')
    await withTimeout(dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files }), timeoutMs)
  } finally {
    try {
      if (dbg.isAttached()) dbg.detach()
    } catch {
      // The page went away meanwhile; nothing is attached any more.
    }
  }
}
