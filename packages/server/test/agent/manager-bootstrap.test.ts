import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentManager, AgentManagerDeps } from '../../src/agent/manager.js';
import type { PhaseSignalWatcher } from '../../src/agent/phase-signal-watcher.js';
import { createManagerSuiteRunner, useManagerSuiteHarness, workdirsOf } from '../helpers/manager-harness.js';
import type { FakeRunner, FakeRunnerOptions } from '../helpers/fake-runner.js';

const NOW = '2026-05-14T05:00:00.000Z';
const TOKEN = 'token-abc';
// startup dialog:trust dialog 的自动应答管不到它,waitReplReady 只能超时 → dialogPending
const STARTUP_DIALOG = ' Enter to confirm · Esc to cancel\n';
const LAUNCH_REFUSED = 'launch refused by tmux';

const harness = useManagerSuiteHarness();

let runner: FakeRunner;
let onExec: ((cmd: string) => void | Promise<void>) | null;

function useRunner(options: FakeRunnerOptions = {}, deps: Partial<AgentManagerDeps> = {}): FakeRunner {
  runner = createManagerSuiteRunner({ workdirs: workdirsOf(harness.config), ...options, onExec: cmd => onExec?.(cmd) });
  harness.manager = makeManager(deps);
  return runner;
}

function makeManager(deps: Partial<AgentManagerDeps> = {}): AgentManager {
  return harness.createManager({ runnerFactory: () => runner, ...deps });
}

const cmds = (): string[] => runner.exec.mock.calls.map(c => String(c[0]));
const sawKill = (from = 0): boolean => cmds().slice(from).some(c => c.includes('kill-session'));
const pastedBodies = (): string[] => runner.pastedPrompts.map(p => p.body);
const eventTypes = (): string[] => harness.events.map(e => e.type);

// create 路径才是 bootstrap 的正常入口:会话还不存在
function withoutSession(): void {
  runner.sessions.drop('dev-1');
}

// 启动命令被 tmux 拒收:会话已建、runtime 没起来,是非对话框的硬失败
function launchFails(): FakeRunnerRule {
  return {
    match: c => c.includes('send-keys -l') && c.includes('claude'),
    reply: { exitCode: 1, stderr: LAUNCH_REFUSED },
  };
}
type FakeRunnerRule = NonNullable<FakeRunnerOptions['rules']>[number];

beforeEach(async () => {
  onExec = null;
  useRunner();
  withoutSession();
  await harness.seedAgent({ id: 'dev-1', creationToken: TOKEN, updatedAt: NOW });
});

