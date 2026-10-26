const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-CloudCoder-CSRF': '1',
      ...(opts.headers || {}),
    },
    ...opts,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
};

const state = {
  workspaceId: null,
  jobId: null,
  stream: null,
  workspaces: [],
  models: [],
  openCodeReady: false,
  modelMeta: { defaultModel: null, source: null, error: null },
};

/* ---------------- Utilities ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Minimal, safe markdown: code fences, inline code, bold, italic, links, line breaks.
function renderMarkdown(text) {
  const src = String(text || '');
  const parts = [];
  const re = /```([\w-]*)\n?([\s\S]*?)```/g;
  let i = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > i) parts.push({ t: 'text', v: src.slice(i, m.index) });
    parts.push({ t: 'code', lang: m[1] || '', v: m[2] });
    i = m.index + m[0].length;
  }
  if (i < src.length) parts.push({ t: 'text', v: src.slice(i) });

  return parts.map((p) => {
    if (p.t === 'code') {
      const lang = p.lang || 'text';
      return (
        '<div class="code-block">' +
          '<div class="code-head">' +
            `<span>${escapeHtml(lang)}</span>` +
            '<button class="copy-code" type="button">Copy</button>' +
          '</div>' +
          `<pre><code>${escapeHtml(p.v)}</code></pre>` +
        '</div>'
      );
    }
    let t = escapeHtml(p.v);
    t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    t = t.replace(/\n/g, '<br>');
    return t;
  }).join('');
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/* ---------------- Auth ---------------- */

function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
}
function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

async function checkSession() {
  try {
    await api('/api/auth/me');
    showApp();
    await Promise.all([refreshWorkspaces(), refreshRepos()]);
  } catch {
    showLogin();
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  $('#login-btn').disabled = true;
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#login-user').value, password: $('#login-pass').value }),
    });
    showApp();
    await Promise.all([refreshWorkspaces(), refreshRepos()]);
  } catch (err) {
    $('#login-error').textContent = err.message;
  } finally {
    $('#login-btn').disabled = false;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

/* ---------------- Drawers (mobile) ---------------- */

function closeDrawers() {
  $('#sidebar')?.classList.remove('open');
  $('#inspector')?.classList.remove('open');
  const scrim = $('#scrim');
  if (scrim) { scrim.classList.remove('visible'); scrim.setAttribute('hidden', ''); }
}
function openSidebar() {
  $('#inspector')?.classList.remove('open');
  $('#sidebar')?.classList.add('open');
  const scrim = $('#scrim');
  if (scrim) { scrim.classList.add('visible'); scrim.removeAttribute('hidden'); }
}
function openInspector() {
  $('#sidebar')?.classList.remove('open');
  $('#inspector')?.classList.add('open');
  const scrim = $('#scrim');
  if (scrim) { scrim.classList.add('visible'); scrim.removeAttribute('hidden'); }
}
$('#menu-btn')?.addEventListener('click', openSidebar);
$('#sidebar-close')?.addEventListener('click', closeDrawers);
$('#inspector-btn')?.addEventListener('click', openInspector);
$('#inspector-close')?.addEventListener('click', closeDrawers);
$('#scrim')?.addEventListener('click', closeDrawers);

/* ---------------- Navigation ---------------- */

$$('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const view = btn.dataset.view;
    $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
    if (view === 'files') refreshFiles();
    if (view === 'repos') refreshRepos();
    closeDrawers();
  });
});


/* ---------------- Composer enablement (workspace-first + readiness) ---------------- */

function updateComposerState() {
  const prompt = $('#prompt');
  const send = $('#send-btn');
  const attach = $('#attach-btn');
  const modelSel = $('#model-select');
  const emptyTitle = $('#empty-title');
  const emptyCopy = $('#empty-copy');
  const suggestions = $('#suggestions');

  const hasWs = Boolean(state.workspaceId);
  const ready = state.openCodeReady;
  const busy = Boolean(state.jobId);
  const canType = hasWs && !busy;
  const canSend = hasWs && ready && !busy && Boolean(prompt?.value.trim());

  if (prompt) {
    prompt.disabled = !canType;
    prompt.placeholder = !hasWs
      ? 'Select a workspace to start…'
      : !ready
        ? 'OpenCode is starting… try again in a moment'
        : 'Tell Universal Modder what to change…';
  }
  if (send) send.disabled = !canSend;
  if (attach) attach.disabled = !hasWs || busy;
  if (modelSel) modelSel.disabled = busy;

  if (emptyTitle && emptyCopy && !hasWs) {
    emptyTitle.textContent = 'Select a workspace first';
    emptyCopy.textContent = 'Import a web app from GitHub or ZIP, then ask Universal Modder to inspect, fix, redesign, refactor or test it.';
  } else if (emptyTitle && emptyCopy && hasWs) {
    emptyTitle.textContent = 'Ready when you are';
    emptyCopy.textContent = 'Tell Universal Modder what to change in this web app. For example: “Make the landing page mobile-friendly and run the tests.”';
  }
  if (suggestions) suggestions.classList.toggle('disabled', !hasWs);
}

