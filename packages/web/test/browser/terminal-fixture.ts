import { expect } from 'vitest';
import { page } from '@vitest/browser/context';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { attachRenderer, type TerminalRenderer } from '../../src/components/terminal-renderer.ts';
import { TERMINAL_MONO_STACK, ZED_LIGHT_THEME } from '../../src/components/pane-terminal.tsx';

const E = '\x1b';
// Claude Code 启动画面的吉祥物原始字节：粉色前景 + 黑色背景的块字符，眼睛是 ▛ 缺角漏出的黑底
export const MASCOT = [
  `${E}[38;5;174m ▐${E}[48;5;16m▛███▛█${E}[39m${E}[49m   ${E}[1mClaude Code${E}[0m`,
  `${E}[38;5;174m▝▜${E}[48;5;16m█████${E}[49m█▀${E}[39m  Fable 5.1`,
  `${E}[38;5;174m  ▝▝ ▝▝  ${E}[39m`,
].join('\r\n');

const COLS = 40;
const ROWS = 3;

type Rgb = readonly [number, number, number];
export const isPink = ([r, g, b]: Rgb): boolean => r > 170 && g < 170 && b < 170 && r - g > 40;
export const isBlack = ([r, g, b]: Rgb): boolean => r < 60 && g < 60 && b < 60;

export interface ResourceCounts {
  addons: number;
  themeListeners: number;
  optionListeners: number;
  linkListeners: number;
}

// xterm 5.5 内部结构：AddonManager 登记项和 theme/options/linkifier 的监听数
export function resourceCounts(term: Terminal): ResourceCounts {
  const internals = term as unknown as {
    _addonManager: { _addons: unknown[] };
    _core: {
      _themeService: { _onChangeColors: { _listeners: unknown[] } };
      optionsService: { _onOptionChange: { _listeners: unknown[] } };
      linkifier: { _onShowLinkUnderline: { _listeners: unknown[] }; _onHideLinkUnderline: { _listeners: unknown[] } };
    };
  };
  return {
    addons: internals._addonManager._addons.length,
    themeListeners: internals._core._themeService._onChangeColors._listeners.length,
    optionListeners: internals._core.optionsService._onOptionChange._listeners.length,
    linkListeners: internals._core.linkifier._onShowLinkUnderline._listeners.length
      + internals._core.linkifier._onHideLinkUnderline._listeners.length,
  };
}

export interface Mounted {
  term: Terminal;
  renderer?: TerminalRenderer;
  container: HTMLDivElement;
  baseline: ResourceCounts;
}

const mounted: Mounted[] = [];

// 同步回报“可见”的 IntersectionObserver 桩，让一批挂载在同一个 task 里拿到渲染器
export class SyncVisibleObserver {
  constructor(private readonly cb: (entries: Array<Partial<IntersectionObserverEntry>>, observer: SyncVisibleObserver) => void) { }
  observe(target: Element): void {
    this.cb([{ target, isIntersecting: true, intersectionRatio: 1 }], this);
  }
  unobserve(): void { }
  disconnect(): void { }
}

// 由测试手动触发通知的 IntersectionObserver 桩
export class ManualObserver {
  static latest: ManualObserver | null = null;
  target: Element | null = null;
  constructor(private readonly cb: (entries: Array<Partial<IntersectionObserverEntry>>, observer: ManualObserver) => void) {
    ManualObserver.latest = this;
  }
  observe(target: Element): void { this.target = target; }
  unobserve(): void { }
  disconnect(): void { }
  emit(isIntersecting: boolean): void {
    this.cb([{ target: this.target ?? undefined, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 }], this);
  }
}

export function mountTerminal(opts: { policy?: boolean; offscreen?: boolean } = {}): Mounted {
  const container = document.createElement('div');
  container.style.cssText = `width:400px;height:70px;${opts.offscreen ? 'margin-top:4000px;' : ''}`;
  document.body.appendChild(container);
  const term = new Terminal({
    theme: ZED_LIGHT_THEME,
    fontFamily: TERMINAL_MONO_STACK,
    fontSize: 13,
    lineHeight: 1.4,
    cols: COLS,
    rows: ROWS,
    scrollback: 0,
  });
  term.open(container);
  const baseline = resourceCounts(term);
  const renderer = opts.policy === false ? undefined : attachRenderer(term, container);
  const entry: Mounted = { term, renderer, container, baseline };
  mounted.push(entry);
  return entry;
}

export function unmount(entry: Mounted): void {
  mounted.splice(mounted.indexOf(entry), 1);
  if (entry.renderer) entry.renderer.dispose();
  else entry.term.dispose();
  entry.container.remove();
}

export function unmountAll(): void {
  for (const entry of mounted.splice(0)) {
    if (entry.renderer) entry.renderer.dispose();
    else entry.term.dispose();
    entry.container.remove();
  }
  window.scrollTo(0, 0);
}

export function screenCanvasCount({ container }: Mounted): number {
  return container.querySelectorAll('.xterm-screen canvas').length;
}

export async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 16));
  }
}

export async function settle(ms = 150): Promise<void> {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, ms))));
}

export async function writeAndRender(term: Terminal, data: string): Promise<void> {
  await new Promise<void>(resolve => term.write(data, resolve));
  await settle();
}

export interface Probe {
  cellW: number;
  cellH: number;
  at(x: number, y: number): Rgb;
}

export async function probeScreen({ term, container }: Mounted): Promise<Probe> {
  const screen = container.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) throw new Error('.xterm-screen missing');
  const shot: unknown = await page.elementLocator(screen).screenshot({ base64: true, save: false });
  const base64 = typeof shot === 'string' ? shot : (shot as { base64: string }).base64;
  const img = new Image();
  img.src = `data:image/png;base64,${base64}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable for probe');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rect = screen.getBoundingClientRect();
  const scale = canvas.width / rect.width;
  return {
    cellW: rect.width / term.cols,
    cellH: rect.height / term.rows,
    at(x, y) {
      const px = Math.min(canvas.width - 1, Math.round(x * scale));
      const py = Math.min(canvas.height - 1, Math.round(y * scale));
      const i = (py * canvas.width + px) * 4;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    },
  };
}

// 第 3 列第 0/1 行是黑底粉色 █，整格连同接缝都得是粉色；第 2 列第 0 行 ▛ 的右下象限是眼睛，必须是黑色
export function expectMascotIntact(probe: Probe): void {
  const { cellW, cellH } = probe;
  const bodyX = 3 * cellW + cellW / 2;
  expect(isPink(probe.at(bodyX, 1)), 'top edge of body cell').toBe(true);
  expect(isPink(probe.at(bodyX, cellH / 2)), 'middle of body cell').toBe(true);
  expect(isPink(probe.at(bodyX, cellH - 2)), 'bottom edge of body cell').toBe(true);
  expect(isPink(probe.at(bodyX, cellH + 1)), 'top edge of second body row').toBe(true);
  expect(isBlack(probe.at(2 * cellW + cellW * 0.75, cellH * 0.8)), 'eye quadrant').toBe(true);
  expect(isPink(probe.at(2 * cellW + cellW * 0.25, cellH * 0.25)), 'brow quadrant').toBe(true);
}
