/**
 * Types shared by the main process, the preload bridge and the renderer.
 * Types and constants only: nothing in here may touch the filesystem.
 */

export type WorkspaceStatus =
  /** Master profile `master-profile.md` present (skill v3 layout), directory readable and writable. */
  | 'valid'
  /** Recognised older layout: `master_profile.md` and/or application folders only. Usable. */
  | 'legacy'
  /** Directory exists and holds nothing but ignorable noise (`.DS_Store`, `.git`, ...). Create allowed. */
  | 'empty'
  /** Path does not exist yet but its parent is a writable directory. Create allowed. */
  | 'missing'
  /** Non-empty directory with unrelated content. Neither Create nor Import will touch it. */
  | 'not-a-workspace'
  /** Not a directory, unreadable/unwritable, relative path, or parent missing. */
  | 'invalid'

export type WorkspaceLayout = 'v3' | 'legacy'

export interface WorkspaceInspection {
  /** Absolute path; symlinked roots are resolved to their real path. */
  path: string
  status: WorkspaceStatus
  /** Master profile filename found at the root, e.g. `master-profile.md`. */
  masterProfile: string | null
  layout: WorkspaceLayout | null
  /** Number of `<role>/<company>/<job-id>/` application folders found by the bounded scan. */
  applicationCount: number
  warnings: string[]
  errors: string[]
}

export interface CreateResult {
  ok: boolean
  inspection: WorkspaceInspection
  /** Paths (relative to the workspace root, `.` for the root itself) that were created. */
  created: string[]
  error?: string
}

export type PickMode = 'create' | 'import'

export interface HuntgryApi {
  workspace: {
    /** Native folder picker. Resolves `null` when cancelled. */
    pickDirectory(mode: PickMode): Promise<string | null>
    /** Read-only inspection of a path. */
    inspect(path: string): Promise<WorkspaceInspection>
    /** Create a new workspace; never overwrites existing files. */
    create(path: string): Promise<CreateResult>
    /** Import: inspect and remember as current workspace. Writes nothing inside the workspace. */
    open(path: string): Promise<WorkspaceInspection>
    /** Re-inspect the remembered workspace, or `null` when none has been chosen yet. */
    getCurrent(): Promise<WorkspaceInspection | null>
  }
}

export const IPC_CHANNELS = {
  pickDirectory: 'workspace:pick-directory',
  inspect: 'workspace:inspect',
  create: 'workspace:create',
  open: 'workspace:open',
  getCurrent: 'workspace:get-current'
} as const

/** Statuses that Import accepts as a usable workspace. */
export const USABLE_STATUSES: readonly WorkspaceStatus[] = ['valid', 'legacy']

/** Statuses that Create can initialise without touching existing user content. */
export const CREATABLE_STATUSES: readonly WorkspaceStatus[] = ['missing', 'empty']
