# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report privately through GitHub: go to the **Security** tab → **Report a vulnerability**. That opens
a private advisory visible only to you and the maintainers.

Include the affected file or endpoint, what an attacker can achieve, and the steps to reproduce it.
You can expect an initial response within seven days.

## Scope

This is a project template. It is intended to be forked and deployed by others, so a weak default,
a missing guard, or a documentation example that is insecure if copied verbatim all count as valid
findings.

Particularly in scope:

- Authentication and session handling (`src/application/auth/**`, `src/infrastructure/security/**`)
- Authorization bypass — anything reaching a use case without the required permission
- Injection, SSRF, or unsafe deserialization in the HTTP or job paths
- Secrets, tokens, or personal data reaching logs, traces, or error responses

Out of scope:

- The development-only credentials in `.env.example` and `docker-compose.yml`. They exist to make a
  first run work and are documented as values to replace before any deployment.
- Findings that require an attacker to already control the server or the database.
- Vulnerabilities in dependencies that are already covered by an open Dependabot pull request.

## For anyone deploying this template

Boot-time checks refuse to start in production with weak secrets
(`src/config/assert-production-secrets.ts`), but they cannot judge whether a value is genuinely
secret. Before deploying:

- Replace every credential in `.env` — generate them with `openssl rand -base64 48`
- Set `NODE_ENV=production` so the secret-strength checks run
- Keep `COOKIE_SECURE=true` and terminate TLS in front of the app
- Leave `BULL_BOARD_ENABLED=false` unless the dashboard is behind a private network