/* ---------------- Workspaces ---------------- */

async function refreshWorkspaces() {
  state.workspaces = await api('/api/workspaces').catch(() => []);
  const ul = $('#workspace-list');
  if (!ul) return;
  ul.innerHTML = '';
  for (const w of state.workspaces) {
    const li = document.createElement('li');
    li.className = 'clickable';
    li.textContent = `${w.id} · ${w.files} files`;
    li.addEventListener('click', () => selectWorkspace(w.id));
    ul.appendChild(li);
  }
  if (!state.workspaces.length) ul.innerHTML = '<li class="muted small">No workspaces yet</li>';
}

$('#new-workspace').addEventListener('click', async () => {
  try {
    const res = await api('/api/workspaces', { method: 'POST', body: '{}' });
    await refreshWorkspaces();
    selectWorkspace(res.workspaceId);
    toast('Workspace created', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#new-task-btn')?.addEventListener('click', () => {
  $('#new-workspace')?.click();
});

async function selectWorkspace(id) {
  state.workspaceId = id;
  const wsPill = $('#ws-pill');
  if (wsPill) { wsPill.hidden = false; wsPill.textContent = id; }

  const info = await api(`/api/workspaces/${id}`).catch(() => null);
  const dl = $('#ws-info');
  if (dl) {
    dl.innerHTML = '';
    const rows = [
      ['Workspace', id],
      ['Project', info?.project?.type || 'unknown'],
      ['Files', String(info?.files ?? '—')],
      ['Size', info ? `${(info.bytes / 1024).toFixed(1)} KB` : '—'],
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      dl.append(dt, dd);
    }
  }
  await refreshFiles();
  await refreshStatus();
  updateComposerState();
  toast(`Workspace ${id} selected`);
}

/* ---------------- Repos ---------------- */

async function refreshRepos() {
  const ul = $('#repo-list');
  if (!ul) return;
  try {
    const repos = await api('/api/github/repos');
    ul.innerHTML = '';
    for (const r of repos) {
      const li = document.createElement('li');
      li.className = 'clickable';
      li.textContent = `${r.fullName}${r.private ? ' 🔒' : ''} — ${r.language || 'n/a'}`;
      li.addEventListener('click', async () => {
        try {
          const res = await api('/api/github/clone', {
            method: 'POST',
            body: JSON.stringify({ owner: r.owner, repo: r.name }),
          });
          await refreshWorkspaces();
          selectWorkspace(res.workspaceId);
          toast(`Cloned ${r.fullName}`, 'ok');
        } catch (err) {
          toast(err.message, 'err');
        }
      });
      ul.appendChild(li);
    }
    if (!repos.length) ul.innerHTML = '<li class="muted">No repositories.</li>';
  } catch (err) {
    ul.innerHTML = `<li class="muted">${escapeHtml(err.message)}</li>`;
  }
}
$('#refresh-repos').addEventListener('click', refreshRepos);

/* ---------------- Files ---------------- */

async function refreshFiles() {
  const ul = $('#file-list');
  if (!ul) return;
  if (!state.workspaceId) { ul.innerHTML = '<li class="muted">Select or create a workspace.</li>'; return; }
  try {
    const files = await api(`/api/workspaces/${state.workspaceId}/files`);
    ul.innerHTML = '';
    for (const f of files.slice(0, 500)) {
      const li = document.createElement('li');
      li.textContent = f.type === 'dir' ? `📁 ${f.path}` : `📄 ${f.path} · ${f.size} B`;
      if (f.type === 'file') {
        li.className = 'clickable';
        li.addEventListener('click', async () => {
          try {
            const res = await fetch(`/api/workspaces/${state.workspaceId}/file?path=${encodeURIComponent(f.path)}`, { credentials: 'same-origin' });
            const text = await res.text();
            addMessage('tool', `\`\`\`\n${text.slice(0, 4000)}\n\`\`\``);
            $('[data-view="chat"]').click();
          } catch (err) { toast(err.message, 'err'); }
        });
      }
      ul.appendChild(li);
    }
    if (!files.length) ul.innerHTML = '<li class="muted">Empty workspace.</li>';
  } catch (err) {
    ul.innerHTML = `<li class="muted">${escapeHtml(err.message)}</li>`;
  }
}

$('#upload-files').addEventListener('click', () => {
  if (!state.workspaceId) return toast('Select a workspace first', 'err');
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true;
  input.addEventListener('change', async () => {
    const fd = new FormData();
    for (const f of input.files) fd.append('files', f);
    const res = await fetch(`/api/workspaces/${state.workspaceId}/upload`, {
      method: 'POST', body: fd, credentials: 'same-origin',
      headers: { 'X-CloudCoder-CSRF': '1' },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return toast(data?.error || 'Upload failed', 'err');
    toast(`Uploaded ${data.uploaded.length} file(s)`, 'ok');
    refreshFiles();
  });
  input.click();
});

$('#upload-zip').addEventListener('click', () => {
  if (!state.workspaceId) return toast('Select a workspace first', 'err');
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.zip,application/zip';
  input.addEventListener('change', async () => {
    const fd = new FormData();
    fd.append('archive', input.files[0]);
    const res = await fetch(`/api/workspaces/${state.workspaceId}/upload-zip`, {
      method: 'POST', body: fd, credentials: 'same-origin',
      headers: { 'X-CloudCoder-CSRF': '1' },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return toast(data?.error || 'Extraction failed', 'err');
    toast(`Extracted ${data.extracted.entries} entries`, 'ok');
    refreshFiles();
  });
  input.click();
});

$('#download-zip').addEventListener('click', () => {
  if (!state.workspaceId) return toast('Select a workspace first', 'err');
  window.location.href = `/api/workspaces/${state.workspaceId}/zip`;
});

/* ---------------- Inspector actions ---------------- */

$('#btn-diff').addEventListener('click', async () => {
  if (!state.workspaceId) return toast('Select a workspace', 'err');
  try {
    const res = await fetch(`/api/github/${state.workspaceId}/diff`, { credentials: 'same-origin' });
    const text = await res.text();
    $('#terminal').textContent = text.slice(0, 8000) || '(no diff)';
  } catch (err) { $('#terminal').textContent = err.message; }
});

$('#btn-test').addEventListener('click', () => runAction('test'));
$('#btn-build').addEventListener('click', () => runAction('build'));

$('#clear-terminal')?.addEventListener('click', () => { $('#terminal').textContent = ''; });

async function runAction(action) {
  if (!state.workspaceId) return toast('Select a workspace', 'err');
  $('#terminal').textContent = `Running ${action}…`;
  try {
    const res = await api(`/api/workspaces/${state.workspaceId}/actions/${action}`, { method: 'POST', body: '{}' });
    if (!res.supported) { $('#terminal').textContent = res.reason || `Unsupported action for project type.`; return; }
    const last = res.results[res.results.length - 1];
    $('#terminal').textContent = `exit ${last.code} · ${last.durationMs}ms\n\n${last.stdout}\n${last.stderr}`;
    toast(`${action} ${res.ok ? 'passed' : 'failed'}`, res.ok ? 'ok' : 'err');
  } catch (err) {
    $('#terminal').textContent = err.message;
    toast(err.message, 'err');
  }
}

async function refreshStatus() {
  if (!state.workspaceId) return;
  const res = await fetch(`/api/github/${state.workspaceId}/status`, { credentials: 'same-origin' }).catch(() => null);
  if (!res || !res.ok) return;
  const data = await res.json();
  const ul = $('#changed-list');
  if (!ul) return;
  ul.innerHTML = '';
  for (const f of data.status?.files || []) {
    const li = document.createElement('li');
    li.textContent = `${f.index}${f.working_dir} ${f.path}`;
    ul.appendChild(li);
  }
  if (!ul.children.length) ul.innerHTML = '<li class="muted">No changes</li>';
}

/* ---------------- Chat ---------------- */

function hideEmptyState() {
  const es = document.getElementById('empty-state');
  if (es) es.classList.add('hidden');
}

function addMessage(role, text, { html = false } = {}) {
  hideEmptyState();
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = role === 'user' ? 'YOU' : role === 'tool' ? 'TOOL' : 'AI';

  const content = document.createElement('div');
  content.className = 'msg-content';
  if (html) content.innerHTML = renderMarkdown(text);
  else content.textContent = text;

  wrap.append(avatar, content);
  $('#messages').appendChild(wrap);

  const m = $('#messages');
  m.scrollTop = m.scrollHeight;
  return content;
}

// Copy-code delegation
$('#messages').addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-code');
  if (!btn) return;
  const pre = btn.closest('.code-block')?.querySelector('pre code');
  if (!pre) return;
  const text = pre.textContent;
  const done = () => { btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = 'Copy'), 1400); };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(() => {});
  else {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch {}
    document.body.removeChild(ta);
  }
});

// Suggestion chips
document.addEventListener('click', (e) => {
  const s = e.target.closest('.suggestion');
  if (!s) return;
  if (!state.workspaceId) return toast('Select or create a workspace first', 'err');
  const p = $('#prompt');
  if (!p || p.disabled) return;
  p.value = s.dataset.prompt || s.textContent.trim();
  autoGrow();
  updateComposerState();
  p.focus();
});

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = $('#prompt').value.trim();
  if (!prompt) return;
  if (!state.workspaceId) return toast('Select or create a workspace first', 'err');
  if (!state.openCodeReady) return toast('OpenCode is still starting — wait a few seconds', 'err');

  addMessage('user', prompt);
  $('#prompt').value = '';
  autoGrow();
  state.jobId = 'pending';
  $('#cancel-btn').classList.remove('hidden');
  updateComposerState();

  try {
    const model = $('#model-select').value || undefined;
    const { jobId } = await api('/api/agent/tasks', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: state.workspaceId, prompt, model }),
    });
    state.jobId = jobId;
    streamJob(jobId);
  } catch (err) {
    addMessage('tool', `Error: ${err.message}`);
    state.jobId = null;
    $('#cancel-btn').classList.add('hidden');
    updateComposerState();
  }
});