describe('AgentManager.startBootstrapAsync', () => {
  it('success records paneId and clears the creation token', async () => {
    await harness.manager.startBootstrapAsync('dev-1', TOKEN);

    const pane = runner.sessions.pane('dev-1')!;
    expect(pane.process).toBe('claude');
    const state = await harness.agentStore.get('dev-1');
    expect(state).toMatchObject({ id: 'dev-1', projectId: 'proj', paneId: pane.id });
    expect(state?.creationToken).toBeUndefined();
    expect('status' in (state as object)).toBe(false);
    expect('sessionStatus' in (state as object)).toBe(false);
    expect(eventTypes()).toContain('agent.bootstrap_succeeded');
    // create 轨迹:新建会话 → identity-only 启动命令 → 抓屏确认 runtime 就绪
    const trace = cmds();
    expect(trace.findIndex(c => c.includes('new-session'))).toBeGreaterThanOrEqual(0);
    expect(trace.some(c => c.includes('send-keys -l') && c.includes('claude') && c.includes('BX_TARGET_GONE'))).toBe(true);
  });

  it('success clears stale dialog Held fields from an earlier pending bootstrap', async () => {
    await harness.agentStore.update('dev-1', state => state ? {
      ...state,
      status: 'awaiting_human',
      awaitingPhase: 'agent_dialog_pending',
      awaitingReason: 'startup dialog',
      awaitingSince: NOW,
    } : null);

    await harness.manager.startBootstrapAsync('dev-1', TOKEN);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.status).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    expect(state?.awaitingReason).toBeUndefined();
    expect(state?.awaitingSince).toBeUndefined();
  });

  it('hard failure clears the creation token and emits bootstrap_failed', async () => {
    useRunner({ rules: [launchFails()] });
    withoutSession();

    await harness.manager.startBootstrapAsync('dev-1', TOKEN);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.paneId).toBeUndefined();
    expect(state?.creationToken).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    expect(harness.events.some(e =>
      e.type === 'agent.bootstrap_failed' && String(e.data.error).includes(LAUNCH_REFUSED),
    )).toBe(true);
  });

  it('hard failure rolls back the created session by its generation-bound ref', async () => {
    useRunner({ rules: [launchFails()] });
    withoutSession();

    await harness.manager.startBootstrapAsync('dev-1', TOKEN);

    // 会话真的被拆掉了,不是只清了状态
    expect(sawKill()).toBe(true);
    expect(runner.sessions.present('dev-1')).toBe(false);
  });

  it('created-session hard failure: rollback not confirmed (refused) hands off the dialog hold instead of clearing over a live session', async () => {
    useRunner({ rules: [launchFails()] });
    withoutSession();
    // tmux 代次在 kill 之前变了:kill 被服务端条件拒绝,会话可能还活着
    onExec = c => { if (c.includes('kill-session')) runner.sessions.bumpGeneration('dev-1'); };

    await harness.manager.startBootstrapAsync('dev-1', TOKEN);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.creationToken).toBe(TOKEN);
    expect(state?.awaitingPhase).toBe('agent_dialog_pending');
    expect(runner.sessions.present('dev-1')).toBe(true);
    expect(eventTypes()).not.toContain('agent.bootstrap_failed');
  });

  it('a successor queued on the lifecycle lock during hard-failure rollback cannot resurrect the creation token', async () => {
    useRunner({ rules: [launchFails()] });
    withoutSession();
    // 后继在回滚 kill 还在跑时排队拿同一把生命周期锁;收尾与回滚同处一个临界区,后继只会看到已清空的 token
    let successor: Promise<void> | null = null;
    onExec = c => {
      if (successor || !c.includes('kill-session')) return;
      successor = harness.manager.startBootstrapAsync('dev-1', TOKEN);
    };

    await harness.manager.startBootstrapAsync('dev-1', TOKEN);
    await successor;

    expect(eventTypes()).toContain('agent.bootstrap_failed');
    expect((await harness.agentStore.get('dev-1'))?.creationToken).toBeUndefined();
  });

  it('hard failure with a rotated token leaves the session to its successor', async () => {
    useRunner({ rules: [launchFails()] });
    withoutSession();
    await harness.agentStore.update('dev-1', s => s ? { ...s, creationToken: 'token-newer' } : null);

    await harness.manager.startBootstrapAsync('dev-1', TOKEN);

    expect(sawKill()).toBe(false);
    expect(runner.sessions.present('dev-1')).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.creationToken).toBe('token-newer');
  });

  it('rollback stands down when the session was adopted after create', async () => {
    useRunner({ rules: [launchFails()] });
    withoutSession();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 真实接管:启动命令阶段排入一次 ensureSession,它在失败的 create 让出生命周期锁后 adopt 并 bump 代次
    let adopt: Promise<unknown> | null = null;
    onExec = c => {
      if (adopt || !c.includes('send-keys -l')) return;
      adopt = harness.manager.ensureSession('dev-1', 'runtime').catch(() => undefined);
    };

    await harness.manager.startBootstrapAsync('dev-1', TOKEN);
    await adopt;

    expect(sawKill()).toBe(false);
    expect(warn.mock.calls.some(c => String(c[0]).includes('session adopted since create'))).toBe(true);
    expect(runner.sessions.present('dev-1')).toBe(true);
    const state = await harness.agentStore.get('dev-1');
    expect(state?.creationToken).toBe(TOKEN);
    expect(eventTypes()).not.toContain('agent.bootstrap_failed');
  });

  it('skips rollback with the original failure visible when the agent store read rejects', async () => {
    useRunner({ rules: [launchFails()] });
    withoutSession();
    const realGet = harness.agentStore.get.bind(harness.agentStore);
    let armed = false;
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id: string) => {
      if (armed) { armed = false; throw new Error('EACCES: permission denied'); }
      return realGet(id);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onExec = c => { if (c.includes('send-keys -l')) armed = true; };

    await harness.manager.startBootstrapAsync('dev-1', TOKEN);

    expect(sawKill()).toBe(false);
    const storeSkip = warn.mock.calls.find(c => String(c[0]).includes('agent store read failed'));
    expect(storeSkip).toBeDefined();
    expect(String(storeSkip![1])).toContain('EACCES');
    expect(warn.mock.calls.some(c => String(c[0]).includes('creationToken rotated'))).toBe(false);
  });

  it('an in-flight ref kill is not retracted by a token rotation and can never reach a successor session', async () => {
    useRunner({ rules: [launchFails()] });
    withoutSession();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let gated = false;
    onExec = async c => {
      if (gated || !c.includes('kill-session')) return;
      gated = true;
      await harness.agentStore.update('dev-1', s => s ? { ...s, creationToken: 'token-successor' } : null);
      await gate;
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const bootstrap = harness.manager.startBootstrapAsync('dev-1', TOKEN);
    await vi.waitFor(() => expect(gated).toBe(true));
    release();
    await bootstrap;

    const kills = cmds().filter(c => c.includes('kill-session'));
    expect(kills).toHaveLength(1);
    // kill 绑定在创建时的那个会话 ref 上,轮转后的 token 既拦不住它,它也够不到后继会话
    expect(kills[0]).toContain('@baxian-agent-id');
    expect(runner.sessions.present('dev-1')).toBe(false);
  });

  it('leaves a created dialog-blocked session untouched when the token has rotated', async () => {
    useRunner({ agents: { 'dev-1': { trustDialog: STARTUP_DIALOG } } });
    withoutSession();
    await harness.agentStore.update('dev-1', s => s ? { ...s, creationToken: 'token-newer' } : null);

    await harness.manager.startBootstrapAsync('dev-1', TOKEN);

    expect(sawKill()).toBe(false);
    expect(runner.sessions.present('dev-1')).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.creationToken).toBe('token-newer');
  });

  it('dialog-pending bootstrap keeps the creation token and asks for human intervention', async () => {
    useRunner({ agents: { 'dev-1': { trustDialog: STARTUP_DIALOG } } });
    withoutSession();

    await harness.manager.startBootstrapAsync('dev-1', TOKEN);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.creationToken).toBe(TOKEN);
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('agent_dialog_pending');
    expect(harness.events.some(e =>
      e.type === 'human.intervention'
      && e.agentId === 'dev-1'
      && e.data.phase === 'agent_dialog_pending',
    )).toBe(true);
    expect(eventTypes()).not.toContain('agent.bootstrap_failed');
  });

  it('stale bootstrap completion cannot clear a newer creation token', async () => {
    await harness.agentStore.set({
      id: 'dev-1', projectId: 'proj', creationToken: 'token-new', updatedAt: NOW,
    });

    await harness.manager.startBootstrapAsync('dev-1', TOKEN);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.creationToken).toBe('token-new');
    expect(state?.paneId).toBeUndefined();
  });
});

