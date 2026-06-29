import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianConfig, BaxianEvent } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import { AgentManager, EnsureSessionError, DispatchTerminalError } from '../../src/agent/manager.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { initStateDir } from '../../src/state/init.js';
import type { PhaseSignalWatcher } from '../../src/agent/phase-signal-watcher.js';

const NOW = '2026-05-14T05:00:00.000Z';

const CONFIG: BaxianConfig = {
  review: { rounds: 10 },
  server: DEFAULT_SERVER_CONFIG,
  project: [{
    id: 'proj',
    repo: 'owner/repo',
    merge: null,
    agent: [[
      { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo', yolo: true },
    ]],
  }],
};

let tempDir: string;
let manager: AgentManager;
let agentStore: AgentStore;
let lockManager: LockManager;
const events: BaxianEvent[] = [];

function runner(): CommandRunner {
  return {
    exec: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    writeFile: vi.fn(async (): Promise<void> => undefined),
  };
}

// recover() now runs its re-greet in the background (so server startup is not blocked); poll for the
// resulting state instead of asserting synchronously right after recover() returns.
async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor: condition not met within timeout');
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-bootstrap-test-'));
  await initStateDir(tempDir);

  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  const taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  lockManager = new LockManager(join(tempDir, 'locks'));
  const eventBus = new EventBus(new EventLog(join(tempDir, 'events')));
  events.length = 0;
  eventBus.on('*', (event) => { events.push(event); });

  manager = new AgentManager({
    config: CONFIG,
    agentStore,
    taskStore,
    lockManager,
    eventBus,
    skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
    runnerFactory: () => runner(),
  });

  await agentStore.set({
    id: 'dev-1',
    projectId: 'proj',
    creationToken: 'token-abc',
    updatedAt: NOW,
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('AgentManager.startBootstrapAsync', () => {
  it('success records paneId and clears the creation token', async () => {
    const ensureSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: true,
      paneId: '%0',
      workdir: '/tmp/repo',
    });

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    expect(ensureSpy).toHaveBeenCalledWith('dev-1', 'create');
    const state = await agentStore.get('dev-1');
    expect(state).toMatchObject({ id: 'dev-1', projectId: 'proj', paneId: '%0' });
    expect(state?.creationToken).toBeUndefined();
    expect('status' in (state as object)).toBe(false);
    expect('sessionStatus' in (state as object)).toBe(false);
    expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(true);
  });

  it('success clears stale dialog Held fields from an earlier pending bootstrap', async () => {
    await agentStore.update('dev-1', (state) => state ? {
      ...state,
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
      awaitingReason: 'startup dialog',
      awaitingSince: NOW,
    } : null);
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: true,
      paneId: '%0',
      workdir: '/tmp/repo',
    });

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.status).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    expect(state?.awaitingReason).toBeUndefined();
    expect(state?.awaitingSince).toBeUndefined();
  });

  it('hard failure clears the creation token and emits bootstrap_failed', async () => {
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError(
        { createdSession: true, agentId: 'dev-1', lastScreen: 'still booting...' },
        'buildFreshSession failed: repl not ready',
      ),
    );

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBeUndefined();
    expect(state?.creationToken).toBeUndefined();
    expect(events.some(e =>
      e.type === 'agent.bootstrap_failed'
      && String(e.data.error).includes('repl not ready'),
    )).toBe(true);
  });

  it('dialog-pending bootstrap keeps the creation token and asks for human intervention', async () => {
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError(
        {
          createdSession: true,
          agentId: 'dev-1',
          dialogPending: true,
          lastScreen: 'Welcome to Codex\nSign in with ChatGPT\nProvide your own API key',
        },
        'buildFreshSession failed: repl not ready',
      ),
    );
    const slowPollSpy = vi
      .spyOn(manager as unknown as {
        slowPollDialogPending: (id: string, token: string | undefined) => Promise<void>;
      }, 'slowPollDialogPending')
      .mockResolvedValue(undefined);

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBe('token-abc');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('agent_dialog_pending');
    expect(events.some(e =>
      e.type === 'human.intervention'
      && e.agentId === 'dev-1'
      && e.data.phase === 'agent_dialog_pending',
    )).toBe(true);
    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
    expect(slowPollSpy).toHaveBeenCalledWith('dev-1', 'token-abc');
  });

  it('stale bootstrap completion cannot clear a newer creation token', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      creationToken: 'token-new',
      updatedAt: NOW,
    });
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: true,
      paneId: '%0',
      workdir: '/tmp/repo',
    });

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBe('token-new');
    expect(state?.paneId).toBeUndefined();
  });
});

