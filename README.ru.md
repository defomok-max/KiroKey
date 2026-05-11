# kiro-router

**Быстрый, специализированный прокси с поддержкой нескольких аккаунтов,
который превращает твою подписку Kiro IDE в OpenAI / Anthropic-совместимый
API.** Подключай в OpenCode, Kilo Code, Cline, Continue.dev, Roo Code — в
любой инструмент, который умеет говорить по `/v1/chat/completions` или
`/v1/messages`.

> EN — [README.md](README.md)

Вдохновлён [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute),
но в отличие от него — laser-focused на Kiro и поэтому быстрее + стабильнее:

- **ноль runtime-зависимостей** (только Node ≥ 20),
- **keep-alive HTTPS pooling** к AWS CodeWhisperer — нет TLS handshake на
  каждый запрос,
- **проактивный refresh токенов** в фоне за ~5 минут до экспирации — первый
  запрос после простоя никогда не блокируется на refresh,
- **несколько аккаунтов Kiro** одновременно с авто-обнаружением,
  round-robin / least-used / priority маршрутизацией и **автоматическим
  failover** на 401 / 429 / 5xx.

## Что есть

- `POST /v1/chat/completions` — OpenAI-совместимый streaming chat (SSE) и
  non-streaming JSON
- `POST /v1/messages` — Anthropic-совместимый Messages API (SSE + не-stream)
- `GET  /v1/models` — список моделей Claude, доступных через Kiro
- `GET  /health` — liveness + сводка состояния аккаунтов
- `GET  /admin/accounts` — полный статус каждого аккаунта (токены замаскированы)
- `POST /admin/refresh` — форсированный refresh всех аккаунтов
- `POST /admin/reload` — пересканировать `~/.aws/sso/cache` и подцепить новые аккаунты
- `POST /admin/accounts/:id/reset` — сбросить cool-down / счётчики ошибок

Поддерживаемые модели (проксируются в AWS CodeWhisperer):

| Model id              | Заметки                                |
| --------------------- | -------------------------------------- |
| `claude-sonnet-4.5`   | Дефолт, быстрая + способная            |
| `claude-sonnet-4.6`   | Более свежая Sonnet                    |
| `claude-haiku-4.5`    | Самая быстрая / дешёвая                |
| `claude-opus-4.6`     | Максимальное качество                  |
| `claude-opus-4.7`     | Последняя Opus                         |

## Установка

```bash
git clone <этот репо> kiro-router
cd kiro-router
npm install
```

Нужен Node ≥ 20.

## Откуда взять токены Kiro

Нужно один раз залогиниться в Kiro IDE, чтобы он сохранил токены в
`~/.aws/sso/cache/`. Роутер подхватит **все** аккаунты, в которые ты
залогинился, и будет ротировать запросы между ними.

