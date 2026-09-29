#!/usr/bin/env bash
# Runs ON the server (from setup.sh, and from the GitHub Action on every push to main that changes the backend):
# pull the latest main, rebuild the image, and swap the container. The old container keeps serving until the new
# image has built, so a failed build leaves the running app alone.
set -euo pipefail
cd /opt/luma
git fetch -q origin main && git reset -q --hard origin/main
echo "deploying $(git log -1 --format='%h %s')"
docker build -q -t luma-backend . >/dev/null
docker rm -f luma >/dev/null 2>&1 || true
docker run -d --name luma --restart unless-stopped --env-file /opt/luma.env -p 127.0.0.1:8080:8080 luma-backend >/dev/null
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:8080/health >/dev/null && break; sleep 2; done
curl -sf http://127.0.0.1:8080/health >/dev/null && echo "healthy" || { docker logs --tail 40 luma; exit 1; }
docker image prune -f >/dev/null
