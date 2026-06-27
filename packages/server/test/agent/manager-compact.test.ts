import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentManager } from '../../src/agent/manager.js';
import { TmuxManager } from '../../src/agent/tmux.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { initStateDir } from '../../src/state/init.js';
import type { AgentBindingFacts, BaxianConfig } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';

const CONFIG: BaxianConfig = {
  review: { rounds: 10 },
  server: DEFAULT_SERVER_CONFIG,
  project: [{
    id: 'proj',
    repo: 'user/repo',
    merge: null,
    agent: [[
      { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '' },
      { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '' },
    ]],
  }],
};

let tempDir: string;
let agentStore: AgentStore;
let manager: AgentManager;
let mockRunner: CommandRunner;
let waitReadySpy: ReturnType<typeof vi.spyOn>;

function execCalls(): string[] {
  return (mockRunner.exec as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0]));
}

function guardSet(): Set<string> {
  return (manager as never as { compactInFlight: Set<string> }).compactInFlight;
}

function seedAgent(overrides: Partial<AgentBindingFacts> = {}): Promise<void> {
  return agentStore.set({
    id: 'dev-1',
    projectId: 'proj',
    paneId: '%7',
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
}

// Make waitForReplPromptReady block until the caller resolves the next queued gate.
// Each call to compact/clear/dispatch awaits the prompt 3x, so draining gates step-steps it.
function installGates(): Array<() => void> {
  const gates: Array<() => void> = [];
  waitReadySpy.mockImplementation(() => new Promise<void>(r => { gates.push(r); }));
  return gates;
}

function setPollMs(ms: number): void {
  (manager as never as { compactIdlePollMs: number }).compactIdlePollMs = ms;
}

// Call a private AgentManager method with `manager` as `this` (the method reads
// this.agentStore etc., so it must not be detached from the instance).
function callPrivate<T>(name: string, ...args: unknown[]): T {
  return (manager as never as Record<string, (...a: unknown[]) => T>)[name](...args);
}

function runPostMergeCompaction(...args: unknown[]): Promise<void> {
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
    sendEnter: mockFn(),
    waitSubmitAck: mockFn(),
    sendKeysLiteral: mockFn(),
    sendKeysToPane: mockFn(),
    capturePaneById: vi.fn().mockResolvedValue(''),
  };
}

function fakeDispatchTmux(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    injectPrompt: mockFn(), captureSettledSnapshot: vi.fn().mockResolvedValue('snapshot'),
    sendEnter: mockFn(), waitSubmitAck: mockFn(),
  };
}

function expectGuardReleased(id: string): Promise<void> {
  return vi.waitFor(() => expect(guardSet().has(id)).toBe(false));
}

function waitGates(gates: Array<() => void>, n: number): Promise<void> {
  return vi.waitFor(() => expect(gates.length).toBe(n));
}

// Drain the 3 prompt-ready gates a single compact/clear awaits, settling the
// holder promise mid-way (the third gate is opened last, releasing the guard).
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

// Install the gates, kick off a guard-holding operation (compact by default),
// and wait until it parks on its first prompt-ready gate.
async function startGuarded(
  start: () => Promise<unknown> = () => manager.compactAgent('dev-1'),
): Promise<{ gates: Array<() => void>; holder: Promise<unknown> }> {
  const gates = installGates();
  const holder = start();
  await waitGates(gates, 1);
  return { gates, holder };
}

// Start an image upload that blocks inside writeFile until releaseWrite() is
// called, so the upload holds the shared guard for the duration.
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
  await initStateDir(tempDir);

  const skillsDir = join(tempDir, 'skills');
  for (const s of ['baxian-rules', 'task-check', 'spells']) {
    await mkdir(join(skillsDir, s), { recursive: true });
    await writeFile(join(skillsDir, s, 'SKILL.md'), `# ${s}`);
  }
  const skillRegistry = new SkillRegistry(skillsDir);
  await skillRegistry.scan();

  agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
  const taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
  const lockManager = new LockManager(join(tempDir, 'locks'));
  const eventBus = new EventBus(new EventLog(join(tempDir, 'events')));

  mockRunner = {
    exec: vi.fn<(cmd: string) => Promise<ExecResult>>().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    writeFile: vi.fn<(p: string, c: Buffer | string) => Promise<void>>().mockResolvedValue(undefined),
  };

  const config: BaxianConfig = {
    ...CONFIG,
    project: CONFIG.project.map(p => ({
      ...p,
      agent: p.agent.map(pair => pair.map(a => ({ ...a, workdir: tempDir }))),
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
  });

  waitReadySpy = vi.spyOn(
    manager as never as { waitForReplPromptReady: (...args: unknown[]) => Promise<void> },
    'waitForReplPromptReady',
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true });
});

