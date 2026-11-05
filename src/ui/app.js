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
  previewOpen: false,
  modelRouting: { build: '', plan: '', image: '', video: '', audio: '' },
  shell: 'home',
  menuWorkspaceId: null,
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


/* ---------------- Shell navigation (Home / Projects / Workspace) ---------------- */

/* ---------------- Per-project chat history (browser) ---------------- */
function chatStorageKey(workspaceId) {
  return `um_chat_${workspaceId}`;
}

function clearMessagesUI() {
  const box = $('#messages');
  if (!box) return;
  // keep action-history + empty-state nodes
  [...box.children].forEach((child) => {
    if (child.id === 'action-history' || child.id === 'empty-state') return;
    child.remove();
  });
}

function saveChatHistory() {
  if (!state.workspaceId) return;
  const box = $('#messages');
  if (!box) return;
  const items = [];
  box.querySelectorAll('.msg').forEach((el) => {
    const role = el.classList.contains('user') ? 'user' : el.classList.contains('agent') ? 'agent' : 'tool';
    const bubble = el.querySelector('.bubble');
    if (!bubble) return;
    items.push({ role, html: bubble.innerHTML, text: bubble.textContent || '' });
  });
  try {
    localStorage.setItem(chatStorageKey(state.workspaceId), JSON.stringify(items.slice(-80)));
  } catch { /* quota */ }
  updateEmptyStateVisibility();
}

function loadChatHistory(workspaceId) {
  clearMessagesUI();
  let items = [];
  try {
    items = JSON.parse(localStorage.getItem(chatStorageKey(workspaceId)) || '[]');
  } catch { items = []; }
  if (!Array.isArray(items)) items = [];
  for (const item of items) {
    const role = item.role === 'user' || item.role === 'agent' || item.role === 'tool' ? item.role : 'agent';
    if (item.html) addMessage(role, item.html, { html: true, skipSave: true });
    else if (item.text) addMessage(role, item.text, { skipSave: true });
  }
  updateEmptyStateVisibility();
}

function updateEmptyStateVisibility() {
  const empty = $('#empty-state');
  const box = $('#messages');
  if (!empty || !box) return;
  const hasMsgs = box.querySelectorAll('.msg').length > 0;
  empty.classList.toggle('hidden', hasMsgs);
  const suggestions = $('#suggestions');
  // Never show generic starter chips once a project has conversation history
  if (suggestions) suggestions.classList.toggle('hidden', hasMsgs || !state.workspaceId);
}


function setShell(name) {
  state.shell = name;
  const home = $('#shell-home');
  const projects = $('#shell-projects');
  const workspace = $('#shell-workspace');
  const bottomNav = $('#bottom-nav');
  home?.classList.toggle('hidden', name !== 'home');
  projects?.classList.toggle('hidden', name !== 'projects');
  workspace?.classList.toggle('hidden', name !== 'workspace');
  // Hide Home/Projects dock while editing a project
  if (bottomNav) bottomNav.classList.toggle('hidden', name === 'workspace');
  document.body.classList.toggle('shell-workspace-active', name === 'workspace');
  document.body.classList.toggle('shell-home-active', name === 'home');
  document.body.classList.toggle('shell-projects-active', name === 'projects');
  document.querySelectorAll('.bottom-nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.shell === name);
  });
  // Preview / inspector only belong to workspace shell
  document.querySelectorAll('.workspace-only').forEach((el) => {
    el.classList.toggle('hidden', name !== 'workspace');
  });
  if (name === 'home') {
    closeDrawers();
    // ensure preview closed on home
    if (state.previewOpen) {
      state.previewOpen = false;
      $('#preview-view')?.classList.add('hidden');
    }
  }
  if (name === 'projects') {
    closeDrawers();
    hideProjectMenu();
    renderProjectsList();
  }
}

document.querySelectorAll('.bottom-nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const shell = btn.dataset.shell;
    if (shell === 'home') setShell('home');
    if (shell === 'projects') setShell('projects');
  });
});

$('#home-settings-btn')?.addEventListener('click', () => {
  setShell('workspace');
  // open settings view
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === 'settings'));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-settings'));
  loadSiteSettings?.();
});

function hideProjectMenu() {
  $('#project-menu')?.classList.add('hidden');
  state.menuWorkspaceId = null;
}

function showProjectMenu(workspaceId, anchorEl) {
  const menu = $('#project-menu');
  if (!menu || !anchorEl) return;
  state.menuWorkspaceId = workspaceId;
  menu.classList.remove('hidden');
  const rect = anchorEl.getBoundingClientRect();
  const top = Math.min(window.innerHeight - 280, rect.bottom + 6);
  const left = Math.min(window.innerWidth - 240, Math.max(12, rect.right - 220));
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

document.addEventListener('click', (e) => {
  const menu = $('#project-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  if (menu.contains(e.target) || e.target.closest?.('.project-menu-btn')) return;
  hideProjectMenu();
});

async function renderProjectsList() {
  const list = $('#projects-list');
  if (!list) return;
  list.innerHTML = '<p class="muted small">Loading projects…</p>';
  try {
    await refreshWorkspaces();
    const items = state.workspaces || [];
    if (!items.length) {
      list.innerHTML = '<p class="muted" style="padding:12px 4px">No projects yet. Create one from Home or tap New project.</p>';
      return;
    }
    list.innerHTML = '';
    for (const w of items) {
      const id = w.id || w;
      const name = w.name || id;
      const when = w.createdAt || w.updatedAt || '';
      const whenLabel = when ? (typeof when === 'number' ? new Date(when).toLocaleDateString() : new Date(when).toLocaleDateString()) : '';
      const card = document.createElement('div');
      card.className = 'project-card';
      card.dataset.id = id;
      const initial = String(name).trim().charAt(0).toUpperCase() || 'P';
      card.innerHTML = `
        <div class="project-thumb">${escapeHtml(initial)}</div>
        <div class="project-meta">
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(whenLabel || id)}</span>
        </div>
        <button type="button" class="project-menu-btn" aria-label="Project menu">···</button>
      `;
      card.addEventListener('click', (ev) => {
        if (ev.target.closest('.project-menu-btn')) return;
        openProjectWorkspace(id);
      });
      card.querySelector('.project-menu-btn')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        showProjectMenu(id, ev.currentTarget);
      });
      list.appendChild(card);
    }
  } catch (err) {
    list.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
  }
}

