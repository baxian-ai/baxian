import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from 'vitest';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';

const fakeTerminals: FakeTerminal[] = [];

class FakeTerminal {
  cols = 80;
  rows = 24;
  onDataCallback: ((data: string) => void) | null = null;
  writes: string[] = [];
  deferWrites = false;
  pendingWriteCallbacks: Array<() => void> = [];
  focusCount = 0;
  resetCount = 0;
  scrollToBottomCount = 0;
  disposed = false;
  opts: Record<string, unknown>;
  renderCallbacks: Array<() => void> = [];
  buffer = { active: { cursorY: 0 } };
  modes = { applicationCursorKeysMode: false };
  oscHandlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
  parser = {
    registerOscHandler: (ident: number, cb: (data: string) => boolean | Promise<boolean>) => {
      this.oscHandlers.set(ident, cb);
      return { dispose: () => { this.oscHandlers.delete(ident); } };
    },
  };

  constructor(opts?: Record<string, unknown>) {
    this.opts = opts ?? {};
    fakeTerminals.push(this);
  }
  loadAddon(): void { }
  open(): void { }
  onData(cb: (data: string) => void): void {
    this.onDataCallback = cb;
  }
  onRender(cb: () => void): { dispose(): void } {
    this.renderCallbacks.push(cb);
    return {
      dispose: () => {
        this.renderCallbacks = this.renderCallbacks.filter(item => item !== cb);
      },
    };
  }
  emitRender(): void {
    for (const cb of this.renderCallbacks) cb();
  }
  write(data: string, cb?: () => void): void {
    this.writes.push(data);
    if (this.deferWrites) {
      if (cb) this.pendingWriteCallbacks.push(cb);
      return;
    }
    cb?.();
  }
  flushNextWrite(): void {
    this.pendingWriteCallbacks.shift()?.();
  }
  reset(): void {
    this.resetCount++;
    this.writes = [];
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  scrollToBottom(): void {
    this.scrollToBottomCount++;
  }
  focus(): void {
    this.focusCount++;
  }
  dispose(): void { this.disposed = true; }
}

class FakeFitAddon {
  static fitCount = 0;
  fit(): void { FakeFitAddon.fitCount++; }
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FakeFitAddon }));
vi.mock('../../src/components/toast.tsx', async () => (await import('../helpers/toast-mock.tsx')).createToastMock());

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static lastInstance: MockWebSocket | undefined;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  url: string;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.lastInstance = this;
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }
  send(payload: string): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error('not open');
    this.sent.push(payload);
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
  deliver(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

class MockResizeObserver {
  static lastCallback: ResizeObserverCallback | null = null;
  callback: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb;
    MockResizeObserver.lastCallback = cb;
  }
  observe(): void { }
  disconnect(): void { }
}

