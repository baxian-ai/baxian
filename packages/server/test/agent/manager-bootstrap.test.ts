import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianConfig, BaxianEvent } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import { AgentManager, EnsureSessionError } from '../../src/agent/manager.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { initStateDir } from '../../src/state/init.js';

const NOW = '2026-05-14T05:00:00.000Z';

const CONFIG: BaxianConfig = {
  review: { rounds: 10 },
  server: DEFAULT_SERVER_CONFIG,
  project: [{
    id: 'proj',
    repo: 'owner/repo',
    merge: null,
    agent: [[
      { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo', yolo: true },
    ]],
  }],
};

let tempDir: string;
let manager: AgentManager;
let agentStore: AgentStore;
let lockManager: LockManager;
const events: BaxianEvent[] = [];

function runner(): CommandRunner {
  return {
    exec: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    writeFile: vi.fn(async (): Promise<void> => undefined),
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-bootstrap-test-'));
  await initStateDir(tempDir);

  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  const taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  lockManager = new LockManager(join(tempDir, 'locks'));
  const eventBus = new EventBus(new EventLog(join(tempDir, 'events')));
  events.length = 0;
  eventBus.on('*', (event) => { events.push(event); });

  manager = new AgentManager({
    config: CONFIG,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
    runnerFactory: () => runner(),
  });

  await agentStore.set({
    id: 'dev-1',
    projectId: 'proj',
    creationToken: 'token-abc',
    updatedAt: NOW,
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('AgentManager.startBootstrapAsync', () => {
  it('success records paneId and clears the creation token', async () => {
    const ensureSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: true,
      paneId: '%0',
      workdir: '/tmp/repo',
    });

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    expect(ensureSpy).toHaveBeenCalledWith('dev-1', 'create');
    const state = await agentStore.get('dev-1');
    expect(state).toMatchObject({ id: 'dev-1', projectId: 'proj', paneId: '%0' });
    expect(state?.creationToken).toBeUndefined();
    expect('status' in (state as object)).toBe(false);
    expect('sessionStatus' in (state as object)).toBe(false);
    expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(true);
  });

  it('success clears stale dialog Held fields from an earlier pending bootstrap', async () => {
    await agentStore.update('dev-1', (state) => state ? {
      ...state,
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
      awaitingReason: 'startup dialog',
      awaitingSince: NOW,
    } : null);
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: true,
      paneId: '%0',
      workdir: '/tmp/repo',
    });

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.status).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    expect(state?.awaitingReason).toBeUndefined();
    expect(state?.awaitingSince).toBeUndefined();
  });

  it('hard failure clears the creation token and emits bootstrap_failed', async () => {
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError(
        { createdSession: true, agentId: 'dev-1', lastScreen: 'still booting...' },
        'buildFreshSession failed: repl not ready',
      ),
    );

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBeUndefined();
    expect(state?.creationToken).toBeUndefined();
    expect(events.some(e =>
      e.type === 'agent.bootstrap_failed'
      && String(e.data.error).includes('repl not ready'),
    )).toBe(true);
  });

  it('dialog-pending bootstrap keeps the creation token and asks for human intervention', async () => {
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError(
        {
          createdSession: true,
          agentId: 'dev-1',
          dialogPending: true,
          lastScreen: 'Welcome to Codex\nSign in with ChatGPT\nProvide your own API key',
        },
        'buildFreshSession failed: repl not ready',
      ),
    );
    const slowPollSpy = vi
      .spyOn(manager as unknown as {
        slowPollDialogPending: (id: string, token: string | undefined) => Promise<void>;
      }, 'slowPollDialogPending')
      .mockResolvedValue(undefined);

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBe('token-abc');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('agent_dialog_pending');
    expect(events.some(e =>
      e.type === 'human.intervention'
      && e.agentId === 'dev-1'
      && e.data.phase === 'agent_dialog_pending',
    )).toBe(true);
    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
    expect(slowPollSpy).toHaveBeenCalledWith('dev-1', 'token-abc');
  });

  it('stale bootstrap completion cannot clear a newer creation token', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      creationToken: 'token-new',
      updatedAt: NOW,
    });
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: true,
      paneId: '%0',
      workdir: '/tmp/repo',
    });

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBe('token-new');
    expect(state?.paneId).toBeUndefined();
  });
});

describe('AgentManager binding gates', () => {
  it('blocks dispatch while an agent is being created', async () => {
    expect(await manager.pickAgent('proj', 'dev-1')).toBeNull();
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(false);
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('allows dispatch once creationToken is cleared and no task is bound', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
    expect(await manager.pickAgent('proj', 'dev-1')).toMatchObject({ id: 'dev-1' });
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-1');
  });

  it('blocks dispatch while another task is bound', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-busy', updatedAt: NOW });
    expect(await manager.pickAgent('proj', 'dev-1')).toBeNull();
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(false);
  });
});

