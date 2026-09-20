import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentManagerDeps } from '../../src/agent/manager.js';
import { ReplNotReadyError } from '../../src/agent/tmux.js';
import { LocalRunner } from '../../src/agent/runner.js';
import { createManagerSuiteRunner, useManagerSuiteHarness, workdirsOf } from '../helpers/manager-harness.js';
import type { FakeRunner, FakeRunnerOptions } from '../helpers/fake-runner.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const SPACE_LITERAL = "'\\'' '\\''";
const COMMA_LITERAL = "'\\'','\\''";

const harness = useManagerSuiteHarness();

let runner: FakeRunner;
let onExec: FakeRunnerOptions['onExec'] | null;

function useRunner(options: FakeRunnerOptions = {}, deps: Partial<AgentManagerDeps> = {}): FakeRunner {
  runner = createManagerSuiteRunner({
    workdirs: workdirsOf(harness.config),
    ...options,
    onExec: (cmd, options) => onExec?.(cmd, options),
  });
  harness.manager = harness.createManager({ runnerFactory: () => runner, ...deps });
  return runner;
}

beforeEach(() => {
  onExec = null;
  useRunner();
});

const cmds = (): string[] => runner.exec.mock.calls.map(c => String(c[0]));
const idxOf = (calls: string[], match: (c: string) => boolean, from = 0): number =>
  calls.findIndex((c, i) => i >= from && match(c));

const isTitleRead = (c: string): boolean => c.includes('pane_title');
const isCapture = (c: string): boolean => c.includes('capture-pane');
const isLiteral = (c: string, body: string): boolean => c.includes('send-keys -l') && c.includes(body);

// 暂存走 execWithStdin,粘贴走 exec:跨两个 mock 的先后只能按全局调用序号比较
function orderOf(mock: FakeRunner['exec'] | FakeRunner['execWithStdin'], match: (c: string) => boolean): number {
  const i = mock.mock.calls.findIndex(c => match(String(c[0])));
  return i === -1 ? -1 : mock.mock.invocationCallOrder[i]!;
}

// 真实并发闸门:持有者卡在自己发出的某条 tmux 命令上,竞争方在公共入口的守卫处直接被拒
function gateOn(match: (cmd: string) => boolean): { release: () => void; hit: () => boolean } {
  let release!: () => void;
  let hit = false;
  const gate = new Promise<void>(r => { release = r; });
  onExec = async cmd => {
    if (hit || !match(cmd)) return;
    hit = true;
    await gate;
  };
  return { release, hit: () => hit };
}

// 守卫是否已释放只能从行为看:拿不到守卫的操作一律 409
function waitGuardFree(agentId: string): Promise<void> {
  return vi.waitFor(async () => {
    await harness.manager.attachImageToRunningAgent(agentId, PNG, 'png');
  }, { timeout: 5_000, interval: 5 });
}

async function seedLiveAgent(id = 'dev-1', paneId = '%0', extra = {}): Promise<void> {
  await harness.seedAgent({ id, paneId, ...extra });
}

