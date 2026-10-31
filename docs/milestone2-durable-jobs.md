# Milestone 2 — Durable storage and background jobs

## Implemented
- Object storage adapter (`src/storage/objects.js`)
  - Local durable directory by default (`OBJECT_STORAGE_PATH` or `<WORKSPACE_ROOT>/.objects`)
  - S3 credential detection (mode `s3`); remote SigV4 client deferred to avoid new hard dependency in this milestone
  - `putObject` / `getObject` / `deleteObject` / health probe
- Durable job rows on PostgreSQL (`src/jobs/store.js`)
  - Create/update agent_jobs when `ownerUserId` is present
  - List jobs by owner
  - Load job after process restart
  - Mark stale running jobs failed on startup
- In-memory registry dual-writes to Postgres (`src/jobs/registry.js`)
- Agent tasks record `ownerUserId`; list/get respect ownership
- Workspace archive mirror endpoint `POST /api/workspaces/:id/archive`
- Health reports object storage readiness

## Recovery behavior
On process start, jobs left in `running`/`cancelling` longer than 6h (default) are marked `failed` with a restart message so the UI does not spin forever.

Live event streams remain memory-backed (restart loses mid-flight tokens). Job status/result survive when Postgres is configured.

## Env
```
OBJECT_STORAGE_PATH=/var/data/objects   # optional persistent disk path on Render
# Future S3:
# S3_ENDPOINT=
# S3_ACCESS_KEY_ID=
# S3_SECRET_ACCESS_KEY=
# S3_BUCKET=
# S3_REGION=
OBJECT_MAX_BYTES=83886080
```

## Not in this milestone
- Separate queue worker process (Milestone 3)
- Full AWS SDK remote uploads
- Moving live workspace working trees off local disk (still local; archives can be mirrored)