describe('AgentManager greeting capability gate', () => {
  // 边界替身:watcher 是公共依赖,用例只决定它对 greeting 信号的判读
  function withWatcher(awaitOnce: ReturnType<typeof vi.fn>, deps: Partial<AgentManagerDeps> = {}): AgentManager {
    return makeManager({ phaseSignalWatcher: { awaitOnce } as unknown as PhaseSignalWatcher, ...deps });
  }

  const greetings = (): string[] => pastedBodies().filter(b => b.includes('[bx:greeting:'));

  it('goes ready and clears the creation token when the agent echoes a valid greeting', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('matched');
    const mgr = withWatcher(awaitOnce);

    await mgr.startBootstrapAsync('dev-1', TOKEN);

    const pane = runner.sessions.pane('dev-1')!;
    const state = await harness.agentStore.get('dev-1');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.status).toBeUndefined();
    expect(state?.paneId).toBe(pane.id);
    expect(eventTypes()).toContain('agent.bootstrap_succeeded');
    // 问候语真的投进了新建 pane,而不是只被“调用过”
    expect(runner.pastedPrompts).toEqual([{ pane: pane.id, body: expect.stringContaining('[bx:greeting:') }]);
    expect(awaitOnce).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'dev-1', kind: 'greeting' }));
  });

  it('holds the agent as awaiting_human (greeting_failed) when greeting never verifies', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('timeout');
    const mgr = withWatcher(awaitOnce);

    await mgr.startBootstrapAsync('dev-1', TOKEN);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('greeting_failed');
    expect(harness.events.some(e =>
      e.type === 'human.intervention' && e.data.phase === 'greeting_failed',
    )).toBe(true);
    expect(eventTypes()).not.toContain('agent.bootstrap_succeeded');
    expect(awaitOnce).toHaveBeenCalledTimes(2);
    expect(greetings()).toHaveLength(2);
    expect(await mgr.pickAgent('proj', 'dev-1')).toBeNull();
  });

  it('retries on session-gone (a transient subscribe fault must not fail a capable agent)', async () => {
    const awaitOnce = vi.fn()
      .mockResolvedValueOnce('session-gone')
      .mockResolvedValueOnce('matched');
    const mgr = withWatcher(awaitOnce);

    await mgr.startBootstrapAsync('dev-1', TOKEN);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.creationToken).toBeUndefined();
    expect(state?.status).toBeUndefined();
    expect(awaitOnce).toHaveBeenCalledTimes(2);
    expect(greetings()).toHaveLength(2);
  });

  it('does not wait for the signal when the greeting paste fails — it retries the paste', async () => {
    useRunner({ rules: [{ match: 'load-buffer', reply: { exitCode: 1, stderr: 'buffer load refused' } }] });
    withoutSession();
    const awaitOnce = vi.fn().mockResolvedValue('matched');
    const mgr = withWatcher(awaitOnce);

    await mgr.startBootstrapAsync('dev-1', TOKEN);

    expect((await harness.agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect(runner.execWithStdin.mock.calls.filter(c => String(c[0]).includes('load-buffer'))).toHaveLength(2);
    expect(runner.pastedPrompts).toEqual([]);
    expect(awaitOnce).not.toHaveBeenCalled();
  });

  it('holds without retrying when the greeting paste fails ack_unknown (unconfirmed composer)', async () => {
    // pane 在就绪判定之后转入 working:提交失败后不能碰 composer,只能交人工核验
    useRunner({
      rules: [{
        match: c => c.includes('BX_RUNTIME_OK') && c.includes('Enter'),
        reply: { exitCode: 1, stderr: 'enter dropped' },
      }],
    });
    withoutSession();
    // 第 1 次读标题是 create 的就绪判定,第 2 次是 pre-inject 取样:在它之前转 working
    let titleReads = 0;
    onExec = c => {
      if (!c.includes('pane_title')) return;
      if (++titleReads === 2) runner.sessions.markWorking('dev-1', '✻ Thinking… (3s · esc to interrupt)\n');
    };
    const awaitOnce = vi.fn().mockResolvedValue('matched');
    const mgr = withWatcher(awaitOnce);

    await mgr.startBootstrapAsync('dev-1', TOKEN);

    expect((await harness.agentStore.get('dev-1'))?.status).toBe('awaiting_human');
    expect(greetings()).toHaveLength(1);
    expect(awaitOnce).not.toHaveBeenCalled();
  });

  it('leaves the session untouched (no kill, no greeting_failed hold) when creationToken rotates mid-greeting', async () => {
    const mgr = withWatcher(vi.fn().mockResolvedValue('timeout'));
    await harness.agentStore.update('dev-1', s => s ? { ...s, creationToken: 'token-newer' } : null);

    await mgr.startBootstrapAsync('dev-1', TOKEN);

    expect(sawKill()).toBe(false);
    const state = await harness.agentStore.get('dev-1');
    expect(state?.creationToken).toBe('token-newer');
    expect(state?.awaitingPhase).not.toBe('greeting_failed');
  });

  it('leaves the session untouched when the token rotates between greeting success and the store write', async () => {
    const mgr = withWatcher(vi.fn().mockResolvedValue('matched'));
    await harness.agentStore.update('dev-1', s => s ? { ...s, creationToken: 'token-newer' } : null);

    await mgr.startBootstrapAsync('dev-1', TOKEN);

    expect(sawKill()).toBe(false);
    const state = await harness.agentStore.get('dev-1');
    expect(state?.creationToken).toBe('token-newer');
    expect(state?.paneId).toBeUndefined();
  });

  it('recover() preserves a greeting_failed hold instead of releasing it to ok', async () => {
    const mgr = withWatcher(vi.fn().mockResolvedValue('matched'));
    runner.sessions.seed('dev-1', { present: true });
    await harness.agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed',
      awaitingReason: 'cap fail', awaitingSince: NOW, updatedAt: NOW,
    });

    await mgr.recover();

    const state = await harness.agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('greeting_failed');
    expect(await mgr.pickAgent('proj', 'dev-1')).toBeNull();
  });

  it('recover() re-greets an incomplete bootstrap (creationToken set, no task) → ready on pass', async () => {
    const awaitOnce = vi.fn().mockResolvedValue('matched');
    const mgr = withWatcher(awaitOnce);
    await harness.agentStore.set({ id: 'dev-1', projectId: 'proj', creationToken: 'tok-crash', updatedAt: NOW });

    await mgr.recover();
    await vi.waitFor(async () => expect((await harness.agentStore.get('dev-1'))?.creationToken).toBeUndefined(),
      { timeout: 5_000 });

    expect((await harness.agentStore.get('dev-1'))?.status).toBeUndefined();
    expect(awaitOnce).toHaveBeenCalledWith(expect.objectContaining({ kind: 'greeting' }));
  });

  it('recover() holds an incomplete bootstrap that fails its re-greet', async () => {
    const mgr = withWatcher(vi.fn().mockResolvedValue('timeout'));
    await harness.agentStore.set({ id: 'dev-1', projectId: 'proj', creationToken: 'tok-crash', updatedAt: NOW });

    await mgr.recover();
    await vi.waitFor(async () => expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('greeting_failed'),
      { timeout: 5_000 });

    expect((await harness.agentStore.get('dev-1'))?.status).toBe('awaiting_human');
  });

  it('regreetHeldAgent clears the hold when the re-greet passes', async () => {
    const mgr = withWatcher(vi.fn().mockResolvedValue('matched'));
    runner.sessions.seed('dev-1', { present: true });
    await harness.agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW, updatedAt: NOW,
    });

    expect(await mgr.regreetHeldAgent('dev-1')).toBe(true);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.status).toBeUndefined();
    expect(state?.awaitingPhase).toBeUndefined();
    expect(greetings()).toHaveLength(1);
  });

  it('regreetHeldAgent keeps the hold when the re-greet fails', async () => {
    const mgr = withWatcher(vi.fn().mockResolvedValue('timeout'));
    runner.sessions.seed('dev-1', { present: true });
    await harness.agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW, updatedAt: NOW,
    });

    await mgr.regreetHeldAgent('dev-1');

    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('greeting_failed');
  });

  it('regreetHeldAgent does not clear a binding that was recreated mid-handshake (generation guard)', async () => {
    const awaitOnce = vi.fn().mockImplementation(async () => {
      await harness.agentStore.set({ id: 'dev-1', projectId: 'proj', creationToken: 'tok-new', updatedAt: 'LATER' });
      return 'matched';
    });
    const mgr = withWatcher(awaitOnce);
    runner.sessions.seed('dev-1', { present: true });
    await harness.agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW, updatedAt: NOW,
    });

    await mgr.regreetHeldAgent('dev-1');

    const state = await harness.agentStore.get('dev-1');
    expect(state?.creationToken).toBe('tok-new');
    expect(state?.awaitingPhase).toBeUndefined();
  });

  it('Resume refuses a greeting_failed hold — capability must be re-proven, not overridden', async () => {
    const mgr = withWatcher(vi.fn().mockResolvedValue('matched'));
    runner.sessions.seed('dev-1', { present: true });
    await harness.agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW, updatedAt: NOW,
    });

    const res = await mgr.resumeAgent('dev-1');

    expect(res.resumed).toBe(false);
    expect(res.reason).toMatch(/Restart REPL/);
    const state = await harness.agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('greeting_failed');
    expect(await mgr.pickAgent('proj', 'dev-1')).toBeNull();
  });

  it('a dialog-pending bootstrap does not overwrite a greeting_failed hold (no downgrade to a dialog phase)', async () => {
    useRunner({ agents: { 'dev-1': { trustDialog: STARTUP_DIALOG } } });
    withoutSession();
    const mgr = withWatcher(vi.fn());
    await harness.agentStore.set({
      id: 'dev-1', projectId: 'proj', creationToken: TOKEN,
      status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW, updatedAt: NOW,
    });

    await mgr.startBootstrapAsync('dev-1', TOKEN);

    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('greeting_failed');
  });

  it('reconcileFailedAgent preserves a greeting_failed hold on tmux-absent (does not wipe to idle)', async () => {
    const mgr = withWatcher(vi.fn());
    await harness.agentStore.set({
      id: 'dev-1', projectId: 'proj', paneId: '%0',
      status: 'awaiting_human', awaitingPhase: 'greeting_failed', awaitingSince: NOW, updatedAt: NOW,
    });

    expect(await mgr.reconcileFailedAgent('dev-1')).toBe(false);

    const state = await harness.agentStore.get('dev-1');
    expect(state?.status).toBe('awaiting_human');
    expect(state?.awaitingPhase).toBe('greeting_failed');
    expect(state?.paneId).toBe('%0');
    expect(await mgr.pickAgent('proj', 'dev-1')).toBeNull();
  });
});

