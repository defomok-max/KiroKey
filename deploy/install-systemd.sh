#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo sh deploy/install-systemd.sh" >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/KiroKey}"
ENV_FILE="/etc/kiro-router.env"
RUN_USER="${RUN_USER:-kiro-router}"
RUN_HOME="/var/lib/$RUN_USER"
TOKEN_DIR="$RUN_HOME/aws-sso-cache"
SERVICE_FILE="/etc/systemd/system/kiro-router.service"

unit_escape() {
  printf '%s' "$1" | sed "s/'/'\\\\''/g; s/.*/'&'/"
}

if ! command -v node >/dev/null 2>&1; then
  echo "node is required. Install Node >= 20 first." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node >= 20 first." >&2
  exit 1
fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >/dev/null 2>&1; then
  echo "Node >= 20 is required. Current version: $(node -v)" >&2
  exit 1
fi

if ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$RUN_HOME" --shell /usr/sbin/nologin "$RUN_USER"
fi

install -d -m 0755 "$APP_DIR"
install -d -o "$RUN_USER" -g "$RUN_USER" -m 0700 "$RUN_HOME"
install -d -o "$RUN_USER" -g "$RUN_USER" -m 0700 "$TOKEN_DIR"
mkdir -p "$APP_DIR"
tar --exclude .git --exclude node_modules --exclude dist --exclude .env --exclude server-data -cf - . | tar -xf - -C "$APP_DIR"
cd "$APP_DIR"

npm ci
npm run build
npm prune --omit=dev
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR" "$RUN_HOME"

if [ ! -f "$ENV_FILE" ]; then
  cp deploy/kiro-router.env.example "$ENV_FILE"
  echo "Created $ENV_FILE. Edit API_KEY and token settings before starting."
fi
chown root:"$RUN_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=KiroKey OpenAI/Anthropic proxy
Documentation=https://github.com/defomok-max/KiroKey
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$(unit_escape "$APP_DIR")
EnvironmentFile=-$(unit_escape "$ENV_FILE")
Environment=NODE_ENV=production
Environment=HOME=$(unit_escape "$RUN_HOME")
Environment=KIRO_SERVER_MODE=1
Environment=HOST=0.0.0.0
Environment=PORT=11437
Environment=KIRO_TOKEN_DIR=$(unit_escape "$TOKEN_DIR")
ExecStart=/usr/bin/node $(unit_escape "$APP_DIR/dist/server.js")
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$(unit_escape "$RUN_HOME")

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable kiro-router
echo "Start after editing $ENV_FILE: systemctl start kiro-router"
