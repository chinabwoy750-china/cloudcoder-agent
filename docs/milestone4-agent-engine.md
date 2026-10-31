# Milestone 4 — Agent engine (plan/build + verify + repair)

## Implemented
- Stronger plan/build prompt contracts (`buildTaskPrompt`)
- Workspace fingerprint before agent run
- Post-run verification (`src/agent/verify.js`)
  - File change detection (added/changed/removed)
  - Optional isolated `test`/`build` via Milestone 3 runner
  - Structured `successCriteria` (does not report success on empty talk-only responses)
- Streaming events extended:
  - `task_list`, `status` phases, `verification`
- Bounded auto-repair round when build verification fails (`AGENT_MAX_REPAIR_ROUNDS`, default 1)
- Job result includes `{ sessionId, verification, mode }`

## Modes
| Mode | Files | Verification |
|------|-------|--------------|
| plan | Instructs no writes | Skips command verify; success = plan delivered |
| build | Implements changes | Fingerprint + test/build when available; repair once on failure |

## Env
```
PLAN_THEN_ACT=true
AGENT_MAX_REPAIR_ROUNDS=1
TASK_TIMEOUT_MS=900000
```

## Notes
- Plan mode is still a model instruction (OpenCode tools may still be capable of writes). Treat sensitive workspaces carefully.
- Verification uses the same allowlisted project actions as the workbench.
