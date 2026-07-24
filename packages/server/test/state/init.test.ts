import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initStateDir } from '../../src/state/init.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

describe('initStateDir', () => {
  it('creates all required subdirectories', async () => {
    await initStateDir(tempDir);
    const dirs = ['state/agents', 'state/tasks', 'state/root-recovery', 'events', 'locks'];
    for (const dir of dirs) {
      const s = await stat(join(tempDir, dir));
      expect(s.isDirectory()).toBe(true);
    }
  });

  it('is idempotent', async () => {
    await initStateDir(tempDir);
    await initStateDir(tempDir);
    const s = await stat(join(tempDir, 'state', 'agents'));
    expect(s.isDirectory()).toBe(true);
  });
});
