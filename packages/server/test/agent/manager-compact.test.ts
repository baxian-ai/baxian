import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentManager } from '../../src/agent/manager.js';
import { TmuxManager, type PaneRef, type TmuxSessionRef } from '../../src/agent/tmux.js';
import type { AgentStore } from '../../src/state/agent-store.js';
import type { LockManager } from '../../src/state/lock.js';
import type { CommandRunner } from '../../src/agent/runner.js';
import { createManagerHarness } from '../helpers/manager-harness.js';
import { fakeRunner } from '../helpers/fake-runner.js';
import { makeAgent, makeConfig } from '../helpers/fixtures.js';

const REF: TmuxSessionRef = { sessionId: '$1', serverPid: '4242', serverStart: '1700000000' };
const paneRef = (agentId: string, paneId: string): PaneRef => ({ session: REF, paneId, claim: agentId });
const SPACE_LITERAL = "'\\'' '\\''";

let tempDir: string;
let agentStore: AgentStore;
let lockManager: LockManager;
let manager: AgentManager;
let mockRunner: CommandRunner;
let waitReadySpy: ReturnType<typeof vi.spyOn>;
let seedAgent: Awaited<ReturnType<typeof createManagerHarness>>['seedAgent'];

function execCalls(): string[] {
  return (mockRunner.exec as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0]));
}

function guardSet(): Set<string> {
  return (manager as never as { compactInFlight: Set<string> }).compactInFlight;
}

function installGates(): Array<() => void> {
  const gates: Array<() => void> = [];
  waitReadySpy.mockImplementation(() => new Promise<void>(r => { gates.push(r); }));
  return gates;
}

function setPollMs(ms: number): void {
  (manager as never as { compactIdlePollMs: number }).compactIdlePollMs = ms;
}

function callPrivate<T>(name: string, ...args: unknown[]): T {
  return (manager as never as Record<string, (...a: unknown[]) => T>)[name](...args);
}

async function ensureTaskLock(agentId: string, taskId: string): Promise<string> {
  const existing = await lockManager.claimOf(agentId);
  const token = existing?.taskId === taskId
    ? existing.token
    : await lockManager.acquire(agentId, taskId);
  if (!token) throw new Error(`failed to seed ${agentId}/${taskId} lock`);
  await agentStore.update(agentId, state => ({
    ...state!,
    lockToken: token,
    updatedAt: state!.updatedAt,
  }));
  return token;
}

async function runPostMergeCompaction(...args: unknown[]): Promise<void> {
  await ensureTaskLock(String(args[2]), String(args[3]));
  return callPrivate('runPostMergeCompaction', ...args);
}

function injectAndAwaitAck(...args: unknown[]): Promise<{ acked: boolean }> {
  return callPrivate('injectAndAwaitAck', ...args);
}

function stubReleasePostMergeAgent(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(
    manager as never as { releasePostMergeAgent: (...args: unknown[]) => Promise<void> },
    'releasePostMergeAgent',
  ).mockResolvedValue(undefined);
}

function mockFn(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(undefined);
}

function fakeCompactionTmux(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    injectPrompt: mockFn(),
    captureSettledSnapshot: vi.fn().mockResolvedValue('snapshot'),
    readPaneTitle: vi.fn().mockResolvedValue(''),
    sendEnter: mockFn(),
    waitSubmitAck: mockFn(),
    sendKeysLiteral: mockFn(),
    sendKeysToPane: mockFn(),
    clearComposerDraft: mockFn(),
    capturePaneById: vi.fn().mockResolvedValue(''),
  };
}

function fakeDispatchTmux(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    injectPrompt: mockFn(), captureSettledSnapshot: vi.fn().mockResolvedValue('snapshot'),
    readPaneTitle: vi.fn().mockResolvedValue(''),
    sendEnter: mockFn(), waitSubmitAck: mockFn(),
    clearComposerDraft: mockFn(),
    capturePaneById: vi.fn().mockResolvedValue(''),
  };
}

function expectGuardReleased(id: string): Promise<void> {
  return vi.waitFor(() => expect(guardSet().has(id)).toBe(false));
}

function waitGates(gates: Array<() => void>, n: number): Promise<void> {
  return vi.waitFor(() => expect(gates.length).toBe(n));
}

async function drainUntil(gates: Array<() => void>, p: Promise<unknown>): Promise<void> {
  let settled = false;
  const done = p.then(() => { settled = true; }, () => { settled = true; });
  let i = 0;
  while (!settled) {
    while (i < gates.length) gates[i++]();
    await Promise.race([done, new Promise(r => setTimeout(r, 2))]);
  }
  await p;
}