async function openProjectWorkspace(id) {
  hideProjectMenu();
  setShell('workspace');
  // ensure chat view
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === 'chat' || !b.dataset.view));
  const chat = $('#view-chat');
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-chat' && v.id !== undefined));
  // show chat view specifically
  document.querySelectorAll('#shell-workspace .view').forEach((v) => {
    v.classList.toggle('hidden', v.id !== 'view-chat');
  });
  await selectWorkspace(id);
  updateComposerState();
}

$('#projects-new-btn')?.addEventListener('click', () => {
  setShell('home');
  $('#home-prompt')?.focus();
});
$('#projects-refresh')?.addEventListener('click', () => renderProjectsList());

$('#project-menu')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn || !state.menuWorkspaceId) return;
  const id = state.menuWorkspaceId;
  const action = btn.dataset.action;
  hideProjectMenu();
  try {
    if (action === 'open' || action === 'chat') {
      await openProjectWorkspace(id);
    } else if (action === 'rename') {
      const current = state.workspaces.find((w) => (w.id || w) === id);
      const name = prompt('Rename project', current?.name || '');
      if (!name) return;
      await api(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      toast('Renamed', 'ok');
      await renderProjectsList();
    } else if (action === 'export') {
      window.open(`/api/workspaces/${encodeURIComponent(id)}/zip`, '_blank');
    } else if (action === 'snapshot') {
      await api(`/api/workspaces/${encodeURIComponent(id)}/snapshots`, { method: 'POST', body: JSON.stringify({ label: 'manual' }) });
      toast('Snapshot created', 'ok');
    } else if (action === 'delete') {
      if (!confirm('Delete this project? This cannot be undone.')) return;
      await api(`/api/workspaces/${encodeURIComponent(id)}?confirm=true`, { method: 'DELETE' });
      toast('Deleted', 'ok');
      if (state.workspaceId === id) state.workspaceId = null;
      await renderProjectsList();
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

async function createProjectAndRun(prompt, mode = 'build') {
  const name = String(prompt).trim().slice(0, 48) || 'Untitled project';
  const res = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
  const id = res.workspaceId || res.id;
  if (!id) throw new Error('Could not create project');
  await refreshWorkspaces();
  setShell('workspace');
  document.querySelectorAll('#shell-workspace .view').forEach((v) => {
    v.classList.toggle('hidden', v.id !== 'view-chat');
  });
  await selectWorkspace(id);
  // seed prompt into main composer and send
  const ta = $('#prompt');
  if (ta) ta.value = prompt;
  const modeSel = $('#task-mode');
  if (modeSel) modeSel.value = mode === 'plan' ? 'plan' : 'build';
  updateComposerState();
  // trigger existing send path
  $('#composer')?.requestSubmit();
}

$('#home-composer')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = ($('#home-prompt')?.value || '').trim();
  if (!prompt) return;
  if (!state.openCodeReady) return toast('Coding engine is still starting…', 'err');
  const btn = $('#home-send-btn');
  if (btn) btn.disabled = true;
  try {
    const mode = $('#home-task-mode')?.value || 'build';
    await createProjectAndRun(prompt, mode);
    if ($('#home-prompt')) $('#home-prompt').value = '';
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
});

$('#home-prompt')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#home-composer')?.requestSubmit();
  }
});


function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
}
function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  setShell(state.workspaceId ? 'workspace' : 'home');
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


/* Admin settings tabs (non-scroll-all layout) */
document.querySelectorAll('.settings-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.settingsTab;
    document.querySelectorAll('.settings-tab').forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    document.querySelectorAll('.settings-pane').forEach((pane) => {
      pane.classList.toggle('active', pane.dataset.settingsPane === id);
    });
  });
});



/* ---------------- Modern agent live timeline ---------------- */
const STATUS_PHRASES = [
  'Reading your request…',
  'Inspecting the workspace…',
  'Planning the approach…',
  'Editing project files…',
  'Checking the result…',
];
let phraseTimer = null;
let phraseIdx = 0;

function showAgentLive() {
  const el = $('#agent-live');
  if (!el) return;
  el.classList.remove('hidden');
  el.classList.add('is-active');
}

function hideAgentLiveIdle() {
  const el = $('#agent-live');
  if (!el) return;
  el.classList.remove('is-active');
}

function setLiveStatus(text, { live = true } = {}) {
  const st = $('#agent-live-status');
  const badge = $('#agent-live-badge');
  if (st) st.textContent = text || '';
  if (badge) {
    badge.textContent = live ? 'LIVE' : 'DONE';
    badge.classList.toggle('is-done', !live);
    badge.classList.toggle('is-live', live);
  }
}

function startStatusPhrases() {
  stopStatusPhrases();
  phraseIdx = 0;
  setLiveStatus(STATUS_PHRASES[0], { live: true });
  phraseTimer = setInterval(() => {
    phraseIdx = (phraseIdx + 1) % STATUS_PHRASES.length;
    setLiveStatus(STATUS_PHRASES[phraseIdx], { live: true });
  }, 4200);
}

function stopStatusPhrases() {
  if (phraseTimer) clearInterval(phraseTimer);
  phraseTimer = null;
}

function appendLiveEvent({ title, detail = '', kind = 'step', done = false, meta = '' }) {
  const track = $('#agent-live-track');
  if (!track) return null;
  const row = document.createElement('article');
  row.className = `live-event kind-${kind}${done ? ' is-done' : ' is-running'}`;
  row.innerHTML = `
    <div class="live-event-rail" aria-hidden="true"><span class="live-event-node"></span></div>
    <div class="live-event-card">
      <div class="live-event-top">
        <span class="live-event-title">${escapeHtml(title)}</span>
        ${meta ? `<span class="live-event-meta">${escapeHtml(meta)}</span>` : ''}
      </div>
      ${detail ? `<pre class="live-event-detail">${escapeHtml(detail)}</pre>` : ''}
    </div>`;
  track.appendChild(row);
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return row;
}

