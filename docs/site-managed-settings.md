# Site-managed settings

Universal Modder now has a Settings page for the custom OpenAI-compatible provider, GitHub token, and optional website-login override. Provider changes refresh the model catalog and restart OpenCode. The API key and GitHub token are never returned to the browser and are encrypted at rest using the Render `SESSION_SECRET`; the optional website-login password is stored as a salted scrypt hash.

## Persistence on Render

Site settings are written with restrictive file permissions and encrypted secrets. Without a persistent disk they use `/tmp/universal-modder-settings.json`, which may be lost on redeploy. For persistence, attach a Render persistent disk mounted at `/var/data`; the app auto-detects that mount. You can optionally override the file path with `RUNTIME_SETTINGS_PATH`.

The existing Render environment variables remain the bootstrap/fallback. Site-managed values override provider settings for the running instance. Keep the service private to your own use while using site-managed secrets; a production multi-user release should use encrypted secret storage and per-user authorization rather than one shared operator configuration.

## Faster tasks

The composer has **Fast** and **Thorough** modes. Fast mode omits the extra plan-first instruction; Thorough mode asks the agent to plan before changing files. Polling defaults to 750 ms. Model reasoning time and build/test commands can still dominate the total task duration.

## Workspace names

New workspaces save a display name in a metadata sidecar file. Existing workspaces without metadata fall back to their ID. GitHub clones use the repository name unless another name is provided by the API.
