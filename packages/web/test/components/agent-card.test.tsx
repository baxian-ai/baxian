import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgentRuntime, AgentSnapshot } from '../../src/shared/index.js';

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
vi.mock('../../src/api.ts', () => ({
  api: {
    agents: {
      compact: (...args: unknown[]) => compactMock(...args),
      clear: (...args: unknown[]) => clearMock(...args),
    },
    projects: {
      deleteAgent: (...args: unknown[]) => deleteAgentMock(...args),
    },
    tasks: {
      review: (...args: unknown[]) => reviewMock(...args),
    },
  },
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

import { AgentCard } from '../../src/components/agent-card.tsx';

function renderCard(agent: AgentSnapshot, runtime?: AgentRuntime): void {
  render(
    <MemoryRouter>
      <AgentCard agent={agent} projectId="proj" role="dev" runtime={runtime} />
    </MemoryRouter>,
  );
}

describe('AgentCard', () => {
  it('shows the configured runtime as muted text after the agent name with hover text', () => {
    renderCard({
      id: 'dev-codex',
      projectId: 'proj',
      runtimeStatus: 'idle',
      tmuxSessionStatus: 'present',
      stale: false,
    }, 'codex');

    const name = screen.getByText('dev-codex');
    const runtime = screen.getByText('(Codex)');
    expect(name.getAttribute('title')).toBe('dev-codex (Codex)');
    expect(runtime.className).toContain('text-og-400');
    expect(runtime.className).toContain('hidden');
    expect(runtime.className).toContain('sm:inline');
  });

  it('shows bootstrap as starting and keeps Terminal disabled until pane exists', () => {
    renderCard({
      id: 'dev-new',
      projectId: 'proj',
      runtimeStatus: 'pending',
      tmuxSessionStatus: 'absent',
      stale: false,
      binding: {
        id: 'dev-new',
        projectId: 'proj',
        creationToken: 'create-1',
        updatedAt: '2026-05-16T00:00:00.000Z',
      },
    });

    expect(screen.getByText('Starting')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Starting session' })).toBeTruthy();
    expect(screen.getByText(/Agent 正在启动/)).toBeTruthy();
    expect(screen.queryByText('等待人工介入')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Terminal' })).toBeNull();
    expect(screen.getByText('Terminal')).toBeTruthy();
  });

  it('keeps startup-dialog pending agents attachable once paneId is known', () => {
    renderCard({
      id: 'dev-pending',
      projectId: 'proj',
      runtimeStatus: 'pending',
      tmuxSessionStatus: 'present',
      stale: false,
      binding: {
        id: 'dev-pending',
        projectId: 'proj',
        creationToken: 'create-1',
        paneId: '%1',
        updatedAt: '2026-05-16T00:00:00.000Z',
      },
    });

    expect(screen.getByText('Pending user')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Session present' })).toBeTruthy();
    expect(screen.getByText('等待人工介入')).toBeTruthy();
    const terminalLinks = screen.getAllByRole('link', { name: 'Terminal' });
    expect(terminalLinks.map(link => link.getAttribute('href')))
      .toEqual(['/terminal/dev-pending', '/terminal/dev-pending']);
    expect(screen.getByTestId('pane-terminal')).toBeTruthy();
  });

  it('allows attaching once the probe confirms PENDING_HUMAN even if paneId is still missing', () => {
    renderCard({
      id: 'dev-pending-no-pane',
      projectId: 'proj',
      runtimeStatus: 'pending',
      tmuxSessionStatus: 'present',
      stale: false,
      reason: 'PENDING_HUMAN',
      message: 'Agent runtime is waiting on a startup dialog.',
      binding: {
        id: 'dev-pending-no-pane',
        projectId: 'proj',
        creationToken: 'create-1',
        updatedAt: '2026-05-16T00:00:00.000Z',
      },
    });

    expect(screen.getByText('Pending user')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Session present' })).toBeTruthy();
    expect(screen.getByText('等待人工介入')).toBeTruthy();
    const terminalLinks = screen.getAllByRole('link', { name: 'Terminal' });
    expect(terminalLinks.map(link => link.getAttribute('href')))
      .toEqual(['/terminal/dev-pending-no-pane', '/terminal/dev-pending-no-pane']);
    expect(screen.queryByText(/Agent 正在启动/)).toBeNull();
  });

  it('allows attaching when binding.status flips to awaiting_human even if paneId is still missing', () => {
    renderCard({
      id: 'dev-held',
      projectId: 'proj',
      runtimeStatus: 'pending',
      tmuxSessionStatus: 'present',
      stale: false,
      binding: {
        id: 'dev-held',
        projectId: 'proj',
        creationToken: 'create-1',
        updatedAt: '2026-05-16T00:00:00.000Z',
        status: 'awaiting_human',
        awaitingPhase: 'agent_dialog_pending',
        awaitingReason: 'startup dialog blocking REPL',
      },
    });

    expect(screen.getByText('Held')).toBeTruthy();
    expect(screen.getByText('agent_dialog_pending')).toBeTruthy();
    const terminalLinks = screen.getAllByRole('link', { name: 'Terminal' });
    expect(terminalLinks.map(link => link.getAttribute('href')))
      .toEqual(['/terminal/dev-held', '/terminal/dev-held']);
    expect(screen.queryByText(/Agent 正在启动/)).toBeNull();
  });

  it('keeps in-flight bootstrap as Starting when tmux is present but neither awaiting_human nor PENDING_HUMAN is set', () => {
    renderCard({
      id: 'dev-launching',
      projectId: 'proj',
      runtimeStatus: 'pending',
      tmuxSessionStatus: 'present',
      stale: false,
      binding: {
        id: 'dev-launching',
        projectId: 'proj',
        creationToken: 'create-1',
        updatedAt: '2026-05-16T00:00:00.000Z',
      },
    });

    expect(screen.getByText('Starting')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Starting session' })).toBeTruthy();
    expect(screen.getByText(/Agent 正在启动/)).toBeTruthy();
    expect(screen.queryByText('等待人工介入')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Terminal' })).toBeNull();
    expect(screen.getByText('Terminal')).toBeTruthy();
  });

  it('embedded terminal mode renders an interactive full terminal even when idle', () => {
    render(
      <MemoryRouter>
        <AgentCard
          agent={{
            id: 'dev-idle',
            projectId: 'proj',
            runtimeStatus: 'idle',
            tmuxSessionStatus: 'present',
            stale: false,
          }}
          projectId="proj"
          role="dev"
          terminalMode="embedded-full"
        />
      </MemoryRouter>,
    );

    const terminal = screen.getByTestId('pane-terminal');
    expect(terminal.getAttribute('data-mode')).toBe('full');
    expect(terminal.getAttribute('data-interactive')).toBe('true');
    expect(terminal.getAttribute('data-auto-focus')).toBe('false');
    expect(terminal.getAttribute('data-defer-full')).toBe('true');
    expect(terminal.parentElement!.className).not.toContain('rounded');
  });

  it('activity preview terminal frame is square-cornered', () => {
    renderCard({
      id: 'dev-working',
      projectId: 'proj',
      runtimeStatus: 'working',
      tmuxSessionStatus: 'present',
      stale: false,
    });

    const terminal = screen.getByTestId('pane-terminal');
    const terminalFrame = terminal.parentElement as HTMLElement;
    expect(terminalFrame.className).toContain('border');
    expect(terminalFrame.className).not.toContain('rounded');
  });

  describe('selectable embedded terminals', () => {
    function renderSelectable(active: boolean, onActivate = vi.fn()) {
      render(
        <MemoryRouter>
          <AgentCard
            agent={{
              id: 'dev-sel',
              projectId: 'proj',
              runtimeStatus: 'idle',
              tmuxSessionStatus: 'present',
              stale: false,
            }}
            projectId="proj"
            role="dev"
            terminalMode="embedded-full"
            active={active}
            onActivate={onActivate}
          />
        </MemoryRouter>,
      );
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

  it.each([
    ['present', 'Session present', 'status-dot--healthy'],
    ['absent', 'No session', 'status-dot--warn'],
    ['unreachable', 'Host unreachable', 'status-dot--danger'],
    ['unknown', 'Session unknown', 'status-dot--warn'],
  ] as const)('renders a %s tmux status as the %s dot (modifier %s)', (status, label, modifier) => {
    renderCard({
      id: `dev-${status}`,
      projectId: 'proj',
      runtimeStatus: 'idle',
      tmuxSessionStatus: status,
      stale: false,
    });
    const dot = screen.getByRole('img', { name: label });
    expect(dot.className).toContain(modifier);
  });

  it('healthy (present) dot does not animate; non-healthy dots breathe', () => {
    renderCard({
      id: 'dev-healthy',
      projectId: 'proj',
      runtimeStatus: 'idle',
      tmuxSessionStatus: 'present',
      stale: false,
    });
    const healthy = screen.getByRole('img', { name: 'Session present' });
    expect(healthy.className).toContain('status-dot--healthy');
    expect(healthy.className).not.toContain('status-dot--warn');
    expect(healthy.className).not.toContain('status-dot--danger');
  });

  it('status dot sits to the right of the runtime pill in the top-right group', () => {
    renderCard({
      id: 'dev-position',
      projectId: 'proj',
      runtimeStatus: 'working',
      tmuxSessionStatus: 'present',
      stale: true,
    });
    const dot = screen.getByRole('img', { name: 'Session present' });
    const runtimePill = screen.getByText('Working');
    const stalePill = screen.getByText('Stale');
    expect(dot.parentElement).toBe(runtimePill.parentElement);
    expect(dot.parentElement).toBe(stalePill.parentElement);
    const siblings = Array.from(dot.parentElement!.children);
    expect(siblings.indexOf(dot)).toBeGreaterThan(siblings.indexOf(runtimePill));
    expect(siblings.indexOf(dot)).toBeGreaterThan(siblings.indexOf(stalePill));
  });

  it('status dot carries an explicit extra left margin so it breathes away from the pill cluster', () => {
    renderCard({
      id: 'dev-spacing',
      projectId: 'proj',
      runtimeStatus: 'idle',
      tmuxSessionStatus: 'present',
      stale: false,
    });
    const dot = screen.getByRole('img', { name: 'Session present' });
    expect(dot.className).toContain('ml-2');
  });

  describe('actions menu', () => {
    beforeEach(() => {
      deleteAgentMock.mockReset();
      compactMock.mockReset();
      clearMock.mockReset();
      reviewMock.mockReset();
      showMock.mockReset();
    });

    function renderIdleCard(): void {
      renderCard({
        id: 'dev-actions',
        projectId: 'proj',
        runtimeStatus: 'idle',
        tmuxSessionStatus: 'present',
        stale: false,
      });
    }

    it('replaces the trash button with a vertical-ellipsis trigger and hides the menu by default', () => {
      renderIdleCard();

      const trigger = screen.getByRole('button', { name: /Agent dev-actions 操作菜单/ });
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(trigger.querySelector('svg')).toBeTruthy();
      expect(screen.queryByText('🗑')).toBeNull();
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('opens the menu with Compact, Clear, and Delete', () => {
      renderIdleCard();
      const trigger = screen.getByRole('button', { name: /Agent dev-actions 操作菜单/ });

      fireEvent.click(trigger);

      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      const menu = screen.getByRole('menu');
      expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
      const items = screen.getAllByRole('menuitem');
      expect(items).toHaveLength(3);
      expect(items[0].textContent).toBe('Compact');
      expect(items[1].textContent).toBe('Clear');
      expect(items[2].textContent).toBe('Delete');
    });

    it('labels the menu via the trigger so screen readers know which agent owns it', () => {
      renderIdleCard();
      const trigger = screen.getByRole('button', { name: /Agent dev-actions 操作菜单/ });

      fireEvent.click(trigger);

      const menu = screen.getByRole('menu');
      expect(menu.getAttribute('aria-labelledby')).toBe(trigger.id);
      expect(trigger.id).toBeTruthy();
      expect(screen.getByRole('menu', { name: /Agent dev-actions 操作菜单/ })).toBe(menu);
    });

    it('sends /compact via the Compact menu item and closes the menu', async () => {
      compactMock.mockResolvedValue({ compacted: true });
      renderIdleCard();

      fireEvent.click(screen.getByRole('button', { name: /Agent dev-actions 操作菜单/ }));
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Compact' }));
      });

      expect(compactMock).toHaveBeenCalledWith('dev-actions');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
    });

    it('sends /clear via the Clear menu item after user confirms', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      clearMock.mockResolvedValue({ cleared: true });
      renderIdleCard();

      fireEvent.click(screen.getByRole('button', { name: /Agent dev-actions 操作菜单/ }));
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Clear' }));
      });

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('dev-actions'));
      expect(clearMock).toHaveBeenCalledWith('dev-actions');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
      confirmSpy.mockRestore();
    });

    it('does not send /clear when user cancels the confirmation', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      renderIdleCard();

      fireEvent.click(screen.getByRole('button', { name: /Agent dev-actions 操作菜单/ }));
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Clear' }));
      });

      expect(confirmSpy).toHaveBeenCalled();
      expect(clearMock).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('shows an error toast when clear fails', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      clearMock.mockRejectedValue(new Error('Agent dev-actions has no live session'));
      renderIdleCard();

      fireEvent.click(screen.getByRole('button', { name: /Agent dev-actions 操作菜单/ }));
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Clear' }));
      });

      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'error',
        title: 'Clear 失败',
        body: expect.stringContaining('no live session'),
      }));
    });

    it('shows an error toast when compact fails', async () => {
      compactMock.mockRejectedValue(new Error('Agent dev-actions runtime is not at an idle REPL prompt'));
      renderIdleCard();

      fireEvent.click(screen.getByRole('button', { name: /Agent dev-actions 操作菜单/ }));
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Compact' }));
      });

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
      const trigger = screen.getByRole('button', { name: /Agent dev-actions 操作菜单/ });

      fireEvent.click(trigger);
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Compact' }));
      });
      fireEvent.click(trigger);

      const items = screen.getAllByRole('menuitem') as HTMLButtonElement[];
      expect(items[0].textContent).toBe('Compacting…');
      expect(items.every(item => item.disabled)).toBe(true);

      await act(async () => {
        resolveCompact?.({ compacted: true });
      });
    });

    it('invokes deleteAgent when the Delete menu item is chosen', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      deleteAgentMock.mockResolvedValue({ removed: ['dev-actions'], restartRequired: false });
      renderIdleCard();

      fireEvent.click(screen.getByRole('button', { name: /Agent dev-actions 操作菜单/ }));
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
      });

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('dev-actions'));
      expect(deleteAgentMock).toHaveBeenCalledWith('proj', 'dev-actions');
      expect(screen.queryByRole('menu')).toBeNull();
      confirmSpy.mockRestore();
    });

    it('renders a delete error as a full-width block below the action row, not squeezed inside it', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      deleteAgentMock.mockRejectedValue(new Error('boom-delete-failed'));
      renderIdleCard();

      fireEvent.click(screen.getByRole('button', { name: /Agent dev-actions 操作菜单/ }));
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
      });

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
      fireEvent.click(screen.getByRole('button', { name: /Agent dev-actions 操作菜单/ }));
      expect(screen.getByRole('menu')).toBeTruthy();

      fireEvent.mouseDown(document.body);

      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('closes the menu when pressing Escape', () => {
      renderIdleCard();
      fireEvent.click(screen.getByRole('button', { name: /Agent dev-actions 操作菜单/ }));
      expect(screen.getByRole('menu')).toBeTruthy();

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('moves focus to the first menuitem when the menu opens', () => {
      renderIdleCard();
      const trigger = screen.getByRole('button', { name: /Agent dev-actions 操作菜单/ });

      fireEvent.click(trigger);

      const firstItem = screen.getByRole('menuitem', { name: 'Compact' });
      expect(document.activeElement).toBe(firstItem);
    });

    it('disables the menu trigger while a deletion is in flight', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      let resolveDelete: ((value: { removed: string[]; restartRequired: boolean }) => void) | undefined;
      deleteAgentMock.mockReturnValue(new Promise(resolve => { resolveDelete = resolve; }));
      renderIdleCard();
      const trigger = screen.getByRole('button', { name: /Agent dev-actions 操作菜单/ });

      fireEvent.click(trigger);
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
      });

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
    beforeEach(() => {
      reviewMock.mockReset();
      showMock.mockReset();
    });

    function renderDevWithTask(): void {
      renderCard({
        id: 'dev-footer',
        projectId: 'proj',
        runtimeStatus: 'idle',
        tmuxSessionStatus: 'present',
        stale: false,
        binding: {
          id: 'dev-footer',
          projectId: 'proj',
          taskId: 'task-1',
          updatedAt: '2026-05-16T00:00:00.000Z',
        },
      });
    }

    it('shows "Call review" as a menuitem inside the kebab menu for dev agents with a task', () => {
      renderDevWithTask();
      expect(screen.queryByRole('button', { name: 'Call review' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /操作菜单/ }));
      expect(screen.getByRole('menuitem', { name: 'Call review' })).toBeTruthy();
    });

    it('hides "Call review" from the kebab menu for QA agents', () => {
      render(
        <MemoryRouter>
          <AgentCard
            agent={{
              id: 'qa-footer',
              projectId: 'proj',
              runtimeStatus: 'idle',
              tmuxSessionStatus: 'present',
              stale: false,
              binding: {
                id: 'qa-footer',
                projectId: 'proj',
                taskId: 'task-1',
                updatedAt: '2026-05-16T00:00:00.000Z',
              },
            }}
            projectId="proj"
            role="qa"
          />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole('button', { name: /操作菜单/ }));
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
      const kebab = screen.getByRole('button', { name: /操作菜单/ });
      expect(actionRow.contains(kebab)).toBe(false);
    });
  });

  it('does not mount an embedded terminal while agent state is loading', () => {
    render(
      <MemoryRouter>
        <AgentCard
          agent={{
            id: 'dev-loading',
            projectId: 'proj',
            runtimeStatus: 'unknown',
            tmuxSessionStatus: 'unknown',
            stale: true,
          }}
          projectId="proj"
          role="dev"
          terminalMode="embedded-full"
          terminalLoading
        />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('pane-terminal')).toBeNull();
    expect(screen.getByText('Agent 状态加载中')).toBeTruthy();
  });
});
