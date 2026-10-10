# `@huntgry/remote-protocol`

The wire contract between the Huntgry desktop, the relay and the phone
([ADR-0001](../../../docs/adr/0001-mobile-remote-control-relay.md), "Message / event schema").
One package, three bundlers: electron-vite imports it as `@shared/remote`, Metro and wrangler
as the workspace package `@huntgry/remote-protocol`. It has **one dependency, `tweetnacl`**,
imports nothing from the rest of `src/shared`, and uses no Node, DOM or React Native API
(`boundary.test.ts` and `tsconfig.json` with `lib: ["ES2022"]`, `types: []` enforce that).

| File | Owns |
| --- | --- |
| `protocol.ts` | Every wire type: `RelayFrame`, `RelayNotice`, `RelayClientFrame`, `Envelope`, `HelloBody`, `RemoteCommand`, `RemoteEvent`, the DTOs (`RemoteRun`, `RemoteQueueItem`, `RemoteQueueState`, `RemoteTranscriptItem`, `RemoteEnqueueInput`, `PipelineStartInput`, `PipelineState`, `PipelineCounts`, `PipelineSummary`, `ReviewItem`, `ReviewList`, `ReviewDetail`, `StatusSummary`, `FileChunk`, `RunPage`, `RemoteJob`, `RemotePage`), the pairing bodies (`PairHello`, `PairOk`), the enums (`REMOTE_AGENT_IDS`, `REMOTE_DATE_STYLES`, `REMOTE_MAX_CONCURRENCY`, `REMOTE_MAX_JOBS`, `NOTIFICATION_CATEGORIES`, `RemoteFile`), `PROTOCOL`, `COMMAND_TTL_SECONDS`, and the name lists `REMOTE_COMMAND_NAMES`, `COSTLY_COMMANDS`, `WORKSPACE_FREE_COMMANDS`, `READ_COMMANDS`, `REMOTE_EVENT_NAMES`. |
| `limits.ts` | `LIMITS` (bytes and counts), `TTL_SECONDS` bounds, `MAX_CLOCK_SKEW_SECONDS`, `utf8Bytes`, `jsonBytes`, `truncateUtf8`. |
| `check.ts` | `ProtocolError`, `errorOf` (a fixed generic message for anything that is not a `ProtocolError`), the `require*` primitives and enum checks. |
| `guards.ts` | Envelope, command, relay-frame guards (hand-written, no schema library), `requireJobUrl` / `isPrivateHostname`, `negotiateProtocol`, `ttlFor`. |
| `dto.ts` | Field-by-field validation of every desktop → phone body: `requireStatusSummary`, `requireRemoteRun`, `requireQueueItem` / `requireQueueState`, `requireTranscriptItem` / `requireTranscriptPage` / `requireRunPage`, `requirePipelineState` / `requirePipelineSummary`, `requireReviewItem` / `requireReviewList` / `requireReviewDetail`, `requireRemoteJob` / `requireJobsPage` / `requireRunsPage`, `requireFileChunk`, `requireEventBody`. The projector runs them before encrypting, the phone before rendering. |
| `crypto.ts` | `tweetnacl` helpers: keypairs, `deriveSessionKey` (`nacl.box.before`), `sealEnvelope` / `openEnvelope` (box), `sealJson` / `openJson` (secretbox for pairing), nonces, base64 / hex, `equalBytes`. |
| `pairing.ts` | Pairing (ADR "Pairing"): `pairingUrl` / `parsePairingUrl` for the QR `huntgry://pair?v=1&relay=…&room=…&pairing=…&pk=…&s=…&exp=…` (`https://` relay only, `expired` after `exp`), `PAIRING_TTL_SECONDS` (120), the `PairMessage` plaintexts `{ pair: 'hello', hello }`, `{ pair: 'ok', ok }`, `{ pair: 'denied', reason }` and `sealPairMessage` / `openPairMessage` (`secretbox` with a 32-byte key). The phone's `pair.hello` is sealed with the QR secret; the desktop's answer goes through `sealPairReply` / `openPairReply`: `pair.ok` (it carries the relay token) under the phone's session key, `pair.denied` under the QR secret. |
| `relay-http.ts` | The relay's HTTPS side: `RELAY_PATHS` (`/rooms`, `/rooms/{id}`, `…/devices`, `…/devices/{id}`, `…/pairings`, `/ws`), the bearer-token rule (admin token on `POST /rooms`, owner secret elsewhere), the request / response bodies (`CreateRoomRequest` / `CreateRoomResponse`, `RegisterDeviceRequest`, `RegisterPairingRequest`) and their guards. Hashes are hex SHA-256 of the secret string as presented. |
| `text.ts` | The only host APIs the package touches: `TextEncoder` / `TextDecoder` and the WHATWG `URL` parser. |
| `crypto.fixture.json` | Pinned keys, session key and ciphertexts so the phone and the desktop cannot drift. |

