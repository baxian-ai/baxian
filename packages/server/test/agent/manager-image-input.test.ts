import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
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
import type { BaxianConfig, TaskState } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);

const CONFIG: BaxianConfig = {
  review: { rounds: 10 },
  server: DEFAULT_SERVER_CONFIG,
  project: [{
    id: 'proj',
    repo: 'user/repo',
    merge: null,
    agent: [[
      { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '' },
      { id: 'qa-1', runtime: 'claude-code', role: 'qa', mode: 'local', workdir: '' },
    ]],
  }],
};

let tempDir: string;
let stagingRoot: string;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let manager: AgentManager;
let mockRunner: CommandRunner;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-img-test-'));
  await initStateDir(tempDir);
  stagingRoot = join(tempDir, 'state', 'task-images');

  const skillsDir = join(tempDir, 'skills');
  for (const s of ['baxian-rules', 'baxian-task-check', 'baxian-signals']) {
    await mkdir(join(skillsDir, s), { recursive: true });
    await writeFile(join(skillsDir, s, 'SKILL.md'), `# ${s}`);
  }
  const skillRegistry = new SkillRegistry(skillsDir);
  await skillRegistry.scan();

  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  lockManager = new LockManager(join(tempDir, 'locks'));
  const eventBus = new EventBus(new EventLog(join(tempDir, 'events')));

  mockRunner = {
    exec: vi.fn<(cmd: string) => Promise<ExecResult>>().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    writeFile: vi.fn<(p: string, c: Buffer | string) => Promise<void>>().mockResolvedValue(undefined),
  };

  const config: BaxianConfig = {
    ...CONFIG,
    project: CONFIG.project.map(p => ({
      ...p,
      agent: p.agent.map(pair => pair.map(a => ({ ...a, workdir: join(tempDir, a.id) }))),
    })),
  };

  manager = new AgentManager({
    config,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    skillRegistry,
    runnerFactory: () => mockRunner,
    imageStagingRoot: stagingRoot,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true });
});

describe('attachImageToRunningAgent (entry A)', () => {
  it('writes to agent host and injects the path, returning it', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%1', updatedAt: new Date().toISOString() });

    const { path } = await manager.attachImageToRunningAgent('dev-1', PNG, 'png');

    expect(path).toMatch(/^\/tmp\/baxian\/upload\/dev-1\/[0-9a-f-]+\.png$/);
    expect(mockRunner.writeFile).toHaveBeenCalledWith(path, PNG);
    expect(mockRunner.exec).toHaveBeenCalled();
  });

  it('rejects 409 when the agent has no live session (no paneId)', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: new Date().toISOString() });
    await expect(manager.attachImageToRunningAgent('dev-1', PNG, 'png')).rejects.toMatchObject({ status: 409 });
  });

  it('rejects 404 for an unknown agent', async () => {
    await expect(manager.attachImageToRunningAgent('nope', PNG, 'png')).rejects.toMatchObject({ status: 404 });
  });
});

describe('persistTaskImages / materializeTaskImages (entry B core)', () => {
  it('persistTaskImages writes each image to the staging root and returns filenames', async () => {
    const filenames = await (manager as never as {
      persistTaskImages(id: string, imgs: { bytes: Buffer; ext: string }[]): Promise<string[]>;
    }).persistTaskImages('task-x', [{ bytes: PNG, ext: 'png' }, { bytes: GIF, ext: 'gif' }]);

    expect(filenames).toHaveLength(2);
    const onDisk = await readdir(join(stagingRoot, 'task-x'));
    expect(onDisk.sort()).toEqual(filenames.sort());
  });

  it('materializeTaskImages copies staged files to the agent host and returns host paths', async () => {
    await mkdir(join(stagingRoot, 'task-y'), { recursive: true });
    await writeFile(join(stagingRoot, 'task-y', 'f.png'), PNG);

    const task = { id: 'task-y', images: ['f.png'] } as TaskState;
    const paths = await (manager as never as {
      materializeTaskImages(r: CommandRunner, t: TaskState): Promise<string[]>;
    }).materializeTaskImages(mockRunner, task);

    expect(paths).toEqual(['/tmp/baxian/upload/task-y/f.png']);
    expect(mockRunner.writeFile).toHaveBeenCalledWith('/tmp/baxian/upload/task-y/f.png', PNG);
  });

  it('materializeTaskImages throws DispatchTerminalError(task_image_missing) when staging is gone', async () => {
    const task = { id: 'task-z', images: ['missing.png'] } as TaskState;
    await expect((manager as never as {
      materializeTaskImages(r: CommandRunner, t: TaskState): Promise<string[]>;
    }).materializeTaskImages(mockRunner, task)).rejects.toMatchObject({
      name: 'DispatchTerminalError',
      reason: 'task_image_missing',
    });
  });

  it('imagePathsForDispatch materializes for dev deliverable phases, skips QA/post-approve', async () => {
    await mkdir(join(stagingRoot, 'task-c'), { recursive: true });
    await writeFile(join(stagingRoot, 'task-c', 'g.png'), PNG);
    const task = { id: 'task-c', images: ['g.png'] } as TaskState;
    const call = (phase: string) => (manager as never as {
      imagePathsForDispatch(r: CommandRunner, t: TaskState, p: string): Promise<string[]>;
    }).imagePathsForDispatch(mockRunner, task, phase);

    for (const phase of ['develop', 'code', 'fix', 'server-feedback']) {
      expect(await call(phase), phase).toEqual(['/tmp/baxian/upload/task-c/g.png']);
    }
    for (const phase of ['review', 'recheck', 'post-approve', 'merge', 'server-spec-review']) {
      expect(await call(phase)).toEqual([]);
    }
  });
});

