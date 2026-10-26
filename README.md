# Universal Modder

**Universal Modder** is a web-app modification studio built by upgrading CloudCoder Agent. It keeps **OpenCode** as the coding engine and supports a China-GPT-compatible OpenAI API endpoint, GitHub repositories, ZIP uploads, streamed agent tasks, file inspection, project actions, ZIP export, and optional GitHub commits/pull requests.

> Current release status: this is a single-operator MVP, not yet a public multi-tenant service. Do not expose it to untrusted users until per-user authorization, isolated job execution, durable storage, and preview isolation are implemented and tested.

## Current workflow

1. Sign in to the private Universal Modder dashboard.
2. Create a workspace, upload a ZIP, or import a repository through the Repositories view.
3. Ask OpenCode to inspect the app and make a concrete change (for example, “Make the landing page responsive, preserve the existing design, and run the tests”).
4. Follow task progress in the UI; inspect files and diffs.
5. Run supported project actions and download the modified project as a ZIP. GitHub operations are available when a token is configured.

## Architecture

```text
Universal Modder web UI / optional Telegram
                  |
                  v
          Express API + sessions
             |           |
             v           v
       OpenCode CLI     GitHub API
             |
             v
   Workspace + guarded project actions
             |
             v
       China-GPT endpoint
```

OpenCode listens on loopback only. The app uses an authenticated API, signed sessions, CSRF checks, rate limits, ZIP extraction limits, server-side action allowlists, and secret redaction. Review `docs/security.md` before deploying.

## Run locally

Requirements: Node.js 22+, Git, and OpenCode CLI (`opencode-ai`).

```bash
npm install -g opencode-ai@latest
cp .env.example .env
# Edit .env: replace all example credentials and set a valid China-GPT API key.
npm install
npm test
npm run dev
```

Open `http://localhost:10000`.

## China-GPT configuration

The Render Blueprint is preconfigured with the known endpoint and model ID:

```dotenv
CUSTOM_AI_BASE_URL=https://gpt-china.onrender.com/v1
CUSTOM_AI_PROVIDER=china-gpt
CUSTOM_AI_MODEL=dahl/MiniMaxAI/MiniMax-M2.7
CUSTOM_AI_MODEL_NAME=MiniMax M2.7
CUSTOM_AI_PROVIDER_NAME=China-GPT
DEFAULT_MODEL=china-gpt/dahl/MiniMaxAI/MiniMax-M2.7
CUSTOM_AI_API_KEY=<your actual China-GPT API key>
```

Set `CUSTOM_AI_API_KEY` as a secret in Render's Environment dashboard. Never commit the real key. The endpoint's `/v1/models` response is used to populate model selection; if discovery fails, the configured model is the fallback. The model ID above comes from the existing deployment context and must be verified against the live gateway's `/v1/models` response before relying on it. OpenCode's custom provider configuration is documented at <https://opencode.ai/docs/providers/>.

If the gateway's `baseURL` is configured without `/v1`, OpenAI-compatible requests may hit the wrong path. Keep `/v1` in `CUSTOM_AI_BASE_URL` unless the gateway's documentation says otherwise.

## Deploy to Render

1. Push this repository to your GitHub account (or upload the updated ZIP to a new repository).
2. In Render, create a Blueprint from the repository and review `render.yaml`.
3. Set `CLOUDCODER_USERNAME`, `CLOUDCODER_PASSWORD`, `CUSTOM_AI_API_KEY`, and any optional GitHub/Telegram secrets.
4. Deploy and verify `/health` before signing in.
5. Open the dashboard, create a workspace, import a small test app, and ask for a low-risk change before trying a larger project.

The included Blueprint targets a free web service for initial testing. Render free services have ephemeral filesystems and may spin down; local workspace data can disappear after restarts or deploys. See <https://render.com/docs/free>. Do not treat this setup as durable production hosting.

## Environment variables

| Variable | Purpose |
|---|---|
| `CLOUDCODER_USERNAME`, `CLOUDCODER_PASSWORD` | Private dashboard/API login |
| `SESSION_SECRET` | Session signing secret; use a long random value |
| `OPENCODE_SERVER_PASSWORD` | Internal OpenCode server credential |
| `CUSTOM_AI_BASE_URL` | China-GPT OpenAI-compatible base URL, normally ending in `/v1` |
| `CUSTOM_AI_API_KEY` | Secret API key for China-GPT |
| `CUSTOM_AI_PROVIDER` | OpenCode provider ID, e.g. `china-gpt` |
| `CUSTOM_AI_MODEL` | Exact upstream model ID returned by `/v1/models` |
| `DEFAULT_MODEL` | OpenCode model reference, `provider/model` |
| `GITHUB_TOKEN` | Optional token for repository and pull-request actions |
| `GITHUB_ALLOW_DEFAULT_BRANCH` | Keep `false` unless direct default-branch pushes are intentional |
| `TELEGRAM_BOT_TOKEN` | Optional Telegram interface |
| `TELEGRAM_ALLOWED_USER_IDS` | Required allowlist when Telegram is enabled |
| `WORKSPACE_ROOT` | Workspace location; defaults to ephemeral `/tmp/cloudcoder` |

See `.env.example` for all settings and `docs/security.md` for safety boundaries.

## Roadmap for a public Universal Modder service

- [x] Keep OpenCode as the coding engine.
- [x] Support custom OpenAI-compatible model providers.
- [x] Retain GitHub/ZIP project intake and ZIP export.
- [x] Rebrand the existing dashboard as Universal Modder.
- [ ] Add individual user accounts and per-user project/job authorization.
- [ ] Move builds and arbitrary project commands into disposable isolated workers.
- [ ] Add durable database-backed projects/jobs and object storage for uploads/results.
- [ ] Add isolated web previews and cleanup policies.
- [ ] Add end-to-end tests for import → edit → validate → export/PR.

Do not enable open registration or accept arbitrary users until the unchecked security and isolation items are complete. Render background workers are designed for long-running asynchronous work, but are not available on the free instance tier; see <https://render.com/docs/background-workers>.
