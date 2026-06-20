import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  loadAddon(): void { /* no-op */ }
  open(): void { /* no-op */ }
  onData(cb: (data: string) => void): void {
    this.onDataCallback = cb;
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
vi.mock('../../src/components/toast.tsx', () => ({ useToast: () => ({ show: vi.fn() }) }));

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

class MockResizeObserver {
  static lastCallback: ResizeObserverCallback | null = null;
  callback: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb;
    MockResizeObserver.lastCallback = cb;
  }
  observe(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}

describe('stripTerminalAutoReplies (filter for xterm.js capability-query replies)', () => {
  it('strips secondary DA reply that hz1 was leaking into codex stdin', async () => {
    const { stripTerminalAutoReplies } = await import('../../src/components/pane-terminal.tsx');
    expect(stripTerminalAutoReplies('\x1b[>0;276;0c')).toBe('');
  });

  it('strips primary DA reply', async () => {
    const { stripTerminalAutoReplies } = await import('../../src/components/pane-terminal.tsx');
    expect(stripTerminalAutoReplies('\x1b[?64;1;2;6;9;15;18;21;22c')).toBe('');
  });

  it('strips standard cursor-position report (DSR 6n response)', async () => {
    const { stripTerminalAutoReplies } = await import('../../src/components/pane-terminal.tsx');
    expect(stripTerminalAutoReplies('\x1b[24;80R')).toBe('');
  });

  it('strips DEC private cursor-position report (DSR ?6n response, leading "?")', async () => {
    const { stripTerminalAutoReplies } = await import('../../src/components/pane-terminal.tsx');
    expect(stripTerminalAutoReplies('\x1b[?24;80R')).toBe('');
  });

  it('strips device-status report (DSR 5n response)', async () => {
    const { stripTerminalAutoReplies } = await import('../../src/components/pane-terminal.tsx');
    expect(stripTerminalAutoReplies('\x1b[0n')).toBe('');
  });

  it('strips multiple replies arriving in a single onData chunk', async () => {
    const { stripTerminalAutoReplies } = await import('../../src/components/pane-terminal.tsx');
    expect(stripTerminalAutoReplies('\x1b[>0;276;0c\x1b[?64;1c\x1b[24;80R')).toBe('');
  });

  it('preserves residue when auto-replies are interleaved with real input', async () => {
    const { stripTerminalAutoReplies } = await import('../../src/components/pane-terminal.tsx');
    expect(stripTerminalAutoReplies('hello\x1b[>0;276;0cworld')).toBe('helloworld');
  });

  it('does NOT strip arrow keys (legit input sharing the CSI prefix)', async () => {
    const { stripTerminalAutoReplies } = await import('../../src/components/pane-terminal.tsx');
    expect(stripTerminalAutoReplies('\x1b[A')).toBe('\x1b[A');
    expect(stripTerminalAutoReplies('\x1b[B')).toBe('\x1b[B');
    expect(stripTerminalAutoReplies('\x1b[C')).toBe('\x1b[C');
    expect(stripTerminalAutoReplies('\x1b[D')).toBe('\x1b[D');
  });

  it('does NOT strip function keys / home / end / ctrl chars / regular text', async () => {
    const { stripTerminalAutoReplies } = await import('../../src/components/pane-terminal.tsx');
    expect(stripTerminalAutoReplies('\x1bOP')).toBe('\x1bOP'); // F1
    expect(stripTerminalAutoReplies('\x1b[H')).toBe('\x1b[H'); // Home
    expect(stripTerminalAutoReplies('\x1b[F')).toBe('\x1b[F'); // End
    expect(stripTerminalAutoReplies('\x03')).toBe('\x03');     // Ctrl+C
    expect(stripTerminalAutoReplies('hello')).toBe('hello');
    expect(stripTerminalAutoReplies('\r')).toBe('\r');
  });
});

describe('parseOsc52Clipboard (OSC 52 clipboard payload parsing)', () => {
  it('decodes a payload with empty selector (tmux emits `;<base64>`)', async () => {
    const { parseOsc52Clipboard } = await import('../../src/components/pane-terminal.tsx');
    expect(parseOsc52Clipboard(';' + btoa('hello'))).toBe('hello');
  });

  it('decodes a payload with an explicit `c` selector', async () => {
    const { parseOsc52Clipboard } = await import('../../src/components/pane-terminal.tsx');
    expect(parseOsc52Clipboard('c;' + btoa('world'))).toBe('world');
  });

  it('round-trips UTF-8 multibyte text', async () => {
    const { parseOsc52Clipboard } = await import('../../src/components/pane-terminal.tsx');
    const text = '复制 👍 café';
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    expect(parseOsc52Clipboard('c;' + b64)).toBe(text);
  });

  it('ignores read requests (`?`) so the clipboard is never exfiltrated', async () => {
    const { parseOsc52Clipboard } = await import('../../src/components/pane-terminal.tsx');
    expect(parseOsc52Clipboard('c;?')).toBeNull();
    expect(parseOsc52Clipboard(';?')).toBeNull();
  });

  it('returns null when there is no `;` separator', async () => {
    const { parseOsc52Clipboard } = await import('../../src/components/pane-terminal.tsx');
    expect(parseOsc52Clipboard('garbage')).toBeNull();
  });

  it('returns null for an empty base64 payload', async () => {
    const { parseOsc52Clipboard } = await import('../../src/components/pane-terminal.tsx');
    expect(parseOsc52Clipboard('c;')).toBeNull();
  });

  it('returns null for invalid base64', async () => {
    const { parseOsc52Clipboard } = await import('../../src/components/pane-terminal.tsx');
    expect(parseOsc52Clipboard('c;@@@@')).toBeNull();
  });

  it('returns null for an oversize payload (>1MB base64)', async () => {
    const { parseOsc52Clipboard } = await import('../../src/components/pane-terminal.tsx');
    expect(parseOsc52Clipboard('c;' + 'A'.repeat(1024 * 1024 + 4))).toBeNull();
  });
});

// Real xterm parser (canvas-free @xterm/headless; only @xterm/xterm is mocked above) to prove the
// handler we register fires exactly once on a fragmented OSC 52, the way the live PTY stream chunks it.
describe('parseOsc52Clipboard wired to the real xterm OSC parser (chunk reassembly)', () => {
  it('reassembles a fragmented OSC 52 sequence and invokes the handler once with the full payload', async () => {
    const { Terminal } = await import('@xterm/headless');
    const { parseOsc52Clipboard } = await import('../../src/components/pane-terminal.tsx');
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
    const { PaneTerminal, ZED_LIGHT_THEME, TERMINAL_BG } = await import(
      '../../src/components/pane-terminal.tsx'
    );
    const { container } = render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    expect(term.opts.theme).toBe(ZED_LIGHT_THEME);
    expect(ZED_LIGHT_THEME.background).toBe(TERMINAL_BG);
    expect(ZED_LIGHT_THEME.foreground).toBe('#474c55');
    expect(ZED_LIGHT_THEME.blue).toBe('#1348dc');
    expect(ZED_LIGHT_THEME.cursor).toBe('#1348dc');
    expect(container.querySelector(`[class*="bg-[#fdfdfd]"]`)).not.toBeNull();
  });

  it('forwards Ctrl+Q as terminal input', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    await new Promise((r) => setTimeout(r, 0));
    const ws = lastMockWs()!;
    const subscribeMsg = ws.sent
      .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string })
      .find((m) => m.op === 'subscribe');
    const sid = subscribeMsg!.subscriberId!;
    ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 80, rows: 24, data: '', snapshotSeq: 1 });
    ws.deliver({ type: 'subscribed', subscriberId: sid, agentId: 'dev-1', cols: 80, rows: 24, snapshotSeq: 1 });
    await act(async () => {
      await Promise.resolve();
    });

    const before = ws.sent.length;
    term.onDataCallback!(String.fromCharCode(17));
    const sentAfterInput = ws.sent
      .slice(before)
      .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string; data?: string });
    expect(sentAfterInput).toContainEqual({ op: 'input', subscriberId: sid, data: String.fromCharCode(17) });
    _resetPaneStreamClientForTest(null);
  });

  it('non-interactive mode does not register an onData handler', async () => {
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="preview" interactive={false} />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    expect(term.onDataCallback).toBeNull();
  });

  it('interactive mode registers an OSC 52 handler that writes decoded text to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    const handler = term.oscHandlers.get(52);
    expect(handler).toBeTypeOf('function');
    const handled = handler!(';' + btoa('copied text'));
    expect(handled).toBe(true);
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('copied text');
  });

  it('interactive OSC 52 handler ignores read requests (no clipboard read/exfiltration)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    const handled = term.oscHandlers.get(52)!('c;?');
    expect(handled).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('non-interactive mode does not register an OSC 52 handler', async () => {
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="preview" interactive={false} />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    expect(term.oscHandlers.get(52)).toBeUndefined();
  });

  it('interactive but deferred (preview until focus) does NOT register an OSC 52 handler yet', async () => {
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive autoFocus={false} deferFullUntilFocus />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    // streamMode stays 'preview' until the user activates the pane — background tmux copies must not
    // reach the clipboard before the user engages this terminal.
    expect(term.oscHandlers.get(52)).toBeUndefined();
  });

  it('preview mode never calls FitAddon.fit (preserves server-side pane geometry)', async () => {
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="preview" interactive={false} />);
    expect(FakeFitAddon.fitCount).toBe(0);
  });

  it('full+interactive mode does call FitAddon.fit', async () => {
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    expect(FakeFitAddon.fitCount).toBeGreaterThan(0);
  });

  it('can keep an interactive embedded terminal from stealing focus on mount', async () => {
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive autoFocus={false} />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    expect(term.onDataCallback).not.toBeNull();
    expect(term.focusCount).toBe(0);
  });

  it('defers embedded full subscription until the terminal is focused', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    const { container } = render(
      <PaneTerminal agentId="dev-1" mode="full" interactive autoFocus={false} deferFullUntilFocus />,
    );
    await new Promise((r) => setTimeout(r, 0));
    const ws1 = lastMockWs()!;
    const sent = (ws: MockWebSocket) => ws.sent.map((s) => JSON.parse(s) as { op?: string; mode?: string });
    expect(sent(ws1).find((m) => m.op === 'subscribe')?.mode).toBe('preview');
    expect(FakeFitAddon.fitCount).toBe(0);

    const xtermHost = container.querySelector('.overflow-hidden') as HTMLDivElement;
    await act(async () => {
      fireEvent.mouseDown(xtermHost);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fakeTerminals[0].focusCount).toBe(1);
    expect(fakeTerminals.length).toBeGreaterThan(1);

    const ws2 = lastMockWs()!;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const subscribeModes = [
      ...sent(ws1).filter((m) => m.op === 'subscribe').map((m) => m.mode),
      ...(ws2 === ws1 ? [] : sent(ws2).filter((m) => m.op === 'subscribe').map((m) => m.mode)),
    ];
    expect(subscribeModes)
      .toEqual(['preview', 'full']);
    expect(FakeFitAddon.fitCount).toBeGreaterThan(0);
    _resetPaneStreamClientForTest(null);
  });

  it('forwards the first deferred keystroke after the full subscription is active', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive autoFocus={false} deferFullUntilFocus />);
    await new Promise((r) => setTimeout(r, 0));
    const ws1 = lastMockWs()!;
    const term = fakeTerminals[0];
    const sent = (ws: MockWebSocket) =>
      ws.sent.map((s) => JSON.parse(s) as { op?: string; subscriberId?: string; mode?: string; data?: string });

    await act(async () => {
      term.onDataCallback!('a');
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fakeTerminals.length).toBeGreaterThan(1);

    const ws2 = lastMockWs()!;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const fullSubscribe = sent(ws2).find((m) => m.op === 'subscribe' && m.mode === 'full');
    expect(fullSubscribe?.subscriberId).toBeTruthy();
    const fullSid = fullSubscribe!.subscriberId!;
    const allBeforeSubscribed = [
      ...sent(ws1),
      ...(ws2 === ws1 ? [] : sent(ws2)),
    ];
    expect(allBeforeSubscribed.filter((m) => m.op === 'input')).toHaveLength(0);

    ws2.deliver({ type: 'snapshot', subscriberId: fullSid, cols: 80, rows: 24, data: '', snapshotSeq: 1 });
    ws2.deliver({ type: 'subscribed', subscriberId: fullSid, agentId: 'dev-1', cols: 80, rows: 24, snapshotSeq: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sent(ws2).filter((m) => m.op === 'input'))
      .toContainEqual({ op: 'input', subscriberId: fullSid, data: 'a' });
    _resetPaneStreamClientForTest(null);
  });

  it('debounces ResizeObserver fires: window-drag bursts collapse to a single trailing fit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
      render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
      const term = fakeTerminals[fakeTerminals.length - 1];
      expect(FakeFitAddon.fitCount).toBe(1);
      expect(MockResizeObserver.lastCallback).not.toBeNull();
      const scrollsAfterInitialFit = term.scrollToBottomCount;
      const cb = MockResizeObserver.lastCallback!;
      cb([], {} as ResizeObserver);
      vi.advanceTimersByTime(20);
      cb([], {} as ResizeObserver);
      vi.advanceTimersByTime(20);
      cb([], {} as ResizeObserver);
      vi.advanceTimersByTime(20);
      cb([], {} as ResizeObserver);
      vi.advanceTimersByTime(20);
      cb([], {} as ResizeObserver);
      expect(FakeFitAddon.fitCount).toBe(1);
      vi.advanceTimersByTime(150);
      expect(FakeFitAddon.fitCount).toBe(2);
      expect(term.scrollToBottomCount).toBeGreaterThan(scrollsAfterInitialFit);
    } finally {
      vi.useRealTimers();
    }
  });

  it('snapshot path calls term.reset() before write so reconnects do not append', async () => {
    const { getPaneStreamClient, _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="preview" interactive={false} />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    const client = getPaneStreamClient();
    await new Promise((r) => setTimeout(r, 0));
    const ws = lastMockWs()!;
    const subscribeMsg = ws.sent
      .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string })
      .find((m) => m.op === 'subscribe');
    expect(subscribeMsg?.subscriberId).toBeTruthy();
    const sid = subscribeMsg!.subscriberId!;
    ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 80, rows: 24, data: 'AAA', snapshotSeq: 1 });
    ws.deliver({ type: 'subscribed', subscriberId: sid, agentId: 'dev-1', cols: 80, rows: 24, snapshotSeq: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    const resetsAfterFirst = term.resetCount;
    expect(resetsAfterFirst).toBe(1);
    expect(term.writes).toEqual(['AAA']);
    ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 80, rows: 24, data: 'BBB', snapshotSeq: 2 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(term.resetCount).toBe(2);
    expect(term.writes).toEqual(['BBB']);
    void client;
    _resetPaneStreamClientForTest(null);
  });

  it('resizable snapshot fits the container instead of adopting server pane geometry, then pins to bottom (keeps the agent bottom bar in view)', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    const term = fakeTerminals[fakeTerminals.length - 1];
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

    // The taller server geometry (200x50) is NOT adopted — the fitted container size is kept.
    expect(term.cols).toBe(80);
    expect(term.rows).toBe(24);
    expect(term.writes).toEqual(['AAA']);
    expect(term.scrollToBottomCount).toBeGreaterThan(0);
    _resetPaneStreamClientForTest(null);
  });

  it('preview snapshot adopts server pane geometry and never force-scrolls xterm to bottom', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="preview" interactive={false} />);
    const term = fakeTerminals[fakeTerminals.length - 1];
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

    expect(term.cols).toBe(200);
    expect(term.rows).toBe(50);
    expect(term.scrollToBottomCount).toBe(0);
    _resetPaneStreamClientForTest(null);
  });

  it('batches live data into one xterm write per animation frame and keeps the resizable pane pinned to bottom', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    await new Promise((r) => setTimeout(r, 0));
    const ws = lastMockWs()!;
    const subscribeMsg = ws.sent
      .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string })
      .find((m) => m.op === 'subscribe');
    const sid = subscribeMsg!.subscriberId!;
    ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 80, rows: 24, data: 'base', snapshotSeq: 1 });
    ws.deliver({ type: 'subscribed', subscriberId: sid, agentId: 'dev-1', cols: 80, rows: 24, snapshotSeq: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(term.writes).toEqual(['base']);
    const scrollsAfterSnapshot = term.scrollToBottomCount;

    const rafCallbacks: FrameRequestCallback[] = [];
    (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
      (cb) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      };
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
    _resetPaneStreamClientForTest(null);
  });

  it('flushes live data via timeout when animation frames are throttled', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    await new Promise((r) => setTimeout(r, 0));
    const ws = lastMockWs()!;
    const subscribeMsg = ws.sent
      .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string })
      .find((m) => m.op === 'subscribe');
    const sid = subscribeMsg!.subscriberId!;
    ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 80, rows: 24, data: 'base', snapshotSeq: 1 });
    ws.deliver({ type: 'subscribed', subscriberId: sid, agentId: 'dev-1', cols: 80, rows: 24, snapshotSeq: 1 });
    await act(async () => {
      await Promise.resolve();
    });

    const rafCallbacks: FrameRequestCallback[] = [];
    (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
      (cb) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      };
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
      _resetPaneStreamClientForTest(null);
    }
  });

  it('flushes immediately when the live queue reaches its memory cap', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    await new Promise((r) => setTimeout(r, 0));
    const ws = lastMockWs()!;
    const subscribeMsg = ws.sent
      .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string })
      .find((m) => m.op === 'subscribe');
    const sid = subscribeMsg!.subscriberId!;
    ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 80, rows: 24, data: 'base', snapshotSeq: 1 });
    ws.deliver({ type: 'subscribed', subscriberId: sid, agentId: 'dev-1', cols: 80, rows: 24, snapshotSeq: 1 });
    await act(async () => {
      await Promise.resolve();
    });

    const rafSpy = vi.fn<(cb: FrameRequestCallback) => number>(() => 1);
    (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
      rafSpy;
    const largeChunk = 'x'.repeat(256 * 1024);
    ws.deliver({ type: 'data', agentId: 'dev-1', data: largeChunk, seq: 2 });
    await act(async () => {
      await Promise.resolve();
    });

    expect(rafSpy).not.toHaveBeenCalled();
    expect(term.writes).toHaveLength(2);
    expect(term.writes[1]).toHaveLength(largeChunk.length);
    _resetPaneStreamClientForTest(null);
  });

  it('queues snapshot reset behind an in-flight live write so stale live output is cleared', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    await new Promise((r) => setTimeout(r, 0));
    const ws = lastMockWs()!;
    const subscribeMsg = ws.sent
      .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string })
      .find((m) => m.op === 'subscribe');
    const sid = subscribeMsg!.subscriberId!;
    ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 80, rows: 24, data: 'base', snapshotSeq: 1 });
    ws.deliver({ type: 'subscribed', subscriberId: sid, agentId: 'dev-1', cols: 80, rows: 24, snapshotSeq: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(term.writes).toEqual(['base']);
    expect(term.resetCount).toBe(1);

    term.deferWrites = true;
    ws.deliver({ type: 'data', agentId: 'dev-1', data: 'old-live', seq: 2 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(term.writes).toEqual(['base', 'old-live']);
    expect(term.pendingWriteCallbacks).toHaveLength(1);

    ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 80, rows: 24, data: 'fresh', snapshotSeq: 3 });
    await act(async () => {
      await Promise.resolve();
    });
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
    _resetPaneStreamClientForTest(null);
  });

  it('focuses on mouse down', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    const { container } = render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    const xtermHost = container.querySelector('.overflow-hidden') as HTMLDivElement;
    expect(term.focusCount).toBe(1);
    fireEvent.mouseDown(xtermHost);
    expect(term.focusCount).toBe(2);
    _resetPaneStreamClientForTest(null);
  });

  it('scroll container is padding-free (vertical padding lives on the outer wrapper so scrollTop stays a pure row offset)', async () => {
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    const { container } = render(<PaneTerminal agentId="dev-1" mode="preview" interactive={false} maxLines={6} />);
    const scrollEl = container.querySelector('.overflow-hidden') as HTMLDivElement;
    expect(scrollEl).toBeTruthy();
    expect(scrollEl.className).not.toMatch(/(^|\s)p[ytb]?-/);
    // The padding wrapper is the scroll container's direct parent.
    const padWrapper = scrollEl.parentElement!;
    expect(padWrapper.className).toContain('py-1.5');
    expect(padWrapper.className).toContain('px-2');
  });

  it('preview clipping scrolls container so cursor row anchors to the bottom (not the top)', async () => {
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
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 900,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 108,
    });

    try {
      const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
      render(<PaneTerminal agentId="dev-1" mode="preview" interactive={false} maxLines={6} />);
      const term = fakeTerminals[fakeTerminals.length - 1];
      // Agent has filled the 50-row server pane; cursor sits near the bottom at row 42 (0-indexed).
      term.buffer.active.cursorY = 42;
      await new Promise((r) => setTimeout(r, 0));
      const ws = lastMockWs()!;
      const subscribeMsg = ws.sent
        .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string })
        .find((m) => m.op === 'subscribe');
      const sid = subscribeMsg!.subscriberId!;
      ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 200, rows: 50, data: 'AAA', snapshotSeq: 1 });
      ws.deliver({ type: 'subscribed', subscriberId: sid, agentId: 'dev-1', cols: 200, rows: 50, snapshotSeq: 1 });
      await act(async () => {
        await Promise.resolve();
      });

      // (cursorY+1) * LINE_HEIGHT(18) - clientHeight(108) = 43*18 - 108 = 666
      expect(scrollState.value).toBe(666);
    } finally {
      // @ts-expect-error deliberately remove the shim so other tests get jsdom defaults again
      delete HTMLElement.prototype.scrollTop;
      // @ts-expect-error remove scrollHeight shim
      delete HTMLElement.prototype.scrollHeight;
      // @ts-expect-error remove clientHeight shim — beforeEach re-installs the default 480 for the next case
      delete HTMLElement.prototype.clientHeight;
      _resetPaneStreamClientForTest(null);
    }
  });

  it('embedded preview (no maxLines) still anchors the cursor row to the bottom so the card shows the latest, not the top', async () => {
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
      // Embedded card preview: full server geometry, no maxLines clip — the h-80 box overflow-hides it.
      render(<PaneTerminal agentId="dev-1" mode="preview" interactive={false} />);
      const term = fakeTerminals[fakeTerminals.length - 1];
      // Agent filled the 50-row server pane; cursor sits near the bottom at row 42 (0-indexed).
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

      // (cursorY+1) * LINE_HEIGHT(18) - clientHeight(300) = 43*18 - 300 = 474 → anchored to bottom, not 0 (top).
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
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );

    const scrollState = { value: 0, writes: 0 };
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get() { return scrollState.value; },
      set(v: number) { scrollState.value = v; scrollState.writes++; },
    });

    try {
      const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
      render(<PaneTerminal agentId="dev-1" mode="full" interactive={false} />);
      const term = fakeTerminals[fakeTerminals.length - 1];
      term.buffer.active.cursorY = 23;
      await new Promise((r) => setTimeout(r, 0));
      const ws = lastMockWs()!;
      const subscribeMsg = ws.sent
        .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string })
        .find((m) => m.op === 'subscribe');
      const sid = subscribeMsg!.subscriberId!;
      ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 80, rows: 24, data: 'AAA', snapshotSeq: 1 });
      ws.deliver({ type: 'subscribed', subscriberId: sid, agentId: 'dev-1', cols: 80, rows: 24, snapshotSeq: 1 });
      await act(async () => {
        await Promise.resolve();
      });

      expect(scrollState.writes).toBe(0);
    } finally {
      // @ts-expect-error restore default
      delete HTMLElement.prototype.scrollTop;
      _resetPaneStreamClientForTest(null);
    }
  });

  it('arrowKeys prop defaults off — no virtual key pad rendered', async () => {
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    expect(screen.queryByRole('group', { name: /终端方向键/ })).toBeNull();
  });

  it('arrowKeys prop renders the key pad and clicking an arrow forwards its CSI sequence as terminal input', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive arrowKeys />);
    await new Promise((r) => setTimeout(r, 0));
    const ws = lastMockWs()!;
    const subscribeMsg = ws.sent
      .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string })
      .find((m) => m.op === 'subscribe');
    const sid = subscribeMsg!.subscriberId!;
    ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 80, rows: 24, data: '', snapshotSeq: 1 });
    ws.deliver({ type: 'subscribed', subscriberId: sid, agentId: 'dev-1', cols: 80, rows: 24, snapshotSeq: 1 });
    await act(async () => {
      await Promise.resolve();
    });

    const before = ws.sent.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /方向键 上/ }));
    });
    const sentAfterInput = ws.sent
      .slice(before)
      .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string; data?: string });
    expect(sentAfterInput).toContainEqual({ op: 'input', subscriberId: sid, data: '\x1b[A' });
    _resetPaneStreamClientForTest(null);
  });

  it('arrowKeyToSequence picks CSI in normal mode and SS3 when xterm reports application cursor mode (DECCKM)', async () => {
    const { arrowKeyToSequence } = await import('../../src/components/pane-terminal.tsx');
    expect(arrowKeyToSequence('up', false)).toBe('\x1b[A');
    expect(arrowKeyToSequence('down', false)).toBe('\x1b[B');
    expect(arrowKeyToSequence('right', false)).toBe('\x1b[C');
    expect(arrowKeyToSequence('left', false)).toBe('\x1b[D');
    expect(arrowKeyToSequence('up', true)).toBe('\x1bOA');
    expect(arrowKeyToSequence('down', true)).toBe('\x1bOB');
    expect(arrowKeyToSequence('right', true)).toBe('\x1bOC');
    expect(arrowKeyToSequence('left', true)).toBe('\x1bOD');
  });

  it('keypad reads live applicationCursorKeysMode at click time — flipping the mode switches CSI ↔ SS3 without re-render', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive arrowKeys />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    await new Promise((r) => setTimeout(r, 0));
    const ws = lastMockWs()!;
    const subscribeMsg = ws.sent
      .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string })
      .find((m) => m.op === 'subscribe');
    const sid = subscribeMsg!.subscriberId!;
    ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 80, rows: 24, data: '', snapshotSeq: 1 });
    ws.deliver({ type: 'subscribed', subscriberId: sid, agentId: 'dev-1', cols: 80, rows: 24, snapshotSeq: 1 });
    await act(async () => { await Promise.resolve(); });

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
    _resetPaneStreamClientForTest(null);
  });

  it('rapid keypad taps in defer mode all queue or land on the post-activation full subscriber (no input lost to preview sid)', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(
      <PaneTerminal
        agentId="dev-1"
        mode="full"
        interactive
        arrowKeys
        autoFocus={false}
        deferFullUntilFocus
      />,
    );
    await new Promise((r) => setTimeout(r, 0));
    const ws1 = lastMockWs()!;
    const sent = (ws: MockWebSocket) =>
      ws.sent.map((s) => JSON.parse(s) as { op?: string; subscriberId?: string; mode?: string; data?: string });
    const previewSid = sent(ws1).find((m) => m.op === 'subscribe' && m.mode === 'preview')!.subscriberId!;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /方向键 上/ }));
      fireEvent.click(screen.getByRole('button', { name: /方向键 下/ }));
      fireEvent.click(screen.getByRole('button', { name: /方向键 右/ }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const ws2 = lastMockWs()!;
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const fullSubscribe = sent(ws2).find((m) => m.op === 'subscribe' && m.mode === 'full');
    const fullSid = fullSubscribe!.subscriberId!;
    ws2.deliver({ type: 'snapshot', subscriberId: fullSid, cols: 80, rows: 24, data: '', snapshotSeq: 1 });
    ws2.deliver({ type: 'subscribed', subscriberId: fullSid, agentId: 'dev-1', cols: 80, rows: 24, snapshotSeq: 1 });
    await act(async () => { await Promise.resolve(); });

    const allInputs = [
      ...sent(ws1).filter((m) => m.op === 'input'),
      ...(ws2 === ws1 ? [] : sent(ws2).filter((m) => m.op === 'input')),
    ];
    expect(allInputs.every((m) => m.subscriberId !== previewSid)).toBe(true);
    expect(allInputs.map((m) => m.data).join('')).toBe('\x1b[A\x1b[B\x1b[C');
    _resetPaneStreamClientForTest(null);
  });

  it('keypad input flows through the same input pipeline as keyboard (shares stripTerminalAutoReplies + defer logic)', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive arrowKeys />);
    const term = fakeTerminals[fakeTerminals.length - 1];
    await new Promise((r) => setTimeout(r, 0));
    const ws = lastMockWs()!;
    const subscribeMsg = ws.sent
      .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string })
      .find((m) => m.op === 'subscribe');
    const sid = subscribeMsg!.subscriberId!;
    ws.deliver({ type: 'snapshot', subscriberId: sid, cols: 80, rows: 24, data: '', snapshotSeq: 1 });
    ws.deliver({ type: 'subscribed', subscriberId: sid, agentId: 'dev-1', cols: 80, rows: 24, snapshotSeq: 1 });
    await act(async () => { await Promise.resolve(); });

    const before = ws.sent.length;
    await act(async () => {
      term.onDataCallback!('\x1b[24;80Rhello');
      fireEvent.click(screen.getByRole('button', { name: /方向键 上/ }));
    });
    const inputs = ws.sent
      .slice(before)
      .map((s) => JSON.parse(s) as { op?: string; data?: string })
      .filter((m) => m.op === 'input')
      .map((m) => m.data);
    expect(inputs).toEqual(['hello', '\x1b[A']);
    _resetPaneStreamClientForTest(null);
  });

  it('arrowKeys + deferFullUntilFocus: first arrow click activates the full stream and forwards the keystroke', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(
      <PaneTerminal
        agentId="dev-1"
        mode="full"
        interactive
        arrowKeys
        autoFocus={false}
        deferFullUntilFocus
      />,
    );
    await new Promise((r) => setTimeout(r, 0));
    const ws1 = lastMockWs()!;
    const sent = (ws: MockWebSocket) =>
      ws.sent.map((s) => JSON.parse(s) as { op?: string; subscriberId?: string; mode?: string; data?: string });
    expect(sent(ws1).find((m) => m.op === 'subscribe')?.mode).toBe('preview');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /方向键 下/ }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fakeTerminals.length).toBeGreaterThan(1);

    const ws2 = lastMockWs()!;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const fullSubscribe = sent(ws2).find((m) => m.op === 'subscribe' && m.mode === 'full');
    expect(fullSubscribe?.subscriberId).toBeTruthy();
    const fullSid = fullSubscribe!.subscriberId!;
    ws2.deliver({ type: 'snapshot', subscriberId: fullSid, cols: 80, rows: 24, data: '', snapshotSeq: 1 });
    ws2.deliver({ type: 'subscribed', subscriberId: fullSid, agentId: 'dev-1', cols: 80, rows: 24, snapshotSeq: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sent(ws2).filter((m) => m.op === 'input'))
      .toContainEqual({ op: 'input', subscriberId: fullSid, data: '\x1b[B' });
    _resetPaneStreamClientForTest(null);
  });

  it('non-interactive: wheel events are stopped in capture phase so the page (not xterm) handles scroll', async () => {
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    const { container } = render(<PaneTerminal agentId="dev-1" mode="preview" interactive={false} />);
    const xtermHost = container.querySelector('.overflow-hidden') as HTMLDivElement;
    expect(xtermHost).toBeTruthy();
    const child = document.createElement('div');
    xtermHost.appendChild(child);

    const bubbleListener = vi.fn();
    xtermHost.addEventListener('wheel', bubbleListener);

    fireEvent.wheel(child, { deltaY: 100 });

    expect(bubbleListener).not.toHaveBeenCalled();
  });

  it('interactive: wheel events propagate normally so xterm can drive its own scrollback', async () => {
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    const { container } = render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    const xtermHost = container.querySelector('.overflow-hidden') as HTMLDivElement;
    const child = document.createElement('div');
    xtermHost.appendChild(child);

    const bubbleListener = vi.fn();
    xtermHost.addEventListener('wheel', bubbleListener);

    fireEvent.wheel(child, { deltaY: 100 });

    expect(bubbleListener).toHaveBeenCalledTimes(1);
  });

  it('changing agentId clears stale error/session-gone banner', async () => {
    const { _resetPaneStreamClientForTest, PaneStreamClient } =
      await import('../../src/stores/pane-stream-store.ts');
    _resetPaneStreamClientForTest(
      new PaneStreamClient({
        wsUrl: 'ws://test.local/api/stream',
        wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
        tokenProvider: () => null,
      }),
    );
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    const { rerender, container } = render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    await new Promise((r) => setTimeout(r, 0));
    const ws = lastMockWs()!;
    const subscribeMsg = ws.sent
      .map((s) => JSON.parse(s) as { op?: string; subscriberId?: string; agentId?: string })
      .find((m) => m.op === 'subscribe');
    const sid = subscribeMsg!.subscriberId!;
    await act(async () => {
      ws.deliver({ type: 'session_gone', agentId: 'dev-1' });
    });
    expect(container.textContent).toContain('session ended');
    await act(async () => {
      rerender(<PaneTerminal agentId="dev-2" mode="full" interactive />);
    });
    expect(container.textContent).not.toContain('session ended');
    void sid;
    _resetPaneStreamClientForTest(null);
  });
});