beforeEach(() => {
  fakeTerminals.length = 0;
  FakeFitAddon.fitCount = 0;
  MockResizeObserver.lastCallback = null;
  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
  (globalThis as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
    MockResizeObserver;
  (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
    (cb) => {
      cb(0);
      return 0;
    };
  (globalThis as unknown as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame =
    () => undefined;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 480,
  });
});

afterEach(() => {
  cleanup();
});

type PaneModule = typeof import('../../src/components/pane-terminal.tsx');
type PaneProps = Omit<import('../../src/components/pane-terminal.tsx').PaneTerminalProps, 'agentId'> & {
  agentId?: string;
};

function importPane(): Promise<PaneModule> {
  return import('../../src/components/pane-terminal.tsx');
}

async function renderPane(props: PaneProps): Promise<ReturnType<typeof render> & { term: FakeTerminal }> {
  const { PaneTerminal } = await importPane();
  const result = render(<PaneTerminal agentId="dev-1" {...props} />);
  return Object.assign(result, { term: lastTerminal() });
}

function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

describe('stripTerminalAutoReplies (filter for xterm.js capability-query replies)', () => {
  it.each<[string, Array<[string, string]>]>([
    ['strips secondary DA reply that hz1 was leaking into codex stdin', [['\x1b[>0;276;0c', '']]],
    ['strips primary DA reply', [['\x1b[?64;1;2;6;9;15;18;21;22c', '']]],
    ['strips standard cursor-position report (DSR 6n response)', [['\x1b[24;80R', '']]],
    ['strips DEC private cursor-position report (DSR ?6n response, leading "?")', [['\x1b[?24;80R', '']]],
    ['strips device-status report (DSR 5n response)', [['\x1b[0n', '']]],
    ['strips multiple replies arriving in a single onData chunk', [['\x1b[>0;276;0c\x1b[?64;1c\x1b[24;80R', '']]],
    ['preserves residue when auto-replies are interleaved with real input', [['hello\x1b[>0;276;0cworld', 'helloworld']]],
    ['does NOT strip arrow keys (legit input sharing the CSI prefix)', [
      ['\x1b[A', '\x1b[A'],
      ['\x1b[B', '\x1b[B'],
      ['\x1b[C', '\x1b[C'],
      ['\x1b[D', '\x1b[D'],
    ]],
    ['does NOT strip function keys / home / end / ctrl chars / regular text', [
      ['\x1bOP', '\x1bOP'],
      ['\x1b[H', '\x1b[H'],
      ['\x1b[F', '\x1b[F'],
      ['\x03', '\x03'],
      ['hello', 'hello'],
      ['\r', '\r'],
    ]],
  ])('%s', async (_label, pairs) => {
    const { stripTerminalAutoReplies } = await importPane();
    for (const [input, expected] of pairs) {
      expect(stripTerminalAutoReplies(input)).toBe(expected);
    }
  });
});

describe('parseOsc52Clipboard (OSC 52 clipboard payload parsing)', () => {
  const utf8Text = '复制 👍 café';
  const utf8B64 = btoa(String.fromCharCode(...new TextEncoder().encode(utf8Text)));

  it.each([
    ['a payload with empty selector (tmux emits `;<base64>`)', ';' + btoa('hello'), 'hello'],
    ['a payload with an explicit `c` selector', 'c;' + btoa('world'), 'world'],
    ['UTF-8 multibyte text (round-trip)', 'c;' + utf8B64, utf8Text],
  ])('decodes %s', async (_label, payload, expected) => {
    const { parseOsc52Clipboard } = await importPane();
    expect(parseOsc52Clipboard(payload)).toBe(expected);
  });

  it.each<[string, string[]]>([
    ['ignores read requests (`?`) so the clipboard is never exfiltrated', ['c;?', ';?']],
    ['there is no `;` separator', ['garbage']],
    ['an empty base64 payload', ['c;']],
    ['invalid base64', ['c;@@@@']],
    ['an oversize payload (>1MB base64)', ['c;' + 'A'.repeat(1024 * 1024 + 4)]],
  ])('returns null when %s', async (_label, payloads) => {
    const { parseOsc52Clipboard } = await importPane();
    for (const payload of payloads) {
      expect(parseOsc52Clipboard(payload)).toBeNull();
    }
  });
});

describe('parseOsc52Clipboard wired to the real xterm OSC parser (chunk reassembly)', () => {
  it('reassembles a fragmented OSC 52 sequence and invokes the handler once with the full payload', async () => {
    const { Terminal } = await import('@xterm/headless');
    const { parseOsc52Clipboard } = await importPane();
    const term = new Terminal({ allowProposedApi: true });
    const seen: string[] = [];
    term.parser.registerOscHandler(52, (payload) => {
      const text = parseOsc52Clipboard(payload);
      if (text !== null) seen.push(text);
      return true;
    });
    const seq = '\x1b]52;c;' + btoa('chunked clip') + '\x07';
    term.write(seq.slice(0, 9));
    await new Promise<void>((resolve) => term.write(seq.slice(9), () => resolve()));
    expect(seen).toEqual(['chunked clip']);
    term.dispose();
  });
});

describe('PaneTerminal', () => {
  it('applies Zed light theme to the xterm instance', async () => {
    const { PaneTerminal, ZED_LIGHT_THEME, TERMINAL_BG } = await importPane();
    const { container } = render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    const term = lastTerminal();
    expect(term.opts.theme).toBe(ZED_LIGHT_THEME);
    expect(ZED_LIGHT_THEME.background).toBe(TERMINAL_BG);
    expect(ZED_LIGHT_THEME.foreground).toBe('#474c55');
    expect(ZED_LIGHT_THEME.blue).toBe('#1348dc');
    expect(ZED_LIGHT_THEME.cursor).toBe('#1348dc');
    expect(container.querySelector(`[class*="bg-term"]`)).not.toBeNull();
  });

  it('forwards Ctrl+Q as terminal input', async () => {
    const { term, ws, sid } = await mountWithHandshake({ mode: 'full', interactive: true });
    const before = ws.sent.length;
    term.onDataCallback!(String.fromCharCode(17));
    const sentAfterInput = inputsSince(ws, before);
    expect(sentAfterInput).toContainEqual({ op: 'input', subscriberId: sid, data: String.fromCharCode(17) });
  });

  it('non-interactive mode does not register an onData handler', async () => {
    const { term } = await renderPane({ mode: 'preview', interactive: false });
    expect(term.onDataCallback).toBeNull();
  });

  it('interactive mode registers an OSC 52 handler that writes decoded text to the clipboard', async () => {
    const writeText = stubClipboard();
    const { term } = await renderPane({ mode: 'full', interactive: true });
    const handler = term.oscHandlers.get(52);
    expect(handler).toBeTypeOf('function');
    const handled = handler!(';' + btoa('copied text'));
    expect(handled).toBe(true);
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('copied text');
  });

  it('interactive OSC 52 handler ignores read requests (no clipboard read/exfiltration)', async () => {
    const writeText = stubClipboard();
    const { term } = await renderPane({ mode: 'full', interactive: true });
    const handled = term.oscHandlers.get(52)!('c;?');
    expect(handled).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('non-interactive mode does not register an OSC 52 handler', async () => {
    const { term } = await renderPane({ mode: 'preview', interactive: false });
    expect(term.oscHandlers.get(52)).toBeUndefined();
  });

  it('interactive but deferred (preview until focus) does NOT register an OSC 52 handler yet', async () => {
    const { term } = await renderPane({ mode: 'full', interactive: true, autoFocus: false, deferFullUntilFocus: true });
    expect(term.oscHandlers.get(52)).toBeUndefined();
  });

  it('preview mode never calls FitAddon.fit (preserves server-side pane geometry)', async () => {
    await renderPane({ mode: 'preview', interactive: false });
    expect(FakeFitAddon.fitCount).toBe(0);
  });

  it('full+interactive mode does call FitAddon.fit', async () => {
    await renderPane({ mode: 'full', interactive: true });
    expect(FakeFitAddon.fitCount).toBeGreaterThan(0);
  });

  it('can keep an interactive embedded terminal from stealing focus on mount', async () => {
    const { term } = await renderPane({ mode: 'full', interactive: true, autoFocus: false });
    expect(term.onDataCallback).not.toBeNull();
    expect(term.focusCount).toBe(0);
  });

  it('defers embedded full subscription until the terminal is focused', async () => {
    const { container, ws1 } = await renderDeferredPane();
    expect(sentMessages(ws1).find((m) => m.op === 'subscribe')?.mode).toBe('preview');
    expect(FakeFitAddon.fitCount).toBe(0);

    const xtermHost = container.querySelector('.overflow-hidden') as HTMLDivElement;
    await act(async () => {
      fireEvent.mouseDown(xtermHost);
      await flushMacrotask();
    });
    expect(fakeTerminals[0].focusCount).toBe(1);
    expect(fakeTerminals.length).toBeGreaterThan(1);

    const ws2 = lastMockWs()!;
    await act(async () => {
      await flushMacrotask();
    });
    expect(subscribeModesAcross(ws1, ws2)).toEqual(['preview', 'full']);
    expect(FakeFitAddon.fitCount).toBeGreaterThan(0);
  });

  it('forwards the first deferred keystroke after the full subscription is active', async () => {
    const { ws1 } = await renderDeferredPane();
    const term = fakeTerminals[0];

    await act(async () => {
      term.onDataCallback!('a');
      await flushMacrotask();
    });
    expect(fakeTerminals.length).toBeGreaterThan(1);

    const { ws2, fullSid } = await activateFullSubscription();
    expect(messagesAcross(ws1, ws2).filter((m) => m.op === 'input')).toHaveLength(0);

    await deliverHandshake(ws2, fullSid);
    expect(sentMessages(ws2).filter((m) => m.op === 'input'))
      .toContainEqual({ op: 'input', subscriberId: fullSid, data: 'a' });
  });

  it('debounces ResizeObserver fires: window-drag bursts collapse to a single trailing fit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { term } = await renderPane({ mode: 'full', interactive: true });
      expect(FakeFitAddon.fitCount).toBe(1);
      expect(MockResizeObserver.lastCallback).not.toBeNull();
      const scrollsAfterInitialFit = term.scrollToBottomCount;
      const cb = MockResizeObserver.lastCallback!;
      for (let i = 0; i < 5; i++) {
        cb([], {} as ResizeObserver);
        vi.advanceTimersByTime(20);
      }
      expect(FakeFitAddon.fitCount).toBe(1);
      vi.advanceTimersByTime(150);
      expect(FakeFitAddon.fitCount).toBe(2);
      expect(term.scrollToBottomCount).toBeGreaterThan(scrollsAfterInitialFit);
    } finally {
      vi.useRealTimers();
    }
  });

  it('snapshot path calls term.reset() before write so reconnects do not append', async () => {
    const { term, ws, sid } = await mountWithHandshake({ mode: 'preview', interactive: false }, { data: 'AAA' });
    expect(sid).toBeTruthy();
    expect(term.resetCount).toBe(1);
    expect(term.writes).toEqual(['AAA']);
    ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 80, rows: 24, data: 'BBB', snapshotSeq: 2 });
    await flushMicrotask();
    expect(term.resetCount).toBe(2);
    expect(term.writes).toEqual(['BBB']);
  });

  it('resizable snapshot fits the container instead of adopting server pane geometry, then pins to bottom (keeps the agent bottom bar in view)', async () => {
    const { term } = await mountWithHandshake({ mode: 'full', interactive: true }, { cols: 200, rows: 50, data: 'AAA' });
    expect(term.cols).toBe(80);
    expect(term.rows).toBe(24);
    expect(term.writes).toEqual(['AAA']);
    expect(term.scrollToBottomCount).toBeGreaterThan(0);
  });

  it('preview snapshot adopts server pane geometry and never force-scrolls xterm to bottom', async () => {
    const { term } = await mountWithHandshake({ mode: 'preview', interactive: false }, { cols: 200, rows: 50, data: 'AAA' });
    expect(term.cols).toBe(200);
    expect(term.rows).toBe(50);
    expect(term.scrollToBottomCount).toBe(0);
  });

  it('batches live data into one xterm write per animation frame and keeps the resizable pane pinned to bottom', async () => {
    const { term, ws } = await mountWithHandshake({ mode: 'full', interactive: true }, { data: 'base' });
    expect(term.writes).toEqual(['base']);
    const scrollsAfterSnapshot = term.scrollToBottomCount;

    const rafCallbacks = captureRaf();
    ws.deliver({ type: 'data', agentId: 'dev-1', data: 'A', seq: 2 });
    ws.deliver({ type: 'data', agentId: 'dev-1', data: 'B', seq: 3 });
    expect(rafCallbacks).toHaveLength(1);
    expect(term.writes).toEqual(['base']);
    await act(async () => {
      rafCallbacks[0](0);
      await Promise.resolve();
    });
    expect(term.writes).toEqual(['base', 'AB']);
    expect(term.scrollToBottomCount).toBeGreaterThan(scrollsAfterSnapshot);
  });

  it('flushes live data via timeout when animation frames are throttled', async () => {
    const { term, ws } = await mountWithHandshake({ mode: 'full', interactive: true }, { data: 'base' });
    const rafCallbacks = captureRaf();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      ws.deliver({ type: 'data', agentId: 'dev-1', data: 'A', seq: 2 });
      ws.deliver({ type: 'data', agentId: 'dev-1', data: 'B', seq: 3 });
      expect(rafCallbacks).toHaveLength(1);
      expect(term.writes).toEqual(['base']);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(249);
        await Promise.resolve();
      });
      expect(term.writes).toEqual(['base']);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
      });
      expect(term.writes).toEqual(['base', 'AB']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes immediately when the live queue reaches its memory cap', async () => {
    const { term, ws } = await mountWithHandshake({ mode: 'full', interactive: true }, { data: 'base' });
    const rafSpy = vi.fn<(cb: FrameRequestCallback) => number>(() => 1);
    (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
      rafSpy;
    const largeChunk = 'x'.repeat(256 * 1024);
    ws.deliver({ type: 'data', agentId: 'dev-1', data: largeChunk, seq: 2 });
    await flushMicrotask();

    expect(rafSpy).not.toHaveBeenCalled();
    expect(term.writes).toHaveLength(2);
    expect(term.writes[1]).toHaveLength(largeChunk.length);
  });

  it('queues snapshot reset behind an in-flight live write so stale live output is cleared', async () => {
    const { term, ws, sid } = await mountWithHandshake({ mode: 'full', interactive: true }, { data: 'base' });
    expect(term.writes).toEqual(['base']);
    expect(term.resetCount).toBe(1);

    term.deferWrites = true;
    ws.deliver({ type: 'data', agentId: 'dev-1', data: 'old-live', seq: 2 });
    await flushMicrotask();
    expect(term.writes).toEqual(['base', 'old-live']);
    expect(term.pendingWriteCallbacks).toHaveLength(1);

    ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 80, rows: 24, data: 'fresh', snapshotSeq: 3 });
    await flushMicrotask();
    expect(term.resetCount).toBe(1);
    expect(term.writes).toEqual(['base', 'old-live']);

    term.flushNextWrite();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(term.resetCount).toBe(2);
    expect(term.writes).toEqual(['fresh']);
    term.flushNextWrite();
  });

  it('focuses on mouse down', async () => {
    await installPaneStreamForTest();
    const { container, term } = await renderPane({ mode: 'full', interactive: true });
    const xtermHost = container.querySelector('.overflow-hidden') as HTMLDivElement;
    expect(term.focusCount).toBe(1);
    fireEvent.mouseDown(xtermHost);
    expect(term.focusCount).toBe(2);
  });

  it('scroll container is padding-free (vertical padding lives on the outer wrapper so scrollTop stays a pure row offset)', async () => {
    const { container } = await renderPane({ mode: 'preview', interactive: false, maxLines: 6 });
    const scrollEl = container.querySelector('.overflow-hidden') as HTMLDivElement;
    expect(scrollEl).toBeTruthy();
    expect(scrollEl.className).not.toMatch(/(^|\s)p[ytb]?-/);
    const padWrapper = scrollEl.parentElement!;
    expect(padWrapper.className).toContain('py-1.5');
    expect(padWrapper.className).toContain('px-2');
  });

  it('preview clipping scrolls container so cursor row anchors to the bottom (not the top)', async () => {
    const { scrollState } = await mountWithScrollAnchor({
      scroll: { scrollHeight: 900, clientHeight: 108 },
      props: { mode: 'preview', interactive: false, maxLines: 6 },
      cursorY: 42,
      handshake: { cols: 200, rows: 50, data: 'AAA' },
    });
    expect(scrollState.value).toBe(666);
  });

  it('embedded preview (no maxLines) still anchors the cursor row to the bottom so the card shows the latest, not the top', async () => {
    const { scrollState } = await mountWithScrollAnchor({
      scroll: { clientHeight: 300 },
      props: { mode: 'preview', interactive: false },
      cursorY: 42,
      handshake: { cols: 200, rows: 50, data: 'AAA' },
    });
    expect(scrollState.value).toBe(474);
  });

  it('preview re-anchors when its card becomes measurable after the first snapshot', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );

    const scrollState = { value: 0 };
    let visibleHeight = 0;
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get() { return scrollState.value; },
      set(v: number) { scrollState.value = v; },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => visibleHeight,
    });

    try {
      const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
      render(<PaneTerminal agentId="dev-1" mode="preview" interactive={false} />);
      const term = fakeTerminals[fakeTerminals.length - 1];
      term.buffer.active.cursorY = 42;
      await new Promise((r) => setTimeout(r, 0));
      const ws = lastMockWs()!;
      const sid = ws.sent
        .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string })
        .find((m) => m.op === 'subscribe')!.subscriberId!;
      ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 200, rows: 50, data: 'AAA', snapshotSeq: 1 });
      ws.deliver({ type: 'subscribed', subscriberId: sid, agentId: 'dev-1', cols: 200, rows: 50, snapshotSeq: 1 });
      await act(async () => {
        await Promise.resolve();
      });
      expect(scrollState.value).toBe(0);
      expect(MockResizeObserver.lastCallback).not.toBeNull();

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        visibleHeight = 300;
        MockResizeObserver.lastCallback!([], {} as ResizeObserver);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
          await Promise.resolve();
        });
      } finally {
        vi.useRealTimers();
      }

      expect(scrollState.value).toBe(474);
    } finally {
      // @ts-expect-error remove scrollTop shim
      delete HTMLElement.prototype.scrollTop;
      // @ts-expect-error remove clientHeight shim — beforeEach re-installs the default 480 for the next case
      delete HTMLElement.prototype.clientHeight;
      _resetPaneStreamClientForTest(null);
    }
  });

  it('preview re-anchors after xterm renders rows for already-written data', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );

    const scrollState = { value: 0 };
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get() { return scrollState.value; },
      set(v: number) { scrollState.value = v; },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 300,
    });

    try {
      const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
      render(<PaneTerminal agentId="dev-1" mode="preview" interactive={false} />);
      const term = fakeTerminals[fakeTerminals.length - 1];
      term.buffer.active.cursorY = 10;
      await new Promise((r) => setTimeout(r, 0));
      const ws = lastMockWs()!;
      const sid = ws.sent
        .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string })
        .find((m) => m.op === 'subscribe')!.subscriberId!;
      ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 200, rows: 50, data: 'AAA', snapshotSeq: 1 });
      ws.deliver({ type: 'subscribed', subscriberId: sid, agentId: 'dev-1', cols: 200, rows: 50, snapshotSeq: 1 });
      await act(async () => {
        await Promise.resolve();
      });
      expect(scrollState.value).toBe(0);

      term.buffer.active.cursorY = 42;
      act(() => {
        term.emitRender();
      });

      expect(scrollState.value).toBe(474);
    } finally {
      // @ts-expect-error remove scrollTop shim
      delete HTMLElement.prototype.scrollTop;
      // @ts-expect-error remove clientHeight shim — beforeEach re-installs the default 480 for the next case
      delete HTMLElement.prototype.clientHeight;
      _resetPaneStreamClientForTest(null);
    }
  });

  it('non-preview (no maxLines) leaves container scrollTop alone — no clipping to compensate for', async () => {
    const { scrollState } = await mountWithScrollAnchor({
      props: { mode: 'full', interactive: false },
      cursorY: 23,
      handshake: { data: 'AAA' },
    });
    expect(scrollState.writes).toBe(0);
    expect(MockResizeObserver.lastCallback).toBeNull();
  });

  it('arrowKeys prop defaults off — no virtual key pad rendered', async () => {
    await renderPane({ mode: 'full', interactive: true });
    expect(screen.queryByRole('group', { name: /终端按键/ })).toBeNull();
  });

  it('arrowKeys prop renders the key pad and clicking an arrow forwards its CSI sequence as terminal input', async () => {
    const { ws, sid } = await mountWithHandshake({ mode: 'full', interactive: true, arrowKeys: true });
    const before = ws.sent.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /方向键 上/ }));
    });
    expect(inputsSince(ws, before)).toContainEqual({ op: 'input', subscriberId: sid, data: '\x1b[A' });
  });

  it('arrowKeyToSequence picks CSI in normal mode and SS3 when xterm reports application cursor mode (DECCKM)', async () => {
    const { arrowKeyToSequence } = await importPane();
    const cases: Array<['up' | 'down' | 'left' | 'right', boolean, string]> = [
      ['up', false, '\x1b[A'],
      ['down', false, '\x1b[B'],
      ['right', false, '\x1b[C'],
      ['left', false, '\x1b[D'],
      ['up', true, '\x1bOA'],
      ['down', true, '\x1bOB'],
      ['right', true, '\x1bOC'],
      ['left', true, '\x1bOD'],
    ];
    for (const [key, appCursor, expected] of cases) {
      expect(arrowKeyToSequence(key, appCursor)).toBe(expected);
    }
  });

  it('keypad reads live applicationCursorKeysMode at click time — flipping the mode switches CSI ↔ SS3 without re-render', async () => {
    const { term, ws } = await mountWithHandshake({ mode: 'full', interactive: true, arrowKeys: true });
    const before1 = ws.sent.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /方向键 上/ }));
    });
    expect(ws.sent.slice(before1).map((s) => JSON.parse(s).data)).toContain('\x1b[A');

    term.modes.applicationCursorKeysMode = true;
    const before2 = ws.sent.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /方向键 上/ }));
    });
    expect(ws.sent.slice(before2).map((s) => JSON.parse(s).data)).toContain('\x1bOA');
  });

  it('rapid keypad taps in defer mode all queue or land on the post-activation full subscriber (no input lost to preview sid)', async () => {
    const { ws1 } = await renderDeferredPane({ arrowKeys: true });
    const previewSid = sentMessages(ws1).find((m) => m.op === 'subscribe' && m.mode === 'preview')!.subscriberId!;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /方向键 上/ }));
      fireEvent.click(screen.getByRole('button', { name: /方向键 下/ }));
      fireEvent.click(screen.getByRole('button', { name: /方向键 右/ }));
      await flushMacrotask();
    });
    const { ws2, fullSid } = await activateFullSubscription();
    await deliverHandshake(ws2, fullSid);

    const allInputs = messagesAcross(ws1, ws2).filter((m) => m.op === 'input');
    expect(allInputs.every((m) => m.subscriberId !== previewSid)).toBe(true);
    expect(allInputs.map((m) => m.data).join('')).toBe('\x1b[A\x1b[B\x1b[C');
  });

  it('keypad input flows through the same input pipeline as keyboard (shares stripTerminalAutoReplies + defer logic)', async () => {
    const { term, ws } = await mountWithHandshake({ mode: 'full', interactive: true, arrowKeys: true });
    const before = ws.sent.length;
    await act(async () => {
      term.onDataCallback!('\x1b[24;80Rhello');
      fireEvent.click(screen.getByRole('button', { name: /方向键 上/ }));
    });
    const inputs = inputsSince(ws, before)
      .filter((m) => m.op === 'input')
      .map((m) => m.data);
    expect(inputs).toEqual(['hello', '\x1b[A']);
  });

  it('arrowKeys + deferFullUntilFocus: first arrow click activates the full stream and forwards the keystroke', async () => {
    const { ws1 } = await renderDeferredPane({ arrowKeys: true });
    expect(sentMessages(ws1).find((m) => m.op === 'subscribe')?.mode).toBe('preview');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /方向键 下/ }));
      await flushMacrotask();
    });
    expect(fakeTerminals.length).toBeGreaterThan(1);

    const { ws2, fullSid } = await activateFullSubscription();
    await deliverHandshake(ws2, fullSid);
    expect(sentMessages(ws2).filter((m) => m.op === 'input'))
      .toContainEqual({ op: 'input', subscriberId: fullSid, data: '\x1b[B' });
  });

  it('non-interactive: wheel events are stopped in capture phase so the page (not xterm) handles scroll', async () => {
    const { container } = await renderPane({ mode: 'preview', interactive: false });
    const xtermHost = container.querySelector('.overflow-hidden') as HTMLDivElement;
    expect(xtermHost).toBeTruthy();
    const bubbleListener = fireWheelFromChild(xtermHost);
    expect(bubbleListener).not.toHaveBeenCalled();
  });

  it('interactive: wheel events propagate normally so xterm can drive its own scrollback', async () => {
    const { container } = await renderPane({ mode: 'full', interactive: true });
    const xtermHost = container.querySelector('.overflow-hidden') as HTMLDivElement;
    const bubbleListener = fireWheelFromChild(xtermHost);
    expect(bubbleListener).toHaveBeenCalledTimes(1);
  });

  it('changing agentId clears stale error/session-gone banner', async () => {
    await installPaneStreamForTest();
    const { PaneTerminal } = await importPane();
    const { rerender, container } = render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    await flushMacrotask();
    const ws = lastMockWs()!;
    await act(async () => {
      ws.deliver({ type: 'session_gone', agentId: 'dev-1' });
    });
    expect(container.textContent).toContain('会话已结束');
    await act(async () => {
      rerender(<PaneTerminal agentId="dev-2" mode="full" interactive />);
    });
    expect(container.textContent).not.toContain('会话已结束');
  });
});

