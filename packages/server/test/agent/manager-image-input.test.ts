import { describe, it, expect } from 'vitest';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskState } from '../../src/shared/index.js';
import { useManagerSuiteHarness } from '../helpers/manager-harness.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);

const harness = useManagerSuiteHarness();

const stagingRoot = (): string => join(harness.tempDir, 'state', 'task-images');
const hostPath = (taskId: string, filename: string): string => `/tmp/baxian/upload/${taskId}/${filename}`;
const pastedBodies = (): string[] => harness.runner.pastedPrompts.map(p => p.body);
const cmds = (): string[] => harness.runner.exec.mock.calls.map(c => c[0] as string);

async function stageImage(taskId: string, filename: string, bytes: Buffer = PNG): Promise<void> {
  await mkdir(join(stagingRoot(), taskId), { recursive: true });
  await writeFile(join(stagingRoot(), taskId, filename), bytes);
}

// 依次在 runner 轨迹里找到每个片段,且每个都出现在前一个之后
function traceOrder(needles: string[]): boolean {
  const trace = cmds();
  let from = 0;
  for (const needle of needles) {
    const at = trace.findIndex((c, i) => i >= from && c.includes(needle));
    if (at === -1) return false;
    from = at + 1;
  }
  return true;
}

describe('attachImageToRunningAgent (entry A)', () => {
  it('writes the image to the agent host and pastes its path into the live pane', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });

    const { path } = await harness.manager.attachImageToRunningAgent('dev-1', PNG, 'png');

    expect(path).toMatch(/^\/tmp\/baxian\/upload\/dev-1\/[0-9a-f-]+\.png$/);
    expect(harness.runner.writeFile).toHaveBeenCalledWith(path, PNG);
    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%0', body: `${path} ` }]);
  });

  it('rejects 409 when the agent has no live session (no paneId)', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    await expect(harness.manager.attachImageToRunningAgent('dev-1', PNG, 'png')).rejects.toMatchObject({ status: 409 });
    expect(harness.runner.pastedPrompts).toEqual([]);
  });

  it('rejects 404 for an unknown agent', async () => {
    await expect(harness.manager.attachImageToRunningAgent('nope', PNG, 'png')).rejects.toMatchObject({ status: 404 });
  });
});

