import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mountTerminal, resourceCounts, settle, unmountAll, until } from './terminal-fixture.ts';

// 单独一个文件：“canvas 不可用”是页面级状态，browser mode 下每个测试文件独占一个 iframe
const originalGetContext = HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    if (type === 'webgl2' || type === '2d') return null;
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

describe('terminal renderer policy without any canvas context (real Chromium)', () => {
  it('a failed canvas activation is disposed and visibility churn keeps the addon/listener baseline', async () => {
    const warn = vi.spyOn(console, 'warn');
    const canvasFailures = (): number =>
      warn.mock.calls.filter(call => String(call[0]).includes('canvas renderer unavailable')).length;
    const spacer = document.createElement('div');
    spacer.style.height = '3000px';
    const entry = mountTerminal();
    document.body.appendChild(spacer);
    try {
      await until(() => canvasFailures() >= 1 || entry.renderer?.kind !== 'dom', 'first renderer attempt');
      expect(entry.renderer?.kind).toBe('dom');
      expect(resourceCounts(entry.term), 'baseline after the failed canvas activation').toEqual(entry.baseline);
      const failuresAfterFirstAttempt = canvasFailures();
      expect(failuresAfterFirstAttempt).toBeLessThanOrEqual(1);
      for (let cycle = 0; cycle < 4; cycle++) {
        window.scrollTo(0, 2500);
        await settle();
        window.scrollTo(0, 0);
        await settle();
        expect(entry.renderer?.kind, `kind after cycle ${cycle}`).toBe('dom');
        expect(resourceCounts(entry.term), `baseline after cycle ${cycle}`).toEqual(entry.baseline);
      }
      expect(canvasFailures(), 'canvas retried during visibility churn').toBe(failuresAfterFirstAttempt);
    } finally {
      spacer.remove();
    }
  });
});
