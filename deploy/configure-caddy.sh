#!/usr/bin/env bash
set -euo pipefail

CADDYFILE=/srv/proxy/Caddyfile
DOMAIN=codexfactory.gulatilabs.me

if grep -q "$DOMAIN" "$CADDYFILE"; then
  echo "Caddy already configured for $DOMAIN"
else
  cat <<'EOF' | sudo tee -a "$CADDYFILE" >/dev/null

codexfactory.gulatilabs.me {
  reverse_proxy codex-factory:4000
}
EOF
fi

sudo docker exec proxy-caddy-1 caddy reload --config /etc/caddy/Caddyfile