describe('AgentManager greeting capability gate', () => {
  // The base manager has no phaseSignalWatcher, so greeting is skipped there. These build a
  // manager WITH a mock watcher to exercise the gate, stubbing the low-level pane inject.
  function makeManagerWithWatcher(awaitOnce: ReturnType<typeof vi.fn>) {
    const localEvents: BaxianEvent[] = [];
    const taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
    const eventBus = new EventBus(new EventLog(join(tempDir, 'events')));
    eventBus.on('*', (event) => { localEvents.push(event); });
    const phaseSignalWatcher = { awaitOnce } as unknown as PhaseSignalWatcher;
    const mgr = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry: new SkillRegistry(join(tempDir, 'skills')),
      runnerFactory: () => runner(),
      phaseSignalWatcher,
    });
    vi.spyOn(mgr, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: true, paneId: '%0', workdir: '/tmp/repo',
    });
    const injectSpy = vi.spyOn(mgr as unknown as {
      injectAndAwaitAckSteps: (...a: unknown[]) => Promise<unknown>;
    }, 'injectAndAwaitAckSteps').mockResolvedValue({ acked: true, composerDelivered: true });
    return { mgr, localEvents, injectSpy };
  }

  it('goes ready and clears the creation token when the agent echoes a valid greeting', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('matched');
    const { mgr, localEvents, injectSpy } = makeManagerWithWatcher(awaitOnce);

    await mgr.startBootstrapAsync('dev-1', 'token-abc');

    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.status).toBeUndefined();
    expect(state?.paneId).toBe('%0');
    expect(localEvents.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(true);
    // One inject, awaiting a greeting-kind signal, via the skill (prose) path.
    expect(injectSpy).toHaveBeenCalledTimes(1);
    expect(awaitOnce).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'dev-1', kind: 'greeting' }));
    expect(String(injectSpy.mock.calls[0][2])).toContain('baxian-greeting');
  });

  it('holds the agent as awaiting_human (greeting_failed) when greeting never verifies', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('timeout');
    const { mgr, localEvents } = makeManagerWithWatcher(awaitOnce);

    await mgr.startBootstrapAsync('dev-1', 'token-abc');

    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('greeting_failed');
    expect(localEvents.some(e =>
      e.type === 'human.intervention' && e.data.phase === 'greeting_failed',
    )).toBe(true);
    expect(localEvents.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(false);
    // Retries up to greetingMaxAttempts before giving up.
    expect(awaitOnce).toHaveBeenCalledTimes(2);
    // A held agent is not dispatchable.
    expect(await mgr.pickAgent('proj', 'dev-1')).toBeNull();
  });

  it('retries on session-gone (a transient subscribe fault must not fail a capable agent)', async () => {
    // First attempt loses the subscription, second verifies — agent should end up ready.
    const awaitOnce = vi.fn()
      .mockResolvedValueOnce('session-gone')
      .mockResolvedValueOnce('matched');
    const { mgr } = makeManagerWithWatcher(awaitOnce);

    await mgr.startBootstrapAsync('dev-1', 'token-abc');

    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.status).toBeUndefined();
    expect(awaitOnce).toHaveBeenCalledTimes(2);
  });

  it('does not wait for the signal when the greeting paste fails — it retries the paste', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('matched');
    const { mgr, injectSpy } = makeManagerWithWatcher(awaitOnce);
    // Inject fails every attempt → agent never echoes; awaitOnce must never be armed.
    injectSpy.mockRejectedValue(new Error('pane busy'));

    await mgr.startBootstrapAsync('dev-1', 'token-abc');

    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect(injectSpy).toHaveBeenCalledTimes(2);
    expect(awaitOnce).not.toHaveBeenCalled();
  });

  it('holds without retrying when the greeting paste fails ack_unknown (unconfirmed composer)', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('matched');
    const { mgr, injectSpy } = makeManagerWithWatcher(awaitOnce);
    // ack_unknown = composer could not be confirmed clean; a second paste would land on unsafe input.
    injectSpy.mockRejectedValue(new DispatchTerminalError('ack_unknown', 'pre-ack failure'));

    await mgr.startBootstrapAsync('dev-1', 'token-abc');

    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect(injectSpy).toHaveBeenCalledTimes(1); // NO second paste onto the unconfirmed composer
    expect(awaitOnce).not.toHaveBeenCalled();
  });

  it('only kills the orphan session (no greeting_failed hold) when creationToken rotates mid-greeting', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('timeout');
    const { mgr } = makeManagerWithWatcher(awaitOnce);
    // A newer create rotates the token while greeting is still timing out.
    await agentStore.update('dev-1', (s) => s ? { ...s, creationToken: 'token-newer' } : null);

    await mgr.startBootstrapAsync('dev-1', 'token-abc');

    const state = await agentStore.get('dev-1');
    // The stale generation must NOT overwrite the newer one with a greeting_failed hold.
    expect(state?.creationToken).toBe('token-newer');
    expect(state?.awaitingPhase).not.toBe('greeting_failed');
  });

  it('recover() preserves a greeting_failed hold instead of releasing it to ok', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('matched');
    const { mgr } = makeManagerWithWatcher(awaitOnce);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed',
      awaitingReason: 'cap fail', awaitingSince: NOW, updatedAt: NOW,
    });

    await mgr.recover();

    const state = await agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('greeting_failed');
    // A held, unverified agent must stay non-dispatchable after a restart.
    expect(await mgr.pickAgent('proj', 'dev-1')).toBeNull();
  });

  it('recover() re-greets an incomplete bootstrap (creationToken set, no task) → ready on pass', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('matched');
    const { mgr } = makeManagerWithWatcher(awaitOnce);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', creationToken: 'tok-crash', updatedAt: NOW });

    await mgr.recover();
    // Re-greet runs in the background; wait for it to clear the token to 'ready'.
    await waitFor(async () => (await agentStore.get('dev-1'))?.creationToken === undefined);

    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.status).toBeUndefined();
    expect(awaitOnce).toHaveBeenCalledWith(expect.objectContaining({ kind: 'greeting' }));
  });

  it('recover() holds an incomplete bootstrap that fails its re-greet', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('timeout');
    const { mgr } = makeManagerWithWatcher(awaitOnce);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', creationToken: 'tok-crash', updatedAt: NOW });

    await mgr.recover();
    // Re-greet runs in the background; wait for the failure to land the greeting_failed hold.
    await waitFor(async () => (await agentStore.get('dev-1'))?.awaitingPhase === 'greeting_failed');

    const state = await agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('greeting_failed');
  });

  it('regreetHeldAgent clears the hold when the re-greet passes', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('matched');
    const { mgr } = makeManagerWithWatcher(awaitOnce);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW, updatedAt: NOW,
    });

    expect(await mgr.regreetHeldAgent('dev-1')).toBe(true);

    const state = await agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
  });

  it('regreetHeldAgent keeps the hold when the re-greet fails', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('timeout');
    const { mgr } = makeManagerWithWatcher(awaitOnce);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW, updatedAt: NOW,
    });

    await mgr.regreetHeldAgent('dev-1');

    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('greeting_failed');
  });

  it('regreetHeldAgent does not clear a binding that was recreated mid-handshake (generation guard)', async () => {
    // A DELETE+recreate lands a new generation (creationToken set, no greeting_failed) while the
    // handshake is still running; the stale regreet must NOT clear it.
    const awaitOnce = vi.fn().mockImplementation(async () => {
      await agentStore.set({ id: 'dev-1', projectId: 'proj', creationToken: 'tok-new', updatedAt: 'LATER' });
      return 'matched';
    });
    const { mgr } = makeManagerWithWatcher(awaitOnce);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW, updatedAt: NOW,
    });

    await mgr.regreetHeldAgent('dev-1');

    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBe('tok-new');
    expect(state?.awaitingPhase).toBeUndefined();
  });

  // NOTE: slowPollDialogPending's bootstrap path also runs the greeting gate (manager.ts) — a direct
  // mirror of startBootstrapAsync's gate covered above. It is not unit-tested here on purpose: driving
  // the private while-loop needs a global setTimeout swap + a waitReplReady prototype spy, which races
  // under CI coverage load (busy-spin → timeout). The mirrored logic is what the gate tests above pin.

  it('Resume refuses a greeting_failed hold — capability must be re-proven, not overridden', async () => {
    const { mgr } = makeManagerWithWatcher(vi.fn().mockResolvedValue('matched'));
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW, updatedAt: NOW,
    });

    const res = await mgr.resumeAgent('dev-1');

    expect(res.resumed).toBe(false);
    const state = await agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('greeting_failed');
    // Still not dispatchable — Resume did not slip it into the pool.
    expect(await mgr.pickAgent('proj', 'dev-1')).toBeNull();
  });

  it('markDialogPending does not overwrite a greeting_failed hold (no downgrade to a dialog phase)', async () => {
    const { mgr } = makeManagerWithWatcher(vi.fn());
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW, updatedAt: NOW,
    });

    await (mgr as unknown as {
      markDialogPending: (id: string, tok: string | undefined) => Promise<void>;
    }).markDialogPending('dev-1', undefined);

    // The hold must stay greeting_failed — else a dialog-collision would let Resume release it.
    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('greeting_failed');
  });

  it('reconcileFailedAgent preserves a greeting_failed hold on tmux-absent (does not wipe to idle)', async () => {
    const { mgr } = makeManagerWithWatcher(vi.fn());
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW, updatedAt: NOW,
    });

    expect(await mgr.reconcileFailedAgent('dev-1')).toBe(false);

    const state = await agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('greeting_failed');
    expect(state?.paneId).toBe('%0');
    // A transient tmux absence must not turn an unverified agent back into a dispatch candidate.
    expect(await mgr.pickAgent('proj', 'dev-1')).toBeNull();
  });
});

