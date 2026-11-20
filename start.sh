#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi
NODE_BIN="${NODE_BIN:-node}"
if [ -x /root/node22/bin/node ]; then NODE_BIN=/root/node22/bin/node; fi
exec "$NODE_BIN" bridge.js
