import { describe, it, expect, vi } from 'vitest';
import type { AgentBindingFacts, AgentConfig } from '../../src/shared/index.js';
import { AgentManager } from '../../src/agent/manager.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { TmuxManager } from '../../src/agent/tmux.js';
import {
  callInjectAndAwaitAck,
  createManagerSuiteRunner,
  TEST_SESSION_REF,
  useManagerSuiteHarness,
} from '../helpers/manager-harness.js';
import { clearAwareRunner, fakeRunner } from '../helpers/fake-runner.js';
import { makeTask } from '../helpers/fixtures.js';

const NOW = '2026-05-14T05:00:00.000Z';

const CLAUDE_PANE = { proc: 'claude', idle: '⏵⏵ bypass permissions on /tmp/repo\n\n>' };

const CODEX_PANE = { proc: 'codex', idle: 'permissions: YOLO mode\n\n>' };

function stubClaimedPaneResolution(paneForAgent: (agentId: string) => string): void {
  vi.spyOn(TmuxManager.prototype, 'getSessionSnapshot')
    .mockImplementation(async (name) => ({ ref: TEST_SESSION_REF, claim: name }));
  vi.spyOn(TmuxManager.prototype, 'getSinglePaneByRef')
    .mockImplementation(async (ref, claim) => ({ session: ref, paneId: paneForAgent(claim), claim }));
}

const harness = useManagerSuiteHarness();

describe('AgentManager runtime menu marker', () => {
  it('emits one pending intervention and one matching resolution when the menu closes', async () => {
    let captures = 0;
    const runner = fakeRunner({
      rules: [{
        match: 'capture-pane',
        reply: () => {
          captures += 1;
          const frame = captures <= 2
            ? 'Enter to confirm · Esc to cancel'
            : '⏵⏵ bypass permissions on /tmp/repo\n\n>';
          return { stdout: `BX_PANE_OK\n${frame}` };
        },
      }],
    });
    harness.manager = harness.createManager({ runnerFactory: () => runner });
    harness.manager['runtimeMenuPollIntervalMs'] = 5;
    await harness.seedTask();
    await harness.seedAgent({
      id: 'dev-1',
      taskId: 'task-1',
      paneId: '%0',
    });

    harness.manager.startRuntimeMenuWatch('dev-1');
    try {
      await vi.waitFor(() => {
        expect(harness.events.some(event =>
          event.type === 'human.intervention' &&
          event.data.phase === 'agent_runtime_menu_resolved'
        )).toBe(true);
      }, { interval: 5 });
    } finally {
      harness.manager.stopRuntimeMenuWatch('dev-1');
    }

    const interventions = harness.events.filter(e => e.type === 'human.intervention');
    expect(interventions.map(event => event.data.phase)).toEqual([
      'agent_runtime_menu_pending',
      'agent_runtime_menu_resolved',
    ]);
    expect(interventions[1].data.previousPhase).toBe('agent_runtime_menu_pending');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe('task-1');
  });
});

