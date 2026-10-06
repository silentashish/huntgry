#!/usr/bin/env sh
# Deploys the relay into the Cloudflare account `wrangler login` is signed into and sets the
# admin token secret. Run from anywhere: `npm run deploy -w relay` or `sh relay/scripts/deploy.sh`.
#
#   ADMIN_TOKEN=<existing>  reuse a token instead of minting one (a redeploy keeps the secret
#                           anyway; pass it only to rotate to a known value)
#   SKIP_SECRET=1           deploy the code only, leave the secret as it is
#
# The token is printed once and never stored here; paste it into Settings → Remote control.
set -eu

cd "$(dirname "$0")/.."

echo "Deploying huntgry-relay with wrangler…"
npx wrangler deploy

if [ "${SKIP_SECRET:-}" = "1" ]; then
  echo "ADMIN_TOKEN left unchanged (SKIP_SECRET=1)."
  exit 0
fi

if [ -z "${ADMIN_TOKEN:-}" ]; then
  # 32 random bytes as 64 hex characters.
  ADMIN_TOKEN="$(openssl rand -hex 32)"
fi

printf '%s' "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN

cat <<EOF

Relay deployed. Paste these into Huntgry → Settings → Remote control (shown once, not saved anywhere):

  Relay URL:    https://<worker-name>.<your-subdomain>.workers.dev  (printed by wrangler above)
  Admin token:  $ADMIN_TOKEN

Lost it? Run this script again to mint a new one; existing rooms keep working (the token only creates rooms).
EOF
