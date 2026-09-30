import { cp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ElectronApplication } from '@playwright/test'

/**
 * Fixture workspaces (e2e/fixtures/workspaces/<name>) and the two things every
 * flow needs around them: a copy in the sandbox, and the app remembering it
 * before launch. Plus stubs for the native dialogs Playwright cannot drive.
 */

export const FIXTURE_WORKSPACES = ['empty-profile', 'demo', 'legacy', 'not-a-workspace'] as const
export type FixtureWorkspace = (typeof FIXTURE_WORKSPACES)[number]

const FIXTURES = resolve(__dirname, 'workspaces')
const RESUMES = resolve(__dirname, 'resumes')

/** Copies `e2e/fixtures/workspaces/<name>` into `into/<name>` (dot folders included) and returns its real path. */
export async function seedWorkspace(name: FixtureWorkspace, into: string, as: string = name): Promise<string> {
  const target = join(into, as)
  await cp(join(FIXTURES, name), target, { recursive: true })
  return realpath(target)
}

/** Path of a committed sample resume (`sample-resume.docx`, `sample-resume.pdf`). */
export function resumeFixture(file: 'sample-resume.docx' | 'sample-resume.pdf'): string {
  return join(RESUMES, file)
}

/**
 * Writes `<userData>/settings.json` so the app starts with `path` open, the
 * way it does after a user picked a workspace once. Call before launch.
 */
export async function rememberWorkspace(userData: string, path: string, extra: Record<string, unknown> = {}): Promise<void> {
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ currentWorkspace: path, ...extra }, null, 2))
}

/**
 * Replaces `dialog.showOpenDialog` in the main process: the next calls resolve
 * with `filePaths` (or as cancelled when `null`). The workspace picker and the
 * resume import both go through it.
 */
export async function stubOpenDialog(electronApp: ElectronApplication, filePaths: string[] | null): Promise<void> {
  await electronApp.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: paths === null, filePaths: paths ?? [] })
  }, filePaths)
}

/** Replaces `dialog.showMessageBoxSync` (the unsaved-profile question on close) with a fixed button index. */
export async function stubMessageBox(electronApp: ElectronApplication, response: number): Promise<void> {
  await electronApp.evaluate(({ dialog }, index) => {
    dialog.showMessageBoxSync = () => index
  }, response)
}
