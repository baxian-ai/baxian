import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBindingFacts, BaxianEvent } from '../../src/shared/index.js';
import { EnsureSessionError, DispatchTerminalError, type AgentManager } from '../../src/agent/manager.js';
import { TmuxManager, TmuxOutcomeUnknownError, ReplNotReadyError } from '../../src/agent/tmux.js';
import type { CommandRunner } from '../../src/agent/runner.js';
import type { AgentStore } from '../../src/state/agent-store.js';
import type { LockManager } from '../../src/state/lock.js';
import type { EventBus } from '../../src/event/bus.js';
import type { PhaseSignalWatcher } from '../../src/agent/phase-signal-watcher.js';
import { createManagerHarness } from '../helpers/manager-harness.js';
import { fakeRunner, type FakeRunnerRule } from '../helpers/fake-runner.js';
import { makeAgent, makeConfig } from '../helpers/fixtures.js';

const NOW = '2026-05-14T05:00:00.000Z';

const REF = { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' };
const PANE = { session: REF, paneId: '%0', claim: 'dev-1' };

let tempDir: string;
let manager: AgentManager;
let agentStore: AgentStore;
let lockManager: LockManager;
let eventBus: EventBus;
let createManager: Awaited<ReturnType<typeof createManagerHarness>>['createManager'];
let events: BaxianEvent[];

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
  const runner = fakeRunner({ defaultResult: {} });
  const config = makeConfig({
    project: [{
      id: 'proj',
      repo: 'https://github.com/owner/repo.git',
      merge: null,
      agent: [[
        makeAgent({ yolo: true }),
        makeAgent({
          id: 'qa-1',
          runtime: 'claude-code',
          role: 'qa',
          workdir: '/tmp/qa-repo',
          yolo: true,
        }),
      ]],
    }],
  });
  const harness = await createManagerHarness(tempDir, {
    config,
    deps: {
      runnerFactory: () => runner,
      platformRunner: runner,
    },
  });
  ({ manager, agentStore, lockManager, eventBus, createManager, events } = harness);
  await harness.seedAgent({
    creationToken: 'token-abc',
    updatedAt: NOW,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

function spyKills(): { byRef: ReturnType<typeof vi.spyOn> } {
  return {
    byRef: vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('killed'),
  };
}

describe('AgentManager.startBootstrapAsync', () => {
  it('success records paneId and clears the creation token', async () => {
    const ensureSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: true,
      paneId: '%0',
      pane: PANE,
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
      pane: PANE,
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

  it('hard failure with the same token rolls back by generation-bound session ref', async () => {
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: REF, genAtCreate: 0 }, 'boot boom'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kills = spyKills();

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    expect(kills.byRef).toHaveBeenCalledWith(REF, { kind: 'emptyOr', claim: 'dev-1' });
    expect(warn.mock.calls.some(c => String(c[0]).includes('killed created session $7'))).toBe(true);
  });

  it('created-session hard failure: rollback not confirmed (refused) hands off to slow poll instead of clearing over a live session', async () => {
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: REF, genAtCreate: 0 }, 'boot boom to shell'),
    );
    vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('refused');
    const slowPollSpy = vi
      .spyOn(manager as unknown as {
        slowPollDialogPending: (id: string, token: string | undefined) => Promise<void>;
      }, 'slowPollDialogPending')
      .mockResolvedValue(undefined);

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBe('token-abc');
    expect(state?.awaitingPhase).toBe('agent_dialog_pending');
    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
    expect(slowPollSpy).toHaveBeenCalledWith('dev-1', 'token-abc');
  });

  it('created-session hard failure: confirmed killed rollback finalizes without a slow-poll handoff', async () => {
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: REF, genAtCreate: 0 }, 'boot boom'),
    );
    vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('killed');
    const slowPollSpy = vi
      .spyOn(manager as unknown as {
        slowPollDialogPending: (id: string, token: string | undefined) => Promise<void>;
      }, 'slowPollDialogPending')
      .mockResolvedValue(undefined);

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(true);
    expect((await agentStore.get('dev-1'))?.creationToken).toBeUndefined();
    expect(slowPollSpy).not.toHaveBeenCalled();
  });

  it('a successor queued on the lifecycle lock during hard-failure rollback is finalized against, not clobbered after', async () => {
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: REF, genAtCreate: 0 }, 'boot boom'),
    );
    const m = manager as unknown as { runUnderSessionLifecycle: (id: string, fn: () => Promise<void>) => Promise<void> };
    let tokenSeenBySuccessor: string | undefined | 'UNSET' = 'UNSET';
    let successorDone: Promise<void> = Promise.resolve();
    // the successor grabs the same lock while the rollback kill is running; finalize must complete before it runs
    vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockImplementation(async () => {
      successorDone = m.runUnderSessionLifecycle('dev-1', async () => {
        tokenSeenBySuccessor = (await agentStore.get('dev-1'))?.creationToken;
      });
      return 'killed';
    });

    await manager.startBootstrapAsync('dev-1', 'token-abc');
    await successorDone;

    expect(tokenSeenBySuccessor).toBeUndefined();
    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(true);
  });

  it('hard failure with a rotated token leaves the session to its successor', async () => {
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: REF, genAtCreate: 0 }, 'boot boom'),
    );
    await agentStore.update('dev-1', (s) => s ? { ...s, creationToken: 'token-newer' } : null);
    const kills = spyKills();

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    expect(kills.byRef).not.toHaveBeenCalled();
    expect((await agentStore.get('dev-1'))?.creationToken).toBe('token-newer');
  });

  it('rollback stands down when the session was adopted after create', async () => {
    // the successor reuses the same creationToken, so the token guard alone can't tell it from the losing bootstrap
    await agentStore.update('dev-1', (s) => s ? { ...s, paneId: '%0' } : null);
    vi.spyOn(manager, 'ensureSession').mockImplementation(async () => {
      (manager as unknown as { adoptGeneration: Map<string, number> }).adoptGeneration.set('dev-1', 1);
      throw new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: REF, genAtCreate: 0 }, 'boot boom');
    });
    const kills = spyKills();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    const state = await agentStore.get('dev-1');
    expect(kills.byRef).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(c => String(c[0]).includes('session adopted since create'))).toBe(true);
    expect(state?.creationToken).toBe('token-abc');
    expect(state?.paneId).toBe('%0');
    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
  });

  it('rollback is skipped when no session ref was recorded', async () => {
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', genAtCreate: 0 }, 'boot boom'),
    );
    const kills = spyKills();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    expect(kills.byRef).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(c => String(c[0]).includes('no session ref recorded'))).toBe(true);
  });

  it('skips rollback with the original failure visible when the agent store read rejects', async () => {
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: REF, genAtCreate: 0 }, 'boot boom'),
    );
    vi.spyOn(agentStore, 'get').mockRejectedValueOnce(new Error('EACCES: permission denied'));
    const kills = spyKills();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    expect(kills.byRef).not.toHaveBeenCalled();
    const storeSkip = warn.mock.calls.find(c => String(c[0]).includes('agent store read failed'));
    expect(storeSkip).toBeDefined();
    expect(String(storeSkip![1])).toContain('EACCES');
    expect(warn.mock.calls.some(c => String(c[0]).includes('creationToken rotated'))).toBe(false);
  });

  it('an in-flight ref kill is not retracted by a token rotation and can never reach a successor session', async () => {
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: REF, genAtCreate: 0 }, 'boot boom'),
    );
    let resolveKill!: (v: 'killed') => void;
    const killByRef = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockImplementation(
      () => new Promise((resolve) => { resolveKill = resolve; }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const bootstrap = manager.startBootstrapAsync('dev-1', 'token-abc');
    await vi.waitFor(() => expect(killByRef).toHaveBeenCalled());
    await agentStore.update('dev-1', (s) => s ? { ...s, creationToken: 'token-successor' } : null);
    resolveKill('killed');
    await bootstrap;

    expect(killByRef).toHaveBeenCalledTimes(1);
    expect(killByRef).toHaveBeenCalledWith(REF, { kind: 'emptyOr', claim: 'dev-1' });
  });

  it('leaves a created dialog-blocked session untouched when the token has rotated', async () => {
    vi.spyOn(manager, 'ensureSession').mockRejectedValue(
      new EnsureSessionError(
        { createdSession: true, agentId: 'dev-1', dialogPending: true, lastScreen: 'Do you trust this folder?' },
        'blocked on startup dialog',
      ),
    );
    await agentStore.update('dev-1', (s) => s ? { ...s, creationToken: 'token-newer' } : null);
    const killRefSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('killed');

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    expect(killRefSpy).not.toHaveBeenCalled();
    expect((await agentStore.get('dev-1'))?.creationToken).toBe('token-newer');
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
      pane: PANE,
      workdir: '/tmp/repo',
    });

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBe('token-new');
    expect(state?.paneId).toBeUndefined();
  });
});

