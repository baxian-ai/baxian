import { describe, it, expect } from 'vitest';
import {
  PaneGoneError,
  TmuxManager,
  TmuxOutcomeUnknownError,
  hasRuntimeReadyView,
  type AgentRuntimeKind,
  type PaneRef,
} from '../../src/agent/tmux.js';
import { classifyScreen } from '../../src/agent/detect/classify.js';
import { fakeRunner, RUNTIME_PROFILES, type FakeRunner, type FakeRunnerOptions } from './fake-runner.js';
import { launchCommandIn } from '../../src/agent/manager.js';
import { makeAgent } from './fixtures.js';

const REF = { sessionId: '$1', serverPid: '4242', serverStart: '1700000000' };
const QA_REF = { ...REF, sessionId: '$2' };
const DEV: PaneRef = { session: REF, paneId: '%0', claim: 'dev-1' };
const QA: PaneRef = { session: QA_REF, paneId: '%1', claim: 'qa-1' };
const FAST = { timeoutMs: 300, intervalMs: 20 };
const stripHistory = (snapshot: string): string => snapshot.replace(/\n---history_size:\d+---$/, '');

function setup(options: FakeRunnerOptions = {}) {
  const runner = fakeRunner(options);
  const tmux = new TmuxManager(runner);
  const cmds = (): string[] => runner.exec.mock.calls.map(c => c[0] as string);
  return { runner, tmux, cmds };
}

async function stageAndPaste(tmux: TmuxManager, pane: PaneRef, runtime: AgentRuntimeKind, body: string): Promise<string> {
  const { buf } = await tmux.stagePromptBuffer(pane.paneId, body, pane.claim);
  await tmux.pasteStagedBuffer(pane, buf, runtime);
  return buf;
}

describe('fake runner: runtime frames pass the real classifier', () => {
  it.each(['claude-code', 'codex', 'opencode', 'qodercli'] as const)('%s idle/working/shell frames', (runtime) => {
    const profile = RUNTIME_PROFILES[runtime];
    expect(hasRuntimeReadyView(profile.idleFrame('/tmp/repo'), runtime)).toBe(true);
    expect(classifyScreen(runtime, profile.workingFrame).state).toBe('working');
    expect(hasRuntimeReadyView('$ ', runtime)).toBe(false);
    if (profile.workingTitle !== null) expect(classifyScreen(runtime, '', profile.workingTitle).state).toBe('working');
  });
});

