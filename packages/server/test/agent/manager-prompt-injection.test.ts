import { describe, it, expect, vi } from 'vitest';
import type { BaxianEvent, TaskState } from '../../src/shared/index.js';
import { DispatchTerminalError, type AgentManagerDeps, type ContinueSessionOpts } from '../../src/agent/manager.js';
import type { AgentRuntimeKind } from '../../src/agent/tmux.js';
import { classifyScreen } from '../../src/agent/detect/classify.js';
import { createManagerSuiteRunner, useManagerSuiteHarness } from '../helpers/manager-harness.js';
import { RUNTIME_PROFILES, type FakeRunner, type FakeRunnerOptions } from '../helpers/fake-runner.js';

const harness = useManagerSuiteHarness();

const FAST = { dispatchAckTimeoutMs: 150, dispatchSettleTimeoutMs: 150, dispatchAckResendIntervalMs: 30 };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
// claude-code 的 working 规则只看屏幕底部,真实派发提示词的尾部是固定协议文本,自匹配基线只能由屏幕帧给出
const BUSY_BODY = '✻ Thinking… (3s · esc to interrupt)';
const BUSY_BASELINE = `${RUNTIME_PROFILES['claude-code'].idleFrame('/tmp/repo')}note:\n${BUSY_BODY}\n`;
const WORKING_FRAME = '✻ Working… (12s · esc to interrupt)\n';
const WORKING_TITLE = '⠹ Grooving…';
const IDLE_TITLE = 'dev-1';
const BUSY_LOOKING_DRAFT = '❯ 排查 codex 卡死，日志：\n  • Working (12s)\n  esc to interrupt\n';
const PANE_LOST = { stderr: 'no such pane: %0', exitCode: 1 };
const SSH_TIMEOUT = { stderr: 'ssh: connect: connection timed out', exitCode: 1 };
// tmux 送达了 Enter(OK 标记),REPL 没有响应:模型里的 pane 保持 idle、composer 原样
const SWALLOW_ENTER = { stdout: 'BX_RUNTIME_OK\n' };
const ENTER = /send-keys -t %0 (?:-- )?\S*Enter/;
const isEnter = (cmd: string): boolean => ENTER.test(cmd);
const isCtrlC = (cmd: string): boolean => cmd.includes("'C-c'");
const isSnapshot = (cmd: string): boolean => cmd.includes('history_size');

type RunnerSpec = FakeRunnerOptions & { runtime?: AgentRuntimeKind };

function useRunner(spec: RunnerSpec = {}, timing: Partial<AgentManagerDeps> = {}): FakeRunner {
  const { runtime, ...options } = spec;
  const runner = createManagerSuiteRunner(runtime
    ? { ...options, agents: { ...options.agents, 'dev-1': { runtime, ...options.agents?.['dev-1'] } } }
    : options);
  const config = structuredClone(harness.config);
  if (runtime) config.project[0]!.agent[0]![0]!.runtime = runtime;
  harness.runner = runner;
  harness.manager = harness.createManager({ config, runnerFactory: () => runner, ...FAST, ...timing });
  return runner;
}

async function seedDispatch(overrides: Partial<TaskState> = {}): Promise<TaskState> {
  const task = await harness.seedTask({ signalToken: 'tok-T1', ...overrides });
  await harness.seedAgent({ id: 'dev-1', taskId: task.id, paneId: '%0' });
  return task;
}

const dispatch = (task: TaskState): Promise<boolean> => harness.manager.startSession(task.id, 'dev-1', 'develop');
// 带 pass token 的派发走 stage/paste 路径,每一步都经真实 fence 复核
const fencedDispatch = (task: TaskState): Promise<boolean> =>
  harness.manager.startSession(task.id, 'dev-1', 'develop', { dispatchPassToken: task.signalToken });
const continueDispatch = (task: TaskState, opts: ContinueSessionOpts = {}): Promise<boolean> =>
  harness.manager.continueSession(task.id, 'dev-1', 'develop', opts);
const fenceOn = (task: TaskState, token: string): ContinueSessionOpts => ({
  guardBeforeInject: async () => (await harness.taskStore.get(task.id))?.signalToken === token,
});

async function rotatePass(task: TaskState, token: string): Promise<void> {
  const fresh = await harness.taskStore.get(task.id);
  await harness.taskStore.set({ ...fresh!, signalToken: token });
}

