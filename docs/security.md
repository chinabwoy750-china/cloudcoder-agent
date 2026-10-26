# Security model

## Threat model

CloudCoder executes AI-generated commands and edits user repositories. It is treated as
high-risk software.

## Controls

| Area | Control |
|---|---|
| Transport | HTTPS terminated by Render; HSTS in production |
| Public auth | HTTP Basic **or** HMAC-signed session cookie |
| Session cookie | `HttpOnly`, `SameSite=Strict`, `Secure` in production, 7-day TTL |
| CSRF | Cookie-authenticated mutations require `X-CloudCoder-CSRF: 1` |
| CORS | Cross-origin requests rejected outright |
| Headers | CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy` |
| Rate limiting | Global 600/min; login 20/15min; clone 10/min; agent tasks 20/min |
| Body size | JSON 2 MB; uploads 50 MB; 20 files per request |
| Workspace isolation | Every path resolved and verified to stay under `WORKSPACE_ROOT` |
| Path traversal | `resolveInside()` throws on any escape attempt |
| Zip Slip | Entry paths resolved and verified; absolute paths, symlinks and traversal rejected |
| Zip bombs | Entry count and total uncompressed size capped |
| Command execution | Server-side whitelist keyed by detected project type; user input never reaches a shell |
| Git hooks | `core.hooksPath=/dev/null`; commits and pushes use `--no-verify` |
| Default branch | Push refused unless `GITHUB_ALLOW_DEFAULT_BRANCH=true` |
| Deletion | Files and workspaces require explicit `confirm=true` |
| Secret files | `.env`, keys, `.git`, `node_modules`, `.ssh`, `.aws` excluded from listing/download |
| Log redaction | Keys, tokens, bot tokens, URL credentials and auth headers scrubbed |
| Audit logs | Every auth failure, job, clone, push and destructive action is logged (never with secrets) |
| Shutdown | SIGTERM/SIGINT stop Telegram, OpenCode and HTTP gracefully |

## Known residual risks

- The agent runs with the container user's privileges. Render's container boundary is the ultimate limit.
- A single credential set is used; there is no per-user authorization beyond the Telegram ID allowlist.
- Rate limiting is in-memory and resets on restart — acceptable for a single-instance free tier.
