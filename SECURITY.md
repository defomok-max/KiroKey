# Security

KiroKey proxies requests to your Kiro subscription. Treat access to the proxy as
access to that subscription.

## Supported versions

Security fixes are expected on the default development branch until formal
release branches exist.

## Reporting a vulnerability

Please do not open public issues containing secrets, tokens, or exploit details.
Open a private report through GitHub's security advisory flow if enabled, or
contact the repository owner directly.

## Deployment hardening

- Always set a strong `API_KEY` when binding to `0.0.0.0`.
- Restrict port `11437/tcp` to trusted IPs with a firewall or reverse proxy.
- Never commit `.env`, `~/.kiro-router/password`, `~/.kiro-router/accounts.json`,
  or files from `~/.aws/sso/cache`.
- Prefer Docker Compose or the included systemd unit for server deployments.
- Rotate Kiro refresh tokens by re-logging into Kiro if a token may have leaked.
