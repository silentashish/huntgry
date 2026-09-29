import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { FILE_SCHEME } from '@shared/applications-types'
import { requireCurrentWorkspace } from '../current-workspace'
import { resolveApplicationFile } from './safe-path'
import { isServableFile, parseFileUrl } from './scan'

/**
 * `huntgry-file://app/<role>/<company>/<job-id>/<file>` serves files of the
 * current workspace's application folders (page images) to the sandboxed
 * renderer. Only known file names inside a valid application folder are
 * served; everything else is 404.
 */

/** Must run before `app.whenReady()`. */
export function registerFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

/** Call once the app is ready. */
export function handleFileScheme(): void {
  protocol.handle(FILE_SCHEME, async (request) => {
    const parsed = parseFileUrl(request.url)
    if (!parsed || !isServableFile(parsed.file)) return new Response('Not found', { status: 404 })
    try {
      const workspace = await requireCurrentWorkspace()
      // Resolves symlinks: only a regular file inside a real application folder of the workspace is served.
      const path = await resolveApplicationFile(workspace.path, parsed.id, parsed.file)
      return await net.fetch(pathToFileURL(path).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
