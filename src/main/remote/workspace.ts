import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { HUNTGRY_DIR } from '../workspace/constants'
import { writeDurable } from './durable'

/**
 * What a phone may know about the open workspace (ADR-0001, "Workspace binding"): a random
 * id, generated on first remote use and kept in `<workspace>/.huntgry/remote.json`, and the
 * folder's display name. Never the path.
 */

export interface WorkspaceIdentity {
  path: string
  id: string
  name: string
}

export const REMOTE_FILE = 'remote.json'

export const remoteFile = (workspace: string): string => join(workspace, HUNTGRY_DIR, REMOTE_FILE)

/** One read-or-mint per workspace at a time: concurrent first uses must not mint two ids. */
const pending = new Map<string, Promise<WorkspaceIdentity>>()

export function workspaceIdentity(workspace: string): Promise<WorkspaceIdentity> {
  let p = pending.get(workspace)
  if (!p) {
    p = readOrMint(workspace).finally(() => pending.delete(workspace))
    pending.set(workspace, p)
  }
  return p
}

async function readOrMint(workspace: string): Promise<WorkspaceIdentity> {
  const file = remoteFile(workspace)
  const name = basename(workspace) || 'Workspace'
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { workspaceId?: unknown }
    if (typeof parsed.workspaceId === 'string' && /^[0-9a-f]{32}$/.test(parsed.workspaceId)) {
      return { path: workspace, id: parsed.workspaceId, name }
    }
  } catch {
    // Missing or broken: mint a new id below.
  }
  const id = randomBytes(16).toString('hex')
  await mkdir(join(workspace, HUNTGRY_DIR), { recursive: true })
  await writeDurable(file, `${JSON.stringify({ version: 1, workspaceId: id }, null, 2)}\n`, 0o644)
  return { path: workspace, id, name }
}
