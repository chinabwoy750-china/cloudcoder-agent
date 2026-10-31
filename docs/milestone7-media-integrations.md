# Milestone 7 — Media adapters and integrations

## Media
- Capability discovery: `GET /api/media/capabilities`
- Generation: `POST /api/media/generate/:kind` where kind ∈ `image|video|audio`
- Provider: China-GPT verified endpoints only (`/v1/image-generation`, `/v1/video-generation`, `/v1/audio`)
- Generated payloads optionally mirrored to object storage under `media/`
- Existing proxy routes under `/api/china-gpt/*` remain for UI compatibility

## GitHub improvements
- `GET /api/github/repos/:owner/:repo/branches` for branch selection before clone/PR flows

## MCP (groundwork)
- Admin `GET/PUT /api/integrations/mcp` stores allowlisted server definitions
- No in-process MCP tool execution yet (permission model reserved)

## n8n (external)
- Admin `GET/PUT /api/integrations/n8n` stores base URL + API key
- `GET /api/integrations/n8n/health` probes external instance
- n8n stays a separate deployment

## Figma (groundwork)
- Admin `GET/PUT /api/integrations/figma` stores token/fileKey
- Capabilities flagged `importFrames: false`, `codegen: false` until implemented

## Honesty
Figma-to-code and live MCP tool running are **not** claimed complete.
