import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianConfig, BaxianEvent } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import { AgentManager } from '../../src/agent/manager.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { initStateDir } from '../../src/state/init.js';
import { ErrorRecordStore } from '../../src/state/error-record-store.js';

const NOW = '2026-04-28T10:00:00Z';

const CONFIG: BaxianConfig = {
  review: { rounds: 10 },
  server: DEFAULT_SERVER_CONFIG,
  project: [{
    id: 'proj',
    repo: 'user/repo',
    merge: null,
    agent: [[
      { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo' },
      { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/qa-repo' },
    ]],
  }],
};

let tempDir: string;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let eventBus: EventBus;
let manager: AgentManager;
let errorRecordStore: ErrorRecordStore;
const events: BaxianEvent[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-reconcile-'));
  await initStateDir(tempDir);

  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  lockManager = new LockManager(join(tempDir, 'locks'));
  eventBus = new EventBus(new EventLog(join(tempDir, 'events')));
  errorRecordStore = new ErrorRecordStore(join(tempDir, 'state', 'errors'));
  events.length = 0;
  eventBus.on('*', (e) => { events.push(e); });

  const noopRunner: CommandRunner = {
    exec: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    writeFile: vi.fn(async (): Promise<void> => undefined),
  };

  manager = new AgentManager({
    config: CONFIG,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    errorRecordStore,
    skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
    runnerFactory: () => noopRunner,
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('AgentManager.reconcileFailedAgent', () => {
  it('holds the task binding and exact lock when tmux is missing, then fails the active task', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-old',
      workdir: '/tmp/repo',
      startedAt: NOW,
      paneId: 'P-1',
      updatedAt: NOW,
    });
    await taskStore.set({
      id: 'task-old',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      devAgentId: 'dev-1',
      qaAgentId: 'qa-1',
      phase: 'code',
      branch: 'bx/task-old',
      reviewRound: 0,
      status: 'in_progress',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await lockManager.acquire('dev-1', 'task-old');

    expect(await manager.reconcileFailedAgent('dev-1')).toBe(true);

    expect(await agentStore.get('dev-1')).toMatchObject({
      id: 'dev-1',
      projectId: 'proj',
      workdir: '/tmp/repo',
    });
    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBe('task-old');
    expect(state?.workdir).toBe('/tmp/repo');
    expect(state?.paneId).toBeUndefined();
    expect(state?.creationToken).toBeUndefined();
    expect(state).toMatchObject({ status: 'awaiting_human', awaitingPhase: 'runtime-missing' });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect((await taskStore.get('task-old'))?.status).toBe('failed');
    expect(events.some(e => e.type === 'agent.recovered' && e.agentId === 'dev-1')).toBe(true);
    expect(await errorRecordStore.latestForAgent('dev-1')).toMatchObject({
      reason: 'TMUX_SESSION_ABSENT',
      taskId: 'task-old',
    });
  });

  it('returns false when agent binding does not exist', async () => {
    expect(await manager.reconcileFailedAgent('dev-1')).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('does not throw when event emission fails', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: 'P-1', updatedAt: NOW });
    vi.spyOn(eventBus, 'emit').mockRejectedValueOnce(new Error('emit boom'));
    await expect(manager.reconcileFailedAgent('dev-1')).resolves.toBe(true);
    expect(await agentStore.get('dev-1')).toMatchObject({ id: 'dev-1', projectId: 'proj' });
  });

  it('does not repeatedly emit recovered once absent reconciliation has already cleared volatile binding facts', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      workdir: '/tmp/repo',
      paneId: 'P-1',
      updatedAt: NOW,
    });

    expect(await manager.reconcileFailedAgent('dev-1')).toBe(true);
    expect(await manager.reconcileFailedAgent('dev-1')).toBe(false);

    expect(events.filter(e => e.type === 'agent.recovered')).toHaveLength(1);
  });

  it('does not clear a creationToken acquired after an earlier stale read', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      workdir: '/tmp/repo',
      updatedAt: NOW,
    });
    const stalePrecheck = await agentStore.get('dev-1');
    expect(stalePrecheck?.creationToken).toBeUndefined();
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      workdir: '/tmp/repo',
      creationToken: 'create-new',
      paneId: 'P-new',
      updatedAt: NOW,
    });

    expect(await manager.reconcileFailedAgent('dev-1')).toBe(false);

    expect(await agentStore.get('dev-1')).toMatchObject({
      creationToken: 'create-new',
      paneId: 'P-new',
      workdir: '/tmp/repo',
    });
    expect(events.filter(e => e.type === 'agent.recovered')).toHaveLength(0);
    expect(await errorRecordStore.latestForAgent('dev-1')).toBeUndefined();
  });
});