const cmds = (): string[] => harness.runner.exec.mock.calls.map(c => String(c[0]));
const enters = (): string[] => harness.runner.sentKeys.filter(isEnter);
const ctrlCs = (): string[] => harness.runner.sentKeys.filter(isCtrlC);
const literals = (): string[] => harness.runner.sentKeys.filter(k => k.includes('send-keys -l'));
const hasSessionProbes = (): string[] => cmds().filter(c => c.includes('has-session'));
const afterFirstEnter = (): string[] => cmds().slice(cmds().findIndex(isEnter));
const pane = () => harness.runner.sessions.pane('dev-1')!;
const staged = (): string[] => harness.runner.execWithStdin.mock.calls.map(c => String(c[0]));
const isAckUnknown = (err: unknown): boolean => err instanceof DispatchTerminalError && err.reason === 'ack_unknown';

function ackInterventions(): BaxianEvent[] {
  return harness.events.filter(
    e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'dispatch-ack-timeout',
  );
}

async function expectBinding(task: TaskState, bound: boolean): Promise<void> {
  expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(bound ? task.id : undefined);
  expect(await harness.lockManager.isLocked('dev-1')).toBe(bound);
}

describe('fenced dispatch: a rotated pass never reaches the pane', () => {
  it('rotated while an upload holds the pane mutex: nothing is staged, pasted or typed', async () => {
    const runner = useRunner();
    const task = await seedDispatch();
    let releaseWrite!: () => void;
    runner.writeFile.mockReturnValueOnce(new Promise<void>(r => { releaseWrite = r; }));
    const upload = harness.manager.attachImageToRunningAgent('dev-1', PNG, 'png');
    await vi.waitFor(() => expect(runner.writeFile).toHaveBeenCalled());

    const dispatching = fencedDispatch(task);
    await vi.waitFor(async () => expect((await harness.agentStore.get('dev-1'))?.bootstrappingTaskId).toBe(task.id));
    await rotatePass(task, 'tok-T2');
    releaseWrite();
    await upload;

    await expect(dispatching).resolves.toBe(false);
    expect(staged().filter(c => c.startsWith('tmux load-buffer'))).toEqual([]);
    expect(runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringMatching(/\.png $/) }]);
    expect(runner.sentKeys).toEqual([]);
  });

  it('rotated during buffer staging: the buffer is dropped and the paste never happens', async () => {
    const task = await seedDispatch();
    const runner = useRunner({
      rules: [{
        match: /^tmux load-buffer/,
        reply: async () => { await rotatePass(task, 'tok-T2'); return { outcome: 'ok' as const }; },
      }],
    });

    await expect(fencedDispatch(task)).resolves.toBe(false);

    expect(cmds().some(c => c.includes('delete-buffer'))).toBe(true);
    expect(runner.pastedPrompts).toEqual([]);
    expect(runner.sentKeys).toEqual([]);
    expect(pane().composer).toBe('');
  });

  it('serializes the final fence and the paste against task mutations; the rotated prompt is scrubbed, not submitted', async () => {
    let releasePaste!: () => void;
    const pasteGate = new Promise<void>(r => { releasePaste = r; });
    const runner = useRunner({ onExec: async cmd => { if (cmd.includes('paste-buffer')) await pasteGate; } });
    const task = await seedDispatch();

    const dispatching = fencedDispatch(task);
    await vi.waitFor(() => expect(cmds().some(c => c.includes('paste-buffer'))).toBe(true));
    let rotated = false;
    const rotation = harness.manager.updateTask(task.id, { signalToken: 'tok-T2' }).then(() => { rotated = true; });
    await new Promise(r => setTimeout(r, 50));
    expect(rotated).toBe(false);

    releasePaste();
    await expect(dispatching).resolves.toBe(false);
    await rotation;

    expect((await harness.taskStore.get(task.id))?.signalToken).toBe('tok-T2');
    expect(runner.pastedPrompts).toHaveLength(1);
    expect(enters()).toEqual([]);
    expect(pane().composer).toBe('');
  });

  it('a rotation landing after the paste aborts before Enter and scrubs the composer', async () => {
    let pasted = false;
    let releaseSnapshot!: () => void;
    const snapGate = new Promise<void>(r => { releaseSnapshot = r; });
    const runner = useRunner({
      onExec: async cmd => {
        if (cmd.includes('paste-buffer')) pasted = true;
        if (pasted && isSnapshot(cmd)) await snapGate;
      },
    });
    const task = await seedDispatch();

    const dispatching = fencedDispatch(task);
    await vi.waitFor(() => expect(pasted).toBe(true));
    await harness.manager.updateTask(task.id, { signalToken: 'tok-T2' });
    releaseSnapshot();

    await expect(dispatching).resolves.toBe(false);
    expect(runner.pastedPrompts).toHaveLength(1);
    expect(enters()).toEqual([]);
    expect(pane().composer).toBe('');
  });

  it('escalates to ack_unknown and keeps the binding when the fence-rejected composer cannot be scrubbed', async () => {
    let pasted = false;
    let releaseSnapshot!: () => void;
    const snapGate = new Promise<void>(r => { releaseSnapshot = r; });
    useRunner({
      onExec: async cmd => {
        if (cmd.includes('paste-buffer')) pasted = true;
        if (pasted && isSnapshot(cmd)) await snapGate;
      },
      rules: [{ match: cmd => pasted && isCtrlC(cmd), reply: { stderr: 'pane is gone', exitCode: 1 } }],
    });
    const task = await seedDispatch();

    const dispatching = fencedDispatch(task);
    await vi.waitFor(() => expect(pasted).toBe(true));
    await harness.manager.updateTask(task.id, { signalToken: 'tok-T2' });
    releaseSnapshot();

    await expect(dispatching).rejects.toMatchObject({
      name: 'DispatchTerminalError',
      reason: 'ack_unknown',
      message: expect.stringMatching(/could not be scrubbed/),
    });
    expect(enters()).toEqual([]);
    await expectBinding(task, true);
  });

  it('ack resends re-check the fence: a pass rotated after Enter is never re-submitted and the composer is scrubbed', async () => {
    const task = await seedDispatch();
    const runner = useRunner({
      rules: [{ match: isEnter, reply: async () => { await rotatePass(task, 'tok-T2'); return SWALLOW_ENTER; } }],
    }, { dispatchAckTimeoutMs: 400 });

    await expect(fencedDispatch(task)).resolves.toBe(false);

    expect(enters()).toHaveLength(1);
    expect(runner.pastedPrompts).toHaveLength(1);
    expect(pane().composer).toBe('');
    expect(ctrlCs()).toHaveLength(2);
    expect(ackInterventions()).toEqual([]);
  });

  it('stages the buffer first, scrubs the composer inside the paste fence, then pastes', async () => {
    const runner = useRunner();
    const task = await seedDispatch();

    await expect(fencedDispatch(task)).resolves.toBe(true);

    const stagedAt = runner.execWithStdin.mock.invocationCallOrder[0]!;
    const orderOf = (pick: (cmd: string) => boolean): number =>
      runner.exec.mock.invocationCallOrder[cmds().findIndex(pick)]!;
    expect(stagedAt).toBeLessThan(orderOf(c => c.includes('send-keys -l')));
    expect(orderOf(c => c.includes('send-keys -l'))).toBeLessThan(orderOf(isCtrlC));
    expect(orderOf(isCtrlC)).toBeLessThan(orderOf(c => c.includes('paste-buffer')));
    expect(runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining('token: tok-T1') }]);
  });
});