// Enter to send, Shift+Enter for newline
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

function streamJob(jobId) {
  if (state.stream) state.stream.close();
  const es = new EventSource(`/api/agent/tasks/${jobId}/stream`);
  state.stream = es;
  let agentBody = null;
  let agentRaw = '';

  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }

    if (ev.type === 'part') {
      const role = ev.role || 'assistant';
      if (role === 'user' || role === 'system') return;
      const p = ev.part || {};
      if (p.type === 'text' && p.text) {
        if (!agentBody) agentBody = addMessage('agent', '');
        agentRaw += p.text;
        agentBody.innerHTML = renderMarkdown(agentRaw);
        const m = $('#messages');
        m.scrollTop = m.scrollHeight;
      } else if (p.type === 'tool') {
        addMessage('tool', `🔧 ${p.tool || 'tool'}`);
      } else if (p.type === 'reasoning' && p.text) {
        addMessage('tool', `💭 ${p.text.slice(0, 500)}`);
      }
    } else if (ev.type === 'done') {
      addMessage('tool', ev.status === 'completed' ? '✅ Task completed' : `❌ Task ${ev.status}${ev.error ? `: ${ev.error}` : ''}`);
      es.close();
      state.stream = null;
      state.jobId = null;
      state.jobId = null;
      $('#cancel-btn').classList.add('hidden');
      updateComposerState();
      refreshStatus();
      refreshFiles();
    }
  };
  es.onerror = () => {
    es.close();
    state.stream = null;
    state.jobId = null;
    $('#cancel-btn').classList.add('hidden');
    updateComposerState();
  };
}

