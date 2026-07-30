import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { backupConfig } from '../../src/config/backup.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('backupConfig', () => {
  it('creates a timestamped backup beside the config', async () => {
    const configPath = join(tempDir, 'baxian.json');
    await writeFile(configPath, '{"test": true}');

    const backupPath = await backupConfig(configPath);

    expect(backupPath).not.toBeNull();
    expect(dirname(backupPath!)).toBe(tempDir);
    expect(backupPath!).toMatch(/baxian\.json\.\d{4}(?:-\d{2}){5}-\d{3}$/);
    expect(await readFile(backupPath!, 'utf-8')).toBe('{"test": true}');
  });

  it('returns null when config file does not exist', async () => {
    const result = await backupConfig(join(tempDir, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('propagates copy errors other than ENOENT', async () => {
    await expect(backupConfig('\0')).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' });
  });

  it('never follows or overwrites a pre-planted entry at the predictable backup name', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T10:00:00'));
    try {
      const configPath = join(tempDir, 'baxian.json');
      await writeFile(configPath, '{"secret":1}');
      const victim = join(tempDir, 'victim.txt');
      await writeFile(victim, 'precious');
      await symlink(victim, join(tempDir, 'baxian.json.2026-04-28-10-00-00-000'));

      await expect(backupConfig(configPath)).resolves.toBeNull();

      expect(await readFile(victim, 'utf-8')).toBe('precious');
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs up a symlinked config beside the logical config path', async () => {
    const home = join(tempDir, 'home');
    const target = join(tempDir, 'real-baxian.json');
    const configPath = join(home, 'baxian.json');
    await mkdir(home);
    await writeFile(target, '{"test":"symlink"}');
    await symlink(target, configPath);

    const backupPath = await backupConfig(configPath);

    expect(dirname(backupPath!)).toBe(home);
    expect(await readFile(backupPath!, 'utf-8')).toBe('{"test":"symlink"}');
  });

  it('skips an exact millisecond collision without overwriting the existing backup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T10:00:00'));
    try {
      const configPath = join(tempDir, 'baxian.json');
      await writeFile(configPath, 'v1');
      const backupPath = await backupConfig(configPath);
      await writeFile(configPath, 'v2');

      await expect(backupConfig(configPath)).resolves.toBeNull();

      expect(await readFile(backupPath!, 'utf-8')).toBe('v1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps at most 7 adjacent backups', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T10:00:00'));
    const configPath = join(tempDir, 'baxian.json');
    try {
      await writeFile(configPath, '{}');
      for (let i = 0; i < 10; i++) {
        const timestamp = `2026-04-28-10-00-00-${String(i).padStart(3, '0')}`;
        await writeFile(join(tempDir, `baxian.json.${timestamp}`), `backup-${i}`);
      }

      await backupConfig(configPath);

      const files = (await readdir(tempDir))
        .filter(f => /^baxian\.json\.\d{4}(?:-\d{2}){5}-\d{3}$/.test(f))
        .sort();
      expect(files).toEqual([
        'baxian.json.2026-04-28-10-00-00-004',
        'baxian.json.2026-04-28-10-00-00-005',
        'baxian.json.2026-04-28-10-00-00-006',
        'baxian.json.2026-04-28-10-00-00-007',
        'baxian.json.2026-04-28-10-00-00-008',
        'baxian.json.2026-04-28-10-00-00-009',
        'baxian.json.2026-04-29-10-00-00-000',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not touch non-backup siblings', async () => {
    const configPath = join(tempDir, 'baxian.json');
    await writeFile(configPath, '{}');
    await writeFile(join(tempDir, 'other.txt'), 'keep me');
    await writeFile(join(tempDir, 'baxian.json.invalid'), 'keep me');
    await writeFile(join(tempDir, 'baxian.json.manual.2026-04-28-10-00-00-000'), 'keep me');
    await writeFile(join(tempDir, 'other.json.2026-04-28-10-00-00-000'), 'keep me');
    for (let i = 0; i < 10; i++) {
      await writeFile(
        join(tempDir, `baxian.json.2026-04-28-10-00-00-${String(i).padStart(3, '0')}`),
        '',
      );
    }

    await backupConfig(configPath);

    const files = await readdir(tempDir);
    expect(files).toContain('other.txt');
    expect(files).toContain('baxian.json.invalid');
    expect(files).toContain('baxian.json.manual.2026-04-28-10-00-00-000');
    expect(files).toContain('other.json.2026-04-28-10-00-00-000');
  });
});
