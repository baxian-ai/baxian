import { afterEach, describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { WEBGL_CONTEXT_BUDGET } from '../../src/components/terminal-renderer.ts';
import {
  MASCOT,
  ManualObserver,
  SyncVisibleObserver,
  expectMascotIntact,
  isBlack,
  mountTerminal,
  probeScreen,
  resourceCounts,
  screenCanvasCount,
  settle,
  unmount,
  unmountAll,
  until,
  writeAndRender,
  type Mounted,
} from './terminal-fixture.ts';

afterEach(() => {
  unmountAll();
});

describe('terminal renderer policy renders block glyphs edge to edge (real Chromium)', () => {
  it('probe sanity: the DOM renderer alone shows the reported defect (background bar above the block glyph)', async () => {
    const entry = mountTerminal({ policy: false });
    expect(entry.container.querySelectorAll('canvas')).toHaveLength(0);
    await writeAndRender(entry.term, MASCOT);
    const probe = await probeScreen(entry);
    expect(isBlack(probe.at(3 * probe.cellW + probe.cellW / 2, 1))).toBe(true);
  });

  it('a visible terminal gets WebGL and the mascot is intact', async () => {
    const entry = mountTerminal();
    await until(() => entry.renderer?.kind === 'webgl', 'webgl renderer');
    await writeAndRender(entry.term, MASCOT);
    expectMascotIntact(await probeScreen(entry));
  });

  it('the terminal beyond the WebGL budget renders on canvas with the mascot intact', async () => {
    for (let i = 0; i < WEBGL_CONTEXT_BUDGET; i++) {
      const entry = mountTerminal();
      await until(() => entry.renderer?.kind === 'webgl', `webgl renderer #${i}`);
    }
    const extra = mountTerminal();
    await until(() => extra.renderer?.kind === 'canvas', 'canvas renderer for the over-budget terminal');
    await writeAndRender(extra.term, MASCOT);
    expectMascotIntact(await probeScreen(extra));
  });

  it('an offscreen terminal stays on DOM, takes WebGL when scrolled into view and gives everything back when scrolled away', async () => {
    const entry = mountTerminal({ offscreen: true });
    await settle();
    expect(entry.renderer?.kind).toBe('dom');
    expect(screenCanvasCount(entry)).toBe(0);
    for (let cycle = 0; cycle < 3; cycle++) {
      entry.container.scrollIntoView();
      await until(() => entry.renderer?.kind === 'webgl', `webgl after scrolling into view (cycle ${cycle})`);
      expect(screenCanvasCount(entry)).toBeGreaterThan(0);
      window.scrollTo(0, 0);
      await until(() => entry.renderer?.kind === 'dom', `dom after scrolling away (cycle ${cycle})`);
      expect(screenCanvasCount(entry), `no canvases left behind after hide (cycle ${cycle})`).toBe(0);
      expect(resourceCounts(entry.term), `addon/listener baseline after hide (cycle ${cycle})`).toEqual(entry.baseline);
    }
  });

  // disconnect 拦不住已经排队的通知，dispose 后送达的 visible 不能再加载 addon
  it('a visibility notification delivered after dispose is ignored: no addon, no budget slot, kind stays dom', async () => {
    const nativeObserver = window.IntersectionObserver;
    window.IntersectionObserver = ManualObserver as unknown as typeof IntersectionObserver;
    let late: Mounted;
    let observer: ManualObserver | null;
    try {
      late = mountTerminal();
      observer = ManualObserver.latest;
      expect(observer?.target).toBe(late.container);
      unmount(late);
      observer?.emit(true);
    } finally {
      window.IntersectionObserver = nativeObserver;
    }
    expect(late.renderer?.kind, 'late visible notification must not load a renderer').toBe('dom');
    expect(resourceCounts(late.term).addons).toBe(0);
    expect(late.container.querySelectorAll('canvas')).toHaveLength(0);
    const live = Array.from({ length: WEBGL_CONTEXT_BUDGET }, () => mountTerminal());
    for (const entry of live) await until(() => entry.renderer?.kind === 'webgl', 'webgl for every budget slot after the late notification');
    observer?.emit(false);
    expect(live.map(entry => entry.renderer?.kind)).toEqual(live.map(() => 'webgl'));
  });

  // 必须保留已卸载终端的引用（否则 GC 回收僵尸掩盖泄漏），并直接听 DOM 事件（xterm 要等 3s 才触发 onContextLoss）
  it('mount/dispose churn leaves no zombie contexts: older live terminals keep WebGL through a burst of mounts', async () => {
    const live = Array.from({ length: WEBGL_CONTEXT_BUDGET - 1 }, () => mountTerminal());
    for (const entry of live) await until(() => entry.renderer?.kind === 'webgl', 'webgl for live terminal');
    const lostLiveCanvases: Element[] = [];
    const onLost = (event: Event): void => {
      if ((event.target as Element | null)?.isConnected) lostLiveCanvases.push(event.target as Element);
    };
    document.addEventListener('webglcontextlost', onLost, true);
    const retained: Terminal[] = [];
    const nativeObserver = window.IntersectionObserver;
    window.IntersectionObserver = SyncVisibleObserver as unknown as typeof IntersectionObserver;
    try {
      for (let i = 0; i < WEBGL_CONTEXT_BUDGET * 3; i++) {
        const entry = mountTerminal();
        expect(entry.renderer?.kind, `cycle ${i}`).toBe('webgl');
        unmount(entry);
        retained.push(entry.term);
      }
      await settle(300);
    } finally {
      window.IntersectionObserver = nativeObserver;
      document.removeEventListener('webglcontextlost', onLost, true);
    }
    expect(retained).toHaveLength(WEBGL_CONTEXT_BUDGET * 3);
    expect(lostLiveCanvases, 'live terminals evicted by zombie contexts').toHaveLength(0);
    expect(live.map(entry => entry.renderer?.kind)).toEqual(live.map(() => 'webgl'));
  });
});