describe('paste failures clean up the staged buffer', () => {
  it.each([
    ['exits non-zero', { stderr: 'pane vanished', exitCode: 1 }, /pane vanished/],
    ['transport throws', () => { throw new Error('ssh transport lost'); }, /ssh transport lost/],
  ] as const)('paste %s: buffer dropped, nothing pasted, binding released', async (_name, reply, pattern) => {
    const runner = useRunner({ rules: [{ match: 'paste-buffer', reply }] });
    const task = await seedDispatch();

    await expect(fencedDispatch(task)).rejects.toThrow(pattern);

    expect(cmds().some(c => c.includes('delete-buffer'))).toBe(true);
    expect(runner.pastedPrompts).toEqual([]);
    expect(pane().composer).toBe('');
    await expectBinding(task, false);
  });

  it('a paste that landed but lost its reply is reconciled by scrubbing the composer', async () => {
    const runner = useRunner({ rules: [{ match: 'paste-buffer', reply: { outcome: 'applied-lost' } }] });
    const task = await seedDispatch();

    await expect(fencedDispatch(task)).rejects.toThrow(/neither marker returned/);

    expect(runner.pastedPrompts).toHaveLength(1);
    expect(cmds().some(c => c.includes('delete-buffer'))).toBe(true);
    expect(ctrlCs()).toHaveLength(2);
    expect(pane().composer).toBe('');
  });
});

