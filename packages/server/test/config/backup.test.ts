import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backupConfig, cleanupOldBackups, configBackupDir } from '../../src/config/backup.js';

let tempDir: string;
let stateDir: string;
let backupDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-test-'));
  stateDir = join(tempDir, '.baxian');
  backupDir = configBackupDir(stateDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('backupConfig', () => {
  it('creates a timestamped backup under the state dir', async () => {
    const configPath = join(tempDir, 'baxian.json');
    await writeFile(configPath, '{"test": true}');

    const backupPath = await backupConfig(configPath, stateDir);

    expect(backupPath).not.toBeNull();
    expect(backupPath!.startsWith(backupDir)).toBe(true);
    expect(backupPath!).toMatch(/baxian\.json\.\d{8}-\d{6}$/);
    expect(await readFile(backupPath!, 'utf-8')).toBe('{"test": true}');
  });

  it('returns null when config file does not exist', async () => {
    const result = await backupConfig(join(tempDir, 'nonexistent.json'), stateDir);
    expect(result).toBeNull();
  });

  it('never follows or overwrites a pre-planted entry at the predictable backup name', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T10:00:00'));
    try {
      const configPath = join(tempDir, 'baxian.json');
      await writeFile(configPath, '{"secret":1}');
      await mkdir(backupDir, { recursive: true });
      const victim = join(tempDir, 'victim.txt');
      await writeFile(victim, 'precious');
      await symlink(victim, join(backupDir, 'baxian.json.20260428-100000'));

      const backupPath = await backupConfig(configPath, stateDir);

      expect(await readFile(victim, 'utf-8')).toBe('precious');
      expect(backupPath!.endsWith('baxian.json.20260428-100000.1')).toBe(true);
      expect(await readFile(backupPath!, 'utf-8')).toBe('{"secret":1}');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps every returned path live across 12 same-second saves and rotates by numeric suffix', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T10:00:00'));
    try {
      const configPath = join(tempDir, 'baxian.json');
      let lastPath = '';
      for (let i = 1; i <= 12; i++) {
        await writeFile(configPath, `v${i}`);
        const backupPath = await backupConfig(configPath, stateDir);
        expect(await readFile(backupPath!, 'utf-8')).toBe(`v${i}`);
        lastPath = backupPath!;
      }
      const survivors = (await readdir(backupDir)).sort();
      expect(survivors).toEqual(
        [5, 6, 7, 8, 9, 10, 11].map(n => `baxian.json.20260428-100000.${n}`).sort(),
      );
      expect(await readFile(lastPath, 'utf-8')).toBe('v12');
    } finally {
      vi.useRealTimers();
    }
  });

});

describe('cleanupOldBackups', () => {
  it('keeps at most 7 backups', async () => {
    const configPath = join(tempDir, 'baxian.json');
    await writeFile(configPath, '{}');
    await mkdir(backupDir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      const ts = `20260428-${String(100000 + i).slice(0, 6)}`;
      await writeFile(join(backupDir, `baxian.json.${ts}`), `backup-${i}`);
    }

    await cleanupOldBackups(configPath, stateDir);

    const files = (await readdir(backupDir)).filter(f => /\.\d{8}-\d{6}$/.test(f));
    expect(files).toHaveLength(7);
  });

  it('keeps recent backups and returns silently when the backup dir does not exist yet', async () => {
    const configPath = join(tempDir, 'baxian.json');
    await writeFile(configPath, '{}');
    await expect(cleanupOldBackups(configPath, stateDir)).resolves.toBeUndefined();

    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, 'baxian.json.20260401-100000'), 'oldest');
    await writeFile(join(backupDir, 'baxian.json.20260428-100000'), 'newest');
    await writeFile(join(backupDir, 'baxian.json.20260415-100000'), 'middle');

    await cleanupOldBackups(configPath, stateDir);

    const files = (await readdir(backupDir)).filter(f => /\.\d{8}-\d{6}$/.test(f));
    expect(files).toHaveLength(3);
  });

  it('does not touch non-backup files in the backup dir or legacy backups beside the config', async () => {
    const configPath = join(tempDir, 'baxian.json');
    await writeFile(configPath, '{}');
    await writeFile(`${configPath}.20260401-100000`, 'legacy beside config');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, 'other.txt'), 'keep me');
    for (let i = 0; i < 10; i++) {
      await writeFile(join(backupDir, `baxian.json.20260428-${String(100000 + i).slice(0, 6)}`), '');
    }

    await cleanupOldBackups(configPath, stateDir);

    expect(await readdir(backupDir)).toContain('other.txt');
    expect(await readdir(tempDir)).toContain('baxian.json.20260401-100000');
  });
});
