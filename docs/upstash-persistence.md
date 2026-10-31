# Upstash persistence setup

Universal Modder can store site-managed settings in Upstash Redis instead of its local runtime settings file. This covers provider URL/model preferences, encrypted provider and GitHub tokens, and the site-managed account username/password hash. It does **not yet** move generated project folders, build output, chat history, or project files to durable storage; those remain a separate migration.

## Configure

1. Create a Redis database in the Upstash console.
2. Copy the database's **REST URL** and **REST token** (not the Redis TCP URL/password).
3. In Render, add these environment variables to the main Universal Modder service:
   - `UPSTASH_REDIS_REST_URL` — HTTPS REST URL
   - `UPSTASH_REDIS_REST_TOKEN` — secret REST token
   - `UPSTASH_REDIS_PREFIX` — optional, defaults to `universal-modder`
4. Keep `SESSION_SECRET` stable across deployments. Runtime secrets are encrypted with a key derived from it; changing it prevents old encrypted secrets from being decrypted.
5. Redeploy. The settings API should report `persistence: "upstash-redis"`.
6. Save a test provider/account setting, redeploy, and verify it remains. Do not paste API keys into logs or screenshots.

## Safety and migration notes

- Redis is authoritative once both Upstash variables are configured. If Redis reads fail during startup, the service fails rather than loading a stale local copy. If a save fails, the settings endpoint should return an error instead of claiming success.
- Existing settings stored only in `/tmp` are not automatically migrated to Redis. Before enabling Redis, copy/re-enter any settings you need to preserve using the website's settings page after deployment.
- Secrets are encrypted before storage, but the encryption key is derived from `SESSION_SECRET`; keep that variable private and unchanged.
- Use a dedicated Upstash database or a unique prefix for this app. Do not expose the REST token to browser code.
- Upstash settings persistence does not keep generated project files. A separate durable project-storage/runner phase is still required.
