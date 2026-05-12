#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo sh deploy/install-systemd.sh" >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/KiroKey}"
ENV_FILE="/etc/kiro-router.env"
RUN_USER="${RUN_USER:-kiro-router}"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required. Install Node >= 20 first." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node >= 20 first." >&2
  exit 1
fi

if ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/var/lib/$RUN_USER" --shell /usr/sbin/nologin "$RUN_USER"
fi

mkdir -p "$APP_DIR"
tar --exclude .git --exclude node_modules --exclude dist -cf - . | tar -xf - -C "$APP_DIR"
cd "$APP_DIR"

npm ci
npm run build
npm prune --omit=dev
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR" "/var/lib/$RUN_USER"

if [ ! -f "$ENV_FILE" ]; then
  cp deploy/kiro-router.env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE. Edit API_KEY and token settings before starting."
fi
chown root:"$RUN_USER" "$ENV_FILE"

cp deploy/kiro-router.service /etc/systemd/system/kiro-router.service
systemctl daemon-reload
systemctl enable kiro-router
echo "Start after editing $ENV_FILE: systemctl start kiro-router"
