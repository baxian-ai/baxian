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
import type { BaxianConfig } from '../../src/shared/index.js';
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
  it('waits for an idle prompt, clears the composer with C-c, then sends /compact + Enter', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString() });
    waitReadySpy.mockResolvedValue(undefined);

    await manager.compactAgent('dev-1');

    await vi.waitFor(() => expect(waitReadySpy).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => {
      expect(guardSet().has('dev-1')).toBe(false);
    });
    const [, paneId, runtime, timeoutMs] = waitReadySpy.mock.calls[0];
    expect(paneId).toBe('%7');
    expect(runtime).toBe('claude-code');
    expect(timeoutMs).toBe(5_000);

    const calls = execCalls();
    const ccIdx = calls.findIndex(c => c.includes('send-keys') && c.includes('C-c'));
    const literalIdx = calls.findIndex(c => c.includes('send-keys -l') && c.includes('/compact'));
    expect(ccIdx).toBeGreaterThanOrEqual(0);
    expect(literalIdx).toBeGreaterThan(ccIdx);
    expect(calls[literalIdx]).toContain("'%7'");
    const enterIdx = calls.findIndex((c, i) => i > literalIdx && c.includes('send-keys') && c.includes('Enter'));
    expect(enterIdx).toBeGreaterThan(literalIdx);
  });

  it('rejects 409 when a compact for the same agent is already in flight, and releases the guard after', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString() });
    const waitGates: Array<() => void> = [];
    waitReadySpy.mockImplementation(() => new Promise<void>(r => { waitGates.push(r); }));

    const first = manager.compactAgent('dev-1');
    await vi.waitFor(() => expect(waitGates.length).toBe(1));

    await expect(manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });

    waitGates[0]();
    await vi.waitFor(() => expect(waitGates.length).toBe(2));
    waitGates[1]();
    await first;

    await vi.waitFor(() => expect(waitGates.length).toBe(3));
    waitGates[2]();
    await vi.waitFor(() => expect(guardSet().has('dev-1')).toBe(false));

    waitReadySpy.mockResolvedValue(undefined);
    await expect(manager.compactAgent('dev-1')).resolves.toBeUndefined();
  });

  it('rejects 409 and sends nothing when the agent is re-dispatched (taskId changes) during the wait', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString() });
    waitReadySpy.mockImplementation(async () => {
      await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', taskId: 'task-new', updatedAt: new Date().toISOString() });
    });

    await expect(manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('session changed'),
    });
    expect(execCalls().some(c => c.includes('C-c') || c.includes('/compact'))).toBe(false);
  });

  it('rejects 409 and sends nothing when a same-task re-dispatch bumps updatedAt during the wait', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', taskId: 'task-1', updatedAt: '2026-06-12T08:00:00.000Z' });
    waitReadySpy.mockImplementation(async () => {
      // 同任务 phase 派发：paneId/taskId 均不变，仅 agent state 被重写。
      await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', taskId: 'task-1', updatedAt: '2026-06-12T08:00:01.000Z' });
    });

    await expect(manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('session changed'),
    });
    expect(execCalls().some(c => c.includes('C-c') || c.includes('/compact'))).toBe(false);
  });

  it('rejects 409 and sends nothing when the pane is rebuilt during the wait', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString() });
    waitReadySpy.mockImplementation(async () => {
      await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%9', updatedAt: new Date().toISOString() });
    });

    await expect(manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('session changed'),
    });
    expect(execCalls().some(c => c.includes('C-c') || c.includes('/compact'))).toBe(false);
  });

  it('passes the configured runtime through for a codex agent', async () => {
    await agentStore.set({ id: 'qa-1', projectId: 'proj', paneId: '%3', updatedAt: new Date().toISOString() });
    waitReadySpy.mockResolvedValue(undefined);

    await manager.compactAgent('qa-1');

    expect(waitReadySpy.mock.calls[0][2]).toBe('codex');
  });

  it('rejects 409 without sending anything when the runtime is not at an idle prompt', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString() });
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
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', taskId: 't1', updatedAt: '2026-06-12T09:00:00.000Z' });
    (manager as never as { compactIdlePollMs: number }).compactIdlePollMs = 1;
    vi.spyOn(
      manager as never as { releasePostMergeAgent: (...args: unknown[]) => Promise<void> },
      'releasePostMergeAgent',
    ).mockResolvedValue(undefined);
    const gates: Array<() => void> = [];
    waitReadySpy.mockImplementation(() => new Promise<void>(r => { gates.push(r); }));
    const fakeTmux = {
      injectPrompt: vi.fn().mockResolvedValue(undefined),
      sendEnter: vi.fn().mockResolvedValue(undefined),
      sendKeysLiteral: vi.fn().mockResolvedValue(undefined),
      sendKeysToPane: vi.fn().mockResolvedValue(undefined),
    };

    const manual = manager.compactAgent('dev-1');
    await vi.waitFor(() => expect(gates.length).toBe(1));

    const postMerge = (manager as never as {
      runPostMergeCompaction(...args: unknown[]): Promise<void>;
    }).runPostMergeCompaction(fakeTmux, '%7', 'dev-1', 't1', 'claude-code', 'cleanup prompt');
    await new Promise(r => setTimeout(r, 20));
    expect(fakeTmux.injectPrompt).not.toHaveBeenCalled();
    expect(gates.length).toBe(1);

    gates[0]();
    await vi.waitFor(() => expect(gates.length).toBe(2));
    gates[1]();
    await manual;

    await vi.waitFor(() => expect(gates.length).toBe(3));
    expect(fakeTmux.injectPrompt).not.toHaveBeenCalled();
    gates[2]();
    await vi.waitFor(() => expect(gates.length).toBe(4));
    gates[3]();
    await vi.waitFor(() => expect(fakeTmux.injectPrompt).toHaveBeenCalled());
    await vi.waitFor(() => expect(gates.length).toBe(5));
    gates[4]();
    await vi.waitFor(() => expect(gates.length).toBe(6));
    gates[5]();
    await postMerge;

    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('rejects image attach with 409 while a compact holds the guard', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString() });
    const gates: Array<() => void> = [];
    waitReadySpy.mockImplementation(() => new Promise<void>(r => { gates.push(r); }));

    const manual = manager.compactAgent('dev-1');
    await vi.waitFor(() => expect(gates.length).toBe(1));

    await expect(
      manager.attachImageToRunningAgent('dev-1', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'png'),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('in progress'),
    });

    gates[0]();
    await vi.waitFor(() => expect(gates.length).toBe(2));
    gates[1]();
    await manual;
    await vi.waitFor(() => expect(gates.length).toBe(3));
    gates[2]();
    await vi.waitFor(() => expect(guardSet().has('dev-1')).toBe(false));
  });

  it('keeps the guard until the runtime is idle again after /compact, blocking uploads meanwhile', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString() });
    const gates: Array<() => void> = [];
    waitReadySpy.mockImplementation(() => new Promise<void>(r => { gates.push(r); }));

    const manual = manager.compactAgent('dev-1');
    await vi.waitFor(() => expect(gates.length).toBe(1));
    gates[0]();
    await vi.waitFor(() => expect(gates.length).toBe(2));
    gates[1]();
    await manual;

    await expect(
      manager.attachImageToRunningAgent('dev-1', Buffer.from([0x89, 0x50]), 'png'),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('in progress') });

    await vi.waitFor(() => expect(gates.length).toBe(3));
    gates[2]();
    await vi.waitFor(() => expect(guardSet().has('dev-1')).toBe(false));

    await expect(
      manager.attachImageToRunningAgent('dev-1', Buffer.from([0x89, 0x50]), 'png'),
    ).resolves.toMatchObject({ path: expect.stringContaining('dev-1') });
  });

  it('dispatch injection waits for an in-flight compact instead of pasting concurrently', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString() });
    (manager as never as { compactIdlePollMs: number }).compactIdlePollMs = 1;
    const gates: Array<() => void> = [];
    waitReadySpy.mockImplementation(() => new Promise<void>(r => { gates.push(r); }));
    const fakeTmux = {
      injectPrompt: vi.fn().mockResolvedValue(undefined),
      captureSettledSnapshot: vi.fn().mockResolvedValue('snapshot'),
      sendEnter: vi.fn().mockResolvedValue(undefined),
      waitSubmitAck: vi.fn().mockResolvedValue(undefined),
    };

    const manual = manager.compactAgent('dev-1');
    await vi.waitFor(() => expect(gates.length).toBe(1));

    const dispatch = (manager as never as {
      injectAndAwaitAck(...args: unknown[]): Promise<{ acked: boolean }>;
    }).injectAndAwaitAck(fakeTmux, '%7', 'next prompt', 'dev-1', 'claude-code');
    await new Promise(r => setTimeout(r, 20));
    expect(fakeTmux.injectPrompt).not.toHaveBeenCalled();

    gates[0]();
    await vi.waitFor(() => expect(gates.length).toBe(2));
    gates[1]();
    await manual;
    await vi.waitFor(() => expect(gates.length).toBe(3));
    gates[2]();

    await expect(dispatch).resolves.toMatchObject({ acked: true });
    expect(fakeTmux.injectPrompt).toHaveBeenCalledWith('%7', 'next prompt', 'dev-1');
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('aborts a guarded dispatch when the binding is released while waiting (task cancelled)', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', taskId: 't1', updatedAt: new Date().toISOString() });
    (manager as never as { compactIdlePollMs: number }).compactIdlePollMs = 1;
    const gates: Array<() => void> = [];
    waitReadySpy.mockImplementation(() => new Promise<void>(r => { gates.push(r); }));
    const fakeTmux = {
      injectPrompt: vi.fn().mockResolvedValue(undefined),
      captureSettledSnapshot: vi.fn().mockResolvedValue('snapshot'),
      sendEnter: vi.fn().mockResolvedValue(undefined),
      waitSubmitAck: vi.fn().mockResolvedValue(undefined),
    };

    const manual = manager.compactAgent('dev-1');
    await vi.waitFor(() => expect(gates.length).toBe(1));

    const dispatch = (manager as never as {
      injectAndAwaitAck(...args: unknown[]): Promise<unknown>;
    }).injectAndAwaitAck(fakeTmux, '%7', 'stale prompt', 'dev-1', 'claude-code');
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString() });

    gates[0]();
    await expect(manual).rejects.toMatchObject({ status: 409 });

    await expect(dispatch).rejects.toThrow('binding changed');
    expect(fakeTmux.injectPrompt).not.toHaveBeenCalled();
    expect(guardSet().has('dev-1')).toBe(false);
  });

  it('read-file text injection waits for the guard, then pastes once it is released', async () => {
    await agentStore.set({ id: 'qa-1', projectId: 'proj', paneId: '%3', taskId: 't1', updatedAt: new Date().toISOString() });
    (manager as never as { compactIdlePollMs: number }).compactIdlePollMs = 1;
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined);
    const enterSpy = vi.spyOn(TmuxManager.prototype, 'sendEnter').mockResolvedValue(undefined);
    const gates: Array<() => void> = [];
    waitReadySpy.mockImplementation(() => new Promise<void>(r => { gates.push(r); }));

    const manual = manager.compactAgent('qa-1');
    await vi.waitFor(() => expect(gates.length).toBe(1));

    const inject = manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: 't1' });
    await new Promise(r => setTimeout(r, 20));
    expect(injectSpy).not.toHaveBeenCalled();

    gates[0]();
    await vi.waitFor(() => expect(gates.length).toBe(2));
    gates[1]();
    await manual;
    await vi.waitFor(() => expect(gates.length).toBe(3));
    gates[2]();

    await inject;
    expect(injectSpy).toHaveBeenCalledWith('%3', 'file body', 'qa-1');
    expect(enterSpy).toHaveBeenCalled();
    expect(guardSet().has('qa-1')).toBe(false);
  });

  it('drops stale read-file injection when the agent was rebound during the guard wait', async () => {
    await agentStore.set({ id: 'qa-1', projectId: 'proj', paneId: '%3', taskId: 't1', updatedAt: new Date().toISOString() });
    (manager as never as { compactIdlePollMs: number }).compactIdlePollMs = 1;
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined);
    const gates: Array<() => void> = [];
    waitReadySpy.mockImplementation(() => new Promise<void>(r => { gates.push(r); }));

    const manual = manager.compactAgent('qa-1');
    await vi.waitFor(() => expect(gates.length).toBe(1));

    const inject = manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: 't1' });
    await agentStore.set({ id: 'qa-1', projectId: 'proj', paneId: '%3', taskId: 't2', updatedAt: new Date().toISOString() });

    gates[0]();
    await expect(manual).rejects.toMatchObject({ status: 409 });

    await expect(inject).rejects.toThrow('no longer bound');
    expect(injectSpy).not.toHaveBeenCalledWith('%3', 'file body', 'qa-1');
    expect(guardSet().has('qa-1')).toBe(false);
  });

  it('rejects manual compact while an image upload holds the guard, then allows it after the upload completes', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString() });
    let releaseWrite: (() => void) | undefined;
    (mockRunner.writeFile as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<void>(r => { releaseWrite = r; }),
    );

    const upload = manager.attachImageToRunningAgent('dev-1', Buffer.from([0x89, 0x50]), 'png');
    await vi.waitFor(() => expect(mockRunner.writeFile).toHaveBeenCalled());

    await expect(manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });
    expect(execCalls().some(c => c.includes('C-c') || c.includes('/compact'))).toBe(false);

    releaseWrite?.();
    await upload;

    waitReadySpy.mockResolvedValue(undefined);
    await expect(manager.compactAgent('dev-1')).resolves.toBeUndefined();
  });

  it('rejects a second image upload while the first still holds the guard', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString() });
    let releaseWrite: (() => void) | undefined;
    (mockRunner.writeFile as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<void>(r => { releaseWrite = r; }),
    );

    const first = manager.attachImageToRunningAgent('dev-1', Buffer.from([0x89, 0x50]), 'png');
    await vi.waitFor(() => expect(mockRunner.writeFile).toHaveBeenCalled());

    await expect(
      manager.attachImageToRunningAgent('dev-1', Buffer.from([0x89, 0x50]), 'png'),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('in progress') });

    releaseWrite?.();
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
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString() });
    const gates: Array<() => void> = [];
    waitReadySpy.mockImplementation(() => new Promise<void>(r => { gates.push(r); }));

    const clear = manager.clearAgent('dev-1');
    await vi.waitFor(() => expect(gates.length).toBe(1));

    await expect(manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });

    gates[0]();
    await vi.waitFor(() => expect(gates.length).toBe(2));
    gates[1]();
    await clear;
    await vi.waitFor(() => expect(gates.length).toBe(3));
    gates[2]();
    await vi.waitFor(() => expect(guardSet().has('dev-1')).toBe(false));
  });

  it('rejects manual compact with 409 while post-merge compaction holds the shared guard', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', taskId: 't1', updatedAt: new Date().toISOString() });
    (manager as never as { compactIdlePollMs: number }).compactIdlePollMs = 1;
    const releaseSpy = vi.spyOn(
      manager as never as { releasePostMergeAgent: (...args: unknown[]) => Promise<void> },
      'releasePostMergeAgent',
    ).mockResolvedValue(undefined);
    const gates: Array<() => void> = [];
    waitReadySpy.mockImplementation(() => new Promise<void>(r => { gates.push(r); }));
    const fakeTmux = {
      injectPrompt: vi.fn().mockResolvedValue(undefined),
      sendEnter: vi.fn().mockResolvedValue(undefined),
      sendKeysLiteral: vi.fn().mockResolvedValue(undefined),
      sendKeysToPane: vi.fn().mockResolvedValue(undefined),
    };

    const run = (manager as never as {
      runPostMergeCompaction(...args: unknown[]): Promise<void>;
    }).runPostMergeCompaction(fakeTmux, '%7', 'dev-1', 't1', 'claude-code', 'cleanup prompt');
    await vi.waitFor(() => expect(gates.length).toBe(1));

    await expect(manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });

    gates[0]();
    await vi.waitFor(() => expect(gates.length).toBe(2));
    gates[1]();
    await vi.waitFor(() => expect(gates.length).toBe(3));
    gates[2]();
    await run;

    expect(releaseSpy).toHaveBeenCalledWith('dev-1', 't1');
    expect((manager as never as { compactInFlight: Set<string> }).compactInFlight.has('dev-1')).toBe(false);
  });
});

