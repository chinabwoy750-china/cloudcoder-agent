# Milestone 3 — Execution isolation and preview authorization

## Implemented
- Worker runner (`src/worker/runner.js`)
  - Modes: `local-process` (default), `docker` when `DOCKER_ISOLATION=true` + docker CLI, `remote` when `WORKER_URL` is set
  - Memory/CPU/pids limits for docker mode; network off by default (on for install)
  - Child env strips secrets (API keys, tokens, DB URLs)
- Standalone worker service (`src/worker/service.js`)
  - `GET /health`, `POST /v1/exec` with `WORKER_SHARED_SECRET`
  - Start with `WORKER_ROLE=1 node src/worker/service.js` or `npm run worker`
- Project actions (`runProjectAction`) execute through isolation layer
- Preview tokens (`src/auth/preview-token.js`)
  - `POST /api/workspaces/:id/preview-token` issues HMAC token (30m)
  - Preview route accepts session **or** `?preview_token=` / `X-Preview-Token`
- Health reports `isolation` mode

## Render
Add a second service (optional) from the same image:
- Start command: `node src/worker/service.js`
- Env: `WORKER_SHARED_SECRET`, `WORKSPACE_ROOT` (shared disk if used), same Docker image
- Web service env: `WORKER_URL=https://<worker-service>`, `WORKER_SHARED_SECRET=<same>`

On free Render without Docker socket, isolation stays `local-process` with timeouts and secret stripping. Docker isolation requires a host that exposes docker to the container (not available on Render free).

## Env
```
DOCKER_ISOLATION=false
WORKER_DOCKER_IMAGE=node:22-bookworm-slim
WORKER_MEMORY=512m
WORKER_CPUS=1
WORKER_PIDS=256
WORKER_URL=
WORKER_SHARED_SECRET=
WORKER_PORT=10001
```

## Not complete yet
- True multi-tenant sandbox per concurrent project on managed cloud without Docker socket
- Automatic cleanup cron for orphaned preview tokens (tokens are stateless HMAC)
- Full queue-backed worker pool (foundation is HTTP remote exec)
