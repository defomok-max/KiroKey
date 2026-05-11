#!/usr/bin/env bash
# kiro-router launcher (Linux / macOS).
#
# Usage:
#   ./start.sh           # auto-install deps + start the server
#   PORT=12345 ./start.sh
#   API_KEY=secret ./start.sh
#
# Pass any extra env vars in the environment — they are forwarded to node.
# See README for full configuration.

set -euo pipefail

cd "$(dirname "$0")"

# Pick up nvm/asdf-installed node if available.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[kiro-router] ERROR: node is not installed."
  echo "Install Node >= 20 from https://nodejs.org/ and re-run this script."
  exit 1
fi

NODE_MAJOR=$(node -v | sed -E 's/^v([0-9]+).*/\1/')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[kiro-router] ERROR: Node >= 20 required (you have $(node -v))."
  exit 1
fi

if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  echo "[kiro-router] installing dependencies (one-time)..."
  npm install --silent --no-audit --no-fund
fi

echo "[kiro-router] starting on http://${HOST:-127.0.0.1}:${PORT:-11437}"
exec npm start
