# Huntgry relay

The one server in [ADR-0001](../docs/adr/0001-mobile-remote-control-relay.md): a Cloudflare
Worker plus one Durable Object per room that forwards and queues **opaque ciphertext** between
the desktop and each paired phone, and sends generic push notifications through the Expo push
service. It never sees plaintext, keys or the pairing secret. You run it in your own Cloudflare
account; on the Workers Free plan it costs nothing.

| File | What it is |
| --- | --- |
| `src/worker.ts` | Public routes, admin token check, https-only, credential-in-URL refusal. |
| `src/room.ts` | The `Room` Durable Object: SQLite inboxes, first-frame auth, hibernating sockets, presence, push. |
| `src/push.ts` | Expo push client: fixed body per category, `data: { category }`. |
| `src/auth.ts`, `src/env.ts` | SHA-256 + constant-time compare; bindings and tunables. |
| `wrangler.toml` | Worker name, the `ROOM` binding, the SQLite migration, the tunables. |
| `scripts/deploy.sh` | `wrangler deploy` + `wrangler secret put ADMIN_TOKEN`, prints the token once. |
| `test/` | Miniflare integration tests (`npm test -w relay`). |

## Deploying

Once, on your Mac:

```sh
npm install                 # from the repo root; installs wrangler for this workspace
npx -w relay wrangler login # opens the browser, signs wrangler into your Cloudflare account
npm run deploy -w relay     # = sh relay/scripts/deploy.sh
```

The script runs `wrangler deploy`, mints a random 32-byte admin token, stores it as the
`ADMIN_TOKEN` secret and prints it **once**:

```
Relay URL:    https://huntgry-relay.<your-subdomain>.workers.dev
Admin token:  3f9c…
```

Paste both into **Settings → Remote control** in Huntgry. The desktop stores them encrypted
with `safeStorage` and uses the token only to create its room; after that every call uses the
room's owner secret. Lose the token? Run the script again: it mints a new one, and existing
rooms keep working.

`ADMIN_TOKEN=<value> npm run deploy -w relay` sets a token of your choosing;
`SKIP_SECRET=1 npm run deploy -w relay` redeploys the code and leaves the secret alone.
Local development: `npm run dev -w relay` (`wrangler dev`, with `ADMIN_TOKEN` in a `.dev.vars`
file, which is git-ignored).

## The admin token

`POST /rooms` is the only route that uses it, and the only way to create a room. A wrong or
missing token is rejected in the Worker, before any Durable Object runs (no cost), and
failures are rate-limited per IP (5 per 15 minutes per isolate). The request body carries
`sha256(ownerSecret)`; the room stores that hash only. From then on the desktop authenticates
to its room with the owner secret: `Authorization: Bearer` on its HTTPS calls, and the first
frame `{ auth: { room, owner } }` on its WebSocket.

## Routes

| Route | Auth | Body / notes |
| --- | --- | --- |
| `POST /rooms` | `Bearer <ADMIN_TOKEN>` | `{ ownerSecretHash }` → `{ roomId }` |
| `POST /rooms/:room/pairings` | `Bearer <ownerSecret>` | `{ pairingId, exp }` (ISO, ≤ 10 min ahead) |
| `POST /rooms/:room/devices` | `Bearer <ownerSecret>` | `{ deviceId, tokenHash }` (`sha256(relayToken)`); replaces an existing token and closes its socket |
| `DELETE /rooms/:room/devices/:device` | `Bearer <ownerSecret>` | Revocation: token hash, push token, inbox and socket go |
| `DELETE /rooms/:room` | `Bearer <ownerSecret>` | Wipes the room (**Rotate relay credentials**) |
| `GET /rooms/:room/ws` | first frame | WebSocket; no query string, no `Authorization` / `Cookie` / `Sec-WebSocket-Protocol` |

Everything is `https://` / `wss://` only; a plain `http://` request gets `400`.

