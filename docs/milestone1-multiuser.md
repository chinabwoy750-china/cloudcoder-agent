# Milestone 1 — Database multi-user foundation

## Implemented
- DB user model helpers (`src/db/users.js`): create, authenticate, list, disable, password hashing (scrypt)
- Admin bootstrap from `CLOUDCODER_USERNAME` / `CLOUDCODER_PASSWORD` when `app_users` is empty
- Platform settings table for registration toggle (`src/db/platform-settings.js`)
- Audit event writer (`src/db/audit.js`)
- Session auth upgraded to multi-user identity `{ id, username, role }` with DB validation and legacy fallback
- Auth routes: `/api/auth/login|logout|me|register`, admin `/api/auth/users`, `/api/auth/registration`
- Workspace ownership recording + `assertWorkspaceOwner` (`src/db/workspaces.js`)
- Workspace manager + files routes enforce ownership when Postgres is configured
- Rename workspace (`PATCH /api/workspaces/:id`)

## Behavior
| Mode | Condition | Auth | Ownership |
|------|-----------|------|-----------|
| Legacy single-account | no `DATABASE_URL` | env/basic credentials | none (prior behavior) |
| Multi-user | `DATABASE_URL` set | DB users; admin bootstrapped once | enforced on workspace routes |

Registration is **off** unless admin enables it (`POST /api/auth/registration`) or `ALLOW_PUBLIC_REGISTRATION=true` seed.

## Not in this milestone
- Durable file/object storage
- Job queue / worker isolation
- Password-reset email flow (schema-ready later)
- UI admin panels for user management (API is ready)

## Env
- `DATABASE_URL` (required for multi-user)
- `CLOUDCODER_USERNAME` / `CLOUDCODER_PASSWORD` (bootstrap admin, min 12 chars)
- `SESSION_SECRET` (session + settings encryption)
- `ALLOW_PUBLIC_REGISTRATION` (optional seed default)