describe('AgentManager greeting capability gate', () => {
  function makeManagerWithWatcher(awaitOnce: ReturnType<typeof vi.fn>) {
    const localEvents: BaxianEvent[] = [];
    eventBus.on('*', (event) => { localEvents.push(event); });
    const phaseSignalWatcher = { awaitOnce } as unknown as PhaseSignalWatcher;
    const mgr = createManager({
      phaseSignalWatcher,
    });
    vi.spyOn(mgr, 'ensureSession').mockResolvedValue({
      ok: true, createdSession: true, paneId: '%0', pane: PANE, workdir: '/tmp/repo',
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
    expect(injectSpy).toHaveBeenCalledTimes(1);
    expect(awaitOnce).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'dev-1', kind: 'greeting' }));
    expect(String(injectSpy.mock.calls[0][2])).toContain('[bx:greeting:');
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
    expect(awaitOnce).toHaveBeenCalledTimes(2);
    expect(await mgr.pickAgent('proj', 'dev-1')).toBeNull();
  });

  it('retries on session-gone (a transient subscribe fault must not fail a capable agent)', async () => {
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
    injectSpy.mockRejectedValue(new Error('pane busy'));

    await mgr.startBootstrapAsync('dev-1', 'token-abc');

    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect(injectSpy).toHaveBeenCalledTimes(2);
    expect(awaitOnce).not.toHaveBeenCalled();
  });

  it('holds without retrying when the greeting paste fails ack_unknown (unconfirmed composer)', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('matched');
    const { mgr, injectSpy } = makeManagerWithWatcher(awaitOnce);
    injectSpy.mockRejectedValue(new DispatchTerminalError('ack_unknown', 'pre-ack failure'));

    await mgr.startBootstrapAsync('dev-1', 'token-abc');

    expect((await agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect(injectSpy).toHaveBeenCalledTimes(1);
    expect(awaitOnce).not.toHaveBeenCalled();
  });

  it('leaves the session untouched (no kill, no greeting_failed hold) when creationToken rotates mid-greeting', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('timeout');
    const { mgr } = makeManagerWithWatcher(awaitOnce);
    await agentStore.update('dev-1', (s) => s ? { ...s, creationToken: 'token-newer' } : null);
    const killRefSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('killed');

    await mgr.startBootstrapAsync('dev-1', 'token-abc');

    expect(killRefSpy).not.toHaveBeenCalled();
    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBe('token-newer');
    expect(state?.awaitingPhase).not.toBe('greeting_failed');
  });

  it('leaves the session untouched when the token rotates between greeting success and the store write', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('matched');
    const { mgr } = makeManagerWithWatcher(awaitOnce);
    await agentStore.update('dev-1', (s) => s ? { ...s, creationToken: 'token-newer' } : null);
    const killRefSpy = vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('killed');

    await mgr.startBootstrapAsync('dev-1', 'token-abc');

    expect(killRefSpy).not.toHaveBeenCalled();
    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBe('token-newer');
    expect(state?.paneId).toBeUndefined();
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
    expect(await mgr.pickAgent('proj', 'dev-1')).toBeNull();
  });

  it('recover() re-greets an incomplete bootstrap (creationToken set, no task) → ready on pass', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('matched');
    const { mgr } = makeManagerWithWatcher(awaitOnce);
    await agentStore.set({ id: 'dev-1', projectId: 'proj', creationToken: 'tok-crash', updatedAt: NOW });

    await mgr.recover();
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
    await waitFor(async () => (await agentStore.get('dev-1'))?.awaitingPhase === 'greeting_failed');

    const state = await agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('greeting_failed');
  });

  it('regreetHeldAgent clears the hold when the re-greet passes', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('matched');
    const { mgr } = makeManagerWithWatcher(awaitOnce);
    vi.spyOn(TmuxManager.prototype, 'getSessionSnapshot').mockResolvedValue({ ref: REF, claim: 'dev-1' });
    vi.spyOn(TmuxManager.prototype, 'getSinglePaneByRef').mockResolvedValue(PANE);
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
    vi.spyOn(TmuxManager.prototype, 'getSessionSnapshot').mockResolvedValue({ ref: REF, claim: 'dev-1' });
    vi.spyOn(TmuxManager.prototype, 'getSinglePaneByRef').mockResolvedValue(PANE);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW, updatedAt: NOW,
    });

    await mgr.regreetHeldAgent('dev-1');

    expect((await agentStore.get('dev-1'))?.awaitingPhase).toBe('greeting_failed');
  });

  it('regreetHeldAgent does not clear a binding that was recreated mid-handshake (generation guard)', async () => {
    const awaitOnce = vi.fn().mockImplementation(async () => {
      await agentStore.set({ id: 'dev-1', projectId: 'proj', creationToken: 'tok-new', updatedAt: 'LATER' });
      return 'matched';
    });
    const { mgr } = makeManagerWithWatcher(awaitOnce);
    vi.spyOn(TmuxManager.prototype, 'getSessionSnapshot').mockResolvedValue({ ref: REF, claim: 'dev-1' });
    vi.spyOn(TmuxManager.prototype, 'getSinglePaneByRef').mockResolvedValue(PANE);
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW, updatedAt: NOW,
    });

    await mgr.regreetHeldAgent('dev-1');

    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBe('tok-new');
    expect(state?.awaitingPhase).toBeUndefined();
  });

  it('Resume refuses a greeting_failed hold — capability must be re-proven, not overridden', async () => {
    const { mgr } = makeManagerWithWatcher(vi.fn().mockResolvedValue('matched'));
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW, updatedAt: NOW,
    });

    const res = await mgr.resumeAgent('dev-1');

    expect(res.resumed).toBe(false);
    expect(res.reason).toMatch(/Restart REPL/);
    const state = await agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('greeting_failed');
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
  const DIALOG_SCREEN = ' Enter to confirm · Esc to cancel\n';
  const DIALOG_STILL_PENDING = new ReplNotReadyError('%0', 'claude-code', DIALOG_SCREEN, 'dialog still pending', false);
  const EXITED_TO_SHELL = new ReplNotReadyError('%0', 'claude-code', DIALOG_SCREEN, 'exited to shell', true);
  const realSetTimeout = globalThis.setTimeout;
  const realDateNow = Date.now;
  let simNow = 0;

  // 虚拟时钟:sleep 立即回调并推进 Date.now,waitReplReady 的 1 s deadline 不再真等
  beforeEach(() => {
    simNow = realDateNow();
    Date.now = () => simNow;
    globalThis.setTimeout = ((fn: () => void, ms = 0) => {
      simNow += ms;
      return realSetTimeout(fn, 0);
    }) as unknown as typeof globalThis.setTimeout;
  });
  afterEach(() => {
    Date.now = realDateNow;
    globalThis.setTimeout = realSetTimeout;
  });

  type PollScope = { expectedPaneId?: string; expectedTaskId?: string };
  function slowPoll(token: string | undefined, opts?: PollScope): Promise<void> {
    return (manager as unknown as {
      slowPollDialogPending: (id: string, token: string | undefined, opts?: PollScope) => Promise<void>;
    }).slowPollDialogPending('dev-1', token, opts);
  }

  function useRunner(runner: CommandRunner): void {
    vi.spyOn(manager as unknown as {
      createRunnerFor: (agent: unknown) => CommandRunner;
    }, 'createRunnerFor').mockReturnValue(runner);
  }

  async function seedPendingBootstrap(overrides: Partial<AgentBindingFacts> = {}): Promise<void> {
    await agentStore.update('dev-1', (s) => s ? {
      ...s,
      creationToken: TOKEN,
      paneId: '%0',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
      awaitingReason: 'startup dialog',
      awaitingSince: NOW,
      updatedAt: NOW,
      ...overrides,
    } : null);
  }

  function shellExitRunner(screen = DIALOG_SCREEN, rules: FakeRunnerRule[] = []): ReturnType<typeof fakeRunner> {
    return fakeRunner({ agents: { 'dev-1': { process: 'zsh', screen } }, rules });
  }

  function sentKillSession(runner: ReturnType<typeof fakeRunner>): boolean {
    return runner.exec.mock.calls.some(c => String(c[0]).includes('kill-session'));
  }

  // ends the loop on poll n by handing back a rotated token; never writes to the store (update() re-enters get() under its mutex)
  function rotateTokenAtPoll(n: number, onFirstPoll?: () => void): { polls: () => number } {
    const realGet = agentStore.get.bind(agentStore);
    let polls = 0;
    const getSpy = vi.spyOn(agentStore, 'get').mockImplementation(async (id: string) => {
      polls++;
      if (polls === 1) onFirstPoll?.();
      const state = await realGet(id);
      if (polls < n || !state) return state;
      getSpy.mockRestore();
      return { ...state, creationToken: 'token-force-exit' };
    });
    return { polls: () => polls };
  }

  // a successor ensure holds the lifecycle lock from its generation bump until its session work is done
  function fakeTakeover(): { start: () => void; release: () => void; done: () => boolean } {
    let done = false;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const m = manager as unknown as {
      adoptGeneration: Map<string, number>;
      runUnderSessionLifecycle: (id: string, fn: () => Promise<void>) => Promise<void>;
    };
    return {
      start: () => {
        void m.runUnderSessionLifecycle('dev-1', async () => {
          m.adoptGeneration.set('dev-1', 1);
          await gate;
          done = true;
        });
      },
      release: () => release(),
      done: () => done,
    };
  }

  // absent until the takeover has rebuilt the session as $2/%1
  function rebuiltSessionRunner(
    takeover: ReturnType<typeof fakeTakeover>,
    onFirstSnapshot?: () => void,
  ): ReturnType<typeof fakeRunner> {
    let snapshots = 0;
    return fakeRunner({
      agents: { 'dev-1': { paneId: '%1', process: 'claude', screen: DIALOG_SCREEN } },
      rules: [{
        match: 'list-sessions',
        reply: () => {
          if (++snapshots === 1) onFirstSnapshot?.();
          return { stdout: takeover.done() ? '4242|1700000000|$2|dev-1\n' : '' };
        },
      }],
    });
  }

  async function expectSuccessorStateUntouched(): Promise<void> {
    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBe(TOKEN);
    expect(state?.paneId).toBe('%0');
    expect(state?.awaitingPhase).toBe('agent_dialog_pending');
    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
  }

  it('no longer hard-fails after 10 minutes while the session cannot be probed (transient), dialog unresolved', async () => {
    await agentStore.update('dev-1', (s) => s ? { ...s, creationToken: TOKEN, updatedAt: NOW } : null);

    // A transient probe failure (not PaneGoneError) must keep polling, never hard-fail on a time budget.
    vi.spyOn(TmuxManager.prototype, 'getSessionSnapshot')
      .mockRejectedValue(new TmuxOutcomeUnknownError('list-sessions outcome unknown (transient): exit 255: Connection reset by peer'));
    const failSpy = vi.spyOn(manager, 'failTasksForAgent').mockResolvedValue({ failedCount: 0, releasedPartners: 0 });
    const releaseSpy = vi.spyOn(lockManager, 'releaseIfOwner');
    let iterations = 0;
    const realGet = agentStore.get.bind(agentStore);
    const realSet = agentStore.set.bind(agentStore);
    vi.spyOn(agentStore, 'get').mockImplementation(async (id: string) => {
      iterations++;
      simNow += 5 * 60_000;
      if (iterations === 200) {
        const cur = await realGet(id);
        if (cur) await realSet({ ...cur, creationToken: 'token-force-exit', updatedAt: new Date().toISOString() });
      }
      return realGet(id);
    });
    await slowPoll(TOKEN);

    expect(failSpy).not.toHaveBeenCalled();
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
    expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(false);
  });

  it('exits cleanly when creationToken is cleared mid-flight (DELETE/recreate)', async () => {
    await agentStore.update('dev-1', (s) => s ? { ...s, paneId: '%0', creationToken: 'token-newer', updatedAt: NOW } : null);
    await slowPoll(TOKEN);

    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
    expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(false);
    expect((await agentStore.get('dev-1'))?.creationToken).toBe('token-newer');
  });

  it('recovers a runtime dialog after the tmux pane was recreated (stale stored paneId)', async () => {
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
      awaitingReason: 'startup dialog',
      awaitingSince: NOW,
      paneId: '%1',
      taskId: 'task-1',
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

    useRunner(fakeRunner({
      rules: [
        { match: 'list-sessions', reply: { stdout: '9999|1700000000|$1|dev-1\n' } },
        { match: 'list-panes', reply: { stdout: '%2 node\n' } },
        {
          match: cmd => cmd.includes('%1') && !cmd.includes('%2'),
          reply: { stderr: "can't find pane: %1", exitCode: 1 },
        },
        {
          match: cmd => cmd.includes('capture-pane') && cmd.includes('%2'),
          reply: { stdout: `BX_PANE_OK\n${READY_CODEX}` },
        },
        {
          match: cmd => cmd.includes('display-message') && cmd.includes('%2'),
          reply: { stdout: 'BX_PANE_OKnode\n' },
        },
      ],
      defaultResult: {},
    }));
    vi.spyOn(manager, 'getAgentConfig').mockReturnValue({
      id: 'dev-1',
      projectId: 'proj',
      runtime: 'codex',
      role: 'dev',
      mode: 'local',
      workdir: '/tmp/repo',
      yolo: true,
    });
    rotateTokenAtPoll(13);
    await slowPoll(undefined, { expectedPaneId: '%1', expectedTaskId: 'task-1' });

    const state = await agentStore.get('dev-1');
    expect(state?.awaitingPhase).toBe('agent_dialog_resolved_runtime');
    expect(state?.paneId).toBe('%2');
    expect(state?.awaitingReason).toContain('cancel it if it is still active');
    const intervention = events.find(e =>
      e.type === 'human.intervention'
      && e.taskId === 'task-1'
      && (e.data as { phase?: string }).phase === 'agent_dialog_resolved_runtime',
    );
    expect(intervention?.data.note).toContain('cancel it if it is still active');
    expect(intervention?.data.note).not.toBe('Runtime dialog resolved; agent REPL ready. Click Resume to continue.');
  });

  it('bootstrap path: REPL exited to a shell → rolls back the dead session and clears the dialog hold so Retry/Resume can rebuild', async () => {
    await seedPendingBootstrap();
    const shellRunner = shellExitRunner();
    useRunner(shellRunner);
    await slowPoll(TOKEN);

    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(true);
    expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(false);
    // Recovery-ready: the dialog hold and creation token are gone so Resume is not rejected and Retry is not blocked.
    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    expect(state?.status).toBeUndefined();
    // The leftover shell session was actually torn down (guarded kill), not left present to block Retry.
    expect(sentKillSession(shellRunner)).toBe(true);
  });

  it('bootstrap path: a successor queued on the lifecycle lock during rollback is finalized against, not clobbered after', async () => {
    await seedPendingBootstrap();
    useRunner(shellExitRunner());
    const m = manager as unknown as { runUnderSessionLifecycle: (id: string, fn: () => Promise<void>) => Promise<void> };
    let tokenSeenBySuccessor: string | undefined | 'UNSET' = 'UNSET';
    let successorDone: Promise<void> = Promise.resolve();
    // the losing poll confirms shell → rolls back; a same-token successor queues on the lock while the kill runs
    vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockImplementation(async () => {
      successorDone = m.runUnderSessionLifecycle('dev-1', async () => {
        tokenSeenBySuccessor = (await agentStore.get('dev-1'))?.creationToken;
      });
      return 'killed';
    });

    await slowPoll(TOKEN);
    await successorDone;

    // finalize ran inside the same critical section as the rollback, so the successor never observes a live token to clobber
    expect(tokenSeenBySuccessor).toBeUndefined();
    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(true);
  });

  it('bootstrap path: half-created session left as a plain shell (no dialog text) → rolls back and finalizes so Retry can rebuild', async () => {
    await seedPendingBootstrap();
    // A create that failed before the launch command leaves a plain shell — no runtime ever started, no dialog on screen.
    const shellRunner = shellExitRunner('➜  repo git:(main)\n');
    useRunner(shellRunner);
    await slowPoll(TOKEN);

    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(true);
    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    expect(sentKillSession(shellRunner)).toBe(true);
  });

  it('bootstrap path: a successor adopting during the readiness probe is not killed by the losing slow poll', async () => {
    await seedPendingBootstrap();
    useRunner(shellExitRunner());
    // A successor adopts the same ref (bumps adoptGeneration) while this poll's waitReplReady is still running.
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockImplementation(async () => {
      (manager as unknown as { adoptGeneration: Map<string, number> }).adoptGeneration.set('dev-1', 1);
      throw EXITED_TO_SHELL;
    });
    const killSpy = spyKills().byRef;
    await slowPoll(TOKEN);

    expect(killSpy).not.toHaveBeenCalled();
    await expectSuccessorStateUntouched();
  });

  it('bootstrap path: a session ref replaced mid-probe (no panes match) is re-probed, not finalized as failed', async () => {
    await seedPendingBootstrap();
    // getSinglePaneByRef throws a plain Error (not PaneGoneError) for a stale ref, so this path must re-probe
    useRunner(shellExitRunner(DIALOG_SCREEN, [{ match: 'list-panes', reply: { stdout: '' } }]));
    const killSpy = spyKills().byRef;
    const loop = rotateTokenAtPoll(4);
    await slowPoll(TOKEN);

    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
    expect(loop.polls()).toBeGreaterThan(1);
  });

  it('bootstrap path: a takeover that begins during this poll\'s probe and rebuilds the session is not finalized as gone', async () => {
    await seedPendingBootstrap();
    const takeover = fakeTakeover();
    // the successor bumped, killed the old ref and is still building the new one when this poll's snapshot lands
    useRunner(rebuiltSessionRunner(takeover, () => {
      takeover.start();
      realSetTimeout(takeover.release, 0);
    }));
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(DIALOG_STILL_PENDING);
    const killSpy = spyKills().byRef;
    const loop = rotateTokenAtPoll(3);
    await slowPoll(TOKEN);

    await expectSuccessorStateUntouched();
    expect(killSpy).not.toHaveBeenCalled();
    expect(loop.polls()).toBeGreaterThan(1);
  });

  it('bootstrap path: a takeover already in flight when this poll samples (generation bumped, old session destroyed, new one not yet built) is not finalized as gone', async () => {
    await seedPendingBootstrap();
    const takeover = fakeTakeover();
    takeover.start();
    useRunner(rebuiltSessionRunner(takeover));
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockRejectedValue(DIALOG_STILL_PENDING);
    const killSpy = spyKills().byRef;
    // the successor finishes only after this poll has already started its iteration
    const loop = rotateTokenAtPoll(3, () => realSetTimeout(takeover.release, 0));
    await slowPoll(TOKEN);

    await expectSuccessorStateUntouched();
    expect(killSpy).not.toHaveBeenCalled();
    expect(loop.polls()).toBeGreaterThan(1);
  });

  it('bootstrap path: a takeover already in flight that relaunches the runtime in the same pane is not killed by a shell observed before it finished', async () => {
    await seedPendingBootstrap();
    const takeover = fakeTakeover();
    takeover.start();
    useRunner(shellExitRunner());
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockImplementation(async () => {
      throw takeover.done() ? DIALOG_STILL_PENDING : EXITED_TO_SHELL;
    });
    const killSpy = spyKills().byRef;
    const loop = rotateTokenAtPoll(3, () => realSetTimeout(takeover.release, 0));
    await slowPoll(TOKEN);

    await expectSuccessorStateUntouched();
    expect(killSpy).not.toHaveBeenCalled();
    expect(loop.polls()).toBeGreaterThan(1);
  });

  for (const variant of [
    { label: 'refused (session ref changed / adopted)', kill: () => vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('refused') },
    { label: 'unknown (SSH connection reset)', kill: () => vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockRejectedValue(new TmuxOutcomeUnknownError('kill outcome unknown: exit 255: Connection reset by peer')) },
  ]) {
    it(`bootstrap path: session teardown ${variant.label} → keeps the dialog hold and re-probes instead of clearing state over a live session`, async () => {
      await seedPendingBootstrap();
      useRunner(shellExitRunner());
      const killSpy = variant.kill();
      const loop = rotateTokenAtPoll(4);
      await slowPoll(TOKEN);

      // A not-confirmed-gone session must NOT be treated as failed: no bootstrap_failed, hold not cleared.
      expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
      expect(killSpy).toHaveBeenCalled();
      expect(loop.polls()).toBeGreaterThan(1);
    });
  }

  it('bootstrap path: kill applied but response lost (unknown) → next cycle sees the session gone and finalizes', async () => {
    await seedPendingBootstrap();
    let killApplied = false;
    useRunner(shellExitRunner(DIALOG_SCREEN, [
      { match: 'list-sessions', reply: () => ({ stdout: killApplied ? '' : '4242|1700000000|$1|dev-1\n' }) },
    ]));
    // Remote kill actually succeeds, but SSH drops before the reply → the session is gone yet the outcome is unknown.
    vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockImplementation(async () => {
      killApplied = true;
      throw new TmuxOutcomeUnknownError('kill outcome unknown: exit 255: Connection reset by peer');
    });
    await slowPoll(TOKEN);

    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(true);
    const state = await agentStore.get('dev-1');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
  });

  it('bootstrap path: does not roll back or fail when the creation token was already rotated to a successor', async () => {
    await seedPendingBootstrap({ creationToken: 'token-newer' });
    const shellRunner = shellExitRunner();
    useRunner(shellRunner);
    await slowPoll(TOKEN);

    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
    expect(sentKillSession(shellRunner)).toBe(false);
    expect((await agentStore.get('dev-1'))?.creationToken).toBe('token-newer');
  });

  it('exits when agentStore record is deleted (DELETE path collapses the loop)', async () => {
    await agentStore.update('dev-1', (s) => s ? { ...s, creationToken: TOKEN, updatedAt: NOW } : null);
    const realGet = agentStore.get.bind(agentStore);
    let polls = 0;
    vi.spyOn(agentStore, 'get').mockImplementation(async (id: string) => {
      polls++;
      if (polls === 2) await agentStore.delete('dev-1');
      return realGet(id);
    });
    await slowPoll(TOKEN);

    expect(polls).toBeGreaterThanOrEqual(2);
    expect(polls).toBeLessThan(10);
    expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
    expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(false);
  });
});