describe('ack timeout', () => {
  it('a swallowed Enter holds for a human: dispatch-ack-timeout intervention, no C-c, prompt left queued, binding kept', async () => {
    useRunner({ rules: [{ match: isEnter, reply: SWALLOW_ENTER }] }, { dispatchAckTimeoutMs: 50 });
    const task = await seedDispatch();

    await expect(dispatch(task)).resolves.toBe(true);

    expect(ackInterventions()).toEqual([expect.objectContaining({
      projectId: 'proj',
      agentId: 'dev-1',
      taskId: task.id,
      data: expect.objectContaining({ paneId: '%0', note: expect.stringMatching(/REPL did not acknowledge/) }),
    })]);
    expect(afterFirstEnter().filter(isCtrlC)).toEqual([]);
    expect(pane().composer).toContain('token: tok-T1');
    expect((await harness.taskStore.get(task.id))?.status).toBe('in_progress');
    await expectBinding(task, true);
  });

  it('re-sends Enter when the first is swallowed, then acks', async () => {
    let enterCount = 0;
    useRunner({
      rules: [{ match: isEnter, reply: () => (++enterCount === 1 ? SWALLOW_ENTER : { outcome: 'ok' as const }) }],
    }, { dispatchAckTimeoutMs: 3000, dispatchAckResendIntervalMs: 50 });
    const task = await seedDispatch();

    await expect(dispatch(task)).resolves.toBe(true);

    expect(enters().length).toBeGreaterThanOrEqual(2);
    expect(ackInterventions()).toEqual([]);
    expect(pane().phase).toBe('working');
  });

  it('an infrastructure failure after Enter is ack_unknown: no intervention, no C-c, no has-session probe, binding kept', async () => {
    let enterSeen = false;
    let dropped = false;
    useRunner({
      onExec: cmd => {
        if (enterSeen && !dropped) { dropped = true; harness.runner.sessions.dropPane('dev-1', '%0'); }
        if (isEnter(cmd)) enterSeen = true;
      },
    });
    const task = await seedDispatch();

    await expect(dispatch(task)).rejects.toSatisfy(isAckUnknown);

    expect(ackInterventions()).toEqual([]);
    expect(afterFirstEnter().filter(isCtrlC)).toEqual([]);
    expect(hasSessionProbes()).toEqual([]);
    await expectBinding(task, true);
  });
});

