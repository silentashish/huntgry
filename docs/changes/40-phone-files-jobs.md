# #40 — Files and jobs from the phone (desktop side)

Issue: [silentashish/huntgry#40](https://github.com/silentashish/huntgry/issues/40) · Epic #33, E8 · Spec: [ADR-0001](../adr/0001-mobile-remote-control-relay.md) · Builds on #36 (gateway), #24 (safe paths)

## Context & problem

The phone should show a tailored PDF and its page previews, list the saved jobs and add one by
URL, and refresh when the application folders change. #36 (PR #61) already had most of the
gateway side: `file.get` with 24 KiB chunks and the whole-file SHA-256 (size-capped, hashed once
per file version), `jobs.list` paged by cursor and by bytes, `jobs.addUrl` behind
`assertPublicUrl`, and an `applications.changed` event. What was missing against #40's
acceptance criteria:

- `file.get` was tested only with a stand-in resolver, never with the desktop's real
  `resolveApplicationFile`, so none of #24's refusals were covered; the file was opened and
  hashed **by path again** after the check, so a symlink swapped in between would be followed;
  and a refusal reached the phone as the generic `failed`.
- A chunk result could wait 24 h at the relay (the command's ttl), not "10 minutes".
- `jobs.list` dropped dismissed jobs, so there was no "dismissed flag" to send, and the DTO
  had no field for it.
- `jobs.addUrl` returned the job under the id it was saved as, not the canonical id the Jobs
  page lists, and a refusal (private host, "No job posting was found") read as the generic
  `failed`.

The phone screens are #38's app and come later; this change is the desktop side only.

## What changed and why

| Area | Files | Why |
| --- | --- | --- |
| `file.get` | `src/main/remote/gateway.ts` | The resolver (the app wires `resolveApplicationFile`: the id's shape, a real folder inside the workspace, a known regular file, no symlink) runs first; then the file is opened with **`O_NOFOLLOW`**, and the size check, the chunk and the whole-file SHA-256 all come from that one handle (`fileHash` reads through it instead of `createReadStream(path)`). Any refusal is `invalid` with a fixed message, never the path. The result's relay ttl is `min(command ttl, 10 min)` (`FILE_CHUNK_TTL_SECONDS`), so a chunk is dropped after delivery (ack) or 10 minutes. |
| `jobs.list` | `src/main/remote/project.ts` | Every saved job, as the desktop lists them (canonical, newest posting first), dismissed ones included and flagged; `filter` narrows on title, company and location. Still 50 per page or the plaintext budget, by cursor. The DTO is `id` (the canonical id), title, company, location, source, `tailored`, `dismissed`, `savedAt`; never the description or the posting URL. |
| `jobs.addUrl` | `src/main/remote/gateway.ts` | The package's shape check (http(s), no credentials, no local / private host shape), then the desktop's `assertPublicUrl` (DNS), then the desktop's own add-by-URL. A refusal of either is shown as the desktop shows it (`invalid` for the URL, `failed` for the loader), with any path removed. The answer is the saved job under its canonical id (looked up in the list it merged into). |
| `applications.changed` | `src/main/remote/events.ts` (from #41) | Unchanged in substance: the workspace watcher's `applications:changed` (and every review decision's) is forwarded with `ids: []`, which tells the phone to refresh. |
| Protocol package | `src/shared/remote/protocol.ts`, `dto.ts` | **Minor, additive.** `RemoteJob.dismissed?: boolean`, with its guard; `RemoteJob.id` documented as the canonical id. |

## Decisions and alternatives

- **Dismissed jobs are listed, flagged.** The issue asks for a dismissed flag; dropping them
  made the flag meaningless and differed from the desktop's `jobs.list` (dismissed included,
  flagged). The phone can hide them.
- **`O_NOFOLLOW` plus hashing through the handle** closes the window between the safe-path
  check and the read for the last path component. A folder swapped for a symlink in that
  window is still caught by the checks the resolver already makes; the remaining race needs a
  local attacker who can already write the workspace.
- **`applications.changed` keeps `ids: []`** (= "something changed, refresh"). The watcher
  reports bursts of file events without application ids, and diffing a full scan on every
  burst would cost more than the phone's refresh.
- **No byte limit change.** A page of 50 jobs with every label at its 200-character bound is
  over 40 KiB; the projector already stops a page at the plaintext budget and sets
  `nextCursor` (#36), so the phone gets more, smaller pages.
- **Not done here:** the Files and Jobs screens, the phone's reassembly and hash check, and
  their screenshots (#38's app); the phone keeping files only while the app is open is the
  app's rule.

## How to test

```bash
npm test && npm run typecheck && npm run build
```

- `src/main/remote/files.test.ts` (the gateway with the real `resolveApplicationFile` on a copy
  of the demo workspace's `platform-engineer/initech/init-9`): `resume.pdf`, `cover.pdf` and
  both page previews reassemble byte for byte and match the whole-file SHA-256; a 60 000-byte
  PDF is three chunks of 24 576 / 24 576 / 10 848 bytes, each with the same whole-file hash,
  chunk 3 is refused, and a regenerated file gets a new hash; chunk results carry a 10-minute
  ttl; `review-notes.md` is served and `huntgry.json`, `build-report.json`, `resume_data.json`,
  `job-description.md`, `resume.tex`, `master-profile.md`, traversal names and other image
  names are refused; ids that are too short, too long, absolute, with `..` or hidden are
  refused; a symlinked file, a symlinked application folder, a directory named like a page and
  a missing file are refused, and so is a file swapped for a symlink **after** the check
  (`O_NOFOLLOW`), without leaking its content; `jobs.list` pages 120 jobs as 50 / 50 / 20 in
  the desktop's order with the dismissed and tailored flags and no description, and filters;
  `jobs.addUrl` refuses `ftp:`, `file:`, `javascript:`, localhost, private IPs, `.local`,
  credentials and a public name resolving to loopback before any fetch, returns the canonical
  id of a merged job, and shows the loader's refusal; `file.get`, `jobs.list` and
  `jobs.addUrl` with another workspace's id or none are `invalid`; a file written in the
  workspace reaches the phone as `applications.changed` through the real `WorkspaceWatcher`.
- `src/main/remote/project.test.ts`: cursor pages 50 / 50 / 20, every job once, flags, no
  description or posting URL, an unknown cursor restarts at the top.
- `src/shared/remote/dto.test.ts`: the `dismissed` flag accepted, a non-boolean and an extra
  `description` refused.

Manual: not possible yet. It needs a paired phone (#37 pairing, #38 app).

## Follow-ups

- #38: the Files screen (PDF viewer, page previews reassembled and hash-checked, refresh on
  `applications.changed`) and the Jobs screen (search, **Add by URL**), with screenshots.
