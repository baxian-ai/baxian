import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgentBindingFacts, AgentRole, AgentRuntime, AgentSnapshot } from '../../src/shared/index.js';

const showMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/components/toast.tsx', () => ({
  useToast: () => ({ show: showMock }),
}));

vi.mock('../../src/hooks/use-pending-restart.tsx', () => ({
  usePendingRestart: () => ({ flagDirty: vi.fn() }),
}));

const deleteAgentMock = vi.fn();
const compactMock = vi.fn();
const clearMock = vi.fn();
const reviewMock = vi.fn();
const resumeAgentMock = vi.fn();
const restartReplMock = vi.fn();
const retryAgentMock = vi.fn();
vi.mock('../../src/api.ts', () => ({
  api: {
    agents: {
      compact: (...args: unknown[]) => compactMock(...args),
      clear: (...args: unknown[]) => clearMock(...args),
    },
    projects: {
      deleteAgent: (...args: unknown[]) => deleteAgentMock(...args),
      resumeAgent: (...args: unknown[]) => resumeAgentMock(...args),
      restartRepl: (...args: unknown[]) => restartReplMock(...args),
      retryAgent: (...args: unknown[]) => retryAgentMock(...args),
    },
    tasks: {
      review: (...args: unknown[]) => reviewMock(...args),
    },
  },
}));

vi.mock('../../src/hooks/use-pets.ts', () => ({
  usePets: () => ({ pets: [], loading: false, error: null, refresh: vi.fn() }),
  usePetSpritesheet: (petId?: string) => (petId ? 'blob:mock-sprite' : null),
}));

vi.mock('../../src/components/pane-terminal.tsx', () => ({
  TERMINAL_BG: '#fdfdfd',
  PaneTerminal: (props: { mode: string; interactive?: boolean; autoFocus?: boolean; deferFullUntilFocus?: boolean }) => (
    <div
      data-testid="pane-terminal"
      data-mode={props.mode}
      data-interactive={String(!!props.interactive)}
      data-auto-focus={String(props.autoFocus)}
      data-defer-full={String(!!props.deferFullUntilFocus)}
    />
  ),
}));

import { AgentCard, type TerminalMode } from '../../src/components/agent-card.tsx';

type RenderCardOptions = {
  runtime?: AgentRuntime;
  role?: AgentRole;
  terminalMode?: TerminalMode;
  terminalLoading?: boolean;
  active?: boolean;
  onActivate?: () => void;
};

function renderCard(agent: AgentSnapshot, options: RenderCardOptions = {}): void {
  const { runtime, role = 'dev', terminalMode, terminalLoading, active, onActivate } = options;
  render(
    <MemoryRouter>
      <AgentCard
        agent={agent}
        projectId="proj"
        role={role}
        runtime={runtime}
        terminalMode={terminalMode}
        terminalLoading={terminalLoading}
        active={active}
        onActivate={onActivate}
      />
    </MemoryRouter>,
  );
}

function makeSnapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: 'dev-1',
    projectId: 'proj',
    runtimeStatus: 'idle',
    tmuxSessionStatus: 'present',
    stale: false,
    ...overrides,
  };
}

function classToken(el: HTMLElement, prefix: string): string {
  return el.className.split(' ').find(c => c.startsWith(prefix)) ?? '';
}

function tailwindSpacingPx(token: string): number {
  const value = Number.parseFloat(token.split('-').at(-1) ?? '');
  return Number.isFinite(value) ? value * 4 : 0;
}

function makeBinding(id: string, overrides: Partial<AgentBindingFacts> = {}): AgentBindingFacts {
  return {
    id,
    projectId: 'proj',
    updatedAt: '2026-05-16T00:00:00.000Z',
    ...overrides,
  };
}

function kebab(): HTMLElement {
  return screen.getByRole('button', { name: /操作菜单/ });
}

function openMenu(): void {
  fireEvent.click(kebab());
}

function terminalHrefs(): (string | null)[] {
  return screen.getAllByRole('link', { name: 'Terminal' }).map(link => link.getAttribute('href'));
}

