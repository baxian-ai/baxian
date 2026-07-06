import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { StreamSubMode } from '../shared/index.js';
import { usePaneStream } from '../hooks/use-pane-stream.ts';
import { TerminalKeyPad, type ArrowKey } from './terminal-key-pad.tsx';
import { ImageUploadButton } from './image-upload-button.tsx';
import { useT } from '../i18n/index.tsx';

const ARROW_FINAL: Record<ArrowKey, string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

export function arrowKeyToSequence(key: ArrowKey, applicationCursor: boolean): string {
  return (applicationCursor ? '\x1bO' : '\x1b[') + ARROW_FINAL[key];
}

const TERMINAL_LINE_HEIGHT_PX = 18;
const LIVE_FLUSH_FALLBACK_MS = 250;
const LIVE_QUEUE_MAX_CHARS = 256 * 1024;

export const TERMINAL_BG = '#fdfdfd';

export const TERMINAL_MONO_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

export const ZED_LIGHT_THEME: ITheme = {
  background: TERMINAL_BG,
  foreground: '#474c55',
  cursor: '#1348dc',
  cursorAccent: TERMINAL_BG,
  selectionBackground: '#eaf0ff',
  black: '#0d0d0f',
  red: '#b91c1c',
  green: '#15803d',
  yellow: '#b45309',
  blue: '#1348dc',
  magenta: '#9333ea',
  cyan: '#0e7490',
  white: '#474c55',
  brightBlack: '#878e9b',
  brightRed: '#dc2626',
  brightGreen: '#16a34a',
  brightYellow: '#d97706',
  brightBlue: '#3080ff',
  brightMagenta: '#a855f7',
  brightCyan: '#0891b2',
  brightWhite: '#0d0d0f',
};