describe('submission evidence', () => {
  it('sends Enter only after the pane settles, then acks on the idle→busy evidence', async () => {
    let redraws = 0;
    useRunner({
      rules: [{
        match: cmd => isSnapshot(cmd) && redraws < 2,
        reply: () => ({ stdout: `BX_PANE_OK|0\nbox: [Image #${++redraws}]\n` }),
      }],
    }, { dispatchSettleTimeoutMs: 2000, dispatchAckTimeoutMs: 2000 });
    const task = await seedDispatch();

    await expect(dispatch(task)).resolves.toBe(true);

    const enterIdx = cmds().findIndex(isEnter);
    expect(cmds().slice(0, enterIdx).filter(isSnapshot).length).toBeGreaterThanOrEqual(3);
    expect(cmds().slice(enterIdx).some(isSnapshot)).toBe(true);
    expect(ackInterventions()).toEqual([]);
  });

  it('acks on a brief idle→busy flash after Enter and never touches the composer afterwards', async () => {
    const runner = useRunner({ ackHoldCaptures: 2 });
    const task = await seedDispatch();

    await expect(dispatch(task)).resolves.toBe(true);

    expect(runner.pastedPrompts).toHaveLength(1);
    expect(pane().composer).toBe('');
    expect(ackInterventions()).toEqual([]);
    expect(afterFirstEnter().filter(isCtrlC)).toEqual([]);
    expect(hasSessionProbes()).toEqual([]);
  });

  it('samples the title before Enter: a self-matching baseline still acks through the working title', async () => {
    expect(classifyScreen('claude-code', BUSY_BASELINE).state).toBe('working');
    let enterSeen = false;
    useRunner({
      agents: { 'dev-1': { title: '' } },
      onExec: cmd => { if (isEnter(cmd)) enterSeen = true; },
      rules: [{ match: isSnapshot, reply: () => (enterSeen ? { outcome: 'ok' as const } : { stdout: `BX_PANE_OK|0\n${BUSY_BASELINE}` }) }],
    });
    const task = await seedDispatch();

    await expect(dispatch(task)).resolves.toBe(true);

    expect(ackInterventions()).toEqual([]);
    expect(pane().phase).toBe('working');
  });

  type Snapshot = { frame: string; history?: number } | null;
  it.each<{ name: string; title?: string; busy?: true; snapshot?: (enterSeen: boolean) => Snapshot }>([
    {
      name: 'the runtime never goes busy while redraw deltas keep changing the frame',
      snapshot: (() => { let n = 0; return () => ({ frame: `> frame ${n++}\n` }); })(),
    },
    {
      name: 'scrollback grows from an uncommitted attach redraw',
      snapshot: (() => { let h = 5; return (enterSeen: boolean) => ({ frame: '❯ \n', history: enterSeen ? ++h : h }); })(),
    },
    { name: 'the baseline after the paste already matches a working rule', title: '', busy: true, snapshot: () => ({ frame: BUSY_BASELINE }) },
    {
      name: 'the composer "clears" after submit but the baseline was busy',
      title: '',
      busy: true,
      snapshot: enterSeen => ({ frame: enterSeen ? 'running the task now\n' : BUSY_BASELINE }),
    },
    {
      name: 'a busy baseline keeps redrawing an attach',
      title: '',
      busy: true,
      snapshot: (() => { let n = 0; return () => ({ frame: `${BUSY_BASELINE}[Image #1] frame ${n++}\n` }); })(),
    },
    {
      name: 'a settled busy baseline gets a late attach redraw',
      title: '',
      busy: true,
      snapshot: (() => { let n = 0; return (enterSeen: boolean) => ({ frame: enterSeen ? `${BUSY_BASELINE}[Image #1] frame ${n++}\n` : BUSY_BASELINE }); })(),
    },
  ])('a swallowed Enter never false-acks: $name', async ({ title, busy, snapshot }) => {
    if (busy) expect(classifyScreen('claude-code', BUSY_BASELINE).state).toBe('working');
    let enterSeen = false;
    useRunner({
      ...(title === undefined ? {} : { agents: { 'dev-1': { title } } }),
      rules: [
        { match: isEnter, reply: () => { enterSeen = true; return SWALLOW_ENTER; } },
        ...(snapshot ? [{
          match: isSnapshot,
          reply: () => {
            const view = snapshot(enterSeen);
            return view === null ? { outcome: 'ok' as const } : { stdout: `BX_PANE_OK|${view.history ?? 0}\n${view.frame}` };
          },
        }] : []),
      ],
    }, { dispatchAckTimeoutMs: 150, dispatchSettleTimeoutMs: 80 });
    const task = await seedDispatch();

    await expect(dispatch(task)).resolves.toBe(true);

    expect(enters().length).toBeGreaterThanOrEqual(1);
    expect(ackInterventions()).toHaveLength(1);
    expect(afterFirstEnter().filter(isCtrlC)).toEqual([]);
    expect((await harness.taskStore.get(task.id))?.status).toBe('in_progress');
    await expectBinding(task, true);
  });

  it.each<[AgentRuntimeKind, string]>([
    ['opencode', '帮我看下 esc to interrupt 这个判定'],
    ['qodercli', '文案里写的是 (esc to cancel, 要不要改'],
  ])('%s has no title rule: a self-matching prompt with a swallowed Enter times out into an intervention', async (runtime, description) => {
    useRunner({ runtime, rules: [{ match: isEnter, reply: SWALLOW_ENTER }] }, { dispatchAckTimeoutMs: 250, dispatchSettleTimeoutMs: 60 });
    const task = await seedDispatch({ description });

    await expect(dispatch(task)).resolves.toBe(true);

    expect(classifyScreen(runtime, pane().frame).state).toBe('working');
    expect(enters().length).toBeGreaterThanOrEqual(1);
    expect(ackInterventions()).toHaveLength(1);
  });
});

