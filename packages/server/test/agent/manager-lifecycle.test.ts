import { describe, it, expect, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskState } from '../../src/shared/index.js';
import { createManagerSuiteRunner, useManagerSuiteHarness } from '../helpers/manager-harness.js';
import type { FakeRunner, FakeRunnerOptions } from '../helpers/fake-runner.js';

const harness = useManagerSuiteHarness();

function seedPending(id: string, preferredAgentId: string, overrides: Partial<TaskState> = {}): Promise<TaskState> {
  return harness.seedTask({
    id,
    title: `Task ${id}`,
    description: 'seeded task',
    phase: 'code',
    status: 'pending',
    agentId: '',
    preferredAgentId,
    ...(preferredAgentId === '' ? { devAgentId: '', qaAgentId: undefined } : {}),
    ...overrides,
  });
}

const pasted = () => harness.runner.pastedPrompts;

// 换一台带不同布置的 live runner,manager 经公共依赖重建
function useRunner(options: FakeRunnerOptions): FakeRunner {
  const runner = createManagerSuiteRunner(options);
  harness.manager = harness.createManager({ runnerFactory: () => runner });
  return runner;
}

describe('dispatchPendingTask', () => {
  it('promotes a pending task whose preferredAgentId matches and dev is idle', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    const task = await seedPending('task-001', 'dev-1');

    const result = await harness.manager.dispatchPendingTask(task.id, 'dev-1');

    expect(result.errorCode).toBeUndefined();
    const updated = await harness.taskStore.get(task.id);
    expect(updated!.status).toBe('in_progress');
    expect(updated!.agentId).toBe('dev-1');
    expect(pasted()).toEqual([{ pane: '%0', body: expect.stringContaining(updated!.signalToken!) }]);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(task.id);
  });

  it('claims an unassigned task atomically: preferredAgentId/qaAgentId/agentId/status all in one set', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    const task = await seedPending('task-002', '');

    const result = await harness.manager.dispatchPendingTask(task.id, 'dev-1');

    expect(result.errorCode).toBeUndefined();
    const updated = await harness.taskStore.get(task.id);
    expect(updated!.preferredAgentId).toBe('dev-1');
    expect(updated!.agentId).toBe('dev-1');
    expect(updated!.qaAgentId).toBe('qa-1');
    expect(updated!.status).toBe('in_progress');
    expect(pasted()).toHaveLength(1);
  });

  it('omitting requestedAgentId falls back to task.preferredAgentId inside lock (no stale snapshot race)', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    const task = await seedPending('task-fallback', 'dev-1');

    const result = await harness.manager.dispatchPendingTask(task.id);

    expect(result.errorCode).toBeUndefined();
    expect((await harness.taskStore.get(task.id))!.agentId).toBe('dev-1');
    expect(pasted()).toEqual([{ pane: '%0', body: expect.any(String) }]);
  });

  it('returns 409 when startSession refuses (returns false without throwing) — task state changed during dispatch', async () => {
    const task = await seedPending('task-state-changed', 'dev-1');
    // 派单途中任务被人取消:ensureSession 的抓屏处切换状态,startSession 在 ensure 之后的状态闸门上退回 false
    let flipped = false;
    const runner = useRunner({
      onExec: async command => {
        if (flipped || !command.includes('capture-pane')) return;
        flipped = true;
        const fresh = (await harness.taskStore.get(task.id))!;
        await harness.taskStore.set({ ...fresh, status: 'cancelled', updatedAt: new Date().toISOString() });
      },
    });
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });

    const result = await harness.manager.dispatchPendingTask(task.id, 'dev-1');

    expect(flipped).toBe(true);
    expect(result.errorCode).toBe(409);
    expect(result.error).toMatch(/task state changed/);
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('returns 400 when both requestedAgentId and task.preferredAgentId are empty (unassigned + no body)', async () => {
    const task = await seedPending('task-no-agent', '');
    const result = await harness.manager.dispatchPendingTask(task.id);
    expect(result.errorCode).toBe(400);
    expect(result.error).toMatch(/agentId is required/);
  });

  it('returns 409 when agent is busy (canDispatchWithBinding=false), leaves task untouched', async () => {
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-other' });
    const task = await seedPending('task-003', 'dev-1');

    const result = await harness.manager.dispatchPendingTask(task.id, 'dev-1');

    expect(result.errorCode).toBe(409);
    const stayed = await harness.taskStore.get(task.id);
    expect(stayed!.status).toBe('pending');
    expect(stayed!.agentId).toBe('');
    expect(stayed!.preferredAgentId).toBe('dev-1');
  });

  it('returns 404 when task does not exist', async () => {
    const result = await harness.manager.dispatchPendingTask('task-missing', 'dev-1');
    expect(result.errorCode).toBe(404);
    expect(result.task).toBeNull();
  });

  it('returns 409 when task status is not pending', async () => {
    const task = await harness.seedTask({
      id: 'task-005',
      title: 'Task task-005',
      description: 'seeded task',
      phase: 'code',
      status: 'in_progress',
      agentId: 'dev-1',
      preferredAgentId: 'dev-1',
    });
    const result = await harness.manager.dispatchPendingTask(task.id, 'dev-1');
    expect(result.errorCode).toBe(409);
  });

  it('returns 400 when agentId mismatches existing preferredAgentId', async () => {
    const task = await seedPending('task-006', 'dev-1');
    const result = await harness.manager.dispatchPendingTask(task.id, 'ghost-dev');
    expect(result.errorCode).toBe(400);
  });

  it('returns 400 when agentId is unknown to config', async () => {
    const task = await seedPending('task-007', '');
    const result = await harness.manager.dispatchPendingTask(task.id, 'ghost-dev');
    expect(result.errorCode).toBe(400);
  });

  it('returns 400 when the requested agent is not a dev', async () => {
    const task = await seedPending('task-role', '');
    const result = await harness.manager.dispatchPendingTask(task.id, 'qa-1');
    expect(result.errorCode).toBe(400);
    expect(result.error).toMatch(/not a dev agent/);
  });

  it('returns 400 when a known dev is requested for a task preferring another dev', async () => {
    const task = await seedPending('task-preferred-other', 'dev-x');
    const result = await harness.manager.dispatchPendingTask(task.id, 'dev-1');
    expect(result.errorCode).toBe(400);
    expect(result.error).toMatch(/preferredAgentId=dev-x/);
  });

  it('returns 400 when the requested agent belongs to another project', async () => {
    harness.manager.replaceConfig({
      ...harness.manager.getConfig(),
      project: [
        ...harness.manager.getConfig().project,
        {
          id: 'proj2', repo: 'https://github.com/user/other.git', merge: null,
          agent: [[
            { id: 'dev-2', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: harness.tempDir },
            { id: 'qa-2', runtime: 'claude-code', role: 'qa', mode: 'local', workdir: join(harness.tempDir, 'qa-2') },
          ]],
        },
      ],
    });
    const task = await seedPending('task-cross-proj', '');
    const result = await harness.manager.dispatchPendingTask(task.id, 'dev-2');
    expect(result.errorCode).toBe(400);
    expect(result.error).toMatch(/not in project/);
  });

  it('returns 409 when the dev lock is already held by another task', async () => {
    await harness.lockManager.acquire('dev-1', 'foreign-task');
    const task = await seedPending('task-lockheld', 'dev-1');
    const result = await harness.manager.dispatchPendingTask(task.id, 'dev-1');
    expect(result.errorCode).toBe(409);
    expect(result.error).toMatch(/lock acquisition failed/);
  });

  it('rolls the claim back and returns 500 when the dispatch dies on a tmux error', async () => {
    const runner = useRunner({
      rules: [{ match: 'capture-pane', reply: { stderr: 'tmux exploded', exitCode: 1 } }],
    });
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const task = await seedPending('task-hard-error', 'dev-1');

    const result = await harness.manager.dispatchPendingTask(task.id, 'dev-1');

    expect(result.errorCode).toBe(500);
    expect(result.error).toMatch(/tmux exploded/);
    const rolled = await harness.taskStore.get(task.id);
    expect(rolled!.status).toBe('pending');
    expect(rolled!.agentId).toBe('');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(runner.pastedPrompts).toEqual([]);
    errSpy.mockRestore();
  });

  it('fails the task through failTaskForDispatchError on a DispatchTerminalError', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 暂存目录里没有这张图:真实派单在组装提示词时抛 DispatchTerminalError(task_image_missing)
    const task = await seedPending('task-terminal-error', 'dev-1', { images: ['gone.png'] });
    await mkdir(join(harness.tempDir, 'state', 'task-images', task.id), { recursive: true });

    const result = await harness.manager.dispatchPendingTask(task.id, 'dev-1');

    expect(result.errorCode).toBe(500);
    expect((await harness.taskStore.get(task.id))?.status).toBe('failed');
    expect(harness.events.some(e => e.type === 'human.intervention'
      && e.taskId === task.id
      && (e.data as { phase?: string }).phase === 'dispatch-failed:task_image_missing')).toBe(true);
    expect(pasted()).toEqual([]);
    errSpy.mockRestore();
  });

  it('lists a staged task image in the very first prompt it dispatches', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    const task = await seedPending('task-image-staged', 'dev-1', { images: ['a.png'] });
    const dir = join(harness.tempDir, 'state', 'task-images', task.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await harness.manager.dispatchPendingTask(task.id, 'dev-1');

    expect(result.errorCode).toBeUndefined();
    expect(pasted()).toEqual([{ pane: '%0', body: expect.stringContaining('/tmp/baxian/upload/') }]);
  });

  it('on 409 from busy agent, taskStore.set is never called (atomicity guard)', async () => {
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-bound' });
    const task = await seedPending('task-008', '');
    const setSpy = vi.spyOn(harness.taskStore, 'set');
    setSpy.mockClear();

    const result = await harness.manager.dispatchPendingTask(task.id, 'dev-1');
    expect(result.errorCode).toBe(409);
    expect(setSpy).not.toHaveBeenCalled();
  });
});
