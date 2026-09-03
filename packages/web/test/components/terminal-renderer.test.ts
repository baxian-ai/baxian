import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

class FakeTerminal {
  host: HTMLElement | null = null;
  disposed = false;
  addons: Array<{ activate?: (term: FakeTerminal) => void; dispose?: () => void }> = [];
  get element(): HTMLElement | undefined { return this.host ?? undefined; }
  open(host: HTMLElement): void { this.host = host; }
  loadAddon(addon: { activate?: (term: FakeTerminal) => void; dispose?: () => void }): void {
    this.addons.push(addon);
    addon.activate?.(this);
  }
  dispose(): void {
    this.disposed = true;
    for (const addon of this.addons) addon.dispose?.();
  }
}

class FakeWebglAddon {
  static failAt: 'none' | 'construct' | 'activate' = 'none';
  static loseContextCalls = 0;
  static instances: FakeWebglAddon[] = [];
  disposed = false;
  canvas = document.createElement('canvas');
  private listeners: Array<() => void> = [];
  constructor() {
    if (FakeWebglAddon.failAt === 'construct') throw new Error('Webgl2 is only supported on Safari 16 and above');
    FakeWebglAddon.instances.push(this);
  }
  // 真实 WebglRenderer 在拿 webgl2 context 之前就把 link 层画布挂进了 screen
  activate(term: FakeTerminal): void {
    if (FakeWebglAddon.failAt === 'activate') {
      const strayLinkLayer = document.createElement('canvas');
      strayLinkLayer.className = 'xterm-link-layer';
      term.host?.appendChild(strayLinkLayer);
      throw new Error('WebGL2 not supported null');
    }
    const gl = {
      getExtension: (name: string) =>
        name === 'WEBGL_lose_context' ? { loseContext: () => { FakeWebglAddon.loseContextCalls++; } } : null,
    };
    this.canvas.getContext = ((type: string) => (type === 'webgl2' ? gl : null)) as HTMLCanvasElement['getContext'];
    term.host?.appendChild(this.canvas);
  }
  onContextLoss(cb: () => void): { dispose(): void } {
    this.listeners.push(cb);
    return { dispose: () => { this.listeners = this.listeners.filter(item => item !== cb); } };
  }
  loseContext(): void {
    for (const cb of this.listeners) cb();
  }
  dispose(): void {
    this.disposed = true;
    this.canvas.remove();
  }
}

class FakeCanvasAddon {
  static fail = false;
  static instances: FakeCanvasAddon[] = [];
  disposed = false;
  constructor() {
    FakeCanvasAddon.instances.push(this);
  }
  activate(): void {
    if (FakeCanvasAddon.fail) throw new Error('Could not get canvas context');
  }
  dispose(): void { this.disposed = true; }
}

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  target: Element | null = null;
  disconnected = false;
  constructor(private readonly cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
    MockIntersectionObserver.instances.push(this);
  }
  observe(target: Element): void { this.target = target; }
  disconnect(): void { this.disconnected = true; }
  emit(isIntersecting: boolean): void { this.cb([{ isIntersecting }]); }
}

vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: FakeWebglAddon }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: FakeCanvasAddon }));

type Xterm = import('@xterm/xterm').Terminal;
type RendererModule = typeof import('../../src/components/terminal-renderer.ts');

let mod: RendererModule;
const mounted: Array<{ dispose(): void }> = [];
const originalGetContext = HTMLCanvasElement.prototype.getContext;
let webgl2Probe: 'supported' | 'unsupported' = 'supported';
let probeContextsLost = 0;
const probeGl = {
  getExtension: (name: string) =>
    name === 'WEBGL_lose_context' ? { loseContext: () => { probeContextsLost++; } } : null,
};

