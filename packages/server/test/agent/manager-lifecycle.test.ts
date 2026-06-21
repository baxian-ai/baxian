import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentManager } from '../../src/agent/manager.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { initStateDir } from '../../src/state/init.js';
import type { BaxianConfig, BaxianEvent, TaskState } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';

const CONFIG: BaxianConfig = {
  review: { rounds: 10 },
  server: DEFAULT_SERVER_CONFIG,
  project: [
    {
      id: 'proj',
      repo: 'user/repo',
      merge: null,
      agent: [
        [
          { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '' },
          { id: 'qa-1', runtime: 'claude-code', role: 'qa', mode: 'local', workdir: '' },
        ],
      ],
    },
  ],
};

let tempDir: string;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let eventBus: EventBus;
let manager: AgentManager;
let mockRunner: CommandRunner;
let emittedEvents: BaxianEvent[];

async function seedTask(overrides: Partial<TaskState> & { id: string }): Promise<TaskState> {
  const now = new Date().toISOString();
  const task: TaskState = {
    id: overrides.id,
    projectId: 'proj',
    title: `Task ${overrides.id}`,
    description: 'seeded task',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    reviewRound: 0,
    status: 'in_progress',
    branch: `bx/${overrides.id}`,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await taskStore.set(task);
  return task;
}

function seedPending(id: string, preferredAgentId: string): Promise<TaskState> {
  return seedTask({ id, status: 'pending', agentId: '', preferredAgentId });
}

function stubStartSession(result: boolean): void {
  vi.spyOn(manager, 'startSession').mockResolvedValue(result);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-lifecycle-test-'));
  await initStateDir(tempDir);

  const skillsDir = join(tempDir, 'skills');
  for (const s of ['baxian-rules', 'task-check', 'pr-review', 'pr-feedback', 'pr-recheck']) {
    await mkdir(join(skillsDir, s), { recursive: true });
    await writeFile(join(skillsDir, s, 'SKILL.md'), `# ${s}`);
  }
  const skillRegistry = new SkillRegistry(skillsDir);
  await skillRegistry.scan();

  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  lockManager = new LockManager(join(tempDir, 'locks'));
  const eventLog = new EventLog(join(tempDir, 'events'));
  eventBus = new EventBus(eventLog);

  emittedEvents = [];
  eventBus.on('*', (evt) => { emittedEvents.push(evt); });

  mockRunner = {
    exec: vi.fn<(cmd: string) => Promise<ExecResult>>().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }),
    writeFile: vi.fn<(p: string, c: Buffer | string) => Promise<void>>().mockResolvedValue(undefined),
  };

  const config: BaxianConfig = {
    ...CONFIG,
    project: CONFIG.project.map(p => ({
      ...p,
      agent: p.agent.map(pair => pair.map(a => ({ ...a, workdir: tempDir }))),
    })),
  };

  manager = new AgentManager({
    config,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    runnerFactory: () => mockRunner,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true });
});