describe('PaneTerminal image upload bar', () => {
  it('shows the upload button on the full terminal page (interactive + arrow keys)', async () => {
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    const { _resetPaneStreamClientForTest } = await import('../../src/stores/pane-stream-store.ts');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive arrowKeys />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole('button', { name: /上传图片/ })).toBeTruthy();
    _resetPaneStreamClientForTest(null);
  });

  it('does not show the upload button in non-interactive preview mode', async () => {
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    const { _resetPaneStreamClientForTest } = await import('../../src/stores/pane-stream-store.ts');
    render(<PaneTerminal agentId="dev-1" mode="preview" interactive={false} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('button', { name: /上传图片/ })).toBeNull();
    _resetPaneStreamClientForTest(null);
  });
});

describe('PaneTerminal control bar layout', () => {
  it('centers the key pad relative to the whole bar via symmetric gutters, not the space beside the upload button', async () => {
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive arrowKeys />);
    await new Promise((r) => setTimeout(r, 0));

    const keypad = screen.getByRole('group', { name: /终端方向键/ });
    const bar = keypad.parentElement!;
    // Symmetric 1fr | auto | 1fr template → the key pad (auto column) is centered in the bar,
    // independent of the upload button's width in the left gutter.
    expect(bar.className).toContain('grid');
    expect(bar.className).toContain('grid-cols-[1fr_auto_1fr]');
    // Symmetric gap keeps a minimum distance between the upload button and the key pad on narrow
    // widths without disturbing centering (the gaps flank the auto column symmetrically).
    expect(bar.className).toMatch(/\bgap(-x)?-2\b/);
    // Regression: the key pad must not be the flex-1 leftover filler — that only centered it
    // within the space to the right of the upload button.
    expect(keypad.className).not.toContain('flex-1');
    expect(screen.getByRole('button', { name: /上传图片/ })).toBeTruthy();
  });

  it('hides the whole bar (upload + key pad) when arrow keys are disabled', async () => {
    const { PaneTerminal } = await import('../../src/components/pane-terminal.tsx');
    render(<PaneTerminal agentId="dev-1" mode="full" interactive />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('button', { name: /上传图片/ })).toBeNull();
    expect(screen.queryByRole('group', { name: /终端方向键/ })).toBeNull();
  });
});

function lastMockWs(): MockWebSocket | undefined {
  return MockWebSocket.lastInstance;
}