function renderLiveFiles(verification) {
  const wrap = $('#agent-live-files');
  if (!wrap) return;
  const diff = verification?.diff || {};
  const files = [
    ...(diff.added || []).map((f) => ({ f, k: 'added' })),
    ...(diff.changed || []).map((f) => ({ f, k: 'changed' })),
    ...(diff.removed || []).map((f) => ({ f, k: 'removed' })),
  ].slice(0, 24);
  if (!files.length) {
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  wrap.innerHTML = `<div class="live-files-label">Files touched</div>` + files.map(({ f, k }) =>
    `<div class="live-file"><span class="live-file-tag ${k}">${k[0].toUpperCase()}</span><span>${escapeHtml(f)}</span></div>`
  ).join('');
}

function resetAgentLive() {
  showAgentLive();
  const track = $('#agent-live-track');
  if (track) track.innerHTML = '';
  const files = $('#agent-live-files');
  if (files) { files.classList.add('hidden'); files.innerHTML = ''; }
  startStatusPhrases();
  setLiveStatus('Starting…', { live: true });
}

// Back-compat shims used by older call sites
function showActionHistory() { showAgentLive(); }
function resetActionHistory() { resetAgentLive(); }
function setStatusPhrase(text, pulsing = true) { setLiveStatus(text || '', { live: Boolean(pulsing) }); }
function appendActionStep(label, { done = false, kind = 'step', detail = '' } = {}) {
  return appendLiveEvent({ title: label, detail, kind, done });
}
function appendActionStream(line) {
  // fold stream lines into compact live events only when meaningful
  if (!line || String(line).length < 2) return;
}
function renderActionFiles(v) { renderLiveFiles(v); }

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
    if (view === 'settings') loadSiteSettings();
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
  const canType = ready && !busy;
  const canSend = ready && !busy && Boolean(prompt?.value.trim());

  if (prompt) {
    prompt.disabled = !canType;
    prompt.placeholder = !ready
      ? 'Getting the coding engine ready…'
      : hasWs
        ? 'Tell Universal Modder what to change…'
        : 'Describe what you want to build…';
  }
  if (send) send.disabled = !canSend;
  if (attach) attach.disabled = !hasWs || busy;
  if (modelSel) modelSel.disabled = busy;
  const modeSel = $('#task-mode'); if (modeSel) modeSel.disabled = busy;
  const app = $('#app');
  if (app) app.classList.toggle('home-mode', !hasWs && !state.previewOpen);
  const projectTitle = $('#project-title');
  if (projectTitle) projectTitle.textContent = hasWs ? (state.workspaces.find((w) => w.id === state.workspaceId)?.name || 'Project') : 'Universal Modder';
  if (emptyTitle && emptyCopy && !hasWs) {
    emptyTitle.textContent = "What's on your mind?";
    emptyCopy.textContent = 'Describe the website or web app you want to create.';
  } else if (emptyTitle && emptyCopy && hasWs) {
    emptyTitle.textContent = 'What would you like to change?';
    emptyCopy.textContent = 'Ask Universal Modder to build, redesign, debug or improve this project.';
  }
  if (suggestions) {
    const hasMsgs = Boolean($('#messages')?.querySelectorAll('.msg')?.length);
    suggestions.classList.toggle('hidden', hasMsgs || !hasWs);
    suggestions.classList.toggle('disabled', !hasWs);
  }
  updateEmptyStateVisibility();
  // Compact stop control while busy
  const cancel = $('#cancel-btn');
  if (cancel) cancel.classList.toggle('hidden', !busy);
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
    li.innerHTML = `<span class="workspace-name">${escapeHtml(w.name || w.id)}</span><span class="workspace-subtitle">${w.files} files</span>`;
    li.addEventListener('click', () => selectWorkspace(w.id));
    ul.appendChild(li);
  }
  if (!state.workspaces.length) ul.innerHTML = '<li class="muted small">No workspaces yet</li>';
}