describe('clearAgent', () => {
  it('sends /clear instead of /compact', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString() });
    waitReadySpy.mockResolvedValue(undefined);

    await manager.clearAgent('dev-1');

    await vi.waitFor(() => expect(waitReadySpy).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(guardSet().has('dev-1')).toBe(false));

    const calls = execCalls();
    const literalIdx = calls.findIndex(c => c.includes('send-keys -l') && c.includes('/clear'));
    expect(literalIdx).toBeGreaterThanOrEqual(0);
    expect(calls.some(c => c.includes('/compact'))).toBe(false);
    const enterIdx = calls.findIndex((c, i) => i > literalIdx && c.includes('send-keys') && c.includes('Enter'));
    expect(enterIdx).toBeGreaterThan(literalIdx);
  });

  it('clears injectedSkills from the agent store after sending /clear', async () => {
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString(),
      injectedSkills: { taskId: 't1', paneId: '%7', skills: ['baxian-rules', 'task-check'] },
    });
    waitReadySpy.mockResolvedValue(undefined);

    await manager.clearAgent('dev-1');
    await vi.waitFor(() => expect(guardSet().has('dev-1')).toBe(false));

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills).toBeUndefined();
  });

  it('does not clear injectedSkills when sending /compact', async () => {
    await agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString(),
      injectedSkills: { taskId: 't1', paneId: '%7', skills: ['baxian-rules'] },
    });
    waitReadySpy.mockResolvedValue(undefined);

    await manager.compactAgent('dev-1');
    await vi.waitFor(() => expect(guardSet().has('dev-1')).toBe(false));

    const state = await agentStore.get('dev-1');
    expect(state?.injectedSkills).toEqual({ taskId: 't1', paneId: '%7', skills: ['baxian-rules'] });
  });

  it('rejects 404 for an unknown agent', async () => {
    await expect(manager.clearAgent('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects 409 when a compact is already in flight', async () => {
    await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%7', updatedAt: new Date().toISOString() });
    const gates: Array<() => void> = [];
    waitReadySpy.mockImplementation(() => new Promise<void>(r => { gates.push(r); }));

    const compact = manager.compactAgent('dev-1');
    await vi.waitFor(() => expect(gates.length).toBe(1));

    await expect(manager.clearAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });

    gates[0]();
    await vi.waitFor(() => expect(gates.length).toBe(2));
    gates[1]();
    await compact;
    await vi.waitFor(() => expect(gates.length).toBe(3));
    gates[2]();
    await vi.waitFor(() => expect(guardSet().has('dev-1')).toBe(false));
  });
});