async function drainHolderGates(gates: Array<() => void>, holder: Promise<unknown>): Promise<void> {
  gates[0]();
  await waitGates(gates, 2);
  gates[1]();
  await holder;
  await waitGates(gates, 3);
  gates[2]();
}

async function drainHolderAndRelease(
  gates: Array<() => void>,
  holder: Promise<unknown>,
  id: string,
): Promise<void> {
  await drainHolderGates(gates, holder);
  await expectGuardReleased(id);
}

async function startGuarded(
  start: () => Promise<unknown> = () => manager.compactAgent('dev-1'),
): Promise<{ gates: Array<() => void>; holder: Promise<unknown> }> {
  const gates = installGates();
  const holder = start();
  await waitGates(gates, 1);
  return { gates, holder };
}

async function startBlockedUpload(id: string): Promise<{ upload: Promise<unknown>; releaseWrite: () => void }> {
  let releaseWrite: () => void = () => {};
  (mockRunner.writeFile as ReturnType<typeof vi.fn>).mockReturnValue(
    new Promise<void>(r => { releaseWrite = r; }),
  );
  const upload = manager.attachImageToRunningAgent(id, Buffer.from([0x89, 0x50]), 'png');
  await vi.waitFor(() => expect(mockRunner.writeFile).toHaveBeenCalled());
  return { upload, releaseWrite };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-compact-test-'));
  mockRunner = fakeRunner({ defaultResult: {} });
  const config = makeConfig({
    project: [{
      id: 'proj',
      repo: 'https://github.com/user/repo.git',
      merge: null,
      agent: [[
        makeAgent({ workdir: join(tempDir, 'dev-1') }),
        makeAgent({
          id: 'qa-1',
          runtime: 'codex',
          role: 'qa',
          workdir: join(tempDir, 'qa-1'),
        }),
      ]],
    }],
  });
  const harness = await createManagerHarness(tempDir, {
    config,
    agentDefaults: { paneId: '%7' },
    deps: {
      runnerFactory: () => mockRunner,
      platformRunner: mockRunner,
    },
  });
  ({ manager, agentStore, lockManager, seedAgent } = harness);

  waitReadySpy = vi.spyOn(
    manager as never as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
    'waitForReplPromptReady',
  );

  vi.spyOn(TmuxManager.prototype, 'getSessionSnapshot')
    .mockImplementation(async name => ({ ref: REF, claim: name }));
  vi.spyOn(TmuxManager.prototype, 'getSinglePaneByRef')
    .mockImplementation(async (_ref, claim) => {
      const paneId = (await agentStore.get(claim))?.paneId;
      if (!paneId) throw new Error(`tmux session ${claim} is gone (no panes match)`);
      return { session: REF, paneId, claim };
    });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true });
});

