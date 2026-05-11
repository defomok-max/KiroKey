# kiro-router

**A fast, focused, multi-account proxy that exposes your Kiro IDE subscription
as an OpenAI / Anthropic-compatible API.** Drop it in front of OpenCode,
Kilo Code, Cline, Continue.dev, Roo Code, or any tool that speaks
`/v1/chat/completions` or `/v1/messages`.

> 🇷🇺 Русская версия — [README.ru.md](README.ru.md)

Inspired by [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute),
which is a much larger general-purpose router. This project is laser-focused
on Kiro only and is faster + more stable for that use case because it:

- has **zero runtime dependencies** (just Node ≥ 20),
- uses **keep-alive HTTPS pooling** to AWS CodeWhisperer (no TLS handshake per
  request),
- **proactively refreshes tokens** in the background ~5 minutes before they
  expire — your first request after idle never blocks on a refresh,
- supports **multiple Kiro accounts** with auto-discovery, round-robin /
  least-used / priority routing, and **automatic failover** on 401 / 429 / 5xx.

## What you get

- `POST /v1/chat/completions` — OpenAI-compatible streaming chat (SSE) and
  non-streaming JSON
- `POST /v1/messages` — Anthropic-compatible Messages API (SSE + non-streaming)
- `GET  /v1/models` — list of Claude models exposed via Kiro
- `GET  /health` — liveness + per-state account summary
- `GET  /admin/accounts` — full per-account status (tokens redacted)
- `POST /admin/refresh` — kick a proactive refresh sweep
- `POST /admin/reload` — rescan `~/.aws/sso/cache` and merge new accounts
- `POST /admin/accounts/:id/reset` — clear cool-downs / failure state

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
git clone <this repo> kiro-router
cd kiro-router
npm install
```

Requires Node ≥ 20.

## Getting Kiro tokens

You need to log into Kiro IDE at least once so it writes its tokens to
`~/.aws/sso/cache/`. The router will pick up **every account** you've logged
into and rotate between them.

- **AWS Builder ID** (free, recommended) — install
  [Kiro IDE](https://kiro.dev), open it, click "Sign in with AWS Builder ID".
- **Google / GitHub** (Cognito social login) — also supported.
- **AWS Identity Center (IDC)** — enterprise, works too (set `KIRO_PROFILE_ARN`
  if needed).

After signing in, you should see files like
`~/.aws/sso/cache/kiro-auth-token.json` containing a `refreshToken` starting
with `aorAAAAAG`. The router auto-discovers all such files.

### Headless / Docker / remote box

If you can't run Kiro IDE on the same machine, copy the `refreshToken` from
`~/.aws/sso/cache/kiro-auth-token.json` on your laptop and set:

```bash
export KIRO_REFRESH_TOKEN="aorAAAAAG..."
```

The router will use that single account.

## Run

```bash
# foreground
npm start

# background dev with reload
npm run dev

# production build
npm run build && node dist/server.js
```

The server listens on `http://127.0.0.1:11437` by default.

```bash
curl http://127.0.0.1:11437/health
curl http://127.0.0.1:11437/admin/accounts | jq
```

## Configuration

All knobs are environment variables. Copy `.env.example` and `source .env`,
or export them directly.

| Variable                    | Default                       | Description                                              |
| --------------------------- | ----------------------------- | -------------------------------------------------------- |
| `PORT`                      | `11437`                       | HTTP port                                                |
| `HOST`                      | `127.0.0.1`                   | Bind address                                             |
| `API_KEY`                   | _(unset)_                     | If set, clients must send `Authorization: Bearer <key>`  |
| `KIRO_TOKEN_DIR`            | `~/.aws/sso/cache`            | Where to discover Kiro account JSON files                |
| `KIRO_REFRESH_TOKEN`        | _(unset)_                     | Single override account (for headless/Docker)            |
| `KIRO_PROFILE_ARN`          | _(unset)_                     | Profile ARN for IDC users                                |
| `KIRO_REFRESH_LEAD_SECONDS` | `300`                         | Refresh tokens this many seconds before expiry           |
| `KIRO_STRATEGY`             | `round-robin`                 | `round-robin` / `least-used` / `priority`                |
| `LOG_LEVEL`                 | `info`                        | `error` / `warn` / `info` / `debug`                      |

## Integration recipes

### OpenCode

```bash
opencode --provider=openai \
  --openai-base-url=http://127.0.0.1:11437/v1 \
  --openai-api-key=$API_KEY \   # use any value if API_KEY is unset
  --model=claude-sonnet-4.5
```

Or set in `~/.config/opencode/config.json`:

```json
{
  "provider": "openai",
  "openai_base_url": "http://127.0.0.1:11437/v1",
  "openai_api_key": "kiro",
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

Wire it into your orchestrator (systemd, Docker, k8s) — non-zero exit on
unhealthy + `status: "degraded"` body when no accounts are usable.

## Building from source

```bash
npm install
npm run typecheck
npm test
npm run build
node dist/server.js
```

## Security

- The proxy binds to `127.0.0.1` by default — only local processes can reach
  it. If you set `HOST=0.0.0.0`, also set `API_KEY` so the proxy isn't open
  to your LAN.
- Tokens are stored under `~/.kiro-router/accounts.json` with mode `0600` and
  never logged (admin endpoints redact them).
- Don't commit your `.env` or `accounts.json`.

## License

MIT. Not affiliated with AWS, Kiro, or Cognition. Use at your own risk and in
accordance with the Kiro Terms of Service.
