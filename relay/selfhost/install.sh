#!/bin/sh
# Runs on the server as root (deploy.yml: `ssh … 'sudo sh /tmp/huntgry-relay/install.sh <domain>'`)
# after the bundle and the workerd binary were copied to /tmp/huntgry-relay and the admin token
# to /tmp/huntgry-relay/admin-token. Idempotent: every deploy runs it.
set -eu
DOMAIN="$1"
SRC=/tmp/huntgry-relay
APP=/opt/huntgry-relay
LISTEN=127.0.0.1:8787
DATA=/var/lib/huntgry-relay

install -d -m 755 "$APP" /etc/caddy/conf.d
install -d -m 700 /etc/huntgry-relay

# The admin token only lives in this root-only env file (and in the GitHub secret it came from).
if [ -s "$SRC/admin-token" ]; then
  token=$(cat "$SRC/admin-token")
  [ -n "$token" ] || { echo "The admin token is blank: set the RELAY_ADMIN_TOKEN secret." >&2; exit 1; }
  printf 'ADMIN_TOKEN=%s\n' "$token" > /etc/huntgry-relay/env.new
  chmod 600 /etc/huntgry-relay/env.new
  mv /etc/huntgry-relay/env.new /etc/huntgry-relay/env
fi
[ -s /etc/huntgry-relay/env ] || { echo "No admin token: set the RELAY_ADMIN_TOKEN secret." >&2; exit 1; }

install -m 755 "$SRC/workerd" "$APP/workerd"
install -m 644 "$SRC/worker.js" "$APP/worker.js"
sed -e "s#@LISTEN@#$LISTEN#" -e "s#@DATA_DIR@#$DATA#" "$SRC/relay.capnp.tmpl" > "$APP/relay.capnp"
install -m 644 "$SRC/huntgry-relay.service" /etc/systemd/system/huntgry-relay.service

# The website's Caddyfile imports /etc/caddy/conf.d/*.caddy; add the import if an older one doesn't.
grep -q 'import /etc/caddy/conf.d/\*.caddy' /etc/caddy/Caddyfile || printf '\nimport /etc/caddy/conf.d/*.caddy\n' >> /etc/caddy/Caddyfile
# A broken snippet would stop Caddy (and the website) on its next reload, so keep the previous
# one unless the new config validates.
SITE=/etc/caddy/conf.d/huntgry-relay.caddy
[ -f "$SITE" ] && cp "$SITE" "$SRC/previous.caddy"
sed -e "s#@DOMAIN@#$DOMAIN#" -e "s#@LISTEN@#$LISTEN#" "$SRC/relay.caddy.tmpl" > "$SITE"
if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; then
  if [ -f "$SRC/previous.caddy" ]; then mv "$SRC/previous.caddy" "$SITE"; else rm -f "$SITE"; fi
  echo "The Caddy config for $DOMAIN does not validate; kept the previous one." >&2
  exit 1
fi

systemctl daemon-reload
systemctl enable huntgry-relay >/dev/null 2>&1
systemctl restart huntgry-relay
systemctl reload caddy

# Wait for workerd, then check it answers like the relay (401 without the admin token).
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-Forwarded-Proto: https' "http://$LISTEN/rooms" || true)
  [ "$code" = "401" ] && { echo "relay up on $LISTEN (POST /rooms without token → 401)"; rm -rf "$SRC"; exit 0; }
  sleep 1
done
echo "relay did not answer on $LISTEN" >&2
journalctl -u huntgry-relay -n 40 --no-pager >&2
exit 1
