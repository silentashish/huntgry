# `@huntgry/remote-protocol`

The wire contract between the Huntgry desktop, the relay and the phone
([ADR-0001](../../../docs/adr/0001-mobile-remote-control-relay.md), "Message / event schema").
One package, three bundlers: electron-vite imports it as `@shared/remote`, Metro and wrangler
as the workspace package `@huntgry/remote-protocol`. It has **one dependency, `tweetnacl`**,
imports nothing from the rest of `src/shared`, and uses no Node, DOM or React Native API
(`boundary.test.ts` and `tsconfig.json` with `lib: ["ES2022"]`, `types: []` enforce that).

| File | Owns |
| --- | --- |
| `protocol.ts` | Every wire type: `RelayFrame`, `RelayNotice`, `RelayClientFrame`, `Envelope`, `HelloBody`, `RemoteCommand`, `RemoteEvent`, the DTOs (`RemoteRun`, `RemoteQueueItem`, `RemoteQueueState`, `RemoteTranscriptItem`, `RemoteEnqueueInput`, `PipelineStartInput`, `PipelineState`, `PipelineSummary`, `ReviewItem`, `ReviewDetail`, `StatusSummary`, `FileChunk`, `RunPage`, `RemoteJob`, `RemotePage`), the pairing bodies (`PairHello`, `PairOk`), the enums (`REMOTE_AGENT_IDS`, `REMOTE_DATE_STYLES`, `REMOTE_MAX_CONCURRENCY`, `REMOTE_MAX_JOBS`, `NOTIFICATION_CATEGORIES`, `RemoteFile`), `PROTOCOL`, `COMMAND_TTL_SECONDS`, and the name lists `REMOTE_COMMAND_NAMES`, `COSTLY_COMMANDS`, `WORKSPACE_FREE_COMMANDS`, `READ_COMMANDS`, `REMOTE_EVENT_NAMES`. |
| `limits.ts` | `LIMITS` (bytes and counts), `TTL_SECONDS` bounds, `MAX_CLOCK_SKEW_SECONDS`, `utf8Bytes`, `jsonBytes`, `truncateUtf8`. |
| `guards.ts` | Hand-written `require*` validators (no schema library), `ProtocolError` with the `Envelope.error.code` to answer with, `errorOf`. |
| `crypto.ts` | `tweetnacl` helpers: keypairs, `deriveSessionKey` (`nacl.box.before`), `sealEnvelope` / `openEnvelope` (box), `sealJson` / `openJson` (secretbox for pairing), nonces, base64 / hex, `equalBytes`. |
| `text.ts` | The only host API the package touches: `TextEncoder` / `TextDecoder`. |
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
  reply({ kind: 'result', re: frame.ref, ok: false, error: errorOf(e), body: null })
}
```

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
| `transcriptPageItems` | 20 | items per `run.get` page (see the note below) |
| `jobsPageItems` | 50 | `jobs.list` page |
| `reviewNotesInlineBytes` | 16 KiB | `ReviewDetail.reviewNotes` inline, else `file.get` |
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
result with 16 KiB of inline notes (50.7 KB), `queue.changed` with 20 items (49.3 KB), a
`run.transcript` event with four 8 KiB items (47.1 KB) and `file.chunk` (45.7 KB).

**Transcript pages are bounded by bytes as well as by count.** Twenty items of 8 KiB each do
not fit one frame (the test asserts it), so `run.get` and `run.transcript` stop a page at
`transcriptPageItems` items **or** at the plaintext budget, whichever comes first, and set
`nextSeq`. E3's projector owns that rule; `requireEnvelope` is the backstop.

## Crypto

- Identity: one X25519 keypair per Mac and per phone (`generateKeyPair`,
  `keyPairFromSecretKey`).
- Session key: `deriveSessionKey(theirPublicKey, mySecretKey)` = `nacl.box.before`; both sides
  get the same 32 bytes. Pinned in `crypto.fixture.json`: keys 0x01…0x20 and 0x80…0x9f give
  session key `baba246e…5e03`; regenerate the fixture only on a protocol major bump.
- Frames: `sealEnvelope(envelope, sessionKey)` → `{ nonce, ct }` (random 24-byte nonce,
  `nacl.box.after`); `openEnvelope` returns the parsed plaintext or `null` (tampered, wrong key,
  wrong nonce, not JSON). Always run the result through `requireEnvelope`.
- Pairing: `sealJson` / `openJson` = `nacl.secretbox` with the 32-byte QR secret.
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
`requireCommand`, a row in `frame-size.test.ts`, and the gateway `case`. Any dependency change
regenerates both lockfiles (`npm install && pnpm install --lockfile-only`); `npm test` fails
otherwise.
