# #42 — Review from the phone, revision-bound (desktop side)

Issue: [silentashish/huntgry#42](https://github.com/silentashish/huntgry/issues/42) · Epic #33, E7 · Spec: [ADR-0001](../adr/0001-mobile-remote-control-relay.md) ("Revision-bound approvals") · Builds on #31 (review service), #41, #40, #72

## Context & problem

#31 built the review of unattended results on the desktop: a detail pinned by a `revision`,
Approve (ticked reframings become standing approvals), Re-run with answers, Discard, all
refused as `stale` when the result changed and as `invalid` for a reframing id outside the
revision. The gateway still answered `unsupported` for every `review.*` command,
`StatusSummary.review.unreviewed` was always 0, and `review.needed` was never sent.

The phone must approve only **what it was shown**: the exact snapshot (notes, gaps, reframings,
verify report, every PDF and page preview), and only the reframings it ticked, which it names by
id and never by text. A revision it never fetched is not good enough, even if it is current.

The phone screens are #38's app and come later; this change is the desktop side only.

## What changed and why

| Area | Files | Why |
| --- | --- | --- |
| Gateway | `src/main/remote/gateway.ts` | `review.list`, `review.get`, `review.approve`, `review.rerun`, `review.discard` call the desktop's review service, bound to the checked workspace. `review.get` records the served revision **per device and pairing** (with the result, its run and the reframing ids it listed); the record lives in the gateway, which outlives every relay reconnect. A decision on a revision this device was not served (for that result or run) is `denied`; an approved id it was not shown in full is `invalid`, before anything is read or written; then the service rebuilds the detail from disk and answers `stale` on any difference. A decision's answer is the new detail, served too, so the phone can decide again. The write-ahead audit entry of each decision carries `detail: { applicationId \| runId, revision, ids }`. Without a review service (older wiring, tests) `review.*` still answer `unsupported`; the `NOT_YET` list is gone. |
| Projections | `src/main/remote/project.ts` | `projectReviewDetail`: the desktop's detail under the desktop's own `revision` (sha256 over the full notes, gaps, reframing ids, verify report, every artifact's sha256, and the review state), inside the package bounds; `projectReviewItem` / `projectReviewList` (newest first, 50 and the plaintext budget, `more`). What does not fit is `truncated`: a gap or report is cut, a reframing that does not fit whole is **left out** (so it cannot be approved from the phone), PDFs and every page 1 are listed before further pages, and when the whole detail would not fit one frame the inline notes go first (the phone fetches `review-notes.md` with `file.get`). |
| Review service | `src/main/review/service.ts`, `src/main/review/ipc.ts` | `reviewForRemote` and `reviewDepsFor(ws)`: the desktop's `reviewDeps` with the workspace bound (`WorkspaceChangedError` otherwise) and the re-run reply through the queue for that workspace, like the desktop's Re-run; `changed` stays `afterReviewDecision`, so a phone decision refreshes the Tailor page, the counts and the dock badge exactly like a desktop one (#72). `openGapCount` (the list badge, notes only, no PDF hashing), `isSettledReview` (not still being built, not re-running), `RERUN_REASON`. A short cache for the status count, cleared by every decision. |
| Events and status | `src/main/remote/events.ts`, `src/main/remote/ipc.ts` | After queue, application-folder and pipeline-summary events (debounced), the results are listed again; one that is newly waiting for review and **settled** (its run done with it) is announced as `review.needed { count, latest }`, which carries the `needs-review` push hint (`pushText`: its title). The first listing per workspace is the baseline. `StatusSummary.review.unreviewed` counts the settled results (what the dock badge counts) and is refreshed when it changes. |
| Audit | `src/main/remote/audit.ts` | `AuditStart.detail` (optional). |
| Protocol package | `src/shared/remote/protocol.ts`, `dto.ts`, `limits.ts` | **Minor, additive.** `ReviewDetail` gains optional `state`, `reason`, `parseWarning` (≤ 1 KiB each) and `truncated`; `ReviewItem` optional `state` (`unreviewed` / `needs-attention`) and `reason`; new `ReviewList { items, more? }` for the `review.list` result (it had no defined body) with `requireReviewList`; `LIMITS.reviewItems` = 50. The frame-size row puts every new field at its bound: the largest `review.get` result still fits one frame. |

### One approval

```mermaid
sequenceDiagram
    participant P as Phone
    participant G as gateway.ts
    participant S as review/service.ts
    participant D as Disk (workspace, authority store)
    P->>G: review.get { applicationId }
    G->>S: reviewDetail(ws, id)
    S->>D: notes, report, PDFs + pages (sha256), review state
    S-->>G: detail + revision
    G->>G: project (bounds) · served[device, sid][revision] = { app, run, listed ids }
    G-->>P: ReviewDetail
    P->>G: review.approve { applicationId, revision, approvedReframingIds }
    G->>G: served for this device and result? else denied
    G->>G: every id listed in full? else invalid (nothing written)
    G->>G: audit start { detail: revision, ids } + fsync
    G->>S: approveReview(reviewDepsFor(ws), …, 'phone:<device>')
    S->>D: rebuild detail; revision differs? → stale (nothing written)
    S->>D: state approved + content revision; standing approvals = on-disk pairs of the ids; review-audit.jsonl
    S->>S: deps.changed() = afterReviewDecision (desktop refresh, queue outcomes, badge)
    S-->>G: new detail
    G-->>P: ReviewDetail (state approved), served
```

## Decisions and alternatives

- **The desktop's revision, not a second one.** The issue's revision is "sha256 over the notes,
  gaps, reframing ids, verify report and every artifact's sha256"; #31's `revision` hashes
  exactly that plus the review state, so a decision made before a re-run or another decision
  is stale too. The phone and the Review page pin the same snapshot, and the service's own
  `stale` check is the one that runs.
- **Served revisions live in the gateway, per device and pairing.** A socket reconnect keeps
  them (tested through `RemoteSession` with a dropped relay). An app restart forgets them, and a
  re-pair starts a new list: the phone gets `denied` and fetches the detail again, which is the
  safe direction. Persisting them would let a revision outlive what the owner can see on the
  Mac's audit trail of `review.get`. At most 64 per device.
- **Only ids listed in full can be approved.** A source fact or wording longer than
  `LIMITS.reviewEntryBytes` is not cut on the wire, it is left out and the detail is marked
  `truncated`, so the phone never approves a reframing whose text it showed only in part. The
  standing approval is still written from the on-disk pair, never from phone text.
- **Where standing approvals go.** The issue names `<workspace>/.huntgry/approved-reframings.json`;
  #31 moved standing approvals to the review authority store under userData (an agent can write
  the workspace). The phone writes through the same `addApprovals` as the desktop.
- **`review.rerun` carries no reframing ids** (the protocol has none): the answers go alone,
  trimmed, non-empty, ≤ 32 KiB (package) and ≤ `MAX_TEXT` (desktop). The served revision must
  belong to the run named.
- **Discard deletes nothing.** It is the desktop's Discard: the review state and the
  application's tracking status (`archived`); every file stays.
- **`review.needed` waits for the run.** A result is marked Unreviewed while its unattended run
  still builds (#31's in-progress mark) and while it re-runs with answers; announcing those
  would push before there is anything to review. The count in the status follows the same rule.
- **Not done here:** the phone's Review screens, per-reframing ticks, "Approve after page 1 of
  each preview loaded", and their screenshots (#38's app).

## How to test

```bash
npm test && npm run typecheck && npm run build
```

- `src/main/remote/review.test.ts` (the gateway on the real review service and authority
  store): the list (newest first, gap counts, state and reason, no path); the detail (inline
  notes, gaps, ids = `sha256(sourceFact + "\n" + wording)`, verify, every artifact's bytes and
  sha256, the desktop's revision); **the revision changes for each of** notes, gaps, a reframing,
  the verify report, `resume.pdf` and a page preview, and not when nothing changed; a detail with
  oversized entries and JSON-escaped text fits one frame, marks `truncated`, leaves out a
  reframing that does not fit, and that id is `invalid`; an approval clears Unreviewed with
  `via: phone:<id>`, calls the decision hook once, saves only the ticked on-disk pair, and is in
  both audit logs with the revision and the ids. **The five refusals, each leaving the standing
  approvals file byte for byte and the result Unreviewed:** a forged id (`invalid`), an id from
  another application (`invalid`), a stale revision after the notes were edited (`stale`), a
  regenerated PDF (`stale`), a revision never served to this phone, including the current one
  served only to another phone and one served for another result (`denied`, also for discard
  and re-run). Re-run: wrong run `denied`, blank answers `invalid`, answers reach the reply path
  and the result is Unreviewed ("Re-running…"), the old revision is then `stale`. Discard keeps
  every file. `review.needed`: baseline, nothing for a result still being built, one event with
  the count and the latest when it settles, status count follows. **Served revisions survive a
  reconnect** (`RemoteSession`, relay drop, approve after reconnecting).
- `src/main/remote/pipeline.test.ts` (#42 case, real pipeline, queue, run manager and fake
  agent): after a phone-started pipeline, `review.list` and `review.get` show the result;
  `review.rerun` sends the answers into the **same run and session** through the queue (no new
  job), `run.changed` shows it working, the verify gate settles it Unreviewed again; approving
  the new revision clears Unreviewed and the queue item follows (#72).
- `src/main/remote/project.test.ts`: `review.list` bounded by count and bytes with `more`, no
  path from a reason. `src/shared/remote/dto.test.ts`, `frame-size.test.ts`: the new optional
  fields and `ReviewList`, their refusals, and the largest `review.get` result in one frame.

Manual: not possible yet. It needs a paired phone (#37 pairing, #38 app).

## Follow-ups

- #38: the Review list and detail screens, page previews via `file.get`, per-reframing ticks,
  Approve enabled only after the page-1 previews for that revision loaded, and screenshots.
- If served revisions should survive an app restart, persist them per pairing next to
  `devices.json`.
