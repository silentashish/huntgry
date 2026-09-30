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
| `HUNTGRY_E2E` | `1` | Isolated CLI discovery (`src/main/cli/env.ts`): `findCli` skips the login-shell `PATH` and the machine-wide folders (`/opt/homebrew/bin`, `/usr/local/bin`) and looks only below `HOME` and in the app's `PATH`; `buildChildEnv` builds the `PATH` of agent child processes the same way, so a fake agent never sees the machine's tools either. Without it the real `claude` in `/opt/homebrew/bin` would be found. Ignored by packaged builds. |
| `HUNTGRY_ALLOW_LOCAL_URLS` | `1` | Lets the in-app browser **and the hidden job-board loader** open loopback addresses (`127.0.0.1`, `localhost`, `[::1]`): the mock server of the Jobs, Browser and Apply specs. Private-network addresses (`10.…`, `192.168.…`, `169.254.…`, names that resolve to them) stay refused, which those specs assert. Unpackaged builds only. |
| `HUNTGRY_JOB_BOARD_BASE_URL_HIRINGCAFE`, `HUNTGRY_JOB_BOARD_BASE_URL_INDEED` | the mock server's origins (set by `fixtures/servers/fixture.ts`, not by `appEnv`) | Point a job board at the mock server (`src/main/jobs/board-url.ts`). Only a loopback http(s) origin is accepted, only in unpackaged builds; anything else (or a packaged build) keeps the real board. Unit-tested in `board-url.test.ts`. |
| `SHELL` | `/bin/sh` | Nothing sources the user's zsh profile. |
| `TMPDIR`, `LANG`, `USER`, `LOGNAME` | sandbox tmp, `en_US.UTF-8`, the runner's user | Chromium and Node basics. |

Not set, deliberately: `ELECTRON_RENDERER_URL` (so main loads the built renderer),
`CLAUDECODE`/`CLAUDE_CODE_*`, `HUNTGRY_CLAUDE_PATH` and the rest of the runner's environment.
`--user-data-dir` is the Chromium switch Electron honours; `app.getPath('userData')` is the
only app path `src/main` uses. (Electron's `app.getPath('home')` comes from the user database
on macOS, not from `HOME`; nothing in the app reads it.)

`isolation.spec.ts` launches the app itself so it can take a baseline **before** launch, asserts
all of this from inside the running app, and after closing compares a file-level snapshot (path,
size, mtime) of the real `~/Library/Application Support/Huntgry`, `~/.claude/skills` and
`~/.claude/local` plus `git status --porcelain --ignored` of the repository (minus `node_modules`
and `e2e/.results`, which the runner writes) against that baseline. The rest of `~/.claude`
belongs to Claude Code itself and changes while a developer's session runs, so it is not part
of the baseline. Other tests check that the real `claude`/`codex`/`agy` are not found (Settings
shows *Not found* for all three) while a fake `claude` in the sandbox `bin` is, and that a
closed app's sandbox is removed. A worker-scoped fixture fails the run if any sandbox is still
on disk at the end, and the `app` fixture removes its sandbox even when seeding or the launch
itself fails (a process that spawned but never showed a window is killed).

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
  one saved job), `legacy` (`master_profile.md`), `not-a-workspace`, `mocks` (applications and
  saved jobs pointing at the mock server, see below). Binary files (the sample resumes, the tiny
  `resume.pdf`s and `cover.pdf`) are generated by `node e2e/fixtures/generate.mts`; every person
  in them is fictional.
- Two hooks the `app` fixture exposes for other fixtures to override: `prepareWorkspace` (runs on
  the seeded copy before launch) and `launchEnv` (extra variables for `launchApp`). Both are
  no-ops by default; `fixtures/servers/fixture.ts` overrides them.
- Main-process stderr/stdout is attached to the report (and printed) when a test fails.

## Mock servers (Jobs, Browser, Apply)

Those three flows reach job boards, employer pages and ATS forms. In the suite they reach
**one Node server per worker** on a free `127.0.0.1` port and nothing else
(`e2e/fixtures/servers/`):

| File | What it holds |
| --- | --- |
| `fixture.ts` | `test` for these specs: the `app` fixture plus `mock` (the server, its request log cleared and the last submission removed per test). Before launch it rewrites `http://mock-server.invalid` in the seeded `mocks` workspace to the server's origin and sets the board overrides through `launchEnv`. |
| `mock-server.ts` | The server: routes below, `origin` (`http://127.0.0.1:<port>`), `altOrigin` (`http://localhost:<port>`, the same server on a different origin), `requests`, `submissionFile`, `close()`. Port 0, never a fixed port. |
| `pages.ts` | The fictional pages: the board result shapes, the employer postings, a Lever-style and an Ashby-style posting. |

