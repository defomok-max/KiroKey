#!/usr/bin/env bash
# kiro-router launcher (Linux / macOS).
#
# Usage:
#   ./start.sh                          # auto-install deps + start the server
#   ./start.sh --set-password           # set a password (prompts interactively)
#   ./start.sh --set-password <pw>      # set a password in one line
#   ./start.sh --set-password --random  # generate a strong random password
#   ./start.sh --show-password          # print the current password (if any)
#   ./start.sh --clear-password         # remove the persistent password
#   PORT=12345 ./start.sh
#   HOST=127.0.0.1 ./start.sh           # bind to localhost only
#   API_KEY=secret ./start.sh           # one-shot password via env
#
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

if [ ! -d node_modules ] || [ package.json -nt node_modules ] || { [ -f package-lock.json ] && [ package-lock.json -nt node_modules ]; }; then
  echo "[kiro-router] installing dependencies (one-time)..."
  npm install --silent --no-audit --no-fund
fi

# Dispatch sub-commands (password management) before launching the server.
case "${1:-}" in
  --set-password)
    shift
    exec npm run --silent set-password -- "$@"
    ;;
  --clear-password)
    exec npm run --silent clear-password
    ;;
  --show-password)
    exec npm run --silent show-password
    ;;
  -h|--help)
    sed -n '2,16p' "$0"
    exit 0
    ;;
esac

echo "[kiro-router] starting on http://${HOST:-0.0.0.0}:${PORT:-11437}"
exec npm start
