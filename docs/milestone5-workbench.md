# Milestone 5 — Workbench visibility

## Implemented
- Agent activity panel in the workspace inspector:
  - Task list from agent `task_list` events
  - Live status line from `status` phases
  - Verification summary (files touched, build/test outcomes)
  - Compact activity log (tools, phases)
- Stream handler consumes Milestone 4 events (`session`, `task_list`, `status`, `verification`, `part`, `done`)
- On task completion: refresh file list; reload preview if open
- Verification populates the **Changed files** list (M/A/D)
- Styles for activity/verification panels

## Preserved
- Existing composer, Build/Plan mode selector, preview iframe, visual editor, terminal/actions, settings UI

## Notes
- Preview still serves real workspace static/build output under `/api/workspaces/:id/preview` (authenticated or preview token)
- Full in-browser code editor remains optional; file list + terminal + diffs remain the primary inspection path
