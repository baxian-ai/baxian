import { copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, join } from 'node:path';
import { MAX_CONFIG_BACKUPS } from '../shared/index.js';
import { assertInsideManagedDir } from '../state/managed-path.js';

// Backups live under the state dir, not beside the config file, so rotation deletion always targets baxian-managed ground in both deployment shapes (project-local baxian.json and ~/.baxian/config.json).
export function configBackupDir(stateDir: string): string {
  return join(stateDir, 'config-backups');
}

export async function backupConfig(configPath: string, stateDir: string): Promise<string | null> {
  try {
    await stat(configPath);
  } catch {
    return null;
  }

  const now = new Date();
  const timestamp = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');

  const dir = configBackupDir(stateDir);
  await mkdir(dir, { recursive: true });
  // Exclusive create with monotonic suffixes: reusing a rotated-away name would make the newest backup sort as the oldest and be deleted by its own rotation.
  const stampedBase = `${basename(configPath)}.${timestamp}`;
  let n = await nextSuffix(dir, stampedBase);
  let backupPath = suffixedPath(dir, stampedBase, n);
  for (let attempts = 0; ; attempts++) {
    try {
      await copyFile(configPath, backupPath, fsConstants.COPYFILE_EXCL);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST' || attempts >= 50) throw err;
      n = Math.max(n + 1, await nextSuffix(dir, stampedBase));
      backupPath = suffixedPath(dir, stampedBase, n);
    }
  }
  await cleanupOldBackups(configPath, stateDir);

  return backupPath;
}

function suffixedPath(dir: string, stampedBase: string, n: number): string {
  return join(dir, n === 0 ? stampedBase : `${stampedBase}.${n}`);
}

async function nextSuffix(dir: string, stampedBase: string): Promise<number> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 0;
    throw err;
  }
  let next = 0;
  for (const f of files) {
    const taken = suffixOf(f, stampedBase);
    if (taken !== null && taken >= next) next = taken + 1;
  }
  return next;
}

function suffixOf(file: string, stampedBase: string): number | null {
  if (file === stampedBase) return 0;
  if (!file.startsWith(`${stampedBase}.`)) return null;
  const rest = file.slice(stampedBase.length + 1);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

const BACKUP_PATTERN = /\.(\d{8}-\d{6})(?:\.(\d+))?$/;

export async function cleanupOldBackups(configPath: string, stateDir: string): Promise<void> {
  const dir = configBackupDir(stateDir);
  const base = basename(configPath);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
    throw err;
  }

  const backups = files
    .flatMap((f) => {
      if (!f.startsWith(`${base}.`)) return [];
      const m = BACKUP_PATTERN.exec(f);
      return m ? [{ file: f, stamp: m[1], seq: m[2] === undefined ? 0 : Number(m[2]) }] : [];
    })
    .sort((a, b) => (a.stamp !== b.stamp ? b.stamp.localeCompare(a.stamp) : b.seq - a.seq));

  for (const old of backups.slice(MAX_CONFIG_BACKUPS)) {
    try {
      await unlink(assertInsideManagedDir(dir, join(dir, old.file)));
    } catch (err) {
      console.warn(`[backup] failed to remove old backup ${old.file}:`, err);
    }
  }
}
