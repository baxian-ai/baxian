import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianEvent, TaskState } from '../../src/shared/index.js';
import type { AgentManager } from '../../src/agent/manager.js';
import { TmuxManager, ReplNotReadyError } from '../../src/agent/tmux.js';
import { BranchManager } from '../../src/agent/branch.js';
import type { AgentStore } from '../../src/state/agent-store.js';
import type { TaskStore } from '../../src/state/task-store.js';
import type { LockManager } from '../../src/state/lock.js';
import { createManagerHarness } from '../helpers/manager-harness.js';
import { fakeRunner, type FakeRunner } from '../helpers/fake-runner.js';
import { makeTask } from '../helpers/fixtures.js';

const NOW = '2026-04-28T10:00:00Z';

type ManagerHarness = Awaited<ReturnType<typeof createManagerHarness>>;

let tempDir: string;
let agentStore: AgentStore;
let taskStore: TaskStore;
let lockManager: LockManager;
let manager: AgentManager;
let events: BaxianEvent[];
let createManager: ManagerHarness['createManager'];
let seedAgent: ManagerHarness['seedAgent'];
let seedTask: ManagerHarness['seedTask'];
let acquireAgentLock: ManagerHarness['acquireAgentLock'];
let onBranchCleanup: (() => Promise<void>) | undefined;

function releaseProbeRunner(opts: {
  session?: boolean;
  claim?: string | null;
  panes?: string;
  fail?: 'session' | 'claim' | 'panes';
} = {}): FakeRunner {
  const session = opts.session ?? true;
  const claim = opts.claim === undefined ? 'dev-1' : opts.claim;
  const panes = opts.panes ?? '%0 claude\n';
  return fakeRunner({
    rules: [
      ...(opts.fail === 'session'
        ? [{ match: 'tmux has-session', reply: { stderr: 'ssh: connection timed out', exitCode: 255 } }]
        : !session
          ? [{ match: 'tmux has-session', reply: { stderr: "can't find session: dev-1", exitCode: 1 } }]
          : []),
      ...(opts.fail === 'claim'
        ? [{ match: 'tmux list-sessions', reply: { stderr: 'tmux probe failed', exitCode: 2 } }]
        : claim !== 'dev-1'
          ? [{
              match: 'tmux list-sessions',
              reply: { stdout: `4242|1700000000|$1|${claim ?? ''}\n` },
            }]
          : []),
      ...(opts.fail === 'panes'
        ? [{ match: 'tmux list-panes', reply: { stderr: 'tmux list failed', exitCode: 2 } }]
        : panes !== '%0 claude\n'
          ? [{ match: 'tmux list-panes', reply: { stdout: panes } }]
          : []),
    ],
  });
}