describe('AgentManager.waitForBootstrapSettled', () => {
  it('resolves when creationToken clears', async () => {
    setTimeout(() => {
      void agentStore.update('dev-1', (state) => state ? {
        ...state,
        creationToken: undefined,
        updatedAt: new Date().toISOString(),
      } : null);
    }, 10);

    await expect(manager.waitForBootstrapSettled('dev-1', 500)).resolves.toBeUndefined();
  });

  it('resolves when the agent row is removed', async () => {
    setTimeout(() => {
      void agentStore.delete('dev-1');
    }, 10);

    await expect(manager.waitForBootstrapSettled('dev-1', 500)).resolves.toBeUndefined();
  });

  it('throws when creationToken never clears', async () => {
    await expect(manager.waitForBootstrapSettled('dev-1', 50)).rejects.toThrow(/timed out/);
  });
});

describe('AgentManager.slowPollDialogPending (no hard-fail timeout)', () => {
  const TOKEN = 'token-abc';

  it('no longer hard-fails after 10 minutes when the dialog stays unresolved', async () => {
    // Date.now 合成推进：真实等 10 分钟在 CI 不现实。
    await agentStore.update('dev-1', (s) => s ? {
      ...s,
      creationToken: TOKEN,
      updatedAt: NOW,
    } : null);

    const failSpy = vi.spyOn(manager, 'failTasksForAgent').mockResolvedValue({ failedCount: 0, releasedPartners: 0 });
    const releaseSpy = vi.spyOn(lockManager, 'release');
    const realSetTimeout = globalThis.setTimeout;
    const fastSetTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof globalThis.setTimeout;
    globalThis.setTimeout = fastSetTimeout;
    const realDateNow = Date.now;
    let simNow = realDateNow();
    Date.now = () => simNow;
    let iterations = 0;
    const realGet = agentStore.get.bind(agentStore);
    const realSet = agentStore.set.bind(agentStore);
    const getSpy = vi.spyOn(agentStore, 'get').mockImplementation(async (id: string) => {
      iterations++;
      simNow += 5 * 60_000;
      if (iterations === 200) {
        const cur = await realGet(id);
        if (cur) await realSet({ ...cur, creationToken: 'token-force-exit', updatedAt: new Date().toISOString() });
      }
      return realGet(id);
    });
    try {
      await (manager as unknown as {
        slowPollDialogPending: (id: string, token: string) => Promise<void>;
      }).slowPollDialogPending('dev-1', TOKEN);

      expect(failSpy).not.toHaveBeenCalled();
      expect(releaseSpy).not.toHaveBeenCalled();
      expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
      expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(false);
    } finally {
      Date.now = realDateNow;
      getSpy.mockRestore();
      failSpy.mockRestore();
      releaseSpy.mockRestore();
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('exits cleanly when creationToken is cleared mid-flight (DELETE/recreate)', async () => {
    // 确认 generational guard 在 slowPoll 上下文中也生效（startBootstrapAsync 之外的独立入口）。
    await agentStore.update('dev-1', (s) => s ? {
      ...s,
      paneId: '%0',
      creationToken: 'token-newer',
      updatedAt: NOW,
    } : null);

    const realSetTimeout = globalThis.setTimeout;
    const fastSetTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof globalThis.setTimeout;
    globalThis.setTimeout = fastSetTimeout;
    try {
      await (manager as unknown as {
        slowPollDialogPending: (id: string, token: string) => Promise<void>;
      }).slowPollDialogPending('dev-1', TOKEN);

      expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
      expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(false);
      expect((await agentStore.get('dev-1'))?.creationToken).toBe('token-newer');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('exits when agentStore record is deleted (DELETE path collapses the loop)', async () => {
    await agentStore.update('dev-1', (s) => s ? {
      ...s, creationToken: TOKEN, updatedAt: NOW,
    } : null);

    const realSetTimeout = globalThis.setTimeout;
    const fastSetTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof globalThis.setTimeout;
    globalThis.setTimeout = fastSetTimeout;
    const realGet = agentStore.get.bind(agentStore);
    let polls = 0;
    const getSpy = vi.spyOn(agentStore, 'get').mockImplementation(async (id: string) => {
      polls++;
      // 模拟 operator 在第 2 轮 poll 时 DELETE 掉 agent。
      if (polls === 2) {
        await agentStore.delete('dev-1');
      }
      return realGet(id);
    });
    try {
      // 不会无限挂——agentStore.get 返回 null 触发 line 595 的 return。
      await (manager as unknown as {
        slowPollDialogPending: (id: string, token: string) => Promise<void>;
      }).slowPollDialogPending('dev-1', TOKEN);

      expect(polls).toBeGreaterThanOrEqual(2);
      expect(polls).toBeLessThan(10); // 没失控
      expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
      expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(false);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      getSpy.mockRestore();
    }
  });
});
