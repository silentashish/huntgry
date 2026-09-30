# End-to-end tests (Playwright + Electron)

The e2e suite drives the **built** app, `out/main/index.js`, through
[Playwright's Electron API](https://playwright.dev/docs/api/class-electron): one app instance
per test, in a sandbox that the machine it runs on cannot leak into and that leaves nothing
behind. Pure logic stays in vitest (`npm test`); e2e covers what depends on wiring: preload,
IPC, the filesystem, dialogs and the real renderer.

## Running

```bash
npm run test:e2e                                   # electron-vite build, then the whole suite (~20 s after the build)
npx playwright test -c e2e/playwright.config.ts    # the suite without rebuilding (after any `npm run build`)
npx playwright test -c e2e/playwright.config.ts e2e/tests/workspace.spec.ts -g "legacy"   # one file / one test
npm run test:e2e:ui                                # Playwright's UI mode: pick tests, watch, time-travel
npx playwright show-report e2e/.results/html-report
```

Requirements: `npm install` (Playwright needs no browser download; it launches the Electron
binary from `node_modules`) and macOS, the app's primary target. The suite talks to nothing
but the local machine: no job board, ATS or agent vendor is ever reached.

`npm test` stays vitest only. `npm run typecheck` includes `typecheck:e2e` (`e2e/tsconfig.json`,
Node types plus the DOM lib Playwright's page types need, kept out of `tsconfig.node.json`).

## Isolation model

`e2e/fixtures/app.ts` creates a **sandbox** per test and launches the app inside it:

```
<tmp>/huntgry-e2e-XXXXXX/          the sandbox, removed after the test
├── user-data/                     --user-data-dir: settings.json, browser partitions, skill-install.json
├── home/                          HOME: ~/.claude, ~/.local/bin, ~/Library/… all resolve here
├── bin/                           first PATH entry; tests drop fake `claude`/`codex`/`agy` here
├── workspaces/                    seedWorkspace() copies fixture workspaces here
└── tmp/                           TMPDIR
```

The app gets a **fresh environment**, not the runner's. Everything it sees:

| Variable | Value | Why |
| --- | --- | --- |
| `HOME` | `<sandbox>/home` | Every `~/…` lookup in `src/main` goes through `os.homedir()`, which follows `HOME`: the skill search, the agents' skill folders, the well-known CLI folders. |
| `PATH` | `<sandbox>/bin:/usr/bin:/bin:/usr/sbin:/sbin` | The system folders Electron and its helpers need; no user-installed CLI lives there. |
| `HUNTGRY_E2E` | `1` | Isolated CLI discovery (`src/main/cli/env.ts`): `findCli` skips the login-shell `PATH` and the machine-wide folders (`/opt/homebrew/bin`, `/usr/local/bin`) and looks only below `HOME` and in the app's `PATH`. Without it the real `claude` in `/opt/homebrew/bin` would be found. Ignored by packaged builds. |
| `HUNTGRY_ALLOW_LOCAL_URLS` | `1` | Lets the in-app browser open `127.0.0.1` (mock job boards and ATS forms of later tickets). Unpackaged builds only. |
| `SHELL` | `/bin/sh` | Nothing sources the user's zsh profile. |
| `TMPDIR`, `LANG`, `USER`, `LOGNAME` | sandbox tmp, `en_US.UTF-8`, the runner's user | Chromium and Node basics. |

Not set, deliberately: `ELECTRON_RENDERER_URL` (so main loads the built renderer),
`CLAUDECODE`/`CLAUDE_CODE_*`, `HUNTGRY_CLAUDE_PATH` and the rest of the runner's environment.
`--user-data-dir` is the Chromium switch Electron honours; `app.getPath('userData')` is the
only app path `src/main` uses. (Electron's `app.getPath('home')` comes from the user database
on macOS, not from `HOME`; nothing in the app reads it.)

`isolation.spec.ts` asserts all of this from inside the running app, checks that the real
`~/Library/Application Support/Huntgry`, `~/.claude` and the repository are untouched, that the
real `claude`/`codex`/`agy` are not found (Settings shows *Not found* for all three) while a fake
`claude` in the sandbox `bin` is, and that sandboxes are removed. A worker-scoped fixture fails
the run if any sandbox is still on disk at the end.

Closing: the fixture destroys the windows first (which skips `beforeunload`, so an editor left
with unsaved edits cannot raise the native "unsaved changes" question), stubs
`showMessageBoxSync` as a second guard, and kills a process that has not exited after 15 s.

## Fixtures

- `test` / `expect` from `e2e/fixtures/app.ts`. The `app` fixture gives `{ electronApp, window,
  sandbox, userData, home, workspace, relaunch(), output() }`. `test.use({ workspace: 'demo' })`
  seeds that fixture workspace and writes `settings.json` **before** launch, so the app starts
  in the shell (the fast path every later ticket uses); `'empty-profile'` starts on profile
  setup; the default `null` starts on the picker. `relaunch()` quits and starts again with the
  same userData and HOME, like a user relaunching.
- `e2e/fixtures/workspace.ts`: `seedWorkspace(name, into, as?)` copies
  `e2e/fixtures/workspaces/<name>` and returns its real path; `rememberWorkspace(userData, path)`;
  `resumeFixture('sample-resume.docx' | 'sample-resume.pdf')`; `stubOpenDialog(electronApp,
  paths | null)` and `stubMessageBox(electronApp, index)` replace the native dialogs through
  `electronApp.evaluate`, since Playwright cannot drive them. The picker's typed-path input
  avoids the dialog for most workspace tests.
- Fixture workspaces (`e2e/fixtures/workspaces/README.md`): `empty-profile` (exactly what Create
  writes; the Create test asserts they stay equal), `demo` (filled profile, two applications,
  one saved job), `legacy` (`master_profile.md`), `not-a-workspace`. Binary files (the sample
  resumes, the tiny `resume.pdf`s) are generated by `node e2e/fixtures/generate.mts`; every
  person in them is fictional.
- Main-process stderr/stdout is attached to the report (and printed) when a test fails.

## Page objects

`e2e/pages/`: `WorkspacePicker`, `ProfileSetup`, `ProfileEditor`, `Shell` (`SHELL_PAGES`,
`navLink(page)`, `goTo(page)`, `expectActive(page)`, `switchWorkspaceButton`). Later tickets add
`dashboard`, `tailor`, `jobs`, `browser`, `settings` next to them.

Selectors are role, label and text based; Mantine renders accessible markup. The renderer has no
`data-testid` and none was needed. When an element has no accessible name, prefer giving it one
(`aria-label`, or the right element: the navbar entries became `<button>`s for this) over a test
id; if a test id is unavoidable, list it in the PR.

## Adding a page object and a spec

1. `e2e/pages/<page>.ts`: a class taking `page: Page`, exposing `Locator`s built with
   `getByRole` / `getByLabel` / `getByText`, and small `expect…()` helpers. No waits, no sleeps:
   web-first assertions (`await expect(locator).toBeVisible()`) retry on their own.
2. `e2e/tests/<flow>.spec.ts`: `import { expect, test } from '../fixtures/app'`, pick the start
   state with `test.use({ workspace })`, drive the app through page objects, and assert on both
   the UI and the filesystem (`app.workspace`, `app.userData`) where a flow writes files.
3. External things get a local fake: a scripted CLI in `app.sandbox.bin` (set
   `HUNTGRY_<NAME>_PATH` through `launchApp(sandbox, env)` when a test needs to pin one), a
   server on `127.0.0.1`, a stubbed dialog. Never the real thing.
4. Keep one app per test; do not share state between tests (one worker, `fullyParallel: false`,
   but tests must still be order-independent: `--repeat-each 3` is part of the test plan).

## Debugging

- `npm run test:e2e:ui`, or `npx playwright test -c e2e/playwright.config.ts --headed --debug`
  for the inspector.
- A failure leaves `e2e/.results/test-output/<test>/`: `test-failed-1.png`, `trace.zip`
  (`npx playwright show-trace <file>`), `error-context.md` (accessibility snapshot) and the
  main-process output. Traces are kept on failure locally (`retain-on-failure`) and recorded
  on the first retry in CI (`retries: 2` when `CI` is set).
- The HTML report is at `e2e/.results/html-report` (`npx playwright show-report …`).
- `electronApp.evaluate(({ app, dialog, BrowserWindow }) => …)` runs in the main process: use
  it to read state or stub Electron APIs. `require` is not available inside it.
- To look at a sandbox, comment out `destroySandbox` in the fixture temporarily; the path is in
  the failure output.
