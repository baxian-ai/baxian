import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DispatchTerminalError, type AgentManager } from '../../src/agent/manager.js';
import type { AgentStore } from '../../src/state/agent-store.js';
import type { TaskStore } from '../../src/state/task-store.js';
import type { LockManager } from '../../src/state/lock.js';
import type { TaskState } from '../../src/shared/index.js';
import type { CommandRunner } from '../../src/agent/runner.js';
import { createManagerHarness } from '../helpers/manager-harness.js';
import { fakeRunner } from '../helpers/fake-runner.js';
import { makeAgent, makeConfig } from '../helpers/fixtures.js';

let tempDir: string;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let manager: AgentManager;
let mockRunner: CommandRunner;
let seedTask: Awaited<ReturnType<typeof createManagerHarness>>['seedTask'];

function seedPending(id: string, preferredAgentId: string): Promise<TaskState> {
  return seedTask({
    id,
    title: `Task ${id}`,
    description: 'seeded task',
    phase: 'code',
    status: 'pending',
    agentId: '',
    preferredAgentId,
    ...(preferredAgentId === '' ? { devAgentId: '', qaAgentId: undefined } : {}),
  });
}

function stubStartSession(result: boolean): void {
  vi.spyOn(manager, 'startSession').mockResolvedValue(result);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-lifecycle-test-'));
  mockRunner = fakeRunner({ defaultResult: {} });
  const config = makeConfig({
    project: [{
      id: 'proj',
      repo: 'user/repo',
      merge: null,
      agent: [[
        makeAgent({ workdir: join(tempDir, 'dev-1') }),
        makeAgent({
          id: 'qa-1',
          runtime: 'claude-code',
          role: 'qa',
          workdir: join(tempDir, 'qa-1'),
        }),
      ]],
    }],
  });
  const harness = await createManagerHarness(tempDir, {
    config,
    deps: {
      runnerFactory: () => mockRunner,
      platformRunner: mockRunner,
    },
  });
  ({
    manager,
    agentStore,
    taskStore,
    lockManager,
    seedTask,
  } = harness);
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
      title: 'Task task-005',
      description: 'seeded task',
      phase: 'code',
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

  it('returns 400 when the requested agent is not a dev', async () => {
    const task = await seedPending('task-role', '');
    const result = await manager.dispatchPendingTask(task.id, 'qa-1');
    expect(result.errorCode).toBe(400);
    expect(result.error).toMatch(/not a dev agent/);
  });

  it('returns 400 when a known dev is requested for a task preferring another dev', async () => {
    const task = await seedPending('task-preferred-other', 'dev-x');
    const result = await manager.dispatchPendingTask(task.id, 'dev-1');
    expect(result.errorCode).toBe(400);
    expect(result.error).toMatch(/preferredAgentId=dev-x/);
  });

  it('returns 400 when the requested agent belongs to another project', async () => {
    manager.replaceConfig({
      ...manager.getConfig(),
      project: [
        ...manager.getConfig().project,
        {
          id: 'proj2', repo: 'user/other', merge: null,
          agent: [[
            { id: 'dev-2', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: tempDir },
            { id: 'qa-2', runtime: 'claude-code', role: 'qa', mode: 'local', workdir: join(tempDir, 'qa-2') },
          ]],
        },
      ],
    });
    const task = await seedPending('task-cross-proj', '');
    const result = await manager.dispatchPendingTask(task.id, 'dev-2');
    expect(result.errorCode).toBe(400);
    expect(result.error).toMatch(/not in project/);
  });

  it('returns 409 when the dev lock is already held by another task', async () => {
    await lockManager.acquire('dev-1', 'foreign-task');
    const task = await seedPending('task-lockheld', 'dev-1');
    const result = await manager.dispatchPendingTask(task.id, 'dev-1');
    expect(result.errorCode).toBe(409);
    expect(result.error).toMatch(/lock acquisition failed/);
  });

  it('rolls the claim back and returns 500 when startSession throws a generic error', async () => {
    vi.spyOn(manager, 'startSession').mockRejectedValue(new Error('tmux exploded'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const task = await seedPending('task-hard-error', 'dev-1');

    const result = await manager.dispatchPendingTask(task.id, 'dev-1');

    expect(result.errorCode).toBe(500);
    expect(result.error).toMatch(/tmux exploded/);
    const rolled = await taskStore.get(task.id);
    expect(rolled!.status).toBe('pending');
    expect(rolled!.agentId).toBe('');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    errSpy.mockRestore();
  });

  it('fails the task through failTaskForDispatchError on a DispatchTerminalError', async () => {
    vi.spyOn(manager, 'startSession').mockRejectedValue(
      new DispatchTerminalError('prompt_too_large', 'prompt too big'),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failSpy = vi.spyOn(manager, 'failTaskForDispatchError').mockResolvedValue();
    const task = await seedPending('task-terminal-error', 'dev-1');

    const result = await manager.dispatchPendingTask(task.id, 'dev-1');

    expect(result.errorCode).toBe(500);
    expect(failSpy).toHaveBeenCalledWith(task.id, 'develop', 'dev-1', expect.objectContaining({ reason: 'prompt_too_large' }));
    errSpy.mockRestore();
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