describe('fake runner: delivery state machine', () => {
  it('load → paste → Enter records exactly one delivery and turns the pane working, then idles after the hold', async () => {
    const { runner, tmux } = setup({ ackHoldCaptures: 2 });
    const baselineBefore = await tmux.capturePaneById(DEV, { runtime: 'claude-code' });
    await stageAndPaste(tmux, DEV, 'claude-code', 'hello world');
    const pasted = await tmux.capturePaneById(DEV, { runtime: 'claude-code' });
    expect(pasted).toContain('hello world');
    expect(pasted).not.toBe(baselineBefore);
    expect(runner.pastedPrompts).toEqual([{ pane: '%0', body: 'hello world' }]);
    await tmux.sendEnter(DEV, 'claude-code');
    const view = runner.sessions.pane('dev-1')!;
    expect(view.phase).toBe('working');
    expect(view.title).toBe(RUNTIME_PROFILES['claude-code'].workingTitle);
    await tmux.capturePaneById(DEV, { runtime: 'claude-code' });
    await tmux.capturePaneById(DEV, { runtime: 'claude-code' });
    expect(runner.sessions.pane('dev-1')!.phase).toBe('idle');
    expect(runner.sessions.pane('dev-1')!.title).toBe(RUNTIME_PROFILES['claude-code'].idleTitle);
  });

  it.each([
    ['only load, never paste', async ({ tmux }: ReturnType<typeof setup>) => {
      await tmux.stagePromptBuffer('%0', 'p', 'dev-1');
      await tmux.sendEnter(DEV, 'claude-code');
    }],
    ['load, drop the session, then paste → can\'t find session', async ({ tmux, runner }: ReturnType<typeof setup>) => {
      const { buf } = await tmux.stagePromptBuffer('%0', 'p', 'dev-1');
      runner.sessions.drop('dev-1');
      await expect(tmux.pasteStagedBuffer(DEV, buf, 'claude-code')).rejects.toThrow(PaneGoneError);
    }],
    ['staged buffer deleted while the pane lives → no buffer, not a gone pane', async ({ tmux }: ReturnType<typeof setup>) => {
      const { buf } = await tmux.stagePromptBuffer('%0', 'p', 'dev-1');
      await tmux.dropStagedBuffer(buf);
      await expect(tmux.pasteStagedBuffer(DEV, buf, 'claude-code')).rejects.toThrow(/no buffer/);
    }],
    ['claim changes before paste → REFUSED|0 → PaneGoneError', async ({ tmux, runner }: ReturnType<typeof setup>) => {
      const { buf } = await tmux.stagePromptBuffer('%0', 'p', 'dev-1');
      runner.sessions.reclaim('dev-1', 'someone-else');
      await expect(tmux.pasteStagedBuffer(DEV, buf, 'claude-code')).rejects.toThrow(/identity condition failed/);
    }],
    ['generation changes before paste → PaneGoneError', async ({ tmux, runner }: ReturnType<typeof setup>) => {
      const { buf } = await tmux.stagePromptBuffer('%0', 'p', 'dev-1');
      runner.sessions.bumpGeneration('dev-1');
      await expect(tmux.pasteStagedBuffer(DEV, buf, 'claude-code')).rejects.toThrow(PaneGoneError);
    }],
    ['paste succeeded, session dropped before Enter → Enter is gone, no working', async ({ tmux, runner }: ReturnType<typeof setup>) => {
      await stageAndPaste(tmux, DEV, 'claude-code', 'p');
      runner.pastedPrompts.length = 0;
      runner.sessions.drop('dev-1');
      await expect(tmux.sendEnter(DEV, 'claude-code')).rejects.toThrow(PaneGoneError);
    }],
    ['empty composer Enter is a no-op', async ({ tmux }: ReturnType<typeof setup>) => {
      await tmux.sendEnter(DEV, 'claude-code');
    }],
    ['load exits non-zero', async ({ tmux }: ReturnType<typeof setup>) => {
      await expect(tmux.stagePromptBuffer('%0', 'p', 'dev-1')).rejects.toThrow();
    }],
    ['not-applied-lost paste', async ({ tmux }: ReturnType<typeof setup>) => {
      const { buf } = await tmux.stagePromptBuffer('%0', 'p', 'dev-1');
      await expect(tmux.pasteStagedBuffer(DEV, buf, 'claude-code')).rejects.toThrow();
    }],
    ['refused paste', async ({ tmux }: ReturnType<typeof setup>) => {
      const { buf } = await tmux.stagePromptBuffer('%0', 'p', 'dev-1');
      await expect(tmux.pasteStagedBuffer(DEV, buf, 'claude-code')).rejects.toThrow(/withheld/);
    }],
    ['target pane does not exist', async ({ tmux }: ReturnType<typeof setup>) => {
      const { buf } = await tmux.stagePromptBuffer('%0', 'p', 'dev-1');
      await expect(tmux.pasteStagedBuffer({ ...DEV, paneId: '%9' }, buf, 'claude-code')).rejects.toThrow(/can't find pane/);
    }],
  ])('no side effects: %s', async (name, run) => {
    const rules = name.startsWith('load exits') ? [{ match: 'load-buffer', reply: { exitCode: 1, stderr: 'boom' } }]
      : name.startsWith('not-applied-lost') ? [{ match: 'paste-buffer', reply: { outcome: 'not-applied-lost' as const } }]
      : name.startsWith('refused paste') ? [{ match: 'paste-buffer', reply: { outcome: 'refused' as const } }]
      : [];
    const ctx = setup({ rules });
    await run(ctx);
    const view = ctx.runner.sessions.pane('dev-1');
    expect(ctx.runner.pastedPrompts).toEqual([]);
    if (view) {
      expect(view.phase).not.toBe('working');
      expect(view.composer === '' || name.startsWith('paste succeeded')).toBe(true);
    }
  });

  it('pastes into another live, matching pane and records that pane, never the intended one', async () => {
    const { runner, tmux } = setup();
    const { buf } = await tmux.stagePromptBuffer('%0', 'leak', 'dev-1');
    await tmux.pasteStagedBuffer(QA, buf, 'codex');
    expect(runner.pastedPrompts).toEqual([{ pane: '%1', body: 'leak' }]);
    expect(runner.sessions.pane('qa-1')!.composer).toBe('leak');
    expect(runner.sessions.pane('dev-1')!.composer).toBe('');
    await tmux.sendEnter(DEV, 'claude-code');
    expect(runner.sessions.pane('dev-1')!.phase).toBe('idle');
  });

  it('records the composer in the capture baseline and only accepts a title change when the body self-matches working', async () => {
    // 空标题:有标题规则的 runtime 只有在标题不能作证 idle 时,粘贴正文才会让基线自匹配 working
    const { runner, tmux } = setup({ agents: { 'dev-1': { title: '' } }, rules: [{ match: /send-keys -t %0 .*Enter/, reply: { titleOnSubmit: 'unchanged' } }] });
    const body = 'note:\n✻ Thinking… (3s · esc to interrupt)';
    await stageAndPaste(tmux, DEV, 'claude-code', body);
    const baseline = await tmux.captureSettledSnapshot(DEV, { timeoutMs: 100, intervalMs: 20, runtime: 'claude-code' });
    expect(baseline).toContain(body);
    expect(classifyScreen('claude-code', stripHistory(baseline)).state).toBe('working');
    const baselineTitle = await tmux.readPaneTitle(DEV);
    await tmux.sendEnter(DEV, 'claude-code');
    await expect(tmux.waitSubmitAck(DEV, baseline, 'claude-code', { ...FAST, baselineTitle }))
      .rejects.toThrow(/baseline already matched a working rule/);
    expect(runner.sessions.pane('dev-1')!.title).toBe('');
  });

  it.each(['claude-code', 'codex'] as const)('%s: a self-matching body acks through the working title', async (runtime) => {
    const pane = runtime === 'codex' ? QA : DEV;
    const { tmux } = setup({ ackHoldCaptures: Infinity, agents: { [pane.claim]: { title: '' } } });
    const body = runtime === 'codex' ? 'note:\n• Working (3s • esc to interrupt)' : 'note:\n✻ Thinking… (3s · esc to interrupt)';
    await stageAndPaste(tmux, pane, runtime, body);
    const baseline = await tmux.captureSettledSnapshot(pane, { timeoutMs: 100, intervalMs: 20, runtime });
    expect(classifyScreen(runtime, stripHistory(baseline)).state).toBe('working');
    const baselineTitle = await tmux.readPaneTitle(pane);
    await tmux.sendEnter(pane, runtime);
    await expect(tmux.waitSubmitAck(pane, baseline, runtime, { ...FAST, baselineTitle })).resolves.toBeUndefined();
  });

  it.each(['opencode', 'qodercli'] as const)('%s: no title rule, a self-matching body can never ack', async (runtime) => {
    const { tmux } = setup({ agents: { 'dev-1': { runtime } }, ackHoldCaptures: Infinity });
    const body = runtime === 'opencode' ? 'Thinking… esc to interrupt' : '⠋ Thinking (esc to cancel, 3s)';
    await stageAndPaste(tmux, DEV, runtime, body);
    const baseline = await tmux.captureSettledSnapshot(DEV, { timeoutMs: 100, intervalMs: 20, runtime });
    expect(classifyScreen(runtime, stripHistory(baseline)).state).toBe('working');
    const baselineTitle = await tmux.readPaneTitle(DEV);
    await tmux.sendEnter(DEV, runtime);
    await expect(tmux.waitSubmitAck(DEV, baseline, runtime, { ...FAST, baselineTitle })).rejects.toThrow(/runtime ack timeout/);
  });

  it('plain body acks on the working screen alone', async () => {
    const { tmux } = setup({ ackHoldCaptures: Infinity });
    await stageAndPaste(tmux, DEV, 'claude-code', 'please refactor');
    const baseline = await tmux.captureSettledSnapshot(DEV, { timeoutMs: 100, intervalMs: 20, runtime: 'claude-code' });
    const baselineTitle = await tmux.readPaneTitle(DEV);
    await tmux.sendEnter(DEV, 'claude-code');
    await expect(tmux.waitSubmitAck(DEV, baseline, 'claude-code', { ...FAST, baselineTitle })).resolves.toBeUndefined();
  });

  it('title lifecycle: ack → hold expires → waitReplReady → second delivery acks again; sticky title blocks readiness', async () => {
    const { runner, tmux } = setup({ ackHoldCaptures: 2 });
    await stageAndPaste(tmux, DEV, 'claude-code', 'one');
    const baseline = await tmux.captureSettledSnapshot(DEV, { timeoutMs: 100, intervalMs: 20, runtime: 'claude-code' });
    const title1 = await tmux.readPaneTitle(DEV);
    await tmux.sendEnter(DEV, 'claude-code');
    await tmux.waitSubmitAck(DEV, baseline, 'claude-code', { ...FAST, baselineTitle: title1 });
    await expect(tmux.waitReplReady(DEV, 'claude-code', { ...FAST, titleIdleFastPath: true })).resolves.toBeUndefined();
    await stageAndPaste(tmux, DEV, 'claude-code', 'two');
    const baseline2 = await tmux.captureSettledSnapshot(DEV, { timeoutMs: 100, intervalMs: 20, runtime: 'claude-code' });
    const title2 = await tmux.readPaneTitle(DEV);
    await tmux.sendEnter(DEV, 'claude-code');
    await expect(tmux.waitSubmitAck(DEV, baseline2, 'claude-code', { ...FAST, baselineTitle: title2 })).resolves.toBeUndefined();
    expect(runner.pastedPrompts.map(p => p.body)).toEqual(['one', 'two']);

    const sticky = setup({ ackHoldCaptures: 2, rules: [{ match: /send-keys -t %0 .*Enter/, reply: { titleHold: 'sticky' } }] });
    await stageAndPaste(sticky.tmux, DEV, 'claude-code', 'stuck');
    await sticky.tmux.sendEnter(DEV, 'claude-code');
    await sticky.tmux.capturePaneById(DEV, { runtime: 'claude-code' });
    await sticky.tmux.capturePaneById(DEV, { runtime: 'claude-code' });
    expect(sticky.runner.sessions.pane('dev-1')!.phase).toBe('idle');
    await expect(sticky.tmux.waitReplReady(DEV, 'claude-code', { ...FAST, titleIdleFastPath: true })).rejects.toThrow(/not ready|ReplNotReady|paneTitle/);
  });
});

describe('fake runner: guard classes', () => {
  it('identity-only launch write reaches a shell pane and turns it into the runtime; the runtime-guarded twin is refused', async () => {
    const { runner, tmux } = setup({ agents: { 'dev-1': { process: 'zsh' } } });
    await expect(tmux.sendKeysLiteral(DEV, 'x', 'claude-code')).rejects.toThrow(/a shell, not claude-code/);
    await tmux.sendKeysLiteral(DEV, "cd '/tmp/repo' && env CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions");
    await tmux.sendEnter(DEV);
    const view = runner.sessions.pane('dev-1')!;
    expect(view.process).toBe('claude');
    expect(view.phase).toBe('idle');
  });

  it('every runtime-guarded public write is withheld on a shell pane, with no buffer, composer or pane side effect', async () => {
    const { runner, tmux } = setup({ agents: { 'dev-1': { process: 'zsh' } } });
    const { buf } = await tmux.stagePromptBuffer('%0', 'prompt body', 'dev-1');

    await expect(tmux.pasteStagedBuffer(DEV, buf, 'claude-code')).rejects.toThrow(/a shell, not claude-code/);
    await expect(tmux.sendEnter(DEV, 'claude-code')).rejects.toThrow(/a shell, not claude-code/);
    await expect(tmux.sendKeysToRuntime(DEV, 'claude-code', 'C-c')).rejects.toThrow(/a shell, not claude-code/);

    const refusals = runner.exec.mock.calls
      .map(c => c[0] as string)
      .length;
    expect(refusals).toBeGreaterThan(0);
    expect(runner.pastedPrompts).toEqual([]);
    expect(runner.sessions.pane('dev-1')).toMatchObject({ process: 'zsh', phase: 'shell', composer: '' });
    // buffer 没被消费:它仍在,paste 一次到合法 pane 就能取出
    await tmux.pasteStagedBuffer(QA, buf, 'codex');
    expect(runner.pastedPrompts).toEqual([{ pane: '%1', body: 'prompt body' }]);
  });

  it('a top-level command whose reply is lost before reaching the server changes nothing', async () => {
    const { runner, tmux } = setup({ rules: [{ match: 'delete-buffer', reply: { outcome: 'not-applied-lost' } }] });
    const { buf } = await tmux.stagePromptBuffer('%0', 'body', 'dev-1');

    await expect(tmux.dropStagedBuffer(buf)).rejects.toThrow();

    // buffer 必须还在:调用方据此区分"没删掉"和"删了但回包丢了"
    await tmux.pasteStagedBuffer(DEV, buf, 'claude-code');
    expect(runner.pastedPrompts).toEqual([{ pane: '%0', body: 'body' }]);
  });

  it('a shell pane stays a shell when Enter submits something that is not a launch command', async () => {
    const { runner, tmux } = setup({ agents: { 'dev-1': { process: 'zsh' } } });
    await tmux.sendKeysLiteral(DEV, 'ls');
    await tmux.sendEnter(DEV);
    expect(runner.sessions.pane('dev-1')!.process).toBe('zsh');
  });

  it('identity change makes identity-only writes fail as BX_TARGET_GONE with no side effects', async () => {
    const { runner, tmux } = setup({ agents: { 'dev-1': { process: 'zsh' } } });
    runner.sessions.bumpGeneration('dev-1');
    await expect(tmux.sendKeysLiteral(DEV, 'claude')).rejects.toThrow(/identity condition failed/);
    await expect(tmux.sendKeysToPane(DEV, 'Down')).rejects.toThrow(PaneGoneError);
    expect(runner.sessions.pane('dev-1')!.composer).toBe('');
  });

  it('pane deleted while the session lives is a plain command error, not PaneGoneError', async () => {
    const { runner, tmux } = setup();
    runner.sessions.dropPane('dev-1', '%0');
    await expect(tmux.sendKeysToPane(DEV, 'Enter')).rejects.toThrow(/can't find pane: %0/);
    await tmux.sendKeysToPane(DEV, 'Enter').catch(err => expect(err).not.toBeInstanceOf(PaneGoneError));
    const dropped = setup();
    dropped.runner.sessions.drop('dev-1');
    await expect(dropped.tmux.sendKeysToPane(DEV, 'Enter')).rejects.toThrow(PaneGoneError);
  });

  it('session-level writes and kills check generation, session id and claim; a same-claim successor is untouched', async () => {
    const { runner, tmux } = setup();
    const stale = { ...REF, serverPid: '1' };
    expect(await tmux.setSessionOptionsIfAlive(stale, [['@x', '1']], { expectedClaim: 'dev-1' })).toBe('gone');
    expect(runner.sessions.option('dev-1', '@x')).toBeUndefined();
    expect(await tmux.killSessionRef(stale, { kind: 'equals', claim: 'dev-1' })).toBe('refused');
    expect(runner.sessions.present('dev-1')).toBe(true);
    expect(await tmux.killSessionRef({ ...REF, sessionId: '$7' }, { kind: 'equals', claim: 'dev-1' })).toBe('absent');
    expect(await tmux.setSessionOptionsIfAlive(REF, [['@x', '1']], { expectedClaim: 'dev-1' })).toBe('applied');
    expect(runner.sessions.option('dev-1', '@x')).toBe('1');
    expect(await tmux.killSessionRef(REF, { kind: 'equals', claim: 'dev-1' })).toBe('killed');
    expect(runner.sessions.present('dev-1')).toBe(false);
    expect(runner.sessions.present('qa-1')).toBe(true);
  });

  it('list-panes honours the session filter: old generation, other session id or a changed claim yield no pane', async () => {
    const { runner, tmux } = setup();
    await expect(tmux.getSinglePaneByRef(REF, 'dev-1')).resolves.toMatchObject({ paneId: '%0' });
    await expect(tmux.getSinglePaneByRef({ ...REF, serverStart: '1' }, 'dev-1')).rejects.toThrow(/no panes match/);
    await expect(tmux.getSinglePaneByRef({ ...REF, sessionId: '$3' }, 'dev-1')).rejects.toThrow(/no panes match/);
    runner.sessions.reclaim('dev-1', 'other');
    await expect(tmux.getSinglePaneByRef(REF, 'dev-1')).rejects.toThrow(/no panes match/);
  });

  it('session options: seeded values read back, unset reads null, clearing reads null', async () => {
    const { tmux, runner } = setup({ agents: { 'dev-1': { options: { '@baxian-context-task-id': 't1' } } } });
    expect(await tmux.getSessionOptionByRef(REF, 'dev-1', '@baxian-context-task-id')).toBe('t1');
    expect(await tmux.getSessionOptionByRef(QA_REF, 'qa-1', '@baxian-context-task-id')).toBeNull();
    await tmux.setSessionOptionsIfAlive(REF, [['@baxian-context-task-id', '']], { expectedClaim: 'dev-1' });
    expect(await tmux.getSessionOptionByRef(REF, 'dev-1', '@baxian-context-task-id')).toBeNull();
    runner.sessions.seed('dev-1', { options: { '@baxian-context-task-id': 't2' } });
    expect(await tmux.getSessionOptionByRef(REF, 'dev-1', '@baxian-context-task-id')).toBe('t2');
  });
});

describe('fake runner: boundary semantics that must not be faked away', () => {
  it('resolves a session target by its ref alone: a foreign claim is refused, never redirected to the matching session', async () => {
    const { runner, tmux } = setup();
    const devRef = (await tmux.getSessionSnapshot('dev-1'))!.ref;
    const qaRef = (await tmux.getSessionSnapshot('qa-1'))!.ref;
    expect(devRef.sessionId).not.toBe(qaRef.sessionId);

    expect(await tmux.setSessionOptionsIfAlive(devRef, [['@probe', 'leak']], { expectedClaim: 'qa-1' })).toBe('gone');

    expect(runner.sessions.option('dev-1', '@probe')).toBeUndefined();
    expect(runner.sessions.option('qa-1', '@probe')).toBeUndefined();
    expect(await tmux.killSessionRef(devRef, { kind: 'equals', claim: 'qa-1' })).toBe('refused');
    expect(runner.sessions.present('dev-1')).toBe(true);
    expect(runner.sessions.present('qa-1')).toBe(true);
  });

  it('gives a third agent its own pane id, so pane lookups never resolve to another session', async () => {
    const { runner, tmux } = setup({ agents: { 'dev-2': {} } });
    const devRef = (await tmux.getSessionSnapshot('dev-1'))!.ref;
    const dev2Ref = (await tmux.getSessionSnapshot('dev-2'))!.ref;

    const devPane = await tmux.getSinglePaneByRef(devRef, 'dev-1');
    const dev2Pane = await tmux.getSinglePaneByRef(dev2Ref, 'dev-2');
    expect(dev2Pane.paneId).not.toBe(devPane.paneId);

    // 往 dev-2 的 pane 写入只能落在 dev-2 上:pane id 若与 dev-1 撞号,paneOwner 会按插入顺序解析到 dev-1
    await tmux.sendKeysLiteral(dev2Pane, 'hello', 'claude-code');
    expect(runner.sessions.pane('dev-2')!.composer).toBe('hello');
    expect(runner.sessions.pane('dev-1')!.composer).toBe('');

    expect(() => fakeRunner({ agents: { 'dev-1': { paneId: '%0' }, 'dev-2': { paneId: '%0' } } }))
      .toThrow(/pane id %0 already taken/);
  });

  it('a rejected seed leaves the id registry untouched, so the next create still gets a free pane', async () => {
    const { runner, tmux } = setup();

    // 撞号的 seed 必须整体失败:旧会话还在模型里,它占的 id 就不能被释放
    expect(() => runner.sessions.seed('dev-1', { paneId: '%1' })).toThrow(/pane id %1 already taken/);

    const ref = await tmux.createSession('dev-2', '/tmp/after-rejection');
    await tmux.setSessionOptionsIfAlive(ref, [['@baxian-agent-id', 'dev-2']], { expectedClaim: '' });
    const pane = await tmux.getSinglePaneByRef(ref, 'dev-2');

    // 新 pane 不能与被拒绝的 seed 里那两个会话撞号,否则 paneOwner 会解析到旧 dev-1
    expect(await tmux.getPaneCurrentPath(pane)).toBe('/tmp/after-rejection');
    const devRef = (await tmux.getSessionSnapshot('dev-1'))!.ref;
    expect(await tmux.getPaneCurrentPath(await tmux.getSinglePaneByRef(devRef, 'dev-1'))).toBe('/tmp/repo');
  });

  // 真实 tmux 用 getopt 解析 send-keys:选项到第一个非选项参数(或 --)为止。选项区里的 '-l' 正文会被当成
  // 又一个 -l 选项吞掉,其后的才是正文。生产侧总是发 --(task-055),这里钉的是 fake 对两种形状都与真实一致
  it.each([
    ["send-keys -l -t %0 '-l'", ''],
    ["send-keys -l -t %0 'hello' '-l'", 'hello-l'],
    ["send-keys -l -t %0 -- '-l'", '-l'],
  ])('%j types %j into the composer', async (command, typed) => {
    const { runner } = setup();
    await runner.exec(`tmux ${command}`);
    expect(runner.sessions.pane('dev-1')!.composer).toBe(typed);
  });

  it('a payload that looks like an unknown flag is rejected instead of typed', async () => {
    const { runner } = setup();
    const result = await runner.exec("tmux send-keys -l -t %0 '-x'");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown flag -x');
    expect(runner.sessions.pane('dev-1')!.composer).toBe('');
  });

  // 真实 tmux 的 display-message 先把整串交给 strftime,再展开 #{};嵌套操作数被递归展开时还会再跑一次 strftime。
  // 于是 %N 形态的 pane id 字面量活不到比较那一步,而同一个条件交给 if-shell -F 则不经 strftime,照常成立(tmux 3.6a 实测)
  it.each([
    ['#{==:#{pane_id},%0}', '0'],
    ['#{==:#{pane_id},%%0}', '0'],
    ['#{==:#{pane_id},%%%%0}', '1'],
    ['#{==:#{session_id},$1}', '1'],
  ])('display-message %j prints %j', async (fmt, printed) => {
    const { runner } = setup();
    const result = await runner.exec(`tmux display-message -p -t %0 '${fmt}'`);
    expect(result.stdout.trim()).toBe(printed);
  });

  it('the same pane-id comparison holds in an if-shell condition, which tmux expands without strftime', async () => {
    const { runner } = setup();
    const result = await runner.exec(
      "tmux if-shell -t %0 -F '#{==:#{pane_id},%0}' 'display-message -p MATCHED' 'display-message -p MISSED'",
    );
    expect(result.stdout.trim()).toBe('MATCHED');
  });

  it('mixing an explicit session id with auto-allocated ones never collides, and a duplicate is rejected outright', async () => {
    // dev-1 显式占住 $1,qa-1 必须拿到别的编号,否则守卫又会在重复 id 之间"选"目标
    const { runner, tmux } = setup({ agents: { 'dev-1': { sessionId: '$1' } } });
    const devRef = (await tmux.getSessionSnapshot('dev-1'))!.ref;
    const qaRef = (await tmux.getSessionSnapshot('qa-1'))!.ref;
    expect(devRef.sessionId).toBe('$1');
    expect(qaRef.sessionId).not.toBe('$1');

    expect(await tmux.setSessionOptionsIfAlive(devRef, [['@probe', 'leak']], { expectedClaim: 'qa-1' })).toBe('gone');
    expect(runner.sessions.option('qa-1', '@probe')).toBeUndefined();
    expect(runner.sessions.option('dev-1', '@probe')).toBeUndefined();

    // 新建会话也走同一登记表,不会撞上已占用的编号
    const fresh = fakeRunner({ session: 'absent', agents: { 'dev-1': { sessionId: '$3' } } });
    fresh.sessions.seed('dev-1', { present: false });
    const created = await new TmuxManager(fresh).createSession('qa-1', '/tmp/qa-repo');
    expect(created.sessionId).not.toBe('$3');

    expect(() => fakeRunner({ agents: { 'dev-1': { sessionId: '$1' }, 'qa-1': { sessionId: '$1' } } }))
      .toThrow(/already taken/);
  });

  it.each([
    ["/tmp/O'Reilly repo"],
    ['/tmp/a && b'],
  ])('accepts a production launch command whose shell-quoted workdir is %j', async (workdir) => {
    const { runner, tmux } = setup({ agents: { 'dev-1': { process: 'zsh', runtime: 'codex' } } });

    await tmux.submitCommandOnShell(DEV, launchCommandIn(workdir, makeAgent({ runtime: 'codex', workdir })));

    expect(runner.sessions.pane('dev-1')!.process).toBe('codex');
    // cd 真的执行过:pane 当前目录随之改变,ensureSession 的复用/重启判定读的就是它
    expect(await tmux.getPaneCurrentPath(DEV)).toBe(workdir);
  });

  it('keeps a semicolon inside a quoted payload instead of splitting it into a second tmux command', async () => {
    const { runner, tmux } = setup();
    await tmux.sendKeysLiteral(DEV, 'hello ; world', 'claude-code');
    expect(runner.sessions.pane('dev-1')!.composer).toBe('hello ; world');

    const shell = setup({ agents: { 'dev-1': { process: 'zsh' } } });
    await shell.tmux.sendKeysLiteral(DEV, "cd '/tmp/a ; b' && claude --permission-mode bypassPermissions");
    await shell.tmux.sendEnter(DEV);
    expect(shell.runner.sessions.pane('dev-1')!.process).toBe('claude');
  });

  it('pastes into the existing draft instead of clearing it for the caller', async () => {
    const { runner, tmux } = setup();
    await tmux.sendKeysLiteral(DEV, 'draft ', 'claude-code');
    await stageAndPaste(tmux, DEV, 'claude-code', 'payload');
    expect(runner.sessions.pane('dev-1')!.composer).toBe('draft payload');

    await stageAndPaste(tmux, DEV, 'claude-code', ' again');
    expect(runner.sessions.pane('dev-1')!.composer).toBe('draft payload again');
    expect(runner.pastedPrompts.map(p => p.body)).toEqual(['payload', ' again']);
  });

  it.each([
    ['echo claude', 'zsh'],
    ['command -v codex', 'zsh'],
    ['which qodercli', 'zsh'],
    ['cd /tmp/my repo && claude', 'zsh'],
    ["env CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions", 'claude'],
    ['codex --dangerously-bypass-approvals-and-sandbox', 'codex'],
  ] as const)('a shell line %j leaves the pane as %s', async (line, process) => {
    const { runner, tmux } = setup({ agents: { 'dev-1': { process: 'zsh' } } });
    await tmux.sendKeysLiteral(DEV, line);
    await tmux.sendEnter(DEV);
    expect(runner.sessions.pane('dev-1')!.process).toBe(process);
  });

  it.each(['claude-code', 'codex', 'opencode', 'qodercli'] as const)(
    '%s: C-c on an empty composer only quits the runtime where production says it does',
    async (runtime) => {
      const quits = RUNTIME_PROFILES[runtime].exitCommand !== undefined && runtime === 'codex';
      const empty = setup({ agents: { 'dev-1': { runtime } } });
      await empty.tmux.sendKeysToRuntime(DEV, runtime, 'C-c');
      expect(empty.runner.sessions.pane('dev-1')!.process)
        .toBe(quits ? 'zsh' : RUNTIME_PROFILES[runtime].process);

      const dirty = setup({ agents: { 'dev-1': { runtime } } });
      await dirty.tmux.sendKeysLiteral(DEV, 'draft', runtime);
      await dirty.tmux.sendKeysToRuntime(DEV, runtime, 'C-c');
      expect(dirty.runner.sessions.pane('dev-1')!.process).toBe(RUNTIME_PROFILES[runtime].process);
      expect(dirty.runner.sessions.pane('dev-1')!.composer).toBe('');
    },
  );

  it('an explicit interrupt or clear also drops a sticky working title', async () => {
    const stickyRule = [{ match: /send-keys -t %0 .*Enter/, reply: { titleHold: 'sticky' as const } }];
    const escaped = setup({ ackHoldCaptures: Infinity, rules: stickyRule });
    await escaped.tmux.sendKeysLiteral(DEV, 'go', 'claude-code');
    await escaped.tmux.sendEnter(DEV, 'claude-code');
    expect(escaped.runner.sessions.pane('dev-1')!.title).toBe(RUNTIME_PROFILES['claude-code'].workingTitle);
    await escaped.tmux.sendKeysToPane(DEV, 'Escape');
    expect(escaped.runner.sessions.pane('dev-1')!.title).toBe(RUNTIME_PROFILES['claude-code'].idleTitle);
    await expect(escaped.tmux.waitReplReady(DEV, 'claude-code', { ...FAST, titleIdleFastPath: true })).resolves.toBeUndefined();

    const cleared = setup({ ackHoldCaptures: Infinity, rules: stickyRule });
    await cleared.tmux.sendKeysLiteral(DEV, 'go', 'claude-code');
    await cleared.tmux.sendEnter(DEV, 'claude-code');
    await cleared.tmux.sendKeysToRuntime(DEV, 'claude-code', 'C-c');
    expect(cleared.runner.sessions.pane('dev-1')!.title).toBe(RUNTIME_PROFILES['claude-code'].idleTitle);
  });

  it('a paste onto a working pane leaves the running turn on screen', async () => {
    const { runner, tmux } = setup({ ackHoldCaptures: Infinity });
    await tmux.sendKeysLiteral(DEV, 'first', 'claude-code');
    await tmux.sendEnter(DEV, 'claude-code');
    expect(runner.sessions.pane('dev-1')!.phase).toBe('working');

    await stageAndPaste(tmux, DEV, 'claude-code', 'next prompt');

    const view = runner.sessions.pane('dev-1')!;
    expect(view.phase).toBe('working');
    expect(view.composer).toBe('next prompt');
    expect(classifyScreen('claude-code', stripHistory(await tmux.capturePaneSnapshot(DEV, 'claude-code'))).state).toBe('working');
  });

  it('a guard-refused paste still runs the else branch, so injectPrompt self-cleans its staged buffer', async () => {
    const { runner, tmux } = setup({ agents: { 'dev-1': { process: 'zsh' } } });

    await expect(tmux.injectPrompt(DEV, 'body', 'dev-1', 'claude-code')).rejects.toThrow(/withheld/);

    expect(runner.pastedPrompts).toEqual([]);
    expect(runner.sessions.pane('dev-1')!.composer).toBe('');
    // buffer 确实被 else 分支的 delete-buffer 清掉了:按行为验证——再删一次必须报 unknown buffer
    const buf = runner.execWithStdin.mock.calls
      .map(c => /load-buffer -b '([^']+)'/.exec(c[0] as string)?.[1])
      .find((b): b is string => b !== undefined)!;
    await expect(tmux.dropStagedBuffer(buf)).rejects.toThrow(/unknown buffer/);
  });

  it.each([
    ['session disappears', (r: FakeRunner) => r.sessions.drop('dev-1')],
    ['claim changes', (r: FakeRunner) => r.sessions.reclaim('dev-1', 'someone-else')],
    ['generation moves on', (r: FakeRunner) => r.sessions.bumpGeneration('dev-1')],
  ])('a compound load that never reached the server stays uncertain even when the %s', async (_name, race) => {
    const { runner, tmux } = setup({
      rules: [{ match: 'load-buffer', reply: { outcome: 'not-applied-lost' } }],
      onExec: cmd => { if (cmd.includes('load-buffer')) race(runner); },
    });

    // 传输结果未知必须走 reconcileInjectBuffer,不能被身份竞态改判成确定的 PaneGoneError
    const failure = await tmux.injectPrompt(DEV, 'body', 'dev-1', 'claude-code').catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PaneGoneError);
    expect((failure as Error).message).toMatch(/load outcome unknown/);
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('runs the onExec hook for execWithStdin too, before the buffer is staged', async () => {
    const seen: string[] = [];
    const { runner, tmux } = setup({
      onExec: cmd => {
        if (cmd.includes('load-buffer')) {
          seen.push(cmd);
          // 暂存这一步就让会话消失:钩子若不在模型变更之前运行,交错注入等于没发生
          runner.sessions.drop('dev-1');
        }
      },
    });

    await expect(tmux.injectPrompt(DEV, 'body', 'dev-1', 'claude-code')).rejects.toThrow(PaneGoneError);

    expect(seen).toHaveLength(1);
    expect(runner.pastedPrompts).toEqual([]);
  });
});

describe('fake runner: compound load (injectPrompt)', () => {
  it('stages only when the five-field identity probe matches', async () => {
    const ok = setup({ ackHoldCaptures: Infinity });
    await ok.tmux.injectPrompt(DEV, 'compound', 'dev-1', 'claude-code');
    expect(ok.runner.pastedPrompts).toEqual([{ pane: '%0', body: 'compound' }]);

    const changed = setup();
    changed.runner.sessions.reclaim('dev-1', 'other');
    await expect(changed.tmux.injectPrompt(DEV, 'compound', 'dev-1', 'claude-code')).rejects.toThrow(/identity probe or buffer load failed/);
    expect(changed.runner.pastedPrompts).toEqual([]);

    const gone = setup();
    gone.runner.sessions.drop('dev-1');
    await expect(gone.tmux.injectPrompt(DEV, 'compound', 'dev-1', 'claude-code')).rejects.toThrow(PaneGoneError);
  });
});

describe('fake runner: outcomes per public API', () => {
  it('runtime-guarded writes: ok-255 applies, applied-lost is uncertain, not-applied-lost applies nothing', async () => {
    const ok255 = setup({ rules: [{ match: 'paste-buffer', reply: { outcome: 'ok-255' } }] });
    await stageAndPaste(ok255.tmux, DEV, 'claude-code', 'a');
    expect(ok255.runner.pastedPrompts).toHaveLength(1);

    const lost = setup({ rules: [{ match: 'paste-buffer', reply: { outcome: 'applied-lost' } }] });
    const { buf } = await lost.tmux.stagePromptBuffer('%0', 'b', 'dev-1');
    await expect(lost.tmux.pasteStagedBuffer(DEV, buf, 'claude-code')).rejects.toThrow(/neither marker returned/);
    expect(lost.runner.pastedPrompts).toEqual([{ pane: '%0', body: 'b' }]);

    const none = setup({ rules: [{ match: 'paste-buffer', reply: { outcome: 'not-applied-lost' } }] });
    const staged = await none.tmux.stagePromptBuffer('%0', 'c', 'dev-1');
    await expect(none.tmux.pasteStagedBuffer(DEV, staged.buf, 'claude-code')).rejects.toThrow();
    expect(none.runner.pastedPrompts).toEqual([]);
  });

  it('submitCommandOnShell reconciles by nonce: applied-lost succeeds, not-applied-lost reports nothing typed, probe failure is unknown', async () => {
    const shellWrite = (cmd: string): boolean => cmd.includes('@bx_shell_write') && cmd.includes('send-keys');
    const applied = setup({ agents: { 'dev-1': { process: 'zsh' } }, rules: [{ match: shellWrite, reply: { outcome: 'applied-lost' } }] });
    await expect(applied.tmux.submitCommandOnShell(DEV, 'claude')).resolves.toBeUndefined();
    expect(applied.runner.sessions.pane('dev-1')!.process).toBe('claude');

    const none = setup({ agents: { 'dev-1': { process: 'zsh' } }, rules: [{ match: shellWrite, reply: { outcome: 'not-applied-lost' } }] });
    await expect(none.tmux.submitCommandOnShell(DEV, 'claude')).rejects.toThrow(/nothing was typed/);
    expect(none.runner.sessions.pane('dev-1')!.process).toBe('zsh');

    const probeFails = setup({
      agents: { 'dev-1': { process: 'zsh' } },
      rules: [
        { match: cmd => cmd.includes('@bx_shell_write') && cmd.includes('send-keys'), reply: { outcome: 'applied-lost' } },
        { match: cmd => cmd.includes('@bx_shell_write') && !cmd.includes('send-keys'), reply: { exitCode: 255, stderr: 'ssh: reset' } },
      ],
    });
    await expect(probeFails.tmux.submitCommandOnShell(DEV, 'claude')).rejects.toThrow(TmuxOutcomeUnknownError);
  });
});

describe('fake runner: clear and exit keys', () => {
  it('codex: C-c on an empty composer exits the runtime; dirtying with a comma first only clears', async () => {
    const quits = setup();
    await quits.tmux.sendKeysToRuntime(QA, 'codex', 'C-c');
    expect(quits.runner.sessions.pane('qa-1')!.process).toBe('zsh');

    const clears = setup();
    await clears.tmux.clearComposerDraft(QA, 'codex', { timeoutMs: 200, intervalMs: 20 });
    expect(clears.runner.sessions.pane('qa-1')!.process).toBe('codex');
    expect(clears.runner.sessions.pane('qa-1')!.composer).toBe('');
  });

  it('claude: C-c on an empty composer keeps the runtime', async () => {
    const { runner, tmux } = setup();
    await tmux.sendKeysToRuntime(DEV, 'claude-code', 'C-c');
    expect(runner.sessions.pane('dev-1')!.process).toBe('claude');
  });

  it.each([
    ['claude-code', '%0', '/exit'],
    ['codex', '%1', '/quit'],
  ] as const)('%s: submitting the exit command returns the pane to a shell; plain text goes working', async (runtime, paneId, exitCommand) => {
    const pane = paneId === '%0' ? DEV : QA;
    const plain = setup();
    await plain.tmux.submitToRuntime(pane, runtime, 'plain text');
    expect(plain.runner.sessions.pane(pane.claim)!.phase).toBe('working');
    expect(plain.runner.sessions.pane(pane.claim)!.process).not.toBe('zsh');
    const exits = setup();
    await exits.tmux.submitToRuntime(pane, runtime, exitCommand);
    expect(exits.runner.sessions.pane(pane.claim)!.process).toBe('zsh');
    expect(exits.runner.sessions.pane(pane.claim)!.title).toBe('zsh');
  });
});

describe('fake runner: interrupt', () => {
  it.each([
    ['idle', 'idle'],
    ['ignored-live', 'working'],
    ['ignored-static', 'working'],
  ] as const)('interrupt=%s → phase %s after Escape', async (mode, phase) => {
    const { runner, tmux } = setup({ ackHoldCaptures: Infinity, agents: { 'dev-1': { interrupt: mode } } });
    await tmux.sendKeysLiteral(DEV, 'go', 'claude-code');
    await tmux.sendEnter(DEV, 'claude-code');
    await tmux.sendKeysToPane(DEV, 'Escape');
    expect(runner.sessions.pane('dev-1')!.phase).toBe(phase);
    if (mode === 'idle') expect(runner.sessions.pane('dev-1')!.composer).toBe('go');
    if (mode === 'ignored-live') {
      const a = await tmux.capturePaneById(DEV, { runtime: 'claude-code' });
      const b = await tmux.capturePaneById(DEV, { runtime: 'claude-code' });
      expect(a).not.toBe(b);
    }
    if (mode === 'ignored-static') {
      const a = await tmux.capturePaneById(DEV, { runtime: 'claude-code' });
      const b = await tmux.capturePaneById(DEV, { runtime: 'claude-code' });
      expect(a).toBe(b);
    }
  });

  it('without Escape the pane stays working forever under an infinite hold', async () => {
    const { runner, tmux } = setup({ ackHoldCaptures: Infinity });
    await tmux.sendKeysLiteral(DEV, 'go', 'claude-code');
    await tmux.sendEnter(DEV, 'claude-code');
    for (let i = 0; i < 5; i++) await tmux.capturePaneById(DEV, { runtime: 'claude-code' });
    expect(runner.sessions.pane('dev-1')!.phase).toBe('working');
  });
});

describe('fake runner: session ownership and creation', () => {
  it('absent → new-session → present → drop → absent', async () => {
    const { runner, tmux } = setup({ session: 'absent' });
    expect(await tmux.getSessionSnapshot('dev-1')).toBeNull();
    const ref = await tmux.createSession('dev-1', '/tmp/repo');
    expect(await tmux.getSessionSnapshot('dev-1')).toEqual({ ref, claim: null });
    expect(await tmux.hasCreationNonce('dev-1')).toBe(true);
    expect(await tmux.setSessionOptionsIfAlive(ref, [['@baxian-agent-id', 'dev-1']], { expectedClaim: '' })).toBe('applied');
    const pane = await tmux.getSinglePaneByRef(ref, 'dev-1');
    expect(runner.sessions.pane('dev-1', pane.paneId)!.process).toBe('zsh');
    runner.sessions.drop('dev-1');
    expect(await tmux.getSessionSnapshot('dev-1')).toBeNull();
  });

  it('a plain duplicate fails outright without any nonce probe', async () => {
    const { tmux, cmds } = setup();
    await expect(tmux.createSession('dev-1', '/tmp/repo')).rejects.toThrow(/Failed to create tmux session/);
    expect(cmds().some(c => c.includes('show-environment'))).toBe(false);
  });

  it('applied-lost creation reconciles by nonce; a foreign or mismatched survivor is left untouched', async () => {
    const adopted = setup({ session: 'absent', rules: [{ match: 'new-session', reply: { outcome: 'applied-lost' } }] });
    const ref = await adopted.tmux.createSession('dev-1', '/tmp/repo');
    expect(await adopted.tmux.getSessionSnapshot('dev-1')).toEqual({ ref, claim: null });

    const foreign = setup({ session: 'absent', rules: [{ match: 'new-session', reply: { outcome: 'not-applied-lost' } }] });
    foreign.runner.sessions.seed('dev-1', { nonce: 'other', claim: null });
    await expect(foreign.tmux.createSession('dev-1', '/tmp/repo')).rejects.toThrow(/nonce mismatch/);
    expect(foreign.runner.sessions.present('dev-1')).toBe(true);
    expect(await foreign.tmux.hasCreationNonce('dev-1')).toBe(true);

    const noNonce = setup({ session: 'absent', rules: [{ match: 'new-session', reply: { outcome: 'not-applied-lost' } }] });
    noNonce.runner.sessions.seed('dev-1', { claim: null });
    await expect(noNonce.tmux.createSession('dev-1', '/tmp/repo')).rejects.toThrow(/nonce mismatch/);
    expect(await noNonce.tmux.hasCreationNonce('dev-1')).toBe(false);
  });

  it('half-created leftovers (nonce, no claim) can be killed as unclaimed; foreign sessions without a nonce are not', async () => {
    const { runner, tmux } = setup({ agents: { 'dev-1': { claim: null, nonce: 'n-1' } } });
    expect(await tmux.killSessionRef(REF, { kind: 'unclaimed' })).toBe('killed');
    expect(runner.sessions.present('dev-1')).toBe(false);
    const foreign = setup({ agents: { 'dev-1': { claim: null } } });
    expect(await foreign.tmux.hasCreationNonce('dev-1')).toBe(false);
    expect(await foreign.tmux.killSessionRef(REF, { kind: 'equals', claim: 'dev-1' })).toBe('refused');
    expect(foreign.runner.sessions.present('dev-1')).toBe(true);
  });
});

describe('fake runner: trust dialog', () => {
  const NO_FIRST = RUNTIME_PROFILES['claude-code'].dialogFrame!;
  const YES_FIRST = 'Quick safety check\nDo you trust this folder?\n› Yes, I trust this folder\n';

  it('claude-code, No preselected: Down then Enter → idle; Enter alone keeps the dialog', async () => {
    const accepted = setup({ agents: { 'dev-1': { screen: NO_FIRST } } });
    expect(await accepted.tmux.handleTrustDialog(DEV, 'claude-code', { timeoutMs: 500, intervalMs: 10 })).toBe(true);
    expect(accepted.runner.sentKeys.some(k => k.includes("'Down'"))).toBe(true);
    expect(accepted.runner.sessions.pane('dev-1')!.phase).toBe('idle');

    const stuck = setup({ agents: { 'dev-1': { screen: NO_FIRST } } });
    await stuck.tmux.sendKeysToPane(DEV, 'Enter');
    expect(stuck.runner.sessions.pane('dev-1')!.phase).toBe('dialog');
  });

  it('claude-code, Yes preselected: Enter alone → idle', async () => {
    const { runner, tmux } = setup({ agents: { 'dev-1': { screen: YES_FIRST } } });
    expect(await tmux.handleTrustDialog(DEV, 'claude-code', { timeoutMs: 500, intervalMs: 10 })).toBe(true);
    expect(runner.sentKeys.some(k => k.includes("'Down'"))).toBe(false);
    expect(runner.sessions.pane('dev-1')!.phase).toBe('idle');
  });

  it('codex has no accept cursor: Enter → idle', async () => {
    const { runner, tmux } = setup({ agents: { 'qa-1': { screen: RUNTIME_PROFILES.codex.dialogFrame! } } });
    expect(await tmux.handleTrustDialog(QA, 'codex', { timeoutMs: 500, intervalMs: 10 })).toBe(true);
    expect(runner.sessions.pane('qa-1')!.phase).toBe('idle');
  });

  it('a freshly launched runtime with a configured dialog waits on it until accepted, then becomes ready', async () => {
    const { runner, tmux } = setup({ agents: { 'dev-1': { process: 'zsh', trustDialog: NO_FIRST } } });
    await tmux.sendKeysLiteral(DEV, "cd '/tmp/repo' && claude");
    await tmux.sendEnter(DEV);
    expect(runner.sessions.pane('dev-1')!.phase).toBe('dialog');
    await expect(tmux.waitReplReady(DEV, 'claude-code', FAST)).rejects.toThrow();
    expect(await tmux.handleTrustDialog(DEV, 'claude-code', { timeoutMs: 500, intervalMs: 10 })).toBe(true);
    await expect(tmux.waitReplReady(DEV, 'claude-code', FAST)).resolves.toBeUndefined();
  });
});