describe('compactAgent', () => {
  it('waits for an idle prompt, clears the composer draft (space then C-c), then sends /compact + Enter', async () => {
    await seedLiveAgent();

    await harness.manager.compactAgent('dev-1');

    const calls = cmds();
    const spaceIdx = idxOf(calls, c => isLiteral(c, SPACE_LITERAL));
    const ccIdx = idxOf(calls, c => c.includes('send-keys') && c.includes('C-c'));
    const literalIdx = idxOf(calls, c => isLiteral(c, '/compact'));
    expect(spaceIdx).toBeGreaterThanOrEqual(0);
    expect(ccIdx).toBeGreaterThan(spaceIdx);
    expect(literalIdx).toBeGreaterThan(ccIdx);
    expect(calls[literalIdx]).toContain("'%0'");
    expect(calls[literalIdx]).toContain('Enter');
    // 提交确实落在 runtime 上:pane 进入 working,composer 已清空
    expect(runner.sessions.pane('dev-1')).toMatchObject({ phase: 'working', composer: '' });

    await waitGuardFree('dev-1');
  });

  it('rejects 409 when a compact for the same agent is already in flight, and releases the guard after', async () => {
    await seedLiveAgent();
    const gate = gateOn(c => c.includes('list-sessions'));
    const first = harness.manager.compactAgent('dev-1');
    await vi.waitFor(() => expect(gate.hit()).toBe(true));

    await expect(harness.manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });

    gate.release();
    await first;
    await waitGuardFree('dev-1');
    await expect(harness.manager.compactAgent('dev-1')).resolves.toBeUndefined();
  });

  it.each([
    {
      label: 're-dispatched (taskId changes)',
      reseed: () => harness.seedAgent({ id: 'dev-1', paneId: '%0', taskId: 'task-new' }),
    },
    {
      label: 'same-task re-dispatch bumps updatedAt',
      reseed: () => harness.seedAgent({ id: 'dev-1', paneId: '%0', taskId: 'task-1', updatedAt: '2026-06-12T08:00:01.000Z' }),
    },
    {
      label: 'pane is rebuilt',
      reseed: () => harness.seedAgent({ id: 'dev-1', paneId: '%9' }),
    },
  ])('rejects 409 and sends nothing when the $label during the wait', async ({ reseed }) => {
    await harness.seedAgent({ id: 'dev-1', paneId: '%0', taskId: 'task-1', updatedAt: '2026-06-12T08:00:00.000Z' });
    // 重新派单落在就绪等待期间:用第一次抓屏做交错点
    let done = false;
    onExec = async c => {
      if (done || !isCapture(c)) return;
      done = true;
      await reseed();
    };

    await expect(harness.manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('session changed'),
    });
    expect(cmds().some(c => c.includes('C-c') || c.includes('/compact'))).toBe(false);
  });

  it('rejects 409 without sending anything when the runtime is not at an idle prompt, and leaves a server-side trace', async () => {
    useRunner({}, { manualCompactWaitMs: 40 });
    await seedLiveAgent();
    // REPL 在就绪判定之后、清稿之前退出前台:探针读回的前台不再是 runtime
    let flipped = false;
    onExec = c => {
      if (flipped || !isTitleRead(c)) return;
      flipped = true;
      runner.sessions.setProcess('dev-1', 'vim');
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(harness.manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('not at an idle REPL prompt'),
    });
    expect(cmds().some(c => c.includes('/compact'))).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('sendSlashCommand(dev-1, /compact) before composer clear: runtime not at an idle prompt'),
      expect.any(Error),
    );
  });

  it('codex: dirties with a comma and sends C-c only after a cursor read shows the composer accepted it', async () => {
    await seedLiveAgent('qa-1', '%1');

    await harness.manager.compactAgent('qa-1');

    const calls = cmds();
    expect(calls.some(c => isLiteral(c, SPACE_LITERAL))).toBe(false);
    const commaIdx = idxOf(calls, c => isLiteral(c, COMMA_LITERAL));
    const ccIdx = idxOf(calls, c => c.includes('send-keys') && c.includes('C-c'));
    expect(commaIdx).toBeGreaterThanOrEqual(0);
    expect(calls[commaIdx]).toContain("'%1'");
    expect(ccIdx).toBeGreaterThan(commaIdx);
    expect(calls.slice(0, commaIdx).some(c => c.includes('cursor_x'))).toBe(true);
    expect(calls.slice(commaIdx + 1, ccIdx).some(c => c.includes('cursor_x'))).toBe(true);
    expect(idxOf(calls, c => isLiteral(c, '/compact'))).toBeGreaterThan(ccIdx);

    await waitGuardFree('qa-1');
  });

  it('codex: rejects 409, withholds C-c and logs when the cursor never moves (keystroke not yet in the composer)', async () => {
    await seedLiveAgent('qa-1', '%1');
    // 光标停住=弄脏键还没进 composer,空 composer 上的 C-c 会直接退出 codex
    useRunner({ rules: [{ match: 'cursor_x', reply: { stdout: 'BX_PANE_OK2|codex\n' } }] });
    await seedLiveAgent('qa-1', '%1');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(harness.manager.compactAgent('qa-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('composer could not be cleared'),
    });

    const calls = cmds();
    expect(calls.some(c => c.includes('send-keys') && c.includes('C-c'))).toBe(false);
    expect(calls.some(c => c.includes('/compact'))).toBe(false);
    expect(runner.sessions.pane('qa-1')?.process).toBe('codex');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('sendSlashCommand(qa-1, /compact) composer clear failed'),
      expect.any(ReplNotReadyError),
    );
  }, 15_000);

  it('rejects 409 when the agent has no live session (no paneId)', async () => {
    await harness.seedAgent({ id: 'dev-1' });
    await expect(harness.manager.compactAgent('dev-1')).rejects.toMatchObject({ status: 409 });
    expect(cmds().some(c => c.includes('send-keys'))).toBe(false);
  });

  it('rejects 404 for an unknown agent', async () => {
    await expect(harness.manager.compactAgent('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects image attach with 409 while a compact holds the guard', async () => {
    await seedLiveAgent();
    const gate = gateOn(c => c.includes('list-sessions'));
    const compact = harness.manager.compactAgent('dev-1');
    await vi.waitFor(() => expect(gate.hit()).toBe(true));

    await expect(harness.manager.attachImageToRunningAgent('dev-1', PNG, 'png')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('in progress'),
    });

    gate.release();
    await compact;
    await waitGuardFree('dev-1');
  });

  it('keeps the guard until the runtime is idle again after /compact, blocking uploads meanwhile', async () => {
    await seedLiveAgent();
    // /compact 提交后的空闲复核仍在跑:守卫必须继续挡住上传
    let submitted = false;
    const gate = gateOn(c => {
      if (isLiteral(c, '/compact')) submitted = true;
      return submitted && isCapture(c);
    });

    await harness.manager.compactAgent('dev-1');
    await vi.waitFor(() => expect(gate.hit()).toBe(true));

    await expect(harness.manager.attachImageToRunningAgent('dev-1', PNG, 'png')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('in progress'),
    });

    gate.release();
    await waitGuardFree('dev-1');
  });

  it('rejects manual compact while an image upload holds the guard, then allows it after the upload completes', async () => {
    await seedLiveAgent();
    let releaseWrite!: () => void;
    runner.writeFile.mockReturnValueOnce(new Promise<void>(r => { releaseWrite = r; }));
    const upload = harness.manager.attachImageToRunningAgent('dev-1', PNG, 'png');
    await vi.waitFor(() => expect(runner.writeFile).toHaveBeenCalled());

    await expect(harness.manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });
    expect(cmds().some(c => c.includes('C-c') || c.includes('/compact'))).toBe(false);

    releaseWrite();
    await upload;
    await expect(harness.manager.compactAgent('dev-1')).resolves.toBeUndefined();
  });

  it('rejects a second image upload while the first still holds the guard', async () => {
    await seedLiveAgent();
    let releaseWrite!: () => void;
    runner.writeFile.mockReturnValueOnce(new Promise<void>(r => { releaseWrite = r; }));
    const first = harness.manager.attachImageToRunningAgent('dev-1', PNG, 'png');
    await vi.waitFor(() => expect(runner.writeFile).toHaveBeenCalled());

    await expect(harness.manager.attachImageToRunningAgent('dev-1', PNG, 'png')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('in progress'),
    });

    releaseWrite();
    await first;
    expect(runner.pastedPrompts).toHaveLength(1);
  });

  it('releases the guard when an upload fails, so a later compact is not blocked', async () => {
    await seedLiveAgent();
    runner.writeFile.mockRejectedValueOnce(new Error('disk full'));

    await expect(harness.manager.attachImageToRunningAgent('dev-1', PNG, 'png')).rejects.toThrow('disk full');

    await expect(harness.manager.compactAgent('dev-1')).resolves.toBeUndefined();
  });

  it('rejects manual compact with 409 while a clear holds the guard', async () => {
    await seedLiveAgent();
    const gate = gateOn(c => c.includes('list-sessions'));
    const clear = harness.manager.clearAgent('dev-1');
    await vi.waitFor(() => expect(gate.hit()).toBe(true));

    await expect(harness.manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });

    gate.release();
    await clear;
    await waitGuardFree('dev-1');
  });
});