describe('AgentManager binding gates', () => {
  it('blocks dispatch while an agent is being created', async () => {
    expect(await manager.pickAgent('proj', 'dev-1')).toBeNull();
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(false);
    expect(await lockManager.isLocked('dev-1')).toBe(false);
  });

  it('allows dispatch once creationToken is cleared and no task is bound', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
    expect(await manager.pickAgent('proj', 'dev-1')).toMatchObject({ id: 'dev-1' });
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-1');
  });

  it('blocks dispatch while another task is bound', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-busy', updatedAt: NOW });
    expect(await manager.pickAgent('proj', 'dev-1')).toBeNull();
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(false);
  });
});

describe('AgentManager.waitForBootstrapSettled', () => {
  it('resolves when creationToken clears', async () => {
    setTimeout(() => {
      void agentStore.update('dev-1', (state) => state ? {
        ...state,
        creationToken: undefined,
        updatedAt: new Date().toISOString(),
      } : null);
    }, 10);

    await expect(manager.waitForBootstrapSettled('dev-1', 500)).resolves.toBeUndefined();
  });

  it('resolves when the agent row is removed', async () => {
    setTimeout(() => {
      void agentStore.delete('dev-1');
    }, 10);

    await expect(manager.waitForBootstrapSettled('dev-1', 500)).resolves.toBeUndefined();
  });

  it('throws when creationToken never clears', async () => {
    await expect(manager.waitForBootstrapSettled('dev-1', 50)).rejects.toThrow(/timed out/);
  });
});