function openWorkspaceModal() {
  const modal = $('#workspace-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  $('#workspace-name-input').value = '';
  setTimeout(() => $('#workspace-name-input')?.focus(), 20);
}
function closeWorkspaceModal() { $('#workspace-modal')?.classList.add('hidden'); }
$('#new-workspace').addEventListener('click', openWorkspaceModal);
$('#workspace-cancel')?.addEventListener('click', closeWorkspaceModal);
$('#workspace-modal')?.addEventListener('click', (e) => { if (e.target.id === 'workspace-modal') closeWorkspaceModal(); });
$('#workspace-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#workspace-name-input').value.trim();
  if (!name) return;
  const btn = $('#workspace-form button[type="submit"]');
  btn.disabled = true;
  try {
    const res = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
    closeWorkspaceModal();
    await refreshWorkspaces();
    selectWorkspace(res.workspaceId);
    toast(`Workspace “${res.name || name}” created`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
  finally { btn.disabled = false; }
});

$('#new-task-btn')?.addEventListener('click', () => {
  $('#new-workspace')?.click();
});

async function selectWorkspace(id) {
  setShell('workspace');
  loadChatHistory(id);
  state.workspaceId = id;
  const wsPill = $('#ws-pill');
  const selectedMeta = state.workspaces.find((w) => w.id === id);
  if (wsPill) { wsPill.hidden = false; wsPill.textContent = selectedMeta?.name || id; }
  const title = $('#project-title'); if (title) title.textContent = selectedMeta?.name || 'Project';
  if (state.previewOpen) refreshPreview(false);
  refreshSnapshots().catch(() => {});

  const info = await api(`/api/workspaces/${id}`).catch(() => null);
  const dl = $('#ws-info');
  if (dl) {
    dl.innerHTML = '';
    const rows = [
      ['Workspace', info?.name || selectedMeta?.name || id],
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
    if (!res.supported) { $('#terminal').textContent = res.reason || 'This project type does not use a traditional build step (static HTML is preview-ready).'; toast('No build step for this project — use Preview', 'ok'); return; }
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

function addMessage(role, text, { html = false, skipSave = false } = {}) {
  const empty = $('#empty-state');
  if (empty) empty.classList.add('hidden');
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (html) bubble.innerHTML = text;
  else if (role === 'agent') bubble.innerHTML = renderMarkdown(text);
  else bubble.textContent = text;
  wrap.appendChild(bubble);
  if (role === 'user' || role === 'agent') {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'msg-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.title = 'Copy message';
    copyBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const plain = bubble.innerText || bubble.textContent || '';
      try {
        await navigator.clipboard.writeText(plain);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
      } catch {
        toast('Could not copy', 'err');
      }
    });
    actions.appendChild(copyBtn);
    wrap.appendChild(actions);
    bubble.addEventListener('click', (ev) => {
      // Tap bubble to reveal copy under the response
      if (ev.target.closest('a, button, .copy-code')) return;
      document.querySelectorAll('.msg.is-selected').forEach((m) => {
        if (m !== wrap) m.classList.remove('is-selected');
      });
      wrap.classList.toggle('is-selected');
    });
  }
  $('#messages').appendChild(wrap);
  const mbox = $('#messages');
  if (mbox) mbox.scrollTop = mbox.scrollHeight;
  if (!skipSave) saveChatHistory();
  updateEmptyStateVisibility();
  return bubble;
}

// Clear message selection when tapping outside a bubble
$('#messages').addEventListener('click', (e) => {
  if (!e.target.closest('.msg')) {
    document.querySelectorAll('.msg.is-selected').forEach((m) => m.classList.remove('is-selected'));
  }
});

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
  if (!state.openCodeReady) return toast('The coding engine is still starting — wait a few seconds', 'err');
  if (!state.workspaceId) {
    try {
      const created = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: prompt.slice(0, 48).replace(/\s+/g, ' ').trim() || 'New project' }) });
      await refreshWorkspaces();
      await selectWorkspace(created.workspaceId);
    } catch (err) { return toast(`Could not create project: ${err.message}`, 'err'); }
  }

  addMessage('user', prompt);
  $('#prompt').value = '';
  autoGrow();
  state.jobId = 'pending';
  /* cancel visibility via updateComposerState */
  updateComposerState();

  try {
    const composerMode = $('#task-mode')?.value || 'build';
    const model = state.modelRouting[composerMode] || $('#settings-model')?.value || $('#model-select').value || undefined;
    const mode = composerMode === 'plan' ? 'thorough' : 'fast';
    const modePrompt = composerMode === 'plan'
      ? `PLAN MODE: Analyze the request and project. Do not create, edit, or delete files. Return a clear implementation plan, files to change, and verification steps.\n\nUser request: ${prompt}`
      : `BUILD MODE: Implement the requested changes in the project, then run appropriate checks and report what was verified.\n\nUser request: ${prompt}`;
    const { jobId } = await api('/api/agent/tasks', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: state.workspaceId, prompt: modePrompt, model, mode }),
    });
    state.jobId = jobId;
    resetActionHistory();
    setStatusPhrase('Discovering the request…', true);
    streamJob(jobId);
  } catch (err) {
    addMessage('tool', `Error: ${err.message}`);
    state.jobId = null;
    /* cancel visibility via updateComposerState */
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
  const toolRows = new Map();
  resetAgentActivity();
  resetAgentLive();
  appendLiveEvent({ title: 'Agent session opened', kind: 'step', done: true });

  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }

    if (ev.type === 'session') {
      setAgentStatus(`Session ${ev.sessionId || ''}`.trim());
      appendAgentLog(`session ${ev.sessionId || ''}`);
      appendLiveEvent({ title: 'Connected to coding engine', kind: 'step', done: true, meta: 'session' });
      setLiveStatus('Connected', { live: true });
    } else if (ev.type === 'task_list') {
      renderTaskList(ev.items || [], ev.mode);
      for (const item of ev.items || []) {
        appendLiveEvent({ title: String(item), kind: 'step' });
      }
      setLiveStatus(ev.mode === 'plan' ? 'Planning…' : 'Working…', { live: true });
    } else if (ev.type === 'status') {
      setAgentStatus(ev.message || ev.phase || 'Working…');
      appendAgentLog(ev.message || ev.phase || 'status');
      if (ev.phase === 'inventory' && Array.isArray(ev.sample) && ev.sample.length) {
        appendLiveEvent({
          title: ev.message || 'Workspace inventory',
          kind: 'file',
          done: true,
          detail: ev.sample.join('\n'),
        });
      } else if (ev.phase === 'error') {
        appendLiveEvent({ title: ev.message || 'Error', kind: 'error', done: true });
      } else {
        appendLiveEvent({ title: ev.message || ev.phase || 'Status', kind: 'step', done: true, meta: ev.phase || '' });
      }
      if (ev.phase === 'snapshot') setLiveStatus('Saving recovery point…', { live: true });
      else if (ev.phase === 'inspect') setLiveStatus('Inspecting workspace…', { live: true });
      else if (ev.phase === 'plan') setLiveStatus('Planning…', { live: true });
      else if (ev.phase === 'build') setLiveStatus('Building…', { live: true });
      else if (ev.phase === 'repair') setLiveStatus('Repairing…', { live: true });
      else if (ev.message) setLiveStatus(ev.message, { live: true });
    } else if (ev.type === 'tool') {
      const name = ev.tool || 'tool';
      const label = ev.path ? `${name} · ${ev.path}` : name;
      const key = name + (ev.path || '');
      let row = toolRows.get(key);
      const detail = [ev.input, ev.output].filter(Boolean).join('\n---\n').slice(0, 1200);
      if (!row) {
        row = appendLiveEvent({
          title: label,
          kind: 'tool',
          detail,
          done: ev.state === 'completed' || ev.state === 'done',
          meta: 'tool',
        });
        toolRows.set(key, row);
      } else {
        row.classList.toggle('is-done', ev.state === 'completed' || ev.state === 'done');
        row.classList.toggle('is-running', !(ev.state === 'completed' || ev.state === 'done'));
        const d = row.querySelector('.live-event-detail');
        if (detail) {
          if (d) d.textContent = detail;
          else {
            const pre = document.createElement('pre');
            pre.className = 'live-event-detail';
            pre.textContent = detail;
            row.querySelector('.live-event-card')?.appendChild(pre);
          }
        }
      }
      setLiveStatus(`Running ${name}…`, { live: true });
      appendAgentLog(`tool ${name}`);
    } else if (ev.type === 'verification') {
      renderVerification(ev.verification, ev.repairRound);
      renderLiveFiles(ev.verification);
      const ok = ev.verification?.successCriteria?.ok;
      const reason = ev.verification?.successCriteria?.reason || (ok ? 'Verified' : 'Needs attention');
      appendLiveEvent({
        title: ok ? 'Verification passed' : 'Verification',
        kind: ok ? 'verify' : 'error',
        done: true,
        detail: reason,
      });
      if (ev.verification?.diff?.totalTouched === 0 && (ev.verification?.mode || 'build') !== 'plan') {
        toast('No files were changed in the workspace', 'err');
      }
      setLiveStatus(reason, { live: !ok });
    } else if (ev.type === 'part') {
      const role = ev.role || 'assistant';
      if (role === 'user' || role === 'system') return;
      const part = ev.part || {};
      if (part.type === 'text' && part.text) {
        if (!agentBody) agentBody = addMessage('agent', '');
        agentRaw += part.text;
        agentBody.innerHTML = renderMarkdown(agentRaw);
        const mbox = $('#messages');
        if (mbox) mbox.scrollTop = mbox.scrollHeight;
        saveChatHistory();
      } else if (part.type === 'tool' || part.tool) {
        const label = part.tool || part.name || 'tool';
        appendLiveEvent({ title: label, kind: 'tool' });
        setLiveStatus(`Running ${label}…`, { live: true });
      } else if (part.type === 'reasoning' && part.text) {
        appendLiveEvent({ title: 'Thinking', kind: 'think', detail: part.text.slice(0, 600) });
      } else if (part.type && part.type !== 'text') {
        appendLiveEvent({ title: part.type + (part.path ? ` · ${part.path}` : ''), kind: 'step' });
      }
    } else if (ev.type === 'done') {
      const ok = ev.status === 'completed';
      stopStatusPhrases();
      setLiveStatus(ok ? 'Completed' : `Failed — ${ev.error || ev.status}`, { live: false });
      document.querySelectorAll('#agent-live-track .live-event.is-running').forEach((n) => {
        n.classList.remove('is-running');
        n.classList.add('is-done');
      });
      appendLiveEvent({
        title: ok ? 'Task completed' : `Task ${ev.status}`,
        kind: ok ? 'verify' : 'error',
        done: true,
        detail: ev.error || '',
      });
      addMessage('tool', ok ? '✅ Task completed' : `❌ Task ${ev.status}${ev.error ? `: ${ev.error}` : ''}`);
      setAgentStatus(ok ? 'Completed' : `Failed: ${ev.error || ev.status}`);
      es.close();
      state.stream = null;
      state.jobId = null;
      updateComposerState();
      if (state.workspaceId) {
        refreshFiles().catch(() => {});
        refreshWorkspaces().catch(() => {});
        if (state.previewOpen) refreshPreview(false);
      }
      if (!ok) toast(ev.error || 'Task did not complete successfully', 'err');
      hideAgentLiveIdle();
    }
  };

  es.onerror = () => {
    stopStatusPhrases();
    setLiveStatus('Stream disconnected', { live: false });
    appendLiveEvent({ title: 'Stream disconnected', kind: 'error', done: true });
    addMessage('tool', '⚠️ Stream disconnected');
    setAgentStatus('Stream disconnected');
    es.close();
    state.stream = null;
    state.jobId = null;
    updateComposerState();
  };
}