describe('cancelTask interrupts (ESC) then releases dev and qa panes without clearing', () => {
  it('sends ESC to both dev and qa, never /clear, then clears both bindings', async () => {
    const sentKeys: string[] = [];
    const localManager = harness.createManager({
      runnerFactory: () => clearAwareRunner(sentKeys, pane => (pane === '%1' ? CODEX_PANE : CLAUDE_PANE)),
    });
    harness.setCompactTiming(localManager);

    const t = await harness.seedTask({ qaAgentId: 'qa-1' });
    await harness.seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await harness.seedAgent({
      id: 'qa-1',
      taskId: t.id,
      paneId: '%1',
    });
    await harness.acquireAgentLock('dev-1');
    await harness.acquireAgentLock('qa-1');

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    const escKeys = sentKeys.filter(k => k.includes("'Escape'"));
    expect(escKeys.length).toBeGreaterThanOrEqual(2);
    expect(sentKeys.some(k => k.includes('send-keys -l') && k.includes('/clear'))).toBe(false);
    expect(sentKeys.some(k => k.includes('%1') && k.includes('C-c'))).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(await harness.lockManager.isLocked('qa-1')).toBe(false);
  });

  it('skips interrupt/clear and release when agent has been rebound to a new task (race protection)', async () => {
    const sentKeys: string[] = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys')) {
          sentKeys.push(cmd);
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
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const localManager = harness.createManager({ runnerFactory: () => runner });

    const oldTask = makeTask({ id: 'task-old' });
    const newTask = makeTask({ id: 'task-new' });
    await harness.taskStore.set(oldTask);
    await harness.taskStore.set(newTask);
    await harness.seedAgent({
      id: 'dev-1',
      taskId: oldTask.id,
      paneId: '%0',
    });
    await harness.acquireAgentLock('dev-1');

    const realAgentGet = harness.agentStore.get.bind(harness.agentStore);
    let devGets = 0;
    let switched = false;
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id: string) => {
      if (id === 'dev-1' && !switched && ++devGets >= 2) {
        switched = true;
        const cur = await realAgentGet(id);
        if (cur) {
          await harness.agentStore.set({ ...cur, taskId: newTask.id, updatedAt: new Date().toISOString() });
        }
        return realAgentGet(id);
      }
      return realAgentGet(id);
    });

    const cancelled = await localManager.cancelTask(oldTask.id);

    expect(cancelled.status).toBe('cancelled');
    expect(sentKeys.filter(k => k.includes("'Escape'"))).toHaveLength(0);
    expect(sentKeys.filter(k => k.includes('/clear'))).toHaveLength(0);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(newTask.id);
  });

  it('preserves binding and emits intervention when interrupt fails (no /clear)', async () => {
    const sentKeys: string[] = [];
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys')) sentKeys.push(cmd);
        if (cmd.includes('display-message') && cmd.includes('pane_current_command')) {
          return { stdout: 'claude\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: 'Tool use: Bash\nstill streaming...\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const localManager = harness.createManager({ runnerFactory: () => runner });

    harness.mockInterruptPane(localManager, false);

    const t = await harness.seedTask();
    await harness.seedAgent({
      id: 'dev-1',
      taskId: t.id,
      paneId: '%0',
    });
    await harness.acquireAgentLock('dev-1');

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(sentKeys.filter(k => k.includes('/clear'))).toHaveLength(0);
    const stateAfter = await harness.agentStore.get('dev-1');
    expect(stateAfter?.taskId).toBe(t.id);
    expect(stateAfter?.status).toBe('awaiting_human');
    expect(stateAfter?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    const failedEvents = harness.events.filter(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'cancel-interrupt-failed',
    );
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      type: 'human.intervention',
      projectId: 'proj',
      agentId: 'dev-1',
      taskId: t.id,
    });
  });

  it('keeps the mutex-busy hold reason and emits a single intervention when the pane mutex stays busy', async () => {
    const localManager = harness.createManager({ runnerFactory: () => createManagerSuiteRunner() });
    Object.assign(localManager, { cancelInterruptGuardWaitMs: 30, compactIdlePollMs: 5 });
    stubClaimedPaneResolution(() => '%0');
    (localManager as unknown as { compactInFlight: Set<string> }).compactInFlight.add('dev-1');

    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBe(t.id);
    expect(dev?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(dev?.awaitingReason).toContain('pane mutex');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
    const holdEvents = harness.events.filter(
      e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'cancel-interrupt-failed',
    );
    expect(holdEvents).toHaveLength(1);
  });

  it('releases neither agent until both panes are interrupted, so a slow qa interrupt cannot expose a freed dev', async () => {
    const localManager = harness.createManager({ runnerFactory: () => createManagerSuiteRunner() });

    const t = await harness.seedTask({ qaAgentId: 'qa-1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('dev-1');
    await harness.acquireAgentLock('qa-1');

    let devStillHeldDuringQaInterrupt: boolean | undefined;
    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: (state: { id: string }) => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async (state) => {
        if (state.id === 'qa-1') {
          devStillHeldDuringQaInterrupt =
            (await harness.agentStore.get('dev-1'))?.taskId === t.id && (await harness.lockManager.isLocked('dev-1'));
        }
        return true;
      });

    await localManager.cancelTask(t.id);

    expect(devStillHeldDuringQaInterrupt).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(await harness.lockManager.isLocked('qa-1')).toBe(false);
  });

  it('refuses Resume while cancel cleanup is in flight, and the worker still completes both releases', async () => {
    const localManager = harness.createManager({ runnerFactory: () => createManagerSuiteRunner() });

    const t = await harness.seedTask({ qaAgentId: 'qa-1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('dev-1');
    await harness.acquireAgentLock('qa-1');

    let resumeDuringCancel: { resumed: boolean; reason?: string } | undefined;
    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: (state: { id: string }) => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async (state) => {
        if (state.id === 'qa-1') {
          resumeDuringCancel = await localManager.resumeAgent('dev-1');
        }
        return true;
      });

    await localManager.cancelTask(t.id);

    expect(resumeDuringCancel?.resumed).toBe(false);
    expect(resumeDuringCancel?.reason).toContain('in progress');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(await harness.lockManager.isLocked('qa-1')).toBe(false);
  });

  it('a duplicate cancel of an already-cancelling task does not clear the in-flight guard early', async () => {
    const localManager = harness.createManager({ runnerFactory: () => createManagerSuiteRunner() });

    const t = await harness.seedTask({ qaAgentId: 'qa-1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('dev-1');
    await harness.acquireAgentLock('qa-1');

    let resumeAfterDuplicateCancel: { resumed: boolean; reason?: string } | undefined;
    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: (state: { id: string }) => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async (state) => {
        if (state.id === 'qa-1') {
          await localManager.cancelTask(t.id);
          resumeAfterDuplicateCancel = await localManager.resumeAgent('dev-1');
        }
        return true;
      });

    await localManager.cancelTask(t.id);

    expect(resumeAfterDuplicateCancel?.resumed).toBe(false);
    expect(resumeAfterDuplicateCancel?.reason).toContain('in progress');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
    expect(await harness.lockManager.isLocked('qa-1')).toBe(false);
  });

  it('a dev whose interrupt fails does not strand qa — qa is still interrupted and released', async () => {
    const localManager = harness.createManager({ runnerFactory: () => createManagerSuiteRunner() });

    const t = await harness.seedTask({ qaAgentId: 'qa-1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('dev-1');
    await harness.acquireAgentLock('qa-1');

    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: (state: { id: string }) => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async (state) => state.id !== 'dev-1');

    await localManager.cancelTask(t.id);

    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.status).toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(dev?.taskId).toBe(t.id);
    const qa = await harness.agentStore.get('qa-1');
    expect(qa?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('qa-1')).toBe(false);
  });

  it('does not stale-mark a rebound agent when it is reassigned mid-cleanup (release+reassign race)', async () => {
    const localManager = harness.createManager({ runnerFactory: () => createManagerSuiteRunner() });

    const t = await harness.seedTask();
    await harness.taskStore.set(makeTask({ id: 'task-new' }));
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async () => {
        await harness.agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-new', paneId: '%0', updatedAt: new Date().toISOString() });
        return true;
      });

    await localManager.cancelTask(t.id);

    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-new');
    expect(dev?.status).not.toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBeUndefined();
  });

  it('refuses release of a cancel-clearing pane unless it is cancel\'s own (fromCancelCleanup)', async () => {
    const t = await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await harness.acquireAgentLock('dev-1');

    expect(await harness.manager.releaseAgentForTask('dev-1', t.id, 'idle')).toBe(false);
    expect(await harness.manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true })).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);

    expect(await harness.manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true, fromCancelCleanup: true })).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('blocks a concurrent terminal-task escape release while cancel is mid-cleanup', async () => {
    const localManager = harness.createManager({ runnerFactory: () => createManagerSuiteRunner() });
    const t = await harness.seedTask({ qaAgentId: 'qa-1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%1' });
    await harness.acquireAgentLock('dev-1');
    await harness.acquireAgentLock('qa-1');

    let escapeReleaseResult: boolean | undefined;
    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async () => {
        if (escapeReleaseResult === undefined) {
          escapeReleaseResult = await localManager.releaseAgentForTask('qa-1', t.id, 'idle');
        }
        return true;
      });

    const cancelled = await localManager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(escapeReleaseResult).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it('cancel of one task does not block a rebound agent release by its new task', async () => {
    const localManager = harness.createManager({ runnerFactory: () => createManagerSuiteRunner() });
    await harness.taskStore.set(makeTask({ id: 'task-old', agentId: 'dev-1', qaAgentId: 'qa-1' }));
    await harness.taskStore.set(makeTask({ id: 'task-new', agentId: 'dev-1' }));
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-new', paneId: '%0' });
    await harness.seedAgent({ id: 'qa-1', taskId: 'task-old', paneId: '%1' });
    await harness.acquireAgentLock('dev-1');
    await harness.acquireAgentLock('qa-1');

    let devReleaseByNewTask: boolean | undefined;
    vi.spyOn(localManager as unknown as { interruptPaneAndWaitReady: () => Promise<boolean> }, 'interruptPaneAndWaitReady')
      .mockImplementation(async () => {
        if (devReleaseByNewTask === undefined) {
          devReleaseByNewTask = await localManager.releaseAgentForTask('dev-1', 'task-new', 'idle');
        }
        return true;
      });

    await localManager.cancelTask('task-old');

    expect(devReleaseByNewTask).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it('a stale cancel does not disturb the cancel-clearing hold of the agent\'s real owner', async () => {
    await harness.taskStore.set(makeTask({ id: 'task-a', agentId: 'dev-1' }));
    await harness.taskStore.set(makeTask({ id: 'task-b', agentId: 'dev-1' }));
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-a', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    await harness.manager.cancelTask('task-b');

    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-a');
    expect(dev?.awaitingPhase).toBe('cancel-clearing');
    expect(await harness.manager.releaseAgentForTask('dev-1', 'task-a', 'idle')).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe('task-a');
  });

  it('Resume releases a stale cancel-clearing hold whose task already reached a terminal status', async () => {
    const t = await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await harness.acquireAgentLock('dev-1');

    const res = await harness.manager.resumeAgent('dev-1');
    expect(res.resumed).toBe(true);
    expect(res.releasedBinding).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('recover() holds a cancel-clearing agent bound to a cancelled task (restart mid-cleanup)', async () => {
    await harness.taskStore.set(makeTask({ id: 'task-x', status: 'cancelled', agentId: 'dev-1' }));
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-x', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await harness.acquireAgentLock('dev-1');
    vi.spyOn(harness.manager as unknown as { ensureSession: () => Promise<{ paneId: string }> }, 'ensureSession')
      .mockResolvedValue({ paneId: '%0' });

    await harness.manager.recover();

    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-x');
    expect(dev?.status).toBe('awaiting_human');
    expect(dev?.awaitingPhase).toBe('cancel-clearing');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });

  it('does not auto-release a cancel-interrupt-failed pane (escape/handler), but Resume can', async () => {
    const t = await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });
    await harness.acquireAgentLock('dev-1');

    expect(await harness.manager.releaseAgentForTask('dev-1', t.id, 'idle', { allowAwaitingHuman: true })).toBe(false);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);

    const res = await harness.manager.resumeAgent('dev-1');
    expect(res.resumed).toBe(true);
    expect(res.releasedBinding).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBeUndefined();
  });

  it('recover() holds a cancel-interrupt-failed agent (restart) instead of auto-releasing it', async () => {
    await harness.taskStore.set(makeTask({ id: 'task-y', status: 'cancelled', agentId: 'dev-1' }));
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-y', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-interrupt-failed' });
    await harness.acquireAgentLock('dev-1');
    vi.spyOn(harness.manager as unknown as { ensureSession: () => Promise<{ paneId: string }> }, 'ensureSession')
      .mockResolvedValue({ paneId: '%0' });

    await harness.manager.recover();

    const dev = await harness.agentStore.get('dev-1');
    expect(dev?.taskId).toBe('task-y');
    expect(dev?.awaitingPhase).toBe('cancel-interrupt-failed');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });
});

