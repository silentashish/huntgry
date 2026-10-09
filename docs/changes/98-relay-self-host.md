# #98 — Self-host the relay on the owner's server (workerd + Caddy)

Issue: [silentashish/huntgry#98](https://github.com/silentashish/huntgry/issues/98) · Epic #33 · Builds on #35 (relay) · Spec: [ADR-0001](../adr/0001-mobile-remote-control-relay.md)

## Context & problem

#35 shipped the relay as a Cloudflare Worker with a Durable Object, deployed with `wrangler
deploy`. Nothing was deployed. The owner wants it on the Oracle Cloud VM that already serves
huntgry.tech (deployed from silentashish/huntgry-website), not in a Cloudflare account. The phone
(#38) and desktop pairing (#37) need a live relay to be tried end to end.

## What changed and why

| Area | Files | Why |
| --- | --- | --- |
| Runtime | `relay/selfhost/relay.capnp.tmpl` | `workerd`, Cloudflare's open-source runtime, runs the **unchanged** bundle. It already ships in `node_modules` for Miniflare. `Room` keeps `enableSql` with storage on local disk, so the SQLite tables, alarms and WebSocket hibernation behave as on Cloudflare. The socket listens on loopback only. `forwardedProtoHeader` makes the Worker see `https://` URLs behind the proxy, because it refuses plain http. Outbound fetch reaches public addresses only (Expo push). `ADMIN_TOKEN` comes from the environment. |
| TLS + routing | `relay/selfhost/relay.caddy.tmpl` | The VM's Caddy serves `relay.huntgry.tech` next to the website and gets its certificate. It sets `X-Forwarded-Proto: https` and `CF-Connecting-IP`; the relay rate-limits admin failures per client IP. |
| Service | `relay/selfhost/huntgry-relay.service` | systemd with `DynamicUser`, a private state directory, read-only system and no privileges. It restarts on failure. |
| Install | `relay/selfhost/install.sh` | An idempotent root script on the server. It writes the files and the token env file (600), and adds `import /etc/caddy/conf.d/*.caddy` if the site's Caddyfile lacks it. It restarts and reloads, then waits for `401` on `POST /rooms`. It cleans the upload. |
| Build | `relay/selfhost/build.sh`, `relay/selfhost/.gitignore` | `wrangler deploy --dry-run --outdir` bundles the Worker without uploading anything. |
| CI | `.github/workflows/relay-deploy.yml` | It runs on `main` pushes touching `relay/` or the protocol, and on demand. Steps: test, build, fetch the `workerd` build for the server's CPU (`uname -m` over SSH), upload, install, then check inside and outside. It is skipped until `RELAY_HOST` is set. |
| Docs | `relay/selfhost/README.md`, `relay/README.md` | Setup (variables, secrets, DNS), the by-hand path, and what the server can see. `wrangler deploy` stays documented for Cloudflare users. |

The website side, a one-line `import /etc/caddy/conf.d/*.caddy` in its Caddyfile template so
the two deploys never overwrite each other, is a separate PR in silentashish/huntgry-website.

## Decisions and alternatives

- **workerd, not a Node port.** Porting the Durable Object (hibernation, SQLite, alarms) to a
  Node server would mean a second implementation and a second test suite. workerd is the
  runtime Miniflare already uses for `npm test -w relay`, so the 52 relay tests exercise the same
  engine that runs in production.
- **Same VM as the website.** The relay is idle most of the time (hibernated sockets, tiny
  SQLite files), and one VM means one firewall, one Caddy and one bill. If the VM's trial-credit
  shape is replaced, the reserved IP and DNS stay, and both deploys reinstall themselves.
- **Admin token in a GitHub secret.** The owner pastes the same value into Settings. It never
  sits in the repo. On the server it is a root-only env file read by systemd.
- **Pinned host key** (`RELAY_HOST_KEY`, `StrictHostKeyChecking yes`) instead of `accept-new`,
  because the deploy sends the admin token over that connection.
- **Fail-safe install.** `install.sh` refuses a blank admin token, and puts the previous Caddy
  snippet back if the new one doesn't validate, since a broken snippet would take the website
  down with it on Caddy's next reload. The outside check fails the run when the domain doesn't
  answer, so a green deploy means the relay is reachable.

## How to test

Local, as done for this PR (no server needed):

1. Run `sh relay/selfhost/build.sh`. Render `relay.capnp.tmpl` with a temp data dir and run
   `ADMIN_TOKEN=x node_modules/.bin/workerd serve relay.capnp`.
2. Without the header, `POST /rooms` returns `400 https required`. With
   `X-Forwarded-Proto: https` and the token, it returns `201 {roomId}`.
3. Put Caddy in front with `local_certs` and the rendered `relay.caddy.tmpl`, then run a Node
   WebSocket client through `wss://localhost:8443`. It creates a room, opens the desktop socket,
   registers a pairing and opens the phone's pairing socket. The phone gets `presence`, and its
   frame reaches the desktop. The desktop's reply reaches the pairing socket, and a device is
   registered.
4. Restart workerd. The device authenticates, and a wrong token is closed with `4002`.
5. `install.sh` was run twice with stubbed `systemctl`. The relay came up on `127.0.0.1:8787`
   (`401`). The import line appeared once, the env file is `600`, the upload was removed and the
   Caddyfile validates.

On the server: set the variables and secrets in `relay/selfhost/README.md`, add the DNS record,
run **relay-deploy**, then `curl -X POST https://relay.huntgry.tech/rooms` should return `401`.

## Follow-ups

- Back up `/var/lib/huntgry-relay` (rooms are recreated by **Rotate relay credentials** if lost,
  at the cost of re-pairing).