function resetAgentActivity() {
  const list = $('#agent-task-list');
  if (list) list.innerHTML = '';
  setAgentStatus('Running…');
  const ver = $('#agent-verification');
  if (ver) { ver.textContent = ''; ver.classList.add('hidden'); }
  const log = $('#agent-log');
  if (log) log.innerHTML = '';
}

function renderTaskList(items, mode) {
  const list = $('#agent-task-list');
  if (!list) return;
  list.innerHTML = '';
  if (mode) {
    const li = document.createElement('li');
    li.className = 'task-mode';
    li.textContent = `Mode: ${mode}`;
    list.appendChild(li);
  }
  for (const item of items || []) {
    const li = document.createElement('li');
    li.textContent = item;
    list.appendChild(li);
  }
}

function setAgentStatus(text) {
  const el = $('#agent-status-line');
  if (el) el.textContent = text || 'Idle';
}

function appendAgentLog(line) {
  const log = $('#agent-log');
  if (!log) return;
  const row = document.createElement('div');
  row.className = 'agent-log-line';
  const ts = new Date().toLocaleTimeString();
  row.textContent = `${ts} · ${line}`;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function renderVerification(verification, repairRound) {
  const box = $('#agent-verification');
  if (!box || !verification) return;
  const diff = verification.diff || {};
  const lines = [];
  if (repairRound) lines.push(`Repair round ${repairRound}`);
  lines.push(`Files touched: ${diff.totalTouched ?? 0}`);
  if (diff.changed?.length) lines.push(`Changed: ${diff.changed.slice(0, 12).join(', ')}`);
  if (diff.added?.length) lines.push(`Added: ${diff.added.slice(0, 12).join(', ')}`);
  if (diff.removed?.length) lines.push(`Removed: ${diff.removed.slice(0, 12).join(', ')}`);
  for (const a of verification.actions || []) {
    lines.push(`${a.action}: ${a.ok ? 'ok' : 'failed'}${a.isolation ? ` (${a.isolation})` : ''}`);
  }
  if (verification.successCriteria?.reason) lines.push(verification.successCriteria.reason);
  box.textContent = lines.join('\n');
  box.classList.remove('hidden');
  box.classList.toggle('ok', Boolean(verification.successCriteria?.ok));
  box.classList.toggle('bad', verification.successCriteria && !verification.successCriteria.ok);

  const ul = $('#changed-list');
  if (ul) {
    ul.innerHTML = '';
    const entries = [
      ...(diff.changed || []).map((f) => ({ f, k: 'M' })),
      ...(diff.added || []).map((f) => ({ f, k: 'A' })),
      ...(diff.removed || []).map((f) => ({ f, k: 'D' })),
    ].slice(0, 40);
    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No file changes detected';
      ul.appendChild(li);
    } else {
      for (const { f, k } of entries) {
        const li = document.createElement('li');
        li.textContent = `${k} ${f}`;
        ul.appendChild(li);
      }
    }
  }
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

/* ---------------- Project preview ---------------- */
function openPreview() {
  if (!state.workspaceId) return toast('Create a project first to open its preview', 'err');
  state.previewOpen = true;
  $('#preview-view')?.classList.remove('hidden');
  updateComposerState();
  refreshPreview(false);
}
function closePreview() {
  state.previewOpen = false;
  $('#preview-view')?.classList.add('hidden');
  updateComposerState();
}
async function refreshPreview(showToast = true) {
  if (!state.workspaceId) return;
  const frame = $('#preview-frame');
  const empty = $('#preview-empty');
  const status = $('#preview-status');
  const url = `/api/workspaces/${encodeURIComponent(state.workspaceId)}/preview/`;
  if (status) status.textContent = 'Loading project files…';
  try {
    const res = await fetch(url, { credentials: 'same-origin', headers: { 'X-CloudCoder-CSRF': '1' } });
    if (!res.ok) {
      const info = await res.json().catch(() => ({}));
      throw new Error(info.error || `Preview returned HTTP ${res.status}`);
    }
    if (frame) { frame.hidden = false; frame.src = `${url}?t=${Date.now()}`; }
    if (empty) empty.hidden = true;
    if (status) status.textContent = 'Project preview';
  } catch (err) {
    if (frame) frame.hidden = true;
    if (empty) { empty.hidden = false; empty.innerHTML = `<div class="preview-empty-icon">↗</div><h3>Preview isn't ready yet</h3><p>${escapeHtml(err.message)}. Try Build & preview after creating the app.</p>`; }
    if (status) status.textContent = 'Not ready';
    if (showToast) toast(err.message, 'err');
  }
}
$('#preview-toggle')?.addEventListener('click', () => state.previewOpen ? closePreview() : openPreview());
$('#preview-close')?.addEventListener('click', closePreview);
$('#preview-reload')?.addEventListener('click', () => refreshPreview(true));
$('#preview-build')?.addEventListener('click', async () => {
  if (!state.workspaceId) return toast('Create a project first', 'err');
  const btn = $('#preview-build'); btn.disabled = true; btn.textContent = 'Building…';
  const status = $('#preview-status'); if (status) status.textContent = 'Running build…';
  try {
    const result = await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/build-repair`, { method: 'POST', body: '{}' });
    if (!result.supported) { toast(result.reason || 'No build step for this project — open Preview instead', 'ok'); return; }
    if (!result.ok) throw new Error((result.results || []).map((r) => r.stderr || r.stdout || `Exit code ${r.code}`).join('\n').slice(0, 700) || 'Build failed');
    toast('Build completed. Loading preview…', 'ok');
    await refreshPreview(true);
  } catch (err) {
    if (status) status.textContent = 'Build failed';
    toast(`Build failed: ${err.message}`, 'err');
  } finally { btn.disabled = false; btn.textContent = 'Build & preview'; }
});

/* ---------------- Phase 4 visual editor ---------------- */
let visualSelection = null;
let visualEditEnabled = false;
const visualFrame = () => $('#preview-frame');
function setVisualMode(enabled) {
  visualEditEnabled = Boolean(enabled);
  const toggle = $('#visual-edit-toggle');
  if (toggle) { toggle.setAttribute('aria-pressed', String(visualEditEnabled)); toggle.textContent = visualEditEnabled ? 'Exit visual edit' : 'Visual edit'; }
  const frame = visualFrame(); if (frame) frame.classList.toggle('visual-selecting', visualEditEnabled);
  try { frame?.contentWindow?.postMessage({ type: 'um-visual-mode', enabled: visualEditEnabled }, '*'); } catch {}
  const status = $('#visual-editor-status'); if (status) status.textContent = visualEditEnabled ? 'Tap an element in the preview to select it.' : 'Visual edit is off.';
}
$('#visual-edit-toggle')?.addEventListener('click', () => {
  if (!state.workspaceId) return toast('Select a workspace first', 'err');
  $('#visual-editor')?.classList.toggle('hidden'); setVisualMode(!visualEditEnabled);
});
$('#visual-editor-close')?.addEventListener('click', () => { $('#visual-editor')?.classList.add('hidden'); setVisualMode(false); });
visualFrame()?.addEventListener('load', () => { if (visualEditEnabled) setVisualMode(true); });
window.addEventListener('message', (event) => {
  const frame = visualFrame();
  if (!frame || event.source !== frame.contentWindow || !event.data || event.data.type !== 'um-visual-select') return;
  const d = event.data;
  if (typeof d.selector !== 'string' || d.selector.length > 500 || !/^[a-zA-Z0-9_#.: >+\-\[\]="']+$/.test(d.selector)) return;
  visualSelection = { selector: d.selector, tag: String(d.tag || '').slice(0,30) };
  $('#visual-selector').value = d.selector;
  const toHex = (value, fallback) => { const m = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i); return m ? '#' + m.slice(1,4).map(x => Number(x).toString(16).padStart(2,'0')).join('') : fallback; };
  $('#visual-color').value = toHex(d.color, '#222222'); $('#visual-background').value = toHex(d.background, '#ffffff');
  $('#visual-font-size').value = Math.round(Number(d.fontSize) || 16); $('#visual-padding').value = Math.round(Number(d.padding) || 0); $('#visual-radius').value = Math.round(Number(d.radius) || 0);
  $('#visual-save').disabled = false; $('#visual-editor-status').textContent = `Selected <${visualSelection.tag}>. Adjust values and apply.`;
});
$('#visual-reset')?.addEventListener('click', () => { visualSelection = null; $('#visual-selector').value = ''; $('#visual-save').disabled = true; $('#visual-editor-status').textContent = 'Selection cleared.'; });
$('#visual-save')?.addEventListener('click', async () => {
  if (!state.workspaceId || !visualSelection) return toast('Select an element first', 'err');
  const selector = visualSelection.selector;
  const declarations = [];
  const color = $('#visual-color').value; const background = $('#visual-background').value;
  const textValue = ($('#visual-text')?.value || '').trim();
  const font = Number($('#visual-font-size').value); const padding = Number($('#visual-padding').value); const radius = Number($('#visual-radius').value);
  if (/^#[0-9a-f]{6}$/i.test(color)) declarations.push(`color: ${color} !important`);
  if (/^#[0-9a-f]{6}$/i.test(background)) declarations.push(`background-color: ${background} !important`);
  if (Number.isFinite(font) && font >= 8 && font <= 96) declarations.push(`font-size: ${font}px !important`);
  if (Number.isFinite(padding) && padding >= 0 && padding <= 160) declarations.push(`padding: ${padding}px !important`);
  if (Number.isFinite(radius) && radius >= 0 && radius <= 100) declarations.push(`border-radius: ${radius}px !important`);
  if (!declarations.length && !textValue) return toast('Enter a style value or text content', 'err');
  const btn = $('#visual-save'); btn.disabled = true;
  try {
    const path = '.universal-modder-visual.css';
    let existing = '';
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/file?path=${encodeURIComponent(path)}`, { credentials: 'same-origin', headers: { 'X-CloudCoder-CSRF': '1' } });
      if (res.ok) existing = await res.text();
    } catch {}
    const safeSelector = selector.replace(/\s+/g, ' ').trim();
    if (declarations.length) {
      const block = `\n/* Universal Modder visual edit: ${new Date().toISOString()} */\n${safeSelector} { ${declarations.join('; ')}; }\n`;
      const escaped = safeSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rule = new RegExp(`(?:^|\\n)${escaped}\\s*\\{[^}]*\\}\\s*`, 'g');
      const content = (existing.replace(rule, '\n') + block).slice(-100000);
      await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/file`, { method: 'PUT', body: JSON.stringify({ path, content }) });
    }
    if (textValue) {
      const mapPath = '.universal-modder-visual-text.json';
      let map = {};
      try {
        const res = await fetch(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/file?path=${encodeURIComponent(mapPath)}`, { credentials: 'same-origin', headers: { 'X-CloudCoder-CSRF': '1' } });
        if (res.ok) map = JSON.parse(await res.text() || '{}');
      } catch { map = {}; }
      if (typeof map !== 'object' || !map) map = {};
      map[safeSelector] = textValue.slice(0, 500);
      await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/file`, {
        method: 'PUT',
        body: JSON.stringify({ path: mapPath, content: JSON.stringify(map, null, 2) }),
      });
      // Best-effort: push text into live iframe selection without claiming full source mapping for frameworks.
      try {
        const frame = $('#preview-frame');
        frame?.contentWindow?.postMessage({ type: 'um-visual-set-text', selector: safeSelector, text: textValue }, '*');
      } catch {}
    }
    await refreshPreview(false);
    $('#visual-editor-status').textContent = textValue
      ? 'Saved CSS/text overrides to project files and refreshed preview.'
      : 'Saved to .universal-modder-visual.css and refreshed preview.';
    toast('Visual changes saved to project files', 'ok');
  } catch (err) {
    $('#visual-editor-status').textContent = err.message;
    toast(`Could not save visual edit: ${err.message}`, 'err');
  } finally {
    btn.disabled = !visualSelection;
  }
});

/* ---------------- Site-managed settings ---------------- */
async function loadSiteSettings() {
  try {
    const data = await api('/api/settings');
    const p = data.provider || {};
    $('#provider-base-url').value = p.baseURL || '';
    $('#provider-id').value = p.providerId || 'china-gpt';
    $('#provider-name').value = p.providerName || 'China-GPT';
    $('#provider-model').value = p.model || '';
    $('#provider-model-name').value = p.modelName || '';
    $('#provider-api-key').value = '';
    $('#provider-api-key').placeholder = p.hasApiKey ? 'Saved API key is configured — leave blank to keep it' : 'Paste your API key';
    state.modelRouting = { build: '', plan: '', image: '', video: '', audio: '', ...(data.modelRouting || {}) };
    for (const key of ['build', 'plan', 'image', 'video', 'audio']) {
      const field = $(`#routing-${key}`); if (field) field.value = state.modelRouting[key] || '';
    }
    $('#account-username').value = data.account?.username || '';
    const ghStatus = $('#github-token-status');
    if (ghStatus) { ghStatus.textContent = data.integrations?.hasGithubToken ? 'Token configured' : 'Not configured'; ghStatus.classList.toggle('ready', Boolean(data.integrations?.hasGithubToken)); }
    $('#github-token').value = '';
    $('#github-token').placeholder = data.integrations?.hasGithubToken ? 'Token saved — leave blank to keep it' : 'Paste a GitHub personal access token';
    const tgStatus = $('#telegram-status');
    if (tgStatus) {
      tgStatus.textContent = data.integrations?.hasTelegramToken ? 'Bot token configured' : 'Not configured';
      tgStatus.classList.toggle('ready', Boolean(data.integrations?.hasTelegramToken));
    }
    if ($('#telegram-allowed-ids')) $('#telegram-allowed-ids').value = data.integrations?.telegramAllowedUserIds || '';
    if ($('#telegram-token')) {
      $('#telegram-token').value = '';
      $('#telegram-token').placeholder = data.integrations?.hasTelegramToken ? 'Token saved — leave blank to keep it' : 'Paste Telegram bot token';
    }
    const status = $('#provider-status');
    if (status) { status.textContent = p.hasApiKey ? `${p.models?.length || 0} models · key set` : 'API key not set'; status.classList.toggle('ready', Boolean(p.hasApiKey)); }
    const dl = $('#provider-model-options');
    if (dl) dl.innerHTML = (p.models || []).map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name || m.id)}</option>`).join('');
  } catch (err) { toast(`Could not load settings: ${err.message}`, 'err'); }
}

$('#model-routing-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#model-routing-form button[type="submit"]'); btn.disabled = true;
  try {
    const modelRouting = {};
    for (const key of ['build', 'plan', 'image', 'video', 'audio']) modelRouting[key] = $(`#routing-${key}`).value.trim();
    const result = await api('/api/settings/model-routing', { method: 'POST', body: JSON.stringify(modelRouting) });
    state.modelRouting = result.modelRouting || modelRouting;
    toast(result.message || 'Model routing saved', 'ok');
  } catch (err) { toast(err.message, 'err'); }
  finally { btn.disabled = false; }
});