describe('PaneTerminal image upload bar', () => {
  it('shows the upload button on the full terminal page (interactive + arrow keys)', async () => {
    const { _resetPaneStreamClientForTest } = await import('../../src/stores/pane-stream-store.ts');
    await renderPane({ mode: 'full', interactive: true, arrowKeys: true });
    await flushMacrotask();
    expect(screen.getByRole('button', { name: /上传图片/ })).toBeTruthy();
    _resetPaneStreamClientForTest(null);
  });

  it('does not show the upload button in non-interactive preview mode', async () => {
    const { _resetPaneStreamClientForTest } = await import('../../src/stores/pane-stream-store.ts');
    await renderPane({ mode: 'preview', interactive: false });
    await flushMacrotask();
    expect(screen.queryByRole('button', { name: /上传图片/ })).toBeNull();
    _resetPaneStreamClientForTest(null);
  });
});

describe('PaneTerminal control bar layout', () => {
  it('centers the key pad relative to the whole bar via symmetric gutters, not the space beside the upload button', async () => {
    await renderPane({ mode: 'full', interactive: true, arrowKeys: true });
    await flushMacrotask();

    const keypad = screen.getByRole('group', { name: /终端按键/ });
    const bar = keypad.parentElement!;
    expect(bar.className).toContain('grid');
    expect(bar.className).toContain('grid-cols-[1fr_auto_1fr]');
    expect(bar.className).toMatch(/\bgap(-x)?-2\b/);
    expect(keypad.className).not.toContain('flex-1');
    expect(screen.getByRole('button', { name: /上传图片/ })).toBeTruthy();
  });

  it('hides the whole bar (upload + key pad) when arrow keys are disabled', async () => {
    await renderPane({ mode: 'full', interactive: true });
    await flushMacrotask();
    expect(screen.queryByRole('button', { name: /上传图片/ })).toBeNull();
    expect(screen.queryByRole('group', { name: /终端按键/ })).toBeNull();
  });
});