describe('createAndStartTask image ordering + rollback', () => {
  it('persists images BEFORE startSession for an in_progress task', async () => {
    let imagesAtStart: string[] | undefined;
    vi.spyOn(manager, 'startSession').mockImplementation(async (taskId: string) => {
      imagesAtStart = (await taskStore.get(taskId))?.images;
      return true;
    });

    const task = await manager.createAndStartTask('proj', {
      title: 'with image', description: 'desc', preferredAgentId: 'dev-1',
      images: [{ bytes: PNG, ext: 'png' }],
    });

    expect(manager.startSession).toHaveBeenCalledTimes(1);
    expect(imagesAtStart).toHaveLength(1);
    expect(task.images).toHaveLength(1);
    expect((await readdir(join(stagingRoot, task.id)))).toHaveLength(1);
  });

  it('persists images for a pending (unassigned) task without dispatching', async () => {
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);

    const task = await manager.createAndStartTask('proj', {
      title: 'queued', description: 'desc', preferredAgentId: '',
      images: [{ bytes: PNG, ext: 'png' }],
    });

    expect(task.status).toBe('pending');
    expect(startSpy).not.toHaveBeenCalled();
    expect(task.images).toHaveLength(1);
    expect((await readdir(join(stagingRoot, task.id)))).toHaveLength(1);
    expect((await taskStore.get(task.id))?.images).toHaveLength(1);
  });

  it('in_progress: image-persist failure creates no task, takes no binding/lock, never dispatches', async () => {
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    vi.spyOn(manager as never as { persistTaskImages: () => Promise<string[]> }, 'persistTaskImages')
      .mockRejectedValue(new Error('disk full'));

    await expect(manager.createAndStartTask('proj', {
      title: 'boom', description: 'desc', preferredAgentId: 'dev-1',
      images: [{ bytes: PNG, ext: 'png' }],
    })).rejects.toThrow('disk full');

    expect(await taskStore.list()).toHaveLength(0);
    expect(startSpy).not.toHaveBeenCalled();
    expect(await lockManager.acquire('dev-1', 'test:probe')).toBeTruthy();
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('pending: image-persist failure creates no task, never dispatches', async () => {
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    vi.spyOn(manager as never as { persistTaskImages: () => Promise<string[]> }, 'persistTaskImages')
      .mockRejectedValue(new Error('disk full'));

    await expect(manager.createAndStartTask('proj', {
      title: 'boom', description: 'desc', preferredAgentId: '',
      images: [{ bytes: PNG, ext: 'png' }],
    })).rejects.toThrow('disk full');

    expect(await taskStore.list()).toHaveLength(0);
    expect(startSpy).not.toHaveBeenCalled();
  });
});

describe('retryTask image preservation', () => {
  async function seedFailedTaskWithImage(id: string, filename: string, writeStaged: boolean): Promise<void> {
    const now = new Date().toISOString();
    await taskStore.set({
      id, projectId: 'proj', title: `Task ${id}`, description: 'd',
      preferredAgentId: 'dev-1', agentId: 'dev-1', reviewRound: 0,
      status: 'failed', branch: `bx/${id}`, createdAt: now, updatedAt: now,
      images: [filename],
    });
    if (writeStaged) {
      await mkdir(join(stagingRoot, id), { recursive: true });
      await writeFile(join(stagingRoot, id, filename), PNG);
    }
  }

  it('carries the old images into the new task and stages the bytes', async () => {
    vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    await seedFailedTaskWithImage('task-001', 'o.png', true);

    const fresh = await manager.retryTask('task-001');

    expect(fresh.id).not.toBe('task-001');
    expect(fresh.images).toHaveLength(1);
    expect((await readdir(join(stagingRoot, fresh.id)))).toHaveLength(1);
    const staged = await readFile(join(stagingRoot, fresh.id, (await readdir(join(stagingRoot, fresh.id)))[0]));
    expect(staged.equals(PNG)).toBe(true);
  });

  it('rejects 409 with zero leaked state when the staged source is gone', async () => {
    const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(true);
    await seedFailedTaskWithImage('task-001', 'gone.png', false);

    await expect(manager.retryTask('task-001')).rejects.toMatchObject({ status: 409 });

    expect(await taskStore.list()).toHaveLength(1);
    expect((await taskStore.get('task-001'))?.status).toBe('failed');
    expect(startSpy).not.toHaveBeenCalled();
    expect(await lockManager.acquire('dev-1', 'test:probe')).toBeTruthy();
  });
});
