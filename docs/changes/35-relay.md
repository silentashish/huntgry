# #35 — Relay (Cloudflare Worker + Durable Object)

Issue: [silentashish/huntgry#35](https://github.com/silentashish/huntgry/issues/35) · Epic #33, E2 · Spec: [ADR-0001](../adr/0001-mobile-remote-control-relay.md) · Contract: `@huntgry/remote-protocol` (#34, PR #56; HTTPS routes from #36, PR #61)

## Context & problem

ADR-0001 lets a phone control Huntgry through an end-to-end encrypted relay. The relay is the
only server in the design. It must route and hold frames for a Mac that sleeps and a phone
that is mostly offline. It must wake the phone with a push without knowing what happened. It
must cost nothing on the Workers Free plan. And it must never see plaintext, keys or the
pairing secret.

This ticket builds `relay/`: the Worker, the per-room Durable Object, the Expo push client,
Miniflare integration tests and a deploy script. The desktop gateway (#36) and the phone
(#38) talk to it only through the protocol package.

## What changed and why

| Area | Files | Why |
| --- | --- | --- |
| Worker | `relay/src/worker.ts` | Public routes, exactly the shared contract (`RELAY_PATHS` and the body guards in `relay-http.ts`). `GET /ws` reads the `{ auth }` frame, connects to the room it names and forwards both ways (see Decisions); `/rooms/:room/ws` is the same socket routed by path. `POST /rooms` checks `Authorization: Bearer <ADMIN_TOKEN>` in the Worker, so a wrong token never reaches a Durable Object, and counts failures per IP (5 per 15 min, then `429` with `Retry-After`). The body is `{ ownerSecretHash }`, a hex SHA-256, checked by `requireCreateRoomRequest`; a plaintext secret or any unknown field is refused. Pairing and device registration, revocation and room deletion are forwarded to the room with the owner secret as a bearer. Both socket routes refuse a query string and any `Authorization`, `Cookie` or `Sec-WebSocket-Protocol` header. Any `http:` request is `400`. Nothing is logged. |
| Room | `relay/src/room.ts` | Bodies checked with `requireRegisterDeviceRequest` / `requireRegisterPairingRequest`; a pairing socket is closed at the pairing's `exp` (`4006`); at most 50 frames per phone wait for an offline desktop. One SQLite-backed Durable Object per room, sockets on the Hibernation API. Tables: `meta` (owner hash, presence), `pairings`, `devices` (token hash, push token), `inbox` (one row per frame, `seq` = deliverySeq, recipient, sender, `ref`, the forwarded frame, expiry, result flag), `notices` (pending `{ expired, ref }`), `pushes` (last push per device and category). Details below. |
| Push | `relay/src/push.ts` | Expo push client: title `Huntgry`, the fixed body per `NotificationCategory`, `data: { category }`, `pushText` only when present. A `DeviceNotRegistered` ticket is reported so the room deletes the token. |
| Auth helpers | `relay/src/auth.ts`, `relay/src/env.ts` | SHA-256 hex and constant-time compare (`equalBytes` from the package); the bearer scheme is the package's `BEARER`, the hex check is the package's guard (no copy in the relay). Tunables with the ADR defaults: heartbeat 30 s, auth timeout 5 s, coalescing 5 min, Expo URL. |
| Config | `relay/wrangler.toml`, `relay/package.json`, `relay/tsconfig*.json` | `ROOM` binding with a `new_sqlite_classes` migration (the Free plan's Durable Object kind), the tunables as `[vars]`, observability off. `src/` type-checks against workers-types only; `test/` against Node. |
| Deploy | `relay/scripts/deploy.sh` | `wrangler deploy`, then `openssl rand -hex 32` → `wrangler secret put ADMIN_TOKEN`, printed once. `ADMIN_TOKEN=` reuses a value, `SKIP_SECRET=1` leaves it. Not run against a real account in this PR. |
| Tests | `relay/test/*.test.ts`, `relay/test/harness.ts`, `relay/vitest.config.ts` | 52 relay tests, Miniflare plus two unit files (list under "How to test"). The harness builds every URL with `RELAY_PATHS` and every body as the contract's request types, parses `POST /rooms` with `requireCreateRoomResponse`, and connects through `/ws` unless a test asks for the direct route. It bundles the Worker with esbuild and captures outbound Expo calls with Miniflare's `outboundService`. |
| Protocol (HTTPS) | `src/shared/remote/relay-http.ts`, `relay-http.test.ts`, `index.ts`, `README.md` | Cherry-picked from #36 (5252fae) unchanged: the routes, the bearer rule and the request / response bodies both sides share. |
| Protocol (frames) | `src/shared/remote/protocol.ts`, `guards.ts`, `guards.test.ts`, `README.md` | `RelayClientFrame` gains `{ ack: string }`. A `RelayFrame` always carries a box, so without it a phone could only acknowledge a result by sending a new frame to the desktop, which would itself need an ack. |
| Workspace | root `package.json`, `pnpm-workspace.yaml`, both lockfiles, `boundary.test.ts` | `npm test` and `npm run typecheck` include the relay workspace. pnpm needs `linkWorkspacePackages: true` to resolve `@huntgry/remote-protocol` from the workspace. The boundary test now reads only the `packages:` block of `pnpm-workspace.yaml`. Both lockfiles regenerated; the root manifest gains no dependency. |
| Docs | `relay/README.md`, this file | Deploying, the admin token, routes and socket rules, Free plan limits with the pricing pages the ADR cites. |

### Inside the room

```mermaid
sequenceDiagram
    participant P as Phone
    participant R as Room DO (SQLite)
    participant D as Desktop
    participant X as Expo push
    P->>R: wss /ws, first frame { auth: { room, device, token } } (the Worker routes it to the room)
    R->>R: sha256(token) == devices.token_hash? (else close 4002; nothing within 5 s: close 4003)
    R-->>P: { presence, since, queued }
    R-->>P: pending { expired, ref } notices, then every unacked frame in deliverySeq order
    P->>R: RelayFrame { to: 'desktop', ref: cmd.id, ttl, ct }
    R->>R: INSERT inbox (owner = desktop, seq = deliverySeq, expires = now + ttl)
    alt desktop socket open
        R->>D: { to, ref, nonce, ct, ttl } (ct untouched)
    else desktop offline
        R-->>P: { queued: true, ref }
    end
    D->>R: RelayFrame { to: deviceId, ref: cmd.id, ack: cmd.id, ct, pushHint? }
    R->>R: DELETE inbox[desktop] ref = cmd.id, INSERT inbox[device] (result = 1)
    alt phone socket open
        R->>P: forward
    else phone offline and pushHint and not pushed this category in 5 min
        R->>X: { to: token, title: 'Huntgry', body: fixed body, data: { category } }
    end
    P->>R: { ack: cmd.id }
    R->>R: DELETE inbox[device] ref = cmd.id
    Note over R: one alarm: auth deadlines, pairing expiry (close 4006), desktop heartbeat (2 missed → close 4005, presence offline), next ttl → { expired, ref }
```

- **Clear fields only.** The room parses each frame with `requireRelayFrame` and reads `to`,
  `ref`, `ttl`, `ack`, `pushHint` and `pushText`. It forwards `{ to, ref, nonce, ct, ttl }`, so
  `ct` and `nonce` arrive byte for byte and `ack`, `pushHint` and `pushText` stop at the relay.
  A frame over `LIMITS.frameBytes` is answered with `{ tooLarge, ref, bytes }` and the socket
  stays open. Any other malformed frame closes with `1008`. The close reason quotes the
  guard's message, never the frame.
- **Deletion.** A frame leaves an inbox only on an ack of its `ref`, either the
  `RelayFrame.ack` field or the new `{ ack }` client frame, or when its `ttl` passes. The one
  extra rule from the ADR is the cap: at most 50 frames per phone, dropping the oldest events.
  The phone → desktop direction has the same cap while the desktop is away: the oldest go and
  the phone is told `{ expired, ref }`, as if their ttl had passed. A frame counts as a result, which is never dropped, when the desktop acks the same `ref` in
  it or when its `ref` matches a command that phone has queued for the desktop.
- **Ordering.** On authentication the room sends every row for that identity
  `ORDER BY seq`, synchronously, before it returns to the event loop. Durable Objects
  process one event at a time, so a live frame arriving meanwhile is queued behind the
  backlog. The test sends a live frame immediately after the desktop reconnects and checks
  the order.
- **Presence.** Any frame from the desktop counts as a heartbeat. The alarm closes the
  desktop socket after `2 × HEARTBEAT_SECONDS` of silence and tells every phone
  `{ presence: 'offline' }`. Phones get presence on connect and on every change, with
  `queued` = their own commands waiting for the desktop.
- **Push.** Only on a frame with `pushHint`, only to a device (not a pairing socket), only
  when that device has no socket, at most once per category per 5 minutes per device. The
  token is registered with `{ pushToken }` on the phone's own authenticated socket. Its shape
  is checked twice, once by the package guard and again in the room. A new token replaces the
  old one. It is deleted on `{ pushToken: null }`, on revocation and on `DeviceNotRegistered`.

## Decisions and alternatives

- **`GET /ws` as the shared contract names it, with the room only in the auth frame.** The
  Worker cannot pick a Durable Object before a frame arrives, so for `/ws` it accepts the
  socket, reads the first frame (at most 2 KiB, must be `auth` with a well-formed room id,
  within the 5 s auth timeout), opens a socket to that room and forwards both ways without
  parsing anything else. Up to 16 frames sent right behind the auth frame are held until
  the room answers. The room re-checks the whole auth frame, so the Worker grants nothing.
  The cost: the Worker stays in the path for the socket's life and spends CPU on every frame,
  and the Free plan caps a request at 10 ms CPU. The room side still hibernates.
  **`/rooms/:room/ws` stays** as the direct, Worker-free route (the room id is not a
  credential). It is the fallback if a long desktop session hits that CPU cap; moving the
  clients to it is a one-line change to `RELAY_PATHS.socket`, left to the owner.
- **Phone → desktop cap of 50 frames per phone.** The ADR's "50 queued frames per device"
  had only been applied to the desktop → phone inbox. A paired phone could reconnect to reset
  its per-connection rate limit and fill the room's storage while the Mac sleeps. The oldest
  frames go first, with an `{ expired, ref }` notice, which the phone already handles.
- **Pairing sockets close at `exp`**, as `RegisterPairingRequest` documents; the alarm covers
  it. `pairingId` and `deviceId` `"desktop"` are reserved.
- **`{ ack }` as a client frame**, added to the protocol package in this PR. The ADR has the
  phone send "`RelayFrame { ack: ref }`", but `RelayFrame` requires `nonce` and `ct`, so that
  frame would have to be a real box to the desktop. The desktop would then need to ack it, and
  so on forever. A clear, relay-consumed `{ ack }` mirrors `{ pushToken }`. #36 can still put
  `ack` on its result frames, and both forms behave the same.
- **One socket per identity.** A reconnect closes the previous socket with `4000`. This is
  what makes "redeliver on reconnect" well-defined. Two live desktop sockets would split
  delivery.
- **Frames for unknown recipients are dropped silently.** A desktop frame to a revoked device
  or an expired pairing has nowhere to go, and a notice would tell an attacker nothing useful.
  The desktop already knows which devices it revoked.
- **Expired notices are stored** for the desktop and for devices (100 per owner), not for
  pairing sockets, which live for two minutes.
- **Admin-failure limiting is per isolate, in memory.** Rejecting before touching storage is
  the ADR's point: a Durable Object or KV write per failed attempt would cost exactly what the
  check is there to avoid. A determined attacker spread across isolates still faces a 32-byte
  random token.
- **Rate limit: 60 frames per rolling minute per connection, then close.** Dropping silently
  would break the inbox contract. Queuing would let one client fill the room. The counter is
  in memory, which is fine because a hibernated socket is by definition not sending.
- **Miniflare 4 from Node, not `@cloudflare/vitest-pool-workers`.** Driving the Worker from
  outside exercises the real WebSocket path, hibernation included, and keeps the root vitest
  run separate. wrangler 4.145 bundles a Miniflare 5 alpha whose Node API is undocumented, so
  the tests pin the last stable 4.x. wrangler is still the tool for `dev` and `deploy`.
- **Tunables as `[vars]`.** Tests lower the auth timeout, heartbeat and coalescing window to
  run in seconds against real alarms. A test pins the shipped `AUTH_TIMEOUT_MS = "5000"`.

## How to test

```sh
npm install
npm test                      # lockfile check, desktop vitest, then the relay's Miniflare suite (~35 s)
npm run typecheck             # includes typecheck:relay
npm test -w relay             # relay only
```

The Miniflare suite covers:

| File | Covers |
| --- | --- |
| `worker.test.ts` | Admin token required (missing, wrong, wrong scheme), hash-only body, per-IP `429`, plain `http` / `ws` refused on both socket routes, owner routes need the owner secret and an existing room, registration validation, room deletion, device ids with `/`, spaces and `%` round-trip through `RELAY_PATHS.device` to revocation, credentials in the query string or headers refused on `/ws` and `/rooms/:room/ws`, `/ws` refusing a first frame that is not auth or names a malformed, unknown or oversized room, frames sent right behind the auth frame forwarded both ways, the room's close codes (`4000`, `4001`) reaching the client through the Worker, both routes reaching the same room. |
| `auth.test.ts` | 5 s default pinned, unauthenticated socket closed at the deadline, owner, device and pairing auth (and wrong secret, token, device, room, unregistered or expired pairing), the first frame must be `auth`, one socket per identity, double auth, malformed frames, token replacement closes the old socket, a pairing socket closed at its `exp` (`4006`), the reserved pairing id. |
| `pending.test.ts`, `rate.test.ts` | The `/ws` pre-room buffer bounds; the rate window across a JSON round trip and its reset after a minute. |
| `inbox.test.ts` | `ct` / `nonce` forwarded unchanged and relay-only fields stripped, `tooLarge`, phones address only the desktop, queue → ack → delete with both ack forms in both directions, `{ queued }`, disconnect-before-ack redelivery in order ahead of a live frame, ttl expiry notice live and on the next connection, the 50-frame cap keeping the result, the 50-frame cap on one phone's frames to an offline desktop with `{ expired }` notices, the 60 frames/min limit. |
| `presence.test.ts` | Offline, online and offline notices with `since` and `queued`, offline after two missed heartbeats with the desktop socket closed. |
| `push.test.ts` | Push only when the phone has no socket, fixed body, `data.category`, `pushText`; coalescing, including a second push after a short window; token shape, replacement and `null`; only paired phones may register; `DeviceNotRegistered` deletes the token; revocation deletes the token hash, push token and inbox and closes the socket. |

Manual (not done here: no real Cloudflare deploys in this PR). Run `npm run deploy -w relay`
in a personal account, open two `wscat -c wss://<relay>/ws` clients, send
`{"auth":{"room":"<room>","owner":"<secret>"}}` on one and a device auth on the other,
exchange frames, kill one client before it acks, reconnect and see the frame again. The
Durable Object dashboard should show close to zero duration while idle.

## Review round 1 (PR #59)

| Finding | Change | Test |
| --- | --- | --- |
| `deviceId` `..` resolved `DELETE …/devices/..` to `DELETE /rooms/<room>/` and wiped the room | `requirePathId` in the shared contract refuses `.` / `..`; every `RELAY_PATHS` builder applies it (separate commit, carried to #61) | `relay-http.test.ts`, `worker.test.ts` |
| The 50-frame cap could not bound an inbox of results only | A result for a phone holding 50 results is refused before its command ack is consumed (`{ expired, ref }` to the desktop, the command stays queued); retransmissions are not stored twice | `inbox.test.ts` |
| The rate window lived in memory and reset on hibernation | The window (`rate.ts`) is kept in the socket attachment | `rate.test.ts` (Miniflare does not evict the object within a test's time, so the round trip is pinned at unit level) |
| No reply to a client-initiated close (compatibility date before `web_socket_auto_reply_to_close`) | `webSocketClose` answers with the same code; the harness now awaits the reply instead of sleeping | `worker.test.ts`, both routes |
| `DeviceNotRegistered` arriving later in the receipt was ignored | Ok ticket ids are stored with their token and read from `getReceipts` after `PUSH_RECEIPT_DELAY_SECONDS`, from the alarm | `push.test.ts` |
| The `/ws` pre-room buffer was bounded by count only | `pending.ts`: one frame ≤ 64 KiB, all ≤ 128 KiB, else `1009` | `pending.test.ts` |
| Transient Expo failures suppressed the category for 5 min | A failed attempt no longer counts for coalescing; durable retries are #70 | `push.test.ts` |
| SQLite row quotas undocumented | README: limits, rough rows per event, what exhaustion does, what to watch | — |
| CI (Linux): DELETE test saw `4002` instead of `4004` | The harness's `f.desktop()` returned before the room had authenticated the desktop, so a fast DELETE beat the auth frame through `/ws` (a correct `4002`). It now waits until a pairing observer sees `presence: online` | the whole suite |

## Follow-ups

- **#36 (desktop gateway)**: cherry-picks this PR's `{ ack }` commit; this PR carries #36's
  `relay-http.ts` commit, so whichever merges second drops the duplicate on rebase. The relay
  implements `RELAY_PATHS` as is, including `/ws`.
- **Watch the `/ws` Worker's CPU** on the first real deploy (Workers dashboard, CPU time per
  request). If long sessions are cut off, point `RELAY_PATHS.socket` at `/rooms/{roomId}/ws`.
- **Bounded retries for transient Expo failures**: #70. Today a failed push no longer counts
  for coalescing, so the next hint retries, but a lone failure is not retried on its own.
- **Durable rate-limit state** if abuse is ever observed: a per-IP counter in a small
  Durable Object, touched only after the in-memory limit trips.
- **Real-account smoke test** with `wscat` and the dashboard check, by the owner after merge.
