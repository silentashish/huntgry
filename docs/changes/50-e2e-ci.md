# #50 — Optional GitHub Actions workflow for the e2e suite

Issue: [silentashish/huntgry#50](https://github.com/silentashish/huntgry/issues/50) · Epic: #45 · Last of #46–#50

## Context & problem

The repository had no CI at all. #46–#49 gave it a Playwright suite that drives the built
Electron app, runnable with one command on a Mac. This ticket runs that suite (and the vitest
suite with the type checks) in GitHub Actions on every PR, as an **optional** check: the owner
makes it required once the build time and the flake rate are known.

## What changed and why

| Area | Files | Why |
| --- | --- | --- |
| e2e workflow | `.github/workflows/e2e.yml` | `pull_request`, `push` to `main`, `workflow_dispatch`; `concurrency` per ref with cancel-in-progress; `permissions: contents: read`; job `e2e (macOS)` on `macos-latest` with `timeout-minutes: 30` and `continue-on-error: true`: setup-node (Node 26, README says ≥ 22.12 and there is no `engines`) with npm cache, Electron binary cache (`~/Library/Caches/electron`, keyed on the lockfile's electron version, restored before `npm ci`), `npm ci`, `npm run build`, `npx playwright test -c e2e/playwright.config.ts` with `CI=1`, job summary, and on failure two 7-day artifacts: the HTML report and the traces folder. |
| Linux trial | (removed) | An `e2e (Linux, experimental)` job on `ubuntu-latest` under `xvfb-run --auto-servernum` was tried once on the PR and dropped; see "Linux" below. |
| Unit workflow | `.github/workflows/ci.yml` | `unit + typecheck` on `ubuntu-latest`: `npm test`, `npm run typecheck`, also optional. Separate workflow so each has its own badge and can be made required on its own. |
| Job summary | `.github/scripts/e2e-summary.mjs`, `e2e/playwright.config.ts` | When `CI` is set the config adds Playwright's JSON reporter (`e2e/.results/results.json`); the script writes pass / fail / flaky / skipped counts and the duration to `$GITHUB_STEP_SUMMARY` (`if: always()`), and says where the artifacts are when something failed. |
| Docs | `docs/testing/e2e.md` ("CI"), `README.md` (badges, link) | What runs, where the report and the traces land, `gh run download` + `npx playwright show-trace`, why the check is optional and the one-step change to make it required. |

Nothing in `src/` changed.

## Design notes

- **Optional means two things**: `continue-on-error: true` on every job (a failed job shows red
  on the job but the run is reported as successful, so a PR is never blocked) and no
  branch-protection change. Making it required later is `continue-on-error: false` plus adding
  `e2e (macOS)` to the required checks; the doc spells it out.
- **The Electron cache is restored before `npm ci`**, not after: electron's `postinstall`
  downloads the binary through `@electron/get`, which looks in that folder first. The key is the
  version from `package-lock.json`, so a bump invalidates it.
- **The traces come from the retry.** With `CI=1` the config runs `retries: 2` and records the
  trace `on-first-retry`, so a failure that persists has a trace and a test that passes on retry
  is reported as flaky (with its trace too).
- **Two artifacts instead of one** (`e2e-html-report-<os>`, `e2e-traces-<os>`): the report is
  what a reviewer opens, the traces folder is what `show-trace` needs; each is small.

## Integration branch

The workflow needs the complete suite, so this PR is based on `test/45-e2e-integration`:
`test/46-e2e-harness` + `test/47-e2e-dashboard-profile` (already merged there) +
`test/48-e2e-tailor-settings` + `test/49-e2e-jobs-browser-apply`, merged in that order. The PR
description lists the conflicts and how they were resolved; the branch must be rebased onto
`main` once #51–#54 are merged.

## Linux

The trial job (`ubuntu-latest`, `xvfb-run --auto-servernum`, Electron runtime libraries installed,
`kernel.apparmor_restrict_unprivileged_userns=0` for Chromium's sandbox) reached the tests and
then failed all 81 at `electron.launch` with *Missing X server or $DISPLAY*
([run 36789448194](https://github.com/silentashish/huntgry/actions/runs/36789448194)). The
cause is in the harness, not the runner: `appEnv` (`e2e/fixtures/app.ts`) builds the app's
environment from scratch so nothing from the developer's shell leaks in, and `DISPLAY` is not on
its list, so the app under test never sees xvfb's server. Passing `DISPLAY` / `XAUTHORITY`
through on Linux is a one-line change, but the Settings specs would fail next (their fake
`pdflatex` goes under `~/Library/TinyTeX`, a macOS path), so per the ticket the job is left out
and this is a follow-up. The artifact upload steps did run on that failure, which is a second
proof of the artifact path besides the deliberate failure below.

## How this was tested

RUNS_PLACEHOLDER

Locally, on the integrated branch:

```bash
npm install
npm test && npm run typecheck && npm run build
npx playwright test -c e2e/playwright.config.ts
node e2e/fixtures/generate.mts && git status --short e2e/fixtures   # every binary regenerated identically
CI=1 npx playwright test -c e2e/playwright.config.ts e2e/tests/shell.spec.ts && node .github/scripts/e2e-summary.mjs e2e/.results/results.json
```

## Follow-ups

- Make the check required once a few PRs have shown the build time and flake rate (one
  setting change, see the doc).
- `workflow_dispatch` from the Actions tab once after the merge to `main` (test plan of #50).