describe('pre-Enter failures leave the pane reuse-safe', () => {
  it('a pre-Enter capture failure scrubs the composer, never sends Enter, never probes has-session, releases the binding', async () => {
    let snaps = 0;
    useRunner({ rules: [{ match: cmd => isSnapshot(cmd) && ++snaps > 1, reply: PANE_LOST }] });
    const task = await seedDispatch();

    await expect(dispatch(task)).rejects.toSatisfy(err => err instanceof Error && !isAckUnknown(err));

    expect(enters()).toEqual([]);
    expect(ctrlCs()).toHaveLength(2);
    expect(hasSessionProbes()).toEqual([]);
    expect(pane().composer).toBe('');
    await expectBinding(task, false);
  });

  it.each([
    {
      name: 'a failed sendEnter is raw cleanup: composer scrubbed, binding released',
      failKeys: 'enter' as const,
      keysReply: PANE_LOST,
      hasSessionReply: undefined as Record<string, unknown> | undefined,
      ackUnknown: false,
      ctrlC: 2,
      probes: 0,
    },
    {
      name: 'a transient reuse-clear failure on a live session escalates to ack_unknown (no blind C-c)',
      failKeys: 'after-preclear' as const,
      keysReply: SSH_TIMEOUT,
      hasSessionReply: undefined,
      ackUnknown: true,
      ctrlC: 1,
      probes: 1,
    },
    {
      name: 'a reuse-clear failure on a confirmed-dead session is reuse-safe: raw error, binding released',
      failKeys: 'after-preclear' as const,
      keysReply: PANE_LOST,
      hasSessionReply: { stderr: "can't find session: dev-1", exitCode: 1 },
      ackUnknown: false,
      ctrlC: 1,
      probes: 1,
    },
    {
      name: 'an unconfirmable session (clear fails and has-session fails) escalates to ack_unknown',
      failKeys: 'after-preclear' as const,
      keysReply: SSH_TIMEOUT,
      hasSessionReply: { stderr: 'ssh: connect: connection timed out', exitCode: 2 },
      ackUnknown: true,
      ctrlC: 1,
      probes: 1,
    },
  ])('$name', async ({ failKeys, keysReply, hasSessionReply, ackUnknown, ctrlC, probes }) => {
    let sendKeysSeen = 0;
    useRunner({
      rules: [
        ...(hasSessionReply ? [{ match: 'has-session', reply: hasSessionReply }] : []),
        {
          match: cmd => cmd.includes('send-keys') && (failKeys === 'enter' ? isEnter(cmd) : ++sendKeysSeen > 2),
          reply: keysReply,
        },
      ],
    });
    const task = await seedDispatch();

    await expect(dispatch(task)).rejects.toSatisfy(err => err instanceof Error && isAckUnknown(err) === ackUnknown);

    expect(ctrlCs()).toHaveLength(ctrlC);
    expect(hasSessionProbes()).toHaveLength(probes);
    await expectBinding(task, ackUnknown);
  });

  it('aborts without pasting when the pre-inject composer clear fails', async () => {
    const runner = useRunner({ rules: [{ match: 'send-keys -l', reply: SSH_TIMEOUT }] });
    const task = await seedDispatch();

    await expect(dispatch(task)).rejects.toThrow(/guarded write/);

    expect(runner.pastedPrompts).toEqual([]);
    expect(enters()).toEqual([]);
  });

  it('re-validates the binding after the pre-inject clear: a task cancelled during the clear is never pasted', async () => {
    const task = await seedDispatch();
    const runner = useRunner({
      onExec: async cmd => {
        if (!cmd.includes('send-keys -l')) return;
        const fresh = await harness.taskStore.get(task.id);
        await harness.taskStore.set({ ...fresh!, status: 'cancelled' });
      },
    });

    await expect(dispatch(task)).rejects.toThrow(/went terminal before paste/);

    expect(runner.pastedPrompts).toEqual([]);
  });

  it('clears any leftover composer draft (space then C-c) before pasting the prompt', async () => {
    useRunner();
    const task = await seedDispatch();

    await expect(dispatch(task)).resolves.toBe(true);

    const spaceIdx = cmds().findIndex(c => c.includes('send-keys -l'));
    const ccIdx = cmds().findIndex(isCtrlC);
    const pasteIdx = cmds().findIndex(c => c.includes('paste-buffer'));
    expect(spaceIdx).toBeGreaterThanOrEqual(0);
    expect(ccIdx).toBeGreaterThan(spaceIdx);
    expect(pasteIdx).toBeGreaterThan(ccIdx);
  });

  it('clears a leftover draft whose text merely looks busy: an idle title plus a static frame rules out a running turn', async () => {
    const runner = useRunner({ agents: { 'dev-1': { title: IDLE_TITLE, screen: BUSY_LOOKING_DRAFT } } });
    const task = await seedDispatch();

    await expect(continueDispatch(task)).resolves.toBe(true);

    expect(literals()).toHaveLength(1);
    expect(ctrlCs()).toHaveLength(1);
    expect(runner.pastedPrompts).toHaveLength(1);
  });
});

