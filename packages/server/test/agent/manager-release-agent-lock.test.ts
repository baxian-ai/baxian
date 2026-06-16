import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianConfig } from '../../src/shared/index.js';
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
    ]],
  }],
};

let tempDir: string;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let manager: AgentManager;
let onWorktreeRemove: (() => Promise<void>) | undefined;

function readyRunner(): CommandRunner {
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('git worktree remove')) {
        await onWorktreeRemove?.();
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
        return { stdout: 'claude\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: '⏵⏵ bypass permissions on /tmp/repo\n\n>', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
  };
}

async function seedActiveBinding(): Promise<void> {
  await taskStore.set({
    id: 'task-001',
    projectId: 'proj',
    title: 'T',
    description: 'D',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    branch: 'bx/task-001',
    reviewRound: 0,
    status: 'in_progress',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await agentStore.set({
    id: 'dev-1',
    projectId: 'proj',
    taskId: 'task-001',
    worktreePath: '/tmp/repo/.baxian-worktrees/task-001',
    repoPath: '/tmp/repo',
    paneId: '%0',
    startedAt: NOW,
    updatedAt: NOW,
  });
  await lockManager.acquire('dev-1');
}

beforeEach(async () => {
  onWorktreeRemove = undefined;
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-release-lock-'));
  await initStateDir(tempDir);

  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  lockManager = new LockManager(join(tempDir, 'locks'));
  const eventBus = new EventBus(new EventLog(join(tempDir, 'events')));

  manager = new AgentManager({
    config: CONFIG,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
    runnerFactory: () => readyRunner(),
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('releaseAgentForTask binding transitions', () => {
  it('waiting mode keeps the task binding and lock after the ready gate passes', async () => {
    await seedActiveBinding();

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'waiting')).toBe(true);

    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBe('task-001');
    expect(state?.worktreePath).toBe('/tmp/repo/.baxian-worktrees/task-001');
    expect(state?.startedAt).toBe(NOW);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('idle mode clears task/worktree binding and releases the lock', async () => {
    await seedActiveBinding();

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(true);

    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.worktreePath).toBeUndefined();
    expect(state?.startedAt).toBeUndefined();
    expect(state?.paneId).toBe('%0');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('idle mode preserves latest pane and repo facts from the update closure', async () => {
    await seedActiveBinding();
    onWorktreeRemove = async () => {
      await agentStore.update('dev-1', (state) => state
        ? {
            ...state,
            paneId: '%9',
            repoPath: '/tmp/repo-new',
            updatedAt: new Date().toISOString(),
          }
        : state);
    };

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(true);

    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.worktreePath).toBeUndefined();
    expect(state?.startedAt).toBeUndefined();
    expect(state?.paneId).toBe('%9');
    expect(state?.repoPath).toBe('/tmp/repo-new');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('absent-tmux reconciliation can clear a binding without deadlocking against release', async () => {
    await seedActiveBinding();

    const release = manager.releaseAgentForTask('dev-1', 'task-001', 'waiting');
    const reconcile = manager.reconcileFailedAgent('dev-1');
    await Promise.all([release, reconcile]);

    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect((await taskStore.get('task-001'))?.status).toBe('failed');
  });
});

describe('releaseAgentForTask does not interrupt the REPL', () => {
  function busyRunner(sentKeys: string[]): CommandRunner {
    return {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys')) {
          sentKeys.push(cmd);
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('git worktree remove')) {
          await onWorktreeRemove?.();
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
          return { stdout: 'claude\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: 'Tool use: Bash\nRunning gh pr comment...\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };
  }

  let sentKeys: string[];

  beforeEach(async () => {
    sentKeys = [];
    manager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus: new EventBus(new EventLog(join(tempDir, 'events-busy'))),
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => busyRunner(sentKeys),
    });
  });

  it('idle release on busy pane: clears binding, no C-c sent', async () => {
    await seedActiveBinding();

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(true);

    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect(sentKeys.filter(k => k.includes('C-c'))).toHaveLength(0);
  });

  it('waiting release on busy pane: keeps binding but updates updatedAt, no C-c sent', async () => {
    await seedActiveBinding();

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'waiting')).toBe(true);

    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBe('task-001');
    expect(state?.updatedAt).not.toBe(NOW);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(sentKeys.filter(k => k.includes('C-c'))).toHaveLength(0);
  });
});