async function seedActiveBinding(): Promise<void> {
  await taskStore.set(makeTask({
    id: 'task-001',
    phase: 'code',
    platformBinding: undefined,
    createdAt: NOW,
    updatedAt: NOW,
  }));
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

function useReleaseHarness(lockSeededAgents = false): void {
  beforeEach(async () => {
    onBranchCleanup = undefined;
    tempDir = await mkdtemp(join(tmpdir(), 'baxian-release-lock-'));
    const runner = releaseProbeRunner();
    const harness = await createManagerHarness(tempDir, {
      deps: {
        runnerFactory: () => runner,
        platformRunner: runner,
      },
      lockSeededAgents,
    });
    ({
      manager,
      createManager,
      agentStore,
      taskStore,
      lockManager,
      seedAgent,
      seedTask,
      acquireAgentLock,
      events,
    } = harness);
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
}

describe('releaseAgentForTask binding transitions', () => {
  useReleaseHarness();

  it('waiting mode keeps the task binding and lock after the ready gate passes', async () => {
    await seedActiveBinding();
    expect((await agentStore.get('dev-1'))?.lockToken).toBeUndefined();

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'waiting')).toBe(true);

    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBe('task-001');
    expect(state?.lockToken).toEqual(expect.any(String));
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
    const absentRunner = fakeRunner({
      rules: [{
        match: cmd => cmd.includes('tmux has-session') || cmd.includes('tmux list-panes'),
        reply: { stderr: "can't find session: dev-1", exitCode: 1 },
      }],
    });
    manager = createManager({
      runnerFactory: () => absentRunner,
      platformRunner: absentRunner,
    });

    expect(await manager.releaseAgentForTask('dev-1', 'task-001', 'idle')).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('idle release treats a persisted pane as stale when the tmux session is absent', async () => {
    await seedActiveBinding();
    const runner = releaseProbeRunner({ session: false });
    manager = createManager({ runnerFactory: () => runner, platformRunner: runner });

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
    manager = createManager({ runnerFactory: () => runner, platformRunner: runner });

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
    const runner = releaseProbeRunner(probe);
    manager = createManager({ runnerFactory: () => runner, platformRunner: runner });

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
    manager = createManager({ runnerFactory: () => runner, platformRunner: runner });

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
  useReleaseHarness();

  let sentKeys: string[];

  beforeEach(async () => {
    const runner = fakeRunner({
      agents: {
        'dev-1': { screen: 'Tool use: Bash\nRunning gh pr comment...\n' },
      },
    });
    sentKeys = runner.sentKeys;
    manager = createManager({ runnerFactory: () => runner, platformRunner: runner });
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

describe('AgentManager.releaseAgentForTask waiting-mode gate', () => {
  useReleaseHarness(true);

  it('refuses the waiting transition when the bound task is no longer active', async () => {
    const t = await seedTask({ status: 'cancelled' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(manager.releaseAgentForTask('dev-1', t.id, 'waiting')).resolves.toBe(false);

    expect((await agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('not active'))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('AgentManager.releaseAgentForTask idle-mode expectedHold gate', () => {
  useReleaseHarness(true);

  async function seedHeldQa(): Promise<TaskState> {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id,
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW, awaitingNonce: 'gen-a',
    });
    await acquireAgentLock('qa-1', t.id);
    return t;
  }

  it('releases and clears the hold when the expected generation matches', async () => {
    const t = await seedHeldQa();

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: { phase: 'checkout-preparation-failed', since: NOW, nonce: 'gen-a' },
    });

    expect(released).toBe(true);
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBeUndefined();
    expect(qa?.status).toBeUndefined();
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('keeps the hold and the binding when the hold generation does not match', async () => {
    const t = await seedHeldQa();

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: { phase: 'checkout-preparation-failed', since: NOW, nonce: 'gen-z' },
    });

    expect(released).toBe(false);
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingNonce).toBe('gen-a');
    expect(await lockManager.isLocked('qa-1')).toBe(true);
  });

  it('refuses a mismatched hold generation before any workdir side effect', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo',
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      awaitingReason: 'prompt may be running', awaitingSince: NOW, awaitingNonce: 'gen-b',
    });
    await acquireAgentLock('qa-1', t.id);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: { phase: 'checkout-preparation-failed', since: NOW, nonce: 'gen-a' },
    });

    expect(released).toBe(false);
    expect(parkSpy).not.toHaveBeenCalled();
    const qa = await agentStore.get('qa-1');
    expect(qa?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(await lockManager.isLocked('qa-1')).toBe(true);
  });

  it('QA REPL 仍忙 → 抛 ReplNotReadyError 且不落 hold（忙碌不是清理失败，可再排队）', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo' });
    await acquireAgentLock('qa-1', t.id);
    vi.spyOn(
      manager as unknown as { inspectReleaseRuntime: (...args: unknown[]) => Promise<unknown> },
      'inspectReleaseRuntime',
    ).mockResolvedValue({ kind: 'pane', pane: { session: 'bx', paneId: '%1', claim: undefined } });
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<unknown> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%1', 'codex', ''));
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);

    await expect(manager.releaseAgentForTask('qa-1', t.id, 'idle', { deferWhenBusy: true }))
      .rejects.toBeInstanceOf(ReplNotReadyError);

    expect(parkSpy).not.toHaveBeenCalled();
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
    expect(qa?.awaitingPhase).toBeUndefined();
  });

  it('release 的忙碌等待走真实实现：持续忙碌时 deferWhenBusy 生效、不落 hold', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo' });
    await acquireAgentLock('qa-1', t.id);
    Object.assign(manager, { compactIdlePollMs: 1, cleanComposerWaitMs: 5 });
    vi.spyOn(
      manager as unknown as { inspectReleaseRuntime: (...args: unknown[]) => Promise<unknown> },
      'inspectReleaseRuntime',
    ).mockResolvedValue({ kind: 'pane', pane: { session: 'bx', paneId: '%1', claim: undefined } });
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockResolvedValue(undefined as never);
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue('node');
    vi.spyOn(TmuxManager.prototype, 'readPaneTitle').mockResolvedValue('');
    vi.spyOn(TmuxManager.prototype, 'capturePaneById').mockResolvedValue(
      '• Working (12s • esc to interrupt)\n  gpt-5.5 xhigh · ~/repo\n',
    );
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);

    await expect(manager.releaseAgentForTask('qa-1', t.id, 'idle', { deferWhenBusy: true }))
      .rejects.toBeInstanceOf(ReplNotReadyError);

    expect(parkSpy).not.toHaveBeenCalled();
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
  });

  it('未声明 deferWhenBusy 的普通释放（终态/清理路径）遇忙仍落 hold 并告警', async () => {
    const t = await seedTask({ status: 'merged', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo' });
    await acquireAgentLock('qa-1', t.id);
    vi.spyOn(
      manager as unknown as { inspectReleaseRuntime: (...args: unknown[]) => Promise<unknown> },
      'inspectReleaseRuntime',
    ).mockResolvedValue({ kind: 'pane', pane: { session: 'bx', paneId: '%1', claim: undefined } });
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<unknown> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%1', 'codex', ''));

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle');

    expect(released).toBe(false);
    const qa = await agentStore.get('qa-1');
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBe('branch-cleanup-pending');
  });

  it('dev REPL 忙仍按 branch-cleanup-pending 落 hold（分支清理凭据不可丢）', async () => {
    const t = await seedTask({ status: 'review', agentId: 'dev-1', branch: 'bx/task-review' });
    await seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', workdir: '/tmp/dev-repo' });
    await acquireAgentLock('dev-1', t.id);
    vi.spyOn(
      manager as unknown as { inspectReleaseRuntime: (...args: unknown[]) => Promise<unknown> },
      'inspectReleaseRuntime',
    ).mockResolvedValue({ kind: 'pane', pane: { session: 'bx', paneId: '%0', claim: undefined } });
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<unknown> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%0', 'claude-code', ''));

    const released = await manager.releaseAgentForTask('dev-1', t.id, 'idle');

    expect(released).toBe(false);
    const dev = await agentStore.get('dev-1');
    expect(dev?.status).toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBe('branch-cleanup-pending');
  });

  it('refuses an expectedHold release when the hold was already cleared', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: t.id });
    await acquireAgentLock('qa-1', t.id);

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: { phase: 'checkout-preparation-failed', since: NOW, nonce: 'gen-a' },
    });

    expect(released).toBe(false);
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(await lockManager.isLocked('qa-1')).toBe(true);
  });

  it('aborts before checkout cleanup when the hold is rewritten during runtime inspection', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo',
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW, awaitingNonce: 'gen-a',
    });
    await acquireAgentLock('qa-1', t.id);
    vi.spyOn(TmuxManager.prototype, 'hasSession').mockImplementation(async () => {
      const held = await agentStore.get('qa-1');
      await agentStore.set({
        ...held!,
        awaitingPhase: 'dispatch-failed:ack_unknown',
        awaitingReason: 'prompt may be running',
        awaitingNonce: 'gen-b',
        updatedAt: new Date().toISOString(),
      });
      return false;
    });
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: { phase: 'checkout-preparation-failed', since: NOW, nonce: 'gen-a' },
    });

    expect(released).toBe(false);
    expect(parkSpy).not.toHaveBeenCalled();
    expect((await agentStore.get('qa-1'))?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
  });

  it('does not let a cleanup failure overwrite a hold rewritten mid-release', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({
      id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo',
      status: 'awaiting_human', awaitingPhase: 'checkout-preparation-failed',
      awaitingReason: 'repl not ready', awaitingSince: NOW, awaitingNonce: 'gen-a',
    });
    await acquireAgentLock('qa-1', t.id);
    vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockImplementation(async () => {
      const held = await agentStore.get('qa-1');
      await agentStore.set({
        ...held!,
        awaitingPhase: 'dispatch-failed:ack_unknown',
        awaitingReason: 'prompt may be running',
        awaitingNonce: 'gen-b',
        updatedAt: new Date().toISOString(),
      });
      throw new Error('park failed');
    });

    const released = await manager.releaseAgentForTask('qa-1', t.id, 'idle', {
      allowAwaitingHuman: true,
      expectedHold: { phase: 'checkout-preparation-failed', since: NOW, nonce: 'gen-a' },
    });

    expect(released).toBe(false);
    const qa = await agentStore.get('qa-1');
    expect(qa?.awaitingPhase).toBe('dispatch-failed:ack_unknown');
    expect(qa?.awaitingNonce).toBe('gen-b');
    expect(await lockManager.isLocked('qa-1')).toBe(true);
  });

  it('hold 先取得 agent lease 时，release 等待并在任何 checkout 副作用前拒绝', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo' });
    await acquireAgentLock('qa-1', t.id);
    const parkSpy = vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockResolvedValue(undefined);
    const realUpdate = agentStore.update.bind(agentStore);
    let entered!: () => void;
    let unblock!: () => void;
    const updateEntered = new Promise<void>(resolve => { entered = resolve; });
    const updateUnblocked = new Promise<void>(resolve => { unblock = resolve; });
    vi.spyOn(agentStore, 'update').mockImplementationOnce(async (...args) => {
      entered();
      await updateUnblocked;
      return realUpdate(...args);
    });

    const hold = manager.markAwaitingHuman('qa-1', 'dispatch-failed:ack_unknown', 'prompt unknown', {
      expectedTaskId: t.id,
    });
    await updateEntered;
    const release = manager.releaseAgentForTask('qa-1', t.id, 'idle');
    await Promise.resolve();
    expect(parkSpy).not.toHaveBeenCalled();

    unblock();
    await expect(hold).resolves.toBe(true);
    await expect(release).resolves.toBe(false);
    expect(parkSpy).not.toHaveBeenCalled();
    expect(await agentStore.get('qa-1')).toMatchObject({
      taskId: t.id,
      status: 'awaiting_human',
      awaitingPhase: 'dispatch-failed:ack_unknown',
    });
  });

  it('release 先取得 agent lease 时，hold 不会在 park 期间落库并在解绑后被 CAS 拒绝', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo' });
    await acquireAgentLock('qa-1', t.id);
    vi.spyOn(
      manager as unknown as { inspectReleaseRuntime: (...args: unknown[]) => Promise<unknown> },
      'inspectReleaseRuntime',
    ).mockResolvedValue({ kind: 'absent' });
    let parkEntered!: () => void;
    let unblockPark!: () => void;
    const parked = new Promise<void>(resolve => { parkEntered = resolve; });
    const parkUnblocked = new Promise<void>(resolve => { unblockPark = resolve; });
    vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockImplementation(async () => {
      parkEntered();
      await parkUnblocked;
    });

    const release = manager.releaseAgentForTask('qa-1', t.id, 'idle');
    await parked;
    const hold = manager.markAwaitingHuman('qa-1', 'dispatch-failed:ack_unknown', 'prompt unknown', {
      expectedTaskId: t.id,
    });
    await Promise.resolve();
    expect((await agentStore.get('qa-1'))?.status).not.toBe('awaiting_human');

    unblockPark();
    await expect(release).resolves.toBe(true);
    await expect(hold).resolves.toBe(false);
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBeUndefined();
    expect(qa?.status).toBeUndefined();
    expect(await lockManager.isLocked('qa-1')).toBe(false);
  });

  it('agent operation lease advances after a failed predecessor', async () => {
    const t = await seedTask({ status: 'review', qaAgentId: 'qa-1' });
    await seedAgent({ id: 'qa-1', taskId: t.id });
    vi.spyOn(agentStore, 'update').mockRejectedValueOnce(new Error('store down'));

    await expect(manager.markAwaitingHuman(
      'qa-1', 'checkout-preparation-failed', 'first hold', { expectedTaskId: t.id },
    )).rejects.toThrow('store down');
    await expect(manager.markAwaitingHuman(
      'qa-1', 'dispatch-failed:ack_unknown', 'second hold', { expectedTaskId: t.id },
    )).resolves.toBe(true);

    expect(await agentStore.get('qa-1')).toMatchObject({
      status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
    });
  });
});

