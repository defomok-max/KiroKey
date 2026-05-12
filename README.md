# KiroKey (kiro-router)

**A fast, multi-account proxy that turns your Kiro IDE subscription into an
OpenAI / Anthropic-compatible API.** Drop it in front of OpenCode, Kilo Code,
Cline, Continue.dev, Roo Code, Claude Code, or any tool that speaks
`/v1/chat/completions` or `/v1/messages`.

> 🇷🇺 На русском — [README.ru.md](README.ru.md)

---

## TL;DR — 3 steps

1. **Authenticate.** Two options:

   - **Built-in login (no Kiro IDE required)** — opens AWS Builder ID device-code
     flow in your browser, then writes the token to the same cache file Kiro IDE
     uses, so the proxy auto-picks it up:

     ```bash
     npm run login
     ```

   - **Or just log into Kiro IDE once** (https://kiro.dev) — Kiro writes
     `~/.aws/sso/cache/kiro-auth-token.json` for you. You can log into multiple
     Kiro accounts — KiroKey picks up all of them and rotates between them.

2. **Clone + start** (needs Node ≥ 18):

   ```bash
   git clone https://github.com/defomok-max/KiroKey.git
   cd KiroKey
   ./start.sh            # Linux / macOS  (or: start.cmd on Windows, or: make start)
   ```

   You should see:

   ```
   kiro-router: starting port=11437 ...
   accounts: reloaded total=1 ids=[aws-sso:kiro-auth-token]
   kiro-router: listening url=http://127.0.0.1:11437
   ```

3. **Point any OpenAI-compatible tool at it:**

   - **Base URL**: `http://<host>:11437/v1` — use `127.0.0.1` if on the same
     machine, or the LAN/VPN IP of the box running KiroKey.
   - **API Key / Password**: see [Set a password](#set-a-password) below.
   - **Model**: `claude-sonnet-4.5` (or `claude-opus-4.7`, `claude-haiku-4.5`, …)

That's it. Quick test:

```bash
curl http://127.0.0.1:11437/health
curl http://127.0.0.1:11437/v1/models
```

## Set a password

The default `HOST` is `0.0.0.0` so the proxy is reachable from your LAN/VPN.
**You should set a password** so only you (or who you share it with) can use
your Kiro subscription.

Easiest — one-time persistent password, server picks it up on every start:

```bash
./start.sh --set-password            # prompts (input hidden)
./start.sh --set-password mySecret   # one-liner
./start.sh --set-password --random   # generate strong random one
./start.sh --show-password           # print the stored value
./start.sh --clear-password          # remove it
```

The equivalent npm scripts also work: `npm run set-password`,
`npm run show-password`, `npm run clear-password`. Stored at
`~/.kiro-router/password` (`0600`).

Alternatively use the `API_KEY` (or alias `PASSWORD`) env var — it wins over
the stored file, useful for CI/Docker:

```bash
API_KEY=mySecret ./start.sh
```

Clients always send it as **`Authorization: Bearer <password>`**.

If neither is set AND `HOST=0.0.0.0` (the default), startup logs a loud
open-proxy warning.

---

## Why this exists

Inspired by [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute),
which is a much larger general-purpose router covering 160+ providers.
KiroKey is laser-focused on Kiro only and is faster + more stable for that
single use case because it:

- has **zero runtime dependencies** (just Node ≥ 20, ~280 KB compiled),
- uses **keep-alive HTTPS pooling** to AWS CodeWhisperer (no TLS handshake
  per request),
- **proactively refreshes tokens** in the background ~5 minutes before they
  expire — your first request after idle never blocks on a refresh,
- supports **multiple Kiro accounts** with auto-discovery, round-robin /
  least-used / priority routing, and **automatic failover** on 401 / 429 / 5xx.

## Endpoints

| Method | Path                              | Description                                              |
| ------ | --------------------------------- | -------------------------------------------------------- |
| POST   | `/v1/chat/completions`            | OpenAI Chat Completions (streaming SSE + non-streaming)  |
| POST   | `/v1/messages`                    | Anthropic Messages API (streaming SSE + non-streaming)   |
| GET    | `/v1/models`                      | List Claude models exposed via Kiro                      |
| GET    | `/health`                         | Liveness + per-state account summary                     |
| GET    | `/admin/accounts`                 | Full per-account status (tokens redacted)                |
| GET    | `/admin/stats`                    | Aggregate counters across all accounts                   |
| POST   | `/admin/refresh`                  | Kick a proactive refresh sweep                           |
| POST   | `/admin/reload`                   | Rescan `~/.aws/sso/cache` and merge new accounts         |
| POST   | `/admin/accounts/:id/reset`       | Clear cool-downs / failure counters for one account      |
| POST   | `/admin/accounts/:id/disable`     | Pause routing to this account without deleting state     |
| POST   | `/admin/accounts/:id/enable`     | Resume routing to a previously disabled account          |

Supported models (proxied to AWS CodeWhisperer):

| Model id              | Notes                                |
| --------------------- | ------------------------------------ |
| `claude-sonnet-4.5`   | Default daily-driver, fast + capable |
| `claude-sonnet-4.6`   | Newer Sonnet                         |
| `claude-haiku-4.5`    | Fastest / cheapest                   |
| `claude-opus-4.6`     | Highest-quality                      |
| `claude-opus-4.7`     | Latest Opus                          |

## Install

```bash
git clone https://github.com/defomok-max/KiroKey.git
cd KiroKey
npm install
```

Requires Node ≥ 18. Once dependencies are installed, you can:

| Command           | What it does                                          |
| ----------------- | ----------------------------------------------------- |
| `./start.sh`      | Install deps if needed and start the server (recommended) |
| `start.cmd`       | Same as above on Windows                              |
| `make start`      | Same, via Make                                        |
| `npm start`       | Just start (assumes deps installed)                   |
| `npm run dev`     | Start with auto-reload on source changes              |
| `npm run build`   | Compile TypeScript → `dist/`                          |
| `npm run login`   | Built-in AWS Builder ID device-code login (writes `~/.aws/sso/cache/kiro-auth-token.json`) |
| `npm test`        | Run unit tests                                        |
| `npm run typecheck` | TypeScript check, no emit                           |
| `npm run check`   | `typecheck` + scripts/tests typecheck + tests          |

## Getting Kiro tokens

KiroKey picks up **every account** in `~/.aws/sso/cache/` and rotates between
them. You have two ways to populate it:

### Option A — built-in login (no Kiro IDE)

Fastest path. Runs the standard AWS Builder ID device-code flow:

```bash
npm run login
```

Opens a verification URL in your browser. Log in once, the script saves the
token to `~/.aws/sso/cache/kiro-auth-token.json` (mode `0600`) and the proxy
auto-picks it up. Repeat for additional accounts (pass `--out=...` to write to
a different file name).

Flags / env:

- `--no-open` — don't try to auto-launch a browser
- `--region=<aws-region>` — default `us-east-1`
- `--start-url=<url>` — IDC start URL (default: AWS Builder ID portal)
- `--out=<path>` — custom token file path
- `KIRO_REGION`, `KIRO_START_URL`, `KIRO_TOKEN_DIR`, `KIRO_TOKEN_FILE` —
  environment overrides

### Option B — Kiro IDE

- **AWS Builder ID** (free) — install
  [Kiro IDE](https://kiro.dev), open it, click "Sign in with AWS Builder ID".
  Kiro writes `~/.aws/sso/cache/kiro-auth-token.json`.
- **Google / GitHub** (Cognito social login) — also supported.
- **AWS Identity Center (IDC)** — enterprise, works too (set `KIRO_PROFILE_ARN`
  if needed).

After signing in, you should see files like
`~/.aws/sso/cache/kiro-auth-token.json` containing a `refreshToken` starting
with `aorAAAAAG`. The router auto-discovers all such files.

### Adding more accounts

Just log into Kiro IDE with another account (or copy a second JSON into
`~/.aws/sso/cache/`). KiroKey will pick it up **without restart** thanks to
filesystem watching. Verify with:

```bash
curl http://127.0.0.1:11437/admin/accounts | jq
```

### Headless / Docker / remote box

If you can't run Kiro IDE on the same machine, copy the `refreshToken` from
`~/.aws/sso/cache/kiro-auth-token.json` on your laptop and set:

```bash
export KIRO_REFRESH_TOKEN="aorAAAAAG..."
./start.sh
```

The router will use that single account.

## Run forever (optional)

**systemd (Linux):**

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/kiro-router.service <<EOF
[Unit]
Description=kiro-router
After=network.target

[Service]
ExecStart=$(which npm) start
WorkingDirectory=$PWD
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user enable --now kiro-router
systemctl --user status kiro-router
```

**pm2 (any OS):**

```bash
npm install -g pm2
pm2 start "npm start" --name kiro-router
pm2 save
pm2 startup   # follow the printed instructions
```

**Windows** — easiest is to run `start.cmd` in a terminal window, or use
`pm2-windows-service` for a real service.

## Configuration

All knobs are environment variables. Copy `.env.example` and `source .env`,
or export them directly.

| Variable                    | Default             | Description                                              |
| --------------------------- | ------------------- | -------------------------------------------------------- |
| `PORT`                      | `11437`             | HTTP port                                                |
| `HOST`                      | `0.0.0.0`           | Bind address (set `127.0.0.1` for localhost-only)        |
| `API_KEY` / `PASSWORD`      | _(file)_            | Password; env wins over `~/.kiro-router/password`        |
| `KIRO_TOKEN_DIR`            | `~/.aws/sso/cache`  | Where to discover Kiro account JSON files                |
| `KIRO_REFRESH_TOKEN`        | _(unset)_           | Single override account (for headless/Docker)            |
| `KIRO_PROFILE_ARN`          | _(unset)_           | Profile ARN for IDC users                                |
| `KIRO_REFRESH_LEAD_SECONDS` | `300`               | Refresh tokens this many seconds before expiry           |
| `KIRO_STRATEGY`             | `round-robin`       | `round-robin` / `least-used` / `priority` (invalid → warn + round-robin) |
| `KIRO_MAX_ATTEMPTS`         | `5`                 | Max accounts tried per client request (`1`..`50`)        |
| `CORS_ORIGIN`               | `*`                 | `Access-Control-Allow-Origin` for browser callers        |
| `LOG_LEVEL`                 | `info`              | `error` / `warn` / `info` / `debug`                      |

## Integration recipes

### OpenCode

```bash
opencode --provider=openai \
  --openai-base-url=http://127.0.0.1:11437/v1 \
  --openai-api-key=kiro \
  --model=claude-sonnet-4.5
```

Or set in `~/.config/opencode/config.json`:

```json
{
  "provider": "openai",
  "openai_base_url": "http://127.0.0.1:11437/v1",
  "openai_api_key": "<your-password>",
  "model": "claude-sonnet-4.5"
}
```

### Kilo Code (VS Code extension)

1. Open Kilo Code → Settings → API Provider → **OpenAI Compatible**
2. **Base URL**: `http://127.0.0.1:11437/v1`
3. **API Key**: `kiro` (or whatever you set `API_KEY=` to)
4. **Model**: `claude-sonnet-4.5`

### Cline

Settings → API Provider → **OpenAI Compatible**
- Base URL: `http://127.0.0.1:11437/v1`
- API Key: anything (or your `API_KEY`)
- Model ID: `claude-sonnet-4.5`

### Roo Code

Same as Cline — OpenAI Compatible, base URL `http://127.0.0.1:11437/v1`,
model `claude-sonnet-4.5`.

### Continue.dev

```yaml
# ~/.continue/config.yaml
models:
  - name: kiro-sonnet
    provider: openai
    model: claude-sonnet-4.5
    apiBase: http://127.0.0.1:11437/v1
    apiKey: kiro
```

### Claude Code (Anthropic Messages API)

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:11437"
export ANTHROPIC_API_KEY="kiro"
claude
```

### `curl` test

```bash
curl -N http://127.0.0.1:11437/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "messages": [{"role":"user","content":"Say hi in one word."}],
    "stream": true
  }'
```

## Architecture (one-pager)

```
                       ┌──────────────────────────────┐
                       │  ~/.aws/sso/cache/*.json     │
                       │  (Kiro IDE writes these)     │
                       └──────────────┬───────────────┘
                                      │ auto-discover + watch
                                      ▼
   client ──► /v1/chat/completions ──►┌─────────────────────────┐
   (OpenCode,                          │  AccountManager         │
    Kilo Code,                         │  ├─ proactive refresher │ ◄── refresh
    Cline, …)                          │  ├─ round-robin picker  │     loop
                                       │  ├─ cooling/terminal SM │
                                       │  └─ atomic manifest IO  │
                                       └────────────┬────────────┘
                                                    │
                                                    ▼
                                       ┌─────────────────────────┐
                                       │  dispatchChat (failover)│
                                       │  on 401: refresh+retry  │
                                       │  on 429: cool, next acc │
                                       │  on 5xx: brief cool     │
                                       └────────────┬────────────┘
                                                    │ POST (keep-alive HTTPS)
                                                    ▼
                                       codewhisperer.us-east-1.amazonaws.com
                                       /generateAssistantResponse
                                                    │
                                                    │ AWS EventStream binary
                                                    ▼
                                       ┌─────────────────────────┐
                                       │  iterateKiroAsOpenAISSE │
                                       │  incremental frame      │
                                       │  parser + CRC32 + SSE   │
                                       │  pass-through           │
                                       └────────────┬────────────┘
                                                    │ data: {...}\n\n
                                                    ▼
                                                  client
```

## Multi-account behaviour

- All `*.json` files in `~/.aws/sso/cache/` whose `refreshToken` starts with
  `aorAAAAAG` are picked up as separate accounts.
- A persistent manifest is kept at `~/.kiro-router/accounts.json` so cool-down
  and counter state survives restarts. Atomic write (tmpfile + rename) means
  Kiro IDE and the router never race.
- Strategy is configurable: `round-robin` (default), `least-used`, `priority`.
- On `429`: account is cooled for `Retry-After` seconds (default 30); the same
  request is immediately retried on the next healthy account.
- On `401/403`: refresh once on the same account; if still failing, mark
  terminal and move to the next.
- On `5xx`: 10-second cool-down, immediate failover.
- Up to 5 accounts are tried per request before giving up.

## Health check / monitoring

```bash
curl -s http://127.0.0.1:11437/health
# {"status":"ok","accounts":{"total":3,"healthy":2,"cooling":1,...}}
```

Wire it into your orchestrator (systemd, Docker, k8s) — `status: "degraded"`
means no accounts are usable.

## Building from source

```bash
npm install
npm run typecheck
npm test
npm run build
node dist/server.js
```

## Security

- The proxy binds to `0.0.0.0` by default. **Set a password** (see [Set a
  password](#set-a-password)) so only people who know it can use your Kiro
  subscription. If you don't want network access at all, set `HOST=127.0.0.1`.
- The password file (`~/.kiro-router/password`) and account manifest
  (`~/.kiro-router/accounts.json`) are stored with mode `0600` and never
  logged. Admin endpoints redact tokens.
- Don't commit your `.env` or `~/.kiro-router/` files.

## Troubleshooting

| Symptom                                                | Likely cause / fix                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `accounts: reloaded total=0`                           | No Kiro tokens found. Log into Kiro IDE first; check `ls ~/.aws/sso/cache/`.                             |
| `No Kiro accounts configured`                          | Same as above.                                                                                           |
| `refresh failed: status=400` (terminal)                | Refresh token is dead (expired/revoked). Re-login in Kiro IDE.                                           |
| `429` returned to client after a few requests          | All accounts are rate-limited. Add another Kiro account or wait for cool-down to expire.                 |
| Tools can't connect to `127.0.0.1:11437`               | Server not running (`./start.sh`), wrong port (`PORT=`), or firewall blocking the LAN address.           |
| `Unauthorized` from KiroKey                            | Password set, but client isn't sending `Authorization: Bearer <password>` matching it.                   |
| Open-proxy banner at startup                           | `HOST=0.0.0.0` (default) AND no password. Run `./start.sh --set-password` to silence it.                 |

## License

MIT. Not affiliated with AWS, Kiro, or Cognition. Use at your own risk and in
accordance with the Kiro Terms of Service.
