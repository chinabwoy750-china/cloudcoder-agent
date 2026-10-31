# Universal Modder Phase 7A patch

Merge the included `package.json`, `src/storage/postgres.js`, and documentation into the current repository. Do not replace the repository with this patch ZIP.

This is a compatibility-first PostgreSQL foundation. It creates the relational schema but intentionally does not change authentication or project access yet. Configure `DATABASE_URL` only after creating a Render PostgreSQL database. Run `npm install` so the `pg` dependency is installed, then redeploy.

The next patch will migrate the initial administrator account and add database-backed sessions/account identity plus ownership enforcement before multi-user registration is enabled.
