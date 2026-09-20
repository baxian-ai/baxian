import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentConfig, BaxianConfig } from '../../src/shared/index.js';
import {
  CleanupFailedError,
  EnsureSessionError,
  type AgentManager,
  type AgentManagerDeps,
} from '../../src/agent/manager.js';
import { RepoStore } from '../../src/agent/repo-store.js';
import type { PaneStreamerManager } from '../../src/agent/pane-streamer-manager.js';
import { ApiError } from '../../src/errors.js';
import { createManagerHarness, repoStoreStandIn, seedTask } from '../helpers/manager-harness.js';
import { fakeRunner, RUNTIME_PROFILES, type FakeRunner, type FakeRunnerOptions } from '../helpers/fake-runner.js';
import { makeAgent, makeConfig } from '../helpers/fixtures.js';

const NOW = '2026-05-14T05:00:00.000Z';
const TRUST_SCREEN = 'Quick safety check\nDo you trust this folder?\n› Yes, I trust this folder\n';
const TRUST_SCREEN_NO_FIRST = RUNTIME_PROFILES['claude-code'].dialogFrame!;
const CLAUDE_LAUNCH = 'permission-mode';

function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

describe('AgentManager.ensureSession', () => {
  let tempDir: string;
  let config: BaxianConfig;
  type Harness = Awaited<ReturnType<typeof createManagerHarness>>;
  let manager: AgentManager;
  let createManager: Harness['createManager'];
  let agentStore: Harness['agentStore'];
  let taskStore: Harness['taskStore'];
  let lockManager: Harness['lockManager'];
  let runner: FakeRunner;

  const cmds = (): string[] => runner.exec.mock.calls.map(c => c[0] as string);
  const trace = (needle: string): string[] => cmds().filter(c => c.includes(needle));
  const keysWith = (needle: string): string[] => runner.sentKeys.filter(c => c.includes(needle));

  function setOptionCalls(...needles: string[]): string[] {
    return cmds().filter(c => c.includes('set-option') && needles.every(n => c.includes(n)));
  }

  // 依次在 runner 轨迹里找到每个片段,且每个都出现在前一个之后
  function traceOrder(needles: string[]): boolean {
    const all = cmds();
    let from = 0;
    for (const needle of needles) {
      const at = all.findIndex((c, i) => i >= from && c.includes(needle));
      if (at === -1) return false;
      from = at + 1;
    }
    return true;
  }

  // 每个用例按模型重建 tmux 替身;节拍与依赖经 createManager 注入
  function live(model: FakeRunnerOptions = {}, deps: Partial<AgentManagerDeps> = {}): FakeRunner {
    runner = fakeRunner(model);
    manager = createManager({ runnerFactory: () => runner, ...deps });
    return runner;
  }

  function repoStoreWith(ensure: () => Promise<string>): NonNullable<AgentManagerDeps['repoStoreFactory']> {
    return (...args) => {
      const store = repoStoreStandIn(tempDir)(...args);
      store.ensure = ensure;
      return store;
    };
  }

  function streamerManager(destroy: (id: string) => Promise<void>): PaneStreamerManager {
    return { destroy } as unknown as PaneStreamerManager;
  }

  function runEnsure(path: 'create' | 'adopt'): Promise<unknown> {
    live({ session: path === 'create' ? 'absent' : 'present' });
    return manager.ensureSession('dev-1', path === 'create' ? 'create' : 'runtime');
  }

  async function expectEnsureError(mode: 'create' | 'runtime', pattern: RegExp): Promise<EnsureSessionError> {
    const err = await manager.ensureSession('dev-1', mode).then(
      () => { throw new Error('expected throw'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EnsureSessionError);
    expect((err as EnsureSessionError).message).toMatch(pattern);
    return err as EnsureSessionError;
  }

  function expandedConfig(): BaxianConfig {
    return makeConfig({
      ...config,
      project: [{
        ...config.project[0],
        agent: [
          ...config.project[0].agent,
          [
            makeAgent({ id: 'dev-2', workdir: '/tmp/repo-2', yolo: true }),
            makeAgent({
              id: 'qa-2',
              runtime: 'codex',
              role: 'qa',
              workdir: '/tmp/qa-repo-2',
              yolo: true,
            }),
          ],
        ],
      }],
    });
  }

  async function setPaneId(id: string, paneId: string): Promise<void> {
    await agentStore.set({ ...(await agentStore.get(id))!, paneId });
  }

  function seedRunningTask(id: string): Promise<void> {
    const now = new Date().toISOString();
    return seedTask(taskStore, {
      id,
      phase: 'code',
      branchCreatedByBaxian: undefined,
      platformBinding: undefined,
      createdAt: now,
      updatedAt: now,
    }).then(() => undefined);
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'baxian-ensure-session-'));
    config = makeConfig({
      project: [{
        id: 'proj',
        repo: 'https://github.com/owner/repo.git',
        merge: null,
        agent: [[
          makeAgent({ yolo: true }),
          makeAgent({ id: 'qa-1', runtime: 'codex', role: 'qa', workdir: '/tmp/qa-repo', yolo: true }),
        ]],
      }],
    });
    runner = fakeRunner();
    const harness = await createManagerHarness(tempDir, {
      config,
      deps: {
        runnerFactory: () => runner,
        platformRunner: runner,
        repoStoreFactory: repoStoreStandIn(tempDir),
        bootstrapTimeoutsMs: { trustDialog: 200, waitReplReady: 400 },
        compactIdlePollMs: 1,
      },
    });
    ({ manager, createManager, agentStore, taskStore, lockManager } = harness);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('create mode, no existing session → builds + claim + paneId', async () => {
    live({ session: 'absent' });

    const result = await manager.ensureSession('dev-1', 'create');

    const pane = runner.sessions.pane('dev-1')!;
    expect(result).toMatchObject({ ok: true, createdSession: true, freshRuntime: true, paneId: pane.id });
    expect(runner.sessions.present('dev-1')).toBe(true);
    expect(runner.sessions.option('dev-1', '@baxian-agent-id')).toBe('dev-1');
    expect(pane).toMatchObject({ process: 'claude', phase: 'idle' });
  });

  it('create mode, session already exists → throws (createdSession=false)', async () => {
    live({ agents: { 'dev-1': { claim: 'someone-else' } } });

    const err = await expectEnsureError('create', /already exists/);

    expect(err.partial.createdSession).toBe(false);
    expect(runner.sessions.present('dev-1')).toBe(true);
    expect(trace('new-session')).toHaveLength(0);
  });

  it('create mode reclaims a half-created leftover (nonce present, claim never written) and boots fresh', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    live({ agents: { 'dev-1': { claim: null, nonce: 'stranded-nonce' } } });

    const result = await manager.ensureSession('dev-1', 'create');

    expect(result.createdSession).toBe(true);
    expect(result.sessionRef.sessionId).not.toBe('$1');
    expect(runner.sessions.option('dev-1', '@baxian-agent-id')).toBe('dev-1');
    expect(traceOrder(['kill-session', 'new-session'])).toBe(true);
    expect(warn.mock.calls.some(c => String(c[0]).includes('half-created leftover'))).toBe(true);
  });

  it('create mode leaves a claimless session without the nonce to the operator', async () => {
    live({ agents: { 'dev-1': { claim: null } } });

    await expectEnsureError('create', /already exists/);

    expect(runner.sessions.present('dev-1')).toBe(true);
    expect(trace('kill-session')).toHaveLength(0);
  });

  it('a same-name replacement between create and configuration never receives the claim', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 会话 id 只由 new-session 分配:用换代(pid/start_time 变化)表达"创建后、写 option 前已被同名会话顶替"
    live({
      session: 'absent',
      onExec: cmd => {
        if (cmd.includes('set-option') && cmd.includes('@baxian-agent-id')) runner.sessions.bumpGeneration('dev-1');
      },
    });

    const err = await expectEnsureError('create', /vanished before its options/);

    expect(err.partial.createdSession).toBe(true);
    expect(runner.sessions.present('dev-1')).toBe(true);
    expect(runner.sessions.option('dev-1', '@baxian-agent-id')).toBeUndefined();
  });

  it('reclaim logs already-gone instead of a fabricated kill when the session vanished', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    live({
      agents: { 'dev-1': { claim: null, nonce: 'stranded' } },
      onExec: cmd => { if (cmd.includes('kill-session')) runner.sessions.drop('dev-1'); },
    });

    const result = await manager.ensureSession('dev-1', 'create');

    expect(result.createdSession).toBe(true);
    expect(runner.sessions.present('dev-1')).toBe(true);
    expect(warn.mock.calls.some(c => String(c[0]).includes('already gone'))).toBe(true);
    expect(warn.mock.calls.some(c => String(c[0]).includes('killed half-created'))).toBe(false);
  });

  it('reclaim stands down when a claim lands between the probes and the kill', async () => {
    live({
      agents: { 'dev-1': { claim: null, nonce: 'stranded-nonce' } },
      onExec: cmd => { if (cmd.includes('show-environment')) runner.sessions.reclaim('dev-1', 'dev-1'); },
    });

    await expectEnsureError('create', /claimed .*while reclaiming|retry to observe/);

    expect(runner.sessions.present('dev-1')).toBe(true);
    expect(runner.sessions.option('dev-1', '@baxian-agent-id')).toBe('dev-1');
    expect(trace('new-session')).toHaveLength(0);
  });

  it('new-session ok but post-create setOption fails → partial.createdSession=true so caller can rollback orphan', async () => {
    live({
      session: 'absent',
      rules: [{
        match: cmd => cmd.includes('set-option') && cmd.includes('@baxian-agent-id'),
        reply: { stderr: 'tmux command failed: bad option', exitCode: 1 },
      }],
    });

    const err = await expectEnsureError('create', /bad option/);

    expect(err.partial).toMatchObject({ createdSession: true, agentId: 'dev-1' });
    expect(runner.sessions.present('dev-1')).toBe(true);
  });

  it('runtime mode, claim matches → adopts existing session', async () => {
    live();

    const result = await manager.ensureSession('dev-1', 'runtime');

    expect(result).toMatchObject({ createdSession: false, freshRuntime: false, paneId: '%0' });
    expect(trace('new-session')).toHaveLength(0);
    expect(runner.sentKeys).toEqual([]);
  });

  it('create path pins window-size=latest so plain tmux attach follows the current terminal size', async () => {
    await runEnsure('create');
    const windowSizeCalls = setOptionCalls('window-size', 'latest');
    expect(windowSizeCalls).toHaveLength(1);
    expect(windowSizeCalls[0]).toMatch(/set-option -t '\\''\$\d+'\\'' window-size/);
    expect(runner.sessions.option('dev-1', 'window-size')).toBe('latest');
  });

  it('adopt path preserves the existing window-size owner', async () => {
    await runEnsure('adopt');
    expect(setOptionCalls('window-size')).toHaveLength(0);
    expect(runner.sessions.option('dev-1', 'window-size')).toBeUndefined();
  });

  it.each(['create', 'adopt'] as const)('%s path locks prefix=C-b + prefix2=None', async (path) => {
    await runEnsure(path);
    expect(setOptionCalls('prefix ', 'C-b')).toHaveLength(1);
    expect(setOptionCalls('prefix2 ', 'None')).toHaveLength(1);
    expect(runner.sessions.option('dev-1', 'prefix')).toBe('C-b');
    expect(runner.sessions.option('dev-1', 'prefix2')).toBe('None');
  });

  it.each(['create', 'adopt'] as const)('%s path pins mouse=on', async (path) => {
    await runEnsure(path);
    const mouseOn = setOptionCalls('mouse ');
    expect(mouseOn).toHaveLength(1);
    expect(mouseOn[0]).toMatch(/mouse '\\''on'\\''/);
    expect(mouseOn[0]).toMatch(/-t '\\''\$\d+'\\''/);
    expect(runner.sessions.option('dev-1', 'mouse')).toBe('on');
  });

  it('adopt path: runtime option failure surfaces as EnsureSessionError (preserves partial contract)', async () => {
    live({
      rules: [{
        match: c => c.includes('set-option') && c.includes('prefix ') && c.includes('C-b'),
        reply: { stderr: 'tmux command failed: bad option', exitCode: 1 },
      }],
    });

    const err = await expectEnsureError('runtime', /pinning runtime session options failed/);

    expect(err.partial).toMatchObject({ createdSession: false, agentId: 'dev-1' });
  });

  it('runtime mode, claim mismatch → throws (createdSession=false)', async () => {
    live({ agents: { 'dev-1': { claim: 'someone-else' } } });

    const err = await expectEnsureError('runtime', /session claim mismatch/);

    expect(err.partial.createdSession).toBe(false);
    expect(runner.sentKeys).toEqual([]);
  });

  it('runtime mode, no session → auto-builds (createdSession=true)', async () => {
    live({ session: 'absent' });

    const result = await manager.ensureSession('dev-1', 'runtime');

    expect(result.createdSession).toBe(true);
    expect(runner.sessions.present('dev-1')).toBe(true);
    expect(runner.sessions.pane('dev-1')).toMatchObject({ id: result.paneId, process: 'claude', phase: 'idle' });
  });

  it('REPL that exited back to the shell with dialog text left on screen is a bootstrap failure, not a pending dialog', async () => {
    const leftover = ' Enter to confirm · Esc to cancel\n➜  repo git:(main)\n';
    let exited = false;
    live({
      session: 'absent',
      // 启动后第一次抓屏前 runtime 已退回 shell,对话框文字仍留在屏幕上
      onExec: cmd => {
        if (exited || !cmd.includes('capture-pane') || runner.sessions.pane('dev-1')?.process !== 'claude') return;
        exited = true;
        runner.sessions.setProcess('dev-1', 'zsh');
        runner.sessions.markWorking('dev-1', leftover);
      },
    });

    const err = await expectEnsureError('create', /shell/);

    expect(err.partial.createdSession).toBe(true);
    expect(err.partial.dialogPending).toBeFalsy();
    expect(err.partial.lastScreen).toContain('Enter to confirm');
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
    // trustDialog 即启动后的首屏:runtime 起来后停在这一帧,不会自行就绪
    live({ session: 'absent', agents: { 'dev-1': { trustDialog: screen } } });

    const err = await expectEnsureError('create', /buildFreshSession failed/);

    expect(err.partial.createdSession).toBe(true);
    if (dialogPending) expect(err.partial.dialogPending).toBe(true);
    else expect(err.partial.dialogPending).toBeFalsy();
    expect(err.partial.lastScreen).toContain(lastScreen);
    if (message) expect(err.message).toContain(message);
  });

  it('Unknown agent → EnsureSessionError without touching tmux', async () => {
    live();
    await expect(manager.ensureSession('nonexistent', 'create'))
      .rejects.toBeInstanceOf(EnsureSessionError);
    expect(runner.exec).not.toHaveBeenCalled();
  });

  it('acquireAgentForTask records taskId; lock contention returns false', async () => {
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(true);
    const state = await agentStore.get('dev-1');
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
    expect(await agentStore.get('dev-1')).toBeNull();
    manager.releaseDeletionClaim(['dev-1']);
  });

  it('acquireAgentForTask is ABA-safe: a bumped deletion generation NOOPs a suspended commit', async () => {
    const realGenOf = manager.deletionGenerationOf.bind(manager);
    let firstCall = true;
    const spy = vi.spyOn(manager, 'deletionGenerationOf').mockImplementation((id: string) => {
      if (firstCall) { firstCall = false; return 0; }
      return id === 'dev-1' ? 1 : realGenOf(id);
    });
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(false);
    expect(await agentStore.get('dev-1')).toBeNull();
    expect(await lockManager.claimOf('dev-1')).toBeNull();
    spy.mockRestore();
  });

  it('acquireAgentForTask still lazily initializes a config-only agent with no prior state', async () => {
    expect(await agentStore.get('dev-1')).toBeNull();
    expect(await manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(true);
    expect((await agentStore.get('dev-1'))?.taskId).toBe('task-1');
  });

  it('releaseAgentForTask returns false on stale taskId (do not touch new assignment)', async () => {
    await manager.acquireAgentForTask('dev-1', 'task-1', 'develop');
    expect(await manager.releaseAgentForTask('dev-1', 'task-OTHER', 'idle')).toBe(false);
    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBe('task-1');
  });

  it('releaseAgentForTask mode=waiting keeps the binding without releasing lock', async () => {
    live();
    await seedRunningTask('task-1');
    await manager.acquireAgentForTask('dev-1', 'task-1', 'develop');
    const ensure = await manager.ensureSession('dev-1', 'runtime');
    await setPaneId('dev-1', ensure.paneId);
    expect(await manager.releaseAgentForTask('dev-1', 'task-1', 'waiting')).toBe(true);
    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBe('task-1');
    expect(await lockManager.isLocked('dev-1')).toBe(true);
  });

  it('release on a non-ready pane (mode=idle): keeps the binding and lock without touching checkout', async () => {
    live({}, { cleanComposerWaitMs: 10 });
    await seedRunningTask('task-r1');
    await manager.acquireAgentForTask('dev-1', 'task-r1', 'develop');
    await agentStore.update('dev-1', state => ({ ...state!, paneId: '%0', workdir: '/tmp/repo' }));
    runner.sessions.markWorking('dev-1', '✻ Thinking… (12s · esc to interrupt)\n');

    expect(await manager.releaseAgentForTask('dev-1', 'task-r1', 'idle')).toBe(false);

    const state = await agentStore.get('dev-1');
    expect(state?.taskId).toBe('task-r1');
    expect(state).toMatchObject({ status: 'awaiting_human', awaitingPhase: 'branch-cleanup-pending' });
    expect(await lockManager.isLocked('dev-1')).toBe(true);
    expect(cmds().some(cmd => cmd.includes('git switch') || cmd.includes('git branch -d'))).toBe(false);
  });

  it('cleanupRemovedAgentRuntime: destroys streamer BEFORE tmux kill', async () => {
    const order: string[] = [];
    live(
      { onExec: cmd => { if (cmd.includes('kill-session')) order.push('kill-session'); } },
      { paneStreamerManager: streamerManager(async id => { order.push(`destroy:${id}`); }) },
    );

    await manager.cleanupRemovedAgentRuntime(['dev-1']);

    expect(order).toEqual(['destroy:dev-1', 'kill-session']);
    expect(runner.sessions.present('dev-1')).toBe(false);
  });

  it('cleanupRemovedAgentRuntime: streamer destroy failure is logged but does NOT skip tmux kill', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    live({}, { paneStreamerManager: streamerManager(async () => { throw new Error('streamer boom'); }) });

    await manager.cleanupRemovedAgentRuntime(['dev-1']);

    expect(runner.sessions.present('dev-1')).toBe(false);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('destroy(dev-1) failed'))).toBe(true);
  });

  it('prepareRemoveTargets returns the whole team for either member', async () => {
    manager.replaceConfig(expandedConfig());
    expect(manager.prepareRemoveTargets('dev-1').targets).toEqual(['dev-1', 'qa-1']);
    expect(manager.prepareRemoveTargets('qa-1').targets).toEqual(['dev-1', 'qa-1']);
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

  it('previewPromptBytesForTaskInput includes the live repository descriptor', () => {
    const baseline = manager.previewPromptBytesForTaskInput('proj', {
      title: 'hi',
      description: 'do work',
      preferredAgentId: 'dev-1',
    });
    manager.replaceConfig({
      ...config,
      project: [{
        ...config.project[0],
        repo: 'https://github.com/example-owner/a-much-longer-repository-name.git',
      }],
    });

    const withNotes = manager.previewPromptBytesForTaskInput('proj', {
      title: 'hi',
      description: 'do work',
      preferredAgentId: 'dev-1',
    });

    expect(withNotes).toBeGreaterThan(baseline);
  });

  it('replaceConfig: rebuilds agentIndex so newly added agents are visible', async () => {
    expect(manager.getAgentConfig('qa-2')).toBeUndefined();
    manager.replaceConfig(expandedConfig());
    expect(manager.getAgentConfig('qa-2')).toBeDefined();
  });

  it('replaceConfig preserves canonical ownership and rejects a newly configured alias', async () => {
    live({ rules: [{ match: "cd '/tmp/repo-link'", reply: { stdout: '/tmp/repo\n' } }] });
    manager.getRepoCache().owners.set('local:/tmp/repo', 'dev-1');
    const config = expandedConfig();
    config.project[0].agent[0][1] = {
      ...config.project[0].agent[0][1],
      workdir: '/tmp/repo-link',
    };

    manager.replaceConfig(config);

    expect(manager.getRepoCache().owners.get('local:/tmp/repo')).toBe('dev-1');
    const alias = new RepoStore(
      runner,
      'owner/repo',
      'local',
      undefined,
      manager.getRepoCache(),
      'qa-1',
      '/tmp/repo-link',
    );
    await expect(alias.ensure()).rejects.toThrow(/already owned by agent "dev-1"/i);
  });

  it.each<[string, AgentConfig[][]]>([
    ['agent removal', []],
    ['idle Workdir change', [[
      makeAgent({ workdir: '/tmp/repo-new', yolo: true }),
      makeAgent({ id: 'qa-1', runtime: 'codex', role: 'qa', workdir: '/tmp/qa-repo', yolo: true }),
    ]]],
  ])('replaceConfig releases the old canonical owner on %s', (_label, agent) => {
    manager.getRepoCache().owners.set('local:/tmp/repo', 'dev-1');

    manager.replaceConfig({
      ...config,
      project: [{ ...config.project[0]!, agent }],
    });

    expect(manager.getRepoCache().owners.has('local:/tmp/repo')).toBe(false);
  });

  it('restartReplOnly clears the remembered task context after a successful relaunch', async () => {
    live({ agents: { 'dev-1': { options: { '@baxian-context-task-id': 'task-old' } } } });

    await manager.restartReplOnly('dev-1');

    expect(runner.sessions.option('dev-1', '@baxian-context-task-id')).toBe('');
    expect(runner.sessions.pane('dev-1')).toMatchObject({ process: 'claude', phase: 'idle' });
  });

  it('restartReplOnly refuses to relaunch when the pane has moved outside the fixed Workdir', async () => {
    live({ agents: { 'dev-1': { workdir: '/tmp/wrong-directory' } } });

    await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/does not match agent Workdir/i);

    expect(runner.sentKeys).toEqual([]);
    expect(runner.sessions.pane('dev-1')).toMatchObject({ process: 'claude', phase: 'idle' });
  });

  describe('adoptOrRestartSession probe failures & pane states', () => {
    it('surfaces a claim-snapshot probe failure without adopting', async () => {
      live({ rules: [{ match: 'list-sessions', reply: { stderr: 'tmux snapshot probe boom', exitCode: 2 } }] });
      const err = await expectEnsureError('runtime', /tmux probe failed/);
      expect(err.partial.createdSession).toBe(false);
      expect(runner.sentKeys).toEqual([]);
    });

    it('adopts when logical and physical Workdir paths identify the same directory', async () => {
      live({
        agents: { 'dev-1': { workdir: '/private/tmp/repo' } },
        rules: [{ match: "cd -P '/tmp/repo'", reply: { stdout: '/private/tmp/repo\n' } }],
      });

      await expect(manager.ensureSession('dev-1', 'runtime')).resolves.toMatchObject({
        freshRuntime: false,
        paneId: '%0',
        workdir: '/tmp/repo',
      });
      expect(trace('kill-session')).toHaveLength(0);
      expect(trace('new-session')).toHaveLength(0);
    });

    it('kills and rebuilds the session when the idle runtime sits in a different Workdir', async () => {
      live({ agents: { 'dev-1': { workdir: '/tmp/elsewhere' } } });

      const result = await manager.ensureSession('dev-1', 'runtime');

      expect(result).toMatchObject({ createdSession: true, freshRuntime: true });
      expect(result.sessionRef.sessionId).not.toBe('$1');
      expect(runner.sessions.pane('dev-1')).toMatchObject({ id: result.paneId, process: 'claude', phase: 'idle' });
      expect(traceOrder(['kill-session', 'new-session'])).toBe(true);
    });

    it('refuses a session with more than one pane (getSinglePaneId failure)', async () => {
      live({ rules: [{ match: 'list-panes', reply: { stdout: '%0 zsh\n%1 zsh\n' } }] });
      await expectEnsureError('runtime', /getSinglePaneId failed/);
      expect(runner.sentKeys).toEqual([]);
    });

    it('surfaces a classifyPaneForAdopt probe failure', async () => {
      live({
        rules: [{
          match: c => c.includes('display-message') && c.includes('capture-pane'),
          reply: { stderr: 'probe boom', exitCode: 1 },
        }],
      });
      await expectEnsureError('runtime', /classifyPaneForAdopt failed/);
    });

    it('classifies a runtime stuck on a startup dialog as dialogPending', async () => {
      live({ agents: { 'dev-1': { screen: '✨ Update available!\nPress enter to continue\n' } } });

      const err = await expectEnsureError('runtime', /blocked on startup dialog/);

      expect(err.partial.dialogPending).toBe(true);
      expect(err.partial.lastScreen).toContain('Press enter to continue');
      expect(runner.sentKeys).toEqual([]);
    });

    it('refuses to send launch keys into a foreign foreground process', async () => {
      live({ agents: { 'dev-1': { process: 'vim', screen: 'editing something\n' } } });

      const err = await expectEnsureError('runtime', /pane foreground "vim" is neither runtime/);

      expect(err.partial.dialogPending).toBeFalsy();
      expect(runner.sentKeys).toEqual([]);
      expect(runner.sessions.pane('dev-1')!.process).toBe('vim');
    });

    it.each([
      ['Yes preselected', TRUST_SCREEN, false],
      ['No preselected', TRUST_SCREEN_NO_FIRST, true],
    ])('auto-answers a trust dialog (%s) and adopts the pane as a fresh runtime', async (_label, screen, needsDown) => {
      live({ agents: { 'dev-1': { screen } } });

      const result = await manager.ensureSession('dev-1', 'runtime');

      expect(result).toMatchObject({ createdSession: false, freshRuntime: true, paneId: '%0' });
      expect(keysWith("'Down'").length > 0).toBe(needsDown);
      expect(keysWith("'Enter'")).toHaveLength(1);
      expect(runner.sessions.pane('dev-1')).toMatchObject({ process: 'claude', phase: 'idle' });
    });

    it('reports dialogPending when a startup dialog appears after the trust auto-answer', async () => {
      let accepted = false;
      live({
        agents: { 'dev-1': { screen: TRUST_SCREEN } },
        onExec: cmd => {
          if (cmd.includes("'Enter'")) accepted = true;
          else if (accepted && cmd.includes('capture-pane')) runner.sessions.markWorking('dev-1', 'Press enter to continue\n');
        },
      });

      const err = await expectEnsureError('runtime', /blocked on startup dialog after trust auto-answer/);

      expect(err.partial.dialogPending).toBe(true);
      expect(err.partial.lastScreen).toContain('Press enter to continue');
    });

    it('wraps a trust-dialog handling crash as EnsureSessionError', async () => {
      live({
        agents: { 'dev-1': { screen: TRUST_SCREEN } },
        rules: [{
          match: c => c.includes('capture-pane') && !c.includes('pane_current_command'),
          reply: { stderr: 'capture blew up', exitCode: 1 },
        }],
      });

      await expectEnsureError('runtime', /trust dialog handling failed/);
      expect(runner.sessions.pane('dev-1')!.phase).toBe('dialog');
    });

    it('shell relaunch blocked on a startup dialog reports dialogPending', async () => {
      live({ agents: { 'dev-1': { process: 'zsh', trustDialog: 'Press enter to continue\n' } } });

      const err = await expectEnsureError('runtime', /relaunch blocked on startup dialog/);

      expect(err.partial.dialogPending).toBe(true);
      expect(runner.sessions.pane('dev-1')!.process).toBe('claude');
    });

    it('shell relaunch that never becomes ready fails as REPL relaunch failed', async () => {
      live({ agents: { 'dev-1': { process: 'zsh', trustDialog: 'still booting...\n' } } });

      const err = await expectEnsureError('runtime', /REPL relaunch failed/);

      expect(err.partial.dialogPending).toBeFalsy();
    });
  });

  describe('ensureSession pre-flight failures', () => {
    it('wraps an ensureWorkdir failure', async () => {
      live({}, { repoStoreFactory: repoStoreWith(async () => { throw new Error('clone failed'); }) });
      await expect(manager.ensureSession('dev-1', 'runtime'))
        .rejects.toThrow(/ensureWorkdir failed: clone failed/);
      expect(runner.exec).not.toHaveBeenCalled();
    });

    it('records the auto-managed repo path on the binding when a repoStore resolves the workdir', async () => {
      live(
        { agents: { 'dev-1': { workdir: '/tmp/auto-repo' } } },
        { repoStoreFactory: repoStoreWith(async () => '/tmp/auto-repo') },
      );
      await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });

      const result = await manager.ensureSession('dev-1', 'runtime');

      expect(result.workdir).toBe('/tmp/auto-repo');
      expect((await agentStore.get('dev-1'))?.workdir).toBe('/tmp/auto-repo');
    });

    it('wraps a tmux session-probe failure', async () => {
      live({ rules: [{ match: 'list-sessions', reply: { stderr: 'tmux socket weirdness', exitCode: 2 } }] });
      await expect(manager.ensureSession('dev-1', 'runtime'))
        .rejects.toThrow(/tmux probe failed/);
    });
  });

  describe('restartReplOnly preconditions & relaunch', () => {
    const WORKING = '⏵ Thinking · esc to interrupt\n\n❯ \n⏵⏵ bypass permissions on';

    it('throws when the tmux session does not exist', async () => {
      live({ session: 'absent' });
      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/does not exist/);
      expect(trace('new-session')).toHaveLength(0);
    });

    it('refuses a foreign session claim', async () => {
      live({ agents: { 'dev-1': { claim: 'someone-else' } } });
      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/claim mismatch/);
      expect(runner.sentKeys).toEqual([]);
    });

    it('exits a live runtime before relaunching and refreshes the binding paneId', async () => {
      live();
      await agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });

      await manager.restartReplOnly('dev-1');

      expect(traceOrder(["'/exit'", 'BX_SHELL_OK'])).toBe(true);
      expect(keysWith(CLAUDE_LAUNCH)).toHaveLength(1);
      expect(runner.sessions.pane('dev-1')).toMatchObject({ id: '%0', process: 'claude', phase: 'idle' });
      expect((await agentStore.get('dev-1'))?.paneId).toBe('%0');
    });

    it('throws on an unexpected foreground process instead of relaunching over it', async () => {
      live();
      runner.sessions.setProcess('dev-1', 'vim');

      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/unexpected pane state "vim"/);

      expect(runner.sentKeys).toEqual([]);
      expect(runner.sessions.pane('dev-1')!.process).toBe('vim');
    });

    it.each([
      ['dev-1', 'claude-code', "' '", "'/exit'", CLAUDE_LAUNCH],
      ['qa-1', 'codex', "','", "'/quit'", 'dangerously-bypass'],
    ] as const)('%s exits via composer clear → exit command; never a bare C-c (which quits codex outright)', async (agentId, runtime, dirtyKey, exitCommand, launchFlag) => {
      live();

      await manager.restartReplOnly(agentId);

      const keys = runner.sentKeys;
      const dirtyIdx = keys.findIndex(c => c.includes('send-keys -l') && c.includes(dirtyKey));
      const ccIdxs = keys.flatMap((c, i) => (c.includes("'C-c'") ? [i] : []));
      const exitIdx = keys.findIndex(c => c.includes(exitCommand));
      const launchIdx = keys.findIndex(c => c.includes(launchFlag));
      expect(keys.some(c => c.includes("'Escape'"))).toBe(false);
      expect(dirtyIdx).toBeGreaterThanOrEqual(0);
      // 第一个 C-c 紧跟弄脏键(清 composer);第二个 C-c 与启动命令、Enter 同在一条 shell 守卫写里,由 tmux 服务端确认前台是 shell 后才排入
      expect(ccIdxs).toHaveLength(2);
      expect(ccIdxs[0]).toBeGreaterThan(dirtyIdx);
      expect(exitIdx).toBeGreaterThan(ccIdxs[0]);
      expect(ccIdxs[1]).toBeGreaterThan(exitIdx);
      expect(ccIdxs[1]).toBe(launchIdx);
      expect(keys[launchIdx]).toContain('BX_SHELL_OK');
      expect(keys[launchIdx]!.indexOf("'C-c'")).toBeLessThan(keys[launchIdx]!.indexOf(launchFlag));
      expect(runner.sessions.pane(agentId)).toMatchObject({ process: RUNTIME_PROFILES[runtime].process, phase: 'idle', composer: '' });
    });

    it('sends Escape only when the runtime is mid-turn, then exits once it returns to idle', async () => {
      live({ ackHoldCaptures: Infinity }, { restartInterruptWaitMs: 100 });
      runner.sessions.markWorking('dev-1');

      await manager.restartReplOnly('dev-1');

      const keys = runner.sentKeys;
      const escIdx = keys.findIndex(c => c.includes("'Escape'"));
      const exitIdx = keys.findIndex(c => c.includes("'/exit'"));
      expect(escIdx).toBeGreaterThanOrEqual(0);
      expect(exitIdx).toBeGreaterThan(escIdx);
      expect(keys.some(c => c.includes('BX_SHELL_OK') && c.includes(CLAUDE_LAUNCH))).toBe(true);
      expect(runner.sessions.pane('dev-1')).toMatchObject({ process: 'claude', phase: 'idle' });
    });

    it('fails closed without relaunching when the runtime is still in the foreground after the exit command', async () => {
      // tmux 收下了退出命令(OK 标记),runtime 却没有退出
      live({ rules: [{ match: "'/exit'", reply: { stdout: 'BX_RUNTIME_OK\n' } }] }, { replExitWaitMs: 300 });

      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/did not exit within 300ms/);

      expect(keysWith("'/exit'")).toHaveLength(1);
      expect(keysWith('BX_SHELL_OK')).toHaveLength(0);
      expect(runner.sessions.pane('dev-1')!.process).toBe('claude');
    });

    it('refuses to send the exit command while the runtime is still mid-turn after Escape', async () => {
      live({ ackHoldCaptures: Infinity, agents: { 'dev-1': { interrupt: 'ignored-live' } } }, { restartInterruptWaitMs: 100 });
      runner.sessions.markWorking('dev-1');

      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/did not return to an idle prompt after Escape/);

      expect(keysWith("'Escape'")).toHaveLength(1);
      expect(keysWith("'/exit'")).toHaveLength(0);
      expect(keysWith("'C-c'")).toHaveLength(0);
      expect(runner.sessions.pane('dev-1')!.phase).toBe('working');
    });

    it('relaunches without Escape or an exit command when the runtime drops to the shell during the first idle wait', async () => {
      let dropped = false;
      live({
        ackHoldCaptures: Infinity,
        // 就绪等待第一次抓屏时 runtime 已自行退到 shell(误杀后的 recap 结束)
        onExec: cmd => {
          if (dropped || !cmd.includes('capture-pane')) return;
          dropped = true;
          runner.sessions.setProcess('dev-1', 'zsh');
        },
      }, { restartInterruptWaitMs: 5_000 });
      runner.sessions.markWorking('dev-1');

      await manager.restartReplOnly('dev-1');

      expect(keysWith("'Escape'")).toHaveLength(0);
      expect(keysWith("'/exit'")).toHaveLength(0);
      const guards = keysWith("'C-c'");
      expect(guards).toHaveLength(1);
      expect(guards[0]).toContain('BX_SHELL_OK');
      expect(guards[0]!.indexOf("'C-c'")).toBeLessThan(guards[0]!.indexOf(CLAUDE_LAUNCH));
      expect(runner.sessions.pane('dev-1')).toMatchObject({ process: 'claude', phase: 'idle' });
    });

    it('relaunches without an exit command when the runtime drops to the shell while being interrupted', async () => {
      let escaped = false;
      let dropped = false;
      live({
        ackHoldCaptures: Infinity,
        onExec: cmd => {
          if (cmd.includes("'Escape'")) { escaped = true; return; }
          if (!escaped || dropped) return;
          dropped = true;
          runner.sessions.setProcess('dev-1', 'zsh');
        },
      }, { restartInterruptWaitMs: 100 });
      runner.sessions.markWorking('dev-1');

      await manager.restartReplOnly('dev-1');

      expect(keysWith("'Escape'")).toHaveLength(1);
      expect(keysWith("'/exit'")).toHaveLength(0);
      const guards = keysWith("'C-c'");
      expect(guards).toHaveLength(1);
      expect(guards[0]).toContain('BX_SHELL_OK');
      expect(guards[0]!.indexOf("'C-c'")).toBeLessThan(guards[0]!.indexOf(CLAUDE_LAUNCH));
      expect(runner.sessions.pane('dev-1')).toMatchObject({ process: 'claude', phase: 'idle' });
    });

    it('accepts any supported login shell (dash) as proof the runtime exited, then relaunches', async () => {
      let exited = false;
      let switched = false;
      live({
        onExec: cmd => {
          if (cmd.includes("'/exit'")) { exited = true; return; }
          if (!exited || switched) return;
          switched = true;
          runner.sessions.setProcess('dev-1', 'dash');
        },
      });

      await manager.restartReplOnly('dev-1');

      expect(keysWith("'/exit'")).toHaveLength(1);
      expect(keysWith(CLAUDE_LAUNCH)).toHaveLength(1);
      expect(runner.sessions.pane('dev-1')).toMatchObject({ process: 'claude', phase: 'idle' });
    });

    it('relaunch is one shell-guarded tmux call: identity + shell-foreground condition, then C-c, the launch command and Enter, with no read in between', async () => {
      live({ agents: { 'dev-1': { process: 'zsh' } } });

      await manager.restartReplOnly('dev-1');

      const guards = trace('BX_SHELL_OK');
      expect(guards).toHaveLength(1);
      const guard = guards[0]!;
      expect(guard).toContain('if-shell');
      expect(guard).toContain('#{==:#{pane_current_command},zsh}');
      expect(guard).toContain('#{==:#{@baxian-agent-id},dev-1}');
      const order = ["'C-c'", CLAUDE_LAUNCH, "'Enter'"].map(part => guard.indexOf(part));
      expect(order.every(i => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(keysWith("'C-c'")).toEqual(guards);
      expect(keysWith("'/exit'")).toHaveLength(0);
      expect(runner.sessions.pane('dev-1')).toMatchObject({ process: 'claude', phase: 'idle' });
    });

    it('refuses to relaunch (no C-c, no command, no Enter) when tmux finds a runtime in the foreground at the moment of the guarded write', async () => {
      live({
        agents: { 'dev-1': { process: 'zsh' } },
        // 入口复查看到 shell;守卫写到达 tmux 时前台已是 runtime(有人在窗口里手动拉起了它)
        onExec: cmd => { if (cmd.includes('BX_SHELL_OK')) runner.sessions.setProcess('dev-1', 'claude'); },
      });

      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/foreground is "claude", not a shell; C-c, command and Enter withheld/);

      expect(trace('BX_SHELL_OK')).toHaveLength(1);
      expect(runner.sentKeys.filter(c => !c.includes('BX_SHELL_OK'))).toEqual([]);
      expect(runner.sessions.pane('dev-1')!.composer).toBe('');
    });

    it('relaunches from a dash prompt without sending an exit command', async () => {
      live({ agents: { 'dev-1': { process: 'dash' } } });

      await manager.restartReplOnly('dev-1');

      expect(keysWith("'/exit'")).toHaveLength(0);
      expect(keysWith(CLAUDE_LAUNCH)).toHaveLength(1);
      expect(runner.sessions.pane('dev-1')).toMatchObject({ process: 'claude', phase: 'idle' });
    });

    it('runs the Workdir preparation before tearing the runtime down, so a failed preparation leaves the REPL alive', async () => {
      live({}, { repoStoreFactory: repoStoreWith(async () => { throw new Error('git fetch timed out'); }) });

      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/git fetch timed out/);

      expect(runner.sentKeys).toEqual([]);
      expect(runner.sessions.pane('dev-1')).toMatchObject({ process: 'claude', phase: 'idle' });
    });

    function withDevModel(model: string): BaxianConfig {
      const next = structuredClone(config);
      next.project[0].agent[0][0] = { ...next.project[0].agent[0][0], model };
      return next;
    }

    it('an idle wait that meets the shell on its very first sample returns at once instead of waiting out restartInterruptWaitMs', async () => {
      let foregroundReads = 0;
      live({
        // 入口两次复查仍是 runtime;就绪等待的第一次前台采样它已退到 shell
        onExec: cmd => {
          if (cmd.includes('pane_current_command') && !cmd.includes('capture-pane') && ++foregroundReads === 3) {
            runner.sessions.setProcess('dev-1', 'zsh');
          }
        },
      }, { restartInterruptWaitMs: 3_000 });

      const started = Date.now();
      await manager.restartReplOnly('dev-1');

      expect(Date.now() - started).toBeLessThan(1_500);
      expect(keysWith("'Escape'")).toHaveLength(0);
      expect(keysWith("'/exit'")).toHaveLength(0);
      expect(runner.sentKeys.some(c => c.includes('BX_SHELL_OK') && c.includes(CLAUDE_LAUNCH))).toBe(true);
    });

    // 用一次在 list-sessions 处挂起的 ensureSession 占住会话生命周期链(retry / delete 走同一条链)
    function holdLifecycleAtProbe(): { holder: Promise<unknown>; heldAt: () => number; release: () => void } {
      const probe = gate();
      let held = false;
      let calls = 0;
      live({
        onExec: async cmd => {
          if (held || !cmd.includes('list-sessions')) return;
          held = true;
          calls = cmds().length;
          await probe.wait;
        },
      });
      const holder = manager.ensureSession('dev-1', 'runtime');
      return {
        holder,
        heldAt: () => { expect(held).toBe(true); return calls; },
        release: probe.release,
      };
    }

    it('a restart queued behind a lifecycle operation launches the config current when it runs, not the one captured at entry', async () => {
      const lifecycle = holdLifecycleAtProbe();
      await vi.waitFor(() => lifecycle.heldAt());
      const restart = manager.restartReplOnly('dev-1');
      await new Promise(resolve => setTimeout(resolve, 20));
      manager.replaceConfig(withDevModel('sonnet-x'));
      lifecycle.release();
      await lifecycle.holder;
      await restart;

      const relaunch = cmds().find(c => c.includes('BX_SHELL_OK'));
      expect(relaunch).toContain('--model');
      expect(relaunch).toContain('sonnet-x');
    });

    it('a config change between the runtime exit and the relaunch stops before launching under a mix of two configs', async () => {
      live({ onExec: cmd => { if (cmd.includes("'/exit'")) manager.replaceConfig(withDevModel('sonnet-x')); } });

      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/config changed while exiting the runtime; run Restart REPL again/);

      expect(keysWith("'/exit'")).toHaveLength(1);
      expect(trace('BX_SHELL_OK')).toHaveLength(0);
      expect(runner.sessions.pane('dev-1')!.process).toBe('zsh');
    });

    function withDevOnRemoteHost(): BaxianConfig {
      const next = structuredClone(config);
      next.host = [...(next.host ?? []), { id: 'box', hostname: 'box.example', port: 22, user: 'runner' }];
      next.project[0].agent[0][0] = { ...next.project[0].agent[0][0], mode: 'remote', host: 'box' };
      return next;
    }

    it('a connection-target change (mode) during the exit trips the config fence even though the launch command is unchanged', async () => {
      live({ onExec: cmd => { if (cmd.includes("'/exit'")) manager.replaceConfig(withDevOnRemoteHost()); } });

      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/config changed while exiting the runtime; run Restart REPL again/);

      expect(keysWith("'/exit'")).toHaveLength(1);
      expect(trace('BX_SHELL_OK')).toHaveLength(0);
      expect(runner.sessions.pane('dev-1')!.process).toBe('zsh');
    });

    it('the exit command and its Enter travel in one runtime-guarded tmux command', async () => {
      live();

      await manager.restartReplOnly('dev-1');

      const exits = trace("'/exit'");
      expect(exits).toHaveLength(1);
      expect(exits[0]).toContain('BX_RUNTIME_OK');
      expect(exits[0]).toContain("'Enter'");
      expect(exits[0]!.indexOf("'/exit'")).toBeLessThan(exits[0]!.indexOf("'Enter'"));
      expect(exits[0]).toContain('#{==:#{pane_current_command},claude}');
    });

    it('an exit command the server refuses because the runtime already dropped to the shell is not an error: the restart relaunches', async () => {
      live({ onExec: cmd => { if (cmd.includes("'/exit'")) runner.sessions.setProcess('dev-1', 'zsh'); } });

      await manager.restartReplOnly('dev-1');

      expect(trace("'/exit'")).toHaveLength(1);
      expect(cmds().filter(c => c.includes('BX_SHELL_OK') && c.includes(CLAUDE_LAUNCH))).toHaveLength(1);
      expect(runner.sessions.pane('dev-1')).toMatchObject({ process: 'claude', phase: 'idle' });
    });

    it('the mid-turn Escape is runtime-guarded; refused because the runtime already dropped to the shell, the restart relaunches without an exit command', async () => {
      live({
        ackHoldCaptures: Infinity,
        onExec: cmd => { if (cmd.includes("'Escape'")) runner.sessions.setProcess('dev-1', 'zsh'); },
      }, { restartInterruptWaitMs: 100 });
      runner.sessions.markWorking('dev-1', WORKING);

      await manager.restartReplOnly('dev-1');

      const escapes = trace("'Escape'");
      expect(escapes).toHaveLength(1);
      expect(escapes[0]).toContain('BX_RUNTIME_OK');
      expect(keysWith("'/exit'")).toHaveLength(0);
      expect(cmds().filter(c => c.includes('BX_SHELL_OK') && c.includes(CLAUDE_LAUNCH))).toHaveLength(1);
      expect(runner.sessions.pane('dev-1')).toMatchObject({ process: 'claude', phase: 'idle' });
    });

    function liveWithExitGate(): { release: () => void } {
      const exitGate = gate();
      live({ onExec: async cmd => { if (cmd.includes("'/exit'")) await exitGate.wait; } });
      return { release: exitGate.release };
    }

    it('a second restart while one is mid-flight is refused as 409 without touching the pane; the pane mutex is released once the first finishes', async () => {
      const exitGate = liveWithExitGate();

      const first = manager.restartReplOnly('dev-1');
      await vi.waitFor(() => expect(trace("'/exit'")).toHaveLength(1));
      const callsBeforeSecond = cmds().length;

      const second = await manager.restartReplOnly('dev-1').catch(e => e);
      expect(second).toBeInstanceOf(ApiError);
      expect((second as ApiError).status).toBe(409);
      expect((second as Error).message).toMatch(/pane is busy \(compact, upload, dispatch or another restart in progress\)/);
      expect(cmds()).toHaveLength(callsBeforeSecond);

      exitGate.release();
      await first;
      expect(trace("'/exit'")).toHaveLength(1);
      expect(trace('BX_SHELL_OK')).toHaveLength(1);

      await manager.restartReplOnly('dev-1');
      expect(trace("'/exit'")).toHaveLength(2);
    });

    it('while a restart holds the pane, compact is refused and a text injection waits until the relaunch has finished', async () => {
      await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%0', updatedAt: NOW });
      const exitGate = liveWithExitGate();

      const restart = manager.restartReplOnly('dev-1');
      await vi.waitFor(() => expect(trace("'/exit'")).toHaveLength(1));

      await expect(manager.compactAgent('dev-1')).rejects.toThrow(/compact or upload already in progress/);
      const injection = manager.injectTextToAgent('dev-1', 'hello after restart');
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(runner.pastedPrompts).toEqual([]);

      exitGate.release();
      await restart;
      await injection;
      expect(runner.pastedPrompts).toEqual([{ pane: '%0', body: 'hello after restart' }]);
      const relaunchIdx = cmds().findIndex(c => c.includes('BX_SHELL_OK'));
      const pasteIdx = cmds().findIndex(c => c.includes('paste-buffer'));
      expect(relaunchIdx).toBeGreaterThanOrEqual(0);
      expect(pasteIdx).toBeGreaterThan(relaunchIdx);
    });

    it('a restart refuses while another pane write holds the mutex, and proceeds once it is released', async () => {
      await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%0', updatedAt: NOW });
      const pasteGate = gate();
      let gated = false;
      live({
        ackHoldCaptures: 1,
        onExec: async cmd => {
          if (gated || !cmd.includes('paste-buffer')) return;
          gated = true;
          await pasteGate.wait;
        },
      });

      const injection = manager.injectTextToAgent('dev-1', 'typed by hand');
      await vi.waitFor(() => expect(gated).toBe(true));
      const callsBefore = cmds().length;

      const refused = await manager.restartReplOnly('dev-1').catch(e => e);
      expect(refused).toBeInstanceOf(ApiError);
      expect((refused as ApiError).status).toBe(409);
      expect(cmds()).toHaveLength(callsBefore);

      pasteGate.release();
      await injection;
      expect(runner.pastedPrompts).toEqual([{ pane: '%0', body: 'typed by hand' }]);

      await manager.restartReplOnly('dev-1');
      expect(trace('BX_SHELL_OK')).toHaveLength(1);
    });

    it('a restart queues behind an in-flight session lifecycle operation (retry / delete) instead of interleaving with it', async () => {
      await agentStore.set({ id: 'dev-1', projectId: 'proj', paneId: '%0', updatedAt: NOW });
      const lifecycle = holdLifecycleAtProbe();
      const callsAtHold = await vi.waitFor(() => lifecycle.heldAt());

      const restart = manager.restartReplOnly('dev-1');
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(cmds()).toHaveLength(callsAtHold);
      // 排队期间 pane 互斥已被 restart 占住:compact 立即 409
      await expect(manager.compactAgent('dev-1')).rejects.toThrow(/already in progress/);

      lifecycle.release();
      await lifecycle.holder;
      await restart;
      expect(trace('BX_SHELL_OK')).toHaveLength(1);

      // 重启完成后互斥释放:注入不再等待
      await manager.injectTextToAgent('dev-1', 'after restart');
      expect(runner.pastedPrompts).toEqual([{ pane: '%0', body: 'after restart' }]);
    });

    it('releases the pane mutex when the restart fails, so later pane writes are not locked out', async () => {
      live({ session: 'absent' });
      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/does not exist/);
      // 第二次仍是同一个错误而不是 409:失败路径没有扣住 pane 互斥
      await expect(manager.restartReplOnly('dev-1')).rejects.toThrow(/does not exist/);
    });
  });

  describe('cleanupRemovedAgentRuntime failure aggregation', () => {
    it('skips the kill (warn only) when the session claim belongs to someone else', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      live({ agents: { 'dev-1': { claim: 'foreign-owner' } } });

      await manager.cleanupRemovedAgentRuntime(['dev-1']);

      expect(runner.sessions.present('dev-1')).toBe(true);
      expect(trace('kill-session')).toHaveLength(0);
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('not baxian-managed'))).toBe(true);
    });

    it('aggregates a tmux probe failure into CleanupFailedError', async () => {
      live({ rules: [{ match: 'list-sessions', reply: { stderr: 'socket exploded', exitCode: 2 } }] });
      try {
        await manager.cleanupRemovedAgentRuntime(['dev-1']);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CleanupFailedError);
        expect((err as CleanupFailedError).failures).toEqual([
          expect.objectContaining({ agentId: 'dev-1', step: 'tmux' }),
        ]);
      }
      expect(runner.sessions.present('dev-1')).toBe(true);
    });
  });
});
