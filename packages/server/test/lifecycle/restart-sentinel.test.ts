import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import {
  writeRestartSentinelSync,
  consumeRestartSentinel,
  clearRestartSentinelSync,
} from '../../src/lifecycle/restart-sentinel.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-sentinel-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function sentinelFile(): string {
  return join(tempDir, 'state', 'restart-intent.json');
}

describe('writeRestartSentinelSync', () => {
  it('creates state dir + writes JSON payload', async () => {
    writeRestartSentinelSync({
      stateDir: tempDir,
      restartId: 'abc',
      parentPid: 12345,
      actor: 'user',
    });
    const raw = await readFile(sentinelFile(), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.kind).toBe('restart');
    expect(parsed.restartId).toBe('abc');
    expect(parsed.parentPid).toBe(12345);
    expect(parsed.actor).toBe('user');
    expect(parsed.ttlMs).toBe(60_000);
    expect(typeof parsed.createdAt).toBe('number');
  });
});

describe('consumeRestartSentinel', () => {
  it('returns null when file does not exist', async () => {
    const result = await consumeRestartSentinel(tempDir);
    expect(result).toBeNull();
  });

  it('returns payload and deletes file when TTL valid', async () => {
    writeRestartSentinelSync({ stateDir: tempDir, restartId: 'r1', parentPid: 999, actor: 'cli' });
    const result = await consumeRestartSentinel(tempDir);
    expect(result).not.toBeNull();
    expect(result?.restartId).toBe('r1');
    expect(result?.parentPid).toBe(999);
    expect(result?.actor).toBe('cli');
    await expect(stat(sentinelFile())).rejects.toThrow();
  });

  it('returns null when TTL expired', async () => {
    await mkdir(join(tempDir, 'state'), { recursive: true });
    await writeFile(
      sentinelFile(),
      JSON.stringify({
        kind: 'restart',
        restartId: 'm',
        parentPid: 1,
        createdAt: Date.now() - 60_001,
        ttlMs: 60_000,
        actor: 'u',
      }),
    );
    const result = await consumeRestartSentinel(tempDir);
    expect(result).toBeNull();
  });

  it('returns null on corrupted JSON + deletes file', async () => {
    await mkdir(join(tempDir, 'state'), { recursive: true });
    await writeFile(sentinelFile(), 'not-json{');
    const result = await consumeRestartSentinel(tempDir);
    expect(result).toBeNull();
    await expect(stat(sentinelFile())).rejects.toThrow();
  });

  it('returns null on wrong kind + deletes file', async () => {
    await mkdir(join(tempDir, 'state'), { recursive: true });
    await writeFile(
      sentinelFile(),
      JSON.stringify({ kind: 'other', restartId: 'm', parentPid: 1, createdAt: Date.now(), ttlMs: 60_000, actor: 'u' }),
    );
    const result = await consumeRestartSentinel(tempDir);
    expect(result).toBeNull();
    await expect(stat(sentinelFile())).rejects.toThrow();
  });
});

describe('clearRestartSentinelSync', () => {
  it('does not throw when file is absent', () => {
    expect(() => clearRestartSentinelSync(tempDir)).not.toThrow();
  });

  it('removes existing file', async () => {
    writeRestartSentinelSync({ stateDir: tempDir, restartId: 'x', parentPid: 1, actor: 'u' });
    clearRestartSentinelSync(tempDir);
    await expect(stat(sentinelFile())).rejects.toThrow();
  });
});