describe('AgentManager.slowPollDialogPending (no hard-fail timeout)', () => {
  const TOKEN = 'token-abc';

  it('no longer hard-fails after 10 minutes when the dialog stays unresolved', async () => {
    // Date.now 合成推进：真实等 10 分钟在 CI 不现实。
    await agentStore.update('dev-1', (s) => s ? {
      ...s,
      creationToken: TOKEN,
      updatedAt: NOW,
    } : null);

    const failSpy = vi.spyOn(manager, 'failTasksForAgent').mockResolvedValue({ failedCount: 0, releasedPartners: 0 });
    const releaseSpy = vi.spyOn(lockManager, 'release');
    const realSetTimeout = globalThis.setTimeout;
    const fastSetTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof globalThis.setTimeout;
    globalThis.setTimeout = fastSetTimeout;
    const realDateNow = Date.now;
    let simNow = realDateNow();
    Date.now = () => simNow;
    let iterations = 0;
    const realGet = agentStore.get.bind(agentStore);
    const realSet = agentStore.set.bind(agentStore);
    const getSpy = vi.spyOn(agentStore, 'get').mockImplementation(async (id: string) => {
      iterations++;
      simNow += 5 * 60_000;
      if (iterations === 200) {
        const cur = await realGet(id);
        if (cur) await realSet({ ...cur, creationToken: 'token-force-exit', updatedAt: new Date().toISOString() });
      }
      return realGet(id);
    });
    try {
      await (manager as unknown as {
        slowPollDialogPending: (id: string, token: string) => Promise<void>;
      }).slowPollDialogPending('dev-1', TOKEN);

      expect(failSpy).not.toHaveBeenCalled();
      expect(releaseSpy).not.toHaveBeenCalled();
      expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
      expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(false);
    } finally {
      Date.now = realDateNow;
      getSpy.mockRestore();
      failSpy.mockRestore();
      releaseSpy.mockRestore();
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('exits cleanly when creationToken is cleared mid-flight (DELETE/recreate)', async () => {
    // 确认 generational guard 在 slowPoll 上下文中也生效（startBootstrapAsync 之外的独立入口）。
    await agentStore.update('dev-1', (s) => s ? {
      ...s,
      paneId: '%0',
      creationToken: 'token-newer',
      updatedAt: NOW,
    } : null);

    const realSetTimeout = globalThis.setTimeout;
    const fastSetTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof globalThis.setTimeout;
    globalThis.setTimeout = fastSetTimeout;
    try {
      await (manager as unknown as {
        slowPollDialogPending: (id: string, token: string) => Promise<void>;
      }).slowPollDialogPending('dev-1', TOKEN);

      expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
      expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(false);
      expect((await agentStore.get('dev-1'))?.creationToken).toBe('token-newer');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('recovers a runtime dialog after the tmux pane was recreated (stale stored paneId)', async () => {
    // Held on agent_dialog_pending (runtime path: no creationToken, no taskId) with a paneId that
    // points at a pane the session no longer owns — the runtime relaunched into a fresh pane that is
    // already at a ready REPL. slowPoll must follow the session's live pane, not the dead snapshot.
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
      awaitingReason: 'startup dialog',
      awaitingSince: NOW,
      paneId: '%old',
      updatedAt: NOW,
    });

    const READY_CODEX = [
      '>_ OpenAI Codex (v0.142.3)',
      'model:       gpt-5.5 xhigh',
      'directory:   ~/repo',
      'permissions: YOLO mode',
      '',
      '› ',
    ].join('\n');

    const dispatchRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('list-panes')) {
          return { stdout: '%new node\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('%old')) {
          return { stdout: '', stderr: "can't find pane: %old", exitCode: 1 };
        }
        if (cmd.includes('display-message') && cmd.includes('%new')) {
          return { stdout: 'node\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane') && cmd.includes('%new')) {
          return { stdout: READY_CODEX, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
    };

    vi.spyOn(manager as unknown as {
      createRunnerFor: (agent: unknown) => CommandRunner;
    }, 'createRunnerFor').mockReturnValue(dispatchRunner);
    vi.spyOn(manager, 'getAgentConfig').mockReturnValue({
      id: 'dev-1',
      projectId: 'proj',
      runtime: 'codex',
      role: 'dev',
      mode: 'local',
      workdir: '/tmp/repo',
      yolo: true,
    });

    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof globalThis.setTimeout;
    // Force-exit guard: the buggy code polls the dead %old forever, so cap the loop instead of hanging.
    const realGet = agentStore.get.bind(agentStore);
    let polls = 0;
    const getSpy = vi.spyOn(agentStore, 'get').mockImplementation(async (id: string) => {
      polls++;
      if (polls > 12) await agentStore.delete(id);
      return realGet(id);
    });
    try {
      await (manager as unknown as {
        slowPollDialogPending: (
          id: string,
          token: string | undefined,
          opts: { expectedPaneId?: string; expectedTaskId?: string },
        ) => Promise<void>;
      }).slowPollDialogPending('dev-1', undefined, { expectedPaneId: '%old', expectedTaskId: undefined });

      const state = await realGet('dev-1');
      expect(state?.awaitingPhase).toBe('agent_dialog_resolved_runtime');
      expect(state?.paneId).toBe('%new');
      expect(events.some(e =>
        e.type === 'human.intervention'
        && (e.data as { phase?: string }).phase === 'agent_dialog_resolved_runtime',
      )).toBe(true);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      getSpy.mockRestore();
    }
  });

  it('exits when agentStore record is deleted (DELETE path collapses the loop)', async () => {
    await agentStore.update('dev-1', (s) => s ? {
      ...s, creationToken: TOKEN, updatedAt: NOW,
    } : null);

    const realSetTimeout = globalThis.setTimeout;
    const fastSetTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof globalThis.setTimeout;
    globalThis.setTimeout = fastSetTimeout;
    const realGet = agentStore.get.bind(agentStore);
    let polls = 0;
    const getSpy = vi.spyOn(agentStore, 'get').mockImplementation(async (id: string) => {
      polls++;
      // 模拟 operator 在第 2 轮 poll 时 DELETE 掉 agent。
      if (polls === 2) {
        await agentStore.delete('dev-1');
      }
      return realGet(id);
    });
    try {
      // 不会无限挂——agentStore.get 返回 null 触发 line 595 的 return。
      await (manager as unknown as {
        slowPollDialogPending: (id: string, token: string) => Promise<void>;
      }).slowPollDialogPending('dev-1', TOKEN);

      expect(polls).toBeGreaterThanOrEqual(2);
      expect(polls).toBeLessThan(10); // 没失控
      expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
      expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(false);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      getSpy.mockRestore();
    }
  });
});
