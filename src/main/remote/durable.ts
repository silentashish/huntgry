import { randomBytes } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Replaces `file` with `text` so that, once this resolves, a power loss leaves either the old
 * or the new content: the temp file is fsynced before the rename and the directory after it.
 * A rename alone is atomic but not durable (the outgoing `seq` reservation relies on this).
 */
export async function writeDurable(file: string, text: string, mode = 0o600): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  const handle = await open(tmp, 'w', mode)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } catch (err) {
    await handle.close().catch(() => undefined)
    await rm(tmp, { force: true })
    throw err
  }
  await handle.close()
  await rename(tmp, file)
  await syncDir(dirname(file))
}

/** fsyncs a directory so a rename or create in it survives a crash (no-op where unsupported). */
export async function syncDir(dir: string): Promise<void> {
  let handle
  try {
    handle = await open(dir, 'r')
  } catch {
    return // Windows cannot open a directory; NTFS journals the rename itself.
  }
  try {
    await handle.sync()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'EPERM' && code !== 'EISDIR') throw err
  } finally {
    await handle.close()
  }
}