describe('compactAgent', () => {
  it('waits for an idle prompt, clears the composer draft (space then C-c), then sends /compact + Enter', async () => {
    await seedAgent();
    waitReadySpy.mockResolvedValue(undefined);

    await manager.compactAgent('dev-1');

    await vi.waitFor(() => expect(waitReadySpy).toHaveBeenCalledTimes(3));
    await expectGuardReleased('dev-1');
    const [, pane, runtime, timeoutMs] = waitReadySpy.mock.calls[0];
    expect(pane).toMatchObject({ paneId: '%7' });
    expect(runtime).toBe('claude-code');
    expect(timeoutMs).toBe(5_000);

    const calls = execCalls();
    const spaceIdx = calls.findIndex(c => c.includes('send-keys -l') && c.includes(SPACE_LITERAL));
    const ccIdx = calls.findIndex(c => c.includes('send-keys') && c.includes('C-c'));
    const literalIdx = calls.findIndex(c => c.includes('send-keys -l') && c.includes('/compact'));
    expect(spaceIdx).toBeGreaterThanOrEqual(0);
    expect(ccIdx).toBeGreaterThan(spaceIdx);
    expect(literalIdx).toBeGreaterThan(ccIdx);
    expect(calls[literalIdx]).toContain("'%7'");
    const enterIdx = calls.findIndex((c, i) => i > literalIdx && c.includes('send-keys') && c.includes('Enter'));
    expect(enterIdx).toBeGreaterThan(literalIdx);
  });

  it('rejects 409 when a compact for the same agent is already in flight, and releases the guard after', async () => {
    await seedAgent();
    const { gates, holder: first } = await startGuarded();

    await expect(manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });

    await drainHolderAndRelease(gates, first, 'dev-1');

    waitReadySpy.mockResolvedValue(undefined);
    await expect(manager.compactAgent('dev-1')).resolves.toBeUndefined();
  });

  it.each([
    {
      label: 're-dispatched (taskId changes)',
      seed: () => seedAgent(),
      reseed: () => seedAgent({ taskId: 'task-new' }),
    },
    {
      label: 'same-task re-dispatch bumps updatedAt',
      seed: () => seedAgent({ taskId: 'task-1', updatedAt: '2026-06-12T08:00:00.000Z' }),
      reseed: () => seedAgent({ taskId: 'task-1', updatedAt: '2026-06-12T08:00:01.000Z' }),
    },
    {
      label: 'pane is rebuilt',
      seed: () => seedAgent(),
      reseed: () => seedAgent({ paneId: '%9' }),
    },
  ])('rejects 409 and sends nothing when the $label during the wait', async ({ seed, reseed }) => {
    await seed();
    waitReadySpy.mockImplementation(async () => { await reseed(); });

    await expect(manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('session changed'),
    });
    expect(execCalls().some(c => c.includes('C-c') || c.includes('/compact'))).toBe(false);
  });

  it('passes the configured runtime through for a codex agent', async () => {
    await seedAgent({ id: 'qa-1', paneId: '%3' });
    waitReadySpy.mockResolvedValue(undefined);

    await manager.compactAgent('qa-1');

    expect(waitReadySpy.mock.calls[0][2]).toBe('codex');
  });

  it('rejects 409 without sending anything when the runtime is not at an idle prompt', async () => {
    await seedAgent();
    waitReadySpy.mockRejectedValue(new Error('pane %7 stayed busy past 5000ms'));

    await expect(manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('not at an idle REPL prompt'),
    });
    expect(execCalls().some(c => c.includes('/compact'))).toBe(false);
  });

  it('rejects 409 when the agent has no live session (no paneId)', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: new Date().toISOString() });
    await expect(manager.compactAgent('dev-1')).rejects.toMatchObject({ status: 409 });
    expect(waitReadySpy).not.toHaveBeenCalled();
  });

  it('rejects 404 for an unknown agent', async () => {
    await expect(manager.compactAgent('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('post-merge compaction waits for an in-flight manual compact instead of running concurrently', async () => {
    await seedAgent({ taskId: 't1', updatedAt: '2026-06-12T09:00:00.000Z' });
    setPollMs(1);
    stubReleasePostMergeAgent();
    const gates = installGates();
    const fakeTmux = fakeCompactionTmux();

    const manual = manager.compactAgent('dev-1');
    await waitGates(gates, 1);

    const postMerge = runPostMergeCompaction(fakeTmux, paneRef('dev-1', '%7'), 'dev-1', 't1', 'claude-code');
    await new Promise(r => setTimeout(r, 20));
    expect(gates.length).toBe(1);

    await drainUntil(gates, postMerge);
    await manual;

    expect(fakeTmux.injectPrompt).not.toHaveBeenCalled();
    expect(fakeTmux.sendKeysLiteral).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%7' }), '/clear');
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('rejects image attach with 409 while a compact holds the guard', async () => {
    await seedAgent();
    const { gates, holder: manual } = await startGuarded();

    await expect(
      manager.attachImageToRunningAgent('dev-1', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'png'),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('in progress'),
    });

    await drainHolderAndRelease(gates, manual, 'dev-1');
  });

  it('keeps the guard until the runtime is idle again after /compact, blocking uploads meanwhile', async () => {
    await seedAgent();
    const { gates, holder: manual } = await startGuarded();
    gates[0]();
    await waitGates(gates, 2);
    gates[1]();
    await manual;

    await expect(
      manager.attachImageToRunningAgent('dev-1', Buffer.from([0x89, 0x50]), 'png'),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('in progress') });

    await waitGates(gates, 3);
    gates[2]();
    await expectGuardReleased('dev-1');

    await expect(
      manager.attachImageToRunningAgent('dev-1', Buffer.from([0x89, 0x50]), 'png'),
    ).resolves.toMatchObject({ path: expect.stringContaining('dev-1') });
  });

  it('dispatch injection waits for an in-flight compact instead of pasting concurrently', async () => {
    await seedAgent();
    setPollMs(1);
    const fakeTmux = fakeDispatchTmux();
    const { gates, holder: manual } = await startGuarded();

    const dispatch = injectAndAwaitAck(fakeTmux, paneRef('dev-1', '%7'), 'next prompt', 'dev-1', 'claude-code');
    await new Promise(r => setTimeout(r, 20));
    expect(fakeTmux.injectPrompt).not.toHaveBeenCalled();

    await drainHolderGates(gates, manual);

    await expect(dispatch).resolves.toMatchObject({ acked: true });
    expect(fakeTmux.injectPrompt).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%7' }), 'next prompt', 'dev-1');
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('samples the OSC title BEFORE sendEnter and threads it into waitSubmitAck (a post-submit working title must not become the baseline)', async () => {
    await seedAgent();
    setPollMs(1);
    const fakeTmux = fakeDispatchTmux();
    fakeTmux.readPaneTitle.mockResolvedValue('~/repo');
    const { gates, holder: manual } = await startGuarded();

    const dispatch = injectAndAwaitAck(fakeTmux, paneRef('dev-1', '%7'), 'p', 'dev-1', 'claude-code');
    await drainHolderGates(gates, manual);
    await expect(dispatch).resolves.toMatchObject({ acked: true });

    expect(fakeTmux.readPaneTitle.mock.invocationCallOrder[0])
      .toBeLessThan(fakeTmux.sendEnter.mock.invocationCallOrder[0]);
    expect(fakeTmux.waitSubmitAck).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: '%7' }),
      'snapshot', 'claude-code', expect.objectContaining({ baselineTitle: '~/repo' }),
    );
  });

  it('a guarded dispatch that goes stale after entry never touches the composer', async () => {
    await seedAgent();
    setPollMs(1);
    const fakeTmux = fakeDispatchTmux();
    fakeTmux.stagePromptBuffer = vi.fn().mockResolvedValue({ buf: 'baxian-dev-1-x' });
    fakeTmux.pasteStagedBuffer = mockFn();
    fakeTmux.dropStagedBuffer = mockFn();
    let calls = 0;
    const guard = vi.fn(async () => {
      calls += 1;
      return calls === 1;
    });

    const result = await injectAndAwaitAck(fakeTmux, '%7', 'stale prompt', 'dev-1', 'claude-code', guard);

    expect(result).toMatchObject({ aborted: true });
    expect(fakeTmux.clearComposerDraft).not.toHaveBeenCalled();
    expect(fakeTmux.stagePromptBuffer).not.toHaveBeenCalled();
    expect(fakeTmux.pasteStagedBuffer).not.toHaveBeenCalled();
  });

  it('a guarded dispatch scrubs the composer inside the paste fence, after staging', async () => {
    await seedAgent();
    setPollMs(1);
    const fakeTmux = fakeDispatchTmux();
    fakeTmux.stagePromptBuffer = vi.fn().mockResolvedValue({ buf: 'baxian-dev-1-y' });
    fakeTmux.pasteStagedBuffer = mockFn();
    fakeTmux.dropStagedBuffer = mockFn();
    const guard = vi.fn(async () => true);

    const result = await injectAndAwaitAck(fakeTmux, '%7', 'live prompt', 'dev-1', 'claude-code', guard);

    expect(result).toMatchObject({ acked: true });
    expect(fakeTmux.clearComposerDraft.mock.invocationCallOrder[0])
      .toBeGreaterThan(fakeTmux.stagePromptBuffer.mock.invocationCallOrder[0]!);
    expect(fakeTmux.clearComposerDraft.mock.invocationCallOrder[0])
      .toBeLessThan(fakeTmux.pasteStagedBuffer.mock.invocationCallOrder[0]!);
  });

  it('aborts a guarded dispatch when the binding is released while waiting (task cancelled)', async () => {
    await seedAgent({ taskId: 't1' });
    const lockToken = await lockManager.acquire('dev-1', 't1');
    expect(lockToken).toBeTruthy();
    await agentStore.update('dev-1', state => ({ ...state!, lockToken: lockToken!, updatedAt: state!.updatedAt }));
    setPollMs(1);
    const fakeTmux = fakeDispatchTmux();
    const { gates, holder: manual } = await startGuarded();

    const dispatch = injectAndAwaitAck(fakeTmux, paneRef('dev-1', '%7'), 'stale prompt', 'dev-1', 'claude-code');
    await seedAgent();

    gates[0]();
    await expect(manual).rejects.toMatchObject({ status: 409 });

    await expect(dispatch).rejects.toThrow('binding changed');
    expect(fakeTmux.injectPrompt).not.toHaveBeenCalled();
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('guarded text injection waits for the guard, then pastes once it is released', async () => {
    await seedAgent({ id: 'qa-1', paneId: '%3', taskId: 't1' });
    expect(await lockManager.acquire('qa-1', 't1')).toBeTruthy();
    setPollMs(1);
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined);
    const enterSpy = vi.spyOn(TmuxManager.prototype, 'sendEnter').mockResolvedValue(undefined);
    const { gates, holder: manual } = await startGuarded(() => manager.compactAgent('qa-1'));

    const inject = manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: 't1' });
    await new Promise(r => setTimeout(r, 20));
    expect(injectSpy).not.toHaveBeenCalled();

    await drainHolderGates(gates, manual);

    await inject;
    expect(injectSpy).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%3' }), 'file body', 'qa-1');
    expect(enterSpy).toHaveBeenCalled();
    expect(guardSet().has('qa-1')).toBe(false);
  });

  it('drops stale text injection when the agent was rebound during the guard wait', async () => {
    await seedAgent({ id: 'qa-1', paneId: '%3', taskId: 't1' });
    expect(await lockManager.acquire('qa-1', 't1')).toBeTruthy();
    setPollMs(1);
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined);
    const { gates, holder: manual } = await startGuarded(() => manager.compactAgent('qa-1'));

    const inject = manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: 't1' });
    await seedAgent({ id: 'qa-1', paneId: '%3', taskId: 't2' });

    gates[0]();
    await expect(manual).rejects.toMatchObject({ status: 409 });

    await expect(inject).rejects.toThrow('no longer bound');
    expect(injectSpy).not.toHaveBeenCalledWith(expect.objectContaining({ paneId: '%3' }), 'file body', 'qa-1');
    expect(guardSet().has('qa-1')).toBe(false);
  });

  it('rejects manual compact while an image upload holds the guard, then allows it after the upload completes', async () => {
    await seedAgent();
    const { upload, releaseWrite } = await startBlockedUpload('dev-1');

    await expect(manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });
    expect(execCalls().some(c => c.includes('C-c') || c.includes('/compact'))).toBe(false);

    releaseWrite();
    await upload;

    waitReadySpy.mockResolvedValue(undefined);
    await expect(manager.compactAgent('dev-1')).resolves.toBeUndefined();
  });

  it('rejects a second image upload while the first still holds the guard', async () => {
    await seedAgent();
    const { upload: first, releaseWrite } = await startBlockedUpload('dev-1');

    await expect(
      manager.attachImageToRunningAgent('dev-1', Buffer.from([0x89, 0x50]), 'png'),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('in progress') });

    releaseWrite();
    await first;
  });

  it('releases the guard when an upload fails, so a later compact is not blocked', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString() });
    (mockRunner.writeFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));

    await expect(
      manager.attachImageToRunningAgent('dev-1', Buffer.from([0x89, 0x50]), 'png'),
    ).rejects.toThrow('disk full');

    waitReadySpy.mockResolvedValue(undefined);
    await expect(manager.compactAgent('dev-1')).resolves.toBeUndefined();
  });

  it('rejects manual compact with 409 while a clear holds the guard', async () => {
    await seedAgent();
    const { gates, holder: clear } = await startGuarded(() => manager.clearAgent('dev-1'));

    await expect(manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });

    await drainHolderAndRelease(gates, clear, 'dev-1');
  });

  it('rejects manual compact with 409 while post-merge compaction holds the shared guard', async () => {
    await seedAgent({ taskId: 't1' });
    setPollMs(1);
    const releaseSpy = stubReleasePostMergeAgent();
    const gates = installGates();
    const fakeTmux = fakeCompactionTmux();

    const run = runPostMergeCompaction(fakeTmux, paneRef('dev-1', '%7'), 'dev-1', 't1', 'claude-code');
    await waitGates(gates, 1);

    await expect(manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });

    await drainUntil(gates, run);
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 't1');
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('retries post-merge /clear when Codex rejects it while the task is still in progress', async () => {
    await seedAgent({ taskId: 't1' });
    setPollMs(1);
    const releaseSpy = stubReleasePostMergeAgent();
    waitReadySpy.mockResolvedValue(undefined);

    let lastLiteral = '';
    let clearSubmits = 0;
    const fakeTmux = {
      ...fakeCompactionTmux(),
      sendKeysLiteral: vi.fn(async (_pane: PaneRef, text: string) => { lastLiteral = text; }),
      sendEnter: vi.fn(async () => {
        if (lastLiteral === '/clear') clearSubmits++;
      }),
      capturePaneById: vi.fn(async () => (
        clearSubmits === 1
          ? "■ '/clear' is disabled while a task is in progress.\n› \n\n  repo · 100% context left"
          : '› \n\n  repo · 100% context left'
      )),
    };

    await runPostMergeCompaction(fakeTmux, paneRef('dev-1', '%7'), 'dev-1', 't1', 'codex');

    const slashCalls = fakeTmux.sendKeysLiteral.mock.calls.filter(([, text]) => text === '/clear');
    expect(slashCalls).toHaveLength(2);
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 't1');
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('clears the composer draft before submitting the post-merge slash command', async () => {
    await seedAgent({ taskId: 't1' });
    setPollMs(1);
    const releaseSpy = stubReleasePostMergeAgent();
    waitReadySpy.mockResolvedValue(undefined);

    const fakeTmux = fakeCompactionTmux();

    await runPostMergeCompaction(fakeTmux, paneRef('dev-1', '%7'), 'dev-1', 't1', 'codex');

    const draftIdx = fakeTmux.clearComposerDraft.mock.calls.findIndex(([pane]) => (pane as PaneRef).paneId === '%7');
    const clearIdx = fakeTmux.sendKeysLiteral.mock.calls.findIndex(([, text]) => text === '/clear');
    expect(draftIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(fakeTmux.sendKeysToPane).not.toHaveBeenCalledWith(expect.objectContaining({ paneId: '%7' }), 'Escape');
    expect(fakeTmux.clearComposerDraft.mock.invocationCallOrder[draftIdx])
      .toBeLessThan(fakeTmux.sendKeysLiteral.mock.invocationCallOrder[clearIdx]);
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 't1');
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('re-verifies the binding before each clear attempt: a rebind during the retry sleep stops the second clear', async () => {
    await seedAgent({ taskId: 't1' });
    setPollMs(1);
    const releaseSpy = stubReleasePostMergeAgent();
    waitReadySpy.mockResolvedValue(undefined);

    let lastLiteral = '';
    let clearSubmits = 0;
    const fakeTmux = {
      ...fakeCompactionTmux(),
      sendKeysLiteral: vi.fn(async (_pane: PaneRef, text: string) => { lastLiteral = text; }),
      sendEnter: vi.fn(async () => {
        if (lastLiteral === '/clear') clearSubmits++;
      }),
      capturePaneById: vi.fn(async () => {
        if (clearSubmits > 0) {
          const cur = await agentStore.get('dev-1');
          if (cur?.taskId === 't1') {
            await agentStore.set({ ...cur, taskId: 'next-task', updatedAt: new Date().toISOString() });
          }
          return "■ '/clear' is disabled while a task is in progress.\n› \n\n  repo · 100% context left";
        }
        return '› \n\n  repo · 100% context left';
      }),
    };

    await runPostMergeCompaction(fakeTmux, paneRef('dev-1', '%7'), 'dev-1', 't1', 'codex');

    expect(fakeTmux.clearComposerDraft.mock.calls.filter(([pane]) => (pane as PaneRef).paneId === '%7')).toHaveLength(1);
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('does not treat a reused Codex rejection toast as post-merge /clear success', async () => {
    await seedAgent({ taskId: 't1' });
    setPollMs(1);
    const releaseSpy = stubReleasePostMergeAgent();
    waitReadySpy.mockResolvedValue(undefined);

    let lastLiteral = '';
    let clearSubmits = 0;
    const fakeTmux = {
      ...fakeCompactionTmux(),
      sendKeysLiteral: vi.fn(async (_pane: PaneRef, text: string) => { lastLiteral = text; }),
      sendEnter: vi.fn(async () => {
        if (lastLiteral === '/clear') clearSubmits++;
      }),
      capturePaneById: vi.fn(async () => (
        clearSubmits > 0
          ? "■ '/clear' is disabled while a task is in progress.\n› \n\n  repo · 100% context left"
          : '› \n\n  repo · 100% context left'
      )),
    };

    await runPostMergeCompaction(fakeTmux, paneRef('dev-1', '%7'), 'dev-1', 't1', 'codex');

    const slashCalls = fakeTmux.sendKeysLiteral.mock.calls.filter(([, text]) => text === '/clear');
    expect(slashCalls).toHaveLength(2);
    const draftCalls = fakeTmux.clearComposerDraft.mock.calls.filter(([pane]) => (pane as PaneRef).paneId === '%7');
    expect(draftCalls).toHaveLength(2);
    const draftOrders = fakeTmux.clearComposerDraft.mock.invocationCallOrder;
    const slashOrders = fakeTmux.sendKeysLiteral.mock.calls
      .map((c, i) => (c[1] === '/clear' ? fakeTmux.sendKeysLiteral.mock.invocationCallOrder[i] : -1))
      .filter(order => order >= 0);
    expect(draftOrders[0]).toBeLessThan(slashOrders[0]);
    expect(draftOrders[1]).toBeLessThan(slashOrders[1]);
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 't1');
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('restarts and releases when Codex exits to shell before /clear lands', async () => {
    await seedAgent({ taskId: 't1' });
    setPollMs(1);
    const releaseSpy = stubReleasePostMergeAgent();
    const ensureSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: false,
      freshRuntime: true,
      paneId: '%9',
      pane: paneRef('dev-1', '%9'),
      sessionRef: REF,
      workdir: tempDir,
    });
    waitReadySpy
      .mockRejectedValueOnce(new Error('waitForReplPromptReady: pane %7 pane_current_command=zsh'))
      .mockRejectedValue(new Error('repl not ready'));

    const fakeTmux = {
      ...fakeCompactionTmux(),
      displayMessage: vi.fn().mockResolvedValue('zsh'),
    };

    await runPostMergeCompaction(fakeTmux, paneRef('dev-1', '%7'), 'dev-1', 't1', 'codex');

    expect(ensureSpy).toHaveBeenCalledWith('dev-1', 'runtime');
    expect(fakeTmux.sendKeysLiteral).not.toHaveBeenCalledWith(expect.objectContaining({ paneId: '%7' }), '/clear');
    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBe('%9');
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 't1');
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('recovers post-merge cleanup when the pane probe reports a missing pane', async () => {
    await seedAgent({ taskId: 't1' });
    const lockToken = await ensureTaskLock('dev-1', 't1');
    const ensureSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: false,
      freshRuntime: true,
      paneId: '%9',
      pane: paneRef('dev-1', '%9'),
      sessionRef: REF,
      workdir: tempDir,
    });
    const fakeTmux = {
      displayMessage: vi.fn().mockRejectedValue(new Error("tmux displayMessage %7 failed: can't find pane: %7")),
    };

    const recovered = await callPrivate<Promise<boolean>>(
      'recoverPostMergeExitedRuntime',
      fakeTmux,
      paneRef('dev-1', '%7'),
      'dev-1',
      't1',
      lockToken,
      'codex',
    );

    expect(recovered).toBe(true);
    expect(ensureSpy).toHaveBeenCalledWith('dev-1', 'runtime');
    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBe('%9');  });

  it('does not rewrite post-merge recovery state when the fresh runtime facts are already current', async () => {
    const updatedAt = '2026-06-26T00:00:00.000Z';
    await seedAgent({ taskId: 't1', workdir: tempDir, updatedAt });
    const lockToken = await ensureTaskLock('dev-1', 't1');
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: false,
      freshRuntime: true,
      paneId: '%7',
      pane: paneRef('dev-1', '%7'),
      sessionRef: REF,
      workdir: tempDir,
    });
    const fakeTmux = {
      displayMessage: vi.fn().mockResolvedValue('zsh'),
      sendKeysToPane: mockFn(),
    };

    const recovered = await callPrivate<Promise<boolean>>(
      'recoverPostMergeExitedRuntime',
      fakeTmux,
      paneRef('dev-1', '%7'),
      'dev-1',
      't1',
      lockToken,
      'codex',
    );

    expect(recovered).toBe(true);
    expect((await agentStore.get('dev-1'))?.updatedAt).toBe(updatedAt);
  });

  it('holds the agent (no release) when give-up cannot reach a clean composer', async () => {
    await seedAgent({ taskId: 't1' });
    setPollMs(1);
    const releaseSpy = stubReleasePostMergeAgent();
    waitReadySpy.mockResolvedValue(undefined);

    const fakeTmux = {
      ...fakeCompactionTmux(),
      clearComposerDraft: vi.fn().mockRejectedValue(new Error('keystroke failed')),
      hasSession: vi.fn().mockResolvedValue(true),
    };
    await runPostMergeCompaction(fakeTmux, paneRef('dev-1', '%7'), 'dev-1', 't1', 'claude-code');

    expect(releaseSpy).not.toHaveBeenCalled();
    expect(guardSet().has('dev-1')).toBe(false);
  });
});