$('#cancel-btn').addEventListener('click', async () => {
  if (!state.jobId) return;
  await api(`/api/agent/tasks/${state.jobId}/cancel`, { method: 'POST', body: '{}' }).catch(() => {});
  toast('Cancellation requested');
});

$('#attach-btn').addEventListener('click', () => $('#attach-input').click());
$('#attach-input').addEventListener('change', async () => {
  if (!state.workspaceId) return toast('Select a workspace first', 'err');
  const fd = new FormData();
  for (const f of $('#attach-input').files) fd.append('files', f);
  const res = await fetch(`/api/workspaces/${state.workspaceId}/upload`, {
    method: 'POST', body: fd, credentials: 'same-origin',
    headers: { 'X-CloudCoder-CSRF': '1' },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return toast(data?.error || 'Upload failed', 'err');
  toast(`Attached ${data.uploaded.length} file(s)`, 'ok');
  $('#attach-input').value = '';
});

/* ---------------- Model selector ---------------- */

const MODEL_PREF_KEY = 'cc.preferredModel';

function persistModel(v) {
  try {
    if (v) localStorage.setItem(MODEL_PREF_KEY, v);
    else localStorage.removeItem(MODEL_PREF_KEY);
  } catch {}
}
function restoreModel() {
  try { return localStorage.getItem(MODEL_PREF_KEY) || ''; } catch { return ''; }
}

async function loadModels() {
  const sel = $('#model-select');
  const settingsSel = $('#settings-model');
  if (!sel) return;
  const seen = new Set();
  state.models = [];
  const add = (id, label) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    state.models.push(id);
    for (const target of [sel, settingsSel].filter(Boolean)) {
      // skip if option already exists
      if ([...target.options].some((o) => o.value === id)) continue;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = label || id;
      target.appendChild(opt);
    }
  };

  // Primary: safe backend model list (no secrets)
  try {
    const data = await api('/api/models');
    state.modelMeta = {
      defaultModel: data.defaultModel || null,
      source: data.source || null,
      error: data.error || null,
    };
    state.openCodeReady = Boolean(data.openCodeReady);
    for (const m of data.models || []) {
      const ref = m.openCodeRef || m.id;
      add(ref, m.name ? `${m.name} (${ref})` : ref);
    }
    if (data.defaultModel) add(data.defaultModel, data.defaultModel);
  } catch {}

  // Fallback providers from OpenCode if list empty
  if (!state.models.length) {
    try {
      const res = await fetch('/opencode/config/providers', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data.providers)
          ? data.providers
          : Object.entries(data.providers || data || {}).map(([id, p]) => ({ id, ...(p || {}) }));
        for (const p of list) {
          const pid = p.id || p.providerID || p.name;
          const models = p.models
            ? (Array.isArray(p.models) ? p.models : Object.values(p.models))
            : [];
          for (const m of models) {
            const mid = typeof m === 'string' ? m : (m.id || m.modelID || m.name);
            if (pid && mid) add(`${pid}/${mid}`, `${pid}/${mid}`);
            else if (mid) add(String(mid), String(mid));
          }
        }
      }
    } catch {}
  }

  try {
    const st = await api('/api/status').catch(() => null);
    if (st?.defaultModel) add(st.defaultModel, st.defaultModel);
    if (typeof st?.openCodeReady === 'boolean') state.openCodeReady = st.openCodeReady;
  } catch {}

  const pref = restoreModel();
  if (pref && state.models.includes(pref)) {
    sel.value = pref;
    if (settingsSel) settingsSel.value = pref;
  }

  // Settings meta (never secrets)
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v || '—'; };
  setText('#meta-default', state.modelMeta.defaultModel || '(server default)');
  setText('#meta-source', state.modelMeta.source || 'unknown');
  setText('#meta-opencode', state.openCodeReady ? 'ready' : 'starting');
  setText('#meta-error', state.modelMeta.error || 'none');
  updateComposerState();
}

