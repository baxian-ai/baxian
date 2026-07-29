import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianEvent } from '../../src/shared/index.js';
import { EnsureSessionError, DispatchTerminalError, type AgentManager } from '../../src/agent/manager.js';
import { TmuxManager } from '../../src/agent/tmux.js';
import type { CommandRunner } from '../../src/agent/runner.js';
import type { AgentStore } from '../../src/state/agent-store.js';
import type { LockManager } from '../../src/state/lock.js';
import type { EventBus } from '../../src/event/bus.js';
import type { PhaseSignalWatcher } from '../../src/agent/phase-signal-watcher.js';
import { createManagerHarness } from '../helpers/manager-harness.js';
import { fakeRunner } from '../helpers/fake-runner.js';
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
      repo: 'owner/repo',
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

  function spyKills(): { byRef: ReturnType<typeof vi.spyOn> } {
    return {
      byRef: vi.spyOn(TmuxManager.prototype, 'killSessionRef').mockResolvedValue('killed'),
    };
  }

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
    vi.spyOn(manager, 'ensureSession').mockImplementation(async () => {
      (manager as unknown as { adoptGeneration: Map<string, number> }).adoptGeneration.set('dev-1', 1);
      throw new EnsureSessionError({ createdSession: true, agentId: 'dev-1', sessionRef: REF, genAtCreate: 0 }, 'boot boom');
    });
    const kills = spyKills();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.startBootstrapAsync('dev-1', 'token-abc');

    expect(kills.byRef).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(c => String(c[0]).includes('session adopted since create'))).toBe(true);
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

  it('no longer hard-fails after 10 minutes when the dialog stays unresolved', async () => {
    await agentStore.update('dev-1', (s) => s ? {
      ...s,
      creationToken: TOKEN,
      updatedAt: NOW,
    } : null);

    const failSpy = vi.spyOn(manager, 'failTasksForAgent').mockResolvedValue({ failedCount: 0, releasedPartners: 0 });
    const releaseSpy = vi.spyOn(lockManager, 'releaseIfOwner');
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
    await agentStore.set({
      id: 'dev-1',
      projectId: 'proj',
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
      awaitingReason: 'startup dialog',
      awaitingSince: NOW,
      paneId: '%1',
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

    const dispatchRunner = fakeRunner({
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
    });

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
      }).slowPollDialogPending('dev-1', undefined, { expectedPaneId: '%1', expectedTaskId: undefined });

      const state = await realGet('dev-1');
      expect(state?.awaitingPhase).toBe('agent_dialog_resolved_runtime');
      expect(state?.paneId).toBe('%2');
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
      if (polls === 2) {
        await agentStore.delete('dev-1');
      }
      return realGet(id);
    });
    try {
      await (manager as unknown as {
        slowPollDialogPending: (id: string, token: string) => Promise<void>;
      }).slowPollDialogPending('dev-1', TOKEN);

      expect(polls).toBeGreaterThanOrEqual(2);
      expect(polls).toBeLessThan(10);
      expect(events.some(e => e.type === 'agent.bootstrap_failed')).toBe(false);
      expect(events.some(e => e.type === 'agent.bootstrap_succeeded')).toBe(false);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      getSpy.mockRestore();
    }
  });
});
