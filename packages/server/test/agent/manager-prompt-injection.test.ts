import { describe, it, expect, vi } from 'vitest';
import type { BaxianEvent } from '../../src/shared/index.js';
import { AgentManager, DispatchTerminalError } from '../../src/agent/manager.js';
import type { CommandRunner, ExecResult } from '../../src/agent/runner.js';
import { TmuxManager } from '../../src/agent/tmux.js';
import {
  callInjectAndAwaitAck,
  createManagerSuiteRunner,
  useManagerSuiteHarness,
  type AckResult,
} from '../helpers/manager-harness.js';

function makeInjectManager(runner: CommandRunner, ackMs: number, settleMs: number, resendMs?: number): AgentManager {
  const mgr = harness.createManager({
    runnerFactory: () => runner,
    dispatchAckTimeoutMs: ackMs,
    dispatchSettleTimeoutMs: settleMs,
  });
  Object.assign(mgr, { runtimeLivenessProbeMs: 1, ...(resendMs === undefined ? {} : { dispatchAckResendIntervalMs: resendMs }) });
  return mgr;
}

function ackInterventions(): BaxianEvent[] {
  return harness.events.filter(
    e => e.type === 'human.intervention' && (e.data as { phase?: string }).phase === 'dispatch-ack-timeout',
  );
}

type SnapRunner = CommandRunner & { sawEnter: () => boolean };