// Sync model selectors + persist preference
$('#model-select').addEventListener('change', () => {
  const v = $('#model-select').value;
  persistModel(v);
  const settingsSel = $('#settings-model');
  if (settingsSel && settingsSel.value !== v) settingsSel.value = v;
});
$('#settings-model')?.addEventListener('change', () => {
  const v = $('#settings-model').value;
  persistModel(v);
  const sel = $('#model-select');
  if (sel && sel.value !== v) sel.value = v;
});

/* ---------------- Composer niceties ---------------- */

function autoGrow() {
  const el = $('#prompt');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';

  const counter = $('#char-count');
  if (counter) {
    const len = el.value.length;
    if (len > 500) { counter.hidden = false; counter.textContent = `${len} chars`; }
    else counter.hidden = true;
  }

  updateComposerState();
}

$('#prompt')?.addEventListener('input', autoGrow);

/* ---------------- Connection status ---------------- */

async function pollHealth() {
  const dot = $('#conn-dot');
  const label = $('#conn-label');
  if (!dot || !label) return;
  try {
    const res = await fetch('/health', { credentials: 'same-origin' });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.opencode === 'ready') {
      state.openCodeReady = true;
      dot.className = 'dot ok';
      label.textContent = 'connected';
      const mo = $('#meta-opencode');
      if (mo) mo.textContent = 'ready';
    } else {
      state.openCodeReady = false;
      dot.className = 'dot warn';
      label.textContent = 'starting…';
      const mo = $('#meta-opencode');
      if (mo) mo.textContent = 'starting';
    }
  } catch {
    state.openCodeReady = false;
    dot.className = 'dot err';
    label.textContent = 'offline';
    const mo = $('#meta-opencode');
    if (mo) mo.textContent = 'offline';
  }
  updateComposerState();
}

/* ---------------- Bootstrap ---------------- */

async function bootstrap() {
  await checkSession();
  await loadModels();
  await pollHealth();
  setInterval(pollHealth, 15000);
  updateComposerState();
  autoGrow();
}

bootstrap();