function lastMockWs(): MockWebSocket | undefined {
  return MockWebSocket.lastInstance;
}

function lastTerminal(): FakeTerminal {
  return fakeTerminals[fakeTerminals.length - 1];
}

function flushMacrotask(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function flushMicrotask(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
  });
}

type StreamMessage = {
  op?: string;
  subscriberId?: string;
  mode?: string;
  data?: string;
  agentId?: string;
};

function sentMessages(ws: MockWebSocket): StreamMessage[] {
  return ws.sent.map((s) => JSON.parse(s) as StreamMessage);
}

function subscriberIdOf(ws: MockWebSocket): string {
  return sentMessages(ws).find((m) => m.op === 'subscribe')!.subscriberId!;
}

function inputsSince(ws: MockWebSocket, before: number): StreamMessage[] {
  return ws.sent.slice(before).map((s) => JSON.parse(s) as StreamMessage);
}

function messagesAcross(ws1: MockWebSocket, ws2: MockWebSocket): StreamMessage[] {
  return [...sentMessages(ws1), ...(ws2 === ws1 ? [] : sentMessages(ws2))];
}

function subscribeModesAcross(ws1: MockWebSocket, ws2: MockWebSocket): Array<string | undefined> {
  return messagesAcross(ws1, ws2)
    .filter((m) => m.op === 'subscribe')
    .map((m) => m.mode);
}

