import fs from 'node:fs/promises';
import path from 'node:path';
import { detectProjectType } from '../git/detect.js';
import { runProjectAction } from '../workspace/run.js';
import { logger } from '../utils/logger.js';

/**
 * Snapshot a lightweight view of the workspace for change detection.
 */
export async function snapshotWorkspaceFingerprint(directory, { maxFiles = 400 } = {}) {
  const files = [];
  async function walk(dir, rel = '') {
    if (files.length >= maxFiles) return;
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= maxFiles) break;
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.cloudcoder' || e.name === 'dist' || e.name === 'build') continue;
      const nextRel = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, nextRel);
      else if (e.isFile()) {
        try {
          const st = await fs.stat(full);
          files.push({ path: nextRel, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* ignore */ }
      }
    }
  }
  await walk(directory);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export function diffFingerprints(before, after) {
  const mapB = new Map(before.map((f) => [f.path, f]));
  const mapA = new Map(after.map((f) => [f.path, f]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [p, f] of mapA) {
    const prev = mapB.get(p);
    if (!prev) added.push(p);
    else if (prev.size !== f.size || prev.mtimeMs !== f.mtimeMs) changed.push(p);
  }
  for (const p of mapB.keys()) if (!mapA.has(p)) removed.push(p);
  return {
    added,
    removed,
    changed,
    totalTouched: added.length + removed.length + changed.length,
  };
}

/**
 * Post-agent verification: detect file changes and optionally run build/test.
 */
export async function verifyAgentOutcome(directory, beforeFingerprint, { runVerify = true, mode = 'build' } = {}) {
  const after = await snapshotWorkspaceFingerprint(directory);
  const diff = diffFingerprints(beforeFingerprint || [], after);
  const project = await detectProjectType(directory).catch(() => ({ type: 'static' }));
  const verification = {
    mode,
    projectType: project.type,
    filesChanged: diff.totalTouched > 0,
    diff: {
      added: diff.added.slice(0, 50),
      removed: diff.removed.slice(0, 50),
      changed: diff.changed.slice(0, 50),
      totalTouched: diff.totalTouched,
    },
    actions: [],
  };

  if (mode === 'plan') {
    verification.successCriteria = {
      ok: true,
      reason: 'Plan mode does not require file changes',
    };
    return verification;
  }

  if (!runVerify) {
    verification.successCriteria = {
      ok: diff.totalTouched > 0,
      reason: diff.totalTouched > 0 ? 'Files changed' : 'No file changes detected',
    };
    return verification;
  }

  // Static HTML/CSS sites have no npm build — treat file changes as success.
  const staticTypes = new Set(['static', 'unknown', 'html', '']);
  const isStatic = staticTypes.has(String(project?.type || 'static'));
  const hasIndex = after.some((f) => /^(index\.html|index\.htm)$/i.test(f.path) || /\/index\.html?$/i.test(f.path));

  if (!isStatic) {
    // Prefer test, then build when the project type supports them.
    for (const action of ['test', 'build']) {
      try {
        const result = await runProjectAction({ dir: directory, action, projectType: project.type });
        if (!result.supported) {
          // Do not record unsupported actions as failures (avoids "build not supported" noise).
          continue;
        }
        verification.actions.push({
          action,
          ok: result.ok,
          isolation: result.isolation,
          results: (result.results || []).map((r) => ({
            cmd: r.cmd,
            code: r.code,
            timedOut: r.timedOut,
            stderr: String(r.stderr || '').slice(0, 1500),
            stdout: String(r.stdout || '').slice(0, 800),
          })),
        });
        if (!result.ok) break;
      } catch (err) {
        logger.warn(`[verify] ${action} failed: ${err.message}`);
        verification.actions.push({ action, ok: false, error: err.message });
        break;
      }
    }
  } else {
    verification.actions.push({
      action: 'static-check',
      ok: diff.totalTouched > 0,
      note: hasIndex ? 'index.html present' : 'static files updated',
    });
  }

  const actionFail = verification.actions.some((a) => a.ok === false && a.action !== 'static-check');
  const actionPass = verification.actions.some((a) => a.ok === true);
  const filesOk = diff.totalTouched > 0;
  verification.successCriteria = {
    ok: filesOk && !actionFail,
    filesChanged: filesOk,
    verificationRan: verification.actions.length > 0,
    verificationPassed: isStatic ? filesOk : (actionPass && !actionFail),
    projectType: project?.type || 'static',
    reason: actionFail
      ? 'Verification command failed'
      : (!filesOk
        ? 'No file changes detected'
        : (isStatic
          ? (hasIndex ? 'Static site files written (preview ready)' : 'Static files written')
          : 'Changes applied')),
  };
  return verification;
}
