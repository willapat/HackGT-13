#!/usr/bin/env bash
# Set up a fresh Ubuntu server (Vultr Cloud Compute) to run the Luma backend: Docker for the app, Caddy for HTTPS
# on the free <ip-with-dashes>.sslip.io name, a firewall that only allows SSH and web traffic, and the code from
# GitHub in /opt/luma. Run it from the repo root on your own machine:
#
#   deploy/vultr/setup.sh <server ip> [ssh key]            # ssh key defaults to ~/.ssh/luma_vultr
#
# Secrets come from your local .env and go to /opt/luma.env on the server (readable by root only); they are never
# committed. The AI loops start switched off unless you run it as LOOPS=on deploy/vultr/setup.sh ..., so a new server
# can be checked while another one still runs them (only one server should run the loops).
set -euo pipefail

IP="${1:?usage: deploy/vultr/setup.sh <server ip> [ssh key]}"
KEY="${2:-$HOME/.ssh/luma_vultr}"
HOST="${IP//./-}.sslip.io"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes "root@$IP")

echo "==> Packages, Docker, Caddy and the firewall"
"${SSH[@]}" 'export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq docker.io caddy git ufw >/dev/null
systemctl enable --now docker >/dev/null
ufw allow 22/tcp >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw --force enable >/dev/null'

echo "==> Secrets from .env"
{
  grep -E '^[A-Z_]+=.+' .env
  if [ "${LOOPS:-off}" != "on" ]; then echo "DISABLE_LOOPS=1"; echo "DISABLE_CALENDAR_SYNC=1"; fi
} | "${SSH[@]}" 'umask 077; cat > /opt/luma.env'

echo "==> Code, image and container"
"${SSH[@]}" 'set -e
[ -d /opt/luma ] || git clone -q https://github.com/willapat/HackGT-13.git /opt/luma
/opt/luma/deploy/vultr/redeploy.sh'

echo "==> HTTPS for $HOST"
"${SSH[@]}" "cat > /etc/caddy/Caddyfile <<EOF
# Luma backend: HTTPS for the sslip.io name (it always resolves to this server), passed to the container
$HOST {
	reverse_proxy 127.0.0.1:8080
}
EOF
systemctl reload caddy || systemctl restart caddy"

for _ in $(seq 1 30); do curl -sf "https://$HOST/health" >/dev/null && break; sleep 3; done
curl -sf "https://$HOST/health" && echo "  <- https://$HOST is up"
