# Milestone 6 — Visual edits + version history

## Implemented
- **Auto recovery snapshot** before build-mode agent tasks (non-fatal if snapshot fails)
- Snapshot event streamed to the workbench activity log
- **Version history panel** in inspector: list, create, restore (confirm required)
- Visual editor **text content** field persisted to `.universal-modder-visual-text.json` (selector → text map)
- Style overrides remain in `.universal-modder-visual.css` (real project files, not ephemeral preview-only styles)

## DOM → source mapping strategy
- CSS edits: selector-scoped rules written into workspace CSS file served by preview
- Text edits: JSON map by CSS selector; applied best-effort in iframe; full framework AST rewrites are **not** claimed
- Unsupported cases (shadow DOM, canvas, cross-origin frames) remain unmapped and are reported via UI status

## API (existing + used)
- `GET/POST /api/workspaces/:id/snapshots`
- `POST /api/workspaces/:id/snapshots/:snapshotId/restore` with `{ confirm: true }`

## Safety
- Restore is destructive and requires explicit confirmation
- Agent pre-snapshots reduce risk of silent loss after failed jobs