function fireWheelFromChild(xtermHost: HTMLElement): ReturnType<typeof vi.fn> {
  const child = document.createElement('div');
  xtermHost.appendChild(child);
  const bubbleListener = vi.fn();
  xtermHost.addEventListener('wheel', bubbleListener);
  fireEvent.wheel(child, { deltaY: 100 });
  return bubbleListener;
}

function captureRaf(): FrameRequestCallback[] {
  const rafCallbacks: FrameRequestCallback[] = [];
  (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
    (cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };
  return rafCallbacks;
}

interface ScrollStub {
  value: number;
  writes: number;
  restore: () => void;
}

function stubScroll(overrides: { scrollHeight?: number; clientHeight?: number } = {}): ScrollStub {
  const state: ScrollStub = { value: 0, writes: 0, restore: () => undefined };
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get() { return state.value; },
    set(v: number) { state.value = v; state.writes++; },
  });
  if (overrides.scrollHeight !== undefined) {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => overrides.scrollHeight!,
    });
  }
  if (overrides.clientHeight !== undefined) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => overrides.clientHeight!,
    });
  }
  state.restore = () => {
    delete (HTMLElement.prototype as { scrollTop?: unknown }).scrollTop;
    if (overrides.scrollHeight !== undefined) {
      delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
    }
    if (overrides.clientHeight !== undefined) {
      delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  };
  return state;
}