describe('AgentCard', () => {
  beforeEach(() => {
    deleteAgentMock.mockReset();
    compactMock.mockReset();
    clearMock.mockReset();
    reviewMock.mockReset();
    resumeAgentMock.mockReset();
    restartReplMock.mockReset();
    retryAgentMock.mockReset();
    showMock.mockReset();
  });

  describe('Held recovery via Resume button', () => {
    function heldCard(id: string, awaitingPhase: string, tmuxSessionStatus: AgentSnapshot['tmuxSessionStatus'] = 'present'): void {
      renderCard(makeSnapshot({
        id,
        runtimeStatus: 'pending',
        tmuxSessionStatus,
        binding: makeBinding(id, {
          status: 'awaiting_human',
          awaitingPhase,
          awaitingReason: `${awaitingPhase} reason`,
        }),
      }));
    }

    function resumeButton(): HTMLElement {
      return screen.getByRole('button', { name: /^Resume$/ });
    }

    it('routes Resume to restart-repl (re-greet) for a greeting_failed hold with a live session', async () => {
      restartReplMock.mockResolvedValue({ ok: true, agentId: 'dev-greet' });
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      heldCard('dev-greet', 'greeting_failed', 'present');

      await act(async () => { fireEvent.click(resumeButton()); });

      expect(restartReplMock).toHaveBeenCalledWith('proj', 'dev-greet');
      expect(retryAgentMock).not.toHaveBeenCalled();
      expect(resumeAgentMock).not.toHaveBeenCalled();
    });

    it.each(['absent', 'unreachable', 'unknown'] as const)(
      'routes Resume to retry (rebuild) for a greeting_failed hold when the session is %s',
      async (sessionStatus) => {
        retryAgentMock.mockResolvedValue({ ok: true, agentId: 'dev-gone' });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        heldCard('dev-gone', 'greeting_failed', sessionStatus);

        await act(async () => { fireEvent.click(resumeButton()); });

        expect(retryAgentMock).toHaveBeenCalledWith('proj', 'dev-gone');
        expect(restartReplMock).not.toHaveBeenCalled();
        expect(resumeAgentMock).not.toHaveBeenCalled();
      },
    );

    it('routes Resume to the resume endpoint for a non-greeting hold', async () => {
      resumeAgentMock.mockResolvedValue({ agentId: 'dev-hold', resumed: true, releasedBinding: true });
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      heldCard('dev-hold', 'cancel-interrupt-failed');

      await act(async () => { fireEvent.click(resumeButton()); });

      expect(resumeAgentMock).toHaveBeenCalledWith('proj', 'dev-hold');
      expect(restartReplMock).not.toHaveBeenCalled();
    });

    it('gives the greeting_failed Resume button a distinct tooltip from the plain hold', () => {
      heldCard('dev-greet', 'greeting_failed');
      expect(resumeButton().getAttribute('title')).toMatch(/握手|greeting|Restart REPL/i);
    });
  });

  it('shows the configured runtime as muted text after the agent name with hover text', () => {
    renderCard(makeSnapshot({ id: 'dev-codex' }), { runtime: 'codex' });

    const name = screen.getByText('dev-codex');
    const runtime = screen.getByText('(Codex)');
    expect(name.getAttribute('title')).toBe('dev-codex (Codex)');
    expect(runtime.className).toContain('text-og-400');
    expect(runtime.className).toContain('hidden');
    expect(runtime.className).toContain('sm:inline');
  });

  it('shows bootstrap as starting and keeps the terminal gated until the tmux session appears', () => {
    renderCard(makeSnapshot({
      id: 'dev-new',
      runtimeStatus: 'pending',
      tmuxSessionStatus: 'absent',
      binding: makeBinding('dev-new', { creationToken: 'create-1' }),
    }));

    expect(screen.getByText('Starting')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Starting session' })).toBeTruthy();
    expect(screen.getByText(/Agent 正在启动/)).toBeTruthy();
    expect(screen.queryByText('等待人工介入')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Terminal' })).toBeNull();
    expect(screen.getByText('Terminal')).toBeTruthy();
    expect(screen.queryByTestId('pane-terminal')).toBeNull();
  });

  it('keeps startup-dialog pending agents attachable once paneId is known', () => {
    renderCard(makeSnapshot({
      id: 'dev-pending',
      runtimeStatus: 'pending',
      binding: makeBinding('dev-pending', { creationToken: 'create-1', paneId: '%1' }),
    }));

    expect(screen.getByText('Pending user')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Session present' })).toBeNull();
    expect(screen.getByText('等待人工介入')).toBeTruthy();
    expect(terminalHrefs()).toEqual(['/terminal/dev-pending', '/terminal/dev-pending']);
    expect(screen.getByTestId('pane-terminal')).toBeTruthy();
  });

  it('allows attaching once the probe confirms PENDING_HUMAN even if paneId is still missing', () => {
    renderCard(makeSnapshot({
      id: 'dev-pending-no-pane',
      runtimeStatus: 'pending',
      reason: 'PENDING_HUMAN',
      message: 'Agent runtime is waiting on a startup dialog.',
      binding: makeBinding('dev-pending-no-pane', { creationToken: 'create-1' }),
    }));

    expect(screen.getByText('Pending user')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Session present' })).toBeNull();
    expect(screen.getByText('等待人工介入')).toBeTruthy();
    expect(terminalHrefs()).toEqual(['/terminal/dev-pending-no-pane', '/terminal/dev-pending-no-pane']);
    expect(screen.queryByText(/Agent 正在启动/)).toBeNull();
  });

  it('allows attaching when binding.status flips to awaiting_human even if paneId is still missing', () => {
    renderCard(makeSnapshot({
      id: 'dev-held',
      runtimeStatus: 'pending',
      binding: makeBinding('dev-held', {
        creationToken: 'create-1',
        status: 'awaiting_human',
        awaitingPhase: 'agent_dialog_pending',
        awaitingReason: 'startup dialog blocking REPL',
      }),
    }));

    expect(screen.getByText('Held')).toBeTruthy();
    expect(screen.getByText('agent_dialog_pending')).toBeTruthy();
    expect(terminalHrefs()).toEqual(['/terminal/dev-held', '/terminal/dev-held']);
    expect(screen.queryByText(/Agent 正在启动/)).toBeNull();
  });

  it('reveals the live terminal during in-flight bootstrap once the tmux session is present', () => {
    renderCard(makeSnapshot({
      id: 'dev-launching',
      runtimeStatus: 'pending',
      tmuxSessionStatus: 'present',
      binding: makeBinding('dev-launching', { creationToken: 'create-1' }),
    }));

    expect(screen.getByText('Starting')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Starting session' })).toBeTruthy();
    expect(screen.queryByText('等待人工介入')).toBeNull();
    expect(screen.queryByText(/Agent 正在启动/)).toBeNull();
    expect(terminalHrefs()).toEqual(['/terminal/dev-launching']);
    expect(screen.getByTestId('pane-terminal')).toBeTruthy();
  });

  it('embedded mode mounts the live terminal during bootstrap once the session is present', () => {
    renderCard(makeSnapshot({
      id: 'dev-emb-boot',
      runtimeStatus: 'pending',
      tmuxSessionStatus: 'present',
      binding: makeBinding('dev-emb-boot', { creationToken: 'create-1' }),
    }), { terminalMode: 'embedded-full' });

    expect(screen.getByText('Starting')).toBeTruthy();
    expect(screen.queryByText(/Agent 正在启动/)).toBeNull();
    expect(screen.getByTestId('pane-terminal').getAttribute('data-mode')).toBe('full');
  });

  it('embedded mode keeps the startup placeholder while bootstrapping before the session exists', () => {
    renderCard(makeSnapshot({
      id: 'dev-emb-wait',
      runtimeStatus: 'pending',
      tmuxSessionStatus: 'absent',
      binding: makeBinding('dev-emb-wait', { creationToken: 'create-1' }),
    }), { terminalMode: 'embedded-full' });

    expect(screen.queryByTestId('pane-terminal')).toBeNull();
    expect(screen.getByText('Agent 正在启动')).toBeTruthy();
  });

  it('embedded terminal mode renders an interactive full terminal even when idle', () => {
    renderCard(makeSnapshot({ id: 'dev-idle' }), { terminalMode: 'embedded-full' });

    const terminal = screen.getByTestId('pane-terminal');
    expect(terminal.getAttribute('data-mode')).toBe('full');
    expect(terminal.getAttribute('data-interactive')).toBe('true');
    expect(terminal.getAttribute('data-auto-focus')).toBe('false');
    expect(terminal.getAttribute('data-defer-full')).toBe('true');
    expect(terminal.parentElement!.className).not.toContain('rounded');
  });

  it('activity preview terminal frame is square-cornered', () => {
    renderCard(makeSnapshot({ id: 'dev-working', runtimeStatus: 'working' }));

    const terminal = screen.getByTestId('pane-terminal');
    const terminalFrame = terminal.parentElement as HTMLElement;
    expect(terminalFrame.className).toContain('border');
    expect(terminalFrame.className).not.toContain('rounded');
  });

  describe('selectable embedded terminals', () => {
    function renderSelectable(active: boolean, onActivate = vi.fn()) {
      renderCard(makeSnapshot({ id: 'dev-sel' }), { terminalMode: 'embedded-full', active, onActivate });
      return { onActivate };
    }

    it('renders a non-interactive preview by default (active=false)', () => {
      renderSelectable(false);
      const terminal = screen.getByTestId('pane-terminal');
      expect(terminal.getAttribute('data-mode')).toBe('preview');
      expect(terminal.getAttribute('data-interactive')).toBe('false');
    });

    it('upgrades to interactive full + autoFocus while active', () => {
      renderSelectable(true);
      const terminal = screen.getByTestId('pane-terminal');
      expect(terminal.getAttribute('data-mode')).toBe('full');
      expect(terminal.getAttribute('data-interactive')).toBe('true');
      expect(terminal.getAttribute('data-auto-focus')).toBe('true');
    });

    it('tags root with data-agent-card so group click-outside detection can find it', () => {
      renderSelectable(false);
      const tagged = document.querySelector('[data-agent-card="dev-sel"]');
      expect(tagged).not.toBeNull();
    });

    it('invokes onActivate when the terminal container is clicked', () => {
      const { onActivate } = renderSelectable(false);
      const trigger = screen.getByRole('button', { name: '激活 dev-sel 终端' });
      fireEvent.click(trigger);
      expect(onActivate).toHaveBeenCalledTimes(1);
    });

    it('does not activate when an inner control (e.g. the kebab menu button) inside the card is clicked', () => {
      const { onActivate } = renderSelectable(false);
      const menuTrigger = screen.getByRole('button', { name: /Agent dev-sel 操作菜单/ });
      fireEvent.click(menuTrigger);
      expect(onActivate).not.toHaveBeenCalled();
    });

    it('does not activate when the card root (outside the terminal pane) is clicked', () => {
      const { onActivate } = renderSelectable(false);
      const card = document.querySelector('[data-agent-card="dev-sel"]') as HTMLElement;
      fireEvent.click(card);
      expect(onActivate).not.toHaveBeenCalled();
    });

    it('exposes the terminal container as a keyboard-activatable button while inactive', () => {
      const { onActivate } = renderSelectable(false);
      const trigger = screen.getByRole('button', { name: '激活 dev-sel 终端' });
      expect(trigger.getAttribute('tabindex')).toBe('0');
      fireEvent.keyDown(trigger, { key: 'Enter' });
      expect(onActivate).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(trigger, { key: ' ' });
      expect(onActivate).toHaveBeenCalledTimes(2);
    });

    it('drops role/tabIndex/cursor-pointer from the terminal container once active', () => {
      renderSelectable(true);
      const terminalContainer = screen.getByTestId('pane-terminal').parentElement as HTMLElement;
      expect(terminalContainer.getAttribute('role')).toBeNull();
      expect(terminalContainer.getAttribute('tabindex')).toBeNull();
      expect(terminalContainer.className).not.toContain('cursor-pointer');
    });

    it('paints a blue accent ring on the active card', () => {
      renderSelectable(true);
      const card = document.querySelector('[data-agent-card="dev-sel"]') as HTMLElement;
      expect(card.className).toContain('ring-2');
      expect(card.className).toContain('ring-accent');
    });

    it('keeps the inactive card free of the accent ring', () => {
      renderSelectable(false);
      const card = document.querySelector('[data-agent-card="dev-sel"]') as HTMLElement;
      expect(card.className).not.toContain('ring-accent');
    });
  });

  it('hides the session-present status dot in the normal path', () => {
    renderCard(makeSnapshot({ id: 'dev-present' }));

    expect(screen.queryByRole('img', { name: 'Session present' })).toBeNull();
    expect(document.querySelector('.status-dot')).toBeNull();
  });

  it.each([
    ['absent', 'No session', 'status-dot--warn'],
    ['unreachable', 'Host unreachable', 'status-dot--danger'],
    ['unknown', 'Session unknown', 'status-dot--warn'],
  ] as const)('renders a non-normal %s tmux status as the %s dot (modifier %s)', (status, label, modifier) => {
    renderCard(makeSnapshot({ id: `dev-${status}`, tmuxSessionStatus: status }));
    const dot = screen.getByRole('img', { name: label });
    expect(dot.className).toContain(modifier);
  });

  it('non-normal status dots use the warning or danger treatment', () => {
    renderCard(makeSnapshot({ id: 'dev-no-session', tmuxSessionStatus: 'absent' }));
    const dot = screen.getByRole('img', { name: 'No session' });
    expect(dot.className).toContain('status-dot--warn');
    expect(dot.className).not.toContain('status-dot--danger');
  });

  it('abnormal status dot sits to the right of the runtime pill in the top-right group', () => {
    renderCard(makeSnapshot({
      id: 'dev-position',
      runtimeStatus: 'working',
      tmuxSessionStatus: 'unreachable',
      stale: true,
    }));
    const dot = screen.getByRole('img', { name: 'Host unreachable' });
    const runtimePill = screen.getByText('Working');
    const stalePill = screen.getByText('Stale');
    expect(dot.parentElement).toBe(runtimePill.parentElement);
    expect(dot.parentElement).toBe(stalePill.parentElement);
    const siblings = Array.from(dot.parentElement!.children);
    expect(siblings.indexOf(dot)).toBeGreaterThan(siblings.indexOf(runtimePill));
    expect(siblings.indexOf(dot)).toBeGreaterThan(siblings.indexOf(stalePill));
  });

  it('abnormal status dot carries an explicit extra left margin so it breathes away from the pill cluster', () => {
    renderCard(makeSnapshot({ id: 'dev-spacing', tmuxSessionStatus: 'absent' }));
    const dot = screen.getByRole('img', { name: 'No session' });
    expect(dot.className).toContain('ml-2');
  });

  describe('actions menu', () => {
    function renderIdleCard(): void {
      renderCard(makeSnapshot({ id: 'dev-actions' }));
    }

    async function clickMenuItem(name: string): Promise<void> {
      openMenu();
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name }));
      });
    }

    it('replaces the trash button with a vertical-ellipsis trigger and hides the menu by default', () => {
      renderIdleCard();

      const trigger = kebab();
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(trigger.getAttribute('aria-controls')).toBeNull();
      expect(trigger.querySelector('svg')).toBeTruthy();
      expect(screen.queryByText('🗑')).toBeNull();
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('opens the menu with Agent Pet, Compact, Clear, and Delete', () => {
      renderIdleCard();
      const trigger = kebab();

      fireEvent.click(trigger);

      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      const menu = screen.getByRole('menu');
      expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
      const items = screen.getAllByRole('menuitem');
      expect(items).toHaveLength(4);
      expect(items[0].textContent).toBe('Agent Pet');
      expect(items[1].textContent).toBe('Compact');
      expect(items[2].textContent).toBe('Clear');
      expect(items[3].textContent).toBe('Delete');
    });

    it('labels the menu via the trigger so screen readers know which agent owns it', () => {
      renderIdleCard();
      const trigger = kebab();

      fireEvent.click(trigger);

      const menu = screen.getByRole('menu');
      expect(menu.getAttribute('aria-labelledby')).toBe(trigger.id);
      expect(trigger.id).toBeTruthy();
      expect(screen.getByRole('menu', { name: /Agent dev-actions 操作菜单/ })).toBe(menu);
    });

    it('sends /compact via the Compact menu item and closes the menu', async () => {
      compactMock.mockResolvedValue({ compacted: true });
      renderIdleCard();

      await clickMenuItem('Compact');

      expect(compactMock).toHaveBeenCalledWith('dev-actions');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
    });

    it('sends /clear via the Clear menu item after user confirms', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      clearMock.mockResolvedValue({ cleared: true });
      renderIdleCard();

      await clickMenuItem('Clear');

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('dev-actions'));
      expect(clearMock).toHaveBeenCalledWith('dev-actions');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
      confirmSpy.mockRestore();
    });

    it('does not send /clear when user cancels the confirmation', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      renderIdleCard();

      await clickMenuItem('Clear');

      expect(confirmSpy).toHaveBeenCalled();
      expect(clearMock).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('shows an error toast when clear fails', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      clearMock.mockRejectedValue(new Error('Agent dev-actions has no live session'));
      renderIdleCard();

      await clickMenuItem('Clear');

      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'error',
        title: 'Clear 失败',
        body: expect.stringContaining('no live session'),
      }));
    });

    it('shows an error toast when compact fails', async () => {
      compactMock.mockRejectedValue(new Error('Agent dev-actions runtime is not at an idle REPL prompt'));
      renderIdleCard();

      await clickMenuItem('Compact');

      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'error',
        title: 'Compact 失败',
        body: expect.stringContaining('idle REPL prompt'),
      }));
    });

    it('disables all menu items while a compact is in flight', async () => {
      let resolveCompact: ((value: { compacted: boolean }) => void) | undefined;
      compactMock.mockReturnValue(new Promise(resolve => { resolveCompact = resolve; }));
      renderIdleCard();

      await clickMenuItem('Compact');
      openMenu();

      const items = screen.getAllByRole('menuitem') as HTMLButtonElement[];
      expect(items[1].textContent).toBe('Compacting…');
      expect(items.every(item => item.disabled)).toBe(true);

      await act(async () => {
        resolveCompact?.({ compacted: true });
      });
    });

    it('invokes deleteAgent when the Delete menu item is chosen', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      deleteAgentMock.mockResolvedValue({ removed: ['dev-actions'], restartRequired: false });
      renderIdleCard();

      await clickMenuItem('Delete');

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('dev-actions'));
      expect(deleteAgentMock).toHaveBeenCalledWith('proj', 'dev-actions');
      expect(screen.queryByRole('menu')).toBeNull();
      confirmSpy.mockRestore();
    });

    it('renders a delete error as a full-width block below the action row, not squeezed inside it', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      deleteAgentMock.mockRejectedValue(new Error('boom-delete-failed'));
      renderIdleCard();

      await clickMenuItem('Delete');

      const errorEl = await screen.findByText('boom-delete-failed');
      expect(errorEl.tagName).toBe('DIV');
      expect(errorEl.className).toContain('break-words');
      const actionRow = screen.getByRole('link', { name: 'Terminal' }).parentElement as HTMLElement;
      expect(actionRow.className).toContain('flex');
      expect(actionRow.contains(errorEl)).toBe(false);
      confirmSpy.mockRestore();
    });

    it('closes the menu when clicking outside', () => {
      renderIdleCard();
      openMenu();
      expect(screen.getByRole('menu')).toBeTruthy();

      fireEvent.mouseDown(document.body);

      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('closes the menu when pressing Escape', () => {
      renderIdleCard();
      openMenu();
      expect(screen.getByRole('menu')).toBeTruthy();

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('moves focus to the first menuitem when the menu opens', () => {
      renderIdleCard();

      openMenu();

      const firstItem = screen.getByRole('menuitem', { name: 'Agent Pet' });
      expect(document.activeElement).toBe(firstItem);
    });

    it('disables the menu trigger while a deletion is in flight', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      let resolveDelete: ((value: { removed: string[]; restartRequired: boolean }) => void) | undefined;
      deleteAgentMock.mockReturnValue(new Promise(resolve => { resolveDelete = resolve; }));
      renderIdleCard();
      const trigger = kebab();

      await clickMenuItem('Delete');

      expect((trigger as HTMLButtonElement).disabled).toBe(true);
      expect(trigger.className).toContain('disabled:opacity-50');
      expect(trigger.className).toContain('disabled:cursor-not-allowed');

      await act(async () => {
        resolveDelete?.({ removed: ['dev-actions'], restartRequired: false });
      });
      confirmSpy.mockRestore();
    });
  });

  describe('footer actions', () => {
    function renderDevWithTask(): void {
      renderCard(makeSnapshot({
        id: 'dev-footer',
        binding: makeBinding('dev-footer', { taskId: 'task-1' }),
      }));
    }

    it('shows "Call review" as a menuitem inside the kebab menu for dev agents with a task', () => {
      renderDevWithTask();
      expect(screen.queryByRole('button', { name: 'Call review' })).toBeNull();

      openMenu();
      expect(screen.getByRole('menuitem', { name: 'Call review' })).toBeTruthy();
    });

    it('hides "Call review" from the kebab menu for QA agents', () => {
      renderCard(makeSnapshot({
        id: 'qa-footer',
        binding: makeBinding('qa-footer', { taskId: 'task-1' }),
      }), { role: 'qa' });
      openMenu();
      expect(screen.queryByRole('menuitem', { name: 'Call review' })).toBeNull();
    });

    it('keeps the action buttons on one scrollable line (no wrap)', () => {
      renderDevWithTask();
      const actionRow = screen.getByRole('link', { name: 'Terminal' }).parentElement as HTMLElement;
      expect(actionRow.className).toContain('flex');
      expect(actionRow.className).not.toContain('flex-wrap');
      expect(actionRow.className).toContain('overflow-x-auto');
      expect(actionRow.className).toContain('scrollbar-none');
      expect(screen.getByRole('link', { name: 'Terminal' }).className).toContain('shrink-0');
    });

    it('keeps the kebab menu outside the scroll area so its dropdown is never clipped', () => {
      renderDevWithTask();
      const actionRow = screen.getByRole('link', { name: 'Terminal' }).parentElement as HTMLElement;
      expect(actionRow.contains(kebab())).toBe(false);
    });
  });

  describe('Agent Pet', () => {
    it('renders the animated pet in place of the status pill when petId is set', () => {
      renderCard(makeSnapshot({ id: 'dev-pet', runtimeStatus: 'working', petId: 'pet-1' }));
      expect(screen.queryByText('Working')).toBeNull();
      const pet = screen.getByRole('img', { name: 'Working' });
      expect(pet.getAttribute('data-pet-row')).toBe('7');
    });

    it('renders the card pet larger and lets it escape the card border', () => {
      renderCard(makeSnapshot({ id: 'dev-pet-large', runtimeStatus: 'working', petId: 'pet-1' }));
      const pet = screen.getByRole('img', { name: 'Working' });
      expect(pet.style.height).toBe('72px');
      const petFrame = pet.parentElement as HTMLElement;
      expect(petFrame.className).toContain('absolute');
      expect(petFrame.className).toContain('-top-4');
      const card = pet.closest('.card') as HTMLElement;
      expect(card.className).toContain('relative');
      expect(card.className).toContain('overflow-visible');
      const rightOffsetClass = classToken(petFrame, 'right-');
      const headerPaddingClass = classToken(petFrame.nextElementSibling as HTMLElement, 'pr-');
      expect(rightOffsetClass.length).toBeGreaterThan(0);
      expect(headerPaddingClass.length).toBeGreaterThan(0);
      expect(tailwindSpacingPx(headerPaddingClass))
        .toBeGreaterThan(tailwindSpacingPx(rightOffsetClass) + Number.parseFloat(pet.style.width));
    });

    it('keeps the status pill when no pet is assigned', () => {
      renderCard(makeSnapshot({ id: 'dev-nopet', runtimeStatus: 'working' }));
      expect(screen.getByText('Working').className).toContain('pill');
      expect(screen.queryByRole('img', { name: 'Working' })).toBeNull();
    });

    it('opens the Agent Pet config modal from the kebab menu', () => {
      renderCard(makeSnapshot({ id: 'dev-petcfg' }));
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Agent Pet' }));
      expect(screen.getByRole('dialog', { name: 'Agent Pet' })).toBeTruthy();
    });
  });

  it('does not mount an embedded terminal while agent state is loading', () => {
    renderCard(makeSnapshot({
      id: 'dev-loading',
      runtimeStatus: 'unknown',
      tmuxSessionStatus: 'unknown',
      stale: true,
    }), { terminalMode: 'embedded-full', terminalLoading: true });

    expect(screen.queryByTestId('pane-terminal')).toBeNull();
    expect(screen.getByText('Agent 状态加载中')).toBeTruthy();
  });
});