describe('interruptPaneAndWaitReady composer recovery', () => {
  function callInterrupt(
    mgr: AgentManager,
    state: AgentBindingFacts,
    cfg: AgentConfig & { projectId: string },
  ): Promise<boolean> {
    return (mgr as unknown as {
      interruptPaneAndWaitReady: (s: AgentBindingFacts, c: AgentConfig & { projectId: string }) => Promise<boolean>;
    }).interruptPaneAndWaitReady(state, cfg);
  }
  function cfgOf(mgr: AgentManager, id: string): AgentConfig & { projectId: string } {
    return (mgr as unknown as {
      getAgentConfig: (id: string) => AgentConfig & { projectId: string };
    }).getAgentConfig(id);
  }
  const INTERRUPT_PANES: Record<string, string> = { 'qa-1': '%7', 'dev-1': '%3' };
  function stubInterruptPanes(): void {
    stubClaimedPaneResolution(id => INTERRUPT_PANES[id] ?? '%0');
  }
  function spyKeys(proc = 'node'): string[] {
    stubInterruptPanes();
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue(proc);
    return keys;
  }
  function spyClearFlow(dirty: string, afterCtrlC: string, opts: { proc?: string; cleanAfterCtrlC?: boolean } = {}): string[] {
    stubInterruptPanes();
    const proc = opts.proc ?? 'node';
    const cleanAfterCtrlC = opts.cleanAfterCtrlC ?? true;
    const keys: string[] = [];
    let cleared = false;
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => {
      keys.push(k);
      if (k === 'C-c') cleared = true;
    });
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue(proc);
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockImplementation(async () => {
      if (cleared && cleanAfterCtrlC) return;
      throw new Error('repl not ready');
    });
    vi.spyOn(TmuxManager.prototype, 'capturePaneById').mockImplementation(async () => (cleared ? afterCtrlC : dirty));
    return keys;
  }

  const STUCK_COMPOSER =
    '› Title: 优化 Agent Pet 样式\n  1. Agent Pet 再放大一点点\n  2. ...\n  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  const BUSY_LOOKING_COMPOSER =
    '› 排查 codex 卡死，日志：\n  • Working (12s)\n  esc to interrupt\n  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  const LONG_COMPOSER_NO_GLYPH =
    'pasted diagnostics line\n'.repeat(14) + '  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  const CLEARED_BARE_PROMPT = '› \n  gpt-5.5 xhigh · ~/.baxian/repos/example-owner/example-repo\n';
  const NODE_HUMAN_SESSION = 'running diagnostics…\n> \n';
  const CLAUDE_DIRTY = '❯ 修复 web terminal 乱码\n';
  const CLAUDE_CLEARED = '❯ \n';
  const RUNNING_TURN_A = '• Working (12s)\n  esc to interrupt\n';
  const RUNNING_TURN_B = '• Working (13s)\n  esc to interrupt\n';
  const CLAUDE_RUN_A = '✶ Grooving… (12s)\n' + 'tool output\n'.repeat(12) + '❯ \n';
  const CLAUDE_RUN_B = '✶ Grooving… (13s)\n' + 'tool output\n'.repeat(12) + '❯ \n';
  const RUNTIME_MENU = 'Select a model\n  Enter to confirm · Esc to cancel\n';
  const GROWING_OUTPUT_A = 'building project…\n  compiled module 1\n';
  const GROWING_OUTPUT_B = 'building project…\n  compiled module 2\n';
  const BLOCKER_OVER_PROMPT = 'Allow command `rm -rf`?\n  Press Enter to confirm or Esc to cancel\n› \n';

  it('C-c clears an un-submitted composer and verifies it reached a clean composer (qa-1: codex)', async () => {
    Object.assign(harness.manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(STUCK_COMPOSER, CLEARED_BARE_PROMPT);

    await harness.seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('qa-1'))!, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('C-c clears a dirty composer whose text contains "Working"/"esc to interrupt"', async () => {
    Object.assign(harness.manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(BUSY_LOOKING_COMPOSER, CLEARED_BARE_PROMPT);

    await harness.seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('qa-1'))!, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('C-c clears a LONG composer whose `›` scrolled off — verified by the OUTCOME, not a visible glyph', async () => {
    Object.assign(harness.manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(LONG_COMPOSER_NO_GLYPH, CLEARED_BARE_PROMPT);

    await harness.seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('qa-1'))!, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('C-c clears a Claude dirty composer and verifies the empty ❯ prompt (dev-1: claude-code)', async () => {
    Object.assign(harness.manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(CLAUDE_DIRTY, CLAUDE_CLEARED, { proc: 'claude' });

    await harness.seedAgent({ id: 'dev-1', paneId: '%3' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('dev-1'))!, cfgOf(harness.manager, 'dev-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('holds (no C-c) when a turn is genuinely still running after ESC (screen changes between grabs)', async () => {
    Object.assign(harness.manager, { runtimeLivenessProbeMs: 1 });
    const keys = spyKeys();
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById')
      .mockResolvedValueOnce(RUNNING_TURN_A)
      .mockResolvedValueOnce(RUNNING_TURN_B);

    await harness.seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('qa-1'))!, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
  });

  it('holds (no C-c) on a real running Claude turn whose high spinner advances between grabs (dev-1)', async () => {
    Object.assign(harness.manager, { runtimeLivenessProbeMs: 1 });
    const keys = spyKeys('claude');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById')
      .mockResolvedValueOnce(CLAUDE_RUN_A)
      .mockResolvedValueOnce(CLAUDE_RUN_B);

    await harness.seedAgent({ id: 'dev-1', paneId: '%3' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('dev-1'))!, cfgOf(harness.manager, 'dev-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
  });

  it('holds (no C-c) when the pane is no longer running the runtime (crashed to shell)', async () => {
    const keys = spyKeys('zsh');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    const captureSpy = vi.spyOn(TmuxManager.prototype, 'capturePaneById');

    await harness.seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('qa-1'))!, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('re-checks proc title right before C-c: holds (no C-c) if the runtime crashed to a shell during the liveness window', async () => {
    Object.assign(harness.manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    stubInterruptPanes();
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    vi.spyOn(TmuxManager.prototype, 'displayMessage')
      .mockResolvedValueOnce('node')
      .mockResolvedValue('zsh');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    const captureSpy = vi.spyOn(TmuxManager.prototype, 'capturePaneById')
      .mockResolvedValue('idle diagnostics output\n  gpt-5.5 xhigh · ~/repo\n');

    await harness.seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('qa-1'))!, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
    expect(captureSpy).toHaveBeenCalled();
  });

  it('holds (no C-c) when the screen is static but the OSC braille title ADVANCES across samples (live turn)', async () => {
    Object.assign(harness.manager, { runtimeLivenessProbeMs: 1 });
    stubInterruptPanes();
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue('node');
    vi.spyOn(TmuxManager.prototype, 'readPaneTitle')
      .mockResolvedValueOnce('⠋ Working')
      .mockResolvedValue('⠙ Working');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById').mockResolvedValue('quiet build output\n  no spinner here\n');

    await harness.seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('qa-1'))!, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
  });

  it('does NOT treat a STALE static working-shaped OSC title as live — C-c proceeds (else cancel-interrupt-failed)', async () => {
    Object.assign(harness.manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(STUCK_COMPOSER, CLEARED_BARE_PROMPT);
    vi.spyOn(TmuxManager.prototype, 'readPaneTitle').mockResolvedValue('⠹ Working');

    await harness.seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('qa-1'))!, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('an ADVANCING OSC title is live even when the screen momentarily shows a ready-looking prompt', async () => {
    Object.assign(harness.manager, { runtimeLivenessProbeMs: 1 });
    stubInterruptPanes();
    const keys: string[] = [];
    vi.spyOn(TmuxManager.prototype, 'sendKeysToPane').mockImplementation(async (_p, k) => { keys.push(k); });
    vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue('node');
    vi.spyOn(TmuxManager.prototype, 'readPaneTitle')
      .mockResolvedValueOnce('⠋ Working')
      .mockResolvedValue('⠙ Working');
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById').mockResolvedValue('› \n');

    await harness.seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('qa-1'))!, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
  });

  it('holds AFTER one C-c when a human `node` session never becomes a Codex composer (`>` ≠ `›`)', async () => {
    Object.assign(harness.manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(NODE_HUMAN_SESSION, NODE_HUMAN_SESSION, { cleanAfterCtrlC: false });

    await harness.seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('qa-1'))!, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('holds AFTER C-c when a runtime menu does not dismiss to a clean composer', async () => {
    Object.assign(harness.manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(RUNTIME_MENU, RUNTIME_MENU, { cleanAfterCtrlC: false });

    await harness.seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('qa-1'))!, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('holds (no C-c) on a live turn with NO busy marker — sampled for change, not gated on busy markers', async () => {
    Object.assign(harness.manager, { runtimeLivenessProbeMs: 1 });
    const keys = spyKeys();
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(new Error('repl not ready'));
    vi.spyOn(TmuxManager.prototype, 'capturePaneById')
      .mockResolvedValueOnce(GROWING_OUTPUT_A)
      .mockResolvedValueOnce(GROWING_OUTPUT_B);

    await harness.seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('qa-1'))!, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape']);
  });

  it('holds AFTER C-c when a bare `›` still sits under a permission/confirm blocker', async () => {
    Object.assign(harness.manager, { runtimeLivenessProbeMs: 1, cleanComposerWaitMs: 20 });
    const keys = spyClearFlow(BLOCKER_OVER_PROMPT, BLOCKER_OVER_PROMPT, { cleanAfterCtrlC: false });

    await harness.seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('qa-1'))!, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual(['Escape', 'C-c']);
  });

  it('holds (cancel-interrupt-failed) without sending keys when the pane mutex stays busy past the wait window', async () => {
    Object.assign(harness.manager, { cancelInterruptGuardWaitMs: 30, compactIdlePollMs: 5 });
    const keys = spyKeys();
    (harness.manager as unknown as { compactInFlight: Set<string> }).compactInFlight.add('qa-1');
    await harness.seedAgent({ id: 'qa-1', taskId: 'tBusy', paneId: '%7', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('qa-1'))!, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(false);
    expect(keys).toEqual([]);
    expect((await harness.agentStore.get('qa-1'))?.awaitingPhase).toBe('cancel-interrupt-failed');
  });

  it('waits for a busy pane mutex and proceeds once the in-flight dispatch releases it (no instant hold)', async () => {
    Object.assign(harness.manager, { cancelInterruptGuardWaitMs: 2_000, compactIdlePollMs: 5 });
    const keys = spyKeys();
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockResolvedValue(undefined);
    const inFlight = (harness.manager as unknown as { compactInFlight: Set<string> }).compactInFlight;
    inFlight.add('qa-1');
    setTimeout(() => inFlight.delete('qa-1'), 25);

    await harness.seedAgent({ id: 'qa-1', paneId: '%7' });
    const ok = await callInterrupt(harness.manager, (await harness.agentStore.get('qa-1'))!, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape']);
  });

  it('returns ready on ESC alone, without capturing or escalating, when the pane is already idle', async () => {
    const keys = spyKeys();
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockResolvedValue(undefined);
    const captureSpy = vi.spyOn(TmuxManager.prototype, 'capturePaneById');

    await harness.seedAgent({ id: 'qa-1', paneId: '%7' });
    const state = (await harness.agentStore.get('qa-1'))!;
    const ok = await callInterrupt(harness.manager, state, cfgOf(harness.manager, 'qa-1'));

    expect(ok).toBe(true);
    expect(keys).toEqual(['Escape']);
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('injectAndAwaitAck aborts a dispatch whose bound task went terminal while waiting for the pane mutex', async () => {
    const t = await harness.seedTask({ status: 'cancelled' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const tmux = new TmuxManager(createManagerSuiteRunner());
    await expect(
      callInjectAndAwaitAck(harness.manager, tmux, '%0', 'prompt', 'dev-1', 'claude-code'),
    ).rejects.toThrow(/went terminal/);
  });

  it('injectAndAwaitAck aborts when cancel marked the agent cancel-clearing before the task flips terminal', async () => {
    const t = await harness.seedTask({ status: 'in_progress' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    const tmux = new TmuxManager(createManagerSuiteRunner());
    await expect(
      callInjectAndAwaitAck(harness.manager, tmux, '%0', 'prompt', 'dev-1', 'claude-code'),
    ).rejects.toThrow(/taken over by cancel/);
  });

  it('injectAndAwaitAck re-checks after the task read: aborts before paste if cancel lands during taskStore.get', async () => {
    const t = await harness.seedTask({ status: 'in_progress' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id: string) => {
      await harness.agentStore.update('dev-1', (s) => (s ? { ...s, status: 'awaiting_human', awaitingPhase: 'cancel-clearing' } : AGENT_STORE_NOOP));
      return realGet(id);
    });
    const tmux = new TmuxManager(createManagerSuiteRunner());
    await expect(
      callInjectAndAwaitAck(harness.manager, tmux, '%0', 'prompt', 'dev-1', 'claude-code'),
    ).rejects.toThrow(/taken over by cancel before paste/);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('injectTextToAgent re-checks after the task read: aborts before paste if cancel lands during taskStore.get', async () => {
    const t = await harness.seedTask({ status: 'in_progress' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('qa-1', t.id);
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id: string) => {
      await harness.agentStore.update('qa-1', (s) => (s ? { ...s, status: 'awaiting_human', awaitingPhase: 'cancel-clearing' } : AGENT_STORE_NOOP));
      return realGet(id);
    });
    await expect(
      harness.manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: t.id }),
    ).rejects.toThrow(/taken over by cancel before paste/);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('injectTextToAgent aborts before paste when a DELETE→recreate bumps the generation during pane resolution', async () => {
    const t = await harness.seedTask({ id: 'task-rf-aba', status: 'in_progress' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('qa-1', t.id);
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    vi.spyOn(harness.manager as unknown as { resolveClaimedPane: (...a: unknown[]) => Promise<unknown> }, 'resolveClaimedPane')
      .mockImplementation(async () => {
        harness.manager.bumpDeletionGeneration('qa-1');
        return { session: { sessionId: '$1', serverPid: '4242', serverStart: '1700000000' }, paneId: '%0', claim: 'qa-1' };
      });
    await expect(
      harness.manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: t.id }),
    ).rejects.toThrow(/deleted or recreated before paste/);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('cleanupRemovedAgentRuntime bounds every tmux probe/kill with a deadline (no unbounded hang holding the tombstone)', async () => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%5' });
    const timeouts: Array<number | undefined> = [];
    vi.spyOn(harness.manager as unknown as { createRunnerFor: (a: unknown) => CommandRunner }, 'createRunnerFor')
      .mockReturnValue({
        exec: vi.fn(async (cmd: string, o?: { timeout?: number }) => {
          timeouts.push(o?.timeout);
          if (cmd.includes('list-sessions')) return { stdout: '4242|1700000000|$1|dev-1\n', stderr: '', exitCode: 0 };
          return { stdout: '', stderr: '', exitCode: 0 };
        }),
        writeFile: vi.fn(async () => {}),
      } as unknown as CommandRunner);

    await harness.manager.cleanupRemovedAgentRuntime(['dev-1']);

    expect(timeouts.filter(t => t !== undefined).length).toBeGreaterThanOrEqual(2);
    expect(timeouts.filter(t => t !== undefined).every(t => t === 15_000)).toBe(true);
  });

  it('injectTextToAgent refuses to inject into a pane held by cancel cleanup', async () => {
    await harness.seedTask({ id: 'task-rf-hold', status: 'in_progress' });
    await harness.seedAgent({ id: 'qa-1', taskId: 'task-rf-hold', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await expect(
      harness.manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: 'task-rf-hold' }),
    ).rejects.toThrow(/taken over by cancel/);
  });

  it('injectTextToAgent refuses to inject when the bound task is already terminal', async () => {
    const t = await harness.seedTask({ id: 'task-rf-terminal', status: 'cancelled' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('qa-1', t.id);
    await expect(
      harness.manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: t.id }),
    ).rejects.toThrow(/terminal/);
  });

  it('injectTextToAgent refuses a newer lock generation for the same task', async () => {
    const t = await harness.seedTask({ id: 'task-rf-rebound', status: 'in_progress' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0' });
    const oldToken = await harness.acquireAgentLock('qa-1', t.id);
    expect(oldToken).toBeTruthy();
    await harness.agentStore.update('qa-1', state => ({ ...state!, lockToken: oldToken!, updatedAt: NOW }));
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id: string) => {
      await harness.lockManager.releaseIfOwner('qa-1', t.id, oldToken!);
      const newToken = await harness.lockManager.acquire('qa-1', t.id);
      expect(newToken).toBeTruthy();
      await harness.agentStore.update('qa-1', state => ({ ...state!, lockToken: newToken!, updatedAt: NOW }));
      return realGet(id);
    });

    await expect(
      harness.manager.injectTextToAgent('qa-1', 'stale file body', { expectedTaskId: t.id }),
    ).rejects.toThrow(/exclusive lock changed/);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('attachImageToRunningAgent refuses to paste into a pane held by cancel cleanup', async () => {
    await harness.seedTask({ id: 'task-img-hold', status: 'in_progress' });
    await harness.seedAgent({ id: 'qa-1', taskId: 'task-img-hold', paneId: '%0', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await expect(
      harness.manager.attachImageToRunningAgent('qa-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/being cancelled/);
  });

  it('attachImageToRunningAgent refuses when the bound task is already terminal', async () => {
    const t = await harness.seedTask({ id: 'task-img-terminal', status: 'cancelled' });
    await harness.seedAgent({ id: 'qa-1', taskId: t.id, paneId: '%0' });
    await expect(
      harness.manager.attachImageToRunningAgent('qa-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/terminal/);
  });

  it('attachImageToRunningAgent re-checks cancel state AFTER the slow host write — refuses the paste if cancel landed', async () => {
    await harness.seedTask({ id: 'task-img-toctou', status: 'in_progress' });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-img-toctou', paneId: '%0' });
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    const localManager = harness.createManager({
      runnerFactory: () => ({
        exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
        writeFile: vi.fn(async () => {
          await harness.agentStore.update('dev-1', (s) => (s ? { ...s, status: 'awaiting_human', awaitingPhase: 'cancel-clearing' } : AGENT_STORE_NOOP));
        }),
      } as unknown as CommandRunner),
    });

    await expect(
      localManager.attachImageToRunningAgent('dev-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/being cancelled/);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('attachImageToRunningAgent re-checks the cancel hold AFTER its task read (closes the assertUploadStillValid gap)', async () => {
    await harness.seedTask({ id: 'task-img-taskgap', status: 'in_progress' });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-img-taskgap', paneId: '%0' });
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined as unknown as void);
    const realGet = harness.taskStore.get.bind(harness.taskStore);
    vi.spyOn(harness.taskStore, 'get').mockImplementation(async (id: string) => {
      await harness.agentStore.update('dev-1', (s) => (s ? { ...s, status: 'awaiting_human', awaitingPhase: 'cancel-clearing' } : AGENT_STORE_NOOP));
      return realGet(id);
    });
    const localManager = harness.createManager({
      runnerFactory: () => ({
        exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
        writeFile: vi.fn(async () => undefined),
        execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
      } as unknown as CommandRunner),
    });
    await expect(
      localManager.attachImageToRunningAgent('dev-1', Buffer.from('img'), 'png'),
    ).rejects.toThrow(/being cancelled/);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('cancel-interrupt guard wait is derived from the configured dispatch ack timeout (not the default)', () => {
    const m = harness.createManager({ dispatchAckTimeoutMs: 60_000 }) as unknown as {
      cancelInterruptGuardWaitMs: number; dispatchAckTimeoutMs: number;
    };
    expect(m.dispatchAckTimeoutMs).toBe(60_000);
    expect(m.cancelInterruptGuardWaitMs).toBeGreaterThanOrEqual(60_000);
  });

  it('markAwaitingHuman does not let a generic hold overwrite a cancel-cleanup hold', async () => {
    await harness.seedAgent({ id: 'dev-1', taskId: 'tX', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });

    await harness.manager.markAwaitingHuman('dev-1', 'code-dispatch-failed', 'generic dispatch failure');
    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clearing');

  });

  it('markAwaitingHuman still allows the escalation cancel-clearing → cancel-interrupt-failed', async () => {
    await harness.seedAgent({ id: 'dev-1', taskId: 'tX', status: 'awaiting_human', awaitingPhase: 'cancel-clearing' });
    await harness.manager.markAwaitingHuman('dev-1', 'cancel-interrupt-failed', 'interrupt failed');
    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-interrupt-failed');
  });

  it('markPaneCancelClearing still sets cancel-clearing from a non-hold binding (initial cancel)', async () => {
    await harness.seedAgent({ id: 'dev-1', taskId: 'tX', paneId: '%0' });
    await (harness.manager as unknown as { markPaneCancelClearing: (a: string, t: string) => Promise<void> })
      .markPaneCancelClearing('dev-1', 'tX');
    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('cancel-clearing');
  });

  it('cancel-interrupt guard wait covers the dispatch ack window (so cancel-during-ack is not dropped to hold)', () => {
    const m = harness.manager as unknown as { cancelInterruptGuardWaitMs: number; dispatchAckTimeoutMs: number };
    expect(m.cancelInterruptGuardWaitMs).toBeGreaterThanOrEqual(m.dispatchAckTimeoutMs);
  });
});

describe('AgentManager.cancelTask release failure tolerance', () => {
  it('logs but completes the cancel when releaseAgentForTask throws', async () => {
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    harness.mockInterruptPane(harness.manager, true);
    vi.spyOn(harness.manager, 'releaseAgentForTask').mockRejectedValue(new Error('release exploded'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const cancelled = await harness.manager.cancelTask(t.id);

    expect(cancelled.status).toBe('cancelled');
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('releaseAgentForTask'))).toBe(true);
    errSpy.mockRestore();
  });
});