describe('AgentManager binding gates', () => {
  it('blocks dispatch while an agent is being created', async () => {
    expect(await harness.manager.pickAgent('proj', 'dev-1')).toBeNull();
    expect(await harness.manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(false);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it('allows dispatch once creationToken is cleared and no task is bound', async () => {
    await harness.agentStore.set({ id: 'dev-1', projectId: 'proj', updatedAt: NOW });
    expect(await harness.manager.pickAgent('proj', 'dev-1')).toMatchObject({ id: 'dev-1' });
    expect(await harness.manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(true);
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe('task-1');
  });

  it('blocks dispatch while another task is bound', async () => {
    await harness.agentStore.set({ id: 'dev-1', projectId: 'proj', taskId: 'task-busy', updatedAt: NOW });
    expect(await harness.manager.pickAgent('proj', 'dev-1')).toBeNull();
    expect(await harness.manager.acquireAgentForTask('dev-1', 'task-1', 'develop')).toBe(false);
  });
});

describe('AgentManager.waitForBootstrapSettled', () => {
  it('resolves when creationToken clears', async () => {
    setTimeout(() => {
      void harness.agentStore.update('dev-1', state => state ? {
        ...state, creationToken: undefined, updatedAt: new Date().toISOString(),
      } : null);
    }, 10);

    await expect(harness.manager.waitForBootstrapSettled('dev-1', 500)).resolves.toBeUndefined();
  });

  it('resolves when the agent row is removed', async () => {
    setTimeout(() => { void harness.agentStore.delete('dev-1'); }, 10);

    await expect(harness.manager.waitForBootstrapSettled('dev-1', 500)).resolves.toBeUndefined();
  });

  it('throws when creationToken never clears', async () => {
    await expect(harness.manager.waitForBootstrapSettled('dev-1', 50)).rejects.toThrow(/timed out/);
  });
});

describe('dialog-pending slow poll (no hard-fail timeout)', () => {
  const realSetTimeout = globalThis.setTimeout;
  const realDateNow = Date.now;
  let simNow = 0;

  // 虚拟时钟:sleep 立即回调并推进 Date.now,5 s 轮询与 1 s 就绪窗口不再真等
  beforeEach(() => {
    simNow = realDateNow();
    Date.now = () => simNow;
    globalThis.setTimeout = ((fn: () => void, ms = 0) => {
      simNow += ms;
      return realSetTimeout(fn, 0);
    }) as unknown as typeof globalThis.setTimeout;
  });
  // 后台轮询是 fire-and-forget:删掉 agent 行让它自行收摊,再让出一个真实 tick,避免与 tempDir 清理抢时序
  afterEach(async () => {
    await harness.agentStore.delete('dev-1').catch(() => undefined);
    await new Promise(r => realSetTimeout(r, 20));
    Date.now = realDateNow;
    globalThis.setTimeout = realSetTimeout;
  });

  // E1: 生命周期锁的排队次序与 adoptGeneration 的代次窗口没有任何外部命令可挂钩 —— 接管在 ensureSession
  // 内部 bump 之后还要持锁干活,锁外没有可观察的时间点。这里只用私有访问“触发”交错,断言全部落在
  // agentStore 终态、harness.events 与 runner 轨迹上。
  function fakeTakeover(): { start: () => void; release: () => void; done: () => boolean } {
    let done = false;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const m = harness.manager as unknown as { adoptGeneration: Map<string, number>; runUnderSessionLifecycle: (id: string, fn: () => Promise<void>) => Promise<void> };
    return {
      start: () => {
        void m.runUnderSessionLifecycle('dev-1', async () => {
          m.adoptGeneration.set('dev-1', (m.adoptGeneration.get('dev-1') ?? 0) + 1);
          await gate;
          done = true;
        });
      },
      release: () => release(),
      done: () => done,
    };
  }

  // 结束轮询用的闸门:第 n 次 store 读把 token 换成别人的,循环按代次不符退出(不写盘,避免与 update 的 mutex 重入)
  function rotateTokenAtPoll(n: number, onFirstPoll?: () => void): { exhausted: () => boolean } {
    const realGet = harness.agentStore.get.bind(harness.agentStore);
    let polls = 0;
    const getSpy = vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id: string) => {
      polls++;
      if (polls === 1) onFirstPoll?.();
      const state = await realGet(id);
      if (polls < n || !state) return state;
      getSpy.mockRestore();
      return { ...state, creationToken: 'token-force-exit' };
    });
    return { exhausted: () => polls >= n };
  }

  // 等到退出闸门真的合上(spy 已还原)再断言,否则读到的是闸门伪造的 token
  async function drainPoll(loop: { exhausted: () => boolean }): Promise<void> {
    await vi.waitFor(() => expect(loop.exhausted()).toBe(true), { timeout: 5_000, interval: 1 });
    await new Promise(r => realSetTimeout(r, 20));
  }

  // 公共入口:create 撞上启动对话框 → 挂起 + 慢轮询接手
  async function bootstrapIntoSlowPoll(options: FakeRunnerOptions = {}): Promise<void> {
    useRunner({ agents: { 'dev-1': { trustDialog: STARTUP_DIALOG } }, ...options });
    withoutSession();
    await harness.seedAgent({ id: 'dev-1', creationToken: TOKEN, updatedAt: NOW });
    await harness.manager.startBootstrapAsync('dev-1', TOKEN);
    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBe('agent_dialog_pending');
  }

  const waitForEvent = (type: string): Promise<void> =>
    vi.waitFor(() => expect(eventTypes()).toContain(type), { timeout: 5_000, interval: 1 });

  const waitForState = (check: (s: Awaited<ReturnType<typeof harness.agentStore.get>>) => boolean): Promise<void> =>
    vi.waitFor(async () => expect(check(await harness.agentStore.get('dev-1'))).toBe(true), { timeout: 5_000, interval: 1 });

  async function expectHoldUntouched(): Promise<void> {
    const state = await harness.agentStore.get('dev-1');
    expect(state?.creationToken).toBe(TOKEN);
    expect(state?.awaitingPhase).toBe('agent_dialog_pending');
    expect(eventTypes()).not.toContain('agent.bootstrap_failed');
  }

  it('REPL exited to a shell → rolls back the dead session and clears the dialog hold so Retry/Resume can rebuild', async () => {
    await bootstrapIntoSlowPoll();
    runner.sessions.setProcess('dev-1', 'zsh');

    await waitForEvent('agent.bootstrap_failed');

    expect(eventTypes()).not.toContain('agent.bootstrap_succeeded');
    const state = await harness.agentStore.get('dev-1');
    expect(state?.awaitingPhase).toBeUndefined();
    expect(state?.status).toBeUndefined();
    // 残留的 shell 会话真的被拆了,不是留着挡住 Retry
    expect(runner.sessions.present('dev-1')).toBe(false);
  });

  it('a successor queued on the lifecycle lock during rollback is finalized against, not clobbered after', async () => {
    await bootstrapIntoSlowPoll();
    let successor: Promise<void> | null = null;
    onExec = c => {
      if (successor || !c.includes('kill-session')) return;
      successor = harness.manager.startBootstrapAsync('dev-1', TOKEN);
    };
    runner.sessions.setProcess('dev-1', 'zsh');

    await waitForEvent('agent.bootstrap_failed');
    await successor;

    expect((await harness.agentStore.get('dev-1'))?.creationToken).toBeUndefined();
  });

  it('a successor adopting during the readiness probe is not killed by the losing slow poll', async () => {
    await bootstrapIntoSlowPoll();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const takeover = fakeTakeover();
    // 接管落在这一轮的就绪探测中间:代次在 genAtProbe 读完之后才被 bump
    let started = false;
    onExec = c => {
      if (started || !c.includes('capture-pane')) return;
      started = true;
      takeover.start();
      realSetTimeout(takeover.release, 0);
    };
    runner.sessions.setProcess('dev-1', 'zsh');

    await vi.waitFor(
      () => expect(warn.mock.calls.some(c => String(c[0]).includes('session adopted since create'))).toBe(true),
      { timeout: 5_000, interval: 1 },
    );
    await expectHoldUntouched();
    expect(sawKill()).toBe(false);
    expect(runner.sessions.present('dev-1')).toBe(true);
  });

  it('a session ref replaced mid-probe (no panes match) is re-probed, not finalized as failed', async () => {
    // list-panes 空列表 = 旧 ref 已被替换,生产侧抛普通错误(不是 PaneGoneError),必须继续轮询
    let replaced = false;
    await bootstrapIntoSlowPoll({
      rules: [{ match: c => replaced && c.includes('list-panes'), reply: { stdout: '' } }],
    });
    replaced = true;
    const loop = rotateTokenAtPoll(4);

    await drainPoll(loop);
    expect(eventTypes()).not.toContain('agent.bootstrap_failed');
    expect(sawKill()).toBe(false);
  });

  it('a takeover already in flight when this poll samples (old session destroyed, new one not yet built) is not finalized as gone', async () => {
    // 旧会话已被后继销毁,新会话要等接管跑完才出现
    let rebuilding = false;
    const pending: { takeover?: ReturnType<typeof fakeTakeover> } = {};
    await bootstrapIntoSlowPoll({
      rules: [{
        match: c => rebuilding && c.includes('list-sessions'),
        reply: () => ({ stdout: pending.takeover?.done() ? '4242|1700000000|$2|dev-1\n' : '' }),
      }],
    });
    const takeover = fakeTakeover();
    pending.takeover = takeover;
    takeover.start();
    rebuilding = true;
    const loop = rotateTokenAtPoll(6);
    realSetTimeout(takeover.release, 15);

    await drainPoll(loop);
    await expectHoldUntouched();
    expect(sawKill()).toBe(false);
  });

  it.each([
    {
      label: 'refused (session ref changed / adopted)',
      arm: () => { onExec = c => { if (c.includes('kill-session')) runner.sessions.bumpGeneration('dev-1'); }; },
    },
    {
      label: 'unknown (SSH connection reset)',
      arm: () => { /* rule 已在 runner 上 */ },
    },
  ])('session teardown $label → keeps the dialog hold and re-probes instead of clearing state over a live session', async ({ label, arm }) => {
    const rules = label.startsWith('unknown')
      ? [{ match: 'kill-session', reply: { exitCode: 255, stderr: 'Connection reset by peer' } }]
      : [];
    await bootstrapIntoSlowPoll({ rules });
    arm();
    runner.sessions.setProcess('dev-1', 'zsh');
    const loop = rotateTokenAtPoll(6);

    await drainPoll(loop);
    expect(eventTypes()).not.toContain('agent.bootstrap_failed');
    expect(sawKill()).toBe(true);
  });

  it('kill applied but response lost (unknown) → next cycle sees the session gone and finalizes', async () => {
    await bootstrapIntoSlowPoll({
      rules: [{ match: 'kill-session', reply: { exitCode: 255, stderr: 'Connection reset by peer' } }],
    });
    // 远端确实执行了 kill,只是回包丢了:结果未知,但会话已经没了
    onExec = c => { if (c.includes('kill-session')) runner.sessions.drop('dev-1'); };
    runner.sessions.setProcess('dev-1', 'zsh');

    await waitForEvent('agent.bootstrap_failed');

    expect((await harness.agentStore.get('dev-1'))?.awaitingPhase).toBeUndefined();
  });

  it('does not roll back or fail when the creation token was already rotated to a successor', async () => {
    await bootstrapIntoSlowPoll();
    const killsBefore = cmds().filter(c => c.includes('kill-session')).length;
    await harness.agentStore.update('dev-1', s => s ? { ...s, creationToken: 'token-newer' } : null);
    runner.sessions.setProcess('dev-1', 'zsh');

    await new Promise(r => realSetTimeout(r, 50));

    expect(eventTypes()).not.toContain('agent.bootstrap_failed');
    expect(cmds().filter(c => c.includes('kill-session'))).toHaveLength(killsBefore);
    expect((await harness.agentStore.get('dev-1'))?.creationToken).toBe('token-newer');
  });

  it('exits when the agentStore record is deleted (DELETE path collapses the loop)', async () => {
    await bootstrapIntoSlowPoll();
    const realGet = harness.agentStore.get.bind(harness.agentStore);
    let polls = 0;
    vi.spyOn(harness.agentStore, 'get').mockImplementation(async (id: string) => {
      polls++;
      if (polls === 2) await harness.agentStore.delete('dev-1');
      return realGet(id);
    });

    await vi.waitFor(() => expect(polls).toBeGreaterThanOrEqual(2), { timeout: 5_000, interval: 1 });
    await new Promise(r => realSetTimeout(r, 30));

    expect(polls).toBeLessThan(10);
    expect(eventTypes()).not.toContain('agent.bootstrap_failed');
    expect(eventTypes()).not.toContain('agent.bootstrap_succeeded');
  });

  it('no longer hard-fails while the session cannot be probed (transient), dialog unresolved', async () => {
    // 瞬时探测失败(非 PaneGoneError)必须继续轮询,不能按时间预算硬失败
    let transient = false;
    await bootstrapIntoSlowPoll({
      rules: [{
        match: c => transient && c.includes('list-sessions'),
        reply: { exitCode: 255, stderr: 'Connection reset by peer' },
      }],
    });
    transient = true;
    const loop = rotateTokenAtPoll(200);

    await drainPoll(loop);
    await expectHoldUntouched();
    expect(eventTypes()).not.toContain('agent.bootstrap_succeeded');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(false);
  });

  it.each([false, true])('runtime path: recovers a dialog after the tmux pane was recreated (delayed event: %s)', async delayedEvent => {
    let release!: () => void;
    const delivery = new Promise<void>(resolve => { release = resolve; });
    const emit = harness.eventBus.emit.bind(harness.eventBus);
    if (delayedEvent) {
      vi.spyOn(harness.eventBus, 'emit').mockImplementation(async event => {
        if (event.type === 'human.intervention' && event.data.phase === 'agent_dialog_resolved_runtime') await delivery;
        return emit(event);
      });
    }
    try {
      useRunner({ agents: { 'dev-1': { screen: STARTUP_DIALOG } } });
      const task = await harness.seedTask({ id: 'task-1', status: 'in_progress', signalToken: 'devtok123456' });
      // 存下来的 paneId 已经过期:真实 pane 由 claim 重新发现
      await harness.seedAgent({ id: 'dev-1', taskId: task.id, paneId: '%9' });
      await harness.acquireAgentLock('dev-1', task.id);

      await expect(harness.manager.startSession(task.id, 'dev-1', 'develop')).rejects.toMatchObject({
        partial: { dialogPending: true },
      });
      await waitForState(s => s?.awaitingPhase === 'agent_dialog_pending');

      // 运维在 web terminal 里把对话框点掉了:pane 回到正常的 runtime idle 帧
      runner.sessions.seed('dev-1', { present: true });

      await waitForState(s => s?.awaitingPhase === 'agent_dialog_resolved_runtime');
      const state = await harness.agentStore.get('dev-1');
      expect(state?.paneId).toBe('%0');
      expect(state?.awaitingReason).toContain('cancel it if it is still active');
      release();
      await vi.waitFor(() => {
        const intervention = harness.events.find(e =>
          e.type === 'human.intervention'
          && e.taskId === task.id
          && (e.data as { phase?: string }).phase === 'agent_dialog_resolved_runtime',
        );
        expect(intervention?.data.note).toContain('cancel it if it is still active');
      }, { timeout: 5_000, interval: 1 });
    } finally {
      release();
    }
  });
});
