import { vi } from 'vitest';
import type { PaneTerminalProps } from '../../src/components/pane-terminal.tsx';

type PaneTerminalModule = typeof import('../../src/components/pane-terminal.tsx');

function PaneTerminalStub(props: PaneTerminalProps) {
  return (
    <div
      data-testid="pane-terminal"
      data-agent-id={props.agentId}
      data-mode={props.mode}
      data-interactive={String(!!props.interactive)}
      data-auto-focus={String(!!props.autoFocus)}
      data-arrow-keys={String(!!props.arrowKeys)}
      data-defer-full={String(!!props.deferFullUntilFocus)}
    />
  );
}

export function createPaneTerminalMock(): PaneTerminalModule {
  return {
    arrowKeyToSequence: vi.fn(),
    TERMINAL_BG: '#fdfdfd',
    TERMINAL_MONO_STACK:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    ZED_LIGHT_THEME: { background: '#fdfdfd' },
    TERMINAL_REPLY_PATTERN: /\x1b\[(?:\?[\d;]*c|>[\d;]*c|\??\d+;\d+R|\d+n)/g,
    stripTerminalAutoReplies: vi.fn((data: string) => data),
    parseOsc52Clipboard: vi.fn(() => null),
    PaneTerminal: PaneTerminalStub,
  };
}
