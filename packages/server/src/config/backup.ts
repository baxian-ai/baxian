import { readdir, copyFile, unlink, stat } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { MAX_CONFIG_BACKUPS } from '../shared/index.js';

export async function backupConfig(configPath: string): Promise<string | null> {
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

  const backupPath = `${configPath}.${timestamp}`;
  await copyFile(configPath, backupPath);
  await cleanupOldBackups(configPath);

  return backupPath;
}

const BACKUP_PATTERN = /\.\d{8}-\d{6}$/;

export async function cleanupOldBackups(configPath: string): Promise<void> {
  const dir = dirname(configPath);
  const base = basename(configPath);
  const files = await readdir(dir);

  const backups = files
    .filter(f => f.startsWith(`${base}.`) && BACKUP_PATTERN.test(f))
    .sort()
    .reverse();

  for (const old of backups.slice(MAX_CONFIG_BACKUPS)) {
    try {
      await unlink(join(dir, old));
    } catch (err) {
      console.warn(`[backup] failed to remove old backup ${old}:`, err);
    }
  }
}
