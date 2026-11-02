# #191 — Jobs: Oracle HCM Candidate Experience postings read from the requisition API

Issue: [silentashish/huntgry#191](https://github.com/silentashish/huntgry/issues/191) · Builds on #78 (add by URL), #148 (description fallbacks)

## Context & problem

Adding this posting by URL failed with "No job posting was found on that page. Paste the description
instead." although the job was live:

`https://careers.americanexpress.com/en/sites/CX_1/job/26014651/?utm_medium=career+site&utm_source=job+alert`

The site is Oracle HCM Cloud Recruiting, "Candidate Experience" (CE). Many large employers use it,
on their own domain (as here) or on Oracle's
(`https://<tenant>.fa.<dc>.oraclecloud.com/hcmUI/CandidateExperience/en/sites/<site>/job/<id>`).
The page is a single-page app. Its HTML is a ~37 KB shell with no JSON-LD `JobPosting` and no
description, only `og:title`, a truncated `og:description` and `og:site_name`. The hidden loader
window reads it before the app has drawn anything, so `parsePosting` found neither JSON-LD nor 200
characters of prose and returned `null`.

The app loads the job from Oracle's public REST API on the tenant's Oracle host. The shell names
that host on its `<base>` tag (`data-apibaseurl="https://egug.fa.us2.oraclecloud.com:443"`):

```
GET https://egug.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
    ?expand=all&onlyData=true&finder=ById;Id="26014651",siteNumber=CX_1
```

Without sign-in it answers `items[0]` with `Title`, `PrimaryLocation`, `secondaryLocations`,
`ExternalPostedStartDate`, `WorkplaceType(Code)`, `ExternalDescriptionStr`,
`ExternalResponsibilitiesStr`, `ExternalQualificationsStr` (HTML) and `requisitionFlexFields`
(Amex puts the salary range there). A job that is gone answers `200` with `items: []`. The same
path on the company's domain answers `302` to a 404 page, so the Oracle host has to come from the
page, or from the URL when it is already `*.oraclecloud.com`. All of this was checked on
2026-11-02.

## What changed and why

| Area | Files | Why |
| --- | --- | --- |
| Oracle source | `src/main/jobs/sources/oracle.ts` | `oracleRef` recognises `/sites/<site>/job/<id>` (also `requisitions/preview/<id>`) under any prefix (`/en/`, `/hcmUI/CandidateExperience/en/`) and with any query. The API origin comes from the URL when it is https `*.oraclecloud.com`; otherwise it is `null` and read from the page. `ORACLE_PAGE_EXTRACT` is `POSTING_EXTRACT` plus the Open Graph tags and the Oracle hosts the page names (`data-apibaseurl` / `data-fahosturl` first, then `https://*.oraclecloud.com` links). `oracleApiOrigin` accepts a host named by the page only when it is https, `*.oraclecloud.com`, on the default port, with no user info; loopback is accepted only with the dev builds' mock allowance. `requisitionJob` maps a requisition to a `Job`. The description is `ExternalDescriptionStr`, then `## Responsibilities` and `## Qualifications` when the description does not already contain them, all through `htmlToText` as the JSON-LD source does. It also fills location (primary plus secondary), posted date, workplace type, the salary flexfield and the company (`og:site_name`). `readOraclePosting` ties it together (see the diagram). |
| Guarded JSON GET | `src/main/jobs/public-json.ts` | `getPublicJson`: `assertPublicUrl`, then `pinnedFetch` at the checked addresses (the CLI posting fetch's DNS-rebinding guard). The e2e harness's `loopbackOnly` restriction and the dev loopback allowance go through `refusalFor`, as in the hidden loader. No redirects (a 3xx is an error), no cookies or credentials, 15 s timeout, 2 MB cap counted as bytes arrive, JSON or an error. |
| App wiring | `src/main/jobs/loader.ts`, `src/main/{jobs,queue,pipeline,remote,automation}/ipc.ts` | `publicJson()` binds `getPublicJson` to `pinnedFetch` and the build's flags. Every `addByUrl` and `fetchDetails` caller passes it. The automation page budget is unchanged, since the API call is not a Jobright page. |
| Service | `src/main/jobs/service.ts` | `addByUrl` sends a CE URL through `readOraclePosting` and saves it under the URL without tracking parameters. `fetchDetails` does the same for a CE copy, so **Fetch full description** completes a job saved from the Open Graph fallback, and a Jobright job whose employer link is a CE posting. When the service is still down it says so (`ORACLE_UNREACHABLE`) and keeps the saved job. |
| URL hygiene | `src/main/jobs/sources/posting.ts` | `withoutTracking` (`utm_*`, `ref`, `source`, `src`, `gh_src`, `trk`, `tk`) is split out of `urlJobId`, which behaves as before. |
| Tests | `src/main/jobs/oracle.test.ts`, `src/main/jobs/fixtures/oracle-ce-shell.html`, `oracle-ce-requisition.json` | Saved fixtures: the Amex shell trimmed to its head, base tag and app mount, and the API answer trimmed to the fields used, with contact and hiring-manager fields null. No network. |
| e2e | `e2e/fixtures/servers/oracle.ts`, `mock-server.ts`, `e2e/tests/jobs.spec.ts` | The mock server serves a fictional CE shell at `/en/sites/:site/job/:id`, with its base tag pointing at itself, and the requisition API (`items: []` for any other id). The spec adds the posting through the dialog, checks the drawer, the API request and the saved file, then adds a closed job and checks the error. |

## How it works

```mermaid
sequenceDiagram
    participant U as Add job (URL)
    participant S as addByUrl / fetchDetails
    participant L as Hidden loader window
    participant P as careers.example.com (CE shell)
    participant G as getPublicJson (public-URL guard)
    participant O as tenant.fa.dc.oraclecloud.com
    U->>S: https://careers.example.com/en/sites/CX_1/job/26014651/?utm_…
    S->>S: oracleRef → site CX_1, job 26014651
    S->>L: load(url, ORACLE_PAGE_EXTRACT)
    L->>P: GET (refusalFor + request guard, as before)
    P-->>L: shell: og:title, og:description, og:site_name, <base data-apibaseurl>
    L-->>S: page data + Oracle hosts
    S->>S: oracleApiOrigin: https, *.oraclecloud.com, port 443, no user info
    S->>G: GET /hcmRestApi/…/recruitingCEJobRequisitionDetails?…finder=ById;Id="26014651",siteNumber=CX_1
    G->>G: assertPublicUrl, pin addresses, no cookies, 15 s, 2 MB
    G->>O: GET (no redirects)
    alt items[0] is the job
        O-->>G: Title, locations, dates, workplace, description HTML
        G-->>S: JSON
        S->>S: requisitionJob → descriptionComplete: true
    else items: []
        O-->>S: no job
        S-->>U: "This job is no longer posted on <company>: it has probably closed. Paste …"
    else HTTP error, timeout, not JSON, not a list
        S->>S: og:title / og:description → descriptionComplete: false
        Note over S: no Open Graph either → "The careers site's job service could not be reached. … Paste …"
    end
    S-->>U: saved job (URL without utm_*)
```

## Decisions and alternatives

- **The API, not the rendered page.** Rejected: waiting in the hidden loader window until the SPA
  has drawn the description. CE renders late and differently per tenant theme. Waiting would need
  a CE-specific "ready" test against markup Oracle changes between releases. It would also yield
  only text: no posted date, no workplace type, no structured location, and the qualifications and
  responsibilities mixed into the page chrome. The API is what the app itself calls, and it gives
  all of it as fields.
- **The page is still loaded, through the existing loader.** It names the Oracle host for a custom
  domain, and its `og:site_name` is the company: the API has no clean employer name (`LegalEmployer`
  is often null). Its Open Graph tags are the fallback. Loading it the way every posting is loaded
  keeps one path, with its guard, rate limit and human-check detection. For an `oraclecloud.com`
  URL a page that fails to load does not stop the API call.
- **The host from the page is untrusted.** Only https `*.oraclecloud.com` on the default port is
  called, and the request still goes through `assertPublicUrl` and address pinning. Any CE tenant
  is on that domain, so a hostile page could point at another Oracle tenant. The worst case is a
  wrong job description, read as text and never executed. No cookies or credentials are sent.
- **A main-process GET, not the loader window.** Calling the API from the hidden window would send
  that session's cookies and need CORS. A pinned `node:https` request sends nothing but the URL, an
  `accept` header and a user agent.
- **"Closed" only for an empty list.** A `200` with `items: []` is how CE answers for a job that is
  gone. Any other failure (HTTP status, timeout, non-JSON, an answer without `items`) is "could not
  be reached", and the Open Graph fallback is used when the page had it.
- **Sections as `## Responsibilities` / `## Qualifications`.** This matches Jobright's summary
  (#148), so tailoring sees one convention. A section the description already contains is not
  repeated.
- **Tracking parameters dropped only for CE URLs.** The issue asks for it here, and job-alert links
  carry `utm_*`. Other sources keep storing the URL as given; their ids already ignore tracking
  parameters.
- **Apply and the in-app browser are unchanged.** They open the posting URL as before. CE's apply
  pages fall to the generic autofill adapter (`atsForHost` → `generic`), and the browser session's
  public-host guard already covers `*.oraclecloud.com`.

## How to test

- Unit: `npx vitest run src/main/jobs` (`oracle.test.ts`):
  - URL recognition: custom domain, `oraclecloud.com` with `hcmUI/CandidateExperience`, language
    prefix, query, `requisitions/preview`, and URLs that are not CE.
  - API host validation: http, another port, look-alike hosts, user info, private IPs, loopback
    only with the allowance.
  - The extract run on the saved shell in jsdom: the host, the Open Graph tags, no JSON-LD, too
    little text for `POSTING_EXTRACT`. That last check is the bug.
  - Add by URL with the saved API answer: every field, `descriptionComplete: true`, the URL without
    `utm_*`, the exact API URL called. The workplace-type mapping.
  - An `oraclecloud.com` URL whose page fails to load.
  - A closed job, a malformed answer, the Open Graph fallback, no fallback, a non-Oracle host named
    by the page (never called), a human check.
  - Fetch full description completing a fallback job, and keeping it when the service is still down.
  - `getPublicJson`: pinned addresses and no cookie, private and loopback refused before any request
    (and public ones under `loopbackOnly`), redirects not followed, the 2 MB cap, non-JSON, offline,
    timeout.
- e2e: `npx electron-vite build && npx playwright test -c e2e/playwright.config.ts e2e/tests/jobs.spec.ts`
  (`add by URL reads an Oracle Candidate Experience posting from its requisition API (#191)`).
- By hand: Jobs → Add job → paste the Amex URL above. The drawer shows *Senior AI Engineer II -
  Forward Deployed Engineer - Enterprise AI Platforms*, American Express, New York / Sunnyvale /
  Phoenix, posted Oct 28, 2026, with the full description and its Responsibilities and
  Qualifications. The saved file's `url` has no `utm_*`. The posting closes on 2026-11-03. After
  that the same steps should give the "no longer posted" error.

## Follow-ups

- The Tailor CLI's direct fetch (`fetchPostingText` in `src/main/cli/posting.ts`, used by
  `startTailorRun` when a run gets only a URL) still reads the CE shell and fails with "almost no
  text". The queue's Tailor goes through `addByUrl` and is fixed. The CLI path could reuse
  `readOraclePosting` with a plain HTML fetch in place of the loader.
- An Apply autofill adapter for CE's apply flow (`/job/<id>/apply/…`), if CE postings become common
  in Apply.
- `CorporateDescriptionStr` / `OrganizationDescriptionStr` (company boilerplate and benefits) are
  left out of the description. They could be added if tailoring benefits from them.