describe('dispatchGitFixToDev QA release', () => {
  useReleaseHarness();

  const interventionPhases = (): string[] => events
    .filter(e => e.type === 'human.intervention')
    .map(e => String((e.data as { phase?: string }).phase));

  async function seedFixingWithBoundQa(opts: { lock?: boolean } = {}): Promise<TaskState> {
    const t = await seedTask({ status: 'fixing', agentId: 'dev-1', qaAgentId: 'qa-1', signalToken: 'tok-fix' });
    await seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1', workdir: '/tmp/qa-repo' });
    if (opts.lock !== false) await acquireAgentLock('qa-1', t.id);
    vi.spyOn(
      manager as unknown as { inspectReleaseRuntime: (...args: unknown[]) => Promise<unknown> },
      'inspectReleaseRuntime',
    ).mockResolvedValue({ kind: 'pane', pane: { session: 'bx', paneId: '%1', claim: undefined } });
    vi.spyOn(
      manager as unknown as { acquireAgentForTask: (...args: unknown[]) => Promise<boolean> },
      'acquireAgentForTask',
    ).mockResolvedValue(false);
    return t;
  }

  it('QA REPL 仍忙（判决已发、总结未打完）→ 延后释放：保持绑定、不落 hold、不发释放失败干预', async () => {
    const t = await seedFixingWithBoundQa();
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<unknown> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%1', 'codex', ''));

    await manager.dispatchGitFixToDev(t.id);

    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
    expect(qa?.awaitingPhase).toBeUndefined();
    expect(interventionPhases()).not.toContain('qa-release-failed-but-dev-dispatched');
    expect(interventionPhases()).toContain('dev-acquire-failed-fix');
  });

  it('QA 清理真正失败（落 hold）→ 仍发 qa-release-failed-but-dev-dispatched', async () => {
    const t = await seedFixingWithBoundQa();
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<unknown> },
      'waitForReplPromptReady',
    ).mockResolvedValue(undefined);
    vi.spyOn(BranchManager.prototype, 'parkOnDefaultDetached').mockRejectedValue(new Error('git checkout failed'));

    await manager.dispatchGitFixToDev(t.id);

    const qa = await agentStore.get('qa-1');
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBe('branch-cleanup-pending');
    expect(interventionPhases()).toContain('qa-release-failed-but-dev-dispatched');
  });

  it('QA 释放因非忙碌原因被拒（不再持有任务锁）→ 不落 hold 但仍发 qa-release-failed-but-dev-dispatched', async () => {
    const t = await seedFixingWithBoundQa({ lock: false });
    const wait = vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<unknown> },
      'waitForReplPromptReady',
    ).mockResolvedValue(undefined);

    await manager.dispatchGitFixToDev(t.id);

    expect(wait).not.toHaveBeenCalled();
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).toBeUndefined();
    expect(interventionPhases()).toContain('qa-release-failed-but-dev-dispatched');
  });

  it('QA 已在 hold 中且 REPL 忙 → 不延后，沿用 hold 路径并告警', async () => {
    const t = await seedFixingWithBoundQa();
    await agentStore.update('qa-1', latest => ({
      ...latest!,
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
      awaitingSince: new Date().toISOString(),
    }));
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<unknown> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%1', 'codex', ''));

    await manager.dispatchGitFixToDev(t.id);

    const qa = await agentStore.get('qa-1');
    expect(qa?.status).toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBe('branch-cleanup-pending');
    expect(interventionPhases()).toContain('qa-release-failed-but-dev-dispatched');
  });

  it('hold 在快照后、释放取锁前被 Resume 清除且 REPL 仍忙 → 按锁内绑定延后，不再误落 branch-cleanup-pending', async () => {
    const t = await seedFixingWithBoundQa();
    await agentStore.update('qa-1', latest => ({
      ...latest!,
      status: 'awaiting_human',
      awaitingPhase: 'branch-cleanup-pending',
      awaitingSince: new Date().toISOString(),
    }));
    vi.spyOn(
      manager as unknown as { waitForReplPromptReady: (...args: unknown[]) => Promise<unknown> },
      'waitForReplPromptReady',
    ).mockRejectedValue(new ReplNotReadyError('%1', 'codex', ''));
    const readBinding = agentStore.get.bind(agentStore);
    let resumedInWindow = false;
    vi.spyOn(agentStore, 'get').mockImplementation(async (id) => {
      const snapshot = await readBinding(id);
      if (id === 'qa-1' && !resumedInWindow) {
        resumedInWindow = true;
        expect((await manager.resumeAgent('qa-1')).resumed).toBe(true);
      }
      return snapshot;
    });

    await manager.dispatchGitFixToDev(t.id);

    expect(resumedInWindow).toBe(true);
    const qa = await agentStore.get('qa-1');
    expect(qa?.taskId).toBe(t.id);
    expect(qa?.status).not.toBe('awaiting_human');
    expect(qa?.awaitingPhase).toBeUndefined();
    expect(interventionPhases()).not.toContain('branch-cleanup-pending');
    expect(interventionPhases()).not.toContain('qa-release-failed-but-dev-dispatched');
    expect(interventionPhases()).toContain('dev-acquire-failed-fix');
  });
});