describe('dispatchPendingTask', () => {
  it('promotes a pending task whose preferredAgentId matches and dev is idle', async () => {
    stubStartSession(true);

    const task = await seedPending('task-001', 'dev-1');

    const result = await manager.dispatchPendingTask(task.id, 'dev-1');

    expect(result.errorCode).toBeUndefined();
    const updated = await taskStore.get(task.id);
    expect(updated!.status).toBe('in_progress');
    expect(updated!.agentId).toBe('dev-1');
  });

  it('claims an unassigned task atomically: preferredAgentId/qaAgentId/agentId/status all in one set', async () => {
    stubStartSession(true);

    const task = await seedPending('task-002', '');

    const result = await manager.dispatchPendingTask(task.id, 'dev-1');

    expect(result.errorCode).toBeUndefined();
    const updated = await taskStore.get(task.id);
    expect(updated!.preferredAgentId).toBe('dev-1');
    expect(updated!.agentId).toBe('dev-1');
    expect(updated!.qaAgentId).toBe('qa-1');
    expect(updated!.status).toBe('in_progress');
  });

  it('omitting requestedAgentId falls back to task.preferredAgentId inside lock (no stale snapshot race)', async () => {
    stubStartSession(true);
    const task = await seedPending('task-fallback', 'dev-1');

    const result = await manager.dispatchPendingTask(task.id);

    expect(result.errorCode).toBeUndefined();
    expect((await taskStore.get(task.id))!.agentId).toBe('dev-1');
  });

  it('returns 409 when startSession refuses (returns false without throwing) — task state changed during dispatch', async () => {
    stubStartSession(false);
    const task = await seedPending('task-state-changed', 'dev-1');

    const result = await manager.dispatchPendingTask(task.id, 'dev-1');

    expect(result.errorCode).toBe(409);
    expect(result.error).toMatch(/task state changed/);
  });

  it('returns 400 when both requestedAgentId and task.preferredAgentId are empty (unassigned + no body)', async () => {
    const task = await seedPending('task-no-agent', '');
    const result = await manager.dispatchPendingTask(task.id);
    expect(result.errorCode).toBe(400);
    expect(result.error).toMatch(/agentId is required/);
  });

  it('falls back to current QA partner when fresh.qaAgentId is missing (task created before QA was paired)', async () => {
    stubStartSession(true);

    const task = await seedTask({
      id: 'task-002b',
      status: 'pending',
      agentId: '',
      preferredAgentId: 'dev-1',
      qaAgentId: undefined,
    });

    const result = await manager.dispatchPendingTask(task.id, 'dev-1');

    expect(result.errorCode).toBeUndefined();
    const updated = await taskStore.get(task.id);
    expect(updated!.qaAgentId).toBe('qa-1');
  });

  it('returns 409 when agent is busy (canDispatchWithBinding=false), leaves task untouched', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-other',
      updatedAt: new Date().toISOString(),
    });
    const task = await seedPending('task-003', 'dev-1');

    const result = await manager.dispatchPendingTask(task.id, 'dev-1');

    expect(result.errorCode).toBe(409);
    const stayed = await taskStore.get(task.id);
    expect(stayed!.status).toBe('pending');
    expect(stayed!.agentId).toBe('');
    expect(stayed!.preferredAgentId).toBe('dev-1');
  });

  it('returns 404 when task does not exist', async () => {
    const result = await manager.dispatchPendingTask('task-missing', 'dev-1');
    expect(result.errorCode).toBe(404);
    expect(result.task).toBeNull();
  });

  it('returns 409 when task status is not pending', async () => {
    const task = await seedTask({
      id: 'task-005',
      status: 'in_progress',
      agentId: 'dev-1',
      preferredAgentId: 'dev-1',
    });
    const result = await manager.dispatchPendingTask(task.id, 'dev-1');
    expect(result.errorCode).toBe(409);
  });

  it('returns 400 when agentId mismatches existing preferredAgentId', async () => {
    const task = await seedPending('task-006', 'dev-1');
    const result = await manager.dispatchPendingTask(task.id, 'ghost-dev');
    expect(result.errorCode).toBe(400);
  });

  it('returns 400 when agentId is unknown to config', async () => {
    const task = await seedPending('task-007', '');
    const result = await manager.dispatchPendingTask(task.id, 'ghost-dev');
    expect(result.errorCode).toBe(400);
  });

  it('on 409 from busy agent, taskStore.set is never called (atomicity guard)', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      taskId: 'task-bound',
      updatedAt: new Date().toISOString(),
    });
    const task = await seedPending('task-008', '');
    const setSpy = vi.spyOn(taskStore, 'set');
    setSpy.mockClear();

    const result = await manager.dispatchPendingTask(task.id, 'dev-1');
    expect(result.errorCode).toBe(409);
    expect(setSpy).not.toHaveBeenCalled();
  });
});

