import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianConfig } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import { AgentManager } from '../../src/agent/manager.js';
import { BranchManager } from '../../src/agent/branch.js';
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
let onBranchCleanup: (() => Promise<void>) | undefined;

function releaseProbeRunner(opts: {
  session?: boolean;
  claim?: string | null;
  panes?: string;
  fail?: 'session' | 'claim' | 'panes';
} = {}): CommandRunner {
  const session = opts.session ?? true;
  const claim = opts.claim === undefined ? 'dev-1' : opts.claim;
  const panes = opts.panes ?? '%0 claude\n';
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('tmux has-session')) {
        if (opts.fail === 'session') {
          return { stdout: '', stderr: 'ssh: connection timed out', exitCode: 255 };
        }
        return session
          ? { stdout: '', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 };
      }
      if (cmd.includes('tmux show-option')) {
        if (opts.fail === 'claim') {
          return { stdout: '', stderr: 'tmux probe failed', exitCode: 2 };
        }
        return claim === null
          ? { stdout: '', stderr: 'option not set', exitCode: 1 }
          : { stdout: `${claim}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('tmux list-panes')) {
        if (opts.fail === 'panes') {
          return { stdout: '', stderr: 'tmux list failed', exitCode: 2 };
        }
        return { stdout: panes, stderr: '', exitCode: 0 };
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

function readyRunner(): CommandRunner {
  return releaseProbeRunner();
}

function managerWithRunner(runner: CommandRunner): AgentManager {
  return new AgentManager({
    config: CONFIG,
    agentStore,
    taskStore,
    lockManager,
    eventBus: new EventBus(new EventLog(join(tempDir, 'events'))),
    skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
    runnerFactory: () => runner,
  });
}

async function seedActiveBinding(): Promise<void> {
  await taskStore.set({
    id: 'task-001',
    projectId: 'proj',
    title: 'T',
    description: 'D',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    devAgentId: 'dev-1',
    phase: 'code',
    branch: 'bx/task-001',
    branchCreatedByBaxian: true,
    reviewRound: 0,
    status: 'in_progress',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await agentStore.set({
    id: 'dev-1',
    projectId: 'proj',
    taskId: 'task-001',
    workdir: '/tmp/repo',
    paneId: '%0',
    startedAt: NOW,
    updatedAt: NOW,
  });
  await lockManager.acquire('dev-1', 'task-001');
}

beforeEach(async () => {
  onBranchCleanup = undefined;
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-release-lock-'));
  await initStateDir(tempDir);

  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  lockManager = new LockManager(join(tempDir, 'locks'));

  manager = managerWithRunner(readyRunner());
  vi.spyOn(BranchManager.prototype, 'cleanupTaskBranch').mockImplementation(async () => {
    await onBranchCleanup?.();
    return { status: 'deleted' };
  });
  vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe('releaseAgentForTask binding transitions', () => {
  it('waiting mode keeps the task binding and lock after the ready gate passes', async () => {
    await seedActiveBinding();

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'waiting')).toBe(true);

    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBe('task-001');
    expect(state?.workdir).toBe('/tmp/repo');
    expect(state?.startedAt).toBe(NOW);
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('idle mode clears the task binding, keeps the fixed Workdir, and releases the lock', async () => {
    await seedActiveBinding();

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(true);

    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.workdir).toBe('/tmp/repo');
    expect(state?.startedAt).toBeUndefined();
    expect(state?.paneId).toBe('%0');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('idle mode preserves the latest pane fact from the update closure', async () => {
    await seedActiveBinding();
    onBranchCleanup = async () => {
      await agentStore.update('dev-1', (state) => state
        ? {
            ...state,
            paneId: '%9',
            updatedAt: new Date().toISOString(),
          }
        : state);
    };

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(true);

    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.startedAt).toBeUndefined();
    expect(state?.paneId).toBe('%9');
    expect(state?.workdir).toBe('/tmp/repo');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('idle mode holds when Workdir changes during checkout cleanup', async () => {
    await seedActiveBinding();
    onBranchCleanup = async () => {
      await agentStore.update('dev-1', (state) => state
        ? { ...state, workdir: '/tmp/repo-new', updatedAt: new Date().toISOString() }
        : state);
    };

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(false);

    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-001',
      workdir: '/tmp/repo-new',
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
    });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('absent-tmux reconciliation holds the binding without deadlocking against a waiting transition', async () => {
    await seedActiveBinding();

    const release = manager.releaseAgentForTask('dev-1', 'task-001', 'waiting');
    const reconcile = manager.reconcileFailedAgent('dev-1');
    await Promise.all([release, reconcile]);

    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBe('task-001');
    expect(state).toMatchObject({ status: 'awaiting_human', awaitingPhase: 'runtime-missing' });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect((await taskStore.get('task-001'))?.status).toBe('failed');
  });

  it('idle release proceeds without a pane after confirming the tmux session is absent', async () => {
    await seedActiveBinding();
    await agentStore.update('dev-1', state => ({ ...state!, paneId: undefined }));
    const absentRunner = readyRunner();
    vi.mocked(absentRunner.exec).mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('tmux has-session')) {
        return { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 };
      }
      if (cmd.includes('tmux list-panes')) {
        return { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    manager = managerWithRunner(absentRunner);

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('idle release treats a persisted pane as stale when the tmux session is absent', async () => {
    await seedActiveBinding();
    const runner = releaseProbeRunner({ session: false });
    manager = managerWithRunner(runner);

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(true);

    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.paneId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    expect(vi.mocked(runner.exec).mock.calls.some(([cmd]) => String(cmd).includes("-t '%0'"))).toBe(false);
  });

  it('idle release replaces a stale persisted pane with the unique live pane in the claimed session', async () => {
    await seedActiveBinding();
    const runner = releaseProbeRunner({ panes: '%9 claude\n' });
    manager = managerWithRunner(runner);

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(true);

    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.paneId).toBe('%9');
    expect(await lockManager.isLocked('dev-1')).toBe(false);
    const commands = vi.mocked(runner.exec).mock.calls.map(([cmd]) => String(cmd));
    expect(commands.some(cmd => cmd.includes("-t '%9'"))).toBe(true);
    expect(commands.some(cmd => cmd.includes("-t '%0'"))).toBe(false);
  });

  it.each([
    ['zero panes', { panes: '' }],
    ['multiple panes', { panes: '%9 claude\n%10 zsh\n' }],
    ['claim mismatch', { claim: 'other-agent' }],
    ['session probe error', { fail: 'session' as const }],
    ['claim probe error', { fail: 'claim' as const }],
    ['pane probe error', { fail: 'panes' as const }],
  ])('idle release holds on %s', async (_label, probe) => {
    await seedActiveBinding();
    manager = managerWithRunner(releaseProbeRunner(probe));

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(false);

    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-001',
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
    });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(BranchManager.prototype.cleanupTaskBranch).not.toHaveBeenCalled();
  });

  it('stops before checkout cleanup when task ownership rotates during pane validation', async () => {
    await seedActiveBinding();
    const originalClaim = await lockManager.claimOf('dev-1');
    await agentStore.update('dev-1', latest => ({
      ...latest!,
      lockToken: originalClaim!.token,
      updatedAt: new Date().toISOString(),
    }));
    const state = (await agentStore.get('dev-1'))!;
    const runner = releaseProbeRunner({ panes: '%9 claude\n' });
    const exec = vi.mocked(runner.exec);
    const baseExec = exec.getMockImplementation()!;
    let rotated = false;
    exec.mockImplementation(async (cmd: string, opts) => {
      if (!rotated && cmd.includes('tmux list-panes')) {
        rotated = true;
        await lockManager.releaseIfOwner('dev-1', 'task-001', state.lockToken!);
        const nextToken = await lockManager.acquire('dev-1', 'task-next');
        await agentStore.update('dev-1', latest => ({
          ...latest!,
          taskId: 'task-next',
          lockToken: nextToken!,
          workdir: '/tmp/repo-next',
          updatedAt: new Date().toISOString(),
        }));
      }
      return baseExec(cmd, opts);
    });
    manager = managerWithRunner(runner);

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(false);

    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-next',
      workdir: '/tmp/repo-next',
    });
    expect(await lockManager.ownerOf('dev-1')).toBe('task-next');
    expect(BranchManager.prototype.cleanupTaskBranch).not.toHaveBeenCalled();
  });
});

describe('releaseAgentForTask does not interrupt the REPL', () => {
  function busyRunner(sentKeys: string[]): CommandRunner {
    return {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('tmux has-session')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('tmux show-option')) {
          return { stdout: 'dev-1\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('tmux list-panes')) {
          return { stdout: '%0 claude\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('send-keys')) {
          sentKeys.push(cmd);
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
    manager = managerWithRunner(busyRunner(sentKeys));
  });

  it('idle release on busy pane: keeps binding and lock, no C-c sent', async () => {
    await seedActiveBinding();
    Object.assign(manager, { cleanComposerWaitMs: 10, compactIdlePollMs: 1 });

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(false);

    expect(await agentStore.get('dev-1')).toMatchObject({
      taskId: 'task-001',
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
    });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
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