- **AWS Builder ID** (бесплатно, рекомендую) — поставь
  [Kiro IDE](https://kiro.dev), открой, нажми «Sign in with AWS Builder ID».
- **Google / GitHub** (Cognito social login) — тоже поддерживается.
- **AWS Identity Center (IDC)** — для корпоратов, тоже работает (при
  необходимости задай `KIRO_PROFILE_ARN`).

После логина у тебя появятся файлы вроде
`~/.aws/sso/cache/kiro-auth-token.json` с `refreshToken`, начинающимся с
`aorAAAAAG`. Роутер автоматически их найдёт.

### Headless / Docker / удалённая машина

Если на сервере нельзя запустить Kiro IDE, скопируй `refreshToken` из
`~/.aws/sso/cache/kiro-auth-token.json` на своём ноуте и задай:

```bash
export KIRO_REFRESH_TOKEN="aorAAAAAG..."
```

Роутер использует этот единственный аккаунт.

## Запуск

```bash
# foreground
npm start

# dev с автоперезагрузкой
npm run dev

# production build
npm run build && node dist/server.js
```

Слушает на `http://127.0.0.1:11437` по умолчанию.

```bash
curl http://127.0.0.1:11437/health
curl http://127.0.0.1:11437/admin/accounts | jq
```

## Конфигурация

Все настройки — через переменные окружения. Скопируй `.env.example` и
`source .env`, или экспортируй вручную.

| Переменная                  | Default                       | Описание                                                       |
| --------------------------- | ----------------------------- | -------------------------------------------------------------- |
| `PORT`                      | `11437`                       | HTTP-порт                                                      |
| `HOST`                      | `127.0.0.1`                   | Bind-адрес                                                     |
| `API_KEY`                   | _(не задан)_                  | Если задан — клиенты должны слать `Authorization: Bearer <key>` |
| `KIRO_TOKEN_DIR`            | `~/.aws/sso/cache`            | Где искать JSON-файлы аккаунтов                                |
| `KIRO_REFRESH_TOKEN`        | _(не задан)_                  | Один override-аккаунт (для headless/Docker)                    |
| `KIRO_PROFILE_ARN`          | _(не задан)_                  | Profile ARN (для IDC юзеров)                                   |
| `KIRO_REFRESH_LEAD_SECONDS` | `300`                         | За сколько секунд до экспирации рефрешить токены               |
| `KIRO_STRATEGY`             | `round-robin`                 | `round-robin` / `least-used` / `priority`                      |
| `LOG_LEVEL`                 | `info`                        | `error` / `warn` / `info` / `debug`                            |

## Подключение

### OpenCode

```bash
opencode --provider=openai \
  --openai-base-url=http://127.0.0.1:11437/v1 \
  --openai-api-key=$API_KEY \   # любое значение, если API_KEY не задан
  --model=claude-sonnet-4.5
```

Или в `~/.config/opencode/config.json`:

```json
{
  "provider": "openai",
  "openai_base_url": "http://127.0.0.1:11437/v1",
  "openai_api_key": "kiro",
  "model": "claude-sonnet-4.5"
}
```

### Kilo Code (VS Code расширение)

1. Открой Kilo Code → Settings → API Provider → **OpenAI Compatible**
2. **Base URL**: `http://127.0.0.1:11437/v1`
3. **API Key**: `kiro` (или то, что ты поставил в `API_KEY=`)
4. **Model**: `claude-sonnet-4.5`

### Cline

Settings → API Provider → **OpenAI Compatible**
- Base URL: `http://127.0.0.1:11437/v1`
- API Key: любой (или твой `API_KEY`)
- Model ID: `claude-sonnet-4.5`

### Roo Code

То же, что и Cline — OpenAI Compatible, base URL `http://127.0.0.1:11437/v1`,
модель `claude-sonnet-4.5`.

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

### Проверка через `curl`

```bash
curl -N http://127.0.0.1:11437/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "messages": [{"role":"user","content":"Скажи привет одним словом."}],
    "stream": true
  }'
```

## Как работает multi-account

- Все `*.json` в `~/.aws/sso/cache/`, где `refreshToken` начинается с
  `aorAAAAAG`, подхватываются как отдельные аккаунты.
- Манифест аккаунтов хранится в `~/.kiro-router/accounts.json` —
  cool-down и счётчики переживают рестарт. Atomic write (tmpfile + rename),
  поэтому Kiro IDE и роутер не конкурируют за файл.
- Стратегия: `round-robin` (дефолт), `least-used`, `priority`.
- На `429`: аккаунт уходит в cool-down на `Retry-After` секунд (по умолчанию
  30); тот же запрос тут же ретраится на следующем здоровом.
- На `401/403`: одна попытка refresh на том же аккаунте; если не помогло —
  terminal state, переход на следующий.
- На `5xx`: 10-секундный cool-down, мгновенный failover.
- Максимум 5 аккаунтов пробуется на один запрос.

## Health-check / мониторинг

```bash
curl -s http://127.0.0.1:11437/health
# {"status":"ok","accounts":{"total":3,"healthy":2,"cooling":1,...}}
```

Подключай к systemd / Docker / k8s — `status: "degraded"` означает, что нет
ни одного рабочего аккаунта.

## Сборка из исходников

```bash
npm install
npm run typecheck
npm test
npm run build
node dist/server.js
```

## Безопасность

- Прокси биндится на `127.0.0.1` по умолчанию — только локальные процессы
  могут до неё достучаться. Если поставишь `HOST=0.0.0.0`, обязательно задай
  `API_KEY`, чтобы прокси не была открыта на всю LAN.
- Токены хранятся в `~/.kiro-router/accounts.json` с правами `0600` и
  никогда не пишутся в логи (admin-endpoints их маскируют).
- Не коммить `.env` и `accounts.json` в git.

## Лицензия

MIT. Не аффилирован с AWS, Kiro или Cognition. Используй на свой страх и
риск и в соответствии с Kiro Terms of Service.