Routes: `/?searchState=…` is a hiring.cafe-shaped search page (`__NEXT_DATA__` with
`pageProps.ssrHits`, what `parseHiringCafeHits` reads); `/jobs?q=…` an Indeed-shaped page
(`window.mosaic.providerData['mosaic-provider-jobcards']`, snippets only); `/postings/employer/<id>`
employer pages with a JSON-LD `JobPosting` and a full description; `/postings/lever-style` and
`/postings/ashby-style` (the latter without JSON-LD, for the text fallback); `/bot-wall` (403,
"Just a moment…"); `/page/one`, `/page/two`, `/hang` for the browser's history and Stop;
`/redirect/lever` (302 to the Lever form on `altOrigin`); and the mock ATS at `/greenhouse/`,
`/lever/`, `/generic/`, `/generic-cover/` (+ `…/submit`, the thanks pages). The ATS routes are
`scripts/mock-ats/server.mjs`, the same module `node scripts/mock-ats.mjs` runs; `generic-cover`
is the generic form with a cover-letter upload added, so `cover.pdf` is exercised.

**How the app is pointed at it.** The harness already sets `HUNTGRY_ALLOW_LOCAL_URLS=1`, which
the in-app browser session and (since #49) the hidden job-board loader honour for loopback
addresses only. The boards are moved with `HUNTGRY_JOB_BOARD_BASE_URL_HIRINGCAFE` and
`HUNTGRY_JOB_BOARD_BASE_URL_INDEED` (`src/main/jobs/board-url.ts`): accepted only in unpackaged
builds and only for a loopback http(s) origin; a packaged build, a public URL or a private-network
address leaves the real board in place (unit-tested). Indeed is put on `localhost` and
hiring.cafe on `127.0.0.1` so the loader's per-host rate limit (one load per host per 4 s) does
not serialise a two-board search. Posting URLs inside the `mocks` workspace are placeholders
(`http://mock-server.invalid/…`) rewritten at seed time.

**Timing.** The loader polls a page once a second and gives a bot wall half its 25 s timeout to
clear itself before reporting it, so "a bot wall gives the blocked message" takes ~13 s
(`test.slow()`); a search of both boards takes ~2 s; fetching a posting right after a search on
the same host waits for the 4 s gap.

### Tabs are `WebContentsView`s

Browser tabs are not windows. Two ways to see them, both in `e2e/fixtures/tabs.ts`:

- **Through the main process** (the primary route): `listTabs(electronApp)` reads every child of
  the main window's `contentView` (URL, title, loading), `expectTabLoaded` / `tabWithUrl` wait for
  one, `evaluateInTab(electronApp, urlPart, expression)` runs `webContents.executeJavaScript`
  in it, and `stubOpenExternal` replaces `shell.openExternal` and records what it was given.
  The BrowserManager itself is not reachable from `electronApp.evaluate` (the bundle exports
  nothing), and it is not needed: the views hang off the window.
- **As Playwright `Page`s** (verified, a bonus): Playwright's Electron driver attaches to every
  page target, so once a tab has loaded `electronApp.windows()` lists it next to the app window
  (`file:…/index.html` first, then the tab's URL), with the usual locators and assertions. The
  browser spec asserts both routes on the same tab. Prefer the main-process route for state (it
  does not depend on when the target attaches) and the `Page` route when a locator reads better.

### Apply: the test presses Submit, never the app

`src/main/apply` fills and attaches and detects the site's confirmation page; it never submits
(#24, enforced by `src/shared/autofill/guard.test.ts`). The apply specs keep that rule:
**the only thing that presses a Submit button is the test**, through
`pressSubmitInTab(electronApp, urlPart, values)`, which fills the answers the form still needs
(a required question, a consent checkbox) and clicks the mock's own button inside the tab. The
mock records the posted fields and file names to `mock.submissionFile` (`last-submission.json`),
and the specs assert that file plus the application's `huntgry.json` ("Mark as applied" writes
it, "Not yet" does not). Nothing in this ticket adds a code path that submits.

Page objects for these flows: `JobsPage` (`pages/jobs.ts`: search form, board chips, per-board
report, add by URL, paste modal, saved-job cards and their selection, the drawer, "Tailor all")
and `BrowserPage` / `ApplyPanel` (`pages/browser.ts`: tab strip, address bar, nav buttons,
notices, "Open in browser", the panel's status, groups, fields and buttons). No `data-testid`
was needed; tabs in the strip are told apart from the "New tab" action by their `title`.

## Page objects

`e2e/pages/`: `WorkspacePicker`, `ProfileSetup`, `ProfileEditor`, `Shell` (`SHELL_PAGES`,
`navLink(page)`, `goTo(page)`, `expectActive(page)` (checks `aria-current="page"`, Mantine's
`data-active` and the page heading), `currentEntries`, `switchWorkspaceButton`), `JobsPage`,
`BrowserPage` with `ApplyPanel` (#49). Other tickets add `dashboard`, `tailor`, `settings` next
to them.

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