export const TERMINAL_REPLY_PATTERN =
  /\x1b\[(?:\?[\d;]*c|>[\d;]*c|\??\d+;\d+R|\d+n)/g;

export function stripTerminalAutoReplies(data: string): string {
  return data.replace(TERMINAL_REPLY_PATTERN, '');
}

const OSC52_MAX_B64 = 1024 * 1024;

export function parseOsc52Clipboard(payload: string): string | null {
  const sep = payload.indexOf(';');
  if (sep === -1) return null;
  const b64 = payload.slice(sep + 1);
  if (b64.length === 0 || b64 === '?' || b64.length > OSC52_MAX_B64) return null;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

type TerminalTask = (term: XTerm) => Promise<void> | void;

export interface PaneTerminalProps {
  agentId: string;
  mode: StreamSubMode;
  interactive?: boolean;
  maxLines?: number;
  className?: string;
  autoFocus?: boolean;
  deferFullUntilFocus?: boolean;
  arrowKeys?: boolean;
}

export function PaneTerminal({
  agentId,
  mode,
  interactive = false,
  maxLines,
  className,
  autoFocus = true,
  deferFullUntilFocus = false,
  arrowKeys = false,
}: PaneTerminalProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const refitToContainerRef = useRef<(() => void) | null>(null);
  const focusAfterActivationRef = useRef(false);
  const pendingDeferredInputRef = useRef('');
  const liveQueueRef = useRef<string[]>([]);
  const liveQueuedCharsRef = useRef(0);
  const liveRafRef = useRef<number | null>(null);
  const liveFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewScrollRafRef = useRef<number | null>(null);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const writeGenerationRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [sessionGone, setSessionGone] = useState(false);
  const activationKey = `${agentId}\0${mode}\0${deferFullUntilFocus ? '1' : '0'}`;
  const [activation, setActivation] = useState({ key: activationKey, active: false });
  const fullActivated = activation.key === activationKey && activation.active;
  const shouldDeferFull = mode === 'full' && deferFullUntilFocus;
  const streamMode: StreamSubMode = shouldDeferFull && !fullActivated ? 'preview' : mode;
  const canResize = interactive && streamMode === 'full';

  const writeTerminalData = (term: XTerm, data: string): Promise<void> => {
    if (data.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      try {
        term.write(data, () => resolve());
      } catch (err) {
        console.warn('[pane-terminal] write failed:', err);
        resolve();
      }
    });
  };

  const isStaticPreview = streamMode === 'preview';
  const scrollPreviewToCursor = (): void => {
    if (!isStaticPreview) return;
    const el = containerRef.current;
    const t = termRef.current;
    if (!el || !t) return;
    if (el.clientHeight <= 0) return;
    const cursorY = t.buffer.active.cursorY;
    const cursorBottomPx = (cursorY + 1) * TERMINAL_LINE_HEIGHT_PX;
    el.scrollTop = Math.max(0, cursorBottomPx - el.clientHeight);
  };
  const schedulePreviewScrollToCursor = (): void => {
    if (!isStaticPreview || previewScrollRafRef.current !== null) return;
    let ran = false;
    const frameId = requestAnimationFrame(() => {
      ran = true;
      previewScrollRafRef.current = null;
      scrollPreviewToCursor();
    });
    if (!ran) previewScrollRafRef.current = frameId;
  };

  const enqueueTerminalTask = (task: TerminalTask, generation: number): void => {
    writeChainRef.current = writeChainRef.current
      .then(async () => {
        const t = termRef.current;
        if (!t || generation !== writeGenerationRef.current) return;
        try {
          await task(t);
          if (canResize) t.scrollToBottom();
          schedulePreviewScrollToCursor();
        } catch (err) {
          console.warn('[pane-terminal] terminal task failed:', err);
        }
      })
      .catch((err) => {
        console.warn('[pane-terminal] write chain failed:', err);
      });
  };

  const enqueueWrite = (data: string, generation: number): void => {
    enqueueTerminalTask((term) => writeTerminalData(term, data), generation);
  };

  const cancelLiveFlush = (): void => {
    if (liveRafRef.current !== null) {
      cancelAnimationFrame(liveRafRef.current);
      liveRafRef.current = null;
    }
    if (liveFlushTimerRef.current !== null) {
      clearTimeout(liveFlushTimerRef.current);
      liveFlushTimerRef.current = null;
    }
  };

  const clearLiveQueue = (): void => {
    cancelLiveFlush();
    liveQueueRef.current = [];
    liveQueuedCharsRef.current = 0;
  };

  const flushLiveQueue = (): void => {
    cancelLiveFlush();
    const chunks = liveQueueRef.current;
    if (chunks.length === 0) return;
    liveQueueRef.current = [];
    liveQueuedCharsRef.current = 0;
    enqueueWrite(chunks.join(''), writeGenerationRef.current);
  };

  const scheduleLiveWrite = (data: string): void => {
    if (data.length === 0) return;
    liveQueueRef.current.push(data);
    liveQueuedCharsRef.current += data.length;
    if (liveQueuedCharsRef.current >= LIVE_QUEUE_MAX_CHARS) {
      flushLiveQueue();
      return;
    }
    if (liveRafRef.current === null) {
      liveRafRef.current = requestAnimationFrame(flushLiveQueue);
    }
    if (liveFlushTimerRef.current === null) {
      liveFlushTimerRef.current = setTimeout(flushLiveQueue, LIVE_FLUSH_FALLBACK_MS);
    }
  };

  const { send, resize } = usePaneStream({
    agentId,
    mode: streamMode,
    onSnapshot: ({ cols, rows, data }) => {
      const t = termRef.current;
      if (!t) return;
      try {
        const generation = writeGenerationRef.current + 1;
        writeGenerationRef.current = generation;
        clearLiveQueue();
        enqueueTerminalTask(async (term) => {
          term.reset();
          if (canResize) {
            refitToContainerRef.current?.();
            await writeTerminalData(term, data);
          } else {
            if (cols > 0 && rows > 0) term.resize(cols, rows);
            await writeTerminalData(term, data);
          }
        }, generation);
      } catch (err) {
        console.warn('[pane-terminal] snapshot write failed:', err);
      }
    },
    onData: (data) => {
      scheduleLiveWrite(data);
    },
    onError: (m) => setError(`${m.code}: ${m.message}`),
    onSessionGone: () => setSessionGone(true),
  });

  useEffect(() => {
    setError(null);
    setSessionGone(false);
  }, [agentId, streamMode]);

  useEffect(() => {
    pendingDeferredInputRef.current = '';
  }, [activationKey]);

  useEffect(() => {
    if (streamMode !== 'full') return;
    const pending = pendingDeferredInputRef.current;
    if (pending.length === 0) return;
    pendingDeferredInputRef.current = '';
    send(pending);
  }, [send, streamMode]);

  const activateFullStream = useCallback(() => {
    if (!interactive || !shouldDeferFull || fullActivated) return;
    focusAfterActivationRef.current = true;
    setActivation({ key: activationKey, active: true });
  }, [activationKey, fullActivated, interactive, shouldDeferFull]);

  const forwardInput = useCallback((data: string) => {
    const cleaned = stripTerminalAutoReplies(data);
    if (cleaned.length === 0) return;
    if (shouldDeferFull && (!fullActivated || pendingDeferredInputRef.current.length > 0)) {
      pendingDeferredInputRef.current += cleaned;
      activateFullStream();
      return;
    }
    send(cleaned);
  }, [activateFullStream, fullActivated, send, shouldDeferFull]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const term = new XTerm({
      cursorBlink: interactive,
      disableStdin: !interactive,
      theme: ZED_LIGHT_THEME,
      fontFamily: TERMINAL_MONO_STACK,
      fontSize: 13,
      lineHeight: 1.4,
      scrollback: streamMode === 'full' ? 5000 : 1000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;
    const renderDisposable = isStaticPreview
      ? term.onRender(() => schedulePreviewScrollToCursor())
      : null;
    if (interactive && (autoFocus || focusAfterActivationRef.current)) {
      focusAfterActivationRef.current = false;
      try { term.focus(); } catch {}
    }

    if (interactive) {
      term.onData(forwardInput);
      if (streamMode === 'full') {
        term.parser.registerOscHandler(52, (payload) => {
          const text = parseOsc52Clipboard(payload);
          if (text !== null) void navigator.clipboard?.writeText(text).catch(() => {});
          return true;
        });
      }
    }

    const canFit = () => container.clientWidth > 0 && container.clientHeight > 0;
    const fitAndResize = (force = false) => {
      if (!canFit()) return false;
      const oldCols = term.cols;
      const oldRows = term.rows;
      try {
        fit.fit();
      } catch {
        return false;
      }
      if (canResize) term.scrollToBottom();
      if (term.cols > 0 && term.rows > 0 && (force || term.cols !== oldCols || term.rows !== oldRows)) {
        resize(term.cols, term.rows);
      }
      return true;
    };
    refitToContainerRef.current = canResize ? () => fitAndResize(true) : null;

    let observer: ResizeObserver | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let raf: number | null = null;
    let fitAttempts = 0;
    const installObserver = () => {
      if (observer) return;
      observer = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          resizeTimer = null;
          if (canResize) {
            fitAndResize();
          } else if (isStaticPreview) {
            schedulePreviewScrollToCursor();
          }
        }, 100);
      });
      observer.observe(container);
    };

    const scheduleFit = () => {
      raf = requestAnimationFrame(() => {
        raf = null;
        if (disposed) return;
        if (!canResize) {
          if (isStaticPreview) {
            installObserver();
            schedulePreviewScrollToCursor();
          }
          return;
        }
        if (fitAndResize(true)) {
          installObserver();
          return;
        }
        if (fitAttempts++ < 5) {
          scheduleFit();
          return;
        }
        installObserver();
      });
    };

    scheduleFit();

    return () => {
      disposed = true;
      if (raf !== null) cancelAnimationFrame(raf);
      if (liveRafRef.current !== null) {
        cancelAnimationFrame(liveRafRef.current);
        liveRafRef.current = null;
      }
      if (liveFlushTimerRef.current !== null) {
        clearTimeout(liveFlushTimerRef.current);
        liveFlushTimerRef.current = null;
      }
      if (previewScrollRafRef.current !== null) {
        cancelAnimationFrame(previewScrollRafRef.current);
        previewScrollRafRef.current = null;
      }
      writeGenerationRef.current++;
      liveQueueRef.current = [];
      liveQueuedCharsRef.current = 0;
      writeChainRef.current = Promise.resolve();
      if (resizeTimer) clearTimeout(resizeTimer);
      observer?.disconnect();
      renderDisposable?.dispose();
      termRef.current = null;
      fitRef.current = null;
      refitToContainerRef.current = null;
      try {
        term.dispose();
      } catch (err) {
        console.warn('[pane-terminal] dispose failed:', err);
      }
    };
  }, [agentId, autoFocus, canResize, forwardInput, interactive, streamMode, resize]);

  const focusTerminal = () => {
    if (!interactive) return;
    activateFullStream();
    try { termRef.current?.focus(); } catch {}
  };

  useEffect(() => {
    if (interactive) return;
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.stopPropagation();
    };
    container.addEventListener('wheel', onWheel, { capture: true, passive: true });
    return () => container.removeEventListener('wheel', onWheel, { capture: true });
  }, [interactive]);

  const containerStyle =
    maxLines && maxLines > 0
      ? { maxHeight: `${maxLines * TERMINAL_LINE_HEIGHT_PX}px` }
      : undefined;

  return (
    <div className={className ?? 'flex flex-col h-full w-full min-h-0 bg-term'}>
      {(error || sessionGone) && (
        <div className="border-b border-accent/25 bg-accent-soft px-3 py-1 font-mono text-xs text-accent">
          {sessionGone ? t.terminal.sessionEnded : error}
        </div>
      )}
      <div className="flex flex-1 min-h-0 px-2 py-1.5" style={containerStyle}>
        <div
          ref={containerRef}
          className="flex-1 min-h-0 overflow-hidden"
          onMouseDown={focusTerminal}
        />
      </div>
      {interactive && arrowKeys && (
        <div className="grid grid-cols-[1fr_auto_1fr] gap-2 flex-none items-center border-t border-hairline bg-page px-3 py-2">
          <div className="flex items-center">
            <ImageUploadButton agentId={agentId} />
          </div>
          <TerminalKeyPad
            className="flex items-center justify-center gap-1"
            onKey={(key) => {
              const appCursor = !!termRef.current?.modes?.applicationCursorKeysMode;
              forwardInput(arrowKeyToSequence(key, appCursor));
            }}
            onEscape={() => forwardInput('\x1b')}
          />
        </div>
      )}
    </div>
  );
}
