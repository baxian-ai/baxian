import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MASCOT,
  expectMascotIntact,
  mountTerminal,
  probeScreen,
  resourceCounts,
  screenCanvasCount,
  unmountAll,
  until,
  writeAndRender,
} from './terminal-fixture.ts';

// 单独一个文件：策略模块记住“WebGL 不可用”是页面级状态，浏览器模式下每个测试文件独占一个 iframe
const originalGetContext = HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    if (type === 'webgl2') return null;
    return (originalGetContext as (this: HTMLCanvasElement, type: string, ...rest: unknown[]) => unknown).call(this, type, ...rest);
  } as typeof originalGetContext;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

describe('terminal renderer policy without WebGL2 (real Chromium)', () => {
  // 第一个终端就是探测发生的地方，隐藏后画布和登记/监听都要回到 attach 之前
  it('renders on canvas with the mascot intact and leaves nothing behind once hidden', async () => {
    const spacer = document.createElement('div');
    spacer.style.height = '3000px';
    const entry = mountTerminal();
    document.body.appendChild(spacer);
    try {
      await until(() => entry.renderer?.kind === 'canvas', 'canvas renderer without webgl2');
      await writeAndRender(entry.term, MASCOT);
      expectMascotIntact(await probeScreen(entry));
      window.scrollTo(0, 2500);
      await until(() => entry.renderer?.kind === 'dom', 'dom after scrolling away');
      expect(screenCanvasCount(entry), 'stray canvases from the failed WebGL attempt').toBe(0);
      expect(resourceCounts(entry.term), 'addon/listener baseline after hide').toEqual(entry.baseline);
    } finally {
      spacer.remove();
    }
  });

  // 每次滚入都重试的话，失败尝试留下的画布会随滚动累积
  it('visibility churn leaves no stray canvases and never retries WebGL', async () => {
    const warn = vi.spyOn(console, 'warn');
    const webglAttempts = (): number =>
      warn.mock.calls.filter(call => String(call[0]).includes('webgl renderer unavailable')).length;
    const spacer = document.createElement('div');
    spacer.style.height = '3000px';
    const entry = mountTerminal();
    document.body.appendChild(spacer);
    await until(() => entry.renderer?.kind === 'canvas', 'canvas renderer');
    const canvasLayers = screenCanvasCount(entry);
    expect(canvasLayers).toBeGreaterThan(0);
    const attemptsBeforeChurn = webglAttempts();
    expect(attemptsBeforeChurn).toBeLessThanOrEqual(1);
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        window.scrollTo(0, 2500);
        await until(() => entry.renderer?.kind === 'dom', `dom after scrolling away (cycle ${cycle})`);
        expect(screenCanvasCount(entry), `stray canvases after hide (cycle ${cycle})`).toBe(0);
        expect(resourceCounts(entry.term), `addon/listener baseline after hide (cycle ${cycle})`).toEqual(entry.baseline);
        window.scrollTo(0, 0);
        await until(() => entry.renderer?.kind === 'canvas', `canvas after scrolling back (cycle ${cycle})`);
        expect(screenCanvasCount(entry), `canvas layers after show (cycle ${cycle})`).toBe(canvasLayers);
      }
    } finally {
      spacer.remove();
    }
    expect(webglAttempts(), 'WebGL retried during visibility churn').toBe(attemptsBeforeChurn);
  });
});
