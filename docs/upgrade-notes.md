# Universal Modder upgrade notes

This upgrade intentionally keeps the existing CloudCoder Agent codebase and its OpenCode engine rather than replacing working code.

## Included in this upgrade

- Rebranded the dashboard and app metadata as Universal Modder.
- Updated the chat's empty-state guidance for importing and modifying web apps.
- Configured the Render Blueprint for the known China-GPT base URL and the currently intended MiniMax model.
- Updated environment examples and default Git commit identity.
- Reworked the README with the project workflow, provider setup, deployment steps, limitations, and production roadmap.

## Required before first deploy

1. Set `CUSTOM_AI_API_KEY` to the real key in Render's secret environment settings. The ZIP contains no real key.
2. Confirm the exact model ID with the gateway's authenticated `GET /v1/models` response. If the returned ID differs, update `CUSTOM_AI_MODEL` and `DEFAULT_MODEL` in Render.
3. Confirm the endpoint's OpenAI-compatible chat-completions and tool-call behavior with OpenCode. A successful model-list request alone does not prove tool use works.
4. Test with a small, non-sensitive sample web app before importing an important repository.

## Not yet included

This is not yet a multi-tenant production platform. It still uses one operator login and a single service process; workspaces on Render Free are ephemeral. Public multi-user accounts, isolated workers, durable project storage, and sandboxed previews remain explicit follow-up milestones. Do not allow arbitrary public users to execute code on this deployment.
