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
| `HUNTGRY_ALLOW_LOCAL_URLS` | `1` | Lets the in-app browser open `127.0.0.1` (mock job boards and ATS forms of later tickets). Unpackaged builds only. |
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
  writes; the Create test asserts they stay equal), `demo` (filled profile, two applications,
  one saved job), `legacy` (`master_profile.md`), `not-a-workspace`. Binary files (the sample
  resumes, the tiny `resume.pdf`s) are generated by `node e2e/fixtures/generate.mts`; every
  person in them is fictional. `seedWorkspace` keeps the fixtures' timestamps: the runner picks
  a run's output folder by mtime, and a freshly copied `demo` application must not pass for it.
- Main-process stderr/stdout is attached to the report (and printed) when a test fails.

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
  `claude` there would otherwise win (`settings.spec.ts` plants one to prove the pin), plus
  `PYTHONDONTWRITEBYTECODE=1`, because the system `python3` that runs the fixture preflight would
  otherwise cache bytecode under `~/Library/Caches` and a check still running at quit recreated
  the removed sandbox for it (the shim guards its markers the same way: it writes nothing once
  `FAKE_AGENT_HOME` is gone);
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
`Bash` step and the files `resume.pdf`, `resume_data.json`, `build-report.json`,
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

## Page objects

`e2e/pages/`: `WorkspacePicker`, `ProfileSetup`, `ProfileEditor`, `Shell` (`SHELL_PAGES`,
`navLink(page)`, `goTo(page)`, `expectActive(page)` (checks `aria-current="page"`, Mantine's
`data-active` and the page heading), `currentEntries`, `switchWorkspaceButton`), `TailorPage`
(the form fields, `agentChoice` / `pickAgent`, `start(job)`, the run list's `runEntry(title)`,
the open run's `runCard`, `expectStatus`, `toolRow`, `turnResults`, `outputLine`, `outputButton`,
`reply(text)`, `finish()`, and the queue panel's `queueRow`, `queueResumeButton`,
`queuePausedNote`, `concurrencySelect`, `pickQueueAgent`; plus `stubOpenPath` / `openedPaths`, so
"Resume" can be pressed without the OS viewer opening) and `SettingsPage` (`readyBanner`,
`notReadyBanner`, `warnings`, `agentRow`, `defaultRadio` / `setDefault`, `linkSkillButton`,
`row('Claude CLI' | 'Account' | …)`, `preflightRow`, the install/update buttons, and `mainEnv`
for the PATH-isolation assertion). Later tickets add `dashboard`, `jobs`, `browser` next to them.

Selectors are role, label and text based; Mantine renders accessible markup. The renderer has no
`data-testid` and none was needed. When an element has no accessible name, prefer giving it one
(`aria-label`, or the right element: the navbar entries and the run list's entries became
`<button>`s for this) over a test id; if a test id is unavoidable, list it in the PR. Two Mantine
details the Tailor page object hides: a `SegmentedControl` option is a visually hidden radio
(named "Codex" or "Codex: not available"), clicked through its label; a `Select` is an
`aria-label`led read-only input whose choices are `option`s. The open run's card and the queue
panel are found by their headings through Mantine's stable `mantine-Card-root` class, the one
class selector in the suite.

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
  it to read state or stub Electron APIs. `require` is not available inside it.
- To look at a sandbox, comment out `destroySandbox` in the fixture temporarily; the path is in
  the failure output.
