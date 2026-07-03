import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianConfig } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import {
  AgentManager,
  CleanupFailedError,
  EnsureSessionError,
} from '../../src/agent/manager.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { WorktreeManager } from '../../src/agent/worktree.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import { initStateDir } from '../../src/state/init.js';

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

describe('AgentManager.ensureSession', () => {
  let tempDir: string;
  let manager: AgentManager;
  let runner: { exec: ReturnType<typeof vi.fn>; writeFile: ReturnType<typeof vi.fn> };

  let tmuxSessions: Map<string, { claim: string; readyOnce: boolean }>;
  let currentSkillsVersion = '';

  function execCmds(): string[] {
    return runner.exec.mock.calls.map(c => c[0] as string);
  }

  function setOptionCalls(...needles: string[]): string[] {
    return execCmds().filter(
      c => c.includes('set-option') && needles.every(n => c.includes(n)),
    );
  }

  function runEnsure(path: 'create' | 'adopt'): Promise<unknown> {
    if (path === 'adopt') {
      tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
      return manager.ensureSession('dev-1', 'runtime');
    }
    return manager.ensureSession('dev-1', 'create');
  }

  function overrideExec(when: (cmd: string) => boolean, response: Partial<ExecResult>): void {
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> =>
      when(cmd)
        ? { stdout: '', stderr: '', exitCode: 0, ...response }
        : makeMockExec({ trustDialogReady: true })(cmd));
  }

  function makeStreamerMgr(destroy: ReturnType<typeof vi.fn>): {
    destroy: typeof destroy; ensure: ReturnType<typeof vi.fn>;
    has: ReturnType<typeof vi.fn>; enqueueInput: ReturnType<typeof vi.fn>;
  } {
    return { destroy, ensure: vi.fn(), has: vi.fn(), enqueueInput: vi.fn() };
  }

  function mockCleanupExec(onKill: () => void): void {
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('kill-session')) {
        onKill();
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('has-session')) {
        const name = cmd.match(/'=([^']+)'/)?.[1] ?? '';
        return tmuxSessions.has(name)
          ? { stdout: '', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: `can't find session: ${name}`, exitCode: 1 };
      }
      if (cmd.includes('show-option')) {
        const name = cmd.match(/'=([^']+):'/)?.[1] ?? '';
        const sess = tmuxSessions.get(name);
        return sess
          ? { stdout: `${sess.claim}\n`, stderr: '', exitCode: 0 }
          : { stdout: '', stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
  }

  function makeManager(suffix: string, paneStreamerManager: unknown): AgentManager {
    return new AgentManager({
      config: CONFIG,
      agentStore: new AgentStore(join(tempDir, 'state', `agents-${suffix}`)),
      taskStore: new TaskStore(join(tempDir, 'state', `tasks-${suffix}`)),
      lockManager: new LockManager(join(tempDir, `locks-${suffix}`)),
      eventBus: new EventBus(new EventLog(join(tempDir, `events-${suffix}`))),
      skillRegistry: new SkillRegistry(join(tempDir, `skills-${suffix}`)),
      runnerFactory: () => runner as unknown as CommandRunner,
      paneStreamerManager: paneStreamerManager as never,
    });
  }

  function expandedConfig(): BaxianConfig {
    return {
      ...CONFIG,
      project: [{
        ...CONFIG.project[0],
        agent: [
          [
            { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/repo', yolo: true },
            { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/repo', yolo: true },
          ],
        ],
      }],
    };
  }

  async function setPaneId(id: string, paneId: string): Promise<void> {
    const store = manager['agentStore'];
    await store.set({ ...(await store.get(id))!, paneId });
  }

  function seedRunningTask(id: string): Promise<void> {
    const now = new Date().toISOString();
    return manager['taskStore'].set({
      id,
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      branch: `bx/${id}`,
      reviewRound: 0,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    });
  }

  function makeMockExec(
    overrides: { trustDialogReady?: boolean } = {},
  ): (cmd: string) => Promise<ExecResult> {
    return async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('has-session')) {
        const m = cmd.match(/'=([^']+)'/);
        const name = m?.[1] ?? '';
        return tmuxSessions.has(name)
          ? { stdout: '', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: `can't find session: ${name}`, exitCode: 1 };
      }
      if (cmd.includes('new-session')) {
        const m = cmd.match(/-s '([^']+)'/);
        const name = m?.[1] ?? '';
        tmuxSessions.set(name, { claim: name, readyOnce: false });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('set-option')) {
        const m = cmd.match(/'=([^']+):'/);
        const name = m?.[1] ?? '';
        if (cmd.includes('@baxian-agent-id')) {
          const sess = tmuxSessions.get(name);
          if (sess) {
            const valM = cmd.match(/@baxian-agent-id '([^']+)'/);
            sess.claim = valM?.[1] ?? name;
          }
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('show-option')) {
        const m = cmd.match(/'=([^']+):'/);
        const name = m?.[1] ?? '';
        const sess = tmuxSessions.get(name);
        if (!sess) return { stdout: '', stderr: '', exitCode: 1 };
        if (cmd.includes('@baxian-agent-id')) {
          return { stdout: `${sess.claim}\n`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('@baxian-skills-version')) {
          return { stdout: `${currentSkillsVersion}\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('list-panes')) {
        return { stdout: '%0 zsh\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('send-keys')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('display-message') && cmd.includes('capture-pane')) {
        return {
          stdout: 'claude\n___bx-classify-sep___\n⏵⏵ bypass permissions on\n',
          stderr: '', exitCode: 0,
        };
      }
      if (cmd.includes('capture-pane')) {
        if (overrides.trustDialogReady) {
          return {
            stdout: '⏵⏵ bypass permissions on\n',
            stderr: '', exitCode: 0,
          };
        }
        return {
          stdout: '⏵⏵ bypass permissions on\n',
          stderr: '', exitCode: 0,
        };
      }
      if (cmd.includes('display-message')) {
        return { stdout: 'claude\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'baxian-ensure-session-'));
    await initStateDir(tempDir);
    tmuxSessions = new Map<string, { claim: string; readyOnce: boolean }>();

    runner = { exec: vi.fn(), writeFile: vi.fn().mockResolvedValue(undefined) };
    runner.exec.mockImplementation(makeMockExec({ trustDialogReady: true }));

    const agentStore = new AgentStore(join(tempDir, 'state', 'agents'));
    const taskStore = new TaskStore(join(tempDir, 'state', 'tasks'));
    const lockManager = new LockManager(join(tempDir, 'locks'));
    const eventLog = new EventLog(join(tempDir, 'events'));
    const eventBus = new EventBus(eventLog);
    const skillsDir = join(tempDir, 'skills');
    for (const name of ['baxian-rules', 'baxian-task-check', 'baxian-pr-feedback', 'baxian-pr-review', 'baxian-pr-recheck', 'baxian-signals']) {
      await mkdir(join(skillsDir, name), { recursive: true });
      await writeFile(
        join(skillsDir, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name} stub\n---\nstub`,
      );
    }
    const skillRegistry = new SkillRegistry(skillsDir);
    await skillRegistry.scan();
    currentSkillsVersion = skillRegistry.contentHash();

    manager = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry,
      runnerFactory: () => runner as unknown as CommandRunner,
      bootstrapTimeoutsMs: { trustDialog: 200, waitReplReady: 400 },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('create mode, no existing session → builds + claim + paneId', async () => {
    const result = await manager.ensureSession('dev-1', 'create');
    expect(result.ok).toBe(true);
    expect(result.createdSession).toBe(true);
    expect(result.paneId).toBe('%0');
    expect(tmuxSessions.has('dev-1')).toBe(true);
    expect(tmuxSessions.get('dev-1')?.claim).toBe('dev-1');
  });

  it('create mode, session already exists → throws (createdSession=false)', async () => {
    tmuxSessions.set('dev-1', { claim: 'someone-else', readyOnce: true });
    await expect(manager.ensureSession('dev-1', 'create'))
      .rejects.toThrow(/already exists/);
    try {
      await manager.ensureSession('dev-1', 'create');
    } catch (err) {
      expect(err).toBeInstanceOf(EnsureSessionError);
      expect((err as EnsureSessionError).partial.createdSession).toBe(false);
    }
  });

  it('new-session ok but post-create setOption fails → partial.createdSession=true so caller can rollback orphan', async () => {
    let setOptionCalls = 0;
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('new-session')) {
        const m = cmd.match(/-s '([^']+)'/);
        const name = m?.[1] ?? '';
        tmuxSessions.set(name, { claim: name, readyOnce: false });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('set-option') && !cmd.includes('-s ')) {
        setOptionCalls += 1;
        if (setOptionCalls === 3) {
          return { stdout: '', stderr: 'tmux command failed: bad option', exitCode: 1 };
        }
      }
      return makeMockExec({ trustDialogReady: true })(cmd);
    });
    try {
      await manager.ensureSession('dev-1', 'create');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnsureSessionError);
      expect((err as EnsureSessionError).partial.createdSession).toBe(true);
      expect((err as EnsureSessionError).partial.agentId).toBe('dev-1');
    }
    expect(tmuxSessions.has('dev-1')).toBe(true);
  });

  it('runtime mode, claim matches → adopts existing session', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    const result = await manager.ensureSession('dev-1', 'runtime');
    expect(result.createdSession).toBe(false);
    expect(result.paneId).toBe('%0');
  });

  it('runtime mode, shell relaunch path tags the session with the skills version (so the next adopt is not seen stale)', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    overrideExec(
      c => c.includes('display-message') && c.includes('capture-pane'),
      { stdout: 'zsh\n___bx-classify-sep___\n' },
    );
    await manager.ensureSession('dev-1', 'runtime');
    expect(setOptionCalls('@baxian-skills-version').length).toBeGreaterThan(0);
  });

  it('runtime mode, live REPL with a stale skills version → kills + rebuilds so /baxian-* resolves', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    overrideExec(
      c => c.includes('show-option') && c.includes('@baxian-skills-version'),
      { stdout: 'stale-version\n' },
    );
    const result = await manager.ensureSession('dev-1', 'runtime');
    expect(result.createdSession).toBe(true);
    const calls = execCmds();
    expect(calls.some(c => c.includes('kill-session'))).toBe(true);
    expect(calls.some(c => c.includes('new-session'))).toBe(true);
  });

  it('runtime mode, a tmux probe failure during the skills-version check surfaces as EnsureSessionError (does NOT kill the live REPL)', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    overrideExec(
      c => c.includes('show-option') && c.includes('@baxian-skills-version'),
      { stderr: 'tmux probe boom', exitCode: 2 },
    );
    await expect(manager.ensureSession('dev-1', 'runtime')).rejects.toThrow(/skills-version probe failed/);
    expect(execCmds().some(c => c.includes('kill-session'))).toBe(false);
  });

  it('create path pins window-size=latest so plain tmux attach follows the current terminal size', async () => {
    await runEnsure('create');
    const windowSizeCalls = setOptionCalls('window-size', 'latest');
    expect(windowSizeCalls).toHaveLength(1);
    expect(windowSizeCalls[0]).toContain("'=dev-1:'");
  });

  it('adopt path preserves the existing window-size owner', async () => {
    await runEnsure('adopt');
    expect(setOptionCalls('window-size')).toHaveLength(0);
  });

  it.each(['create', 'adopt'] as const)('%s path locks prefix=C-b + prefix2=None', async (path) => {
    await runEnsure(path);
    expect(setOptionCalls("'prefix'", "'C-b'")).toHaveLength(1);
    expect(setOptionCalls("'prefix2'", "'None'")).toHaveLength(1);
  });

  it.each(['create', 'adopt'] as const)('%s path pins mouse=on', async (path) => {
    await runEnsure(path);
    const mouseOn = setOptionCalls("'mouse'", "'on'");
    expect(mouseOn).toHaveLength(1);
    expect(mouseOn[0]).toContain("'=dev-1:'");
    if (path === 'create') expect(setOptionCalls("'mouse'", "'off'")).toHaveLength(0);
  });

  it('adopt path: runtime option failure surfaces as EnsureSessionError (preserves partial contract)', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    overrideExec(
      c => c.includes('set-option') && c.includes("'prefix'") && c.includes("'C-b'"),
      { stderr: 'tmux command failed: bad option', exitCode: 1 },
    );
    try {
      await manager.ensureSession('dev-1', 'runtime');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnsureSessionError);
      const e = err as EnsureSessionError;
      expect(e.partial.createdSession).toBe(false);
      expect(e.partial.agentId).toBe('dev-1');
      expect(e.message).toContain('pinRuntimeSessionOptions failed');
    }
  });

  it('runtime mode, claim mismatch → throws (createdSession=false)', async () => {
    tmuxSessions.set('dev-1', { claim: 'someone-else', readyOnce: true });
    try {
      await manager.ensureSession('dev-1', 'runtime');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnsureSessionError);
      const e = err as EnsureSessionError;
      expect(e.partial.createdSession).toBe(false);
      expect(e.message).toContain('session claim mismatch');
    }
  });

  it('runtime mode, no session → auto-builds (createdSession=true)', async () => {
    const result = await manager.ensureSession('dev-1', 'runtime');
    expect(result.createdSession).toBe(true);
    expect(tmuxSessions.has('dev-1')).toBe(true);
  });

  it.each([
    {
      label: 'dialog signal triggers dialogPending=true',
      screen: '✨ Update available! 0.128.0 -> 0.129.0\n'
        + '› 1. Update now  2. Skip  3. Skip until next version\n'
        + 'Press enter to continue\n',
      dialogPending: true,
      lastScreen: 'Press enter to continue',
      message: 'Last pane snapshot',
    },
    {
      label: 'timeout WITHOUT dialog signal → dialogPending stays false',
      screen: 'still booting...\nno anchor here\n',
      dialogPending: false,
      lastScreen: 'still booting',
      message: undefined,
    },
  ])('waitReplReady captures last screen ($label)', async ({ screen, dialogPending, lastScreen, message }) => {
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('new-session')) {
        const name = cmd.match(/-s '([^']+)'/)?.[1] ?? '';
        tmuxSessions.set(name, { claim: name, readyOnce: false });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('list-panes')) return { stdout: '%0 zsh\n', stderr: '', exitCode: 0 };
      if (cmd.includes('capture-pane')) return { stdout: screen, stderr: '', exitCode: 0 };
      if (cmd.includes('display-message')) return { stdout: 'node\n', stderr: '', exitCode: 0 };
      return makeMockExec()(cmd);
    });
    try {
      await manager.ensureSession('dev-1', 'create');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnsureSessionError);
      const e = err as EnsureSessionError;
      expect(e.partial.createdSession).toBe(true);
      if (dialogPending) expect(e.partial.dialogPending).toBe(true);
      else expect(e.partial.dialogPending).toBeFalsy();
      expect(e.partial.lastScreen).toContain(lastScreen);
      if (message) expect(e.message).toContain(message);
    }
  });

  it('Unknown agent → EnsureSessionError without touching tmux', async () => {
    runner.exec.mockClear();
    await expect(manager.ensureSession('nonexistent', 'create'))
      .rejects.toBeInstanceOf(EnsureSessionError);
    expect(runner.exec).not.toHaveBeenCalled();
  });

  it('acquireAgentForTask records taskId; lock contention returns false', async () => {
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(true);
    const state = await manager['agentStore'].get('dev-1');
    expect(state?.taskId).toBe('task-1');
    expect(await manager.acquireAgentForTask('dev-1', 'task-2', 'develop')).toBe(false);
  });

  it.each(['fix', 'post-approve'] as const)(
    'acquireAgentForTask reuses an existing lock when phase=%s and same task',
    async (phase) => {
      expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(true);
      expect(await manager.acquireAgentForTask('dev-1', 'task-1', phase)).toBe(true);
    },
  );

  it('releaseAgentForTask returns false on stale taskId (do not touch new assignment)', async () => {
    await manager.acquireAgentForTask('dev-1', 'task-1', 'develop');
    expect(await manager.releaseAgentForTask('dev-1', 'task-OTHER', 'idle')).toBe(false);
    const state = await manager['agentStore'].get('dev-1');
    expect(state?.taskId).toBe('task-1');
  });

  it('releaseAgentForTask mode=waiting keeps the binding without releasing lock', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    await seedRunningTask('task-1');
    await manager.acquireAgentForTask('dev-1', 'task-1', 'develop');
    const ensure = await manager.ensureSession('dev-1', 'runtime');
    await setPaneId('dev-1', ensure.paneId);
    expect(await manager.releaseAgentForTask('dev-1', 'task-1', 'waiting')).toBe(true);
    const state = await manager['agentStore'].get('dev-1');
    expect(state?.taskId).toBe('task-1');
    expect(await manager['lockManager'].isLocked('dev-1')).toBe(true);
  });

  it('release on a non-ready pane (mode=idle): clears binding and lock regardless of REPL state', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    await seedRunningTask('task-r1');
    await manager.acquireAgentForTask('dev-1', 'task-r1', 'develop');
    await setPaneId('dev-1', '%0');
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('capture-pane')) return { stdout: '$ \n', stderr: '', exitCode: 0 };
      if (cmd.includes('display-message')) return { stdout: 'zsh\n', stderr: '', exitCode: 0 };
      if (cmd.includes('list-panes')) return { stdout: '%0 zsh\n', stderr: '', exitCode: 0 };
      if (cmd.includes('show-option')) return { stdout: 'dev-1\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    expect(await manager.releaseAgentForTask('dev-1', 'task-r1', 'idle')).toBe(true);

    const state = await manager['agentStore'].get('dev-1');
    expect(state?.taskId).toBeUndefined();
    expect(await manager['lockManager'].isLocked('dev-1')).toBe(false);
  });

  it('cleanupRemovedAgentRuntime: destroys streamer BEFORE tmux kill', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: false });
    const callOrder: string[] = [];
    const destroyMock = vi.fn(async (id: string) => { callOrder.push(`destroy:${id}`); });
    mockCleanupExec(() => { callOrder.push('kill-session'); });

    const m2 = makeManager('2', makeStreamerMgr(destroyMock));
    await m2.cleanupRemovedAgentRuntime(['dev-1']);

    expect(destroyMock).toHaveBeenCalledWith('dev-1');
    const destroyIdx = callOrder.indexOf('destroy:dev-1');
    const killIdx = callOrder.indexOf('kill-session');
    expect(destroyIdx).toBeGreaterThanOrEqual(0);
    expect(killIdx).toBeGreaterThan(destroyIdx);
  });

  it('cleanupRemovedAgentRuntime: streamer destroy failure is logged but does NOT skip tmux kill', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: false });
    let killCalled = false;
    const destroyMock = vi.fn(async () => { throw new Error('streamer boom'); });
    mockCleanupExec(() => { killCalled = true; });

    const m2 = makeManager('3', makeStreamerMgr(destroyMock));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await m2.cleanupRemovedAgentRuntime(['dev-1']);
    } finally {
      warnSpy.mockRestore();
    }

    expect(destroyMock).toHaveBeenCalledWith('dev-1');
    expect(killCalled).toBe(true);
  });

  it('prepareRemoveTargets: dev includes paired qa; qa returns only itself', async () => {
    manager.replaceConfig(expandedConfig());
    expect(manager.prepareRemoveTargets('dev-1').targets).toEqual(['dev-1', 'qa-1']);
    expect(manager.prepareRemoveTargets('qa-1').targets).toEqual(['qa-1']);
  });

  it('previewPromptBytesForTaskInput: returns finite byte count without IO', () => {
    const bytes = manager.previewPromptBytesForTaskInput('proj', {
      title: 'hi',
      description: 'do work',
      preferredAgentId: 'dev-1',
    });
    expect(Number.isFinite(bytes)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
  });

  it('replaceConfig: rebuilds agentIndex so newly added agents are visible', async () => {
    expect(manager.getAgentConfig('qa-1')).toBeUndefined();
    manager.replaceConfig(expandedConfig());
    expect(manager.getAgentConfig('qa-1')).toBeDefined();
  });

  type RestartReplPrivates = {
    pollPaneCommandStable: (...a: unknown[]) => Promise<string>;
    ensureWorkdir: (...a: unknown[]) => Promise<{ workdir: string }>;
    provisionRepoSkills: (...a: unknown[]) => Promise<void>;
    tagSessionSkillsVersion: (...a: unknown[]) => Promise<void>;
  };
  function stubRestartRepl(): RestartReplPrivates {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    const m = manager as unknown as RestartReplPrivates;
    vi.spyOn(m, 'pollPaneCommandStable').mockResolvedValue('zsh');
    vi.spyOn(m, 'ensureWorkdir').mockResolvedValue({ workdir: '/tmp/repo' });
    return m;
  }

  it('restartReplOnly tags @baxian-skills-version after a successful re-provision', async () => {
    const m = stubRestartRepl();
    vi.spyOn(m, 'provisionRepoSkills').mockResolvedValue(undefined);
    const tagSpy = vi.spyOn(m, 'tagSessionSkillsVersion');

    await manager.restartReplOnly('dev-1');

    expect(tagSpy).toHaveBeenCalledTimes(1);
    expect(setOptionCalls('@baxian-skills-version').length).toBeGreaterThan(0);
  });

  it('restartReplOnly does NOT tag @baxian-skills-version when re-provision fails (keeps it stale for ensureSession self-heal)', async () => {
    const m = stubRestartRepl();
    vi.spyOn(m, 'provisionRepoSkills').mockRejectedValue(new Error('ssh write failed'));
    const tagSpy = vi.spyOn(m, 'tagSessionSkillsVersion');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.restartReplOnly('dev-1');

    expect(tagSpy).not.toHaveBeenCalled();
    expect(setOptionCalls('@baxian-skills-version')).toEqual([]);
    warnSpy.mockRestore();
  });

  function classifyOutput(proc: string, screen: string): string {
    return `${proc}\n___bx-classify-sep___\n${screen}`;
  }

  async function expectAdoptError(pattern: RegExp): Promise<EnsureSessionError> {
    try {
      await manager.ensureSession('dev-1', 'runtime');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnsureSessionError);
      expect((err as EnsureSessionError).message).toMatch(pattern);
      return err as EnsureSessionError;
    }
  }

  describe('adoptOrRestartSession probe failures & pane states', () => {
    beforeEach(() => {
      tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    });

    it('surfaces a @baxian-agent-id probe failure without adopting', async () => {
      overrideExec(
        c => c.includes('show-option') && c.includes('@baxian-agent-id'),
        { stderr: 'tmux option probe boom', exitCode: 2 },
      );
      const err = await expectAdoptError(/getOption\(@baxian-agent-id\) failed/);
      expect(err.partial.createdSession).toBe(false);
    });

    it('refuses a session with more than one pane (getSinglePaneId failure)', async () => {
      overrideExec(
        c => c.includes('list-panes'),
        { stdout: '%0 zsh\n%1 zsh\n' },
      );
      await expectAdoptError(/getSinglePaneId failed/);
    });

    it('surfaces a classifyPaneForAdopt probe failure', async () => {
      overrideExec(
        c => c.includes('display-message') && c.includes('capture-pane'),
        { stderr: 'probe boom', exitCode: 1 },
      );
      await expectAdoptError(/classifyPaneForAdopt failed/);
    });

    it('classifies a runtime stuck on a startup dialog as dialogPending', async () => {
      overrideExec(
        c => c.includes('display-message') && c.includes('capture-pane'),
        { stdout: classifyOutput('claude', '✨ Update available!\nPress enter to continue\n') },
      );
      const err = await expectAdoptError(/blocked on startup dialog/);
      expect(err.partial.dialogPending).toBe(true);
      expect(err.partial.lastScreen).toContain('Press enter to continue');
    });

    it('refuses to send launch keys into a foreign foreground process', async () => {
      overrideExec(
        c => c.includes('display-message') && c.includes('capture-pane'),
        { stdout: classifyOutput('vim', 'editing something\n') },
      );
      const err = await expectAdoptError(/pane foreground "vim" is neither runtime/);
      expect(err.partial.dialogPending).toBeFalsy();
    });

    const TRUST_SCREEN = 'Quick safety check\nDo you trust this folder?\n› Yes, I trust this folder\n';

    it('auto-answers a trust dialog and adopts the pane as a fresh runtime', async () => {
      let enterSent = false;
      runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message') && cmd.includes('capture-pane')) {
          return { stdout: classifyOutput('claude', TRUST_SCREEN), stderr: '', exitCode: 0 };
        }
        if (cmd.includes('send-keys') && cmd.includes("'Enter'")) {
          enterSent = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return {
            stdout: enterSent ? '⏵⏵ bypass permissions on\n' : TRUST_SCREEN,
            stderr: '', exitCode: 0,
          };
        }
        return makeMockExec({ trustDialogReady: true })(cmd);
      });

      const result = await manager.ensureSession('dev-1', 'runtime');

      expect(result.createdSession).toBe(false);
      expect(result.freshRuntime).toBe(true);
      expect(setOptionCalls('@baxian-skills-version').length).toBeGreaterThan(0);
    });

    it('reports dialogPending when a startup dialog appears after the trust auto-answer', async () => {
      let enterSent = false;
      runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message') && cmd.includes('capture-pane')) {
          return { stdout: classifyOutput('claude', TRUST_SCREEN), stderr: '', exitCode: 0 };
        }
        if (cmd.includes('send-keys') && cmd.includes("'Enter'")) {
          enterSent = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return {
            stdout: enterSent ? 'Press enter to continue\n' : TRUST_SCREEN,
            stderr: '', exitCode: 0,
          };
        }
        return makeMockExec({ trustDialogReady: true })(cmd);
      });

      const err = await expectAdoptError(/blocked on startup dialog after trust auto-answer/);
      expect(err.partial.dialogPending).toBe(true);
    });

    it('wraps a trust-dialog handling crash as EnsureSessionError', async () => {
      runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message') && cmd.includes('capture-pane')) {
          return { stdout: classifyOutput('claude', TRUST_SCREEN), stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: '', stderr: 'capture blew up', exitCode: 1 };
        }
        return makeMockExec({ trustDialogReady: true })(cmd);
      });

      await expectAdoptError(/trust dialog handling failed/);
    });

    it('shell relaunch blocked on a startup dialog reports dialogPending', async () => {
      runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message') && cmd.includes('capture-pane')) {
          return { stdout: classifyOutput('zsh', '$ \n'), stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: 'Press enter to continue\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('display-message')) {
          return { stdout: 'claude\n', stderr: '', exitCode: 0 };
        }
        return makeMockExec({ trustDialogReady: true })(cmd);
      });

      const err = await expectAdoptError(/relaunch blocked on startup dialog/);
      expect(err.partial.dialogPending).toBe(true);
    });

    it('shell relaunch that never becomes ready fails as REPL relaunch failed', async () => {
      runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message') && cmd.includes('capture-pane')) {
          return { stdout: classifyOutput('zsh', '$ \n'), stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: 'still booting...\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('display-message')) {
          return { stdout: 'claude\n', stderr: '', exitCode: 0 };
        }
        return makeMockExec({ trustDialogReady: true })(cmd);
      });

      const err = await expectAdoptError(/REPL relaunch failed/);
      expect(err.partial.dialogPending).toBeFalsy();
    });
  });

  describe('ensureSession pre-flight failures', () => {
    it('wraps an ensureWorkdir failure', async () => {
      vi.spyOn(
        manager as unknown as { ensureWorkdir: () => Promise<unknown> },
        'ensureWorkdir',
      ).mockRejectedValue(new Error('clone failed'));
      await expect(manager.ensureSession('dev-1', 'runtime'))
        .rejects.toThrow(/ensureWorkdir failed: clone failed/);
    });

    it('records the auto-managed repo path on the binding when a repoStore resolves the workdir', async () => {
      tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
      await manager['agentStore'].set({ id: 'dev-1', projectId: 'proj', updatedAt: new Date().toISOString() });
      vi.spyOn(
        manager as unknown as { ensureWorkdir: () => Promise<unknown> },
        'ensureWorkdir',
      ).mockResolvedValue({ workdir: '/tmp/auto-repo', repoStore: {} });

      await manager.ensureSession('dev-1', 'runtime');

      expect((await manager['agentStore'].get('dev-1'))?.repoPath).toBe('/tmp/auto-repo');
    });

    it('wraps a skill provisioning failure', async () => {
      runner.writeFile.mockRejectedValue(new Error('remote write refused'));
      await expect(manager.ensureSession('dev-1', 'runtime'))
        .rejects.toThrow(/skill provisioning failed/);
    });

    it('wraps a tmux has-session probe failure', async () => {
      overrideExec(
        c => c.includes('has-session'),
        { stderr: 'tmux socket weirdness', exitCode: 2 },
      );
      await expect(manager.ensureSession('dev-1', 'runtime'))
        .rejects.toThrow(/tmux probe failed/);
    });
  });

  describe('restartReplOnly preconditions & relaunch', () => {
    it('throws when the tmux session does not exist', async () => {
      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/does not exist/);
    });

    it('refuses a foreign session claim', async () => {
      tmuxSessions.set('dev-1', { claim: 'someone-else', readyOnce: true });
      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/claim mismatch/);
    });

    it('exits a live runtime before relaunching and refreshes the binding paneId', async () => {
      tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
      await manager['agentStore'].set({ id: 'dev-1', projectId: 'proj', updatedAt: new Date().toISOString() });
      let exited = false;
      runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys')) {
          if (cmd.includes("'exit'")) exited = true;
          if (cmd.includes('permission-mode')) exited = false;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('display-message') && !cmd.includes('capture-pane')) {
          return { stdout: exited ? 'zsh\n' : 'claude\n', stderr: '', exitCode: 0 };
        }
        return makeMockExec({ trustDialogReady: true })(cmd);
      });

      await manager.restartReplOnly('dev-1');

      expect(execCmds().some(c => c.includes('send-keys') && c.includes("'exit'"))).toBe(true);
      expect(execCmds().some(c => c.includes('permission-mode'))).toBe(true);
      expect((await manager['agentStore'].get('dev-1'))?.paneId).toBe('%0');
    });

    it('throws on an unexpected foreground process instead of relaunching over it', async () => {
      tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
      overrideExec(
        c => c.includes('display-message') && !c.includes('capture-pane'),
        { stdout: 'vim\n' },
      );
      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/unexpected pane state "vim"/);
    });

    it('relaunches without the skill-dir lock when the workdir cannot be resolved', async () => {
      tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
      const m = manager as unknown as {
        pollPaneCommandStable: (...a: unknown[]) => Promise<string>;
        ensureWorkdir: (...a: unknown[]) => Promise<unknown>;
      };
      vi.spyOn(m, 'pollPaneCommandStable').mockResolvedValue('zsh');
      vi.spyOn(m, 'ensureWorkdir').mockRejectedValue(new Error('repo store down'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await manager.restartReplOnly('dev-1');

      expect(execCmds().some(c => c.includes('permission-mode'))).toBe(true);
      expect(setOptionCalls('@baxian-skills-version')).toEqual([]);
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('skill re-provision failed'))).toBe(true);
      warnSpy.mockRestore();
    });
  });

  describe('cleanupRemovedAgentRuntime failure aggregation', () => {
    it('skips the kill (warn only) when the session claim belongs to someone else', async () => {
      tmuxSessions.set('dev-1', { claim: 'foreign-owner', readyOnce: true });
      let killed = false;
      mockCleanupExec(() => { killed = true; });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await manager.cleanupRemovedAgentRuntime(['dev-1']);

      expect(killed).toBe(false);
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('not baxian-managed'))).toBe(true);
      warnSpy.mockRestore();
    });

    it('aggregates a tmux probe failure into CleanupFailedError', async () => {
      overrideExec(
        c => c.includes('has-session'),
        { stderr: 'socket exploded', exitCode: 2 },
      );
      try {
        await manager.cleanupRemovedAgentRuntime(['dev-1']);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CleanupFailedError);
        expect((err as CleanupFailedError).failures).toEqual([
          expect.objectContaining({ agentId: 'dev-1', step: 'tmux' }),
        ]);
      }
    });

    it('aggregates a worktree removal failure into CleanupFailedError', async () => {
      await manager['agentStore'].set({
        id: 'dev-1', projectId: 'proj',
        worktreePath: '/tmp/repo/.baxian-worktrees/wt',
        updatedAt: new Date().toISOString(),
      });
      vi.spyOn(WorktreeManager.prototype, 'remove').mockRejectedValue(new Error('worktree locked'));

      try {
        await manager.cleanupRemovedAgentRuntime(['dev-1']);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CleanupFailedError);
        expect((err as CleanupFailedError).failures).toEqual([
          expect.objectContaining({ agentId: 'dev-1', step: 'worktree.remove' }),
        ]);
        expect((err as CleanupFailedError).message).toContain('worktree locked');
      }
    });
  });
});
