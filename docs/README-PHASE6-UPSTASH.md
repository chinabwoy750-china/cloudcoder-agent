# Universal Modder Phase 6 — Upstash settings persistence

This patch changes site-managed settings from an ephemeral local JSON file to Upstash Redis when configured. It is designed to overlay the current Universal Modder source tree without replacing the UI or other features.

## Files included
- `src/storage/upstash.js` — small Upstash Redis REST adapter, no extra package dependency.
- `src/config/runtime-settings.js` — stores/retrieves encrypted runtime settings in Redis, migrates an existing runtime file once if Redis is empty, and fails safely when configured Redis is unavailable.
- `src/server/routes/settings.js` — reports the selected persistence backend.
- `.env.example` — documents required Upstash variables.
- `docs/upstash-persistence.md` — setup and safety notes.
- `tests/upstash.test.js` — tests the REST adapter.

## Setup after merging
1. In Upstash, create a Redis database and copy its HTTPS **REST URL** and **REST token**.
2. In Render → `uni-coder` service → Environment, add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Optionally set `UPSTASH_REDIS_PREFIX=universal-modder`.
3. Keep `SESSION_SECRET` unchanged and private. It is used both for sessions and to derive the encryption key for saved API credentials.
4. Redeploy. Open the app settings API (`/api/settings`) while signed in and verify `persistence` is `upstash-redis`.
5. Save settings, redeploy again, and confirm the settings remain.

## Scope limitation
This phase persists the provider configuration/API key, GitHub token, account username/password hash, and other runtime settings. It does **not** persist generated project directories or preview/build artifacts yet. The next phase should move project files to durable storage and isolate project execution. Cron pings are separate and do not provide storage.

## Verification
The three targeted Upstash adapter tests and syntax checks pass. The complete existing test suite could not be fully verified in this environment because dependency installation timed out, leaving packages such as `express` and `archiver` unavailable. Render deployment and a real Upstash database have not been tested here.
