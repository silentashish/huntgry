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
| `HUNTGRY_E2E_LOOPBACK_ONLY` | `1` | The harness's egress restriction (`loopbackOnly` in `src/main/cli/dev-urls.ts`): the in-app browser and the hidden loader refuse every address that is not loopback **before any DNS lookup or request**, with "Refusing to load <host>: this test build may only reach loopback addresses." (private literals and `.local` names keep their usual message). Both Chromium sessions' request guards cancel such requests too, so a page on the mock cannot follow a link out either. This is how the suite proves that a resolvable public URL is never reached. Unpackaged builds only; unit-tested inert when packaged. |
| `HUNTGRY_JOB_BOARD_BASE_URL_HIRINGCAFE`, `HUNTGRY_JOB_BOARD_BASE_URL_INDEED` | the mock server's origins (set by `fixtures/servers/fixture.ts`, not by `appEnv`) | Point a job board at the mock server (`src/main/jobs/board-url.ts`). Only a loopback http(s) origin is accepted, only in unpackaged builds; anything else (or a packaged build) keeps the real board. Unit-tested in `board-url.test.ts`. |
| `SHELL` | `/bin/sh` | Nothing sources the user's zsh profile. |
| `PYTHONDONTWRITEBYTECODE` | `1` | The system `python3` (the skill's preflight) caches bytecode under `~/Library/Caches`; a check still running when the app quits would recreate the removed sandbox HOME for it. |
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
`showMessageBoxSync` as a second guard, and kills a process that has not exited after 15 s. Before
quitting it also lists the non-Electron processes the app spawned (`spawnedChildren`: agent CLIs,
the skill's preflight script) and after quitting waits for them to exit, killing what is still
alive after 10 s (`waitForChildren`): a child that outlived the app would write under the sandbox
`HOME` after it was removed and trip the worker audit.

## Fixtures

- `test` / `expect` from `e2e/fixtures/app.ts`. The `app` fixture gives `{ electronApp, window,
  sandbox, userData, home, workspace, relaunch(), output() }`. `test.use({ workspace: 'demo' })`
  seeds that fixture workspace and writes `settings.json` **before** launch, so the app starts
  in the shell (the fast path every later ticket uses); `'empty-profile'` starts on profile
  setup; the default `null` starts on the picker. `relaunch()` quits and starts again with the
  same userData and HOME, like a user relaunching.
- `test.use({ prepare })` runs a `Preparer` (`{ prepare({ sandbox, workspace }) }`) after the
  workspace is seeded and before the first launch: fake CLIs into `sandbox.bin`, files into the
  workspace, a local server. What it returns is added to the app's environment, for `relaunch()`
  too. It is an object rather than a bare function because Playwright would take a function
  given to `test.use` for a fixture override. `withFakeAgents()` (below) is one; the queue specs
  compose it with `seedJobs` / `seedQueue` from `e2e/fixtures/queue.ts`, which write what the
  Jobs page's "Tailor all" leaves in `.huntgry/`.
- `e2e/fixtures/workspace.ts`: `seedWorkspace(name, into, as?)` copies
  `e2e/fixtures/workspaces/<name>` and returns its real path; `rememberWorkspace(userData, path)`;
  `resumeFixture('sample-resume.docx' | 'sample-resume.pdf')`; `stubOpenDialog(electronApp,
  paths | null)` and `stubMessageBox(electronApp, index)` replace the native dialogs through
  `electronApp.evaluate`, since Playwright cannot drive them. The picker's typed-path input
  avoids the dialog for most workspace tests.
- Fixture workspaces (`e2e/fixtures/workspaces/README.md`): `empty-profile` (exactly what Create
  writes; the Create test asserts they stay equal), `demo` (filled profile with an unknown
  `## Volunteering` section, five applications across statuses, one saved job), `legacy`
  (`master_profile.md`), `not-a-workspace`, `mocks` (applications and saved jobs pointing at the
  mock server, see below). Binary files (the sample resumes, the tiny `resume.pdf`/`cover.pdf`s,
  the `*-page-1.jpg` previews) are generated by `node e2e/fixtures/generate.mts`; every person in
  them is fictional.
- `seedWorkspace` keeps the fixtures' timestamps (`preserveTimestamps`): the runner picks a run's
  output folder by mtime, and a freshly copied `demo` application must not pass for it.
- Two hooks the `app` fixture exposes for other fixtures to override: `prepareWorkspace` (runs on
  the seeded copy before launch) and `launchEnv` (extra variables for `launchApp`). Both are
  no-ops by default; `fixtures/servers/fixture.ts` overrides them. A spec's `prepare` (see
  `Preparer` above) runs after `prepareWorkspace`, and the environment it returns is layered over
  `launchEnv`.
- Main-process stderr/stdout is attached to the report (and printed) when a test fails.

### The `demo` workspace

The README next to the fixtures has the full table. In short: Alex Rivera's profile lists Go,
Python, TypeScript, SQL, AWS, Terraform, Docker and PostgreSQL and states "No Kubernetes in
production yet"; the applications are

| Folder | Status | Notable |
| --- | --- | --- |
| `software-engineer/acme/acme-4821` | generated | `resume.pdf`, ok build, posting URL: Apply possible |
| `backend-engineer/globex/gx-77` | applied 2026-09-20 | failed build (`one_page`), `jobUrl` and `source` in `huntgry.json` |
| `platform-engineer/initech/init-9` | interviewing | `cover.pdf`, `resume-page-1.jpg`, `cover-page-1.jpg`; asks for Kafka |
| `data-engineer/umbrella/umb-12` | generated | no `resume.pdf` (Apply blocked), no build report; asks for Kafka, Spark, Airflow |
| `frontend-engineer/wayne/wy-3` | rejected | no posting URL (Apply blocked); asks for React, GraphQL |

so the insights card lists Kafka (2 jobs), Airflow, GraphQL, React and Spark, notes Kubernetes,
and the graph overlay has five job nodes. The table on the Dashboard is ordered by file mtime,
which a fresh copy does not fix: specs address rows by company, never by position.

**Extending `demo`:** add a `<role>/<company>/<job-id>/` folder with at least one marker file
(`job-description.md`, `resume_data.json`, `build-report.json`, `resume.pdf`, `cover_data.json`),
write the text files by hand, and add a `write(...)` line to `generate.mts` for each binary
(`applicationPdf`, `coverPdf`, `pagePreview`). Then update the README table: the dashboard,
graph and insights specs assert the counts and gaps it lists, so a new job description that
mentions a technology from `src/shared/skills.ts` (`TECH_VOCABULARY`, which includes words like
"on-call") changes the expected gap list. Run `node e2e/fixtures/generate.mts` and check
`git status`: existing binaries must come out unchanged.

## Fake agents

The Tailor page and Settings depend on `claude`, `codex` and `agy`. `e2e/fixtures/fake-agent/`
replaces all three with one scripted Node program, `agent.mjs`, driven through the app's **real**
discovery, version gate, sign-in check, runner and queue: nothing in `src/` knows it is a fake.

```
test.use({ workspace: 'demo', prepare: withFakeAgents({ script: 'slow', slowMs: 400 }) })
const fakes = fakeAgents(app)          // markers and the script switch of this sandbox
await fakes.setScript('fail')          // the next spawned agent fails mid-turn
expect((await fakes.runs()).map((r) => r.agent)).toEqual(['claude', 'codex'])
```

`withFakeAgents(opts)` installs, before launch:

- a wrapper per name in `<sandbox>/bin` (`claude`, `codex`, `agy`) that runs
  `node agent.mjs <name> "$@"` with `FAKE_AGENT_HOME=<sandbox>/fake-agent` (the sandbox PATH has
  no `node`, so the wrapper names the test runner's own binary), and `HUNTGRY_CLAUDE_PATH` pinned
  to the `claude` wrapper: `~/.local/bin` below the sandbox HOME is searched *before* PATH, so a
  `claude` there would otherwise win (`settings.spec.ts` plants one to prove the pin); the shim
  writes nothing once `FAKE_AGENT_HOME` is gone, so a process that boots after the app quit
  cannot recreate the sandbox (the harness sets `PYTHONDONTWRITEBYTECODE` for the same reason);
- the fixture skill (`skill/SKILL.md` and a `scripts/preflight.py` that reports every dependency
  present) copied, not linked (`findSkillDir` skips symlinks), to `~/.claude/skills/resume-tailor`
  and, with `skills: 'all'` (default), to the Codex and Antigravity folders too; `skills: 'claude'`
  leaves those for the "Install skill" buttons to fill;
- a fake `pdflatex` under `~/Library/TinyTeX/bin/universal-darwin` (`tex: false` to skip), so
  Settings reads *Ready to tailor* with nothing missing.

What the shim speaks, per name (the shapes `src/main/cli/agents/*.ts` parse; `agent.test.ts`
runs it against each adapter's `signal()` and `buildTranscript`, in `npm test`):

| Name | In | Out | Resume |
| --- | --- | --- | --- |
| `claude` | stream-json `{type:'user', message:{content}}` lines, one per turn, on stdin; one process per run | `system/init` (with `session_id`, after a dropped `hook_started`), `assistant` text and `tool_use`, `user` `tool_result`, one `result` per turn with `total_cost_usd` | `--resume <id>` |
| `codex` | the whole prompt on stdin until it closes; one process per turn | `thread.started`, `turn.started`, `item.completed` (`agent_message`, `command_execution`), `turn.completed` with `usage` | `exec resume <id>` |
| `agy` | `{event:'user', message:{content}}` lines; needs `--print=` | `init` with `conversation_id`, `step_update` (`agent_response` text deltas, `tool` with `tool_info`), `result` with `status`/`usage` | `--conversation <id>` |

`--version` prints `9.9.9 (Claude Code)` / `codex-cli 0.99.0` / `agy 1.99.0` (`claudeVersion` etc.
in the options change them: `2.0.0` triggers the update warning); `claude auth status` answers
signed in as `fake@example.com`. Every other command line is a run.

The script, the same for every agent: the first message of a session is the job (role, company
and job id are read from the `Company:` / `Role:` / `Job id:` lines the app writes, slugged as
the real skill does) and gets a gap analysis, one `Read` of the master profile and the approval
question, so the run stops at *Waiting for you*. A later message containing "approve" gets a
`Bash` step and the files `resume.pdf` (a structurally valid one-page PDF with a cross-reference
table, carrying the name, role and company as text; `agent.test.ts` parses it with `unpdf` and,
when poppler is on the machine, `pdfinfo`), `resume_data.json`, `build-report.json`,
`job-description.md` under `<CV_HOME>/<role>/<company>/<job-id>/`; any other reply gets a short
answer and the question again. A resumed process keeps the id it was given (Codex, which runs one
process per turn, also recalls the job from `fake-agent/sessions/<id>.json`).

Behaviour switches, from `fake-agent/config.json` (written by `withFakeAgents` and
`fakes.setScript`) or the environment `FAKE_AGENT_SCRIPT` / `FAKE_AGENT_SLOW_MS`:

| `script` | What happens |
| --- | --- |
| `normal` | as above, as fast as it can |
| `slow` | a pause of `slowMs` (default 1500) before every event: the transcript visibly streams, turns take long enough to observe concurrency or to quit mid-turn |
| `fail` | after the first message of the turn: stderr `boom: simulated agent failure`, exit 3 (Codex first prints `turn.failed`, Antigravity a `result` with `status: 'ERROR'` and an `AGY_ERROR` line) |
| `exit-early` | exit 0 right after `init`, before any turn ends (a Claude run reads as *finished* with nothing built, a Codex one as "exited before the turn ended") |

Markers: every spawn appends to `fake-agent/invocations.jsonl` (`{ agent, mode, pid, cwd, args,
resume, session, at }`, `mode` one of `version`, `auth`, `run`) and every turn adds `turn-start` /
`turn-end` lines. `fakeAgents(app)` reads them: `invocations()`, `runs()` (the agent processes,
oldest first: which agent the app really started, with which arguments, resuming which session)
and `turns()` (start/end per turn, for the "2 at a time" check).

Extending the script: add a branch in `runTurn` (agent.mjs) keyed on the message text or on a new
`script` value, emit through `protocol.text/tool/result/fail` so all three agents stay in step,
cover it in `agent.test.ts`, and list it in the tables above. Never make the shim depend on the
machine: no network, nothing outside `CV_HOME`, `FAKE_AGENT_HOME` and the temp folder.

## Mock servers (Jobs, Browser, Apply)

Those three flows reach job boards, employer pages and ATS forms. In the suite they reach
**one Node server per worker** on a free `127.0.0.1` port and nothing else
(`e2e/fixtures/servers/`):

| File | What it holds |
| --- | --- |
| `fixture.ts` | `test` for these specs: the `app` fixture plus `mock` (the server, its request log cleared and the last submission removed per test). Before launch it rewrites `http://mock-server.invalid` in the seeded `mocks` workspace to the server's origin and sets the board overrides through `launchEnv`. |
| `mock-server.ts` | The server: routes below, `origin` (`http://127.0.0.1:<port>`), `altOrigin` (`http://127.0.0.1:<altPort>`: the same handler on a second listener, a different origin), `requests`, `submissionFile`, `close()`. Port 0 for both, never a fixed port, never `localhost` (its resolution is the machine's business). |
| `pages.ts` | The fictional pages: the board result shapes, the employer postings, a Lever-style and an Ashby-style posting. |

Routes: `/?searchState=…` is a hiring.cafe-shaped search page (`__NEXT_DATA__` with
`pageProps.ssrHits`, what `parseHiringCafeHits` reads); `/jobs?q=…` an Indeed-shaped page
(`window.mosaic.providerData['mosaic-provider-jobcards']`, snippets only); `/postings/employer/<id>`
employer pages with a JSON-LD `JobPosting` and a full description; `/postings/lever-style` and
`/postings/ashby-style` (the latter without JSON-LD, for the text fallback); `/bot-wall` (403,
"Just a moment…"); `/page/one`, `/page/two`, `/hang` for the browser's history and Stop;
`/redirect/lever` (302 to the Lever form on `altOrigin`, the second port); and the mock ATS at `/greenhouse/`,
`/lever/`, `/generic/`, `/generic-cover/` (+ `…/submit`, the thanks pages). The ATS routes are
`scripts/mock-ats/server.mjs`, the same module `node scripts/mock-ats.mjs` runs; `generic-cover`
is the generic form with a cover-letter upload added, so `cover.pdf` is exercised.

**How the app is pointed at it.** The harness already sets `HUNTGRY_ALLOW_LOCAL_URLS=1`, which
the in-app browser session and (since #49) the hidden job-board loader honour for loopback
addresses only. The boards are moved with `HUNTGRY_JOB_BOARD_BASE_URL_HIRINGCAFE` and
`HUNTGRY_JOB_BOARD_BASE_URL_INDEED` (`src/main/jobs/board-url.ts`): accepted only in unpackaged
builds and only for a loopback http(s) origin; a packaged build, a public URL or a private-network
address leaves the real board in place (unit-tested). Indeed is put on the second port and
hiring.cafe on the first so the loader's per-host rate limit (one load per `host:port` per 4 s)
does not serialise a two-board search. Posting URLs inside the `mocks` workspace are placeholders
(`http://mock-server.invalid/…`) rewritten at seed time. With `HUNTGRY_E2E_LOOPBACK_ONLY=1` (set by
`appEnv` for every test) nothing but loopback can be reached at all, and the browser and jobs specs
assert a resolvable public URL is refused before a lookup.

**Timing.** The loader polls a page once a second and gives a bot wall half its 25 s timeout to
clear itself before reporting it, so "a bot wall gives the blocked message" takes ~13 s
(`test.slow()`); a search of both boards takes ~2 s; fetching a posting right after a search on
the same host waits for the 4 s gap.

### Tabs are `WebContentsView`s

Browser tabs are not windows. Two ways to see them, both in `e2e/fixtures/tabs.ts`:

- **Through the main process** (the preferred route for state): `listTabs(electronApp)` reads every child of
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

`e2e/pages/`: `WorkspacePicker`, `ProfileSetup`, `ProfileEditor` (`openTab`, `field(label)`
matching only the visible input, `entry(title)` for accordion headers, `unsavedBadge`,
`savedBadge`, `leaveDialog`, `save()`), `Shell` (`SHELL_PAGES`, `navLink(page)`, `goTo(page)`,
`expectActive(page)` (checks `aria-current="page"`, Mantine's `data-active` and the page
heading), `currentEntries`, `switchWorkspaceButton`), `Dashboard` (`rows`, `row(company)`,
`rowStatus`, `pickStatus(select, status)`, `statCard(label)`, `statusFilter`, `searchInput`,
`open(company)` → the drawer, `tooltip(text)`, `expectCompanies([...])`), `InsightsCard`
(`gap(skill)`, `haveThis(skill)` → the evidence modal, `notMe(skill)`, `dismissedToggle`,
`emptyBadge(section)`, `openButton`), `GraphPage` (`showView('Graph' | 'Skills')`,
`nodeLabels()` from the "Jump to…" list, `toggleJobsOverlay(on)`, `skillRow(skill)`,
`nodePanel(label)`, `searchInput`), `TailorPage`
(the form fields, `agentChoice` / `pickAgent`, `start(job)`, the run list's `runEntry(title)`,
the open run's `runCard`, `expectStatus`, `toolRow`, `turnResults`, `outputLine`, `outputButton`,
`reply(text)`, `finish()`, and the queue panel's `queueRow`, `queueResumeButton`,
`queuePausedNote`, `concurrencySelect`, `pickQueueAgent`; plus `stubOpenPath` / `openedPaths`, so
"Resume" can be pressed without the OS viewer opening) and `SettingsPage` (`readyBanner`,
`notReadyBanner`, `warnings`, `agentRow`, `defaultRadio` / `setDefault`, `linkSkillButton`,
`row('Claude CLI' | 'Account' | …)`, `preflightRow`, the install/update buttons, and `mainEnv`
for the PATH-isolation assertion), `JobsPage`, `BrowserPage` with `ApplyPanel` (#49, see "Mock
servers" above).

The dashboard's search box, status filter and sort select carry `aria-label`s (`Search
applications`, `Filter by status`, `Sort applications`) added for the tests, since a placeholder
is not a stable name (the multi-select's disappears once a value is picked).

Mantine details the page objects already handle, so a new spec does not rediscover them:
Select and MultiSelect inputs are `role=combobox` and their options `role=option`, but the option
lists stay mounted (hidden) after the first open, so plain `getByText('Applied')` also hits
options: match visible elements (`.filter({ visible: true })`) or scope to a row. Tooltips are
`role=tooltip`; a disabled control gets no `mouseleave`, so its tooltip stays open and the next
one must be matched by text. The SegmentedControl and the Chip hide their `radio`/`checkbox`
inputs: click the label text, assert `toBeChecked()` on the input. Accordion panels and a
collapsed `Collapse` stay mounted: `getByLabel(...)` on an entry field needs the visible filter.
The Knowledge graph canvas is never inspected: nodes come from the "Jump to…" select
(`<Kind>: <label>` per node), skills from the Skills table.

Selectors are role, label and text based; Mantine renders accessible markup. The renderer has no
`data-testid` and none was needed. When an element has no accessible name, prefer giving it one
(`aria-label`, or the right element: the navbar entries and the run list's entries became
`<button>`s for this) over a test id; if a test id is unavoidable, list it in the PR. Two Mantine
details the Tailor page object hides: a `SegmentedControl` option is a visually hidden radio
(named "Codex" or "Codex: not available"), clicked through its label; a `Select` is an
`aria-label`led read-only input whose choices are `option`s. The open run's card and the queue
panel are found by their headings through Mantine's stable `mantine-Card-root` class, the one
class selector in the suite.

## CI

Two GitHub Actions workflows, both **optional checks** for now:

| Workflow | Job | Runner | Runs |
| --- | --- | --- | --- |
| `.github/workflows/e2e.yml` | `e2e (macOS)` | `macos-latest` | `npm ci`, `npm run build`, `npx playwright test -c e2e/playwright.config.ts` with `CI=1` (so `retries: 2`, traces on the first retry) |
| `.github/workflows/ci.yml` | `unit + typecheck` | `ubuntu-latest` | `npm test`, `npm run typecheck` |

Triggers: every `pull_request`, every `push` to `main`, and the "Run workflow" button
(`workflow_dispatch`). A newer push to the same PR branch cancels the older run (`concurrency`,
`cancel-in-progress` only off `main`: runs on `main` always finish).
`permissions: contents: read` is all they need: the suite reaches only fakes on `127.0.0.1`,
so there are no secrets. The e2e job has a 30-minute timeout. Two caches make the second run
fast: `actions/setup-node`'s npm cache (keyed on `package-lock.json`) and the Electron binary
(`~/Library/Caches/electron`, keyed on the electron version in the lockfile, restored before
`npm ci` so electron's postinstall finds the download already there).

**What a run leaves behind.** The job summary (the run page, under the job) has the pass /
fail / run-error / flaky / skipped counts and the duration; the config adds a JSON reporter when
`CI` is set (`e2e/.results/results.json`) and `.github/scripts/e2e-summary.mjs` turns it into
that table (a missing or truncated results file becomes a warning line, never a failed step).
Two artifacts, kept for 7 days, with different conditions:

| Artifact | Uploaded when | Contents |
| --- | --- | --- |
| `e2e-traces-macOS` | **every run** that produced any (`if: always()`, skipped silently when `e2e/.results/test-output/` is empty): failed tests and flaky ones alike | `trace.zip` (recorded on the first retry), `test-failed-1.png`, `error-context.md` and the main-process output, one folder per failed attempt |
| `e2e-html-report-macOS` | **only when the job failed** (`if: failure()`) | the Playwright HTML report |

A test that fails once and passes on retry is reported as *flaky*, keeps the job green, and
still gets its trace uploaded; only the HTML report is then absent. To look at a trace:

```bash
# Actions → the run → Artifacts → download e2e-traces-macOS.zip, then
unzip e2e-traces-macOS.zip -d /tmp/e2e-traces
npx playwright show-trace /tmp/e2e-traces/<test-folder>/trace.zip
# or the whole report:
unzip e2e-html-report-macOS.zip -d /tmp/e2e-report && npx playwright show-report /tmp/e2e-report
```

`gh run download <run-id> -n e2e-traces-macOS -D /tmp/e2e-traces` does the download from the
terminal.

**Why the check is optional.** Every job has `continue-on-error: true` and neither workflow is
in branch protection, so a red e2e run shows on the PR but never blocks a merge, until the
build time and the flake rate are known. **To make it required** later, one change per
workflow and one in the repository settings: set `continue-on-error: false` on the job you want
to count, the `e2e` job in `e2e.yml` and/or the `unit` job in `ci.yml` (with it left `true` a
failed job still reports the run as successful, so the required check would never go red), then
*Settings → Branches → main → Require status checks to pass* and add `e2e (macOS)` and/or
`unit + typecheck`. Nothing else changes.

**Linux.** There is no Linux job. A trial of the suite on `ubuntu-latest` under
`xvfb-run --auto-servernum` (with the Electron runtime libraries installed and Ubuntu 24.04's
unprivileged user-namespace restriction lifted) failed every test at launch with *Missing X
server or $DISPLAY*: the harness builds the app's environment from scratch (`appEnv` in
`e2e/fixtures/app.ts`, so no developer variable leaks in) and does not pass `DISPLAY` through,
so the app never sees the xvfb server. Two more things would need doing before Linux can count:
pass `DISPLAY` and `XAUTHORITY` through on Linux, and give the Settings specs a Linux location
for the fake `pdflatex` (they plant it under `~/Library/TinyTeX`, a macOS path). macOS is the
primary target, so this stays a follow-up; the trial run is linked from the #50 PR.

## Adding a page object and a spec

1. `e2e/pages/<page>.ts`: a class taking `page: Page`, exposing `Locator`s built with
   `getByRole` / `getByLabel` / `getByText`, and small `expect…()` helpers. No waits, no sleeps:
   web-first assertions (`await expect(locator).toBeVisible()`) retry on their own.
2. `e2e/tests/<flow>.spec.ts`: `import { expect, test } from '../fixtures/app'`, pick the start
   state with `test.use({ workspace })`, drive the app through page objects, and assert on both
   the UI and the filesystem (`app.workspace`, `app.userData`) where a flow writes files.
3. External things get a local fake: a scripted CLI in `app.sandbox.bin` (the agent CLIs are
   `withFakeAgents()`; a `Preparer` given to `test.use({ prepare })` can install anything else
   before launch and return env such as `HUNTGRY_<NAME>_PATH`), a server on `127.0.0.1`, a
   stubbed dialog or `shell.openPath`. Never the real thing: the Settings specs look at the
   Install / Update buttons and their text and never press them.
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
  it to read state or stub Electron APIs. `require` is not available inside it. Closing a
  window with unsaved profile edits (`BrowserWindow.close()`) makes main answer `beforeunload`
  itself through `showMessageBoxSync`; Playwright still receives a `dialog` event with nothing
  left to handle and its default handler throws, so a spec that closes the window registers
  `page.on('dialog', d => d.dismiss().catch(() => {}))` first (see `profile-editor.spec.ts`).
- To look at a sandbox, comment out `destroySandbox` in the fixture temporarily; the path is in
  the failure output.
