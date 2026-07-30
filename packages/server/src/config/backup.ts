import { constants as fsConstants, copyFile, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { MAX_CONFIG_BACKUPS } from '../shared/index.js';
import { assertInsideManagedDir } from '../state/managed-path.js';

const BACKUP_TIMESTAMP_PATTERN = /^\d{4}(?:-\d{2}){5}-\d{3}$/;

export async function backupConfig(configPath: string): Promise<string | null> {
  const now = new Date();
  const timestamp = [
    String(now.getFullYear()).padStart(4, '0'),
    '-',
    String(now.getMonth() + 1).padStart(2, '0'),
    '-',
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    '-',
    String(now.getMinutes()).padStart(2, '0'),
    '-',
    String(now.getSeconds()).padStart(2, '0'),
    '-',
    String(now.getMilliseconds()).padStart(3, '0'),
  ].join('');

  const dir = dirname(configPath);
  const backupPath = join(dir, `${basename(configPath)}.${timestamp}`);
  try {
    await copyFile(configPath, backupPath, fsConstants.COPYFILE_EXCL);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'EEXIST') return null;
    throw err;
  }
  await cleanupOldBackups(configPath);
  return backupPath;
}

async function cleanupOldBackups(configPath: string): Promise<void> {
  const dir = dirname(configPath);
  const prefix = `${basename(configPath)}.`;
  const backups = (await readdir(dir))
    .filter(name => name.startsWith(prefix) && BACKUP_TIMESTAMP_PATTERN.test(name.slice(prefix.length)))
    .sort()
    .reverse();

  for (const old of backups.slice(MAX_CONFIG_BACKUPS)) {
    try {
      await unlink(assertInsideManagedDir(dir, join(dir, old)));
    } catch (err) {
      console.warn(`[backup] failed to remove old backup ${old}:`, err);
    }
  }
}
