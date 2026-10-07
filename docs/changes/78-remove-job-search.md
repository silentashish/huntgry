# #78: Remove job board search

Issue: [silentashish/huntgry#78](https://github.com/silentashish/huntgry/issues/78) · Removes the board search of #10 and the profile refresh of #73

## Context & problem

Search on hiring.cafe and Indeed (the **Search** form, **Refresh** and the 12-hour auto-refresh)
kept breaking: the boards change their page data and put up human checks. The owner adds jobs by
URL or paste anyway, so the feature goes. Jobs now holds only postings added by URL or pasted.

## What changed and why

| Area | Files | Why |
| --- | --- | --- |
| Main | `src/main/jobs/service.ts`, `ipc.ts`, `store.ts`, `prefs.ts`; deleted `sources/hiringcafe.ts`, `sources/indeed.ts`, `board-url.ts` and their fixtures | No `jobs:search`, `jobs:refresh` or `jobs:recent-searches` channels; nothing records `searches.json` or the last search. Add by URL, paste, fetch details and update stay. |
| Shared | `jobs-types.ts`, `jobs-prefs.ts`, `job-relevance.ts` | The query/result types, `relevantQuery` and `autoRefreshDue` are gone. Jobs preferences hold only the filters; the old `autoRefresh`, `lastRefreshAt` and `lastSearch` fields in existing files are ignored. |
| Renderer | `pages/jobs/*`, `AppLayout.tsx` | The search card, Refresh button, board reports, auto-refresh toggle and "Last search" segment are removed. Relevant scoring of saved jobs stays. |
| e2e | `e2e/tests/jobs.spec.ts`, `e2e/pages/jobs.ts`, `e2e/fixtures/servers/*` | The mock board pages, `HUNTGRY_JOB_BOARD_BASE_URL_*` and the board specs are gone; one spec checks that filters survive leaving the page. |

Jobs found by the old search and already saved in a workspace are still read and listed, so
queued runs, applications and their drawers keep working. `JobSourceId` keeps `hiring.cafe` and
`indeed` for them.

## Verification

- `npm test`: 1072 unit tests and 52 relay tests pass.
- `npm run typecheck` passes.
- `playwright test e2e/tests/jobs.spec.ts e2e/tests/tailor-queue.spec.ts e2e/tests/browser.spec.ts` passes.
