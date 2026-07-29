import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentManager } from '../../src/agent/manager.js';
import { TmuxManager, ReplNotReadyError } from '../../src/agent/tmux.js';
import { createManagerHarness } from '../helpers/manager-harness.js';
import { fakeRunner } from '../helpers/fake-runner.js';

const CODEX_IDLE = '› \n\n  gpt-5.5 xhigh · ~/repo\n  permissions: YOLO mode\n';
const CODEX_BUSY = '• Working (12s)\n  esc to interrupt\n  gpt-5.5 xhigh · ~/repo\n  permissions: YOLO mode\n';

type WaitOpts = { stableIdle?: boolean };
type WaitFn = (tmux: TmuxManager, paneId: string, runtime: string, timeoutMs: number, opts?: WaitOpts) => Promise<void>;

let tempDir: string;
let manager: AgentManager;
let tmux: TmuxManager;

function waitReady(timeoutMs: number, opts?: WaitOpts): Promise<void> {
  const fn = (manager as unknown as { waitForReplPromptReady: WaitFn }).waitForReplPromptReady.bind(manager) as WaitFn;
  return fn(tmux, '%0', 'codex', timeoutMs, opts);
}

function mockFrames(frames: string[], opts: { cycle?: boolean } = {}): ReturnType<typeof vi.spyOn> {
  let i = 0;
  return vi.spyOn(TmuxManager.prototype, 'capturePaneById').mockImplementation(async () => {
    const idx = Math.min(i, frames.length - 1);
    const frame = opts.cycle ? frames[i % frames.length] : frames[idx];
    i += 1;
    return frame;
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-debounce-'));
  const runner = fakeRunner({ defaultResult: {} });
  const harness = await createManagerHarness(tempDir, {
    deps: {
      runnerFactory: () => runner,
      platformRunner: runner,
    },
  });
  manager = harness.manager;
  Object.assign(manager, {
    compactIdlePollMs: 1,
    readyStableSpacingMs: 1,
    cleanComposerWaitMs: 30,
    dispatchAckTimeoutMs: 30,
    dispatchSettleTimeoutMs: 30,
  });
  tmux = new TmuxManager(runner);
  vi.spyOn(TmuxManager.prototype, 'displayMessage').mockResolvedValue('node');
  vi.spyOn(TmuxManager.prototype, 'readPaneTitle').mockResolvedValue('');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe('waitForReplPromptReady stableIdle 去抖', () => {
  it('忙碌序列夹单帧假 idle：不判 ready，超时抛 ReplNotReadyError', async () => {
    mockFrames([CODEX_BUSY, CODEX_IDLE, CODEX_BUSY, CODEX_IDLE], { cycle: true });
    await expect(waitReady(30, { stableIdle: true })).rejects.toBeInstanceOf(ReplNotReadyError);
  });

  it('连续稳定 idle 帧达到阈值才返回；忙碌帧清零计数', async () => {
    const spy = mockFrames([CODEX_IDLE, CODEX_BUSY, CODEX_IDLE, CODEX_IDLE, CODEX_IDLE]);
    await expect(waitReady(200, { stableIdle: true })).resolves.toBeUndefined();
    expect(spy.mock.calls.length).toBe(5);
  });

  it('从头稳定 idle：恰好采样阈值帧数后返回', async () => {
    const spy = mockFrames([CODEX_IDLE]);
    await expect(waitReady(200, { stableIdle: true })).resolves.toBeUndefined();
    expect(spy.mock.calls.length).toBe(3);
  });

  it('非 stableIdle 分支的忙碌超时同样抛类型化 ReplNotReadyError', async () => {
    mockFrames([CODEX_BUSY], { cycle: true });
    await expect(waitReady(30)).rejects.toBeInstanceOf(ReplNotReadyError);
  });

  it('REPL 进程退出立即失败（非 ReplNotReadyError）', async () => {
    mockFrames([CODEX_IDLE]);
    const display = vi.spyOn(TmuxManager.prototype, 'displayMessage');
    display.mockResolvedValueOnce('node').mockResolvedValue('zsh');
    const err = await waitReady(200, { stableIdle: true }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ReplNotReadyError);
    expect(String(err)).toMatch(/not runtime/);
  });

  it('plain 模式回归：单帧 idle 即返回（既有行为不变）', async () => {
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockResolvedValue(undefined);
    const spy = mockFrames([CODEX_IDLE]);
    await expect(waitReady(200)).resolves.toBeUndefined();
    expect(spy.mock.calls.length).toBe(1);
  });
});

describe('任务边界注入前的稳定就绪门', () => {
  it('假 idle 帧不放行 /clear：就绪未确证前不发送任何按键', async () => {
    mockFrames([CODEX_BUSY, CODEX_IDLE, CODEX_BUSY, CODEX_IDLE], { cycle: true });
    const clearDraft = vi.spyOn(TmuxManager.prototype, 'clearComposerDraft').mockResolvedValue(undefined);
    const sendLiteral = vi.spyOn(TmuxManager.prototype, 'sendKeysLiteral').mockResolvedValue(undefined);
    const sendEnter = vi.spyOn(TmuxManager.prototype, 'sendEnter').mockResolvedValue(undefined);
    vi.spyOn(TmuxManager.prototype, 'captureSettledSnapshot').mockResolvedValue(CODEX_IDLE);
    vi.spyOn(TmuxManager.prototype, 'waitSubmitAck').mockResolvedValue(undefined);
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockResolvedValue(undefined);

    const boundary = (manager as unknown as {
      clearRuntimeForDispatchBoundary(t: TmuxManager, p: string, a: string, r: string, rv: () => Promise<void>): Promise<void>;
    }).clearRuntimeForDispatchBoundary.bind(manager);

    await expect(boundary(tmux, '%0', 'qa-1', 'codex', async () => undefined))
      .rejects.toBeInstanceOf(ReplNotReadyError);
    expect(clearDraft).not.toHaveBeenCalled();
    expect(sendLiteral).not.toHaveBeenCalled();
    expect(sendEnter).not.toHaveBeenCalled();
  });

  it('稳定 idle 后正常执行 /clear 边界流程', async () => {
    mockFrames([CODEX_IDLE]);
    const clearDraft = vi.spyOn(TmuxManager.prototype, 'clearComposerDraft').mockResolvedValue(undefined);
    const sendLiteral = vi.spyOn(TmuxManager.prototype, 'sendKeysLiteral').mockResolvedValue(undefined);
    vi.spyOn(TmuxManager.prototype, 'sendEnter').mockResolvedValue(undefined);
    vi.spyOn(TmuxManager.prototype, 'captureSettledSnapshot').mockResolvedValue(CODEX_IDLE);
    vi.spyOn(TmuxManager.prototype, 'waitSubmitAck').mockResolvedValue(undefined);
    vi.spyOn(TmuxManager.prototype, 'waitReplReady').mockResolvedValue(undefined);

    const boundary = (manager as unknown as {
      clearRuntimeForDispatchBoundary(t: TmuxManager, p: string, a: string, r: string, rv: () => Promise<void>): Promise<void>;
    }).clearRuntimeForDispatchBoundary.bind(manager);

    await expect(boundary(tmux, '%0', 'qa-1', 'codex', async () => undefined)).resolves.toBeUndefined();
    expect(clearDraft).toHaveBeenCalled();
    expect(sendLiteral).toHaveBeenCalledWith('%0', '/clear');
  });
});