async function deliverHandshake(
  ws: MockWebSocket,
  sid: string,
  opts: { cols?: number; rows?: number; data?: string; snapshotSeq?: number } = {},
): Promise<void> {
  const { cols = 80, rows = 24, data = '', snapshotSeq = 1 } = opts;
  ws.deliver({ type: 'snapshot', subscriberId: sid, cols, rows, data, snapshotSeq });
  ws.deliver({ type: 'subscribed', subscriberId: sid, agentId: 'dev-1', cols, rows, snapshotSeq });
  await act(async () => {
    await Promise.resolve();
  });
}

interface MountOptions {
  mode: 'full' | 'preview';
  interactive: boolean;
  arrowKeys?: boolean;
}

interface MountedPane {
  term: FakeTerminal;
  ws: MockWebSocket;
  sid: string;
}

async function installPaneStreamForTest(): Promise<void> {
  const { _resetPaneStreamClientForTest, PaneStreamClient } =
    await import('../../src/stores/pane-stream-store.ts');
  _resetPaneStreamClientForTest(
    new PaneStreamClient({
      wsUrl: 'ws://test.local/api/stream',
      wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
      tokenProvider: () => null,
    }),
  );
  onTestFinished(() => _resetPaneStreamClientForTest(null));
}

async function mountWithHandshake(
  props: MountOptions,
  handshake: { cols?: number; rows?: number; data?: string } = {},
): Promise<MountedPane> {
  await installPaneStreamForTest();
  const { PaneTerminal } = await importPane();
  render(
    <PaneTerminal
      agentId="dev-1"
      mode={props.mode}
      interactive={props.interactive}
      arrowKeys={props.arrowKeys}
    />,
  );
  const term = lastTerminal();
  await flushMacrotask();
  const ws = lastMockWs()!;
  const sid = subscriberIdOf(ws);
  await deliverHandshake(ws, sid, handshake);
  return { term, ws, sid };
}

