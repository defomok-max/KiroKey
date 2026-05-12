# KiroKey (kiro-router)

**Быстрый, специализированный прокси с поддержкой нескольких аккаунтов,
который превращает твою подписку Kiro IDE в OpenAI / Anthropic-совместимый
API.** Подключай в OpenCode, Kilo Code, Cline, Continue.dev, Roo Code,
Claude Code — в любой инструмент, который умеет говорить по
`/v1/chat/completions` или `/v1/messages`.

> EN — [README.md](README.md)

---

## TL;DR — 3 шага

1. **Залогинься в Kiro IDE один раз** (https://kiro.dev), чтобы он сохранил
   `~/.aws/sso/cache/kiro-auth-token.json`. Можешь логиниться в несколько
   аккаунтов Kiro — KiroKey подхватит их все и будет ротировать запросы
   между ними.
   Или используй `./start.sh --add-account --google` / `--github` /
   `--builder-id`: откроется браузер, ты авторизуешься, аккаунт привяжется.

2. **Склонируй + запусти** (нужен Node ≥ 20):

   ```bash
   git clone https://github.com/defomok-max/KiroKey.git
   cd KiroKey
   ./start.sh            # Linux / macOS  (или: start.cmd на Windows, или: make start)
   ```

   В логах увидишь:

   ```
   kiro-router: starting port=11437 ...
   accounts: reloaded total=1 ids=[aws-sso:kiro-auth-token]
   kiro-router: listening url=http://127.0.0.1:11437
   ```

3. **Укажи в любом OpenAI-совместимом инструменте:**

   - **Base URL**: `http://<host>:11437/v1` — `127.0.0.1` если на той же
     машине, или LAN/VPN IP машины с KiroKey.
   - **API Key / Password**: см. раздел [Установить пароль](#установить-пароль) ниже.
   - **Model**: `claude-sonnet-4.5` (или `claude-opus-4.7`, `claude-haiku-4.5`, …)

Всё. Проверка:

```bash
curl http://127.0.0.1:11437/health
curl http://127.0.0.1:11437/v1/models
```

## Установить пароль

По умолчанию `HOST=0.0.0.0` — прокси доступен из LAN/VPN. **Обязательно
поставь пароль**, чтобы твоей Kiro-подпиской пользовался только ты (или
кому ты дал пароль).

Самый простой способ — постоянный пароль, сервер сам его подхватывает
при каждом запуске:

```bash
./start.sh --set-password            # запросит пароль (ввод скрыт)
./start.sh --set-password mySecret   # одной строкой
./start.sh --set-password --random   # сгенерирует сильный случайный
./start.sh --show-password           # показать текущий
./start.sh --clear-password          # снять пароль
```

Эквивалент через npm: `npm run set-password`, `npm run show-password`,
`npm run clear-password`. Файл — `~/.kiro-router/password` (mode `0600`).

Либо можно через env-переменную `API_KEY` (alias `PASSWORD`) — она
побеждает над файлом, удобно для CI/Docker:

```bash
API_KEY=mySecret ./start.sh
```

Клиенты всегда шлют его как **`Authorization: Bearer <password>`**.

Если пароль НЕ задан и `HOST=0.0.0.0` (дефолт) — при старте сервер
пишет громкий warning об открытом прокси.

---

## Почему это существует

Вдохновлён [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute),
который покрывает 160+ провайдеров. KiroKey же laser-focused на Kiro и
быстрее + стабильнее для этого одного use case потому что:

- **ноль runtime-зависимостей** (только Node ≥ 20, ~280 KB после компиляции),
- **keep-alive HTTPS pooling** к AWS CodeWhisperer — нет TLS handshake на
  каждый запрос,
- **проактивный refresh токенов** в фоне за ~5 минут до экспирации — первый
  запрос после простоя никогда не блокируется на refresh,
- **несколько аккаунтов Kiro** одновременно с авто-обнаружением,
  round-robin / least-used / priority маршрутизацией и **автоматическим
  failover** на 401 / 429 / 5xx.

## Endpoints

| Method | Path                              | Описание                                                  |
| ------ | --------------------------------- | --------------------------------------------------------- |
| POST   | `/v1/chat/completions`            | OpenAI Chat Completions (streaming SSE + non-streaming)   |
| POST   | `/v1/messages`                    | Anthropic Messages API (streaming SSE + non-streaming)    |
| GET    | `/v1/models`                      | Список моделей Claude через Kiro                          |
| GET    | `/health`                         | Liveness + сводка по состоянию аккаунтов                  |
| GET    | `/admin/accounts`                 | Полный статус по каждому аккаунту (токены замаскированы)  |
| POST   | `/admin/accounts/link`            | Открыть login flow и привязать новый аккаунт              |
| POST   | `/admin/refresh`                  | Форсированный refresh                                     |
| POST   | `/admin/reload`                   | Пересканировать `~/.aws/sso/cache`                        |
| POST   | `/admin/accounts/:id/reset`       | Сбросить cool-down / счётчики ошибок                      |

Поддерживаемые модели:

| Model id              | Заметки                                |
| --------------------- | -------------------------------------- |
| `claude-sonnet-4.5`   | Дефолт, быстрая и способная            |
| `claude-sonnet-4.6`   | Более свежая Sonnet                    |
| `claude-haiku-4.5`    | Самая быстрая / дешёвая                |
| `claude-opus-4.6`     | Максимальное качество                  |
| `claude-opus-4.7`     | Последняя Opus                         |

## Установка

```bash
git clone https://github.com/defomok-max/KiroKey.git
cd KiroKey
npm install
```

Нужен Node ≥ 20. В CI или чистой автоматизации используй `npm ci`, когда есть
`package-lock.json`. После установки зависимостей:

| Команда             | Что делает                                          |
| ------------------- | --------------------------------------------------- |
| `./start.sh`        | Ставит зависимости (если нужно) + запускает (Linux/Mac) |
| `start.cmd`         | То же самое на Windows                              |
| `make start`        | То же через Make                                    |
| `npm run check` / `make check` | Typecheck, тесты, build, lint placeholder, package dry-run |
| `./start.sh --add-account --google` | Открыть браузер и привязать ещё один аккаунт |
| `npm run add-account -- --google` | То же через npm                               |
| `npm start`         | Просто запуск (зависимости уже стоят)               |
| `npm run dev`       | Запуск с автоперезагрузкой при изменении кода       |
| `npm run build`     | Скомпилировать TypeScript → `dist/`                 |
| `npm test`          | Прогнать unit-тесты                                 |
| `npm run typecheck` | TypeScript проверка без emit                        |

## Откуда взять токены Kiro

Можно один раз залогиниться в Kiro IDE, чтобы он сохранил токены в
`~/.aws/sso/cache/`, или привязать аккаунты напрямую из KiroKey. KiroKey
подхватит **все** аккаунты в этом cache и будет ротировать запросы между ними.

- **AWS Builder ID** (бесплатно, рекомендую) — поставь
  [Kiro IDE](https://kiro.dev), открой, нажми «Sign in with AWS Builder ID».
- **Google / GitHub** (Cognito social login) — тоже поддерживается.
- **AWS Identity Center (IDC)** — для корпоратов, тоже работает (при
  необходимости задай `KIRO_PROFILE_ARN`).

После логина у тебя появятся файлы вроде
`~/.aws/sso/cache/kiro-auth-token.json` с `refreshToken`, начинающимся с
`aorAAAAAG`. Роутер автоматически их найдёт.

### Привязать аккаунт через браузер

Запускай одну команду на один аккаунт. KiroKey откроет браузер, ты
авторизуешься, а refresh token сохранится отдельным JSON-файлом аккаунта:

```bash
npm run add-account -- --google
npm run add-account -- --github
npm run add-account -- --builder-id
npm run add-account -- --idc --start-url https://example.awsapps.com/start --region us-east-1
```

Полезные флаги: `--label name` для имени аккаунта, `--no-browser` на удалённом
сервере (выведет URL/code вместо открытия браузера), `--cache-dir PATH` для
кастомного `KIRO_TOKEN_DIR`. `./start.sh --add-account --google` запускает тот
же flow, но сначала сам поставит зависимости. Если сервер уже запущен,
перезагрузи аккаунты:

```bash
curl -X POST -H "Authorization: Bearer <password>" http://127.0.0.1:11437/admin/reload
```

То же есть через admin API:

```bash
curl -X POST http://127.0.0.1:11437/admin/accounts/link \
  -H "Authorization: Bearer <password>" \
  -H "Content-Type: application/json" \
  -d '{"method":"google","label":"work"}'
```

### Добавить ещё один аккаунт вручную

Просто залогинься в Kiro IDE с другим аккаунтом (или скопируй второй JSON
в `~/.aws/sso/cache/`). KiroKey подхватит его **без рестарта** благодаря
filesystem watching. Проверка:

```bash
curl http://127.0.0.1:11437/admin/accounts | jq
```

### Сервер / Docker / удалённая машина

Если на сервере нельзя запустить Kiro IDE, скопируй `refreshToken` из
`~/.aws/sso/cache/kiro-auth-token.json` на своём ноуте и задай:

```bash
export KIRO_REFRESH_TOKEN="aorAAAAAG..."
./start.sh
```

Роутер использует этот единственный аккаунт.

Для нормального запуска на сервере используй готовый Docker Compose или
systemd setup:

```bash
cp deploy/kiro-router.env.example .env
$EDITOR .env
docker compose up -d --build
```

В примере `API_KEY` специально пустой: задай его перед стартом, иначе Docker
Compose остановится с ошибкой.

Или как Linux systemd service:

```bash
sudo sh deploy/install-systemd.sh
sudoedit /etc/kiro-router.env
sudo systemctl start kiro-router
```

Полная инструкция для VPS/сервера: [docs/server.md](docs/server.md).

## Запуск как сервиса (опционально)

Для реального VPS/сервера лучше использовать [docs/server.md](docs/server.md):
там есть Docker Compose и hardened systemd service. Пример ниже — быстрый
per-user local service.

**systemd user service (Linux):**

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

**pm2 (любая ОС):**

```bash
npm install -g pm2
pm2 start "npm start" --name kiro-router
pm2 save
pm2 startup   # выполни выведенную команду
```

**Windows** — проще всего запускать `start.cmd` в окне терминала, или
поставить `pm2-windows-service` для нормального сервиса.

## Конфигурация

Все настройки — через переменные окружения. Скопируй `.env.example` и
`source .env`, или экспортируй вручную.

| Переменная                  | Default             | Описание                                                       |
| --------------------------- | ------------------- | -------------------------------------------------------------- |
| `PORT`                      | `11437`             | HTTP-порт                                                      |
| `HOST`                      | `0.0.0.0`           | Bind-адрес (поставь `127.0.0.1` для localhost-only)            |
| `API_KEY` / `PASSWORD`      | _(из файла)_        | Пароль; env побеждает над `~/.kiro-router/password`            |
| `KIRO_TOKEN_DIR`            | `~/.aws/sso/cache`  | Где искать JSON-файлы аккаунтов                                |
| `KIRO_REFRESH_TOKEN`        | _(не задан)_        | Один override-аккаунт (для headless/Docker)                    |
| `KIRO_PROFILE_ARN`          | _(не задан)_        | Profile ARN (для IDC юзеров)                                   |
| `KIRO_REFRESH_LEAD_SECONDS` | `300`               | За сколько секунд до экспирации рефрешить токены               |
| `KIRO_STRATEGY`             | `round-robin`       | `round-robin` / `least-used` / `priority`                      |
| `KIRO_SERVER_MODE`          | `false`             | Требует `API_KEY` и включает server-safe token dir defaults     |
| `LOG_LEVEL`                 | `info`              | `error` / `warn` / `info` / `debug`                            |

## Подключение

### OpenCode

```bash
opencode --provider=openai \
  --openai-base-url=http://127.0.0.1:11437/v1 \
  --openai-api-key=kiro \
  --model=claude-sonnet-4.5
```

Или в `~/.config/opencode/config.json`:

```json
{
  "provider": "openai",
  "openai_base_url": "http://127.0.0.1:11437/v1",
  "openai_api_key": "<твой пароль>",
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
- API Key: любой
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

`status: "degraded"` означает, что нет ни одного рабочего аккаунта.

## Сборка из исходников

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run lint
npm pack --dry-run
node dist/server.js
```

## Безопасность

- Прокси биндится на `0.0.0.0` по умолчанию. **Обязательно задай пароль**
  (см. [Установить пароль](#установить-пароль)), чтобы Kiro-подпиской
  пользовался только ты. Если сетевой доступ вообще не нужен — поставь
  `HOST=127.0.0.1`.
- Файл пароля (`~/.kiro-router/password`) и манифест аккаунтов
  (`~/.kiro-router/accounts.json`) хранятся с правами `0600` и никогда не
  пишутся в логи. Admin-endpoints маскируют токены.
- Не коммить `.env` и содержимое `~/.kiro-router/` в git.
- См. [SECURITY.md](SECURITY.md) для vulnerability reporting и server hardening.

## Troubleshooting

| Симптом                                                | Скорее всего / как починить                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `accounts: reloaded total=0`                           | Нет токенов Kiro. Залогинься в Kiro IDE; проверь `ls ~/.aws/sso/cache/`.                                 |
| `No Kiro accounts configured`                          | То же.                                                                                                   |
| `refresh failed: status=400` (terminal)                | Refresh-токен мёртв. Перелогинься в Kiro IDE.                                                            |
| `429` после нескольких запросов                        | Все аккаунты упёрлись в rate limit. Добавь ещё один Kiro-аккаунт или подожди пока cool-down пройдёт.     |
| Инструменты не подключаются к `127.0.0.1:11437`        | Сервер не запущен (`./start.sh`), другой порт (`PORT=`) или фаервол блокирует LAN-адрес.                 |
| `Unauthorized` от KiroKey                              | Пароль задан, а клиент не шлёт `Authorization: Bearer <password>` с тем же значением.                    |
| Open-proxy banner при старте                           | `HOST=0.0.0.0` (дефолт) И пароль не задан. Запусти `./start.sh --set-password` чтобы убрать.             |

## Лицензия

MIT. Не аффилирован с AWS, Kiro или Cognition. Используй на свой страх и
риск и в соответствии с Kiro Terms of Service.