$('#provider-settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#save-provider-settings');
  btn.disabled = true; btn.textContent = 'Saving & restarting…';
  try {
    const result = await api('/api/settings/provider', { method: 'POST', body: JSON.stringify({
      baseURL: $('#provider-base-url').value.trim(), providerId: $('#provider-id').value.trim(),
      providerName: $('#provider-name').value.trim(), apiKey: $('#provider-api-key').value,
      model: $('#provider-model').value.trim(), modelName: $('#provider-model-name').value.trim(),
    }) });
    $('#provider-api-key').value = '';
    toast(result.message || 'Provider updated', 'ok');
    await loadModels(); await loadSiteSettings();
  } catch (err) { toast(err.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Save provider & restart'; }
});

$('#refresh-provider-models')?.addEventListener('click', async () => {
  const btn = $('#refresh-provider-models'); btn.disabled = true; btn.textContent = 'Refreshing…';
  try {
    const data = await api('/api/models?refresh=1');
    const dl = $('#provider-model-options');
    if (dl) dl.innerHTML = (data.models || []).map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name || m.id)}</option>`).join('');
    toast(`Found ${(data.models || []).length} model(s)`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Refresh models'; }
});

$('#github-settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#github-settings-form button[type="submit"]'); btn.disabled = true;
  try {
    const result = await api('/api/settings/integrations', { method: 'POST', body: JSON.stringify({ githubToken: $('#github-token').value }) });
    $('#github-token').value = '';
    toast(result.message || 'GitHub settings saved', 'ok');
    await loadSiteSettings(); await refreshRepos();
  } catch (err) { toast(err.message, 'err'); }
  finally { btn.disabled = false; }
});

$('#account-settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#account-settings-form button[type="submit"]'); btn.disabled = true;
  try {
    const result = await api('/api/settings/account', { method: 'POST', body: JSON.stringify({ username: $('#account-username').value.trim(), password: $('#account-password').value, useEnvPassword: $('#account-use-env-password').checked }) });
    $('#account-password').value = '';
    $('#account-use-env-password').checked = false;
    toast(result.message || 'Login settings saved', 'ok');
  } catch (err) { toast(err.message, 'err'); }
  finally { btn.disabled = false; }
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
$('#task-mode')?.addEventListener('change', () => { const label = $('#send-btn .send-label'); if (label) label.textContent = $('#task-mode').value === 'plan' ? 'Plan' : 'Build'; });

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

/* ---------------- Version history (snapshots) ---------------- */
async function refreshSnapshots() {
  const ul = $('#snapshot-list');
  if (!ul || !state.workspaceId) return;
  ul.innerHTML = '<li class="muted">Loading…</li>';
  try {
    const res = await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/snapshots`);
    const snaps = res.snapshots || res || [];
    ul.innerHTML = '';
    if (!snaps.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No snapshots yet';
      ul.appendChild(li);
      return;
    }
    for (const s of snaps.slice(0, 20)) {
      const li = document.createElement('li');
      li.className = 'snapshot-item';
      const label = s.label || s.id;
      const when = s.createdAt ? new Date(s.createdAt).toLocaleString() : '';
      li.innerHTML = `<div class="snapshot-meta"><strong>${escapeHtml(String(label).slice(0, 48))}</strong><span class="muted small">${escapeHtml(when)} · ${s.files || 0} files</span></div>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ghost-btn';
      btn.textContent = 'Restore';
      btn.addEventListener('click', async () => {
        if (!confirm('Restore this snapshot? Current unsnapshotted changes will be overwritten.')) return;
        btn.disabled = true;
        try {
          await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/snapshots/${encodeURIComponent(s.id)}/restore`, {
            method: 'POST',
            body: JSON.stringify({ confirm: true }),
          });
          toast('Snapshot restored', 'ok');
          await refreshFiles().catch(() => {});
          if (state.previewOpen) await refreshPreview(false);
          await refreshSnapshots();
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          btn.disabled = false;
        }
      });
      li.appendChild(btn);
      ul.appendChild(li);
    }
  } catch (err) {
    ul.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = err.message || 'Failed to load snapshots';
    ul.appendChild(li);
  }
}

$('#btn-snapshot')?.addEventListener('click', async () => {
  if (!state.workspaceId) return toast('Select a workspace first', 'err');
  const label = prompt('Snapshot label (optional)') || '';
  try {
    await api(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/snapshots`, {
      method: 'POST',
      body: JSON.stringify({ label }),
    });
    toast('Snapshot created', 'ok');
    await refreshSnapshots();
  } catch (err) {
    toast(err.message, 'err');
  }
});


$('#telegram-settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#telegram-settings-form button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    const result = await api('/api/settings/integrations', {
      method: 'POST',
      body: JSON.stringify({
        telegramToken: $('#telegram-token')?.value || '',
        clearTelegramToken: Boolean($('#telegram-clear-token')?.checked),
        telegramAllowedUserIds: $('#telegram-allowed-ids')?.value || '',
      }),
    });
    if ($('#telegram-token')) $('#telegram-token').value = '';
    if ($('#telegram-clear-token')) $('#telegram-clear-token').checked = false;
    toast(result.message || 'Telegram settings saved', 'ok');
    await loadSiteSettings();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
});