describe('a pane already working at dispatch is fire-and-forget', () => {
  it.each<{ name: string; agent: NonNullable<FakeRunnerOptions['agents']>[string]; runtime?: AgentRuntimeKind }>([
    { name: 'a working title over a ready view', agent: { title: WORKING_TITLE } },
    { name: 'a working title over anchor-less soft-wrapped output', agent: { title: WORKING_TITLE, screen: 'soft-wrapped output without any anchor line\n' } },
    { name: 'a working title over a busy-looking leftover draft', agent: { title: WORKING_TITLE, screen: BUSY_LOOKING_DRAFT } },
    { name: 'a working title over a visibly busy frame', agent: { title: WORKING_TITLE, screen: '✶ Grooving… (30s · esc to interrupt)\n' } },
    { name: 'an advancing busy frame under an idle title (no liveness gate)', agent: { title: IDLE_TITLE, workingTitle: IDLE_TITLE, screen: WORKING_FRAME, interrupt: 'ignored-live' } },
    { name: 'a working frame with a working title', agent: { title: WORKING_TITLE, screen: WORKING_FRAME } },
    { name: 'a qodercli single-dot braille spinner', agent: { screen: '⠁ Thinking...\nType your message or @path/to/file\n' }, runtime: 'qodercli' },
  ])('$name: the prompt is pasted without a composer clear, Enter once, no ack wait, no hold', async ({ agent, runtime }) => {
    const runner = useRunner({ runtime, agents: { 'dev-1': agent } }, { dispatchSettleTimeoutMs: 60 });
    const task = await seedDispatch();

    await expect(continueDispatch(task)).resolves.toBe(true);

    expect(runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining('token: tok-T1') }]);
    expect(literals()).toEqual([]);
    expect(ctrlCs()).toEqual([]);
    expect(enters()).toHaveLength(1);
    expect(ackInterventions()).toEqual([]);
  });

  const workingPane = { agents: { 'dev-1': { title: WORKING_TITLE, screen: WORKING_FRAME } } };

  it('uncertain paste plus a failed buffer drop: no C-c, ack_unknown for a human to verify', async () => {
    useRunner({
      ...workingPane,
      rules: [
        { match: 'paste-buffer', reply: PANE_LOST },
        { match: 'delete-buffer', reply: { stderr: 'no buffer', exitCode: 1 } },
      ],
    });
    const task = await seedDispatch();

    await expect(continueDispatch(task, fenceOn(task, 'tok-T1'))).rejects.toSatisfy(isAckUnknown);

    expect(ctrlCs()).toEqual([]);
    expect(literals()).toEqual([]);
  });

  it('fence rejected before Enter: the prompt stays in the composer, no C-c, ack_unknown', async () => {
    let pasted = false;
    const task = await seedDispatch();
    const runner = useRunner({
      ...workingPane,
      onExec: async cmd => {
        if (cmd.includes('paste-buffer')) pasted = true;
        else if (pasted && isSnapshot(cmd)) await rotatePass(task, 'tok-T2');
      },
    });

    await expect(continueDispatch(task, fenceOn(task, 'tok-T1'))).rejects.toMatchObject({
      reason: 'ack_unknown',
      message: expect.stringMatching(/stays in the composer of working pane/),
    });

    expect(runner.pastedPrompts).toHaveLength(1);
    expect(pane().composer).toContain('token: tok-T1');
    expect(ctrlCs()).toEqual([]);
    expect(enters()).toEqual([]);
  });

  it('a pre-Enter capture failure on a working pane skips the reuse scrub: no C-c, ack_unknown', async () => {
    let snaps = 0;
    useRunner({ ...workingPane, rules: [{ match: cmd => isSnapshot(cmd) && ++snaps > 1, reply: PANE_LOST }] });
    const task = await seedDispatch();

    await expect(continueDispatch(task)).rejects.toSatisfy(isAckUnknown);

    expect(ctrlCs()).toEqual([]);
    expect(literals()).toEqual([]);
    expect(enters()).toEqual([]);
  });
});
