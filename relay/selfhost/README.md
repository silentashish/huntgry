# Self-hosted relay (workerd + Caddy)

The relay is a Cloudflare Worker with one SQLite-backed Durable Object per room. The same
bundle runs unchanged on any Linux server with [`workerd`](https://github.com/cloudflare/workerd),
Cloudflare's open-source Workers runtime. Durable Objects keep their SQLite databases on local
disk, and alarms and WebSocket hibernation work the same. Huntgry's own relay runs this way at
`relay.huntgry.tech`, on the Oracle Cloud VM that also serves the website
([silentashish/huntgry-website](https://github.com/silentashish/huntgry-website)).

```
phone / desktop ──wss/https──▶ Caddy (TLS, :443, relay.huntgry.tech)
                                 │  X-Forwarded-Proto: https, CF-Connecting-IP
                                 ▼
                               workerd 127.0.0.1:8787 ── relay.capnp ── worker.js (wrangler bundle)
                                 │
                               /var/lib/huntgry-relay  (one SQLite file per room)
```

| File | What it is |
| --- | --- |
| `relay.capnp.tmpl` | workerd config: the Worker, `ROOM` → `Room` with `enableSql`, storage on disk, a loopback socket that trusts `X-Forwarded-Proto` (the Worker refuses plain http), outbound fetch to public addresses only (Expo push). `ADMIN_TOKEN` comes from the environment. |
| `relay.caddy.tmpl` | Caddy site for the relay domain, installed as `/etc/caddy/conf.d/huntgry-relay.caddy`; the website's Caddyfile imports `conf.d/*.caddy`. Sets `X-Forwarded-Proto` and `CF-Connecting-IP` (the admin rate limit is per client IP). |
| `huntgry-relay.service` | systemd unit: `DynamicUser`, state in `/var/lib/huntgry-relay`, read-only system, no privileges, restart on failure. |
| `install.sh` | Runs on the server as root. It installs the files and writes `/etc/huntgry-relay/env` (mode 600) with the admin token, adds the `conf.d` import if the Caddyfile lacks it, then restarts the relay, reloads Caddy and checks for a `401` from `POST /rooms`. It is idempotent. |
| `build.sh` | `wrangler deploy --dry-run --outdir`: bundles the Worker without uploading anything, into `dist/`. |

## Deploy from CI

`.github/workflows/relay-deploy.yml` runs on pushes to `main` that touch `relay/` or the protocol
package, and on demand (Actions → relay-deploy → Run workflow). It does five things:

1. Tests and builds the relay.
2. Fetches the `workerd` build that matches the server's CPU (x86-64 or Arm).
3. Uploads everything over SSH and runs `install.sh`.
4. Checks the relay from inside the server.
5. Checks `https://<domain>/rooms` from outside.

The workflow is skipped until `RELAY_HOST` is set.

Repository settings (Settings → Secrets and variables → Actions):

| Name | Kind | Value |
| --- | --- | --- |
| `RELAY_HOST` | variable | The server's IP, e.g. the website VM's reserved IP |
| `RELAY_DOMAIN` | variable | `relay.huntgry.tech` |
| `DEPLOY_SSH_PRIVATE_KEY` | secret | The same deploy key the website repository uses (its public half is on the VM) |
| `RELAY_ADMIN_TOKEN` | secret | `openssl rand -hex 32`. Paste the same value into Huntgry → Settings → Remote control |

DNS: an `A` record for `relay.huntgry.tech` → the server IP. Caddy fetches the certificate on
the first HTTPS request. The VM's firewall already allows 80 and 443 for the website.

Rotating the admin token: change the secret and re-run the workflow. Existing rooms keep
working, because the token only creates rooms.

## By hand on any server

```sh
sh relay/selfhost/build.sh                             # → relay/selfhost/dist
cp node_modules/@cloudflare/workerd-linux-64/bin/workerd relay/selfhost/dist/   # or -linux-arm64
rsync -a relay/selfhost/dist/ server:/tmp/huntgry-relay/
ssh server 'umask 077; openssl rand -hex 32 > /tmp/huntgry-relay/admin-token; cat /tmp/huntgry-relay/admin-token'
ssh server 'sudo sh /tmp/huntgry-relay/install.sh relay.example.com'
```

The server needs Caddy, plus `curl` for the health check.

## What the server sees

The same as Cloudflare would. That covers room and device ids, token and owner-secret hashes,
pairing ids with their expiry, Expo push tokens, frame sizes and timing, and client IPs. Every
command, event and pairing message is end-to-end encrypted between the desktop and the phone
(ADR-0001). The relay logs nothing about frames; workerd writes only startup and error lines to
the journal.