## Using it

```ts
import { deriveSessionKey, sealEnvelope, openEnvelope, requireEnvelope, requireFresh, requireNextSeq, requireWorkspace, requireCommandEnvelope, errorOf, ttlFor, LIMITS, PROTOCOL } from '@huntgry/remote-protocol' // or '@shared/remote' in main

// Once per pairing, on each side:
const sessionKey = deriveSessionKey(theirPublicKey, mySecretKey)

// Phone → relay: build, size-check and encrypt a command.
const cmd = requireCommand('queue.setPaused', { paused: true }) // throws ProtocolError before anything is sent
const envelope: Envelope = { v: 1, sid, ws, from: 'phone', seq: nextSeq(), ts: new Date().toISOString(), ttl: ttlFor(cmd.name), kind: 'cmd', id: uuid(), name: cmd.name, body: cmd.args ?? null }
requireEnvelope(envelope) // plaintext budget, shapes
const frame: RelayFrame = { to: 'desktop', ref: envelope.id!, ...sealEnvelope(envelope, sessionKey), ttl: envelope.ttl }

// Desktop, on delivery (ADR "Commit order on the desktop"), in this order:
try {
  const plain = openEnvelope(frame, sessionKey) // null when the box does not open
  const env = requireEnvelope(plain, { sid, from: 'phone' }) // v / PROTOCOL, shape, ttl bounds
  requireFresh(env) // now − ts ≤ ttl
  const lastSeq = requireNextSeq(env.seq, device.lastSeq) // strictly increasing, else `denied`
  requireWorkspace(env, currentWorkspaceId) // every command but status.get / device.*
  const command = requireCommandEnvelope(env) // allow-list (`unsupported`) + arguments (`invalid`)
  // … audit write-ahead, execute, answer `{ kind: 'result', re: env.id, ok: true, body }` with `ack: env.id`
} catch (e) {
  log.error(e) // the original stays on the Mac
  reply({ kind: 'result', re: frame.ref, ok: false, error: errorOf(e), body: null })
}
```

**Acknowledging without sending.** A `RelayFrame` always carries a box (`nonce`, `ct`), so a
receiver that has nothing to send back acknowledges with the clear client frame
`{ ack: ref }` (`RelayClientFrame`): the relay deletes that frame from the receiver's inbox
exactly as it does for `RelayFrame.ack`. The phone acks results and events this way; the
desktop acks a command in the same frame as its result (`ack: env.id`).

`errorOf` forwards the message of a `ProtocolError` only; any other exception (filesystem,
network, process errors, which may quote workspace paths) becomes `failed` with
`GENERIC_FAILURE_MESSAGE`. The gateway logs the original itself.

`requireWorkspace` answers `unsupported` for a name outside the allow-list, so an unknown
command without `ws` is `unsupported` whichever of the two checks the gateway runs first
(the phone needs that code to show "update Huntgry").

**`jobs.addUrl` is not fully validated here.** `requireJobUrl` refuses non-http(s) schemes,
credentials, bare names, loopback, link-local, private-network and `.local`-style hosts by
*shape*. A public name can still resolve to a private address, so the gateway must run the
desktop's `assertPublicUrl` (DNS resolution and redirect checks) before fetching anything,
and test loopback and private-host rejection at that boundary.

