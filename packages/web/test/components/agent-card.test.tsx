import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgentBindingFacts, AgentRole, AgentRuntime, AgentSnapshot } from '../../src/shared/index.js';

vi.mock('../../src/components/toast.tsx', async () => (await import('../helpers/toast-mock.tsx')).createToastMock());
vi.mock('../../src/hooks/use-pending-restart.tsx', async () => (await import('../helpers/pending-restart-mock.tsx')).createPendingRestartMock());
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());
vi.mock('../../src/components/pane-terminal.tsx', async () => (await import('../helpers/pane-terminal-mock.tsx')).createPaneTerminalMock());

vi.mock('../../src/hooks/use-pets.ts', () => ({
  usePets: () => ({ pets: [], loading: false, error: null, refresh: vi.fn() }),
  usePetSpritesheet: (petId?: string) => (petId ? 'blob:mock-sprite' : null),
}));

import { api } from '../../src/api.ts';
import { AgentCard, type TerminalMode } from '../../src/components/agent-card.tsx';
import { makeTask } from '../helpers/fixtures.ts';
import { flagDirtyMock } from '../helpers/pending-restart-mock.tsx';
import { toastShowMock } from '../helpers/toast-mock.tsx';

const showMock = toastShowMock;
const deleteAgentMock = vi.mocked(api.projects.deleteAgent);
const compactMock = vi.mocked(api.agents.compact);
const clearMock = vi.mocked(api.agents.clear);
const stopMock = vi.mocked(api.agents.stop);
const reviewMock = vi.mocked(api.tasks.review);
const resumeAgentMock = vi.mocked(api.projects.resumeAgent);
const restartReplMock = vi.mocked(api.projects.restartRepl);
const retryAgentMock = vi.mocked(api.projects.retryAgent);
const bootstrapMock = vi.mocked(api.projects.bootstrap);

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
  return screen.getAllByRole('link', { name: '终端' }).map(link => link.getAttribute('href'));
}

