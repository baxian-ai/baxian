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
import { RepoStore } from '../../src/agent/repo-store.js';
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
  let runner: { exec: ReturnType<typeof vi.fn>; writeFile: ReturnType<typeof vi.fn>; execWithStdin: ReturnType<typeof vi.fn> };

  let tmuxSessions: Map<string, { claim: string; readyOnce: boolean; sessionId: string }>;
  let nextSessionId: number;
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
      tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true, sessionId: `$${nextSessionId++}` });
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
      if (cmd.includes('if-shell')) {
        onKill();
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('list-sessions')) {
        const name = cmd.match(/#\{==:#\{session_name\},([^}]+)\}/)?.[1] ?? '';
        const sess = tmuxSessions.get(name);
        return sess
          ? { stdout: `9999|1700000000|${sess.sessionId}|${sess.claim}\n`, stderr: '', exitCode: 0 }
          : { stdout: '', stderr: '', exitCode: 0 };
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
      repoStoreFactory: () => ({ ensure: async () => '/tmp/repo' }) as never,
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
            { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/qa-repo', yolo: true },
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
      devAgentId: 'dev-1',
      phase: 'code',
      branch: `bx/${id}`,
      reviewMode: 'server',
      reviewRound: 0,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    });
  }

  function makeMockExec(
    _overrides: { trustDialogReady?: boolean } = {},
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
        const sessionId = `$${nextSessionId++}`;
        tmuxSessions.set(name, { claim: '', readyOnce: false, sessionId });
        return { stdout: `9999|1700000000|${sessionId}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('list-sessions')) {
        const name = cmd.match(/#\{==:#\{session_name\},([^}]+)\}/)?.[1] ?? '';
        const sess = tmuxSessions.get(name);
        return sess
          ? { stdout: `9999|1700000000|${sess.sessionId}|${sess.claim}\n`, stderr: '', exitCode: 0 }
          : { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('if-shell')) {
        const sid = cmd.match(/\$\d+/)?.[0];
        const entry = [...tmuxSessions.entries()].find(([, sess]) => sess.sessionId === sid);
        if (cmd.includes('BX_KILL_REFUSED')) {
          if (!entry) return { stdout: '', stderr: `can't find session: ${sid}`, exitCode: 1 };
          const allowEmpty = cmd.includes('#{==:#{@baxian-agent-id},}');
          const required = cmd.match(/#\{==:#\{@baxian-agent-id\},([^},]+)\}/)?.[1];
          const claimOk = (allowEmpty && entry[1].claim === '')
            || (required !== undefined && entry[1].claim === required);
          if (!claimOk) return { stdout: 'BX_KILL_REFUSED\n', stderr: '', exitCode: 0 };
          tmuxSessions.delete(entry[0]);
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (!entry) return { stdout: 'BX_TARGET_GONE\n', stderr: '', exitCode: 0 };
        const claimM = cmd.match(/@baxian-agent-id '\\''([^']+)'/);
        if (claimM) {
          entry[1].claim = claimM[1];
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        // guarded pane/session ops fall through to the content handlers below
      }
      if (cmd.includes('show-environment')) {
        return { stdout: '', stderr: 'unknown variable: BAXIAN_CREATION_NONCE', exitCode: 1 };
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
        if (cmd.includes('-a -F')) {
          const sid = cmd.match(/session_id\},(\$\d+)\}/)?.[1];
          const exists = [...tmuxSessions.values()].some(sess => sess.sessionId === sid);
          return exists
            ? { stdout: '%0 zsh\n', stderr: '', exitCode: 0 }
            : { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '%0 zsh\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('send-keys')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('pane_current_command') && cmd.includes('capture-pane')) {
        return {
          stdout: 'BX_PANE_OKclaude\n⏵⏵ bypass permissions on\n',
          stderr: '', exitCode: 0,
        };
      }
      if (cmd.includes('display-message') && cmd.includes('pane_current_path')) {
        return { stdout: 'BX_PANE_OK/tmp/repo\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('BX_PANE_OK#{@baxian-skills-version}')) {
        return { stdout: `BX_PANE_OK${currentSkillsVersion}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        const header = cmd.includes('history_size') ? 'BX_PANE_OK|0' : 'BX_PANE_OK';
        return {
          stdout: `${header}\n⏵⏵ bypass permissions on\n`,
          stderr: '', exitCode: 0,
        };
      }
      if (cmd.includes('display-message')) {
        return { stdout: 'BX_PANE_OKclaude\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('BX_SKILLS_NON_GIT')) {
        return { stdout: 'BX_SKILLS_OK\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'baxian-ensure-session-'));
    await initStateDir(tempDir);
    tmuxSessions = new Map<string, { claim: string; readyOnce: boolean; sessionId: string }>();
    nextSessionId = 1;

    runner = {
      exec: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      execWithStdin: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    };
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
      repoStoreFactory: () => ({ ensure: async () => '/tmp/repo' }) as never,
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
    tmuxSessions.set('dev-1', { claim: 'someone-else', readyOnce: true, sessionId: `$${nextSessionId++}` });
    await expect(manager.ensureSession('dev-1', 'create'))
      .rejects.toThrow(/already exists/);
    try {
      await manager.ensureSession('dev-1', 'create');
    } catch (err) {
      expect(err).toBeInstanceOf(EnsureSessionError);
      expect((err as EnsureSessionError).partial.createdSession).toBe(false);
    }
  });

  it('create mode reclaims a half-created leftover (nonce present, claim never written) and boots fresh', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const leftoverId = `$${nextSessionId++}`;
    tmuxSessions.set('dev-1', { claim: '', readyOnce: true, sessionId: leftoverId });
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('show-environment')) {
        return tmuxSessions.get('dev-1')?.sessionId === leftoverId
          ? { stdout: 'BAXIAN_CREATION_NONCE=stranded-nonce\n', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: 'unknown variable: BAXIAN_CREATION_NONCE', exitCode: 1 };
      }
      return makeMockExec({ trustDialogReady: true })(cmd);
    });

    const result = await manager.ensureSession('dev-1', 'create');

    expect(result.createdSession).toBe(true);
    expect(tmuxSessions.get('dev-1')?.sessionId).not.toBe(leftoverId);
    expect(warn.mock.calls.some(c => String(c[0]).includes('half-created leftover'))).toBe(true);
  });

  it('create mode leaves a claimless session without the nonce to the operator', async () => {
    tmuxSessions.set('dev-1', { claim: '', readyOnce: true, sessionId: `$${nextSessionId++}` });
    await expect(manager.ensureSession('dev-1', 'create')).rejects.toThrow(/already exists/);
    expect(tmuxSessions.has('dev-1')).toBe(true);
  });

  it('a same-name replacement between create and configuration never receives the claim', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let replacementId: string | undefined;
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('new-session')) {
        const result = await makeMockExec({ trustDialogReady: true })(cmd);
        // The freshly created session dies and an outsider recreates the name
        // before the first option write — the classic rebind window.
        replacementId = `$${nextSessionId++}`;
        tmuxSessions.set('dev-1', { claim: '', readyOnce: true, sessionId: replacementId });
        return result;
      }
      return makeMockExec({ trustDialogReady: true })(cmd);
    });

    await expect(manager.ensureSession('dev-1', 'create')).rejects.toThrow(/vanished before its options/);

    const survivor = tmuxSessions.get('dev-1');
    expect(survivor?.sessionId).toBe(replacementId);
    expect(survivor?.claim).toBe('');
  });

  it('reclaim logs already-gone instead of a fabricated kill when the session vanished', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const leftoverId = `$${nextSessionId++}`;
    tmuxSessions.set('dev-1', { claim: '', readyOnce: true, sessionId: leftoverId });
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('show-environment')) {
        return { stdout: 'BAXIAN_CREATION_NONCE=stranded\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('if-shell') && cmd.includes('BX_KILL_REFUSED')) {
        tmuxSessions.delete('dev-1');
        return { stdout: '', stderr: `can't find session: ${leftoverId}`, exitCode: 1 };
      }
      return makeMockExec({ trustDialogReady: true })(cmd);
    });

    const result = await manager.ensureSession('dev-1', 'create');

    expect(result.createdSession).toBe(true);
    expect(warn.mock.calls.some(c => String(c[0]).includes('already gone'))).toBe(true);
    expect(warn.mock.calls.some(c => String(c[0]).includes('killed half-created'))).toBe(false);
  });

  it('reclaim stands down when a claim lands between the probes and the kill', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const leftoverId = `$${nextSessionId++}`;
    tmuxSessions.set('dev-1', { claim: '', readyOnce: true, sessionId: leftoverId });
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('show-environment')) {
        // The nonce probe is the last read before the kill: a concurrent
        // bootstrap claims the session right after it, inside the race window.
        const sess = tmuxSessions.get('dev-1');
        if (sess) sess.claim = 'dev-1';
        return { stdout: 'BAXIAN_CREATION_NONCE=stranded-nonce\n', stderr: '', exitCode: 0 };
      }
      return makeMockExec({ trustDialogReady: true })(cmd);
    });

    await expect(manager.ensureSession('dev-1', 'create'))
      .rejects.toThrow(/claimed .*while reclaiming|retry to observe/);

    expect(tmuxSessions.get('dev-1')?.sessionId).toBe(leftoverId);
    expect(tmuxSessions.get('dev-1')?.claim).toBe('dev-1');
  });

  it('new-session ok but post-create setOption fails → partial.createdSession=true so caller can rollback orphan', async () => {
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('new-session')) {
        const m = cmd.match(/-s '([^']+)'/);
        const name = m?.[1] ?? '';
        const sessionId = `$${nextSessionId++}`;
        tmuxSessions.set(name, { claim: name, readyOnce: false, sessionId });
        return { stdout: `9999|1700000000|${sessionId}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('set-option') && !cmd.includes('-s ')) {
        return { stdout: '', stderr: 'tmux command failed: bad option', exitCode: 1 };
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
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true, sessionId: `$${nextSessionId++}` });
    const result = await manager.ensureSession('dev-1', 'runtime');
    expect(result.createdSession).toBe(false);
    expect(result.paneId).toBe('%0');
  });

  it('runtime mode, shell relaunch path tags the session with the skills version (so the next adopt is not seen stale)', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true, sessionId: `$${nextSessionId++}` });
    overrideExec(
      c => c.includes('pane_current_command') && c.includes('capture-pane'),
      { stdout: 'BX_PANE_OKzsh\n' },
    );
    await manager.ensureSession('dev-1', 'runtime');
    expect(setOptionCalls('@baxian-skills-version').length).toBeGreaterThan(0);
  });

  it('runtime mode, live REPL with stale skills defers retagging until task-boundary /clear succeeds', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true, sessionId: `$${nextSessionId++}` });
    overrideExec(
      c => c.includes('BX_PANE_OK#{@baxian-skills-version}'),
      { stdout: 'BX_PANE_OKstale-version\n' },
    );
    const result = await manager.ensureSession('dev-1', 'runtime');
    expect(result.createdSession).toBe(false);
    expect(result.skillsStale).toBe(true);
    const calls = execCmds();
    expect(calls.some(c => c.includes('kill-session'))).toBe(false);
    expect(calls.some(c => c.includes('new-session'))).toBe(false);
    expect(setOptionCalls('@baxian-skills-version')).toHaveLength(0);
  });

  it('runtime mode, a tmux probe failure during the skills-version check surfaces as EnsureSessionError (does NOT kill the live REPL)', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true, sessionId: `$${nextSessionId++}` });
    overrideExec(
      c => c.includes('BX_PANE_OK#{@baxian-skills-version}'),
      { stderr: 'tmux probe boom', exitCode: 2 },
    );
    await expect(manager.ensureSession('dev-1', 'runtime')).rejects.toThrow(/skills-version probe failed/);
    expect(execCmds().some(c => c.includes('kill-session'))).toBe(false);
  });

  it('create path pins window-size=latest so plain tmux attach follows the current terminal size', async () => {
    await runEnsure('create');
    const windowSizeCalls = setOptionCalls('window-size', 'latest');
    expect(windowSizeCalls).toHaveLength(1);
    expect(windowSizeCalls[0]).toMatch(/set-option -t '\\''\$\d+'\\'' window-size/);
  });

  it('adopt path preserves the existing window-size owner', async () => {
    await runEnsure('adopt');
    expect(setOptionCalls('window-size')).toHaveLength(0);
  });

  it.each(['create', 'adopt'] as const)('%s path locks prefix=C-b + prefix2=None', async (path) => {
    await runEnsure(path);
    expect(setOptionCalls('prefix ', "C-b")).toHaveLength(1);
    expect(setOptionCalls('prefix2 ', "None")).toHaveLength(1);
  });

  it.each(['create', 'adopt'] as const)('%s path pins mouse=on', async (path) => {
    await runEnsure(path);
    const mouseOn = setOptionCalls('mouse ');
    expect(mouseOn).toHaveLength(1);
    expect(mouseOn[0]).toMatch(/mouse '\\''on'\\''/);
    expect(mouseOn[0]).toMatch(/-t '\\''\$\d+'\\''/);
  });

  it('adopt path: runtime option failure surfaces as EnsureSessionError (preserves partial contract)', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true, sessionId: `$${nextSessionId++}` });
    overrideExec(
      c => c.includes('set-option') && c.includes('prefix ') && c.includes('C-b'),
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
      expect(e.message).toContain('pinning runtime session options failed');
    }
  });

  it('runtime mode, claim mismatch → throws (createdSession=false)', async () => {
    tmuxSessions.set('dev-1', { claim: 'someone-else', readyOnce: true, sessionId: `$${nextSessionId++}` });
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
        const sessionId = `$${nextSessionId++}`;
        tmuxSessions.set(name, { claim: name, readyOnce: false, sessionId });
        return { stdout: `9999|1700000000|${sessionId}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('list-panes')) return { stdout: '%0 zsh\n', stderr: '', exitCode: 0 };
      if (cmd.includes('capture-pane')) return { stdout: `BX_PANE_OK\n${screen}`, stderr: '', exitCode: 0 };
      if (cmd.includes('display-message')) return { stdout: 'BX_PANE_OKnode\n', stderr: '', exitCode: 0 };
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

  it('acquireAgentForTask refuses while a deletion tombstone is in flight', async () => {
    expect(manager.tryClaimDeletion(['dev-1'])).toBeNull();
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(false);
    expect(await manager['agentStore'].get('dev-1')).toBeNull();
    manager.releaseDeletionClaim(['dev-1']);
  });

  it('acquireAgentForTask is ABA-safe: a bumped deletion generation NOOPs a suspended commit', async () => {
    // Simulate an allocation that captured its generation, then a full DELETE (bump) landing before
    // the store commit runs: the updater must refuse to write the stale incarnation's binding.
    const realGenOf = manager.deletionGenerationOf.bind(manager);
    let firstCall = true;
    const spy = vi.spyOn(manager, 'deletionGenerationOf').mockImplementation((id: string) => {
      // entry capture sees 0; the in-updater re-check sees the post-DELETE bump (1).
      if (firstCall) { firstCall = false; return 0; }
      return id === 'dev-1' ? 1 : realGenOf(id);
    });
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(false);
    expect(await manager['agentStore'].get('dev-1')).toBeNull();
    // the lock the allocation grabbed must have been released, not leaked
    expect(await manager['lockManager'].claimOf('dev-1')).toBeNull();
    spy.mockRestore();
  });

  it('acquireAgentForTask still lazily initializes a config-only agent with no prior state', async () => {
    expect(await manager['agentStore'].get('dev-1')).toBeNull();
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(true);
    expect((await manager['agentStore'].get('dev-1'))?.taskId).toBe('task-1');
  });

  it('releaseAgentForTask returns false on stale taskId (do not touch new assignment)', async () => {
    await manager.acquireAgentForTask('dev-1', 'task-1', 'develop');
    expect(await manager.releaseAgentForTask('dev-1', 'task-OTHER', 'idle')).toBe(false);
    const state = await manager['agentStore'].get('dev-1');
    expect(state?.taskId).toBe('task-1');
  });

  it('releaseAgentForTask mode=waiting keeps the binding without releasing lock', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true, sessionId: `$${nextSessionId++}` });
    await seedRunningTask('task-1');
    await manager.acquireAgentForTask('dev-1', 'task-1', 'develop');
    const ensure = await manager.ensureSession('dev-1', 'runtime');
    await setPaneId('dev-1', ensure.paneId);
    expect(await manager.releaseAgentForTask('dev-1', 'task-1', 'waiting')).toBe(true);
    const state = await manager['agentStore'].get('dev-1');
    expect(state?.taskId).toBe('task-1');
    expect(await manager['lockManager'].isLocked('dev-1')).toBe(true);
  });

  it('release on a non-ready pane (mode=idle): keeps the binding and lock without touching checkout', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true, sessionId: `$${nextSessionId++}` });
    await seedRunningTask('task-r1');
    await manager.acquireAgentForTask('dev-1', 'task-r1', 'develop');
    await setPaneId('dev-1', '%0');
    await manager['agentStore'].update('dev-1', state => ({ ...state!, workdir: '/tmp/repo' }));
    manager['cleanComposerWaitMs'] = 10;
    manager['compactIdlePollMs'] = 1;
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('capture-pane')) return { stdout: '$ \n', stderr: '', exitCode: 0 };
      if (cmd.includes('display-message')) return { stdout: 'zsh\n', stderr: '', exitCode: 0 };
      if (cmd.includes('list-panes')) return { stdout: '%0 zsh\n', stderr: '', exitCode: 0 };
      if (cmd.includes('show-option')) return { stdout: 'dev-1\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    expect(await manager.releaseAgentForTask('dev-1', 'task-r1', 'idle')).toBe(false);

    const state = await manager['agentStore'].get('dev-1');
    expect(state?.taskId).toBe('task-r1');
    expect(state).toMatchObject({ status: 'awaiting_human', awaitingPhase: 'branch-cleanup-pending' });
    expect(await manager['lockManager'].isLocked('dev-1')).toBe(true);
    expect(execCmds().some(cmd => cmd.includes('git switch') || cmd.includes('git branch -d'))).toBe(false);
  });

  it('cleanupRemovedAgentRuntime: destroys streamer BEFORE tmux kill', async () => {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: false, sessionId: '$1' });
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
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: false, sessionId: '$1' });
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

  it('previewPromptBytesForTaskInput includes the live platform CLI descriptor', () => {
    const baseline = manager.previewPromptBytesForTaskInput('proj', {
      title: 'hi',
      description: 'do work',
      preferredAgentId: 'dev-1',
    });
    const notes = '汉'.repeat(170);
    manager.replaceConfig({
      ...CONFIG,
      project: [{ ...CONFIG.project[0], gitCli: { tool: 'gh', notes } }],
    });

    const withNotes = manager.previewPromptBytesForTaskInput('proj', {
      title: 'hi',
      description: 'do work',
      preferredAgentId: 'dev-1',
    });

    expect(withNotes - baseline).toBeGreaterThanOrEqual(Buffer.byteLength(notes, 'utf8'));
  });

  it('replaceConfig: rebuilds agentIndex so newly added agents are visible', async () => {
    expect(manager.getAgentConfig('qa-1')).toBeUndefined();
    manager.replaceConfig(expandedConfig());
    expect(manager.getAgentConfig('qa-1')).toBeDefined();
  });

  it('replaceConfig preserves canonical ownership and rejects a newly configured alias', async () => {
    manager.getRepoCache().owners.set('local:/tmp/repo', 'dev-1');
    const config = expandedConfig();
    config.project[0].agent[0][1] = {
      ...config.project[0].agent[0][1],
      workdir: '/tmp/repo-link',
    };
    overrideExec(
      cmd => cmd.includes("cd '/tmp/repo-link'"),
      { stdout: '/tmp/repo\n' },
    );

    manager.replaceConfig(config);

    expect(manager.getRepoCache().owners.get('local:/tmp/repo')).toBe('dev-1');
    const alias = new RepoStore(
      runner as unknown as CommandRunner,
      'owner/repo',
      'local',
      undefined,
      manager.getRepoCache(),
      'qa-1',
      '/tmp/repo-link',
    );
    await expect(alias.ensure()).rejects.toThrow(/already owned by agent "dev-1"/i);
  });

  it.each([
    ['agent removal', []],
    ['idle Workdir change', [[{
      id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local',
      workdir: '/tmp/repo-new', yolo: true,
    }]]],
  ] as const)('replaceConfig releases the old canonical owner on %s', (_label, agent) => {
    manager.getRepoCache().owners.set('local:/tmp/repo', 'dev-1');

    manager.replaceConfig({
      ...CONFIG,
      project: [{ ...CONFIG.project[0], agent: agent as BaxianConfig['project'][number]['agent'] }],
    });

    expect(manager.getRepoCache().owners.has('local:/tmp/repo')).toBe(false);
  });

  type RestartReplPrivates = {
    pollPaneCommandStable: (...a: unknown[]) => Promise<string>;
    ensureWorkdir: (...a: unknown[]) => Promise<{ workdir: string }>;
    provisionRepoSkills: (...a: unknown[]) => Promise<void>;
    tagSessionSkillsVersion: (...a: unknown[]) => Promise<void>;
  };
  function stubRestartRepl(): RestartReplPrivates {
    tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true, sessionId: `$${nextSessionId++}` });
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

  it('restartReplOnly fails closed and does not relaunch when skill re-provision fails', async () => {
    const m = stubRestartRepl();
    vi.spyOn(m, 'provisionRepoSkills').mockRejectedValue(new Error('ssh write failed'));
    const tagSpy = vi.spyOn(m, 'tagSessionSkillsVersion');

    await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/ssh write failed/);

    expect(tagSpy).not.toHaveBeenCalled();
    expect(setOptionCalls('@baxian-skills-version')).toEqual([]);
    expect(execCmds().some(c => c.includes('permission-mode'))).toBe(false);
  });

  it('restartReplOnly refuses to relaunch when the pane has moved outside the fixed Workdir', async () => {
    const m = stubRestartRepl();
    vi.spyOn(m, 'provisionRepoSkills').mockResolvedValue(undefined);
    runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('display-message') && cmd.includes('pane_current_path')) {
        return { stdout: 'BX_PANE_OK/tmp/wrong-directory\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes("cd -P '/tmp/wrong-directory'")) {
        return { stdout: '/tmp/wrong-directory\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes("cd -P '/tmp/repo'")) {
        return { stdout: '/tmp/repo\n', stderr: '', exitCode: 0 };
      }
      return makeMockExec({ trustDialogReady: true })(cmd);
    });

    await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/does not match agent Workdir/i);

    expect(execCmds().some(c => c.includes('permission-mode'))).toBe(false);
  });

  function classifyOutput(proc: string, screen: string): string {
    return `BX_PANE_OK${proc}\n${screen}`;
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
      tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true, sessionId: `$${nextSessionId++}` });
    });

    it('surfaces a claim-snapshot probe failure without adopting', async () => {
      overrideExec(
        c => c.includes('list-sessions'),
        { stderr: 'tmux snapshot probe boom', exitCode: 2 },
      );
      const err = await expectAdoptError(/tmux probe failed/);
      expect(err.partial.createdSession).toBe(false);
    });

    it('adopts when logical and physical Workdir paths identify the same directory', async () => {
      runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('display-message') && cmd.includes('pane_current_path')) {
          return { stdout: 'BX_PANE_OK/private/tmp/repo\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes("cd -P '/private/tmp/repo'") || cmd.includes("cd -P '/tmp/repo'")) {
          return { stdout: '/private/tmp/repo\n', stderr: '', exitCode: 0 };
        }
        return makeMockExec({ trustDialogReady: true })(cmd);
      });

      await expect(manager.ensureSession('dev-1', 'runtime')).resolves.toMatchObject({
        freshRuntime: false,
        paneId: '%0',
        workdir: '/tmp/repo',
      });
      expect(execCmds().some(command => command.includes('kill-session'))).toBe(false);
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
        if (cmd.includes('pane_current_command') && cmd.includes('capture-pane')) {
          return { stdout: classifyOutput('claude', TRUST_SCREEN), stderr: '', exitCode: 0 };
        }
        if (cmd.includes('send-keys') && cmd.includes("'Enter'")) {
          enterSent = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return {
            stdout: `BX_PANE_OK\n${enterSent ? '⏵⏵ bypass permissions on\n' : TRUST_SCREEN}`,
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
        if (cmd.includes('pane_current_command') && cmd.includes('capture-pane')) {
          return { stdout: classifyOutput('claude', TRUST_SCREEN), stderr: '', exitCode: 0 };
        }
        if (cmd.includes('send-keys') && cmd.includes("'Enter'")) {
          enterSent = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return {
            stdout: `BX_PANE_OK\n${enterSent ? 'Press enter to continue\n' : TRUST_SCREEN}`,
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
        if (cmd.includes('pane_current_command') && cmd.includes('capture-pane')) {
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
        if (cmd.includes('pane_current_command') && cmd.includes('capture-pane')) {
          return { stdout: classifyOutput('zsh', '$ \n'), stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: 'BX_PANE_OK\nPress enter to continue\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('display-message') && cmd.includes('pane_current_path')) {
          return { stdout: 'BX_PANE_OK/tmp/repo\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('display-message')) {
          return { stdout: 'BX_PANE_OKclaude\n', stderr: '', exitCode: 0 };
        }
        return makeMockExec({ trustDialogReady: true })(cmd);
      });

      const err = await expectAdoptError(/relaunch blocked on startup dialog/);
      expect(err.partial.dialogPending).toBe(true);
    });

    it('shell relaunch that never becomes ready fails as REPL relaunch failed', async () => {
      runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('pane_current_command') && cmd.includes('capture-pane')) {
          return { stdout: classifyOutput('zsh', '$ \n'), stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: 'BX_PANE_OK\nstill booting...\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('display-message') && cmd.includes('pane_current_path')) {
          return { stdout: 'BX_PANE_OK/tmp/repo\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('display-message')) {
          return { stdout: 'BX_PANE_OKclaude\n', stderr: '', exitCode: 0 };
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
      tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true, sessionId: `$${nextSessionId++}` });
      await manager['agentStore'].set({ id: 'dev-1', projectId: 'proj', updatedAt: new Date().toISOString() });
      vi.spyOn(
        manager as unknown as { ensureWorkdir: () => Promise<unknown> },
        'ensureWorkdir',
      ).mockResolvedValue({ workdir: '/tmp/auto-repo', repoStore: {} });
      overrideExec(
        command => command.includes('display-message') && command.includes('pane_current_path'),
        { stdout: 'BX_PANE_OK/tmp/auto-repo\n' },
      );

      await manager.ensureSession('dev-1', 'runtime');

      expect((await manager['agentStore'].get('dev-1'))?.workdir).toBe('/tmp/auto-repo');
    });

    it('wraps a skill provisioning failure', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      runner.execWithStdin.mockRejectedValue(new Error('remote write refused'));
      await expect(manager.ensureSession('dev-1', 'runtime'))
        .rejects.toThrow(/skill provisioning failed/);
    });

    it('wraps a tmux session-probe failure', async () => {
      overrideExec(
        c => c.includes('list-sessions'),
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
      tmuxSessions.set('dev-1', { claim: 'someone-else', readyOnce: true, sessionId: `$${nextSessionId++}` });
      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/claim mismatch/);
    });

    it('exits a live runtime before relaunching and refreshes the binding paneId', async () => {
      tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true, sessionId: `$${nextSessionId++}` });
      await manager['agentStore'].set({ id: 'dev-1', projectId: 'proj', updatedAt: new Date().toISOString() });
      let exited = false;
      runner.exec.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys')) {
          if (cmd.includes("'/exit'")) exited = true;
          if (cmd.includes('permission-mode')) exited = false;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('display-message') && cmd.includes('pane_current_path')) {
          return { stdout: 'BX_PANE_OK/tmp/repo\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('display-message') && !cmd.includes('capture-pane')) {
          return { stdout: exited ? 'BX_PANE_OKzsh\n' : 'BX_PANE_OKclaude\n', stderr: '', exitCode: 0 };
        }
        return makeMockExec({ trustDialogReady: true })(cmd);
      });

      await manager.restartReplOnly('dev-1');

      expect(execCmds().some(c => c.includes('send-keys') && c.includes("'/exit'"))).toBe(true);
      expect(execCmds().some(c => c.includes('permission-mode'))).toBe(true);
      expect((await manager['agentStore'].get('dev-1'))?.paneId).toBe('%0');
    });

    it('throws on an unexpected foreground process instead of relaunching over it', async () => {
      tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true, sessionId: `$${nextSessionId++}` });
      overrideExec(
        c => c.includes('display-message') && !c.includes('capture-pane'),
        { stdout: 'BX_PANE_OKvim\n' },
      );
      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/unexpected pane state "vim"/);
    });

    it('fails closed without relaunching when the Workdir cannot be resolved', async () => {
      tmuxSessions.set('dev-1', { claim: 'dev-1', readyOnce: true, sessionId: `$${nextSessionId++}` });
      const m = manager as unknown as {
        pollPaneCommandStable: (...a: unknown[]) => Promise<string>;
        ensureWorkdir: (...a: unknown[]) => Promise<unknown>;
      };
      vi.spyOn(m, 'pollPaneCommandStable').mockResolvedValue('zsh');
      vi.spyOn(m, 'ensureWorkdir').mockRejectedValue(new Error('repo store down'));

      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/repo store down/);

      expect(execCmds().some(c => c.includes('permission-mode'))).toBe(false);
      expect(setOptionCalls('@baxian-skills-version')).toEqual([]);
    });
  });

  describe('cleanupRemovedAgentRuntime failure aggregation', () => {
    it('skips the kill (warn only) when the session claim belongs to someone else', async () => {
      tmuxSessions.set('dev-1', { claim: 'foreign-owner', readyOnce: true, sessionId: `$${nextSessionId++}` });
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
        c => c.includes('list-sessions'),
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

  });
});