Every guard returns a fresh object with only the known fields and throws `ProtocolError`
(`code` ∈ `unsupported | invalid | stale | denied | rate-limited | expired | failed`); unknown
command or event names are `unsupported`, everything malformed or over a limit is `invalid`,
a rewound `seq` or a foreign `sid` is `denied`, `now − ts > ttl` is `expired`.

## Limits

All byte limits count UTF-8 bytes of the serialised JSON (`utf8Bytes`).

| `LIMITS` | Value | Applies to |
| --- | --- | --- |
| `frameBytes` | 64 KiB | serialised `RelayFrame`; the relay drops larger ones with `tooLarge` |
| `plaintextBytes` | 40 KiB | serialised `Envelope` before boxing (`requireEnvelope`) |
| `textBytes` | 32 KiB | `run.reply.text`, `review.rerun.answers`, enqueue `notes` |
| `fileChunkBytes` | 24 KiB | binary bytes per `file.chunk` (32 KiB base64) |
| `transcriptItemTextBytes` | 8 KiB | `text` / `output` of one `RemoteTranscriptItem`, then `truncated: true` |
| `transcriptSummaryBytes` / `transcriptDenials` | 1 KiB / 20 | a tool item's `summary`; denials on a result item |
| `transcriptPageItems` | 20 | items per `run.get` page (see the note below) |
| `jobsPageItems` / `runsPageItems` | 50 / 50 | `jobs.list` / `runs.list` page |
| `reviewNotesInlineBytes` | 16 KiB | `ReviewDetail.reviewNotes` inline, else `file.get` |
| `reviewListItems` / `reviewEntryBytes` | 16 / 256 | `openGaps` and `proposedReframings` entries; bytes per gap, source fact or wording |
| `verifyReportBytes` / `reviewArtifacts` | 4 KiB / 16 | `ReviewDetail.verify.report`; artifacts listed |
| `reviewItems` | 50 | `review.list` items (and the plaintext budget; `more` counts the rest) |
| `queueItems` | 20 | items in `RemoteQueueState` (active first, `more` counts the rest) |
| `applicationsChangedIds` | 50 | ids per `applications.changed` |
| `errorBytes` | 1 KiB | `RemoteRun.error`, `RemoteQueueItem.error` |
| `pushTextChars` | 80 | `RelayFrame.pushText` |
| `idChars` / `jobIdChars` / `applicationIdChars` / `cursorChars` | 128 / 64 / 600 / 256 | ids the guards accept |
| `titleChars` / `shortStringChars` | 200 / 2048 | labels in DTOs / messages and URLs |

`COMMAND_TTL_SECONDS` = `{ costly: 7200, default: 86400 }`; `ttlFor(name)` picks by
`COSTLY_COMMANDS` (`pipeline.start`, `queue.enqueue`, `review.approve`, `review.rerun`,
`run.reply`). `TTL_SECONDS` bounds any `ttl` to 1 s … 7 days (Settings may raise a default up
to that). `MAX_CLOCK_SKEW_SECONDS` = 300: a `ts` further in the future is `invalid`.

**Measured** (`frame-size.test.ts`, `FRAME_SIZES=<file>` writes the table): every command and
event built with its largest allowed fields, boxed and base64-encoded, is below 64 KiB. The
largest are `queue.enqueue` with 100 job ids and 32 KiB of notes (53.9 KB), a `review.get`
result with every list and text at its bound (51.2 KB), `queue.changed` with 20 items
(49.3 KB), `file.chunk` (45.7 KB) and a `run.get` result with three 8 KiB items (44.1 KB).

**Transcript pages are bounded by bytes as well as by count.** `requireTranscriptPage` caps
a page at `transcriptPageItems` items and each item at `transcriptItemTextBytes`, but twenty
such items do not fit one frame (the test asserts it, three do), so `run.get` and
`run.transcript` stop a page at 20 items **or** at the plaintext budget, whichever comes
first, and set `nextSeq`. E3's projector owns that rule; `requireEnvelope` is the backstop.

