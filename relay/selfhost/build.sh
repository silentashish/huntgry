#!/usr/bin/env sh
# Builds the self-hosted relay bundle into relay/selfhost/dist/: wrangler's Worker bundle
# (`wrangler deploy --dry-run`, nothing is uploaded) plus the workerd config, systemd unit,
# Caddy site and installer. `deploy.yml` uploads that folder to the server and runs install.sh.
set -eu
cd "$(dirname "$0")/.."

rm -rf selfhost/dist
npx wrangler deploy --dry-run --outdir selfhost/dist/bundle >/dev/null
cp selfhost/dist/bundle/worker.js selfhost/dist/worker.js
rm -rf selfhost/dist/bundle
cp selfhost/relay.capnp.tmpl selfhost/relay.caddy.tmpl selfhost/huntgry-relay.service selfhost/install.sh selfhost/dist/
echo "Built relay/selfhost/dist ($(wc -c < selfhost/dist/worker.js) bytes of Worker)"