describe('task images travel from the staging root to the agent host on dispatch', () => {
  async function seedBoundDevTask(id: string, overrides: Partial<TaskState> = {}): Promise<TaskState> {
    const task = await harness.seedTask({ id, images: ['g.png'], signalToken: 'devtok123456', ...overrides });
    await harness.seedAgent({ id: 'dev-1', taskId: task.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    return task;
  }

  it.each([
    ['develop', 'in_progress'],
    ['code', 'in_progress'],
    ['fix', 'fixing'],
  ] as const)('%s dispatch copies the staged image to the host and lists it in the prompt', async (phase, status) => {
    const task = await seedBoundDevTask(`task-${phase}`, { status });
    await stageImage(task.id, 'g.png');

    await expect(harness.manager.startSession(task.id, 'dev-1', phase)).resolves.toBe(true);

    expect(harness.runner.writeFile).toHaveBeenCalledWith(hostPath(task.id, 'g.png'), PNG);
    expect(pastedBodies()).toEqual([expect.stringContaining(`- ${hostPath(task.id, 'g.png')}`)]);
  });

  function expectNoImageDispatched(): void {
    expect(harness.runner.writeFile).not.toHaveBeenCalledWith(expect.stringContaining('/tmp/baxian/upload/'), expect.anything());
    expect(pastedBodies()).toEqual([expect.not.stringContaining('/tmp/baxian/upload/')]);
  }

  // merge 不是可派发 phase(PHASE_EXPECTED_STATUS 里没有),不带图的契约只覆盖 review/recheck/post-approve
  it.each([
    ['review', 'qa-1', '%1'],
    ['recheck', 'qa-1', '%1'],
  ] as const)('%s dispatch to QA neither copies nor lists task images', async (phase, agentId, paneId) => {
    const task = await harness.seedTask({
      id: `task-${phase}`,
      status: 'review',
      images: ['g.png'],
      signalToken: 'tok123456789',
      latestHeadSha: 'a'.repeat(40),
      reviewHeadAnchorSha: 'a'.repeat(40),
      passToken: 'aaaaaaaaaaaa',
      failToken: 'bbbbbbbbbbbb',
    });
    await stageImage(task.id, 'g.png');
    await harness.seedAgent({ id: agentId, taskId: task.id, paneId });
    await harness.acquireAgentLock(agentId, task.id);

    await expect(harness.manager.startSession(task.id, agentId, phase)).resolves.toBe(true);

    expectNoImageDispatched();
  });

  it('post-approve dispatch to the dev neither copies nor lists task images', async () => {
    const task = await harness.seedTask({
      id: 'task-post-approve',
      status: 'approved',
      images: ['g.png'],
      signalToken: 'patok1234567',
      prNumber: 42,
      latestHeadSha: 'a'.repeat(40),
    });
    await stageImage(task.id, 'g.png');
    await harness.seedAgent({ id: 'dev-1', taskId: task.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1', task.id);

    await expect(harness.manager.startSession(task.id, 'dev-1', 'post-approve')).resolves.toBe(true);

    expectNoImageDispatched();
  });

  it('fails the dispatch as task_image_missing when the staged bytes are gone, without pasting anything', async () => {
    const task = await seedBoundDevTask('task-missing', { images: ['missing.png'] });

    await expect(harness.manager.startSession(task.id, 'dev-1', 'develop')).rejects.toMatchObject({
      name: 'DispatchTerminalError',
      reason: 'task_image_missing',
    });

    expect(harness.runner.pastedPrompts).toEqual([]);
    expect(harness.runner.writeFile).not.toHaveBeenCalled();
  });
});

describe('createAndStartTask image ordering + rollback', () => {
  it('persists images before dispatch so the very first prompt already lists them', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });

    const task = await harness.manager.createAndStartTask('proj', {
      title: 'with image', description: 'desc', preferredAgentId: 'dev-1',
      images: [{ bytes: PNG, ext: 'png' }],
    });

    expect(task.status).toBe('in_progress');
    expect(task.images).toHaveLength(1);
    const staged = await readdir(join(stagingRoot(), task.id));
    expect(staged).toEqual(task.images);
    expect(harness.runner.writeFile).toHaveBeenCalledWith(hostPath(task.id, task.images![0]!), PNG);
    expect(harness.runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining(`- ${hostPath(task.id, task.images![0]!)}`) }]);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(task.id);
    // adopt 轨迹:探到已有会话 → 守卫粘贴 → 守卫回车
    expect(traceOrder(['tmux list-sessions', 'paste-buffer', "'Enter'"])).toBe(true);
  });

  it('builds a fresh session first when none exists: launch on the shell, then deliver', async () => {
    harness.runner.sessions.drop('dev-1');
    await harness.seedAgent({ id: 'dev-1' });

    const task = await harness.manager.createAndStartTask('proj', {
      title: 'fresh', description: 'desc', preferredAgentId: 'dev-1',
      images: [{ bytes: PNG, ext: 'png' }],
    });

    expect(task.status).toBe('in_progress');
    const pane = harness.runner.sessions.pane('dev-1')!;
    expect(pane.process).toBe('claude');
    expect(harness.runner.pastedPrompts).toEqual([{ pane: pane.id, body: expect.stringContaining(`- ${hostPath(task.id, task.images![0]!)}`) }]);
    expect((await harness.agentStore.get('dev-1'))?.paneId).toBe(pane.id);
    // create 轨迹:新建会话 → identity-only 启动命令与回车 → 抓屏 → runtime 守卫粘贴 → runtime 守卫回车
    expect(traceOrder(['tmux new-session', 'send-keys -l', 'BX_TARGET_GONE', 'capture-pane', 'paste-buffer', 'BX_RUNTIME_OK'])).toBe(true);
    const launch = cmds().find(c => c.includes('send-keys -l') && c.includes('claude'))!;
    expect(launch).toContain('BX_TARGET_GONE');
    expect(launch).not.toContain('BX_RUNTIME_OK');
  });

  it('persists every image for a pending (unassigned) task without dispatching', async () => {
    const task = await harness.manager.createAndStartTask('proj', {
      title: 'queued', description: 'desc', preferredAgentId: '',
      images: [{ bytes: PNG, ext: 'png' }, { bytes: GIF, ext: 'gif' }],
    });

    expect(task.status).toBe('pending');
    expect(task.images).toHaveLength(2);
    expect((await readdir(join(stagingRoot(), task.id))).sort()).toEqual([...task.images!].sort());
    expect((await harness.taskStore.get(task.id))?.images).toEqual(task.images);
    expect(harness.runner.pastedPrompts).toEqual([]);
    expect(cmds().some(c => c.includes('tmux'))).toBe(false);
  });

  it.each([
    ['in_progress', 'dev-1'],
    ['pending', ''],
  ] as const)('%s: a failed image persist creates no task, takes no binding/lock and never dispatches', async (_kind, preferredAgentId) => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    // 用一个普通文件占住 staging root,让 mkdir 以 ENOTDIR 失败——磁盘层的真实故障,而不是桩
    const blocked = join(harness.tempDir, 'blocked-staging');
    await writeFile(blocked, 'not a directory');
    harness.manager = harness.createManager({ imageStagingRoot: blocked });

    await expect(harness.manager.createAndStartTask('proj', {
      title: 'boom', description: 'desc', preferredAgentId,
      images: [{ bytes: PNG, ext: 'png' }],
    })).rejects.toThrow(/ENOTDIR|EEXIST|not a directory/);

    expect(await harness.taskStore.list()).toHaveLength(0);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(harness.runner.pastedPrompts).toEqual([]);
    expect(cmds().some(c => c.includes('tmux'))).toBe(false);
  });
});

describe('retryTask image preservation', () => {
  async function seedFailedTaskWithImage(id: string, filename: string, writeStaged: boolean): Promise<void> {
    await harness.seedTask({
      id,
      status: 'failed',
      agentId: 'dev-1',
      phase: 'code',
      images: [filename],
    });
    if (writeStaged) await stageImage(id, filename);
  }

  it('carries the old images into the new task, re-stages the bytes and dispatches them', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    await seedFailedTaskWithImage('task-001', 'o.png', true);

    const fresh = await harness.manager.retryTask('task-001');

    expect(fresh.id).not.toBe('task-001');
    expect(fresh.images).toHaveLength(1);
    const restaged = await readdir(join(stagingRoot(), fresh.id));
    expect(restaged).toEqual(fresh.images);
    expect((await readFile(join(stagingRoot(), fresh.id, restaged[0]!))).equals(PNG)).toBe(true);
    expect(pastedBodies()).toEqual([expect.stringContaining(`- ${hostPath(fresh.id, restaged[0]!)}`)]);
  });

  it('rejects 409 with zero leaked state when the staged source is gone', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    await seedFailedTaskWithImage('task-001', 'gone.png', false);

    await expect(harness.manager.retryTask('task-001')).rejects.toMatchObject({ status: 409 });

    expect(await harness.taskStore.list()).toHaveLength(1);
    expect((await harness.taskStore.get('task-001'))?.status).toBe('failed');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(harness.runner.pastedPrompts).toEqual([]);
  });
});