### On the socket

The first frame is a `RelayClientFrame.auth` (`{ room, owner }` for the desktop,
`{ room, pairing }` during pairing, `{ room, device, token }` afterwards). A socket that has not
authenticated within 5 s is closed (`4003`); a wrong credential closes with `4002`; a new
socket for the same identity replaces the old one (`4000`). After auth:

- `RelayFrame` (`to`, `ref`, `nonce`, `ct`, `ttl?`, `ack?`, `pushHint?`, `pushText?`): queued in
  the recipient's inbox with a `deliverySeq`, forwarded as `{ to, ref, nonce, ct, ttl }` when the
  recipient has a live socket. A phone may only address `desktop`; the desktop addresses a
  device id or a pairing id.
- `{ ack: ref }` (or `ack` on a `RelayFrame`): deletes `ref` from the sender's own inbox. Frames
  are deleted **only** by an ack or by their `ttl`.
- `{ pushToken }` (paired phones only): stores the Expo token, `null` removes it.
- Notices from the relay: `{ presence, since, queued }` (phones, on connect and on every
  change), `{ queued: true, ref }` (the desktop is offline), `{ expired: true, ref }` (a frame's
  `ttl` passed, live or on the sender's next connection), `{ tooLarge: true, ref, bytes }`.
- On reconnect every unacked frame is redelivered in `deliverySeq` order before live frames.
  A phone's inbox holds at most 50 frames: the oldest *events* are dropped, results never (a
  desktop frame whose `ref` answers a command that phone sent).
- The desktop counts as offline after two missed heartbeats (any frame counts; 30 s period).
- 60 frames per minute per connection; over it the socket closes (`1008`).

### Push

A desktop frame with `pushHint` triggers one Expo push **only** when that phone has no live
socket: title `Huntgry`, the fixed body for the category (`A run needs your reply`,
`Paused: usage limit`, `Pipeline finished`, `Results need your review`, `Something failed`),
`data: { category }`, and `pushText` as the body only when present. One push per category per
5 minutes per device. A `DeviceNotRegistered` ticket deletes the token.

## Free plan limits

The relay is built for the
[Workers Free plan](https://developers.cloudflare.com/workers/platform/pricing/): 100 000
requests a day and 10 ms CPU per request, and
[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing) with
SQLite storage (the only kind the Free plan offers), 100 000 requests a day, 13 000 GB-s of
duration a day and 5 GB of storage. Three things keep a room inside that:

- **Hibernation.** Sockets use the WebSocket Hibernation API, so a room with idle sockets is
  evicted from memory and bills no duration; it wakes for a frame, a close or its alarm. One
  WebSocket message costs 1/20 of a request on the DO side.
- **One alarm.** Auth deadlines, the heartbeat check and the next frame expiry share one alarm;
  a room with no sockets and nothing queued schedules none.
- **Small rows.** A frame is at most 64 KiB and a phone's inbox holds at most 50 of them.

In practice a desktop heartbeat every 30 s is ~2 900 messages a day, well under the daily
request allowance even with a few phones. The dashboard should show close to zero duration
while nothing is happening.

## Tests

```sh
npm test -w relay            # Miniflare: workerd with SQLite Durable Objects and real alarms, ~35 s
npm run typecheck -w relay   # src/ against workers-types, test/ against Node
```

The harness (`test/harness.ts`) bundles `src/worker.ts` with esbuild, starts Miniflare with
the tunables lowered where a test needs them (`AUTH_TIMEOUT_MS`, `HEARTBEAT_SECONDS`,
`PUSH_COALESCE_SECONDS`) and captures the Worker's outbound Expo requests. No real Cloudflare
account or network is involved.

Manual check after deploying: open two `wscat -c wss://…/rooms/<room>/ws` clients, send a
hand-built `{ auth }` frame first on each, exchange frames, kill one client before it acks and
watch the frame come back on reconnect.
