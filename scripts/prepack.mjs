#!/usr/bin/env node
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const SERVER_DIST = resolve(REPO_ROOT, 'packages/server/dist');
const WEB_DIST = resolve(REPO_ROOT, 'packages/web/dist');
const SKILLS_SRC = resolve(REPO_ROOT, 'skills');

const OUT_DIST = resolve(REPO_ROOT, 'dist');
const OUT_WEB = resolve(OUT_DIST, 'web');
const OUT_SKILLS = resolve(OUT_DIST, 'skills');

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function assertExists(path, hint) {
  if (!(await exists(path))) {
    console.error(`prepack: ${path} not found. ${hint}`);
    process.exit(1);
  }
}

await assertExists(SERVER_DIST, 'Run `pnpm -r build` first.');
await assertExists(WEB_DIST, 'Run `pnpm -r build` first.');
await assertExists(SKILLS_SRC, 'Repo skills/ directory missing.');

console.log(`prepack: cleaning ${OUT_DIST}`);
await rm(OUT_DIST, { recursive: true, force: true });
await mkdir(OUT_DIST, { recursive: true });

console.log(`prepack: copying ${SERVER_DIST} → ${OUT_DIST}`);
await cp(SERVER_DIST, OUT_DIST, { recursive: true });

console.log(`prepack: copying ${WEB_DIST} → ${OUT_WEB}`);
await cp(WEB_DIST, OUT_WEB, { recursive: true });

console.log(`prepack: copying ${SKILLS_SRC} → ${OUT_SKILLS}`);
await cp(SKILLS_SRC, OUT_SKILLS, { recursive: true });

console.log('prepack: done');