describe('clearAgent', () => {
  it('sends /clear instead of /compact', async () => {
    await seedLiveAgent();

    await harness.manager.clearAgent('dev-1');

    const calls = cmds();
    const literalIdx = idxOf(calls, c => isLiteral(c, '/clear'));
    expect(literalIdx).toBeGreaterThanOrEqual(0);
    expect(calls.some(c => c.includes('/compact'))).toBe(false);
    expect(calls[literalIdx]).toContain('Enter');
    // /clear 同时清掉会话上的任务上下文标记,下一次派单必须重发完整上下文
    expect(runner.sessions.option('dev-1', '@baxian-context-task-id')).toBe('');

    await waitGuardFree('dev-1');
  });

  it('dirties the composer with a comma before C-c for codex, so a leftover draft is cleared and an empty-composer C-c cannot kill the REPL', async () => {
    await seedLiveAgent('qa-1', '%1');

    await harness.manager.clearAgent('qa-1');

    const calls = cmds();
    expect(calls.some(c => c.includes('send-keys') && c.includes('Escape'))).toBe(false);
    const commaIdx = idxOf(calls, c => isLiteral(c, COMMA_LITERAL));
    const ccIdx = idxOf(calls, c => c.includes('send-keys') && c.includes('C-c'));
    const literalIdx = idxOf(calls, c => isLiteral(c, '/clear'));
    expect(commaIdx).toBeGreaterThanOrEqual(0);
    expect(ccIdx).toBeGreaterThan(commaIdx);
    expect(literalIdx).toBeGreaterThan(ccIdx);
    expect(calls[commaIdx]).toContain("'%1'");
    // codex 的 REPL 没有被空 composer 的 C-c 打死
    expect(runner.sessions.pane('qa-1')?.process).toBe('codex');

    await waitGuardFree('qa-1');
  });

  it('rejects 404 for an unknown agent', async () => {
    await expect(harness.manager.clearAgent('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects 409 when a compact is already in flight', async () => {
    await seedLiveAgent();
    const gate = gateOn(c => c.includes('list-sessions'));
    const compact = harness.manager.compactAgent('dev-1');
    await vi.waitFor(() => expect(gate.hit()).toBe(true));

    await expect(harness.manager.clearAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already in progress'),
    });

    gate.release();
    await compact;
    await waitGuardFree('dev-1');
  });
});

describe('manual context command latency and failure boundaries', () => {
  const isSnapshot = (cmd: string): boolean => cmd.includes('pane_title') && cmd.includes('capture-pane');

  it.each(['foreground', 'menu', 'transport'])('recovers from one transient %s observation before submitting', async fault => {
    let probes = 0;
    useRunner({ rules: [{
      match: cmd => isSnapshot(cmd) && ++probes === 2,
      reply: cmd => {
        if (fault === 'transport') throw new Error('ssh: connection reset');
        const marker = cmd.match(/BX_REPL_TITLE_[a-f0-9-]+/)![0];
        const current = fault === 'foreground' ? 'bash' : 'codex';
        const cap = fault === 'menu'
          ? 'permissions: YOLO mode\n\n› $bax\n  $baxian-task Dispatch\n\n  Press enter to insert or esc to close\n'
          : 'permissions: YOLO mode\n\n› \n';
        return { stdout: `BX_PANE_OK${current}\n${cap}${marker}\n` };
      },
    }] }, { manualCompactWaitMs: 100 });
    await seedLiveAgent('qa-1', '%1');
    await expect(harness.manager.clearAgent('qa-1')).resolves.toBeUndefined();
    expect(probes).toBe(8);
    expect(cmds().filter(cmd => isLiteral(cmd, '/clear'))).toHaveLength(1);
    await waitGuardFree('qa-1');
  });

  it('reports a deadline before submission as definitely not submitted and releases the guard immediately', async () => {
    await seedLiveAgent('qa-1', '%1');
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    onExec = cmd => { if (cmd.includes('set-option') && cmd.includes('@baxian-context-task-id')) now = 15_000; };
    try {
      await expect(harness.manager.clearAgent('qa-1')).rejects.toMatchObject({
        status: 409, message: expect.stringContaining('/clear was not submitted'),
      });
      expect(cmds().some(cmd => isLiteral(cmd, '/clear'))).toBe(false);
      await expect(harness.manager.attachImageToRunningAgent('qa-1', PNG, 'png')).resolves.toHaveProperty('path');
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['session', 'composerClear', 'diagnosis'])('exposes a deadline during %s as an actionable preparation failure', async phase => {
    useRunner(phase === 'diagnosis' ? { rules: [{ match: 'cursor_x', reply: { stdout: 'BX_PANE_OK2|bash\n' } }] } : {});
    await seedLiveAgent('qa-1', '%1');
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    onExec = cmd => {
      if ((phase === 'session' && cmd.includes('list-sessions'))
        || (phase === 'composerClear' && isLiteral(cmd, COMMA_LITERAL))
        || (phase === 'diagnosis' && cmd.includes('cursor_x'))) now = 15_000;
    };
    try {
      await expect(harness.manager.clearAgent('qa-1')).rejects.toMatchObject({
        status: 409, message: expect.stringContaining('/clear was not submitted'),
      });
      expect(cmds().some(cmd => isLiteral(cmd, '/clear'))).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['session', 'composerClear', 'diagnosis'])('exposes a running command timeout during %s without submitting', async phase => {
    let now = 0;
    let probes = 0;
    const stalled = (cmd: string): boolean => phase === 'session' ? cmd.includes('list-panes')
      : phase === 'composerClear' ? cmd.includes('cursor_x')
        : cmd.includes('capture-pane') && !isSnapshot(cmd);
    useRunner({ rules: [
      { match: stalled, reply: (_cmd, options) => new LocalRunner().exec('sleep 30', options) },
      { match: 'cursor_x', reply: { stdout: 'BX_PANE_OK2|bash\n' } },
    ] });
    await seedLiveAgent('qa-1', '%1');
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    onExec = cmd => {
      if ((phase === 'session' && cmd.includes('list-sessions'))
        || (phase === 'composerClear' && isSnapshot(cmd) && ++probes === 3)
        || (phase === 'diagnosis' && cmd.includes('cursor_x'))) now = 14_950;
    };
    try {
      await expect(harness.manager.clearAgent('qa-1')).rejects.toMatchObject({
        status: 409, message: expect.stringMatching(/\/clear was not submitted:.*Command timed out after 50ms/),
      });
      expect(cmds().some(cmd => isLiteral(cmd, '/clear'))).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ['replaced pane', 'BX_TARGET_GONE\n', 'identity condition failed'],
    ['malformed response', 'BX_PANE_OKcodex\n› prompt\n', 'incomplete snapshot'],
  ])('aborts immediately on a %s instead of retrying permanent failures', async (_label, stdout, message) => {
    useRunner({ rules: [{ match: isSnapshot, reply: { stdout } }] });
    await seedLiveAgent('qa-1', '%1');
    await expect(harness.manager.clearAgent('qa-1')).rejects.toMatchObject({
      status: 409, message: expect.stringContaining(message),
    });
    expect(cmds().filter(isSnapshot)).toHaveLength(1);
    expect(runner.sentKeys).toEqual([]);
  });

  it('reports unconfirmed idle and the last transient error when reads never recover', async () => {
    useRunner({ rules: [{ match: isSnapshot, reply: () => { throw new Error('ssh: connection reset'); } }] }, { manualCompactWaitMs: 40 });
    await seedLiveAgent('qa-1', '%1');
    await expect(harness.manager.clearAgent('qa-1')).rejects.toMatchObject({
      status: 409, message: expect.stringMatching(/stable idle not confirmed.*last observation: ssh: connection reset/),
    });
    expect(cmds().filter(isSnapshot).length).toBeGreaterThan(1);
    expect(runner.sentKeys).toEqual([]);
  });

  it('submits after 800ms of stable observations with production polling defaults', async () => {
    useRunner({}, { readyStableSpacingMs: undefined });
    await seedLiveAgent('qa-1', '%1');
    const binding = await harness.agentStore.get('qa-1');
    const get = vi.spyOn(harness.agentStore, 'get').mockResolvedValue(binding);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    try {
      const pending = harness.manager.clearAgent('qa-1');
      await vi.advanceTimersByTimeAsync(799);
      expect(cmds().some(cmd => isLiteral(cmd, '/clear'))).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(runner.sessions.pane('qa-1')?.phase).toBe('working');
      await vi.advanceTimersByTimeAsync(20);
    } finally {
      vi.useRealTimers();
      get.mockRestore();
    }
  });

  it.each(['compactAgent', 'clearAgent'] as const)('%s uses six combined idle observations and one guarded submission', async method => {
    await seedLiveAgent('qa-1', '%1');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});

    await harness.manager[method]('qa-1');

    const command = method === 'compactAgent' ? '/compact' : '/clear';
    const calls = runner.exec.mock.calls;
    const submitted = calls.findIndex(([cmd]) => isLiteral(cmd, command));
    const observations = calls.slice(0, submitted).filter(([cmd]) => isSnapshot(cmd));
    expect(observations).toHaveLength(6);
    expect(calls[submitted]![0]).toContain('Enter');
    for (const [, options] of calls.slice(0, submitted + 1)) {
      expect(options?.timeout).toBeGreaterThan(0);
      expect(options?.timeout).toBeLessThanOrEqual(5_000);
    }
    expect(runner.sessions.pane('qa-1')).toMatchObject({ phase: 'working', composer: '' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('timing:'), expect.objectContaining({
      outcome: 'submitted', session: expect.any(Number), readyBeforeClear: expect.any(Number),
      composerClear: expect.any(Number), readyAfterClear: expect.any(Number), submit: expect.any(Number),
    }));
    await waitGuardFree('qa-1');
  });

  it.each(['before', 'after'])('resets the idle streak on a busy frame %s composer cleanup', async phase => {
    await seedLiveAgent('qa-1', '%1');
    let cleared = false;
    let observations = 0;
    onExec = cmd => {
      if (cmd.includes('C-c')) cleared = true;
      if (!isSnapshot(cmd) || cleared !== (phase === 'after')) return;
      observations++;
      if (observations === 3) runner.sessions.markWorking('qa-1');
      else runner.sessions.setProcess('qa-1', 'codex');
    };

    await harness.manager.compactAgent('qa-1');

    expect(observations).toBe(6);
    expect(runner.sessions.pane('qa-1')?.phase).toBe('working');
    await waitGuardFree('qa-1');
  });

  it('withholds the command when idle frames never become stable', async () => {
    useRunner({}, { manualCompactWaitMs: 60 });
    await seedLiveAgent('qa-1', '%1');
    let probes = 0;
    onExec = cmd => {
      if (!isSnapshot(cmd)) return;
      if (++probes % 2 === 0) runner.sessions.markWorking('qa-1');
      else runner.sessions.setProcess('qa-1', 'codex');
    };

    await expect(harness.manager.clearAgent('qa-1')).rejects.toMatchObject({ status: 409 });

    expect(probes).toBeGreaterThan(2);
    expect(runner.sentKeys).toEqual([]);
  });

  it('an idle screen cannot override a working title', async () => {
    useRunner({ agents: { 'qa-1': { title: '⠹ 分析' } } }, { manualCompactWaitMs: 40 });
    await seedLiveAgent('qa-1', '%1');
    await expect(harness.manager.clearAgent('qa-1')).rejects.toMatchObject({ status: 409 });
    expect(runner.sentKeys).toEqual([]);
  });

  it('withholds submission when the session changes after composer cleanup', async () => {
    await seedLiveAgent('qa-1', '%1');
    onExec = async cmd => {
      if (cmd.includes('C-c')) await harness.seedAgent({ id: 'qa-1', paneId: '%9' });
    };
    await expect(harness.manager.clearAgent('qa-1')).rejects.toMatchObject({
      status: 409, message: expect.stringContaining('session changed'),
    });
    expect(cmds().some(cmd => isLiteral(cmd, '/clear'))).toBe(false);
  });

  it('terminates a stalled probe at its remaining budget and allows a later retry', async () => {
    const rules: NonNullable<FakeRunnerOptions['rules']> = [{
      match: isSnapshot,
      reply: (_cmd, options) => new LocalRunner().exec('sleep 30', options),
    }];
    useRunner({ rules }, { manualCompactWaitMs: 100 });
    await seedLiveAgent('qa-1', '%1');

    await expect(harness.manager.clearAgent('qa-1')).rejects.toMatchObject({
      status: 409, message: expect.stringContaining('Command timed out after'),
    });
    expect(runner.sentKeys).toEqual([]);
    rules.length = 0;
    await expect(harness.manager.clearAgent('qa-1')).resolves.toBeUndefined();
    await waitGuardFree('qa-1');
  });

  it('does not start another terminal command after the total operation budget expires', async () => {
    useRunner({}, { manualCompactWaitMs: 100 });
    await seedLiveAgent('qa-1', '%1');
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    onExec = () => { now += 8_000; };
    try {
      await expect(harness.manager.clearAgent('qa-1')).rejects.toMatchObject({
        status: 409, message: expect.stringContaining('deadline exceeded'),
      });
      expect(runner.exec.mock.calls.map(([, options]) => options?.timeout)).toEqual([5_000, 5_000]);
      expect(runner.sentKeys).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it('bounds a stalled submission, reports unknown and never retries it', async () => {
    useRunner({ rules: [{
      match: cmd => isLiteral(cmd, '/clear'),
      reply: (_cmd, options) => new LocalRunner().exec('sleep 30', options),
    }] });
    await seedLiveAgent('qa-1', '%1');
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    onExec = cmd => { if (cmd.includes('set-option') && cmd.includes('@baxian-context-task-id')) now = 14_950; };
    try {
      await expect(harness.manager.clearAgent('qa-1')).rejects.toMatchObject({
        status: 504, message: expect.stringContaining('execution outcome unknown'),
      });
      const submissions = runner.exec.mock.calls.filter(([cmd]) => isLiteral(cmd, '/clear'));
      expect(submissions).toHaveLength(1);
      expect(submissions[0]![1]?.timeout).toBe(50);
      await waitGuardFree('qa-1');
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['applied-lost', 'not-applied-lost'] as const)('reports %s submission as unknown without resending, retaining the guard during observation', async outcome => {
    useRunner({ rules: [{ match: cmd => isLiteral(cmd, '/clear'), reply: { outcome } }] });
    await seedLiveAgent('qa-1', '%1');
    let submitted = false;
    const gate = gateOn(cmd => {
      if (isLiteral(cmd, '/clear')) submitted = true;
      return submitted && isCapture(cmd);
    });

    await expect(harness.manager.clearAgent('qa-1')).rejects.toMatchObject({
      status: 504, message: expect.stringContaining('execution outcome unknown'),
    });
    await vi.waitFor(() => expect(gate.hit()).toBe(true));
    await expect(harness.manager.compactAgent('qa-1')).rejects.toMatchObject({ status: 409 });
    expect(cmds().filter(cmd => isLiteral(cmd, '/clear'))).toHaveLength(1);
    expect(runner.sessions.pane('qa-1')?.phase).toBe(outcome === 'applied-lost' ? 'working' : 'idle');
    gate.release();
    await waitGuardFree('qa-1');
  });
});

describe('prompt injection under the compact guard', () => {
  const DEV_PROMPT_MARK = 'T';

  async function seedDevDispatch(taskId = 'task-1'): Promise<string> {
    const task = await harness.seedTask({ id: taskId, status: 'in_progress', signalToken: 'devtok123456' });
    await harness.seedAgent({ id: 'dev-1', taskId: task.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1', task.id);
    return task.id;
  }

  // 用一次卡住的图片上传真实占住守卫:它不发任何 tmux 命令,派单只会停在守卫上
  function holdGuardByUpload(agentId = 'dev-1'): { settle: (fail?: boolean) => void; done: Promise<unknown> } {
    let settle!: (fail?: boolean) => void;
    runner.writeFile.mockReturnValueOnce(new Promise<void>((resolve, reject) => {
      settle = fail => (fail ? reject(new Error('upload dropped')) : resolve());
    }));
    const done = harness.manager.attachImageToRunningAgent(agentId, PNG, 'png').catch(() => undefined);
    return { settle, done };
  }

  async function settleTrace(): Promise<void> {
    let prev = -1;
    while (prev !== runner.exec.mock.calls.length) {
      prev = runner.exec.mock.calls.length;
      await new Promise(r => setTimeout(r, 25));
    }
  }

  it('dispatch injection waits for an in-flight compact instead of pasting concurrently', async () => {
    const taskId = await seedDevDispatch();
    const upload = holdGuardByUpload();
    await vi.waitFor(() => expect(runner.writeFile).toHaveBeenCalled());

    const dispatch = harness.manager.startSession(taskId, 'dev-1', 'develop');
    await settleTrace();
    expect(cmds().some(c => c.includes('paste-buffer'))).toBe(false);
    expect(runner.pastedPrompts).toEqual([]);

    upload.settle(true);
    await upload.done;

    await expect(dispatch).resolves.toBe(true);
    expect(runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining(DEV_PROMPT_MARK) }]);
  });

  it('refuses to inject when the pre-inject frame shows a pending blocker (herdr: Blocked 是唯一拒发条件)', async () => {
    const BLOCKER =
      'Bash command\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend · ctrl+e to explain';
    let blocked = false;
    useRunner({
      rules: [{
        match: c => blocked && c.includes('capture-pane'),
        reply: c => ({ stdout: `${c.includes('history_size') ? 'BX_PANE_OK|0' : 'BX_PANE_OK'}\n${BLOCKER}` }),
      }],
    });
    const taskId = await seedDevDispatch();
    const upload = holdGuardByUpload();
    await vi.waitFor(() => expect(runner.writeFile).toHaveBeenCalled());

    const dispatch = harness.manager.startSession(taskId, 'dev-1', 'develop');
    await settleTrace();
    // 阻塞帧在守卫等待期间出现:就绪判定已过,pre-inject 复核是最后一道闸
    blocked = true;
    upload.settle(true);
    await upload.done;

    await expect(dispatch).rejects.toThrow(/pre-inject/);
    expect(runner.pastedPrompts).toEqual([]);
    expect(orderOf(runner.execWithStdin, c => c.includes('load-buffer'))).toBe(-1);
  });

  it('samples the OSC title before the submit Enter so a post-submit working title cannot become the ack baseline', async () => {
    const taskId = await seedDevDispatch();

    await expect(harness.manager.startSession(taskId, 'dev-1', 'develop')).resolves.toBe(true);

    const calls = cmds();
    const pasteIdx = idxOf(calls, c => c.includes('paste-buffer'));
    const titleIdx = idxOf(calls, isTitleRead, pasteIdx + 1);
    const enterIdx = idxOf(calls, c => c.includes('send-keys') && c.includes('Enter'), pasteIdx + 1);
    expect(pasteIdx).toBeGreaterThanOrEqual(0);
    expect(titleIdx).toBeGreaterThan(pasteIdx);
    expect(titleIdx).toBeLessThan(enterIdx);
    // 基线标题取自提交前,提交后标题转 working 才能被认作 ack
    expect(runner.sessions.pane('dev-1')?.title).toBe('⠂ Claude Code');
  });

  it('a guarded dispatch that goes stale after entry never touches the composer', async () => {
    const taskId = await seedDevDispatch();
    let calls = 0;
    const guardBeforeInject = async (): Promise<boolean> => { calls += 1; return calls === 1; };

    await expect(harness.manager.continueSession(taskId, 'dev-1', 'develop', { guardBeforeInject }))
      .resolves.toBe(false);

    const trace = cmds();
    expect(orderOf(runner.execWithStdin, c => c.includes('load-buffer'))).toBe(-1);
    expect(trace.some(c => c.includes('paste-buffer'))).toBe(false);
    expect(trace.some(c => isLiteral(c, SPACE_LITERAL))).toBe(false);
    expect(runner.pastedPrompts).toEqual([]);
    expect(runner.sessions.pane('dev-1')).toMatchObject({ composer: '', phase: 'idle' });
  });

  it('a guarded dispatch scrubs the composer inside the paste fence, after staging', async () => {
    const taskId = await seedDevDispatch();

    await expect(harness.manager.continueSession(taskId, 'dev-1', 'develop', {
      guardBeforeInject: async () => true,
    })).resolves.toBe(true);

    const stageAt = orderOf(runner.execWithStdin, c => c.includes('load-buffer'));
    const scrubAt = orderOf(runner.exec, c => isLiteral(c, SPACE_LITERAL));
    const pasteAt = orderOf(runner.exec, c => c.includes('paste-buffer'));
    expect(stageAt).toBeGreaterThan(0);
    expect(scrubAt).toBeGreaterThan(stageAt);
    expect(pasteAt).toBeGreaterThan(scrubAt);
    expect(runner.pastedPrompts).toEqual([{ pane: '%0', body: expect.stringContaining(DEV_PROMPT_MARK) }]);
  });

  it('aborts a guarded dispatch when the binding is released while waiting (task cancelled)', async () => {
    const taskId = await seedDevDispatch();
    const upload = holdGuardByUpload();
    await vi.waitFor(() => expect(runner.writeFile).toHaveBeenCalled());

    const dispatch = harness.manager.continueSession(taskId, 'dev-1', 'develop', {
      guardBeforeInject: async () => true,
    });
    await settleTrace();
    await harness.seedAgent({ id: 'dev-1', paneId: '%0' });
    upload.settle(true);
    await upload.done;

    await expect(dispatch).rejects.toThrow('binding changed');
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('guarded text injection waits for the guard, then pastes once it is released', async () => {
    await harness.seedAgent({ id: 'qa-1', paneId: '%1', taskId: 't1' });
    await harness.acquireAgentLock('qa-1', 't1');
    const upload = holdGuardByUpload('qa-1');
    await vi.waitFor(() => expect(runner.writeFile).toHaveBeenCalled());

    const inject = harness.manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: 't1' });
    await settleTrace();
    expect(runner.pastedPrompts).toEqual([]);

    upload.settle(true);
    await upload.done;

    await inject;
    expect(runner.pastedPrompts).toEqual([{ pane: '%1', body: 'file body' }]);
    expect(runner.sessions.pane('qa-1')?.phase).toBe('working');
  });

  it('drops stale text injection when the agent was rebound during the guard wait', async () => {
    await harness.seedAgent({ id: 'qa-1', paneId: '%1', taskId: 't1' });
    await harness.acquireAgentLock('qa-1', 't1');
    const upload = holdGuardByUpload('qa-1');
    await vi.waitFor(() => expect(runner.writeFile).toHaveBeenCalled());

    const inject = harness.manager.injectTextToAgent('qa-1', 'file body', { expectedTaskId: 't1' });
    await settleTrace();
    await harness.seedAgent({ id: 'qa-1', paneId: '%1', taskId: 't2' });
    upload.settle(true);
    await upload.done;

    await expect(inject).rejects.toThrow('no longer bound');
    expect(runner.pastedPrompts).toEqual([]);
  });
});

describe('idle detection (width-independent, title-corroborated)', () => {
  const NARROW_IDLE_SCREEN =
    '合并门），合并动作留给你。\n' +
    '你合并后我再做本地清理（删\n' +
    'feat/spec-human-approval\n' +
    '分支、切回 main），或者你直\n' +
    '接说一声我来跑 gh pr\n' +
    'merge。\n' +
    '\n' +
    '✻ Churned for 56s\n';
  const CODEX_POPUP =
    'permissions: YOLO mode\n\n› $bax\n  $baxian-task  Dispatch\n\n  Press enter to insert or esc to close\n';
  const CODEX_IDLE = 'permissions: YOLO mode\n\n› \n\n  gpt-5.5 xhigh · ~/repo\n';

  async function seedReviewDispatch(): Promise<string> {
    const task = await harness.seedTask({
      id: 'task-review',
      status: 'review',
      signalToken: 'tok123456789',
      latestHeadSha: 'a'.repeat(40),
      reviewHeadAnchorSha: 'a'.repeat(40),
      passToken: 'aaaaaaaaaaaa',
      failToken: 'bbbbbbbbbbbb',
    });
    await harness.seedAgent({ id: 'qa-1', taskId: task.id, paneId: '%1' });
    await harness.acquireAgentLock('qa-1', task.id);
    return task.id;
  }

  it('claude-code: a narrow-pane reflowed idle screen (no anchor, no ❯) with a "✳ " title is accepted as idle', async () => {
    useRunner({
      agents: { 'dev-1': { process: '2.1.199', screen: NARROW_IDLE_SCREEN, title: '✳ 分析 baxian 服务 DEV agent 不遵照指示问题' } },
    });
    await seedLiveAgent();

    await expect(harness.manager.compactAgent('dev-1')).resolves.toBeUndefined();
    expect(cmds().some(c => isLiteral(c, '/compact'))).toBe(true);
  });

  it('claude-code: the same narrow screen without the ✳ idle title still fails closed', async () => {
    useRunner(
      { agents: { 'dev-1': { process: '2.1.199', screen: NARROW_IDLE_SCREEN, title: 'baxian' } } },
      { manualCompactWaitMs: 50 },
    );
    await seedLiveAgent();

    await expect(harness.manager.compactAgent('dev-1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('not at an idle REPL prompt'),
    });
    expect(cmds().some(c => c.includes('/compact'))).toBe(false);
  });

  it('stableIdle: a codex completion popup never joins the idle streak even though the YOLO banner anchor reads as idle', async () => {
    useRunner({ agents: { 'qa-1': { screen: CODEX_POPUP } } }, { cleanComposerWaitMs: 50 });
    const taskId = await seedReviewDispatch();

    await expect(harness.manager.startSession(taskId, 'qa-1', 'review')).rejects.toBeInstanceOf(ReplNotReadyError);
    expect(runner.pastedPrompts).toEqual([]);
  });

  it('stableIdle: the same codex banner with an empty composer still passes (control)', async () => {
    useRunner({ agents: { 'qa-1': { screen: CODEX_IDLE } } }, { cleanComposerWaitMs: 1_000 });
    const taskId = await seedReviewDispatch();

    await expect(harness.manager.startSession(taskId, 'qa-1', 'review')).resolves.toBe(true);
    expect(runner.pastedPrompts).toEqual([{ pane: '%1', body: expect.any(String) }]);
  });

  it('a startup dialog on the adopted pane blocks the dispatch instead of being pasted over', async () => {
    useRunner({ agents: { 'dev-1': { screen: ' Enter to confirm · Esc to cancel\n' } } });
    const task = await harness.seedTask({ id: 'task-1', status: 'in_progress', signalToken: 'devtok123456' });
    await harness.seedAgent({ id: 'dev-1', taskId: task.id, paneId: '%0' });
    await harness.acquireAgentLock('dev-1', task.id);

    await expect(harness.manager.startSession(task.id, 'dev-1', 'develop'))
      .rejects.toMatchObject({ partial: { dialogPending: true } });
    expect(runner.pastedPrompts).toEqual([]);
  });
});
