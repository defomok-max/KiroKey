# Server deployment

KiroKey can run on a VPS or home server in two supported ways:

1. **Docker Compose** — easiest for isolated deployments.
2. **systemd** — best when you clone the repo directly on a Linux server.

Always set `API_KEY` when binding to `0.0.0.0`.

## Requirements

- Node.js 20+ for systemd installs.
- Docker with the Compose plugin for Docker installs.
- A strong `API_KEY`.
- Either copied Kiro AWS SSO cache files or `KIRO_REFRESH_TOKEN` for headless
  operation.

## Docker Compose

```bash
git clone https://github.com/defomok-max/KiroKey.git
cd KiroKey
cp deploy/kiro-router.env.example .env
$EDITOR .env
docker compose up -d --build
docker compose logs -f kiro-router
```

For a headless server, set `KIRO_REFRESH_TOKEN` in `.env`. If you copied Kiro's
AWS SSO JSON files to the server, place them in `./server-data/aws-sso-cache` or
set `KIRO_TOKEN_DIR=/absolute/path/to/cache` before running Compose.
Compose creates the default local cache directory automatically if it is missing.

Health check:

```bash
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:11437/v1/models
curl http://127.0.0.1:11437/health
```

## systemd

```bash
git clone https://github.com/defomok-max/KiroKey.git
cd KiroKey
sudo sh deploy/install-systemd.sh
sudoedit /etc/kiro-router.env
sudo systemctl start kiro-router
sudo systemctl status kiro-router
sudo journalctl -u kiro-router -f
```

The installer builds `dist/`, prunes dev dependencies, installs the unit, and
creates `/etc/kiro-router.env` if it does not exist. It runs the service as the
dedicated `kiro-router` system user with `HOME=/var/lib/kiro-router`.

For copied AWS SSO cache files:

```bash
sudo mkdir -p /var/lib/kiro-router/aws-sso-cache
sudo cp kiro-auth-token.json /var/lib/kiro-router/aws-sso-cache/
sudo chown -R kiro-router:kiro-router /var/lib/kiro-router/aws-sso-cache
sudo chmod 700 /var/lib/kiro-router /var/lib/kiro-router/aws-sso-cache
```

## Firewall and reverse proxy

Expose `11437/tcp` only to trusted IPs, or keep KiroKey on `127.0.0.1` behind
your own reverse proxy. Clients should send:

```http
Authorization: Bearer <API_KEY>
```

## Updating

```bash
git pull
npm ci
npm run build
sudo systemctl restart kiro-router
```

For Docker Compose:

```bash
git pull
docker compose up -d --build
```
