import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>(
    'node:child_process',
  );
  return { ...actual, spawn: vi.fn() };
});

// Default mock forwards so happy-path tests can inspect the sentinel file.
vi.mock('../../src/lifecycle/restart-sentinel.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/lifecycle/restart-sentinel.js')
  >('../../src/lifecycle/restart-sentinel.js');
  return {
    ...actual,
    writeRestartSentinelSync: vi.fn(actual.writeRestartSentinelSync),
  };
});

import { spawn } from 'node:child_process';
import { RestartCoordinator } from '../../src/lifecycle/restart.js';
import { writeRestartSentinelSync } from '../../src/lifecycle/restart-sentinel.js';

const spawnMock = vi.mocked(spawn);
const writeSentinelMock = vi.mocked(writeRestartSentinelSync);

let tempDir: string;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-restart-test-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  spawnMock.mockReset();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  exitSpy.mockRestore();
});

function makeApp(closeImpl?: () => Promise<void>): { close: () => Promise<void> } {
  return { close: closeImpl ?? (async () => {}) };
}

describe('RestartCoordinator', () => {
  it('beginRestart sets restarting + generates restartId', () => {
    const coord = new RestartCoordinator({
      app: makeApp() as never,
      configPath: 'baxian.json',
      stateDir: tempDir,
    });
    expect(coord.isRestarting()).toBe(false);
    coord.beginRestart({ actor: 'user' });
    expect(coord.isRestarting()).toBe(true);
  });

  it('second beginRestart throws', () => {
    const coord = new RestartCoordinator({
      app: makeApp() as never,
      configPath: 'baxian.json',
      stateDir: tempDir,
    });
    coord.beginRestart({ actor: 'a' });
    expect(() => coord.beginRestart({ actor: 'b' })).toThrow(/already in progress/);
  });

  it('execute happy path: writes sentinel, closes app, exits 0', async () => {
    const closeFn = vi.fn(async () => {});
    const coord = new RestartCoordinator({
      app: makeApp(closeFn) as never,
      configPath: '/tmp/baxian.json',
      stateDir: tempDir,
    });
    coord.beginRestart({ actor: 'user' });
    await coord.execute();

    await expect(stat(join(tempDir, 'state', 'restart-intent.json'))).resolves.toBeDefined();
    expect(closeFn).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('execute Phase 1 sentinel write failure: clears restarting, app.close not called', async () => {
    writeSentinelMock.mockImplementationOnce(() => {
      throw new Error('mock disk full');
    });

    const closeFn = vi.fn(async () => {});
    const coord = new RestartCoordinator({
      app: makeApp(closeFn) as never,
      configPath: 'baxian.json',
      stateDir: tempDir,
    });
    coord.beginRestart({ actor: 'u' });
    await coord.execute();

    expect(coord.isRestarting()).toBe(false);
    expect(closeFn).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('execute app.close timeout: still exits 0', async () => {
    const coord = new RestartCoordinator({
      app: makeApp(() => new Promise(() => {})) as never,
      configPath: 'baxian.json',
      stateDir: tempDir,
    });
    coord.beginRestart({ actor: 'u' });
    await coord.execute();
    expect(exitSpy).toHaveBeenCalledWith(0);
  }, 10_000);

  it('beforeExit runs after app.close (or its timeout) and BEFORE exit', async () => {
    const order: string[] = [];
    const closeFn = vi.fn(async () => { order.push('close'); });
    const beforeExit = vi.fn(async () => { order.push('beforeExit'); });
    exitSpy.mockImplementation(((() => {
      order.push('exit');
      return undefined as never;
    }) as unknown) as typeof process.exit);

    const coord = new RestartCoordinator({
      app: makeApp(closeFn) as never,
      configPath: 'baxian.json',
      stateDir: tempDir,
      beforeExit,
    });
    coord.beginRestart({ actor: 'u' });
    await coord.execute();

    expect(order).toEqual(['close', 'beforeExit', 'exit']);
    expect(beforeExit).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('beforeExit still runs when app.close times out (lock release must not depend on onClose finishing)', async () => {
    const beforeExit = vi.fn(async () => {});
    const coord = new RestartCoordinator({
      app: makeApp(() => new Promise(() => {})) as never,
      configPath: 'baxian.json',
      stateDir: tempDir,
      beforeExit,
    });
    coord.beginRestart({ actor: 'u' });
    await coord.execute();

    expect(beforeExit).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  }, 10_000);

  it('beforeExit throwing aborts restart: sentinel cleared, exit 1', async () => {
    const beforeExit = vi.fn(async () => { throw new Error('release failed'); });
    const coord = new RestartCoordinator({
      app: makeApp() as never,
      configPath: 'baxian.json',
      stateDir: tempDir,
      beforeExit,
    });
    coord.beginRestart({ actor: 'u' });
    await coord.execute();

    expect(beforeExit).toHaveBeenCalledTimes(1);
    await expect(stat(join(tempDir, 'state', 'restart-intent.json'))).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not spawn a child process (systemd / external supervisor is the relauncher)', async () => {
    const coord = new RestartCoordinator({
      app: makeApp() as never,
      configPath: 'baxian.json',
      stateDir: tempDir,
    });
    coord.beginRestart({ actor: 'u' });
    await coord.execute();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