async function mountWithScrollAnchor(spec: {
  scroll?: { scrollHeight?: number; clientHeight?: number };
  props: PaneProps;
  cursorY: number;
  handshake?: { cols?: number; rows?: number; data?: string };
}): Promise<{ scrollState: ScrollStub }> {
  const scrollState = stubScroll(spec.scroll ?? {});
  onTestFinished(() => scrollState.restore());
  await installPaneStreamForTest();
  const { term } = await renderPane(spec.props);
  term.buffer.active.cursorY = spec.cursorY;
  await flushMacrotask();
  const ws = lastMockWs()!;
  await deliverHandshake(ws, subscriberIdOf(ws), spec.handshake);
  return { scrollState };
}

async function renderDeferredPane(
  opts: { arrowKeys?: boolean } = {},
): Promise<{ container: HTMLElement; ws1: MockWebSocket }> {
  await installPaneStreamForTest();
  const { PaneTerminal } = await importPane();
  const { container } = render(
    <PaneTerminal
      agentId="dev-1"
      mode="full"
      interactive
      arrowKeys={opts.arrowKeys}
      autoFocus={false}
      deferFullUntilFocus
    />,
  );
  await flushMacrotask();
  return { container, ws1: lastMockWs()! };
}

async function activateFullSubscription(): Promise<{ ws2: MockWebSocket; fullSid: string }> {
  const ws2 = lastMockWs()!;
  await act(async () => {
    await flushMacrotask();
  });
  const fullSubscribe = sentMessages(ws2).find((m) => m.op === 'subscribe' && m.mode === 'full');
  expect(fullSubscribe?.subscriberId).toBeTruthy();
  return { ws2, fullSid: fullSubscribe!.subscriberId! };
}
