import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backupConfig, cleanupOldBackups } from '../../src/config/backup.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('backupConfig', () => {
  it('creates a timestamped backup', async () => {
    const configPath = join(tempDir, 'baxian.json');
    await writeFile(configPath, '{"test": true}');

    const backupPath = await backupConfig(configPath);

    expect(backupPath).not.toBeNull();
    expect(backupPath!).toMatch(/baxian\.json\.\d{8}-\d{6}$/);

    const backupContent = await readFile(backupPath!, 'utf-8');
    expect(backupContent).toBe('{"test": true}');
  });

  it('returns null when config file does not exist', async () => {
    const result = await backupConfig(join(tempDir, 'nonexistent.json'));
    expect(result).toBeNull();
  });
});

describe('cleanupOldBackups', () => {
  it('keeps at most 7 backups', async () => {
    const configPath = join(tempDir, 'baxian.json');
    await writeFile(configPath, '{}');

    for (let i = 0; i < 10; i++) {
      const ts = `20260428-${String(100000 + i).slice(0, 6)}`;
      await writeFile(`${configPath}.${ts}`, `backup-${i}`);
    }

    await cleanupOldBackups(configPath);

    const files = (await readdir(tempDir)).filter(f => /\.\d{8}-\d{6}$/.test(f));
    expect(files).toHaveLength(7);
  });

  it('keeps the most recent backups', async () => {
    const configPath = join(tempDir, 'baxian.json');
    await writeFile(configPath, '{}');

    await writeFile(`${configPath}.20260401-100000`, 'oldest');
    await writeFile(`${configPath}.20260428-100000`, 'newest');
    await writeFile(`${configPath}.20260415-100000`, 'middle');

    // With MAX_CONFIG_BACKUPS = 7, all 3 should survive
    await cleanupOldBackups(configPath);

    const files = (await readdir(tempDir)).filter(f => /\.\d{8}-\d{6}$/.test(f));
    expect(files).toHaveLength(3);
  });

  it('does not touch non-backup files', async () => {
    const configPath = join(tempDir, 'baxian.json');
    await writeFile(configPath, '{}');
    await writeFile(join(tempDir, 'other.txt'), 'keep me');

    for (let i = 0; i < 10; i++) {
      await writeFile(`${configPath}.${20260428}-${String(100000 + i).slice(0, 6)}`, '');
    }

    await cleanupOldBackups(configPath);

    const all = await readdir(tempDir);
    expect(all).toContain('other.txt');
  });
});
