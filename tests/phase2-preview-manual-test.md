# Phase 2 preview test checklist

1. Sign in and create/select a workspace.
2. Add `index.html` at the workspace root with simple HTML and a relative `style.css`.
3. Click **Open preview**. The page and stylesheet should render in the preview modal.
4. Change `index.html`, save it, and click **Refresh**.
5. Try a workspace without root `index.html`; the UI should report that a root entry point is missing.
6. Confirm requests for `../.env`, `.git/config`, and `node_modules/...` are rejected/not served.
7. Confirm existing Build/Plan mode selector still appears and still sends its mode.