describe('clearAgent', () => {
  it('sends /clear instead of /compact', async () => {
    await seedAgent();
    waitReadySpy.mockResolvedValue(undefined);

    await manager.clearAgent('dev-1');

    await vi.waitFor(() => expect(waitReadySpy).toHaveBeenCalledTimes(3));
    await expectGuardReleased('dev-1');

    const calls = execCalls();
    const literalIdx = calls.findIndex(c => c.includes('send-keys -l') && c.includes('/clear'));
    expect(literalIdx).toBeGreaterThanOrEqual(0);
    expect(calls.some(c => c.includes('/compact'))).toBe(false);
    const enterIdx = calls.findIndex((c, i) => i > literalIdx && c.includes('send-keys') && c.includes('Enter'));
    expect(enterIdx).toBeGreaterThan(literalIdx);
  });

  it('dirties the composer with a space before C-c for codex, so a leftover draft is cleared and an empty-composer C-c cannot kill the REPL', async () => {
    await seedAgent({ id: 'qa-1', paneId: '%3' });
    waitReadySpy.mockResolvedValue(undefined);

    await manager.clearAgent('qa-1');
    await expectGuardReleased('qa-1');

    expect(waitReadySpy.mock.calls[0][2]).toBe('codex');
    const calls = execCalls();
    expect(calls.some(c => c.includes('send-keys') && c.includes('Escape'))).toBe(false);
    const spaceIdx = calls.findIndex(c => c.includes('send-keys -l') && c.includes(SPACE_LITERAL));
    const ccIdx = calls.findIndex(c => c.includes('send-keys') && c.includes('C-c'));
    const literalIdx = calls.findIndex(c => c.includes('send-keys -l') && c.includes('/clear'));
    expect(spaceIdx).toBeGreaterThanOrEqual(0);
    expect(ccIdx).toBeGreaterThan(spaceIdx);
    expect(literalIdx).toBeGreaterThan(ccIdx);
    expect(calls[spaceIdx]).toContain("'%3'");
  });

  it('rejects 404 for an unknown agent', async () => {
    await expect(manager.clearAgent('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects 409 when a compact is already in flight', async () => {
    await seedAgent();
    const { gates, holder: compact } = await startGuarded();

    await expect(manager.clearAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });

    await drainHolderAndRelease(gates, compact, 'dev-1');
  });
});

describe('waitForReplPromptReady (narrow-pane width-independent idle detection)', () => {
  const NARROW_IDLE_SCREEN =
    '合并门），合并动作留给你。\n' +
    '你合并后我再做本地清理（删\n' +
    'feat/spec-human-approval\n' +
    '分支、切回 main），或者你直\n' +
    '接说一声我来跑 gh pr\n' +
    'merge。\n' +
    '\n' +
    '✻ Churned for 56s\n';

  function mockPaneState(procTitle: string, screen: string, title: string): void {
    (mockRunner.exec as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd.includes('pane_current_command')) return { stdout: `BX_PANE_OK${procTitle}\n`, stderr: '', exitCode: 0 };
      if (cmd.includes('pane_title')) return { stdout: `BX_PANE_OK${title}\n`, stderr: '', exitCode: 0 };
      return { stdout: `BX_PANE_OK\n${screen}`, stderr: '', exitCode: 0 };
    });
  }

  it('claude-code: narrow-pane reflowed idle screen (no anchor, no ❯) + "✳ " title → ready', async () => {
    setPollMs(5);
    mockPaneState('2.1.199', NARROW_IDLE_SCREEN, '✳ 分析 baxian 服务 DEV agent 不遵照指示问题');
    const tmux = new TmuxManager(mockRunner);
    await expect(
      callPrivate<Promise<void>>('waitForReplPromptReady', tmux, paneRef('dev-1', '%6'), 'claude-code', 1000),
    ).resolves.toBeUndefined();
  });

  it('claude-code: same narrow screen without the ✳ idle title still fails closed', async () => {
    setPollMs(5);
    mockPaneState('2.1.199', NARROW_IDLE_SCREEN, 'baxian');
    const tmux = new TmuxManager(mockRunner);
    await expect(
      callPrivate<Promise<void>>('waitForReplPromptReady', tmux, paneRef('dev-1', '%6'), 'claude-code', 200),
    ).rejects.toThrow(/repl not ready/);
  });
});