## Crypto

- Identity: one X25519 keypair per Mac and per phone (`generateKeyPair`,
  `keyPairFromSecretKey`).
- Session key: `deriveSessionKey(theirPublicKey, mySecretKey)` = `nacl.box.before`; both sides
  get the same 32 bytes. Pinned in `crypto.fixture.json`: keys 0x01…0x20 and 0x80…0x9f give
  session key `baba246e…5e03`; regenerate the fixture only on a protocol major bump.
- Frames: `sealEnvelope(envelope, sessionKey)` → `{ nonce, ct }` (random 24-byte nonce,
  `nacl.box.after`); `openEnvelope` returns the parsed plaintext or `null` (tampered, wrong key,
  wrong nonce, not JSON). Always run the result through `requireEnvelope`.
- Pairing: `sealPairMessage` / `openPairMessage` (over `sealJson` / `openJson`) = `nacl.secretbox`.
  `pair.hello` and `pair.denied` use the 32-byte QR secret; `pair.ok` uses the phone's session
  key (`sealPairReply` / `openPairReply`), so only the phone that sent the approved hello reads its
  relay token. `crypto.fixture.json` pins a sealed `pair.hello` (`pairHello`, `pairHelloCt`).
  The QR also carries the `pairing` id the phone authenticates with, which the ADR's sequence implies.
- `randomBytes(n)` for pairing secrets, relay tokens and owner secrets; `equalBytes` for
  constant-time comparison of hashes and tokens.
- The phone needs `react-native-get-random-values` before importing the package (Hermes has no
  `crypto.getRandomValues`), and `TextEncoder` / `TextDecoder` (built into React Native ≥ 0.74).

## Tests

- `guards.test.ts`: envelope shape, `v` negotiation, session and sender binding, ttl bounds,
  freshness, strictly increasing `seq`, `ws` on every workspace-scoped command, the command
  allow-list (unknown → `unsupported`), per-limit rejections, events, file chunks, relay
  frames, client auth frames and notices.
- `frame-size.test.ts`: every command and event with its largest fields through the real
  box + base64 path stays under `frameBytes`; the first larger chunk / text is rejected.
- `crypto.test.ts`: box and secretbox round trips with random nonces, tampering, wrong keys,
  base64 / hex edge cases, the pinned fixture.
- `dto.test.ts`: every DTO accepted with only its known fields; the first value over each
  limit, a wrong enum, an unknown field (`params`, `pendingReply`, `workspacePath`) refused.
- `limits.test.ts`, `boundary.test.ts` (imports, host APIs, package.json, tsconfig, the
  workspaces in both package managers).
- `src/main/remote/enums.test.ts` (desktop side): `REMOTE_AGENT_IDS` = `AGENT_IDS`,
  `REMOTE_DATE_STYLES` = `DateStyle`, `REMOTE_MAX_CONCURRENCY` = `MAX_CONCURRENCY`,
  `REMOTE_MAX_JOBS` = `MAX_ENQUEUE`; `deps.test.ts`: no `expo*` / `react-native*` / `wrangler`
  in the root manifest.

## Changing the contract

New optional fields are minor changes. Removing or renaming a field, changing a limit
downwards or a command's semantics is a major: bump `PROTOCOL.max`, keep `min` while old
phones are supported, and update the desktop projector, the relay and the phone together.
Adding a command is one entry in `RemoteCommand`, `REMOTE_COMMAND_NAMES` (and
`COSTLY_COMMANDS` / `READ_COMMANDS` / `WORKSPACE_FREE_COMMANDS` if it applies), one `case` in
`requireCommand`, a row in `frame-size.test.ts`, and the gateway `case`. Adding an event or a
DTO field is the type, a `require*` in `dto.ts` with its bound, a row in `dto.test.ts` and
the largest value in `frame-size.test.ts`. Any dependency change
regenerates both lockfiles (`npm install && pnpm install --lockfile-only`); `npm test` fails
otherwise.
