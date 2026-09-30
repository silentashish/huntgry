import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { rememberWorkspace, seedWorkspace, type FixtureWorkspace } from './workspace'

export { expect }

/**
 * Launches the built app (`out/main/index.js`) in a sandbox: a fresh
 * `--user-data-dir`, a temp `HOME`, a PATH that holds only a temp bin folder
 * plus the system folders, and no inherited environment. See
 * docs/testing/e2e.md for the isolation model and the variables set here.
 */

const ROOT = resolve(__dirname, '../..')
const MAIN_ENTRY = join(ROOT, 'out/main/index.js')

/** System folders Electron and its helpers need; none of them holds a user-installed agent CLI. */
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

export interface Sandbox {
  /** Parent of everything below; removed after the test. */
  root: string
  /** `--user-data-dir`: settings.json, browser partitions, skill-install.json. */
  userData: string
  /** `HOME` of the app: `~/.claude`, `~/.local/bin`, `~/Library` all resolve below it. */
  home: string
  /** First PATH entry; a test drops a fake `claude`/`codex`/`agy` here to have it found. */
  bin: string
  /** Where `seedWorkspace` copies fixture workspaces. */
  workspaces: string
}

/** Every sandbox created by this worker, for the leak check in the worker fixture below. */
const created: string[] = []

export async function createSandbox(): Promise<Sandbox> {
  // macOS temp paths are symlinks (/var → /private/var); the app reports real paths, so resolve once here.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'huntgry-e2e-')))
  const sandbox: Sandbox = {
    root,
    userData: join(root, 'user-data'),
    home: join(root, 'home'),
    bin: join(root, 'bin'),
    workspaces: join(root, 'workspaces')
  }
  await Promise.all(Object.values(sandbox).map((dir) => mkdir(dir, { recursive: true })))
  created.push(root)
  return sandbox
}

export async function destroySandbox(sandbox: Sandbox): Promise<void> {
  await rm(sandbox.root, { recursive: true, force: true })
}

/** The environment the app runs with. Nothing from the runner's own environment is inherited. */
export function appEnv(sandbox: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: sandbox.home,
    USER: process.env.USER ?? 'huntgry',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'huntgry',
    TMPDIR: join(sandbox.root, 'tmp'),
    LANG: 'en_US.UTF-8',
    SHELL: '/bin/sh',
    PATH: `${sandbox.bin}:${SYSTEM_PATH}`,
    HUNTGRY_E2E: '1',
    HUNTGRY_ALLOW_LOCAL_URLS: '1',
    ...extra
  }
}

export interface LaunchedApp {
  electronApp: ElectronApplication
  window: Page
  /** Main-process stderr so far (also stdout), for failure reports. */
  output(): string
}

/**
 * Quits the app the way the fixture does. Windows are destroyed first, which
 * skips `beforeunload`: an editor left with unsaved edits would otherwise raise
 * the native "unsaved changes" question (`showMessageBoxSync`, stubbed here as
 * a second guard) and Playwright's own beforeunload handling would race it. A
 * process that still has not exited after `timeoutMs` is killed so the sandbox
 * can be removed.
 */
export async function closeApp(electronApp: ElectronApplication, timeoutMs = 15_000): Promise<void> {
  await electronApp
    .evaluate(({ BrowserWindow, dialog }) => {
      dialog.showMessageBoxSync = () => 0
      for (const win of BrowserWindow.getAllWindows()) win.destroy()
    })
    .catch(() => {})
  const child = electronApp.process()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const outcome = await Promise.race([electronApp.close().then(() => 'closed' as const), timeout]).catch(() => 'closed' as const)
  clearTimeout(timer)
  if (outcome === 'timeout') {
    child.kill('SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

export async function launchApp(sandbox: Sandbox, extraEnv: Record<string, string> = {}): Promise<LaunchedApp> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `Build output missing (${MAIN_ENTRY}). Run \`npm run build\` first, or \`npm run test:e2e\`, which builds before testing.`
    )
  }
  await mkdir(join(sandbox.root, 'tmp'), { recursive: true })
  const electronApp = await _electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${sandbox.userData}`],
    env: appEnv(sandbox, extraEnv),
    cwd: ROOT
  })
  const chunks: string[] = []
  electronApp.process().stderr?.on('data', (d: Buffer) => chunks.push(d.toString()))
  electronApp.process().stdout?.on('data', (d: Buffer) => chunks.push(d.toString()))
  const window = await electronApp.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  return { electronApp, window, output: () => chunks.join('') }
}

export interface AppFixture extends LaunchedApp {
  sandbox: Sandbox
  /** Shorthands for the sandbox folders. */
  userData: string
  home: string
  /** Path of the seeded workspace when the test used `test.use({ workspace })`, else `null`. */
  workspace: string | null
  /** Quits the app and starts it again with the same userData and HOME (what a user's relaunch does). */
  relaunch(): Promise<void>
}

export interface AppOptions {
  /**
   * Fixture workspace to seed and remember in settings.json before the first
   * launch, so the app starts in the shell (or in profile setup when the
   * profile is empty). `null` starts on the workspace picker.
   */
  workspace: FixtureWorkspace | null
}

export const test = base.extend<AppOptions & { app: AppFixture }, { sandboxAudit: void }>({
  workspace: [null, { option: true }],

  app: async ({ workspace }, use, testInfo) => {
    const sandbox = await createSandbox()
    let seeded: string | null = null
    if (workspace) {
      seeded = await seedWorkspace(workspace, sandbox.workspaces)
      await rememberWorkspace(sandbox.userData, seeded)
    }
    let current = await launchApp(sandbox)
    const fixture: AppFixture = {
      get electronApp() {
        return current.electronApp
      },
      get window() {
        return current.window
      },
      output: () => current.output(),
      sandbox,
      userData: sandbox.userData,
      home: sandbox.home,
      workspace: seeded,
      relaunch: async () => {
        await closeApp(current.electronApp)
        current = await launchApp(sandbox)
      }
    }
    try {
      await use(fixture)
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus
      if (failed) {
        // Playwright's own screenshot-on-failure runs after this teardown, when the window is gone: take it here.
        const path = testInfo.outputPath('test-failed-1.png')
        await current.window
          .screenshot({ path })
          .then(() => testInfo.attach('screenshot', { path, contentType: 'image/png' }))
          .catch(() => {})
      }
      const output = current.output()
      await closeApp(current.electronApp)
      if (failed && output.trim()) {
        await testInfo.attach('main-process-output', { body: output, contentType: 'text/plain' })
        console.error(`\n[main process output for "${testInfo.title}"]\n${output}`)
      }
      await destroySandbox(sandbox)
    }
  },

  // After the worker's last test: every sandbox this worker created must be gone.
  sandboxAudit: [
    async ({}, use) => {
      await use()
      const leaked = created.filter((dir) => existsSync(dir))
      if (leaked.length > 0) throw new Error(`Sandboxes were not removed: ${leaked.join(', ')}`)
    },
    { scope: 'worker', auto: true }
  ]
})
