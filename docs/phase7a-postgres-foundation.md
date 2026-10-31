# Phase 7A — PostgreSQL foundation

This patch adds the PostgreSQL dependency, a bounded connection pool, an idempotent schema initializer, and initial relational tables for users, workspaces, jobs, chat messages, and audit events.

## Configure Render

Create a managed PostgreSQL database in Render and add its **Internal Database URL** to the main service as `DATABASE_URL`. Keep the database private; do not put the URL in browser code or commit it. Optional settings:

- `PGPOOL_MAX=5` — maximum connections per service instance.
- `PGSSLMODE=disable` — only for a trusted local database connection. Leave unset on Render.

## Important scope

This is the database foundation only. It does not yet switch login to database-backed accounts, enforce workspace ownership, or move workspace files out of `/tmp`. Existing login and workspace behavior remains unchanged in this phase. Those changes must be implemented together in the next migration so no workspace is accidentally orphaned or exposed.

The schema is initialized automatically when `DATABASE_URL` is present. If PostgreSQL is configured but unavailable, startup fails rather than silently pretending relational persistence is active. When `DATABASE_URL` is absent, the existing single-account mode continues to run.

Before production use, take a backup and keep `DATABASE_URL` stable. Do not enable public registration until ownership checks have been applied to every workspace, file, preview, snapshot, GitHub, and job route.
