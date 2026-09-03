import type { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';

// Chrome 单页约 16 个 WebGL context 就会踢掉最旧的，预算留一半余量
export const WEBGL_CONTEXT_BUDGET = 8;
let webglContextsInUse = 0;
// WebglRenderer 拿 webgl2 context 之前就挂好了 link 层画布和监听器，激活失败后外部收不回来：先用临时画布探测，失败也不再尝试
let webglSupported: boolean | undefined;
let canvasSupported = true;

export type RendererKind = 'dom' | 'webgl' | 'canvas';

export interface TerminalRenderer {
  readonly kind: RendererKind;
  dispose(): void;
}

type ActiveRenderer = { kind: 'webgl' | 'canvas'; addon: WebglAddon | CanvasAddon };

function screenCanvases(term: Terminal): HTMLCanvasElement[] {
  return Array.from(term.element?.querySelectorAll('canvas') ?? []);
}

// WebGL 渲染器的 screen 里还有 2D 的 link 层画布；已持有 2D context 的画布问 webgl2 只会返回 null
function findWebglContext(term: Terminal): WebGL2RenderingContext | null {
  for (const canvas of screenCanvases(term)) {
    const gl = canvas.getContext('webgl2');
    if (gl) return gl;
  }
  return null;
}

// addon-webgl 0.18 的 dispose 只摘掉 canvas 不释放 context，等 GC 期间僵尸 context 会挤掉还在显示的终端
function loseWebglContext(gl: WebGL2RenderingContext | null): void {
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
}

function probeWebgl2(): boolean {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return false;
  loseWebglContext(gl);
  return true;
}

// DOM 渲染器靠字体字形画块字符/框线，行高 1.4 时会漏出背景色；只给可见的终端配 WebGL/canvas，离开视口就还回去
export function attachRenderer(term: Terminal, container: Element): TerminalRenderer {
  let active: ActiveRenderer | null = null;
  let disposed = false;

  // loadAddon 先登记再 activate，激活失败的实例要自己 dispose 掉才会从 AddonManager 摘除
  const acquireCanvas = (): void => {
    if (disposed || !canvasSupported) return;
    const addon = new CanvasAddon();
    try {
      term.loadAddon(addon);
      active = { kind: 'canvas', addon };
    } catch (err) {
      canvasSupported = false;
      console.warn('[terminal-renderer] canvas renderer unavailable, using dom renderer:', err);
      addon.dispose();
    }
  };

  const release = (): void => {
    if (!active) return;
    const { kind, addon } = active;
    active = null;
    const gl = kind === 'webgl' ? findWebglContext(term) : null;
    addon.dispose();
    if (kind === 'webgl') {
      webglContextsInUse--;
      loseWebglContext(gl);
    }
  };

  const acquireWebgl = (): boolean => {
    if (webglSupported === undefined) webglSupported = probeWebgl2();
    if (!webglSupported || webglContextsInUse >= WEBGL_CONTEXT_BUDGET) return false;
    let addon: WebglAddon | null = null;
    try {
      addon = new WebglAddon();
      addon.onContextLoss(() => {
        release();
        acquireCanvas();
      });
      term.loadAddon(addon);
      webglContextsInUse++;
      active = { kind: 'webgl', addon };
      return true;
    } catch (err) {
      webglSupported = false;
      console.warn('[terminal-renderer] webgl renderer unavailable, using canvas from now on:', err);
      addon?.dispose();
      for (const canvas of screenCanvases(term)) canvas.remove();
      return false;
    }
  };

  const acquire = (): void => {
    if (disposed || active) return;
    if (!acquireWebgl()) acquireCanvas();
  };

  // disconnect 拦不住已经排队的通知，dispose 之后的回调必须直接丢弃
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      if (disposed) return;
      const latest = entries[entries.length - 1];
      if (latest?.isIntersecting) acquire();
      else release();
    })
    : null;
  if (observer) observer.observe(container);
  else acquire();

  return {
    get kind(): RendererKind {
      return active?.kind ?? 'dom';
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      const current = active;
      active = null;
      const gl = current?.kind === 'webgl' ? findWebglContext(term) : null;
      try {
        term.dispose();
      } catch (err) {
        console.warn('[terminal-renderer] dispose failed:', err);
      }
      if (current?.kind === 'webgl') {
        webglContextsInUse--;
        loseWebglContext(gl);
      }
    },
  };
}
