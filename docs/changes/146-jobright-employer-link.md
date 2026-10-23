# #146 — Employer posting links for Jobright jobs, via a one-time Jobright sign-in

Issue: [silentashish/huntgry#146](https://github.com/silentashish/huntgry/issues/146)

## Context & problem

Jobs added from Explore (#142) kept Jobright's page (`jobright.ai/jobs/info/<id>`) as their link.
**Open posting**, **Fetch full description**, tailoring and autofill all went through Jobright
instead of the employer's own posting.

The GitHub list has no employer link: its table names the company's homepage and the Jobright
page, nothing else. newgrad-jobs.com, linked from the README, embeds a Jobright page whose
`applyUrl` is the Jobright page again. Jobright does know the posting, though. A posting page is a
Next.js page, and its `__NEXT_DATA__` has:

- `props.pageProps.logined`: whether the page was rendered for a signed-in user;
- `props.pageProps.dataSource.jobResult.applyLink` and `originalUrl`: the employer's posting,
  **only when signed in**. Signed out, both are absent and APPLY NOW opens "Sign Up to Apply".

This was checked with Playwright (signed out) and in a signed-in Chrome. The fields are in the
server-rendered HTML, so a page load with the session's cookies is enough.

## What changed and why

| Area | Files | Why |
| --- | --- | --- |
| Employer link | `src/main/explore/employer-link.ts` | `JOBRIGHT_PAGE_EXTRACT` reads `logined`, `applyLink` and `originalUrl` in the hidden loader. `employerLink` keeps `applyLink` (else `originalUrl`) only when it is http(s), has no credentials and is not on a Jobright host; `utm_*` parameters are dropped. `resolveEmployerLink` saves it as the job's `url` (the public-URL guard runs first) and keeps the Jobright page as `boardUrl`. It never throws: on any failure the job keeps its Jobright link. |
| Sign-in | `src/main/explore/account.ts`, `src/main/jobs/loader.ts` | **Connect** opens a visible window on the hidden loader's persistent session (`persist:huntgry-jobboards`), on a Jobright posting from the Explore list. After each page load on a Jobright host, the posting is checked in the background; once it reports `logined: true` the window closes. Closing it by hand checks once more. Popups (Google sign-in) open as child windows on the same session, and the window uses a Chrome user agent. **Check sign-in** loads one posting. **Disconnect** removes Jobright's cookies and site data from the session. The last state seen (`connected`, `checkedAt`) is kept in the app settings, never in the workspace. |
| Account state and races | `src/main/explore/account-state.ts`, `src/main/explore/deps.ts`, `src/main/jobs/loader.ts` | From Codex's review of the PR. State writes are serialized. Every probe takes the account *generation* before it loads, and its result is dropped once Disconnect has bumped it. Disconnect also closes the sign-in window, clears the cookies, waits for queued loads (`loaderIdle`) and clears them again. A page load that arrives while a check runs triggers one more check after it (`createProbe`), so a sign-in that finishes mid-check still closes the window. Connect with no cached posting (a fresh workspace) fetches the Explore list first, or says why it can't, before opening a window. Disconnect is exclusive (`createSignInLifecycle`): a Connect or Check asked for meanwhile starts after its cleanup, employer links are not looked up during it, and it waits only for the Connect it cancels, never for one started later (Codex's second round). |
| When links are resolved | `src/main/explore/service.ts`, `src/main/explore/ipc.ts`, `src/main/jobs/ipc.ts` | On **Add to Jobs** of a new job, and before **Fetch full description** of a job with a Jobright copy, but only while the account was last seen connected. A user who never connected loads nothing extra. Every page that reports `logined` updates the state, so an expired session shows as Not connected. |
| Human check message | `src/main/jobs/service.ts` | "Jobright shows full job descriptions only after a human check" now only applies while the job's link is still the Jobright page. The employer site's own check gets the generic message. |
| Settings | `src/renderer/src/pages/settings/JobrightCard.tsx`, `SectionNav.tsx`, `index.tsx`, `navigation.ts` | A **Jobright** card and section: Connected / Not connected, when it was last checked, **Connect Jobright** (Reconnect), **Check sign-in** and **Disconnect**. A card below the agent check that is opened by name is scrolled back into view once the cards above it are drawn. |
| Explore | `src/renderer/src/pages/explore/index.tsx` | While Jobright is not connected, an info alert explains the employer links, and its **Connect Jobright** button opens Settings at the card. |
| API | `src/shared/explore-types.ts`, `src/preload/explore.ts`, `src/main/workspace/settings.ts` | `explore.account`, `connect`, `checkAccount`, `disconnect`; `JobrightAccount`; `AppSettings.jobright`. |
| Tests | `src/main/explore/employer-link.test.ts`, `src/main/explore/account-state.test.ts`, `src/renderer/src/pages/settings/JobrightCard.test.ts`, `e2e/tests/explore-jobright.spec.ts`, `scripts/mock-ats/jobright.mjs`, `e2e/fixtures/servers/mock-server.ts`, `e2e/pages/*` | Unit tests: the extract run against a fake document, link validation, add while connected or not, signed-out, no-link and failure cases, fetching the description from the employer page, and the human-check message. The mock Jobright pages now carry Next.js data; `/jobright/signin` sets an httpOnly cookie, after which the pages give `applyLink` on the mock's other origin. The e2e covers the Explore hint, Connect, an add with the employer link, the description fetched from it, Disconnect and Check; Connect from Settings in a workspace that never opened Explore; and Disconnect while a sign-in window is open. |

## Decisions and alternatives

- **The hidden loader's session, not the in-app Browser's.** The pages that need the sign-in are
  the ones the hidden loader loads (Fetch full description already does). The Browser page has its
  own partition, which stays separate.
- **A page check, not a cookie check.** Jobright's session cookie is httpOnly with an unknown name.
  Only a posting page's `logined` says for sure, so the state is the last one a page reported.
- **Per job, never the whole list.** One Jobright page per job the user adds or fetches, under the
  loader's per-host gap. Resolving all of Explore's rows would hit rate limits and human checks.
- **Explore keeps the GitHub list.** newgrad-jobs.com's list comes from an internal Jobright API
  (`/swan/mini-sites/list`): it has more rows and filters, but it is undocumented, robots.txt
  disallows `/swan/`, and Jobright's terms forbid automated access. Out of scope here.

- **A generation counter, not locks.** Loads run in the loader's own queue, and a page that is
  already rendering cannot be cancelled. Dropping stale results is enough to keep Disconnect final.

## How to test

- `npx vitest run src/main/explore src/renderer/src/pages/settings`
- `npm run build && npx playwright test -c e2e/playwright.config.ts e2e/tests/explore-jobright.spec.ts e2e/tests/explore.spec.ts`
- By hand: open Explore and click **Connect Jobright** in the hint, then **Connect Jobright** in
  Settings. Sign in on Jobright in the window; it closes and the card says Connected. Add a job from
  Explore: its **Open posting** goes to the employer's site, and **Fetch full description** reads it.
