# Milestone 0 — Repository audit

Inspected live `chinabwoy750-china/cloudcoder-agent` (`main` at Phase 7A `257b01e`).

## Stack
- Node 22+, Express API, static UI (`src/ui`)
- OpenCode CLI agent engine
- China-GPT / OpenAI-compatible custom provider
- Workspace filesystem under `WORKSPACE_ROOT` (default `/tmp/cloudcoder`)
- Optional Upstash Redis for encrypted site settings (Phase 6)
- Optional PostgreSQL schema (Phase 7A): `app_users`, `workspaces`, `agent_jobs`, `chat_messages`, `audit_events`
- Telegram bot optional
- GitHub import/PR optional
- Render Blueprint (`render.yaml`)

## Working features retained
- Build/Plan modes, agent task streaming, build-repair
- ZIP upload/export, snapshots, static preview
- Site-managed settings UI, model routing settings
- Security controls documented in `docs/security.md`

## Gaps vs production multi-user platform
- Auth was single shared credential (Basic + cookie); no DB users
- Workspaces not ownership-scoped
- Jobs in-memory only
- Project files on ephemeral disk
- No separate execution worker / isolation
- No durable object storage, queue, or media adapters

## Decision
Do not duplicate Phase 7A. Build Milestone 1 on top of existing `src/storage/postgres.js`.
