# Huntgry

[![e2e](https://github.com/silentashish/huntgry/actions/workflows/e2e.yml/badge.svg)](https://github.com/silentashish/huntgry/actions/workflows/e2e.yml)
[![ci](https://github.com/silentashish/huntgry/actions/workflows/ci.yml/badge.svg)](https://github.com/silentashish/huntgry/actions/workflows/ci.yml)

## Initial Idea

Architecture converted from [`initial-idea.excalidraw`](./initial-idea.excalidraw).

```mermaid
flowchart LR
    subgraph electron["Electron Application"]
        direction LR

        kg["Person<br/>knowledge graph"]
        dashboard["Custom Dashboard<br/>with all the generated resume<br/>+<br/>link to job board"]
        master["Master Resume"]
        storage[("Local Finder File<br/>Storage")]

        cli["claude cli"]
        skill["Resume<br/>Generator<br/>Skill"]
        scraped["scrapped job<br/>board"]

        hiringcafe(["hiring cafe"])
        indeed(["indeed board"])

        kg --> dashboard
        dashboard --> storage
        master --> dashboard

        cli --> skill
        hiringcafe --> scraped
        indeed --> scraped
        scraped --> skill
        skill -- "custom resume<br/>+<br/>cover letter" --> storage
    end
```

## Development

Requirements: Node.js ≥ 22.12 (developed on Node 26) and npm. macOS is the primary target.

```bash
npm install          # the Electron binary is downloaded on first launch
npm run dev          # electron-vite dev server + Electron window (HMR for the renderer)
npm test             # vitest: workspace, profile format and resume parser (no Electron needed)
npm run test:e2e     # build, then the Playwright end-to-end suite against the real Electron app
npm run test:e2e:ui  # the same suite in Playwright's UI mode
npm run typecheck    # tsc for main/preload (node), renderer (web), in-page autofill code (page) and e2e
npm run build        # typecheck + production bundles in out/
npm start            # preview the production build
npm run dist         # packaged app (Huntgry.app / dmg / zip) in release/ via electron-builder
npm run icons        # regenerate resources/icon.png + icon.icns from resources/icon.svg
```

End-to-end tests live in `e2e/` and run the built app in a sandbox (own `userData`, `HOME`
and `PATH`, so they never see your workspace, settings or agent CLIs). How they isolate the
app, how to add a page object or a spec, how to debug a failure and what the GitHub Actions
run (optional check, `.github/workflows/e2e.yml`) leaves behind is in
[docs/testing/e2e.md](docs/testing/e2e.md).

On macOS, `npm run dev` launches the Electron binary from `node_modules`, which would
show up as "Electron". `scripts/brand-dev-electron.cjs` (run on install and before
`dev`) renames that dev copy to **Huntgry** and gives it the app icon. It only touches
`node_modules` and re-signs the bundle ad hoc.

### Project layout

```
src/
├── shared/                     # types, IPC channel names and pure helpers shared by every process
│   ├── api.ts                  # HuntgryApi = one member per feature (window.huntgry)
│   ├── events.ts               # typed main → renderer event channels + allowlist
│   └── <feature>-types.ts      # e.g. workspace-types.ts, master-profile.ts
├── main/                       # Electron main process
│   ├── index.ts                # window (contextIsolation, sandbox, no nodeIntegration)
│   ├── ipc.ts                  # calls register<Feature>Ipc() for every feature
│   ├── current-workspace.ts    # the open workspace, shared by every feature
│   ├── events.ts               # emit(channel, payload) to the renderer
│   ├── workspace/              # all filesystem logic, Electron-free and unit-tested (+ ipc.ts)
│   ├── profile/                # master-profile.md ⇄ MasterProfile (format.ts), read/save (store.ts) (+ ipc.ts)
│   ├── applications/           # scan <role>/<company>/<job-id>/, huntgry.json tracking, huntgry-file:// previews, fs.watch
│   ├── graph/                  # job descriptions for the knowledge graph overlay
│   ├── insights/               # gap insights from job descriptions, dismissals, Claude-drafted evidence
│   ├── jobs/                   # job boards: hidden-window loader, hiring.cafe / Indeed / posting parsers, .huntgry/jobs store
│   ├── browser/                # in-app browser: one WebContentsView per tab, session hardening, address rules
│   ├── apply/                  # auto-apply: session per tab, CDP resume upload, page-reply checks
│   ├── resume/                 # resume file → lines (docx, pdf, txt/md) → draft profile (parse.ts)
│   └── cli/                    # runs the resume-tailor skill via an agent CLI (claude / codex / agy), run history
├── preload/                    # index.ts composes window.huntgry from <feature>.ts + events.ts;
│                               # browser-page.ts is the in-app tabs' autofill preload (exposes nothing)
└── renderer/src/               # React 19 + Mantine UI, no Node access
    ├── navigation.ts           # pages, typed params, navigate(), leave guard
    ├── components/shell/       # AppLayout: navbar + page area
    └── pages/<page>/           # dashboard, jobs, browser, tailor, graph, profile, settings
resources/                      # app icon (svg source, png, icns)
scripts/                        # icon rendering, dev Electron branding, mock-ats.mjs + mock-ats/ (local test forms)
e2e/                            # Playwright end-to-end tests: fixtures/ (sandbox, workspaces, fake-agent/, servers/), pages/, tests/
```

### Adding a feature

Features only add files, plus one line in each registry:

1. **Types**: `src/shared/<feature>-types.ts` with a `<Feature>Api` interface and its IPC
   channel names; add `<feature>: <Feature>Api` to `HuntgryApi` in `src/shared/api.ts`.
2. **Main**: `src/main/<feature>/` holds the logic (Electron-free where possible, with
   `*.test.ts` next to it) and `ipc.ts` exporting `register<Feature>Ipc()`; call it from
   `src/main/ipc.ts`. Resolve paths from `requireCurrentWorkspace()`; never accept paths
   or command lines from the renderer.
3. **Preload**: `src/preload/<feature>.ts` exports the `ipcRenderer.invoke` wrappers; add
   them to the object in `src/preload/index.ts`.
4. **Streaming**: add `'<feature>:<event>': Payload` to `HuntgryEvents` and the channel to
   `EVENT_CHANNELS` in `src/shared/events.ts`; send with `emit()` from main, listen with
   `window.huntgry.on()` (returns the unsubscribe function) in the renderer.
5. **UI**: `src/renderer/src/pages/<page>/index.tsx`. A new page also needs an entry in
   `PageParams`/`PAGES` (`navigation.ts`), the navbar (`AppLayout.tsx`) and the switch in
   `App.tsx`. Open other pages with `useNavigation().navigate(page, params)`; call
   `setLeaveGuard(message)` while the page has unsaved work.

## Finding jobs

**Jobs** searches hiring.cafe and Indeed when you click Search. Each board's search page is
opened once in a hidden browser window, because both reject plain HTTP clients. You can
also add any posting by URL, or paste it. Saved jobs live in `<workspace>/.huntgry/jobs/`.
**Tailor resume** sends a job to the Tailor page with its saved description, company, role
and job id (the board's id), first fetching the full posting from the employer's page when
there is one. Indeed shows full descriptions only after a human check, so Indeed jobs arrive
with the search snippet: the Tailor page says so, and you can paste the full text first.

## Browser

**Open posting** (Jobs) and the posting links on the Dashboard open the job in the
**Browser** page instead of your system browser: tabs, Back/Forward/Reload/Stop, an address
bar (`jobs.example.com` is enough; there is no search engine) and **Open in browser** to
hand the page to your system browser. Tabs stay open while you use the rest of the app and
close when the app quits. Pages run sandboxed in their own cookie jar
(`persist:huntgry-browser`), with permissions (camera, notifications, location…) and
downloads refused, and cannot reach localhost or your private network. `Cmd/Ctrl+L`
focuses the address bar and `Cmd/Ctrl+T` opens a tab while focus is in the app.

Each tab is an Electron `WebContentsView` owned by the main process (see
`docs/changes/23-embedded-browser.md`), so auto-apply (#24) can drive a page:
`BrowserManager.getWebContents(tabId)`, `attachDebugger(tabId)` (Chrome DevTools Protocol,
e.g. `DOM.setFileInputFiles` for the resume upload), and unpacked extensions dropped into
`<userData>/browser-extensions/<name>/`, which load into the browser session at startup.

## Applying

**Apply** (the send icon on a Dashboard row, **Apply in browser** in the application drawer,
**Apply** on a finished Tailor run) opens the posting's application form in a new Browser
tab, fills it from your master profile and attaches the tailored `resume.pdf` (and
`cover.pdf` when the form has a cover-letter upload). **Huntgry never submits**: you review
the page, answer the rest and press the site's own Submit button. An Apply panel beside the
page lists what was filled, attached, or left to you (custom questions, dropdowns, consent
and demographic questions are always yours). When the site shows its "application
submitted" page, the panel offers **Mark as applied**; nothing changes until you press it.

Greenhouse and Lever forms are recognised (Lever postings open on `/apply`); other sites
get a careful generic match on labels and `autocomplete` that leaves anything ambiguous
empty. Apply needs `resume.pdf` and the posting URL. See `docs/changes/24-auto-apply.md`.

To try it without applying anywhere, run the local mock ATS and allow loopback URLs in a
dev build (ignored by packaged builds):

```bash
node scripts/mock-ats.mjs                      # http://localhost:4173/{greenhouse,lever,generic}/
HUNTGRY_ALLOW_LOCAL_URLS=1 npm run dev         # then set an application's posting URL to one of them
```

The mock's routes live in `scripts/mock-ats/server.mjs`; the e2e suite mounts the same code in
its own server (`e2e/fixtures/servers/`), next to mock job boards that a dev build can be
pointed at with `HUNTGRY_JOB_BOARD_BASE_URL_HIRINGCAFE` / `HUNTGRY_JOB_BOARD_BASE_URL_INDEED`
(loopback origins only, ignored by packaged builds; see `docs/testing/e2e.md`). The e2e harness
additionally sets `HUNTGRY_E2E_LOOPBACK_ONLY=1`, under which a dev build refuses every non-loopback
address outright; packaged builds ignore it too.

## Tailoring a resume

**Tailor** runs the installed resume-tailor skill through an agent CLI — Claude Code
(`claude`), Codex (`codex`) or Antigravity (`agy`) — in the open
workspace: paste a job description, or give an employer or ATS posting URL (job board URLs
such as Indeed cannot be read directly; send those from **Jobs**), pick the agent (the
default one from **Settings** is preselected), follow its gap analysis, answer
its approval question, and open the resulting `resume.pdf` / `cover.pdf`. Runs are kept in
`<workspace>/.huntgry/runs/` and can be reopened and continued after a restart.

To tailor several jobs at once, tick them on **Jobs** and press **Tailor all**. Huntgry
queues one run per job in `<workspace>/.huntgry/queue.json` and starts them itself, two at a
time by default (up to four), a couple of seconds apart. The queue is shown at the top of
**Tailor**. Each run still stops at the approval step: it shows **Needs your reply**, and the
next job starts in its place. Jobs with only a board summary (Indeed) are skipped with a note.
**Tailor all** picks one agent for the batch; each queued job can switch to another agent
until it starts, so one job can go to Claude and the next to Codex.
After a restart the queue is paused until you press **Resume**.

**Settings** shows whether `claude`, the skill and its dependencies are found, which
Claude Code version is installed and whether it is signed in. **Install Claude Code** runs
the official installer, **Update Claude Code** updates an older one (Homebrew installs get
the `brew upgrade claude-code` command instead), and **Install resume-tailor skill**
downloads the skill from its latest GitHub release into `~/.claude/skills`. Signing in
happens once in a terminal (`claude auth login`). The skill needs `pdflatex` (TinyTeX works without admin rights), poppler (`brew install poppler`) and
a few Python modules, which **Install Python dependencies** puts in a venv in the app's
data folder. You do not have to change your shell PATH.

The **Agents** card in **Settings** lists Claude, Codex and Antigravity with their CLI and
version, whether each can see the skill, and which one is the default. Codex and Antigravity
use the skill installed for Claude: **Install skill** links it into their own skills folder
(`~/.agents/skills/resume-tailor`, `~/.gemini/antigravity-cli/skills/resume-tailor`). Install
and sign in to those CLIs yourself (`codex login`, `agy`). See
[docs/changes/22-multi-agent.md](docs/changes/22-multi-agent.md) for how each agent is run and
isolated.

## Knowledge graph

**Knowledge graph** draws the master profile as a graph: roles, companies, projects,
education and skills, each skill backed by evidence (the roles and projects that use it)
and years of use. Job descriptions of the workspace's applications are overlaid: which of
your skills they ask for, and the technologies they ask for that the profile never
mentions (gaps). A **Skills** view lists the same data as a sortable table.


## Keeping the master profile up to date

The Dashboard's **Master profile** card compares the profile with every job description in the
workspace (applications and saved jobs) and lists the skills they keep asking for that the
profile has no evidence of. **I have this** adds evidence to an experience, project or the
skills list, optionally with a bullet Claude words from your own notes (no tools, nothing
invented: numbers not in your notes are flagged); the change is previewed and saved to
`master-profile.md`. **Not me** hides a gap (stored in `.huntgry/profile-insights.json`).

## Workspace

A workspace is the `CV_HOME` directory of the
[resume-tailor skill](https://github.com/silentashish/claude-resume-generator-skill).
On startup the app offers **Create New Workspace** and **Import Existing Workspace**
(or type a folder path; `~` is expanded).

**Create** works on a folder that does not exist yet (it is created) or an empty one
(`.DS_Store`/`.git` are ignored). A folder with other content but no master profile
(unrelated files, or an older workspace with only application folders) is set up after
the user confirms. Create never overwrites anything (existing files are skipped) and writes:

```
<workspace>/
├── master-profile.md   # empty master profile — filled from a resume or the in-app form
├── cover-letter.md     # optional base cover letter
└── CLAUDE.md           # tells Claude Code this folder is CV_HOME (--cv-home <path>)
```

After Create, the app asks how to fill the profile: **Import from a resume**
(`.docx`, `.pdf`, `.txt`, `.md`, parsed locally, reviewed in the form before saving)
or **Fill it in manually**.

**Import** only reads, and requires a master profile at the root: `master-profile.md`
(v3) or the older `master_profile.md`. A folder without one is refused with an offer to
Create a workspace there instead.

### Master profile

`master-profile.md` is the only store: there is no database. The app parses it on every
read and rewrites it on Save, and you can edit it by hand at any time. The format is
plain Markdown: one `## Section` per part of the resume, every entry a `### Heading`
followed by `- Field: value` lines, and list fields (`- Highlights:`) nesting their items.
Sections the app does not know are kept verbatim; lines it cannot place are reported
before you save. Saving is refused if the file changed on disk since it was loaded.
Applications generated by the skill land in the workspace as:

```
<workspace>/<role>/<company>/<job-id>/
├── job-description.md
├── resume_data.json, resume.tex, resume.pdf, build-report.json, resume-page-N.jpg
├── cover_data.json, cover.pdf, cover-page-N.jpg (optional)
└── huntgry.json        # Huntgry's tracking: status, applied date, notes, posting URL, source
```

The **Dashboard** lists them with their build result and links to the PDFs and the job
posting, tracks each one (generated → applied → interviewing → offer / rejected /
archived), previews the pages, and refreshes when folders change on disk.

| Status | Meaning |
| --- | --- |
| `valid` | `master-profile.md` at the root; ready for the skill |
| `legacy` | `master_profile.md` (importable), or application folders only (Create adds a profile after confirmation) |
| `empty` | existing folder with nothing in it; Create allowed |
| `missing` | folder does not exist, parent is writable; Create allowed |
| `not-a-workspace` | unrelated content, no master profile; Create after confirmation, Import refused |
| `unverified` | too large to check (scan stopped before finding a profile or application folder); pick the workspace folder itself |
| `invalid` | not a directory, not readable/writable, relative path, or parent missing |

See [docs/changes/2-electron-workspace-shell.md](docs/changes/2-electron-workspace-shell.md),
[docs/changes/4-master-profile-flow.md](docs/changes/4-master-profile-flow.md),
[docs/changes/7-app-shell.md](docs/changes/7-app-shell.md),
[docs/changes/8-claude-runner.md](docs/changes/8-claude-runner.md),
[docs/changes/9-applications-dashboard.md](docs/changes/9-applications-dashboard.md),
[docs/changes/10-job-boards.md](docs/changes/10-job-boards.md),
[docs/changes/11-knowledge-graph.md](docs/changes/11-knowledge-graph.md)
and [docs/changes/12-profile-insights.md](docs/changes/12-profile-insights.md) for the design notes.