describe('compactAgent', () => {
  it('waits for an idle prompt, clears the composer with C-c (claude), then sends /compact + Enter', async () => {
    await seedAgent();
    waitReadySpy.mockResolvedValue(undefined);

    await manager.compactAgent('dev-1');

    await vi.waitFor(() => expect(waitReadySpy).toHaveBeenCalledTimes(3));
    await expectGuardReleased('dev-1');
    const [, paneId, runtime, timeoutMs] = waitReadySpy.mock.calls[0];
    expect(paneId).toBe('%7');
    expect(runtime).toBe('claude-code');
    expect(timeoutMs).toBe(5_000);

    const calls = execCalls();
    // Claude needs a double Ctrl-C to exit, so a single C-c safely clears a leftover composer draft.
    const ccIdx = calls.findIndex(c => c.includes('send-keys') && c.includes('C-c'));
    const literalIdx = calls.findIndex(c => c.includes('send-keys -l') && c.includes('/compact'));
    expect(ccIdx).toBeGreaterThanOrEqual(0);
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

  // A session change observed mid-wait (taskId flip, same-task updatedAt bump, or
  // pane rebuild) must abort with 409 before any C-c / /compact reaches tmux.
  it.each([
    {
      label: 're-dispatched (taskId changes)',
      seed: () => seedAgent(),
      reseed: () => seedAgent({ taskId: 'task-new' }),
    },
    {
      label: 'same-task re-dispatch bumps updatedAt',
      seed: () => seedAgent({ taskId: 'task-1', updatedAt: '2026-06-12T08:00:00.000Z' }),
      // 同任务 phase 派发：paneId/taskId 均不变，仅 agent state 被重写。
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

    const postMerge = runPostMergeCompaction(fakeTmux, '%7', 'dev-1', 't1', 'claude-code', 'cleanup prompt');
    await new Promise(r => setTimeout(r, 20));
    expect(fakeTmux.injectPrompt).not.toHaveBeenCalled();
    expect(gates.length).toBe(1);

    gates[0]();
    await waitGates(gates, 2);
    gates[1]();
    await manual;

    await waitGates(gates, 3);
    expect(fakeTmux.injectPrompt).not.toHaveBeenCalled();
    gates[2]();
    // post-merge runs 4 prompt-ready waits: pre-notification, post-notification, post-Esc, post-slash.
    await waitGates(gates, 4);
    gates[3]();
    await vi.waitFor(() => expect(fakeTmux.injectPrompt).toHaveBeenCalled());
    await waitGates(gates, 5);
    gates[4]();
    await waitGates(gates, 6);
    gates[5]();
    await waitGates(gates, 7);
    gates[6]();
    await postMerge;

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

    const dispatch = injectAndAwaitAck(fakeTmux, '%7', 'next prompt', 'dev-1', 'claude-code');
    await new Promise(r => setTimeout(r, 20));
    expect(fakeTmux.injectPrompt).not.toHaveBeenCalled();

    await drainHolderGates(gates, manual);

    await expect(dispatch).resolves.toMatchObject({ acked: true });
    expect(fakeTmux.injectPrompt).toHaveBeenCalledWith('%7', 'next prompt', 'dev-1');
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('aborts a guarded dispatch when the binding is released while waiting (task cancelled)', async () => {
    await seedAgent({ taskId: 't1' });
    setPollMs(1);
    const fakeTmux = fakeDispatchTmux();
    const { gates, holder: manual } = await startGuarded();

    const dispatch = injectAndAwaitAck(fakeTmux, '%7', 'stale prompt', 'dev-1', 'claude-code');
    await seedAgent();

    gates[0]();
    await expect(manual).rejects.toMatchObject({ status: 409 });

    await expect(dispatch).rejects.toThrow('binding changed');
    expect(fakeTmux.injectPrompt).not.toHaveBeenCalled();
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('read-file text injection waits for the guard, then pastes once it is released', async () => {
    await seedAgent({ id: 'qa-1', paneId: '%3', taskId: 't1' });
    setPollMs(1);
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined);
    const enterSpy = vi.spyOn(TmuxManager.prototype, 'sendEnter').mockResolvedValue(undefined);
    const { gates, holder: manual } = await startGuarded(() => manager.compactAgent('qa-1'));

    const inject = manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: 't1' });
    await new Promise(r => setTimeout(r, 20));
    expect(injectSpy).not.toHaveBeenCalled();

    await drainHolderGates(gates, manual);

    await inject;
    expect(injectSpy).toHaveBeenCalledWith('%3', 'file body', 'qa-1');
    expect(enterSpy).toHaveBeenCalled();
    expect(guardSet().has('qa-1')).toBe(false);
  });

  it('drops stale read-file injection when the agent was rebound during the guard wait', async () => {
    await seedAgent({ id: 'qa-1', paneId: '%3', taskId: 't1' });
    setPollMs(1);
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined);
    const { gates, holder: manual } = await startGuarded(() => manager.compactAgent('qa-1'));

    const inject = manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: 't1' });
    await seedAgent({ id: 'qa-1', paneId: '%3', taskId: 't2' });

    gates[0]();
    await expect(manual).rejects.toMatchObject({ status: 409 });

    await expect(inject).rejects.toThrow('no longer bound');
    expect(injectSpy).not.toHaveBeenCalledWith('%3', 'file body', 'qa-1');
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

    const run = runPostMergeCompaction(fakeTmux, '%7', 'dev-1', 't1', 'claude-code', 'cleanup prompt');
    await waitGates(gates, 1);

    await expect(manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });

    // 4 prompt-ready waits: pre-notification, post-notification, post-Esc interrupt, post-slash.
    gates[0]();
    await waitGates(gates, 2);
    gates[1]();
    await waitGates(gates, 3);
    gates[2]();
    await waitGates(gates, 4);
    gates[3]();
    await run;

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
      sendKeysLiteral: vi.fn(async (_paneId: string, text: string) => { lastLiteral = text; }),
      sendEnter: vi.fn(async () => {
        if (lastLiteral === '/clear') clearSubmits++;
      }),
      capturePaneById: vi.fn(async () => (
        clearSubmits === 1
          ? "■ '/clear' is disabled while a task is in progress.\n› \n\n  repo · 100% context left"
          : '› \n\n  repo · 100% context left'
      )),
    };

    await runPostMergeCompaction(fakeTmux, '%7', 'dev-1', 't1', 'codex', 'cleanup prompt', true);

    const slashCalls = fakeTmux.sendKeysLiteral.mock.calls.filter(([, text]) => text === '/clear');
    expect(slashCalls).toHaveLength(2);
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 't1');
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('interrupts with Esc before submitting the post-merge slash command', async () => {
    await seedAgent({ taskId: 't1' });
    setPollMs(1);
    const releaseSpy = stubReleasePostMergeAgent();
    waitReadySpy.mockResolvedValue(undefined);

    const fakeTmux = fakeCompactionTmux();

    await runPostMergeCompaction(fakeTmux, '%7', 'dev-1', 't1', 'codex', 'cleanup prompt', true);

    const escIdx = fakeTmux.sendKeysToPane.mock.calls.findIndex(([, key]) => key === 'Escape');
    const clearIdx = fakeTmux.sendKeysLiteral.mock.calls.findIndex(([, text]) => text === '/clear');
    expect(escIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(fakeTmux.sendKeysToPane).toHaveBeenCalledWith('%7', 'Escape');
    // Esc must precede /clear so a still-running turn can't reject the slash command.
    expect(fakeTmux.sendKeysToPane.mock.invocationCallOrder[escIdx])
      .toBeLessThan(fakeTmux.sendKeysLiteral.mock.invocationCallOrder[clearIdx]);
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 't1');
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
      sendKeysLiteral: vi.fn(async (_paneId: string, text: string) => { lastLiteral = text; }),
      sendEnter: vi.fn(async () => {
        if (lastLiteral === '/clear') clearSubmits++;
      }),
      capturePaneById: vi.fn(async () => (
        clearSubmits > 0
          ? "■ '/clear' is disabled while a task is in progress.\n› \n\n  repo · 100% context left"
          : '› \n\n  repo · 100% context left'
      )),
    };

    await runPostMergeCompaction(fakeTmux, '%7', 'dev-1', 't1', 'codex', 'cleanup prompt', true);

    const slashCalls = fakeTmux.sendKeysLiteral.mock.calls.filter(([, text]) => text === '/clear');
    expect(slashCalls).toHaveLength(4);
    expect(fakeTmux.sendKeysToPane).toHaveBeenCalledWith('%7', 'C-c');
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 't1');
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('submits the post-merge notification via waitSubmitAck with a swallowed-Enter resend guard', async () => {
    await seedAgent({ taskId: 't1' });
    setPollMs(1);
    stubReleasePostMergeAgent();
    waitReadySpy.mockResolvedValue(undefined);

    const fakeTmux = fakeCompactionTmux();
    await runPostMergeCompaction(fakeTmux, '%7', 'dev-1', 't1', 'claude-code', 'PR merged notice', true);

    expect(fakeTmux.injectPrompt).toHaveBeenCalledWith('%7', 'PR merged notice', 'dev-1');
    expect(fakeTmux.captureSettledSnapshot).toHaveBeenCalledWith('%7', expect.any(Object));
    expect(fakeTmux.waitSubmitAck).toHaveBeenCalledTimes(1);
    // Settle (baseline w/ pasted text) → ack must run after the paste so a swallowed Enter is detected
    // on the unchanged composer.
    expect(fakeTmux.captureSettledSnapshot.mock.invocationCallOrder[0])
      .toBeLessThan(fakeTmux.waitSubmitAck.mock.invocationCallOrder[0]);
    expect(fakeTmux.injectPrompt.mock.invocationCallOrder[0])
      .toBeLessThan(fakeTmux.captureSettledSnapshot.mock.invocationCallOrder[0]);

    // The resend callback re-sends Enter — recovering the first Enter the TUI swallows after a paste.
    const ackOpts = fakeTmux.waitSubmitAck.mock.calls[0][3] as { resend: () => Promise<void> };
    expect(typeof ackOpts.resend).toBe('function');
    const before = fakeTmux.sendEnter.mock.calls.length;
    await ackOpts.resend();
    expect(fakeTmux.sendEnter.mock.calls.length).toBe(before + 1);
  });

  it('treats a post-merge notification ack timeout as best-effort: still /clears, no C-c retry', async () => {
    await seedAgent({ taskId: 't1' });
    setPollMs(1);
    const releaseSpy = stubReleasePostMergeAgent();
    waitReadySpy.mockResolvedValue(undefined);

    const fakeTmux = {
      ...fakeCompactionTmux(),
      waitSubmitAck: vi.fn().mockRejectedValue(new Error('runtime ack timeout')),
    };
    await runPostMergeCompaction(fakeTmux, '%7', 'dev-1', 't1', 'claude-code', 'PR merged notice', true);

    expect(fakeTmux.sendKeysLiteral).toHaveBeenCalledWith('%7', '/clear');
    expect(fakeTmux.sendKeysToPane).not.toHaveBeenCalledWith('%7', 'C-c');
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 't1');
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('restarts and releases when Codex exits to shell after the post-merge notification', async () => {
    await seedAgent({ taskId: 't1', injectedSkills: { taskId: 't1', paneId: '%7', skills: ['task-check'] } });
    setPollMs(1);
    const releaseSpy = stubReleasePostMergeAgent();
    const ensureSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: false,
      freshRuntime: true,
      paneId: '%9',
      workdir: tempDir,
    });
    waitReadySpy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('waitForReplPromptReady: pane %7 pane_current_command=zsh'))
      .mockRejectedValueOnce(new Error('repl not ready'));

    const fakeTmux = {
      ...fakeCompactionTmux(),
      displayMessage: vi.fn().mockResolvedValue('zsh'),
      waitSubmitAck: vi.fn().mockRejectedValue(new Error('runtime ack timeout')),
    };

    await runPostMergeCompaction(fakeTmux, '%7', 'dev-1', 't1', 'codex', 'PR merged notice', true);

    expect(ensureSpy).toHaveBeenCalledWith('dev-1', 'runtime');
    expect(fakeTmux.sendKeysLiteral).not.toHaveBeenCalledWith('%7', '/clear');
    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBe('%9');
    expect(state?.injectedSkills).toBeUndefined();
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 't1');
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('clears a dirty shell composer before restarting a post-merge runtime', async () => {
    await seedAgent({ taskId: 't1' });
    setPollMs(1);
    const releaseSpy = stubReleasePostMergeAgent();
    const ensureSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: false,
      freshRuntime: true,
      paneId: '%9',
      workdir: tempDir,
    });
    waitReadySpy
      .mockRejectedValueOnce(new Error('first attempt failed before paste'))
      .mockResolvedValueOnce(undefined);

    const fakeTmux = {
      ...fakeCompactionTmux(),
      displayMessage: vi.fn().mockResolvedValue('zsh'),
      captureSettledSnapshot: vi.fn().mockRejectedValue(new Error('settle failed after paste')),
    };

    await runPostMergeCompaction(fakeTmux, '%7', 'dev-1', 't1', 'codex', 'PR merged notice', true);

    expect(fakeTmux.injectPrompt).toHaveBeenCalledWith('%7', 'PR merged notice', 'dev-1');
    const ccCallIndexes = fakeTmux.sendKeysToPane.mock.calls
      .map(([, key], index) => ({ key, index }))
      .filter(({ key }) => key === 'C-c')
      .map(({ index }) => index);
    expect(ccCallIndexes).toHaveLength(2);
    const recoveryCcOrder = fakeTmux.sendKeysToPane.mock.invocationCallOrder[ccCallIndexes[1]];
    expect(fakeTmux.injectPrompt.mock.invocationCallOrder[0]).toBeLessThan(recoveryCcOrder);
    expect(recoveryCcOrder).toBeLessThan(ensureSpy.mock.invocationCallOrder[0]);
    expect(fakeTmux.sendKeysLiteral).not.toHaveBeenCalledWith('%7', '/clear');
    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 't1');
  });

  it('recovers post-merge cleanup when the pane probe reports a missing pane', async () => {
    await seedAgent({ taskId: 't1', injectedSkills: { taskId: 't1', paneId: '%7', skills: ['task-check'] } });
    const ensureSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: false,
      freshRuntime: true,
      paneId: '%9',
      workdir: tempDir,
    });
    const fakeTmux = {
      displayMessage: vi.fn().mockRejectedValue(new Error("tmux displayMessage %7 failed: can't find pane: %7")),
    };

    const recovered = await callPrivate<Promise<boolean>>(
      'recoverPostMergeExitedRuntime',
      fakeTmux,
      '%7',
      'dev-1',
      't1',
      'codex',
    );

    expect(recovered).toBe(true);
    expect(ensureSpy).toHaveBeenCalledWith('dev-1', 'runtime');
    const state = await agentStore.get('dev-1');
    expect(state?.paneId).toBe('%9');
    expect(state?.injectedSkills).toBeUndefined();
  });

  it('does not rewrite post-merge recovery state when the fresh runtime facts are already current', async () => {
    const updatedAt = '2026-06-26T00:00:00.000Z';
    await seedAgent({ taskId: 't1', repoPath: tempDir, updatedAt });
    vi.spyOn(manager, 'ensureSession').mockResolvedValue({
      ok: true,
      createdSession: false,
      freshRuntime: true,
      paneId: '%7',
      workdir: tempDir,
    });
    const fakeTmux = {
      displayMessage: vi.fn().mockResolvedValue('zsh'),
      sendKeysToPane: mockFn(),
    };

    const recovered = await callPrivate<Promise<boolean>>(
      'recoverPostMergeExitedRuntime',
      fakeTmux,
      '%7',
      'dev-1',
      't1',
      'codex',
    );

    expect(recovered).toBe(true);
    expect((await agentStore.get('dev-1'))?.updatedAt).toBe(updatedAt);
  });

  it('propagates a NON-timeout notification ack error to the retry (not best-effort swallow)', async () => {
    await seedAgent({ taskId: 't1' });
    setPollMs(1);
    stubReleasePostMergeAgent();
    waitReadySpy.mockResolvedValue(undefined);

    const fakeTmux = {
      ...fakeCompactionTmux(),
      waitSubmitAck: vi.fn()
        .mockRejectedValueOnce(new Error('capturePaneSnapshot failed')) // infra error, not an ack timeout
        .mockResolvedValue(undefined),
    };
    await runPostMergeCompaction(fakeTmux, '%7', 'dev-1', 't1', 'claude-code', 'PR merged notice', true);

    // Attempt 1's infra error aborted the attempt (not swallowed) → attempt 2 re-injected + C-c'd.
    expect(fakeTmux.injectPrompt.mock.calls.filter(([, p]) => p === 'PR merged notice')).toHaveLength(2);
    expect(fakeTmux.sendKeysToPane).toHaveBeenCalledWith('%7', 'C-c');
    expect(fakeTmux.sendKeysLiteral).toHaveBeenCalledWith('%7', '/clear');
  });

  it('holds the agent (no release) when give-up cannot clear an unsubmitted notification', async () => {
    await seedAgent({ taskId: 't1' });
    setPollMs(1);
    const releaseSpy = stubReleasePostMergeAgent();
    waitReadySpy.mockResolvedValue(undefined);

    // Pre-Enter settle fails on every attempt → give up before submit; C-c also fails and the session
    // is still up → composer can't be confirmed clear, so the dirty pane must NOT be released for reuse.
    const fakeTmux = {
      ...fakeCompactionTmux(),
      captureSettledSnapshot: vi.fn().mockRejectedValue(new Error('capture failed')),
      sendKeysToPane: vi.fn().mockRejectedValue(new Error('C-c failed')),
      hasSession: vi.fn().mockResolvedValue(true),
    };
    await runPostMergeCompaction(fakeTmux, '%7', 'dev-1', 't1', 'claude-code', 'PR merged notice', true);

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

  // Regression: a single Ctrl-C on an empty Codex composer quits Codex (openai/codex#14708). The
  // three-dot-menu /clear must interrupt with Escape so a codex runtime survives the clear.
  it('interrupts with Escape and never C-c for a codex agent so Codex is not killed', async () => {
    await seedAgent({ id: 'qa-1', paneId: '%3' });
    waitReadySpy.mockResolvedValue(undefined);

    await manager.clearAgent('qa-1');
    await expectGuardReleased('qa-1');

    expect(waitReadySpy.mock.calls[0][2]).toBe('codex');
    const calls = execCalls();
    expect(calls.some(c => c.includes('send-keys') && c.includes('C-c'))).toBe(false);
    const escIdx = calls.findIndex(c => c.includes('send-keys') && c.includes('Escape'));
    const literalIdx = calls.findIndex(c => c.includes('send-keys -l') && c.includes('/clear'));
    expect(escIdx).toBeGreaterThanOrEqual(0);
    expect(literalIdx).toBeGreaterThan(escIdx);
    expect(calls[escIdx]).toContain("'%3'");
  });

  it('clears injectedSkills from the agent store after sending /clear', async () => {
    await seedAgent({ injectedSkills: { taskId: 't1', paneId: '%7', skills: ['baxian-rules', 'task-check'] } });
    waitReadySpy.mockResolvedValue(undefined);

    await manager.clearAgent('dev-1');
    await expectGuardReleased('dev-1');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills).toBeUndefined();
  });

  it('does not clear injectedSkills when sending /compact', async () => {
    await seedAgent({ injectedSkills: { taskId: 't1', paneId: '%7', skills: ['baxian-rules'] } });
    waitReadySpy.mockResolvedValue(undefined);

    await manager.compactAgent('dev-1');
    await expectGuardReleased('dev-1');

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills).toEqual({ taskId: 't1', paneId: '%7', skills: ['baxian-rules'] });
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
