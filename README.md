# Huntgry

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
npm run typecheck    # tsc for main/preload (node) and renderer (web)
npm run build        # typecheck + production bundles in out/
npm start            # preview the production build
npm run dist         # packaged app (Huntgry.app / dmg / zip) in release/ via electron-builder
npm run icons        # regenerate resources/icon.png + icon.icns from resources/icon.svg
```

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
│   ├── jobs/                   # job boards: hidden-window loader, hiring.cafe / Indeed / posting parsers, .huntgry/jobs store
│   ├── resume/                 # resume file → lines (docx, pdf, txt/md) → draft profile (parse.ts)
│   └── cli/                    # placeholder for the `claude` CLI integration
├── preload/                    # index.ts composes window.huntgry from <feature>.ts + events.ts
└── renderer/src/               # React 19 + Mantine UI, no Node access
    ├── navigation.ts           # pages, typed params, navigate(), leave guard
    ├── components/shell/       # AppLayout: navbar + page area
    └── pages/<page>/           # dashboard, jobs, tailor, graph, profile, settings
resources/                      # app icon (svg source, png, icns)
scripts/                        # icon rendering, dev Electron branding
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
**Tailor resume** sends a job to the Tailor page. Indeed shows full descriptions only
after a human check, so for Indeed jobs open the posting and paste the text.

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
├── resume_data.json, resume.tex, resume.pdf, build-report.json
└── cover_data.json, cover.pdf (optional)
```

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
[docs/changes/7-app-shell.md](docs/changes/7-app-shell.md)
and [docs/changes/10-job-boards.md](docs/changes/10-job-boards.md) for the design notes.
