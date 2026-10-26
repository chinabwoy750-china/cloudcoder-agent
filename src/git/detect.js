import fs from 'node:fs/promises';
import path from 'node:path';

export async function detectProjectType(dir) {
  const exists = async (p) => fs.access(path.join(dir, p)).then(() => true, () => false);

  if (await exists('package.json')) {
    let type = 'node';
    if (await exists('next.config.js') || await exists('next.config.mjs') || await exists('next.config.ts')) type = 'node-next';
    else if (await exists('vite.config.js') || await exists('vite.config.ts')) type = 'node-vite';
    else if (await exists('nuxt.config.ts') || await exists('nuxt.config.js')) type = 'node-nuxt';
    let pm = 'npm';
    if (await exists('pnpm-lock.yaml')) pm = 'pnpm';
    else if (await exists('yarn.lock')) pm = 'yarn';
    return { type, packageManager: pm, signals: ['package.json'] };
  }
  if (await exists('pyproject.toml') || await exists('requirements.txt') || await exists('setup.py')) {
    let pm = 'pip';
    if (await exists('poetry.lock')) pm = 'poetry';
    else if (await exists('Pipfile')) pm = 'pipenv';
    return { type: 'python', packageManager: pm, signals: ['python'] };
  }
  if (await exists('go.mod')) return { type: 'go', packageManager: 'go', signals: ['go.mod'] };
  if (await exists('Cargo.toml')) return { type: 'rust', packageManager: 'cargo', signals: ['Cargo.toml'] };
  if (await exists('pom.xml')) return { type: 'java-maven', packageManager: 'maven', signals: ['pom.xml'] };
  if (await exists('build.gradle') || await exists('build.gradle.kts')) return { type: 'java-gradle', packageManager: 'gradle', signals: ['build.gradle'] };
  if (await exists('composer.json')) return { type: 'php', packageManager: 'composer', signals: ['composer.json'] };
  if (await exists('index.html')) return { type: 'static', packageManager: null, signals: ['index.html'] };

  return { type: 'unknown', packageManager: null, signals: [] };
}