function webgl2ProbeCalls(): number {
  return (HTMLCanvasElement.prototype.getContext as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter(call => call[0] === 'webgl2').length;
}

beforeEach(async () => {
  vi.resetModules();
  mod = await import('../../src/components/terminal-renderer.ts');
  webgl2Probe = 'supported';
  probeContextsLost = 0;
  HTMLCanvasElement.prototype.getContext = vi.fn(function (type: string) {
    return type === 'webgl2' && webgl2Probe === 'supported' ? probeGl : null;
  }) as unknown as HTMLCanvasElement['getContext'];
  FakeWebglAddon.failAt = 'none';
  FakeWebglAddon.loseContextCalls = 0;
  FakeWebglAddon.instances = [];
  FakeCanvasAddon.fail = false;
  FakeCanvasAddon.instances = [];
  MockIntersectionObserver.instances = [];
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIntersectionObserver;
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) renderer.dispose();
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

function mount(visible = true) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const term = new FakeTerminal();
  term.open(container);
  const renderer = mod.attachRenderer(term as unknown as Xterm, container);
  mounted.push(renderer);
  const observer = MockIntersectionObserver.instances[MockIntersectionObserver.instances.length - 1]!;
  observer.emit(visible);
  return { term, renderer, observer, container };
}

function silenceWarnings(): void {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  onTestFinished(() => { warn.mockRestore(); });
}

describe('attachRenderer (visibility-bounded WebGL/canvas policy)', () => {
  it('stays on the DOM renderer until the container is visible, then takes WebGL', () => {
    const { term, renderer, observer } = mount(false);
    expect(renderer.kind).toBe('dom');
    expect(term.addons).toHaveLength(0);
    observer.emit(true);
    expect(renderer.kind).toBe('webgl');
  });

  it('leaving the viewport drops back to DOM, loses the context explicitly and frees the budget slot', () => {
    const { renderer, observer } = mount();
    const webgl = FakeWebglAddon.instances[0]!;
    observer.emit(false);
    expect(renderer.kind).toBe('dom');
    expect(webgl.disposed).toBe(true);
    expect(FakeWebglAddon.loseContextCalls).toBe(1);
    observer.emit(true);
    expect(renderer.kind).toBe('webgl');
    expect(FakeWebglAddon.instances).toHaveLength(2);
  });

  it('repeated visibility flips do not leak budget or double-release', () => {
    const { renderer, observer } = mount();
    for (let i = 0; i < 5; i++) {
      observer.emit(false);
      observer.emit(false);
      observer.emit(true);
      observer.emit(true);
    }
    expect(renderer.kind).toBe('webgl');
    expect(FakeWebglAddon.loseContextCalls).toBe(5);
    for (let i = 0; i < mod.WEBGL_CONTEXT_BUDGET - 1; i++) expect(mount().renderer.kind).toBe('webgl');
    expect(mount().renderer.kind).toBe('canvas');
  });

  it('visible terminals beyond the WebGL budget use the canvas renderer, never DOM', () => {
    for (let i = 0; i < mod.WEBGL_CONTEXT_BUDGET; i++) expect(mount().renderer.kind).toBe('webgl');
    const extra = mount();
    expect(extra.renderer.kind).toBe('canvas');
    expect(FakeCanvasAddon.instances).toHaveLength(1);
  });

  it('disposing a WebGL terminal frees a slot for the next visible terminal', () => {
    const first = mount();
    for (let i = 1; i < mod.WEBGL_CONTEXT_BUDGET; i++) mount();
    first.renderer.dispose();
    mounted.splice(mounted.indexOf(first.renderer), 1);
    expect(first.term.disposed).toBe(true);
    expect(FakeWebglAddon.loseContextCalls).toBe(1);
    expect(mount().renderer.kind).toBe('webgl');
  });

  it('hidden terminals do not hold budget: offscreen ones let visible ones keep WebGL', () => {
    for (let i = 0; i < mod.WEBGL_CONTEXT_BUDGET * 2; i++) mount(false);
    expect(mount().renderer.kind).toBe('webgl');
  });

  it('probes WebGL2 on a throwaway canvas before touching the addon: unsupported means the addon is never loaded', () => {
    webgl2Probe = 'unsupported';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => { warn.mockRestore(); });
    const { renderer, term, observer } = mount();
    expect(renderer.kind).toBe('canvas');
    expect(FakeWebglAddon.instances).toHaveLength(0);
    observer.emit(false);
    observer.emit(true);
    expect(mount().renderer.kind).toBe('canvas');
    expect(FakeWebglAddon.instances).toHaveLength(0);
    expect(term.host?.querySelector('canvas')).toBeNull();
    expect(webgl2ProbeCalls()).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the probe runs once per page and releases its context immediately', () => {
    expect(mount().renderer.kind).toBe('webgl');
    expect(mount().renderer.kind).toBe('webgl');
    expect(webgl2ProbeCalls()).toBe(1);
    expect(probeContextsLost).toBe(1);
  });

  it('falls back to canvas when the WebGL addon cannot be constructed (no WebGL2)', () => {
    FakeWebglAddon.failAt = 'construct';
    silenceWarnings();
    const { renderer } = mount();
    expect(renderer.kind).toBe('canvas');
  });

  it('falls back to canvas when WebGL2 context creation fails during activation and removes the stray link layer', () => {
    FakeWebglAddon.failAt = 'activate';
    silenceWarnings();
    const { renderer, term } = mount();
    expect(renderer.kind).toBe('canvas');
    expect(term.host?.querySelector('canvas')).toBeNull();
  });

  it('a failed WebGL activation is never retried: visibility churn stays on canvas, warns once, leaves nothing behind', () => {
    FakeWebglAddon.failAt = 'activate';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => { warn.mockRestore(); });
    const { renderer, term, observer } = mount();
    for (let i = 0; i < 3; i++) {
      observer.emit(false);
      expect(renderer.kind).toBe('dom');
      expect(term.host?.querySelector('canvas')).toBeNull();
      observer.emit(true);
      expect(renderer.kind).toBe('canvas');
    }
    expect(FakeWebglAddon.instances).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(mount().renderer.kind).toBe('canvas');
    expect(FakeWebglAddon.instances).toHaveLength(1);
  });

  it('a failed WebGL construction is remembered the same way', () => {
    FakeWebglAddon.failAt = 'construct';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => { warn.mockRestore(); });
    expect(mount().renderer.kind).toBe('canvas');
    expect(mount().renderer.kind).toBe('canvas');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a browser-initiated context loss switches to canvas and frees the slot', () => {
    for (let i = 0; i < mod.WEBGL_CONTEXT_BUDGET; i++) mount();
    const victim = FakeWebglAddon.instances[2]!;
    victim.loseContext();
    expect(victim.disposed).toBe(true);
    expect(FakeCanvasAddon.instances).toHaveLength(1);
    expect(mount().renderer.kind).toBe('webgl');
  });

  it('only when both WebGL and canvas fail does it stay on DOM, with a warning', () => {
    FakeWebglAddon.failAt = 'construct';
    FakeCanvasAddon.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => { warn.mockRestore(); });
    const { renderer } = mount();
    expect(renderer.kind).toBe('dom');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('a failed WebGL activation disposes the registered addon instance', () => {
    FakeWebglAddon.failAt = 'activate';
    silenceWarnings();
    mount();
    expect(FakeWebglAddon.instances[0]!.disposed).toBe(true);
  });

  it('a failed canvas activation disposes the registered instance, is remembered, and visibility churn adds nothing', () => {
    webgl2Probe = 'unsupported';
    FakeCanvasAddon.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => { warn.mockRestore(); });
    const { renderer, term, observer } = mount();
    expect(renderer.kind).toBe('dom');
    expect(FakeCanvasAddon.instances).toHaveLength(1);
    expect(FakeCanvasAddon.instances[0]!.disposed).toBe(true);
    for (let i = 0; i < 4; i++) {
      observer.emit(false);
      observer.emit(true);
    }
    expect(FakeCanvasAddon.instances).toHaveLength(1);
    expect(term.addons).toHaveLength(1);
    expect(mount().renderer.kind).toBe('dom');
    expect(FakeCanvasAddon.instances).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a queued observer notification arriving after dispose is ignored and leaks no budget', () => {
    const { renderer, term, observer } = mount(false);
    renderer.dispose();
    mounted.splice(mounted.indexOf(renderer), 1);
    observer.emit(true);
    observer.emit(false);
    expect(renderer.kind).toBe('dom');
    expect(term.addons).toHaveLength(0);
    expect(FakeWebglAddon.instances).toHaveLength(0);
    for (let i = 0; i < mod.WEBGL_CONTEXT_BUDGET; i++) expect(mount().renderer.kind).toBe('webgl');
  });

  it('dispose is idempotent and a context loss after dispose does nothing', () => {
    const { renderer, observer } = mount();
    const webgl = FakeWebglAddon.instances[0]!;
    renderer.dispose();
    mounted.splice(mounted.indexOf(renderer), 1);
    renderer.dispose();
    webgl.loseContext();
    observer.emit(true);
    expect(renderer.kind).toBe('dom');
    expect(FakeCanvasAddon.instances).toHaveLength(0);
    expect(FakeWebglAddon.loseContextCalls).toBe(1);
    for (let i = 0; i < mod.WEBGL_CONTEXT_BUDGET; i++) expect(mount().renderer.kind).toBe('webgl');
  });

  it('dispose releases the WebGL context after disposing the terminal', () => {
    const { term, renderer } = mount();
    renderer.dispose();
    mounted.splice(mounted.indexOf(renderer), 1);
    expect(term.disposed).toBe(true);
    expect(FakeWebglAddon.instances[0]!.disposed).toBe(true);
    expect(FakeWebglAddon.loseContextCalls).toBe(1);
    expect(MockIntersectionObserver.instances[0]!.disconnected).toBe(true);
  });

  it('dispose of a canvas-backed terminal touches no WebGL bookkeeping', () => {
    FakeWebglAddon.failAt = 'construct';
    silenceWarnings();
    const { term, renderer } = mount();
    renderer.dispose();
    mounted.splice(mounted.indexOf(renderer), 1);
    expect(term.disposed).toBe(true);
    expect(FakeCanvasAddon.instances[0]!.disposed).toBe(true);
    expect(FakeWebglAddon.loseContextCalls).toBe(0);
  });

  it('mount/dispose churn beyond the budget keeps handing out WebGL and releases every context', () => {
    const cycles = mod.WEBGL_CONTEXT_BUDGET * 3;
    for (let i = 0; i < cycles; i++) {
      const { renderer } = mount();
      expect(renderer.kind).toBe('webgl');
      renderer.dispose();
      mounted.splice(mounted.indexOf(renderer), 1);
    }
    expect(FakeWebglAddon.loseContextCalls).toBe(cycles);
  });

  it('without IntersectionObserver support the renderer is attached immediately', () => {
    delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    const container = document.createElement('div');
    const term = new FakeTerminal();
    term.open(container);
    const renderer = mod.attachRenderer(term as unknown as Xterm, container);
    mounted.push(renderer);
    expect(renderer.kind).toBe('webgl');
  });
});
