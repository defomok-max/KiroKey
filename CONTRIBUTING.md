# Contributing

Thanks for improving KiroKey.

## Local setup

```bash
npm ci
npm run check
```

`npm run check` runs typecheck, tests, build, the dependency-light lint
placeholder, and package dry-run validation.

## Development

- Keep runtime dependencies at zero unless a dependency is clearly worth it.
- Prefer small, focused changes with tests for protocol, routing, or parsing
  behavior.
- Do not commit real Kiro tokens, `.env` files, password files, or AWS SSO cache
  files.
- Keep English and Russian README instructions in sync when changing user-facing
  setup steps.

## Server changes

If you change deployment files, run:

```bash
npm run check
docker build .
```

Also verify `deploy/kiro-router.env.example`, `docker-compose.yml`, and
`docs/server.md` stay consistent.
