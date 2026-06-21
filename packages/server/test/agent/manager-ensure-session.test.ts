import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaxianConfig } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';
import {
  AgentManager,
  EnsureSessionError,
} from '../../src/agent/manager.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
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

  function makeMockExec(
    overrides: { trustDialogReady?: boolean } = {},
  ): (cmd: string) => Promise<ExecResult> {
    return async (cmd: string): Promise<ExecResult> => {
      // tmux has-session
      if (cmd.includes('has-session')) {
        const m = cmd.match(/'=([^']+)'/);
        const name = m?.[1] ?? '';
        return tmuxSessions.has(name)
          ? { stdout: '', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: `can't find session: ${name}`, exitCode: 1 };
      }
      // tmux new-session
      if (cmd.includes('new-session')) {
        const m = cmd.match(/-s '([^']+)'/);
        const name = m?.[1] ?? '';
        tmuxSessions.set(name, { claim: name, readyOnce: false });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      // tmux set-option @baxian-...
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
      // tmux show-option -v <key> → bare value
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
      // tmux list-panes (paneId resolution)
      if (cmd.includes('list-panes')) {
        return { stdout: '%0 zsh\n', stderr: '', exitCode: 0 };
      }
      // tmux send-keys (launch + dialog Enter)
      if (cmd.includes('send-keys')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      // Must match BEFORE the per-cmd handlers below.
      if (cmd.includes('display-message') && cmd.includes('capture-pane')) {
        return {
          stdout: 'claude\n___bx-classify-sep___\n⏵⏵ bypass permissions on\n',
          stderr: '', exitCode: 0,
        };
      }
      // tmux capture-pane (waitReplReady + handleTrustDialog)
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
      // tmux display-message (pane_current_command for waitReplReady)
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
    // Seed every skill declared by AGENT_PHASES so previewPromptBytesForTaskInput
    // and any startSession-path test using dev.develop passes fail-fast validation.
    for (const name of ['baxian-rules', 'baxian-task-check', 'baxian-pr-feedback', 'baxian-pr-review', 'baxian-pr-recheck']) {
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
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> =>
      // classifyPaneForAdopt sees a shell foreground → relaunch path (not live-runtime).
      cmd.includes('display-message') && cmd.includes('capture-pane')
        ? { stdout: 'zsh\n___bx-classify-sep___\n', stderr: '', exitCode: 0 }
        : makeMockExec({ trustDialogReady: true })(cmd));
    await manager.ensureSession('dev-1', 'runtime');
    const calls = runner.exec.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('set-option') && c.includes('@baxian-skills-version'))).toBe(true);
  });

  it('runtime mode, live REPL with a stale skills version → kills + rebuilds so /baxian-* resolves', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    // The live REPL reports an OLD skills version (it launched before the current skills),
    // so it cannot resolve a dispatched /baxian-* — adopt must rebuild instead of reusing.
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> =>
      cmd.includes('show-option') && cmd.includes('@baxian-skills-version')
        ? { stdout: 'stale-version\n', stderr: '', exitCode: 0 }
        : makeMockExec({ trustDialogReady: true })(cmd));
    const result = await manager.ensureSession('dev-1', 'runtime');
    expect(result.createdSession).toBe(true);
    const calls = runner.exec.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('kill-session'))).toBe(true);
    expect(calls.some(c => c.includes('new-session'))).toBe(true);
  });

  it('runtime mode, a tmux probe failure during the skills-version check surfaces as EnsureSessionError (does NOT kill the live REPL)', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> =>
      // Unexpected exit (not 0/1) → getOption throws a real probe error (not a missing tag).
      cmd.includes('show-option') && cmd.includes('@baxian-skills-version')
        ? { stdout: '', stderr: 'tmux probe boom', exitCode: 2 }
        : makeMockExec({ trustDialogReady: true })(cmd));
    await expect(manager.ensureSession('dev-1', 'runtime')).rejects.toThrow(/skills-version probe failed/);
    const calls = runner.exec.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('kill-session'))).toBe(false);
  });

  it('create path pins window-size=latest so plain tmux attach follows the current terminal size', async () => {
    await manager.ensureSession('dev-1', 'create');
    const calls = runner.exec.mock.calls.map(c => c[0] as string);
    const windowSizeCalls = calls.filter(
      c => c.includes('set-option') && c.includes('window-size') && c.includes('latest'),
    );
    expect(windowSizeCalls).toHaveLength(1);
    expect(windowSizeCalls[0]).toContain("'=dev-1:'");
  });

  it('adopt path preserves the existing window-size owner', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    await manager.ensureSession('dev-1', 'runtime');
    const calls = runner.exec.mock.calls.map(c => c[0] as string);
    const windowSizeCalls = calls.filter(
      c => c.includes('set-option') && c.includes('window-size'),
    );
    expect(windowSizeCalls).toHaveLength(0);
  });

  it('create path locks prefix=C-b + prefix2=None (so WS sanitizer strip 0x02 stays sufficient)', async () => {
    await manager.ensureSession('dev-1', 'create');
    const calls = runner.exec.mock.calls.map(c => c[0] as string);
    const prefixCB = calls.filter(
      c => c.includes('set-option') && c.includes("'prefix'") && c.includes("'C-b'"),
    );
    const prefix2None = calls.filter(
      c => c.includes('set-option') && c.includes("'prefix2'") && c.includes("'None'"),
    );
    expect(prefixCB).toHaveLength(1);
    expect(prefix2None).toHaveLength(1);
  });

  it('adopt path also re-locks prefix=C-b + prefix2=None (defends against ~/.tmux.conf drift)', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    await manager.ensureSession('dev-1', 'runtime');
    const calls = runner.exec.mock.calls.map(c => c[0] as string);
    const prefixCB = calls.filter(
      c => c.includes('set-option') && c.includes("'prefix'") && c.includes("'C-b'"),
    );
    const prefix2None = calls.filter(
      c => c.includes('set-option') && c.includes("'prefix2'") && c.includes("'None'"),
    );
    expect(prefixCB).toHaveLength(1);
    expect(prefix2None).toHaveLength(1);
  });

  it('create path pins mouse=on so ssh attach gets wheel-scroll / selection / pane click', async () => {
    await manager.ensureSession('dev-1', 'create');
    const calls = runner.exec.mock.calls.map(c => c[0] as string);
    const mouseOn = calls.filter(
      c => c.includes('set-option') && c.includes("'mouse'") && c.includes("'on'"),
    );
    expect(mouseOn).toHaveLength(1);
    expect(mouseOn[0]).toContain("'=dev-1:'");
    const mouseOff = calls.filter(
      c => c.includes('set-option') && c.includes("'mouse'") && c.includes("'off'"),
    );
    expect(mouseOff).toHaveLength(0);
  });

  it('adopt path re-pins mouse=on (retrofits sessions created when mouse=off was the default)', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    await manager.ensureSession('dev-1', 'runtime');
    const calls = runner.exec.mock.calls.map(c => c[0] as string);
    const mouseOn = calls.filter(
      c => c.includes('set-option') && c.includes("'mouse'") && c.includes("'on'"),
    );
    expect(mouseOn).toHaveLength(1);
    expect(mouseOn[0]).toContain("'=dev-1:'");
  });

  it('adopt path: runtime option failure surfaces as EnsureSessionError (preserves partial contract)', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('set-option') && cmd.includes("'prefix'") && cmd.includes("'C-b'")) {
        return { stdout: '', stderr: 'tmux command failed: bad option', exitCode: 1 };
      }
      return makeMockExec({ trustDialogReady: true })(cmd);
    });
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

  it('waitReplReady captures last screen + dialog signal triggers dialogPending=true', async () => {
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('new-session')) {
        const m = cmd.match(/-s '([^']+)'/);
        const name = m?.[1] ?? '';
        tmuxSessions.set(name, { claim: name, readyOnce: false });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('list-panes')) {
        return { stdout: '%0 zsh\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        return {
          stdout:
            '✨ Update available! 0.128.0 -> 0.129.0\n' +
            '› 1. Update now  2. Skip  3. Skip until next version\n' +
            'Press enter to continue\n',
          stderr: '', exitCode: 0,
        };
      }
      if (cmd.includes('display-message')) {
        return { stdout: 'node\n', stderr: '', exitCode: 0 };
      }
      return makeMockExec()(cmd);
    });
    try {
      await manager.ensureSession('dev-1', 'create');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnsureSessionError);
      const e = err as EnsureSessionError;
      expect(e.partial.createdSession).toBe(true);
      expect(e.partial.dialogPending).toBe(true);
      expect(e.partial.lastScreen).toContain('Press enter to continue');
      expect(e.message).toContain('Last pane snapshot');
    }
  });

  it('waitReplReady timeout WITHOUT dialog signal → dialogPending stays false', async () => {
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('new-session')) {
        const m = cmd.match(/-s '([^']+)'/);
        const name = m?.[1] ?? '';
        tmuxSessions.set(name, { claim: name, readyOnce: false });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('list-panes')) {
        return { stdout: '%0 zsh\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        return {
          stdout: 'still booting...\nno anchor here\n',
          stderr: '', exitCode: 0,
        };
      }
      if (cmd.includes('display-message')) {
        return { stdout: 'node\n', stderr: '', exitCode: 0 };
      }
      return makeMockExec()(cmd);
    });
    try {
      await manager.ensureSession('dev-1', 'create');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnsureSessionError);
      const e = err as EnsureSessionError;
      expect(e.partial.createdSession).toBe(true);
      expect(e.partial.dialogPending).toBeFalsy();
      expect(e.partial.lastScreen).toContain('still booting');
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

  it('acquireAgentForTask reuses an existing lock when phase=fix and same task', async () => {
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(true);
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'fix')).toBe(true);
  });

  it('acquireAgentForTask reuses post-approve lock for the same bound task', async () => {
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(true);
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'post-approve')).toBe(true);
  });

  it('releaseAgentForTask returns false on stale taskId (do not touch new assignment)', async () => {
    await manager.acquireAgentForTask('dev-1', 'task-1', 'develop');
    expect(await manager.releaseAgentForTask('dev-1', 'task-OTHER', 'idle')).toBe(false);
    const state = await manager['agentStore'].get('dev-1');
    expect(state?.taskId).toBe('task-1');
  });

  it('releaseAgentForTask mode=waiting keeps the binding without releasing lock', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    await manager['taskStore'].set({
      id: 'task-1',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      branch: 'bx/task-1',
      reviewRound: 0,
      status: 'in_progress',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await manager.acquireAgentForTask('dev-1', 'task-1', 'develop');
    const ensure = await manager.ensureSession('dev-1', 'runtime');
    await manager['agentStore'].set({
      ...(await manager['agentStore'].get('dev-1'))!,
      paneId: ensure.paneId,
    });
    expect(await manager.releaseAgentForTask('dev-1', 'task-1', 'waiting')).toBe(true);
    const state = await manager['agentStore'].get('dev-1');
    expect(state?.taskId).toBe('task-1');
    expect(await manager['lockManager'].isLocked('dev-1')).toBe(true);
  });

  it('release on a non-ready pane (mode=idle): clears binding and lock regardless of REPL state', async () => {
    // release 已解耦 REPL gate — pane 不 ready 也必须能落地状态清理。
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true });
    await manager['taskStore'].set({
      id: 'task-r1',
      projectId: 'proj',
      title: 'T',
      description: 'D',
      preferredAgentId: 'dev-1',
      agentId: 'dev-1',
      branch: 'bx/task-r1',
      reviewRound: 0,
      status: 'in_progress',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await manager.acquireAgentForTask('dev-1', 'task-r1', 'develop');
    await manager['agentStore'].set({
      ...(await manager['agentStore'].get('dev-1'))!,
      paneId: '%0',
    });
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

    const destroyMock = vi.fn(async (id: string) => {
      callOrder.push(`destroy:${id}`);
    });
    const fakeStreamerMgr = {
      destroy: destroyMock,
      ensure: vi.fn(),
      has: vi.fn(),
      enqueueInput: vi.fn(),
    };

    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('kill-session')) {
        callOrder.push('kill-session');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('has-session')) {
        const m = cmd.match(/'=([^']+)'/);
        const name = m?.[1] ?? '';
        return tmuxSessions.has(name)
          ? { stdout: '', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: `can't find session: ${name}`, exitCode: 1 };
      }
      if (cmd.includes('show-option')) {
        const m = cmd.match(/'=([^']+):'/);
        const name = m?.[1] ?? '';
        const sess = tmuxSessions.get(name);
        if (!sess) return { stdout: '', stderr: '', exitCode: 1 };
        return { stdout: `${sess.claim}\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const agentStore = new AgentStore(join(tempDir, 'state', 'agents-2'));
    const taskStore = new TaskStore(join(tempDir, 'state', 'tasks-2'));
    const lockManager = new LockManager(join(tempDir, 'locks-2'));
    const eventBus = new EventBus(new EventLog(join(tempDir, 'events-2')));
    const skillRegistry = new SkillRegistry(join(tempDir, 'skills-2'));
    const m2 = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry,
      runnerFactory: () => runner as unknown as CommandRunner,
      paneStreamerManager: fakeStreamerMgr as never,
    });

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

    const destroyMock = vi.fn(async () => {
      throw new Error('streamer boom');
    });
    const fakeStreamerMgr = {
      destroy: destroyMock,
      ensure: vi.fn(),
      has: vi.fn(),
      enqueueInput: vi.fn(),
    };

    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('kill-session')) {
        killCalled = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('has-session')) {
        const m = cmd.match(/'=([^']+)'/);
        const name = m?.[1] ?? '';
        return tmuxSessions.has(name)
          ? { stdout: '', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: `can't find session: ${name}`, exitCode: 1 };
      }
      if (cmd.includes('show-option')) {
        const m = cmd.match(/'=([^']+):'/);
        const name = m?.[1] ?? '';
        const sess = tmuxSessions.get(name);
        if (!sess) return { stdout: '', stderr: '', exitCode: 1 };
        return { stdout: `${sess.claim}\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const agentStore = new AgentStore(join(tempDir, 'state', 'agents-3'));
    const taskStore = new TaskStore(join(tempDir, 'state', 'tasks-3'));
    const lockManager = new LockManager(join(tempDir, 'locks-3'));
    const eventBus = new EventBus(new EventLog(join(tempDir, 'events-3')));
    const skillRegistry = new SkillRegistry(join(tempDir, 'skills-3'));
    const m2 = new AgentManager({
      config: CONFIG,
      agentStore,
      taskStore,
      lockManager,
      eventBus,
      skillRegistry,
      runnerFactory: () => runner as unknown as CommandRunner,
      paneStreamerManager: fakeStreamerMgr as never,
    });

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
    const expanded: BaxianConfig = {
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
    manager.replaceConfig(expanded);
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
    const expanded: BaxianConfig = {
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
    expect(manager.getAgentConfig('qa-1')).toBeUndefined();
    manager.replaceConfig(expanded);
    expect(manager.getAgentConfig('qa-1')).toBeDefined();
  });
});