describe('AgentCard', () => {
  beforeEach(() => {
    deleteAgentMock.mockReset();
    compactMock.mockReset();
    clearMock.mockReset();
    stopMock.mockReset();
    reviewMock.mockReset();
    resumeAgentMock.mockReset();
    restartReplMock.mockReset();
    retryAgentMock.mockReset();
    bootstrapMock.mockReset();
    flagDirtyMock.mockReset();
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
      return screen.getByRole('button', { name: /^恢复$/ });
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

    it('surfaces a Resume failure as an error toast and re-enables the button', async () => {
      resumeAgentMock.mockRejectedValue(new Error('binding busy'));
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      heldCard('dev-hold', 'cancel-interrupt-failed');

      await act(async () => { fireEvent.click(resumeButton()); });

      expect(showMock).toHaveBeenCalledWith({ kind: 'error', title: 'Resume 失败', body: 'binding busy' });
      expect((resumeButton() as HTMLButtonElement).disabled).toBe(false);
    });

    it('does not call any resume endpoint when the confirm dialog is cancelled', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      heldCard('dev-hold', 'cancel-interrupt-failed');

      await act(async () => { fireEvent.click(resumeButton()); });

      expect(resumeAgentMock).not.toHaveBeenCalled();
      expect(restartReplMock).not.toHaveBeenCalled();
      expect(retryAgentMock).not.toHaveBeenCalled();
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

    expect(screen.getByText('启动中')).toBeTruthy();
    expect(screen.getByRole('img', { name: '会话启动中' })).toBeTruthy();
    expect(screen.getByText(/Agent 正在启动/)).toBeTruthy();
    expect(screen.queryByText('等待人工介入')).toBeNull();
    expect(screen.queryByRole('link', { name: '终端' })).toBeNull();
    expect(screen.getByText('终端')).toBeTruthy();
    expect(screen.queryByTestId('pane-terminal')).toBeNull();
  });

  it('keeps startup-dialog pending agents attachable once paneId is known', () => {
    renderCard(makeSnapshot({
      id: 'dev-pending',
      runtimeStatus: 'pending',
      binding: makeBinding('dev-pending', { creationToken: 'create-1', paneId: '%1' }),
    }));

    expect(screen.getByText('待人工')).toBeTruthy();
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

    expect(screen.getByText('待人工')).toBeTruthy();
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

    expect(screen.getByText('挂起')).toBeTruthy();
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

    expect(screen.getByText('启动中')).toBeTruthy();
    expect(screen.getByRole('img', { name: '会话启动中' })).toBeTruthy();
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

    expect(screen.getByText('启动中')).toBeTruthy();
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
    ['absent', '无会话', 'status-dot--warn'],
    ['unreachable', '主机不可达', 'status-dot--danger'],
    ['unknown', '会话状态未知', 'status-dot--warn'],
  ] as const)('renders a non-normal %s tmux status as the %s dot (modifier %s)', (status, label, modifier) => {
    renderCard(makeSnapshot({ id: `dev-${status}`, tmuxSessionStatus: status }));
    const dot = screen.getByRole('img', { name: label });
    expect(dot.className).toContain(modifier);
  });

  it('non-normal status dots use the warning or danger treatment', () => {
    renderCard(makeSnapshot({ id: 'dev-no-session', tmuxSessionStatus: 'absent' }));
    const dot = screen.getByRole('img', { name: '无会话' });
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
    const dot = screen.getByRole('img', { name: '主机不可达' });
    const runtimePill = screen.getByText('工作中');
    const stalePill = screen.getByText('失联');
    expect(dot.parentElement).toBe(runtimePill.parentElement);
    expect(dot.parentElement).toBe(stalePill.parentElement);
    const siblings = Array.from(dot.parentElement!.children);
    expect(siblings.indexOf(dot)).toBeGreaterThan(siblings.indexOf(runtimePill));
    expect(siblings.indexOf(dot)).toBeGreaterThan(siblings.indexOf(stalePill));
  });

  it('abnormal status dot carries an explicit extra left margin so it breathes away from the pill cluster', () => {
    renderCard(makeSnapshot({ id: 'dev-spacing', tmuxSessionStatus: 'absent' }));
    const dot = screen.getByRole('img', { name: '无会话' });
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
      expect(items[1].textContent).toBe('压缩上下文');
      expect(items[2].textContent).toBe('清空上下文');
      expect(items[3].textContent).toBe('删除');
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

      await clickMenuItem('压缩上下文');

      expect(compactMock).toHaveBeenCalledWith('dev-actions');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
    });

    it('sends /clear via the Clear menu item after user confirms', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      clearMock.mockResolvedValue({ cleared: true });
      renderIdleCard();

      await clickMenuItem('清空上下文');

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('dev-actions'));
      expect(clearMock).toHaveBeenCalledWith('dev-actions');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
      confirmSpy.mockRestore();
    });

    it('does not send /clear when user cancels the confirmation', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      renderIdleCard();

      await clickMenuItem('清空上下文');

      expect(confirmSpy).toHaveBeenCalled();
      expect(clearMock).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('shows an error toast when clear fails', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      clearMock.mockRejectedValue(new Error('Agent dev-actions has no live session'));
      renderIdleCard();

      await clickMenuItem('清空上下文');

      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'error',
        title: '清空上下文失败',
        body: expect.stringContaining('no live session'),
      }));
    });

    it('shows an error toast when compact fails', async () => {
      compactMock.mockRejectedValue(new Error('Agent dev-actions runtime is not at an idle REPL prompt'));
      renderIdleCard();

      await clickMenuItem('压缩上下文');

      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'error',
        title: '压缩上下文失败',
        body: expect.stringContaining('idle REPL prompt'),
      }));
    });

    it('disables all menu items while a compact is in flight', async () => {
      let resolveCompact: ((value: { compacted: boolean }) => void) | undefined;
      compactMock.mockReturnValue(new Promise(resolve => { resolveCompact = resolve; }));
      renderIdleCard();

      await clickMenuItem('压缩上下文');
      openMenu();

      const items = screen.getAllByRole('menuitem') as HTMLButtonElement[];
      expect(items[1].textContent).toBe('压缩中…');
      expect(items.every(item => item.disabled)).toBe(true);

      await act(async () => {
        resolveCompact?.({ compacted: true });
      });
    });

    it('invokes deleteAgent when the Delete menu item is chosen', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      deleteAgentMock.mockResolvedValue({ removed: ['dev-actions'], restartRequired: false });
      renderIdleCard();

      await clickMenuItem('删除');

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('dev-actions'));
      expect(deleteAgentMock).toHaveBeenCalledWith('proj', 'dev-actions');
      expect(screen.queryByRole('menu')).toBeNull();
      confirmSpy.mockRestore();
    });

    it('renders a delete error as a full-width block below the action row, not squeezed inside it', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      deleteAgentMock.mockRejectedValue(new Error('boom-delete-failed'));
      renderIdleCard();

      await clickMenuItem('删除');

      const errorEl = await screen.findByText('boom-delete-failed');
      expect(errorEl.tagName).toBe('DIV');
      expect(errorEl.className).toContain('break-words');
      const actionRow = screen.getByRole('link', { name: '终端' }).parentElement as HTMLElement;
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

      await clickMenuItem('删除');

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
      expect(screen.queryByRole('button', { name: '发起评审' })).toBeNull();

      openMenu();
      expect(screen.getByRole('menuitem', { name: '发起评审' })).toBeTruthy();
    });

    it('hides "Call review" from the kebab menu for QA agents', () => {
      renderCard(makeSnapshot({
        id: 'qa-footer',
        binding: makeBinding('qa-footer', { taskId: 'task-1' }),
      }), { role: 'qa' });
      openMenu();
      expect(screen.queryByRole('menuitem', { name: '发起评审' })).toBeNull();
    });

    it('keeps the action buttons on one scrollable line (no wrap)', () => {
      renderDevWithTask();
      const actionRow = screen.getByRole('link', { name: '终端' }).parentElement as HTMLElement;
      expect(actionRow.className).toContain('flex');
      expect(actionRow.className).not.toContain('flex-wrap');
      expect(actionRow.className).toContain('overflow-x-auto');
      expect(actionRow.className).toContain('scrollbar-none');
      expect(screen.getByRole('link', { name: '终端' }).className).toContain('shrink-0');
    });

    it('keeps the kebab menu outside the scroll area so its dropdown is never clipped', () => {
      renderDevWithTask();
      const actionRow = screen.getByRole('link', { name: '终端' }).parentElement as HTMLElement;
      expect(actionRow.contains(kebab())).toBe(false);
    });
  });

  describe('Agent Pet', () => {
    it('renders the animated pet in place of the status pill when petId is set', () => {
      renderCard(makeSnapshot({ id: 'dev-pet', runtimeStatus: 'working', petId: 'pet-1' }));
      expect(screen.queryByText('工作中')).toBeNull();
      const pet = screen.getByRole('img', { name: '工作中' });
      expect(pet.getAttribute('data-pet-row')).toBe('7');
    });

    it('renders the card pet larger and lets it escape the card border', () => {
      renderCard(makeSnapshot({ id: 'dev-pet-large', runtimeStatus: 'working', petId: 'pet-1' }));
      const pet = screen.getByRole('img', { name: '工作中' });
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
      expect(screen.getByText('工作中').className).toContain('pill');
      expect(screen.queryByRole('img', { name: '工作中' })).toBeNull();
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

  describe('Stop button', () => {
    it('stops a working agent through the session endpoint', async () => {
      stopMock.mockResolvedValue(undefined);
      renderCard(makeSnapshot({ id: 'dev-stop', runtimeStatus: 'working' }));

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止' })); });

      expect(stopMock).toHaveBeenCalledWith('dev-stop');
      expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
    });

    it('shows Stopping… while in flight and renders a failure below the actions', async () => {
      let rejectStop: ((err: Error) => void) | undefined;
      stopMock.mockReturnValue(new Promise((_resolve, reject) => { rejectStop = reject; }));
      renderCard(makeSnapshot({ id: 'dev-stop', runtimeStatus: 'working' }));

      fireEvent.click(screen.getByRole('button', { name: '停止' }));
      expect((screen.getByRole('button', { name: '停止中…' }) as HTMLButtonElement).disabled).toBe(true);

      await act(async () => { rejectStop?.(new Error('no live pane')); });

      expect(screen.getByText('no live pane')).toBeTruthy();
      expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
    });
  });

  describe('Call review dispatch', () => {
    function renderDevWithTask(): void {
      renderCard(makeSnapshot({
        id: 'dev-review',
        binding: makeBinding('dev-review', { taskId: 'task-9' }),
      }));
    }

    async function clickCallReview(): Promise<void> {
      openMenu();
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: '发起评审' }));
      });
    }

    it('confirms and dispatches a QA review, reporting the new round', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      reviewMock.mockResolvedValue(makeTask({ id: 'task-9', reviewRound: 4 }));
      renderDevWithTask();

      await clickCallReview();

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('task-9'));
      expect(reviewMock).toHaveBeenCalledWith('task-9');
      expect(showMock).toHaveBeenCalledWith({ kind: 'success', title: '已发起 QA 重审（第 4 轮）' });
      confirmSpy.mockRestore();
    });

    it('does nothing when the confirm dialog is cancelled', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      renderDevWithTask();

      await clickCallReview();

      expect(reviewMock).not.toHaveBeenCalled();
      expect(showMock).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('shows an error toast when the dispatch fails', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      reviewMock.mockRejectedValue(new Error('task has no PR'));
      renderDevWithTask();

      await clickCallReview();

      expect(showMock).toHaveBeenCalledWith({ kind: 'error', title: '发起评审失败', body: 'task has no PR' });
      confirmSpy.mockRestore();
    });
  });

  describe('bootstrap error card', () => {
    function renderBootstrapError(): void {
      renderCard(makeSnapshot({
        id: 'dev-boot',
        latestBootstrapError: {
          id: 'err-1',
          reason: 'CLONE_FAILED',
          message: 'git clone failed',
          occurredAt: '2026-06-01T00:00:00.000Z',
          recommendation: '检查 deploy key 权限',
        },
      }));
    }

    it('renders the message, recommendation and reason metadata', () => {
      renderBootstrapError();

      expect(screen.getByText('git clone failed')).toBeTruthy();
      expect(screen.getByText('检查 deploy key 权限')).toBeTruthy();
      expect(screen.getByText('CLONE_FAILED · 2026-06-01T00:00:00.000Z')).toBeTruthy();
    });

    it('Retry bootstrap reruns project bootstrap and reports success', async () => {
      bootstrapMock.mockResolvedValue({ ok: true, ran: 1 });
      renderBootstrapError();

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试 bootstrap' })); });

      expect(bootstrapMock).toHaveBeenCalledWith('proj');
      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', title: '重试 bootstrap 完成' }));
    });

    it('reports a still-failing bootstrap as a warning', async () => {
      bootstrapMock.mockResolvedValue({ ok: false, ran: 1 });
      renderBootstrapError();

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试 bootstrap' })); });

      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warn', title: '重试 bootstrap 仍失败' }));
    });

    it('reports a thrown bootstrap retry error as an error toast', async () => {
      bootstrapMock.mockRejectedValue(new Error('ssh unreachable'));
      renderBootstrapError();

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试 bootstrap' })); });

      expect(showMock).toHaveBeenCalledWith({ kind: 'error', title: '重试 bootstrap 失败', body: 'ssh unreachable' });
      expect(screen.getByRole('button', { name: '重试 bootstrap' })).toBeTruthy();
    });
  });

  it('renders the latest runtime error with its reason metadata', () => {
    renderCard(makeSnapshot({
      id: 'dev-err',
      latestError: {
        id: 'err-9',
        reason: 'REPL_CRASH',
        message: 'runtime crashed hard',
        occurredAt: '2026-06-02T03:04:05.000Z',
      },
    }));

    expect(screen.getByText('runtime crashed hard')).toBeTruthy();
    expect(screen.getByText('REPL_CRASH · 2026-06-02T03:04:05.000Z')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试 bootstrap' })).toBeNull();
  });

  describe('paired deletion', () => {
    it('warns that the paired QA agent was removed together and flags the restart', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      deleteAgentMock.mockResolvedValue({ removed: ['dev-actions', 'qa-actions'], restartRequired: true });
      renderCard(makeSnapshot({ id: 'dev-actions' }));

      openMenu();
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
      });

      expect(flagDirtyMock).toHaveBeenCalled();
      expect(showMock).toHaveBeenCalledWith({
        kind: 'warn',
        title: '已删除 Agent dev-actions',
        body: '配对的 QA agent qa-actions 也被一并移除。',
      });
      confirmSpy.mockRestore();
    });
  });
});
