# Milestone 8 — Deployment adapters & production readiness

## Implemented
- Deploy target registry (admin): Render / Netlify / Vercel providers listed
- Render deploy trigger via API (`authorizeDeploy=true` required)
- Netlify/Vercel adapters registered but return 501 until build-hook/API details supplied
- Secrets never returned to browser; audit events on save/deploy
- `/ready` readiness checks (opencode + db + objects)
- `/api/metrics` admin-only process metrics
- `render.yaml` documents `DATABASE_URL`, object storage path, registration off by default

## Required services (production target)
| Service | Role |
|---------|------|
| Web (`universal-modder`) | API + UI + OpenCode orchestration |
| Worker (optional) | Isolated `npm run worker` exec |
| PostgreSQL | Multi-user, jobs, audit, settings |
| Persistent disk / object storage | Workspaces & archives |
| Redis/Upstash (optional) | Site-managed settings already supported |

## Critical env
```
CLOUDCODER_USERNAME / CLOUDCODER_PASSWORD   # bootstrap admin
SESSION_SECRET
CUSTOM_AI_API_KEY / CUSTOM_AI_BASE_URL
DATABASE_URL                                # multi-user
OBJECT_STORAGE_PATH                         # durable files when disk available
ALLOW_PUBLIC_REGISTRATION=false
```

## Security checklist (pre-prod)
- [ ] Registration disabled until ownership verified in all routes
- [ ] Strong admin password (≥12)
- [ ] SESSION_SECRET rotated & unique
- [ ] GITHUB_TOKEN least privilege
- [ ] No secrets in client logs
- [ ] `/health` and `/ready` green
- [ ] Backup DATABASE_URL before schema changes

## Known limitations
- Free Render disk is ephemeral — use paid disk or external object storage for durability
- Docker isolation unavailable on Render free (no socket)
- Netlify/Vercel deploy triggers need provider-specific hooks
- Full load/concurrency testing not automated in CI here
