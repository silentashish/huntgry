/**
 * Types shared by the main process, the preload bridge and the renderer.
 * Types, constants and pure helpers only: nothing in here may touch the filesystem.
 */

import type { MasterProfile, ProfileDocument, ResumeImportResult, SaveProfileResult } from './master-profile'

export type WorkspaceStatus =
  /** Master profile `master-profile.md` present (skill v3 layout), directory readable and writable. */
  | 'valid'
  /**
   * Recognised older layout: `master_profile.md` and/or application folders only.
   * Importable only when it has a master profile; otherwise Create adds one.
   */
  | 'legacy'
  /** Directory exists and holds nothing but ignorable noise (`.DS_Store`, `.git`, ...). Create allowed. */
  | 'empty'
  /** Path does not exist yet but its parent is a writable directory. Create allowed. */
  | 'missing'
  /** Non-empty directory with unrelated content. Create adds a workspace after confirmation; Import refuses. */
  | 'not-a-workspace'
  /**
   * Too large to classify: the bounded scan stopped before finding a master profile or
   * application folders. Neither Create nor Import will use it (it may be `~` or `/`).
   */
  | 'unverified'
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
  /** Skeleton files left alone because something already existed at that name. */
  skipped: string[]
  /** Set when the folder is not empty and Create needs `allowNonEmpty` to go ahead. */
  needsConfirmation?: boolean
  error?: string
}

export interface CreateOptions {
  /** Add the workspace files to a folder that already holds other content. Never overwrites. */
  allowNonEmpty?: boolean
}

export type PickMode = 'create' | 'import'

/** `window.huntgry.workspace`: picking, inspecting, creating and opening a workspace. */
export interface WorkspaceApi {
  /** Native folder picker. Resolves `null` when cancelled. */
  pickDirectory(mode: PickMode): Promise<string | null>
  /** Read-only inspection of a path. */
  inspect(path: string): Promise<WorkspaceInspection>
  /** Create a new workspace; never overwrites existing files. */
  create(path: string, options?: CreateOptions): Promise<CreateResult>
  /**
   * Import: inspect and, when it has a master profile, remember as current workspace.
   * Writes nothing inside the workspace.
   */
  open(path: string): Promise<WorkspaceInspection>
  /** Re-inspect the remembered workspace, or `null` when none has been chosen yet. */
  getCurrent(): Promise<WorkspaceInspection | null>
}

/** `window.huntgry.profile`: master profile of the current workspace. Main resolves the file; the renderer never sends paths. */
export interface ProfileApi {
  read(): Promise<ProfileDocument>
  /** `version` is the one returned by the last read/save; a mismatch means the file changed on disk. */
  save(profile: MasterProfile, version: string): Promise<SaveProfileResult>
  /** Pick a resume file and parse it into a draft. Nothing is written. */
  importResume(): Promise<ResumeImportResult>
  /** Open the Markdown file in the user's default editor. */
  openInEditor(): Promise<void>
  /** Reveal the Markdown file in Finder / Explorer. */
  reveal(): Promise<void>
}

export const IPC_CHANNELS = {
  pickDirectory: 'workspace:pick-directory',
  inspect: 'workspace:inspect',
  create: 'workspace:create',
  open: 'workspace:open',
  getCurrent: 'workspace:get-current',
  profileRead: 'profile:read',
  profileSave: 'profile:save',
  profileImportResume: 'profile:import-resume',
  profileOpenInEditor: 'profile:open-in-editor',
  profileReveal: 'profile:reveal'
} as const

/** Statuses that describe a recognised workspace layout. */
export const USABLE_STATUSES: readonly WorkspaceStatus[] = ['valid', 'legacy']

/** Statuses that Create can initialise without touching existing user content. */
export const CREATABLE_STATUSES: readonly WorkspaceStatus[] = ['missing', 'empty']

/** Import needs a recognised layout *and* a master profile at the root. */
export function canImport(inspection: WorkspaceInspection): boolean {
  return USABLE_STATUSES.includes(inspection.status) && inspection.masterProfile !== null
}

/**
 * How Create may proceed: `direct` for a missing or empty folder, `confirm` for a
 * folder with other content but no master profile (files are only added), or
 * `null` when Create must refuse.
 */
export function createMode(inspection: WorkspaceInspection): 'direct' | 'confirm' | null {
  if (CREATABLE_STATUSES.includes(inspection.status)) return 'direct'
  if (inspection.status === 'not-a-workspace') return 'confirm'
  if (inspection.status === 'legacy' && inspection.masterProfile === null) return 'confirm'
  return null
}