function snapRunner(
  frame: (enterSent: boolean) => string,
  scrollback: (enterSent: boolean) => number = () => 0,
): SnapRunner {
  let enterSent = false;
  return {
    exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('history_size')) {
        return { stdout: `BX_PANE_OK|${scrollback(enterSent)}\n${frame(enterSent)}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OK\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    writeFile: vi.fn(async (): Promise<void> => undefined),
    execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    sawEnter: () => enterSent,
  } as unknown as SnapRunner;
}

async function runAck(
  runner: CommandRunner,
  opts: {
    ackMs: number;
    settleMs: number;
    prompt?: string;
    lock?: boolean;
    resendMs?: number;
    guard?: () => Promise<boolean>;
  } = { ackMs: 150, settleMs: 150 },
): Promise<{ result?: AckResult; caught?: unknown; taskId: string }> {
  const localManager = makeInjectManager(runner, opts.ackMs, opts.settleMs, opts.resendMs);
  const t = await harness.seedTask();
  await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
  if (opts.lock !== false) await harness.acquireAgentLock('dev-1');
  const tmux = new TmuxManager(runner);
  try {
    const result = await callInjectAndAwaitAck(
      localManager, tmux, '%0', opts.prompt ?? 'hello prompt', 'dev-1', 'claude-code', opts.guard,
    );
    return { result, taskId: t.id };
  } catch (caught) {
    return { caught, taskId: t.id };
  }
}
const harness = useManagerSuiteHarness();

describe('injectAndAwaitAck pre-paste generation guard', () => {
  it('aborts between the pane mutex and the paste when the replay generation moved on', async () => {
    const localManager = makeInjectManager(createManagerSuiteRunner(), 150, 150);
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    const injectSpy = vi.spyOn(TmuxManager.prototype, 'injectPrompt').mockResolvedValue(undefined);
    const guard = vi.fn<[], Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    const result = await callInjectAndAwaitAck(
      localManager, new TmuxManager(createManagerSuiteRunner()), '%0', 'prompt', 'dev-1', 'claude-code', guard,
    );

    expect(result).toEqual({ acked: false, composerDelivered: false, aborted: true });
    expect(injectSpy).not.toHaveBeenCalled();
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it('re-checks the fence inside the paste and never issues the remote paste command', async () => {
    const runner = createManagerSuiteRunner();
    const localManager = makeInjectManager(runner, 150, 150);
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    const guard = vi.fn<[], Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    const result = await callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', guard,
    );

    expect(result).toEqual({ acked: false, composerDelivered: false, aborted: true });
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    expect(cmds.some(cmd => cmd.includes('paste-buffer'))).toBe(false);
    expect(guard).toHaveBeenCalledTimes(3);
  });

  it('a rotation landing during the staging exec aborts before the paste ever starts', async () => {
    const t = await harness.seedTask({ signalToken: 'stage-T1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    const base = createManagerSuiteRunner();
    const runner = {
      ...base,
      execWithStdin: vi.fn(async (cmd: string, stdin: Buffer) => {
        if (cmd.includes('load-buffer')) {
          const fresh = await harness.taskStore.get(t.id);
          await harness.taskStore.set({ ...fresh!, signalToken: 'stage-T2' });
        }
        return (base.execWithStdin as (cmd: string, stdin: Buffer) => Promise<ExecResult>)(cmd, stdin);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 150, 150);
    const guard = async (): Promise<boolean> =>
      (await harness.taskStore.get(t.id))?.signalToken === 'stage-T1';

    const result = await callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', guard,
    );

    expect(result).toEqual({ acked: false, composerDelivered: false, aborted: true });
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    expect(cmds.some(cmd => cmd.includes('paste-buffer'))).toBe(false);
  });

  it('serializes the final fence and the paste against task mutations', async () => {
    const t = await harness.seedTask({ signalToken: 'lock-T1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    let releasePaste!: () => void;
    const pasteGate = new Promise<void>((resolve) => { releasePaste = resolve; });
    const base = createManagerSuiteRunner();
    const runner = {
      ...base,
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('paste-buffer')) await pasteGate;
        return (base.exec as (cmd: string) => Promise<ExecResult>)(cmd);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 150, 150);
    const guard = async (): Promise<boolean> =>
      (await harness.taskStore.get(t.id))?.signalToken === 'lock-T1';

    const ackPromise = callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', guard,
    );
    const pasteStarted = (): boolean =>
      (runner.exec as ReturnType<typeof vi.fn>).mock.calls.some(call => String(call[0]).includes('paste-buffer'));
    for (let i = 0; i < 400 && !pasteStarted(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(pasteStarted()).toBe(true);

    let rotated = false;
    const rotatePromise = localManager
      .updateTask(t.id, { signalToken: 'lock-T2' })
      .then(() => { rotated = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rotated).toBe(false);

    releasePaste();
    const result = await ackPromise;
    await rotatePromise;

    expect(rotated).toBe(true);
    expect((await harness.taskStore.get(t.id))?.signalToken).toBe('lock-T2');
    expect(result).toEqual({ acked: false, composerDelivered: false, aborted: true });
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    expect(cmds.some(cmd => cmd.includes('send-keys') && cmd.includes('Enter'))).toBe(false);
  });

  it('cleans up the staged buffer when the paste exec fails', async () => {
    const t = await harness.seedTask({ signalToken: 'fail-T1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    const base = createManagerSuiteRunner();
    const runner = {
      ...base,
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('paste-buffer')) return { stdout: '', stderr: 'pane vanished', exitCode: 1 };
        return (base.exec as (cmd: string) => Promise<ExecResult>)(cmd);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 150, 150);

    await expect(callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', async () => true,
    )).rejects.toThrow(/pane vanished/);
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    expect(cmds.some(cmd => cmd.includes('delete-buffer'))).toBe(true);
  });

  it('cleans up the staged buffer when the paste transport dies with an unknown outcome', async () => {
    const t = await harness.seedTask({ signalToken: 'lost-T1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    const base = createManagerSuiteRunner();
    const runner = {
      ...base,
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('paste-buffer')) throw new Error('ssh transport lost');
        return (base.exec as (cmd: string) => Promise<ExecResult>)(cmd);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 150, 150);

    await expect(callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', async () => true,
    )).rejects.toThrow(/ssh transport lost/);
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    expect(cmds.some(cmd => cmd.includes('delete-buffer'))).toBe(true);
  });

  it('reconciles a consumed buffer after an unknown paste outcome by scrubbing the composer', async () => {
    const t = await harness.seedTask({ signalToken: 'unknown-T1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    const base = createManagerSuiteRunner();
    const runner = {
      ...base,
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('paste-buffer')) throw new Error('ssh reply lost');
        if (cmd.includes('delete-buffer')) return { stdout: '', stderr: 'no buffer', exitCode: 1 };
        return (base.exec as (cmd: string) => Promise<ExecResult>)(cmd);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 150, 150);

    await expect(callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', async () => true,
    )).rejects.toThrow(/ssh reply lost/);
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    const composerScrubs = cmds.filter(cmd => cmd.includes('send-keys') && cmd.includes('C-c'));
    expect(composerScrubs.length).toBeGreaterThanOrEqual(2);
  });

  it('ack resends re-check the fence and never re-submit a rotated composer', async () => {
    const t = await harness.seedTask({ signalToken: 'resend-T1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    const base = createManagerSuiteRunner();
    const runner = {
      ...base,
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          const fresh = await harness.taskStore.get(t.id);
          await harness.taskStore.set({ ...fresh!, signalToken: 'resend-T2' });
        }
        return (base.exec as (cmd: string) => Promise<ExecResult>)(cmd);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 400, 150);
    Object.assign(localManager, { dispatchAckResendIntervalMs: 30 });
    const guard = async (): Promise<boolean> =>
      (await harness.taskStore.get(t.id))?.signalToken === 'resend-T1';

    const result = await callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', guard,
    );

    expect(result).toEqual({ acked: false, composerDelivered: false, aborted: true });
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    const enterSends = cmds.filter(cmd => cmd.includes('send-keys') && cmd.includes('Enter'));
    expect(enterSends).toHaveLength(1);
    const composerScrubs = cmds.filter(cmd => cmd.includes('send-keys') && cmd.includes('C-c'));
    expect(composerScrubs.length).toBeGreaterThanOrEqual(2);
  });

  it('escalates when the stale composer cannot be scrubbed after a fence-rejected Enter', async () => {
    const t = await harness.seedTask({ signalToken: 'scrub-T1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    let pasted = false;
    let releaseSnapshot!: () => void;
    const snapGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const base = createManagerSuiteRunner();
    const runner = {
      ...base,
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('paste-buffer')) pasted = true;
        if (pasted && cmd.includes('history_size')) await snapGate;
        if (pasted && cmd.includes('send-keys') && cmd.includes('C-c')) {
          return { stdout: '', stderr: 'pane is gone', exitCode: 1 };
        }
        return (base.exec as (cmd: string) => Promise<ExecResult>)(cmd);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 150, 150);
    const guard = async (): Promise<boolean> =>
      (await harness.taskStore.get(t.id))?.signalToken === 'scrub-T1';

    const ackPromise = callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', guard,
    );
    for (let i = 0; i < 400 && !pasted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(pasted).toBe(true);
    await localManager.updateTask(t.id, { signalToken: 'scrub-T2' });
    releaseSnapshot();

    await expect(ackPromise).rejects.toThrow(/composer/);
  });

  it('aborts before Enter when the pass rotates after the paste', async () => {
    const t = await harness.seedTask({ signalToken: 'enter-T1' });
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    let pasted = false;
    let releaseSnapshot!: () => void;
    const snapGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const base = createManagerSuiteRunner();
    const runner = {
      ...base,
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('paste-buffer')) pasted = true;
        if (pasted && cmd.includes('history_size')) await snapGate;
        return (base.exec as (cmd: string) => Promise<ExecResult>)(cmd);
      }),
    } as unknown as CommandRunner;
    const localManager = makeInjectManager(runner, 150, 150);
    const guard = async (): Promise<boolean> =>
      (await harness.taskStore.get(t.id))?.signalToken === 'enter-T1';

    const ackPromise = callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', 'prompt', 'dev-1', 'claude-code', guard,
    );
    for (let i = 0; i < 400 && !pasted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(pasted).toBe(true);
    await localManager.updateTask(t.id, { signalToken: 'enter-T2' });
    releaseSnapshot();

    const result = await ackPromise;
    expect(result).toEqual({ acked: false, composerDelivered: false, aborted: true });
    const cmds = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    expect(cmds.some(cmd => cmd.includes('send-keys') && cmd.includes('Enter'))).toBe(false);
  });
});

describe('injectAndAwaitAck ack timeout', () => {
  it('emits human.intervention dispatch-ack-timeout, does not throw, does not send C-c after submit', async () => {
    const sentCommands: string[] = [];
    const stuckRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sentCommands.push(cmd);
        if (cmd.includes('capture-pane')) {
          const header = cmd.includes('history_size') ? 'BX_PANE_OK|42' : 'BX_PANE_OK';
          return { stdout: `${header}\nstuck-screen\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const localManager = harness.createManager({
      runnerFactory: () => stuckRunner,
      dispatchAckTimeoutMs: 50,
    });

    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    const tmux = new TmuxManager(stuckRunner);

    await expect(
      callInjectAndAwaitAck(localManager, tmux, '%0', 'hello prompt', 'dev-1', 'claude-code'),
    ).resolves.toEqual({ acked: false, composerDelivered: true });

    const interventions = ackInterventions();
    expect(interventions).toHaveLength(1);
    expect(interventions[0]).toMatchObject({
      type: 'human.intervention',
      projectId: 'proj',
      agentId: 'dev-1',
      taskId: t.id,
    });
    expect((interventions[0].data as { paneId?: string }).paneId).toBe('%0');

    const firstEnterIdx = sentCommands.findIndex(c => c.includes('send-keys') && c.includes('Enter'));
    expect(firstEnterIdx).toBeGreaterThanOrEqual(0);
    const postSubmitCc = sentCommands.slice(firstEnterIdx).filter(c => c.includes('send-keys') && c.includes('C-c'));
    expect(postSubmitCc).toHaveLength(0);

    expect((await harness.taskStore.get(t.id))?.status).toBe('in_progress');
    expect((await harness.agentStore.get('dev-1'))?.taskId).toBe(t.id);
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);

    const ackTimeoutEvent = interventions[0];
    expect((ackTimeoutEvent.data as { note?: string }).note).toMatch(/REPL did not acknowledge/);
  });

  it('injectAndAwaitAck re-sends Enter when the first is swallowed, then acks', async () => {
    let enterCount = 0;
    const flakyRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterCount++;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          const visible = enterCount >= 2 ? '✻ Working… (3s · esc to interrupt)\n' : 'idle composer\n';
          const header = cmd.includes('history_size') ? 'BX_PANE_OK|0' : 'BX_PANE_OK';
          return { stdout: `${header}\n${visible}`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const localManager = makeInjectManager(flakyRunner, 3000, 10);
    (localManager as unknown as { dispatchAckResendIntervalMs: number }).dispatchAckResendIntervalMs = 50;
    const tmux = new TmuxManager(flakyRunner);

    const result = await callInjectAndAwaitAck(localManager, tmux, '%0', 'hello prompt', 'dev-1', 'claude-code');

    expect(result).toEqual({ acked: true, composerDelivered: true });
    expect(enterCount).toBeGreaterThanOrEqual(2);
  });

  it('infrastructure failure during the post-Enter ack wait throws DispatchTerminalError, not human.intervention', async () => {
    let enterSent = false;
    const failingRunner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterSent = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          if (!enterSent) {
            const header = cmd.includes('history_size') ? 'BX_PANE_OK|10' : 'BX_PANE_OK';
            return { stdout: `${header}\nidle\n`, stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const { caught } = await runAck(failingRunner, { ackMs: 50, settleMs: 200, lock: false });
    expect(caught).toBeInstanceOf(DispatchTerminalError);
    expect(ackInterventions()).toHaveLength(0);
  });
});

describe('injectAndAwaitAck settles the pane before Enter', () => {
  it('settles the pane before Enter, then acks on submission evidence (idle→busy) after Enter', async () => {
    const order: string[] = [];
    const preEnter = [
      'box: read /img.png\n',
      'box: [Image #1]\n',
      'box: [Image #1]\n',
    ];
    let enterSent = false;
    let snap = 0;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterSent = true;
          order.push('enter');
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('history_size')) {
          order.push(enterSent ? 'snap-post' : 'snap-pre');
          const visible = enterSent
            ? 'box: [Image #1]\n✻ Thinking… (2s · esc to interrupt)\n'
            : preEnter[Math.min(snap++, preEnter.length - 1)];
          return { stdout: `BX_PANE_OK|0\n${visible}`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: 'BX_PANE_OK\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const { result } = await runAck(runner, { ackMs: 2000, settleMs: 2000 });

    expect(result).toEqual({ acked: true, composerDelivered: true });
    const enterIdx = order.indexOf('enter');
    expect(enterIdx).toBeGreaterThan(-1);
    const settleSnapsBeforeEnter = order.slice(0, enterIdx).filter(x => x === 'snap-pre').length;
    expect(settleSnapsBeforeEnter).toBeGreaterThanOrEqual(2);
    expect(order.indexOf('snap-post')).toBeGreaterThan(enterIdx);
  });
});

describe('injectAndAwaitAck never-settle + swallowed Enter is non-ackable', () => {
  it('does NOT false-ack from redraw deltas when the runtime never goes busy', async () => {
    let n = 0;
    let enterSent = false;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          enterSent = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('history_size')) {
          return { stdout: `BX_PANE_OK|0\nframe ${n++}\n`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: `BX_PANE_OK\ncomposer still open ${n++}\n[Image #1] attaching\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const { result, taskId } = await runAck(runner, { ackMs: 60, settleMs: 60 });

    expect(result).toEqual({ acked: false, composerDelivered: true });
    expect(enterSent).toBe(true);
    expect(ackInterventions()).toHaveLength(1);
    expect((await harness.taskStore.get(taskId))?.status).toBe('in_progress');
    expect(await harness.lockManager.isLocked('dev-1')).toBe(true);
  });
});

describe('injectAndAwaitAck post-approve edge cases', () => {
  it('acks a quick task on its brief idle-to-busy flash after Enter', async () => {
    const runner = snapRunner(enterSent => (enterSent ? '✻ Working… (3s · esc to interrupt)\n' : 'composer\n'), () => 5);
    const { result } = await runAck(runner, { ackMs: 1000, settleMs: 1000 });
    expect(result).toEqual({ acked: true, composerDelivered: true });
    expect(runner.sawEnter()).toBe(true);
  });

  it('does NOT ack on scrollback growth from an uncommitted attach redraw when runtime never gets busy', async () => {
    let h = 5;
    const runner = snapRunner(() => 'composer still open\n', enterSent => (enterSent ? ++h : h));
    const { result } = await runAck(runner, { ackMs: 150, settleMs: 80 });
    expect(result).toEqual({ acked: false, composerDelivered: true });
    expect(runner.sawEnter()).toBe(true);
    expect(ackInterventions()).toHaveLength(1);
  });

  it('a failed sendEnter is raw cleanup, not ack_unknown', async () => {
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('send-keys') && cmd.includes('Enter')) {
          return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
        }
        if (cmd.includes('history_size')) {
          return { stdout: 'BX_PANE_OK|5\nidle\n', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: 'BX_PANE_OK\nidle\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const { caught } = await runAck(runner, { ackMs: 100, settleMs: 100 });
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
  });

  it('does NOT ack on busy text that was already in the pasted prompt when Enter is swallowed', async () => {
    const screen = `do X\n  esc to interrupt\n`;
    let pasted = false;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('paste-buffer')) {
          pasted = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (cmd.includes('history_size')) {
          return { stdout: `BX_PANE_OK|3\n${pasted ? screen : '❯ \n'}`, stderr: '', exitCode: 0 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: `BX_PANE_OK\n${pasted ? screen : '❯ \n'}`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const { result } = await runAck(runner, { ackMs: 150, settleMs: 150, prompt: 'do X\n  esc to interrupt' });
    expect(result).toEqual({ acked: false, composerDelivered: true });
    expect(ackInterventions()).toHaveLength(1);
  });

  it('a pre-Enter settle/capture failure is not ack_unknown and never sends Enter', async () => {
    const sent: string[] = [];
    let snaps = 0;
    const runner: CommandRunner = {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sent.push(cmd);
        if (cmd.includes('history_size')) {
          snaps++;
          if (snaps === 1) return { stdout: 'BX_PANE_OK|1\ncomposer\n', stderr: '', exitCode: 0 };
          return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
        }
        if (cmd.includes('capture-pane')) {
          return { stdout: 'BX_PANE_OK\ncomposer\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    };
    const { caught } = await runAck(runner, { ackMs: 150, settleMs: 150 });
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
    const enterCmds = sent.filter(c => c.includes('send-keys') && c.includes('Enter'));
    expect(enterCmds).toHaveLength(0);
  });
});

describe('injectAndAwaitAck makes the pane reuse-safe on pre-Enter failure', () => {
  const ccCmds = (sent: string[]): string[] =>
    sent.filter(c => c.includes('send-keys') && c.includes('C-c'));
  const hasSessionCmds = (sent: string[]): string[] =>
    sent.filter(c => c.includes('has-session'));

  function recordRunner(sent: string[], respond: (cmd: string) => ExecResult | undefined): CommandRunner {
    return {
      exec: vi.fn(async (cmd: string): Promise<ExecResult> => {
        sent.push(cmd);
        return respond(cmd) ?? { stdout: '', stderr: '', exitCode: 0 };
      }),
      writeFile: vi.fn(async (): Promise<void> => undefined),
      execWithStdin: vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 })),
    } as unknown as CommandRunner;
  }

  it('clears the composer draft after a pre-Enter capture failure → raw, never Enter, no kill probe', async () => {
    const sent: string[] = [];
    let snaps = 0;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('history_size')) {
        snaps++;
        if (snaps === 1) return { stdout: 'BX_PANE_OK|1\ncomposer\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OK\ncomposer\n', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    const { caught } = await runAck(runner);
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
    expect(ccCmds(sent)).toHaveLength(2);
    expect(hasSessionCmds(sent)).toHaveLength(0);
    expect(sent.filter(c => c.includes('send-keys') && c.includes('Enter'))).toHaveLength(0);
  });

  it.each([
    {
      name: 'clears the composer draft after a failed sendEnter → raw',
      onHasSession: undefined as ExecResult | undefined,
      failKeys: 'enter' as 'enter' | 'all',
      sendKeys: { stdout: '', stderr: 'no such pane: %0', exitCode: 1 },
      expectAckUnknown: false,
      expectCc: 2,
      hasSessionCount: undefined as number | undefined,
    },
    {
      name: 'a transient reuse-clear failure on a still-live session escalates to ack_unknown (no blind C-c)',
      onHasSession: { stdout: '', stderr: '', exitCode: 0 },
      failKeys: 'after-preclear' as 'enter' | 'after-preclear',
      sendKeys: { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 1 },
      expectAckUnknown: true,
      expectCc: 1,
      hasSessionCount: 1,
    },
    {
      name: 'a reuse-clear failure on a CONFIRMED-DEAD session is reuse-safe → raw (next dispatch rebuilds fresh)',
      onHasSession: { stdout: '', stderr: "can't find session: dev-1", exitCode: 1 },
      failKeys: 'after-preclear' as 'enter' | 'after-preclear',
      sendKeys: { stdout: '', stderr: 'no such pane: %0', exitCode: 1 },
      expectAckUnknown: false,
      expectCc: 1,
      hasSessionCount: 1,
    },
    {
      name: 'an UNCONFIRMABLE session (reuse clear fails AND has-session probe fails) escalates to ack_unknown',
      onHasSession: { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 2 },
      failKeys: 'after-preclear' as 'enter' | 'after-preclear',
      sendKeys: { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 1 },
      expectAckUnknown: true,
      expectCc: 1,
      hasSessionCount: 1,
    },
  ])('$name', async ({ onHasSession, failKeys, sendKeys, expectAckUnknown, expectCc, hasSessionCount }) => {
    const sent: string[] = [];
    let sendKeysSeen = 0;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('has-session')) return onHasSession;
      if (cmd.includes('send-keys')) {
        sendKeysSeen++;
        const preClearDone = sendKeysSeen > 2;
        if (failKeys === 'after-preclear' ? preClearDone : cmd.includes('Enter')) return sendKeys;
      }
      if (cmd.includes('history_size')) return { stdout: 'BX_PANE_OK|5\nidle\n', stderr: '', exitCode: 0 };
      if (cmd.includes('capture-pane')) return { stdout: 'BX_PANE_OK\nidle\n', stderr: '', exitCode: 0 };
      return undefined;
    });
    const { caught } = await runAck(runner);
    if (expectAckUnknown) {
      expect(caught).toBeInstanceOf(DispatchTerminalError);
      expect((caught as DispatchTerminalError).reason).toBe('ack_unknown');
    } else {
      expect(caught).toBeInstanceOf(Error);
      expect(caught instanceof DispatchTerminalError && caught.reason === 'ack_unknown').toBe(false);
    }
    expect(ccCmds(sent)).toHaveLength(expectCc);
    if (hasSessionCount !== undefined) expect(hasSessionCmds(sent)).toHaveLength(hasSessionCount);
  });

  it('does NOT touch the composer on a post-Enter ack_unknown — the prompt may be running', async () => {
    const sent: string[] = [];
    let enterSent = false;
    let enterIdx = -1;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        enterIdx = sent.length - 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane') || cmd.includes('display-message')) {
        if (!enterSent) {
          const header = cmd.includes('history_size') ? 'BX_PANE_OK|10' : 'BX_PANE_OK';
          return { stdout: `${header}\nidle\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
      }
      return undefined;
    });
    const { caught } = await runAck(runner);
    expect(caught).toBeInstanceOf(DispatchTerminalError);
    expect((caught as DispatchTerminalError).reason).toBe('ack_unknown');
    expect(enterIdx).toBeGreaterThanOrEqual(0);
    expect(ccCmds(sent.slice(enterIdx))).toHaveLength(0);
    expect(hasSessionCmds(sent)).toHaveLength(0);
  });

  it('does NOT touch the composer on a clean ack', async () => {
    const sent: string[] = [];
    let enterSent = false;
    let enterIdx = -1;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        enterIdx = sent.length - 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('history_size')) {
        const visible = enterSent ? '✻ Working… (3s · esc to interrupt)\n' : 'composer\n';
        return { stdout: `BX_PANE_OK|5\n${visible}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OK\ncomposer\n', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    const { result } = await runAck(runner);
    expect(result).toEqual({ acked: true, composerDelivered: true });
    expect(enterIdx).toBeGreaterThanOrEqual(0);
    expect(ccCmds(sent.slice(enterIdx))).toHaveLength(0);
    expect(hasSessionCmds(sent)).toHaveLength(0);
  });

  it('clears any leftover composer draft (space then C-c) before pasting the prompt', async () => {
    const sent: string[] = [];
    let enterSent = false;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('history_size')) {
        const visible = enterSent ? '✻ Working… (3s · esc to interrupt)\n' : 'composer\n';
        return { stdout: `BX_PANE_OK|5\n${visible}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OK\ncomposer\n', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    const { result } = await runAck(runner);
    expect(result).toEqual({ acked: true, composerDelivered: true });
    const spaceIdx = sent.findIndex(c => c.includes('send-keys -l'));
    const ccIdx = sent.findIndex(c => c.includes('send-keys') && c.includes('C-c'));
    const pasteIdx = sent.findIndex(c => c.includes('paste-buffer'));
    expect(spaceIdx).toBeGreaterThanOrEqual(0);
    expect(ccIdx).toBeGreaterThan(spaceIdx);
    expect(pasteIdx).toBeGreaterThan(ccIdx);
  });

  it('aborts the dispatch without pasting when the pre-inject composer clear fails (unconfirmed clear must not paste onto a leftover draft)', async () => {
    const sent: string[] = [];
    let pasted = false;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('send-keys -l')) {
        return { stdout: '', stderr: 'ssh: connect: connection timed out', exitCode: 1 };
      }
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OK\ncomposer\n', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    const { caught } = await runAck(runner);
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/guarded write/);
    expect(pasted).toBe(false);
    expect(sent.filter(c => c.includes('send-keys') && c.includes('Enter'))).toHaveLength(0);
  });

  it('herdr: a working title beats a visible ready view (no arbitration) — paste proceeds without a composer clear', async () => {
    const sent: string[] = [];
    let pasted = false;
    let enterSent = false;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) {
        return { stdout: 'BX_PANE_OK⠹ Grooving…\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane') && !cmd.includes('history_size')) {
        return { stdout: 'BX_PANE_OK\n❯ \n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('history_size')) {
        const visible = enterSent ? '✻ Working… (3s · esc to interrupt)\n' : '❯ \n';
        return { stdout: `BX_PANE_OK|5\n${visible}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    await runAck(runner);
    expect(pasted).toBe(true);
    expect(sent.filter(c => c.includes('send-keys -l'))).toHaveLength(0);
    expect(ccCmds(sent)).toHaveLength(0);
  });

  it('herdr: a working OSC title no longer aborts dispatch — paste proceeds fire-and-forget without a composer clear', async () => {
    const sent: string[] = [];
    let pasted = false;
    let captures = 0;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) {
        return { stdout: 'BX_PANE_OK⠹ Grooving…\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('history_size')) {
        return { stdout: 'BX_PANE_OK|0\nsoft-wrapped output without any anchor line\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        captures++;
        return { stdout: `BX_PANE_OK\nsoft-wrapped output without any anchor line ${captures}\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      return undefined;
    });
    const { caught } = await runAck(runner);
    expect(caught).toBeUndefined();
    expect(pasted).toBe(true);
    expect(ccCmds(sent)).toHaveLength(0);
    expect(sent.filter(c => c.includes('send-keys -l'))).toHaveLength(0);
  });

  it('herdr: under a working title the draft is NOT cleared — the prompt is pasted directly (fire-and-forget)', async () => {
    const sent: string[] = [];
    let pasted = false;
    let enterSent = false;
    const DRAFT = '› 排查 codex 卡死，日志：\n  • Working (12s)\n  esc to interrupt\n';
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) {
        return { stdout: 'BX_PANE_OK⠹ Grooving…\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane') && !cmd.includes('history_size')) {
        return { stdout: `BX_PANE_OK\n${DRAFT}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('history_size')) {
        const visible = enterSent ? '✻ Working… (3s · esc to interrupt)\n' : '❯ \n';
        return { stdout: `BX_PANE_OK|5\n${visible}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    await runAck(runner);
    expect(pasted).toBe(true);
    expect(sent.filter(c => c.includes('send-keys -l'))).toHaveLength(0);
    expect(ccCmds(sent)).toHaveLength(0);
  });

  it('herdr: a visibly busy pane no longer aborts dispatch — paste proceeds without a composer clear', async () => {
    const sent: string[] = [];
    let pasted = false;
    let captures = 0;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) {
        return { stdout: 'BX_PANE_OK⠹ Grooving…\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('history_size')) {
        return { stdout: 'BX_PANE_OK|0\n✶ Grooving… (30s · esc to interrupt)\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        captures++;
        return { stdout: `BX_PANE_OK\n✶ Grooving… (${12 + captures}s · esc to interrupt)\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      return undefined;
    });
    const { caught } = await runAck(runner);
    expect(caught).toBeUndefined();
    expect(pasted).toBe(true);
    expect(sent.filter(c => c.includes('send-keys -l'))).toHaveLength(0);
    expect(ccCmds(sent)).toHaveLength(0);
  });

  it('clears a leftover draft whose text merely looks busy: an idle title plus a static frame rules out a running turn', async () => {
    const sent: string[] = [];
    let pasted = false;
    let enterSent = false;
    const DRAFT = '❯ 排查 codex 卡死，日志：\n  • Working (12s)\n  esc to interrupt\n';
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) {
        return { stdout: 'BX_PANE_OKdev-1\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane') && !cmd.includes('history_size')) {
        return { stdout: `BX_PANE_OK\n${DRAFT}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('history_size')) {
        const visible = enterSent ? '✻ Working… (3s · esc to interrupt)\n' : '❯ \n';
        return { stdout: `BX_PANE_OK|5\n${visible}`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      if (cmd.includes('send-keys') && cmd.includes('Enter')) {
        enterSent = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    await runAck(runner);
    expect(pasted).toBe(true);
    expect(sent.filter(c => c.includes('send-keys -l'))).toHaveLength(1);
    expect(ccCmds(sent)).toHaveLength(1);
  });

  it('herdr: no liveness gate — an advancing frame with an idle title still dispatches', async () => {
    const sent: string[] = [];
    let pasted = false;
    let captures = 0;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) {
        return { stdout: 'BX_PANE_OKdev-1\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('history_size')) {
        return { stdout: 'BX_PANE_OK|0\n✶ Grooving… (30s)\n  esc to interrupt\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('capture-pane')) {
        captures++;
        return { stdout: `BX_PANE_OK\n✶ Grooving… (${12 + captures}s)\n  esc to interrupt\n`, stderr: '', exitCode: 0 };
      }
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      return undefined;
    });
    const { caught } = await runAck(runner);
    expect(caught).toBeUndefined();
    expect(pasted).toBe(true);
  });

  const WORKING_FRAME = '✻ Working… (12s · esc to interrupt)\n';

  it('working pane + 粘贴结果不确定 + buffer 删除失败:不发 C-c,转 ack_unknown 交人工核验', async () => {
    const sent: string[] = [];
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) return { stdout: 'BX_PANE_OK⠹ Grooving…\n', stderr: '', exitCode: 0 };
      if (cmd.includes('history_size')) return { stdout: `BX_PANE_OK|0\n${WORKING_FRAME}`, stderr: '', exitCode: 0 };
      if (cmd.includes('capture-pane')) return { stdout: `BX_PANE_OK\n${WORKING_FRAME}`, stderr: '', exitCode: 0 };
      if (cmd.includes('paste-buffer')) return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
      if (cmd.includes('delete-buffer')) return { stdout: '', stderr: 'no buffer', exitCode: 1 };
      return undefined;
    });
    const guard = vi.fn<[], Promise<boolean>>().mockResolvedValue(true);
    const { caught } = await runAck(runner, { ackMs: 150, settleMs: 150, guard });

    expect(caught).toBeInstanceOf(DispatchTerminalError);
    expect((caught as DispatchTerminalError).reason).toBe('ack_unknown');
    expect(ccCmds(sent)).toHaveLength(0);
    expect(sent.filter(c => c.includes('send-keys -l'))).toHaveLength(0);
  });

  it('working pane + fence 拒绝:不发 C-c,转 ack_unknown', async () => {
    const sent: string[] = [];
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) return { stdout: 'BX_PANE_OK⠹ Grooving…\n', stderr: '', exitCode: 0 };
      if (cmd.includes('history_size')) return { stdout: `BX_PANE_OK|0\n${WORKING_FRAME}`, stderr: '', exitCode: 0 };
      if (cmd.includes('capture-pane')) return { stdout: `BX_PANE_OK\n${WORKING_FRAME}`, stderr: '', exitCode: 0 };
      return undefined;
    });
    // guard 依次在:外层、steps 入口、paste 锁、submit 锁被调用,最后一次拒绝 = Enter 前 fence 拒绝
    const guard = vi.fn<[], Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const { caught } = await runAck(runner, { ackMs: 150, settleMs: 150, guard });

    expect(caught).toBeInstanceOf(DispatchTerminalError);
    expect((caught as DispatchTerminalError).reason).toBe('ack_unknown');
    expect(ccCmds(sent)).toHaveLength(0);
    expect(sent.filter(c => c.includes('send-keys -l'))).toHaveLength(0);
  });

  it.each<['opencode' | 'qodercli', string]>([
    ['opencode', '帮我看下 esc to interrupt 这个判定'],
    ['qodercli', '文案里写的是 (esc to cancel, 要不要改'],
  ])('%s: idle pane 收到自带 working 关键字的提示词且 Enter 被吞 → 走超时并提人工介入,不得报已提交', async (runtime, prompt) => {
    const sent: string[] = [];
    // 粘贴后基线含提示词正文,自己命中 whole_recent 的 working 规则;Enter 被吞,屏幕此后不再变化
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) return { stdout: 'BX_PANE_OK\n', stderr: '', exitCode: 0 };
      if (cmd.includes('history_size')) return { stdout: `BX_PANE_OK|0\n${prompt}\n`, stderr: '', exitCode: 0 };
      if (cmd.includes('capture-pane')) return { stdout: 'BX_PANE_OK\nctrl+p commands\n', stderr: '', exitCode: 0 };
      return undefined;
    });
    const localManager = makeInjectManager(runner, 250, 60, 50);
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');

    const result = await callInjectAndAwaitAck(
      localManager, new TmuxManager(runner), '%0', prompt, 'dev-1', runtime,
    );

    expect(result.acked).toBe(false);
    expect(ackInterventions()).toHaveLength(1);
  });

  it('派发前就在 working 的 pane 仍然 fire-and-forget:不等 ack、不提人工介入', async () => {
    const sent: string[] = [];
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) return { stdout: 'BX_PANE_OK⠹ Grooving…\n', stderr: '', exitCode: 0 };
      if (cmd.includes('history_size')) return { stdout: `BX_PANE_OK|0\n${WORKING_FRAME}`, stderr: '', exitCode: 0 };
      if (cmd.includes('capture-pane')) return { stdout: `BX_PANE_OK\n${WORKING_FRAME}`, stderr: '', exitCode: 0 };
      return undefined;
    });
    const { result, caught } = await runAck(runner, { ackMs: 250, settleMs: 60, resendMs: 1 });

    expect(caught).toBeUndefined();
    expect(result).toEqual({ acked: true, composerDelivered: true });
    expect(ackInterventions()).toHaveLength(0);
    // 边界前置的结构性保证:working pane 完全不进入 ack/重发/清稿机制,Enter 只发一次,永不 C-c
    expect(ccCmds(sent)).toHaveLength(0);
    expect(sent.filter(c => c.includes('send-keys') && c.includes('Enter'))).toHaveLength(1);
  });

  it('working pane + Enter 前异常:不走 clearComposerForReuse 的 C-c,转 ack_unknown', async () => {
    const sent: string[] = [];
    let snaps = 0;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('pane_title')) return { stdout: 'BX_PANE_OK⠹ Grooving…\n', stderr: '', exitCode: 0 };
      if (cmd.includes('history_size')) {
        snaps++;
        if (snaps === 1) return { stdout: `BX_PANE_OK|0\n${WORKING_FRAME}`, stderr: '', exitCode: 0 };
        return { stdout: '', stderr: 'no such pane: %0', exitCode: 1 };
      }
      if (cmd.includes('capture-pane')) return { stdout: `BX_PANE_OK\n${WORKING_FRAME}`, stderr: '', exitCode: 0 };
      return undefined;
    });

    const { caught } = await runAck(runner, { ackMs: 150, settleMs: 60 });

    expect(caught).toBeInstanceOf(DispatchTerminalError);
    expect((caught as DispatchTerminalError).reason).toBe('ack_unknown');
    expect(ccCmds(sent)).toHaveLength(0);
    expect(sent.filter(c => c.includes('send-keys -l'))).toHaveLength(0);
  });

  it('re-validates the binding after the pre-inject clear: a task cancelled during the clear is never pasted', async () => {
    const sent: string[] = [];
    let pasted = false;
    const runner = recordRunner(sent, cmd => {
      if (cmd.includes('paste-buffer')) {
        pasted = true;
        return undefined;
      }
      if (cmd.includes('capture-pane')) {
        return { stdout: 'BX_PANE_OK\n❯ \n', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    const localManager = makeInjectManager(runner, 150, 150);
    const t = await harness.seedTask();
    await harness.seedAgent({ id: 'dev-1', taskId: t.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1');
    const tmux = new TmuxManager(runner);
    vi.spyOn(TmuxManager.prototype, 'clearComposerDraft').mockImplementation(async () => {
      const cur = await harness.taskStore.get(t.id);
      if (cur) await harness.taskStore.set({ ...cur, status: 'cancelled' });
    });
    await expect(
      callInjectAndAwaitAck(localManager, tmux, '%0', 'hello prompt', 'dev-1', 'claude-code'),
    ).rejects.toThrow(/went terminal before paste/);
    expect(pasted).toBe(false);
  });
});

describe('injectAndAwaitAck: busy-looking baseline text is not busy under herdr — swallowed Enter surfaces as ack timeout', () => {
  it.each([
    {
      name: 'composer "clears" after submit but baseline was busy → still non-ackable',
      settleMs: 150,
      frames: () => (enterSent: boolean) => (enterSent ? 'running the task now\n' : 'review:\n  esc to interrupt\n'),
    },
    {
      name: 'swallowed Enter plus ongoing attach redraw is non-ackable',
      settleMs: 80,
      frames: () => { let n = 0; return () => `review:\n  esc to interrupt\n[Image #1] frame ${n++}\n`; },
    },
    {
      name: 'settled busy baseline plus late attach redraw and swallowed Enter is non-ackable',
      settleMs: 150,
      frames: () => { let post = 0; return (enterSent: boolean) => (enterSent ? `review:\n  esc to interrupt\n[Image #1] frame ${post++}\n` : 'review:\n  esc to interrupt\n'); },
    },
  ])('$name', async ({ frames, settleMs }) => {
    const runner = snapRunner(frames());
    const { result } = await runAck(runner, { ackMs: 150, settleMs, prompt: 'review:\n  esc to interrupt' });
    expect(result).toEqual({ acked: false, composerDelivered: true });
    expect(ackInterventions().length).toBeGreaterThanOrEqual(1);
  });
});
