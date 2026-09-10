#!/usr/bin/env bash
set -euo pipefail
source /etc/os-release
if [[ "$ID" != rhel || "${VERSION_ID%%.*}" != 9 ]]; then
  echo 'Release verification requires Red Hat Enterprise Linux 9.' >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) process.exit(1)'
export WRANGLER_WRITE_LOGS=false WRANGLER_SEND_METRICS=false
export WRANGLER_SEND_ERROR_REPORTS=false CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false
cat /etc/redhat-release
node --version
npm --version
git rev-parse HEAD
npm ci --no-audit --no-fund
npm run typecheck
npm run lint
npm test
docker build --target test -t talember-greeting-verify renderer
docker run --rm --network none --entrypoint python3 talember-greeting-verify /app/test_renderer.py
npm run build
