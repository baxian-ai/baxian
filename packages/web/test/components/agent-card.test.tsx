import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  AgentBindingFacts,
  AgentRole,
  AgentRuntime,
  AgentSnapshot,
  TaskState,
} from '../../src/shared/index.js';

vi.mock('../../src/hooks/use-pending-restart.tsx', async () => (await import('../helpers/pending-restart-mock.tsx')).createPendingRestartMock());
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());
vi.mock('../../src/components/pane-terminal.tsx', async () => (await import('../helpers/pane-terminal-mock.tsx')).createPaneTerminalMock());

import { api } from '../../src/api.ts';
import {
  AgentCard,
  agentHoldRecovery,
  type TerminalMode,
} from '../../src/components/agent-card.tsx';
import { ConfirmProvider } from '../../src/components/confirm-dialog.tsx';
import { ToastProvider } from '../../src/components/toast.tsx';
import { enUS } from '../../src/i18n/en-us.ts';
import { flagDirtyMock } from '../helpers/pending-restart-mock.tsx';
import { expectToast } from '../helpers/toast.tsx';
import { makeTask } from '../helpers/fixtures.ts';

const deleteAgentMock = vi.mocked(api.projects.deleteAgent);
const compactMock = vi.mocked(api.agents.compact);
const clearMock = vi.mocked(api.agents.clear);
const stopMock = vi.mocked(api.agents.stop);
const resumeAgentMock = vi.mocked(api.projects.resumeAgent);
const restartReplMock = vi.mocked(api.projects.restartRepl);
const retryAgentMock = vi.mocked(api.projects.retryAgent);
const bootstrapMock = vi.mocked(api.projects.bootstrap);
type RenderCardOptions = {
  runtime?: AgentRuntime;
  model?: string;
  role?: AgentRole;
  terminalMode?: TerminalMode;
  terminalLoading?: boolean;
  active?: boolean;
  onActivate?: () => void;
  task?: TaskState;
};

function renderCard(agent: AgentSnapshot, options: RenderCardOptions = {}): void {
  const { runtime, model, role = 'dev', terminalMode, terminalLoading, active, onActivate, task } = options;
  render(
    <MemoryRouter>
      <ToastProvider>
        <ConfirmProvider>
          <AgentCard
            agent={agent}
            projectId="proj"
            role={role}
            runtime={runtime}
            model={model}
            terminalMode={terminalMode}
            terminalLoading={terminalLoading}
            active={active}
            onActivate={onActivate}
            task={task}
          />
        </ConfirmProvider>
      </ToastProvider>
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

function makeBinding(id: string, overrides: Partial<AgentBindingFacts> = {}): AgentBindingFacts {
  return {
    id,
    projectId: 'proj',
    updatedAt: '2026-05-16T00:00:00.000Z',
    ...overrides,
  };
}

function kebab(): HTMLElement {
  return screen.getByRole('button', { name: (_name, element) => element.getAttribute('aria-haspopup') === 'menu' });
}

function openMenu(): void {
  fireEvent.click(kebab());
}

function terminalHrefs(): (string | null)[] {
  return screen.getAllByRole('link', { name: enUS.agents.terminal }).map(link => link.getAttribute('href'));
}

async function findConfirmDialog(): Promise<HTMLElement> {
  return screen.findByRole('dialog');
}

async function settleConfirmDialog(buttonName: string): Promise<void> {
  const dialog = await findConfirmDialog();
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: buttonName }));
  });
}

describe('agentHoldRecovery', () => {
  it.each([
    ['greeting_failed', 'dev', 'restart-runtime'],
    ['agent_dialog_pending', 'dev', 'terminal'],
    ['dirty-workdir', 'qa', 'resume'],
    ['cancel-interrupt-failed', 'dev', 'resume'],
  ] as const)('maps %s for %s to %s', (phase, role, expected) => {
    expect(agentHoldRecovery(phase, role)).toBe(expected);
  });

  it.each([
    ['agent_dialog_resolved_runtime', 'dev', 'task'],
    ['signal-arm-failed:timeout', 'qa', 'task'],
    ['dispatch-failed:ack_unknown', 'dev', 'task'],
    ['dev-wait-gate-failed-after-qa-started', 'qa', 'task'],
    ['dirty-workdir', 'dev', 'task'],
    ['checkout-preparation-failed', 'dev', 'task'],
  ] as const)('maps active-task hold %s for %s to %s', (phase, role, expected) => {
    expect(agentHoldRecovery(phase, role, makeTask({ status: 'in_progress' }))).toBe(expected);
  });

  it('falls back to Resume once an active-task-only hold no longer owns an active task', () => {
    expect(agentHoldRecovery('signal-arm-failed:timeout', 'dev')).toBe('resume');
    expect(agentHoldRecovery(
      'dirty-workdir',
      'dev',
      makeTask({ status: 'max_rounds' }),
    )).toBe('resume');
  });
});

describe('AgentCard', () => {
  beforeEach(() => {
    deleteAgentMock.mockReset();
    compactMock.mockReset();
    clearMock.mockReset();
    stopMock.mockReset();
    resumeAgentMock.mockReset();
    restartReplMock.mockReset();
    retryAgentMock.mockReset();
    bootstrapMock.mockReset();
    flagDirtyMock.mockReset();
  });

  it.each(['agent_dialog_resolved_runtime', 'restart-redispatch-failed', 'bootstrap-marker-clear-failed'])('links an active %s hold to task actions without offering Resume', (awaitingPhase) => {
    const task = makeTask({ id: 'task-active', projectId: 'proj', status: 'in_progress' });
    renderCard(makeSnapshot({
      runtimeStatus: 'pending',
      binding: makeBinding('dev-1', {
        taskId: task.id,
        status: 'awaiting_human',
        awaitingPhase,
      }),
    }), { task });

    expect(screen.getByRole('link', { name: enUS.agents.openTaskActions }).getAttribute('href'))
      .toBe('/project/proj/task/task-active');
    expect(screen.queryByRole('button', { name: enUS.agents.deleteToRecover })).toBeNull();
    expect(screen.queryByRole('button', { name: enUS.agents.resume })).toBeNull();
  });

  it.each(['restart-redispatch-failed', 'bootstrap-marker-clear-failed'])('links a %s hold to its bound task before task data loads', (awaitingPhase) => {
    renderCard(makeSnapshot({
      binding: makeBinding('dev-1', { taskId: 'task-loading', status: 'awaiting_human', awaitingPhase }),
    }));

    expect(screen.getByRole('link', { name: enUS.agents.openTaskActions }).getAttribute('href'))
      .toBe('/project/proj/task/task-loading');
    expect(screen.queryByRole('button', { name: enUS.agents.resume })).toBeNull();
  });

  it('offers Resume for a delivered bootstrap hold after its task is cancelled', () => {
    const task = makeTask({ id: 'task-cancelled', projectId: 'proj', status: 'cancelled' });
    renderCard(makeSnapshot({
      binding: makeBinding('dev-1', {
        taskId: task.id, status: 'awaiting_human', awaitingPhase: 'bootstrap-marker-clear-failed',
      }),
    }), { task });

    expect(screen.getByRole('button', { name: enUS.agents.resume })).toBeTruthy();
    expect(screen.queryByRole('link', { name: enUS.agents.openTaskActions })).toBeNull();
  });

  it.each(['spec-ready', 'review', 'fixing', 'approved', 'merge-ready', 'max_rounds'] as const)(
    'offers Resume for a stale bootstrap hold after the task reaches %s', (status) => {
      const task = makeTask({ id: 'task-advanced', projectId: 'proj', status });
      renderCard(makeSnapshot({
        binding: makeBinding('dev-1', {
          taskId: task.id, status: 'awaiting_human', awaitingPhase: 'bootstrap-marker-clear-failed',
        }),
      }), { task });

      expect(screen.getByRole('button', { name: enUS.agents.resume })).toBeTruthy();
      expect(screen.queryByRole('link', { name: enUS.agents.openTaskActions })).toBeNull();
    },
  );

  it.each(['spec-ready', 'review', 'merge-ready', 'max_rounds'] as const)(
    'offers Resume for a stale replay failure after the task reaches %s', (status) => {
      const task = makeTask({ id: 'task-advanced', projectId: 'proj', status });
      renderCard(makeSnapshot({
        binding: makeBinding('dev-1', {
          taskId: task.id, status: 'awaiting_human', awaitingPhase: 'restart-redispatch-failed',
        }),
      }), { task });

      expect(screen.getByRole('button', { name: enUS.agents.resume })).toBeTruthy();
      expect(screen.queryByRole('link', { name: enUS.agents.openTaskActions })).toBeNull();
    },
  );

  it.each(['fixing', 'approved'] as const)(
    'keeps a %s replay failure linked to task recovery actions', (status) => {
      const task = makeTask({ id: 'task-replay', projectId: 'proj', status });
      renderCard(makeSnapshot({
        binding: makeBinding('dev-1', {
          taskId: task.id, status: 'awaiting_human', awaitingPhase: 'restart-redispatch-failed',
        }),
      }), { task });

      expect(screen.getByRole('link', { name: enUS.agents.openTaskActions }).getAttribute('href'))
        .toBe('/project/proj/task/task-replay');
      expect(screen.queryByRole('button', { name: enUS.agents.resume })).toBeNull();
    },
  );

  it.each(['spec-ready', 'review', 'merge-ready', 'max_rounds'] as const)(
    'offers Resume once an uncertain Dev delivery advances to %s', (status) => {
      const task = makeTask({ id: 'task-outcome', projectId: 'proj', status });
      renderCard(makeSnapshot({
        binding: makeBinding('dev-1', {
          taskId: task.id, status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
        }),
      }), { task });

      expect(screen.getByRole('button', { name: enUS.agents.resume })).toBeTruthy();
      expect(screen.queryByRole('link', { name: enUS.agents.openTaskActions })).toBeNull();
    },
  );

  it.each([
    { role: 'dev', status: 'in_progress' },
    { role: 'dev', status: 'fixing' },
    { role: 'dev', status: 'approved' },
    { role: 'qa', status: 'review' },
  ] as const)('keeps uncertain $role delivery in $status linked to task verification', ({ role, status }) => {
    const task = makeTask({ id: 'task-uncertain', projectId: 'proj', status });
    renderCard(makeSnapshot({
      id: `${role}-1`,
      binding: makeBinding(`${role}-1`, {
        taskId: task.id, status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      }),
    }), { task, role });

    expect(screen.getByRole('link', { name: enUS.agents.openTaskActions })).toBeTruthy();
    expect(screen.queryByRole('button', { name: enUS.agents.resume })).toBeNull();
  });

  it('waits for task state before offering Resume for an uncertain Dev delivery', () => {
    renderCard(makeSnapshot({
      binding: makeBinding('dev-1', {
        taskId: 'task-loading', status: 'awaiting_human', awaitingPhase: 'dispatch-failed:ack_unknown',
      }),
    }));

    expect(screen.getByRole('link', { name: enUS.agents.openTaskActions })).toBeTruthy();
    expect(screen.queryByRole('button', { name: enUS.agents.resume })).toBeNull();
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

    function recoveryButton(): HTMLElement {
      return screen.getByRole('button', { name: name => [enUS.agents.resume, enUS.agents.restartRuntime].includes(name) });
    }

    it('routes Resume to restart-repl (re-greet) for a greeting_failed hold with a live session', async () => {
      restartReplMock.mockResolvedValue({ ok: true, agentId: 'dev-greet' });
      heldCard('dev-greet', 'greeting_failed', 'present');

      fireEvent.click(recoveryButton());
      const dialog = await findConfirmDialog();
      expect(within(dialog).getByText(enUS.agents.resumeConfirmTitle('dev-greet'))).toBeTruthy();
      expect(within(dialog).getByText(enUS.agents.resumeGreetingBody)).toBeTruthy();
      await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: enUS.agents.resume })); });

      expect(restartReplMock).toHaveBeenCalledWith('proj', 'dev-greet');
      expect(retryAgentMock).not.toHaveBeenCalled();
      expect(resumeAgentMock).not.toHaveBeenCalled();
    });

    it.each(['absent', 'unreachable', 'unknown'] as const)(
      'routes Resume to retry (rebuild) for a greeting_failed hold when the session is %s',
      async (sessionStatus) => {
        retryAgentMock.mockResolvedValue({ ok: true, agentId: 'dev-gone' });
        heldCard('dev-gone', 'greeting_failed', sessionStatus);

        fireEvent.click(recoveryButton());
        await settleConfirmDialog(enUS.agents.resume);

        expect(retryAgentMock).toHaveBeenCalledWith('proj', 'dev-gone');
        expect(restartReplMock).not.toHaveBeenCalled();
        expect(resumeAgentMock).not.toHaveBeenCalled();
      },
    );

    it('routes Resume to the resume endpoint for a non-greeting hold', async () => {
      resumeAgentMock.mockResolvedValue({ agentId: 'dev-hold', resumed: true, releasedBinding: true });
      heldCard('dev-hold', 'cancel-interrupt-failed');

      fireEvent.click(recoveryButton());
      const dialog = await findConfirmDialog();
      expect(within(dialog).getByText(enUS.agents.resumeDefaultBody)).toBeTruthy();
      await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: enUS.agents.resume })); });

      expect(resumeAgentMock).toHaveBeenCalledWith('proj', 'dev-hold');
      expect(restartReplMock).not.toHaveBeenCalled();
    });

    it('surfaces a Resume failure as an error toast and re-enables the button', async () => {
      resumeAgentMock.mockRejectedValue(new Error('binding busy'));
      heldCard('dev-hold', 'cancel-interrupt-failed');

      fireEvent.click(recoveryButton());
      await settleConfirmDialog(enUS.agents.resume);

      await expectToast({ title: enUS.agents.resumeFailedTitle, body: 'binding busy' });
      expect((recoveryButton() as HTMLButtonElement).disabled).toBe(false);
    });

    it('does not call any resume endpoint when the confirm dialog is cancelled', async () => {
      heldCard('dev-hold', 'cancel-interrupt-failed');

      fireEvent.click(recoveryButton());
      await settleConfirmDialog(enUS.common.cancel);

      expect(resumeAgentMock).not.toHaveBeenCalled();
      expect(restartReplMock).not.toHaveBeenCalled();
      expect(retryAgentMock).not.toHaveBeenCalled();
    });
  });

  it('shows the configured runtime after the agent name with hover text, hiding the label on narrow viewports (hidden sm:inline)', () => {
    renderCard(makeSnapshot({ id: 'dev-codex' }), { runtime: 'codex' });

    const name = screen.getByText('dev-codex');
    const runtime = screen.getByText('(Codex)');
    expect(name.getAttribute('title')).toBe('dev-codex (Codex)');
    expect(runtime.className).toContain('hidden');
    expect(runtime.className).toContain('sm:inline');
  });

  it('renders the agent name at the same size and weight as the rest of the header', () => {
    renderCard(makeSnapshot({ id: 'dev-codex' }), { runtime: 'codex' });

    const nameTokens = screen.getByText('dev-codex').className.split(/\s+/);
    const roleTokens = screen.getByText('Dev').className.split(/\s+/);
    expect(nameTokens).toContain('text-xs');
    expect(roleTokens).toContain('text-xs');
    expect(nameTokens.some(token => token.startsWith('font-') && token !== 'font-display')).toBe(false);
  });

  it('appends the configured model after the runtime label when set', () => {
    renderCard(makeSnapshot({ id: 'dev-codex' }), { runtime: 'codex', model: 'gpt-5.4' });

    const name = screen.getByText('dev-codex');
    expect(screen.getByText('(Codex · gpt-5.4)')).toBeTruthy();
    expect(name.getAttribute('title')).toBe('dev-codex (Codex · gpt-5.4)');
  });

  it('shows the model alone when the runtime is unknown', () => {
    renderCard(makeSnapshot({ id: 'dev-x' }), { model: 'opus' });

    expect(screen.getByText('(opus)')).toBeTruthy();
    expect(screen.getByText('dev-x').getAttribute('title')).toBe('dev-x (opus)');
  });

  it('keeps the terminal gated until the tmux session appears during bootstrap', () => {
    renderCard(makeSnapshot({
      id: 'dev-new',
      runtimeStatus: 'pending',
      tmuxSessionStatus: 'absent',
      binding: makeBinding('dev-new', { creationToken: 'create-1' }),
    }));

    expect(screen.getByText(enUS.agents.bootstrappingNotice)).toBeTruthy();
    expect(screen.queryByText(enUS.agents.awaitingHumanIntervention)).toBeNull();
    expect(screen.queryByRole('link', { name: enUS.agents.terminal })).toBeNull();
    expect(screen.getByText(enUS.agents.terminal)).toBeTruthy();
    expect(screen.queryByTestId('pane-terminal')).toBeNull();
  });

  it('keeps startup-dialog pending agents attachable once paneId is known', () => {
    renderCard(makeSnapshot({
      id: 'dev-pending',
      runtimeStatus: 'pending',
      binding: makeBinding('dev-pending', { creationToken: 'create-1', paneId: '%1' }),
    }));

    expect(screen.getByText(enUS.agents.awaitingHumanIntervention)).toBeTruthy();
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

    expect(screen.getByText(enUS.agents.awaitingHumanIntervention)).toBeTruthy();
    expect(terminalHrefs()).toEqual(['/terminal/dev-pending-no-pane', '/terminal/dev-pending-no-pane']);
    expect(screen.queryByText(enUS.agents.bootstrappingNotice)).toBeNull();
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

    expect(screen.getByText('agent_dialog_pending')).toBeTruthy();
    expect(terminalHrefs()).toEqual(['/terminal/dev-held', '/terminal/dev-held']);
    expect(screen.queryByText(enUS.agents.bootstrappingNotice)).toBeNull();
  });

  it('offers a terminal link when the needInput watermark is lit', () => {
    renderCard(makeSnapshot({
      id: 'dev-asking',
      runtimeStatus: 'working',
      binding: makeBinding('dev-asking', {
        taskId: 'task-9',
        needInput: { epoch: 1, askSeq: 1, answeredSeq: 0, at: '2026-07-06T10:00:00Z' },
      }),
    }));

    expect(screen.getByText(enUS.agents.needInputNoticeTitle)).toBeTruthy();
    expect(terminalHrefs()).toContain('/terminal/dev-asking');
  });

  it('reveals the live terminal during in-flight bootstrap once the tmux session is present', () => {
    renderCard(makeSnapshot({
      id: 'dev-launching',
      runtimeStatus: 'pending',
      tmuxSessionStatus: 'present',
      binding: makeBinding('dev-launching', { creationToken: 'create-1' }),
    }));

    expect(screen.queryByText(enUS.agents.awaitingHumanIntervention)).toBeNull();
    expect(screen.queryByText(enUS.agents.bootstrappingNotice)).toBeNull();
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

    expect(screen.queryByText(enUS.agents.bootstrappingNotice)).toBeNull();
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
    expect(screen.getByText(enUS.agents.bootstrappingTerminalDisabled)).toBeTruthy();
  });

  it('embedded terminal mode renders an interactive full terminal even when idle', () => {
    renderCard(makeSnapshot({ id: 'dev-idle' }), { terminalMode: 'embedded-full' });

    const terminal = screen.getByTestId('pane-terminal');
    expect(terminal.getAttribute('data-mode')).toBe('full');
    expect(terminal.getAttribute('data-interactive')).toBe('true');
    expect(terminal.getAttribute('data-auto-focus')).toBe('false');
    expect(terminal.getAttribute('data-defer-full')).toBe('true');
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

    it('tags root with data-agent-card so team click-outside detection can find it', () => {
      renderSelectable(false);
      const tagged = document.querySelector('[data-agent-card="dev-sel"]');
      expect(tagged).not.toBeNull();
    });

    it('invokes onActivate when the terminal container is clicked', () => {
      const { onActivate } = renderSelectable(false);
      const trigger = screen.getByRole('button', { name: enUS.agents.activateTerminal('dev-sel') });
      fireEvent.click(trigger);
      expect(onActivate).toHaveBeenCalledTimes(1);
    });

    it('does not activate when an inner control (e.g. the kebab menu button) inside the card is clicked', () => {
      const { onActivate } = renderSelectable(false);
      const menuTrigger = screen.getByRole('button', { name: enUS.agents.actionsMenu('dev-sel') });
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
      const trigger = screen.getByRole('button', { name: enUS.agents.activateTerminal('dev-sel') });
      expect(trigger.getAttribute('tabindex')).toBe('0');
      fireEvent.keyDown(trigger, { key: 'Enter' });
      expect(onActivate).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(trigger, { key: ' ' });
      expect(onActivate).toHaveBeenCalledTimes(2);
    });

    it('drops the button role and tabIndex from the terminal container once active', () => {
      renderSelectable(true);
      const terminalContainer = screen.getByTestId('pane-terminal').parentElement as HTMLElement;
      expect(terminalContainer.getAttribute('role')).toBeNull();
      expect(terminalContainer.getAttribute('tabindex')).toBeNull();
    });
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

    it('opens the menu with Compact, Clear, and Delete', () => {
      renderIdleCard();
      const trigger = kebab();

      fireEvent.click(trigger);

      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      const menu = screen.getByRole('menu');
      expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
      const items = screen.getAllByRole('menuitem');
      expect(items).toHaveLength(3);
    });

    it('labels the menu via the trigger so screen readers know which agent owns it', () => {
      renderIdleCard();
      const trigger = kebab();

      fireEvent.click(trigger);

      const menu = screen.getByRole('menu');
      expect(menu.getAttribute('aria-labelledby')).toBe(trigger.id);
      expect(trigger.id).toBeTruthy();
      expect(screen.getByRole('menu', { name: enUS.agents.actionsMenu('dev-actions') })).toBe(menu);
    });

    it('sends /compact via the Compact menu item and closes the menu', async () => {
      compactMock.mockResolvedValue({ compacted: true });
      renderIdleCard();

      await clickMenuItem(enUS.agents.compact);

      expect(compactMock).toHaveBeenCalledWith('dev-actions');
      expect(screen.queryByRole('menu')).toBeNull();
      await expectToast({ title: enUS.agents.compactSentTitle('dev-actions') });
    });

    it('sends /clear via the Clear menu item after user confirms', async () => {
      clearMock.mockResolvedValue({ cleared: true });
      renderIdleCard();

      await clickMenuItem(enUS.agents.clear);
      const dialog = await findConfirmDialog();
      expect(within(dialog).getByText(enUS.agents.clearConfirmTitle('dev-actions'))).toBeTruthy();
      expect(within(dialog).getByText(enUS.agents.clearConfirmBody)).toBeTruthy();
      await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: enUS.agents.clearConfirmLabel })); });

      expect(clearMock).toHaveBeenCalledWith('dev-actions');
      expect(screen.queryByRole('menu')).toBeNull();
      await expectToast({ title: enUS.agents.clearSentTitle('dev-actions') });
    });

    it('does not send /clear when user cancels the confirmation', async () => {
      renderIdleCard();

      await clickMenuItem(enUS.agents.clear);
      await settleConfirmDialog(enUS.common.cancel);

      expect(clearMock).not.toHaveBeenCalled();
    });

    it('shows an error toast when clear fails', async () => {
      clearMock.mockRejectedValue(new Error('Agent dev-actions has no live session'));
      renderIdleCard();

      await clickMenuItem(enUS.agents.clear);
      await settleConfirmDialog(enUS.agents.clearConfirmLabel);

      await expectToast({
        title: enUS.agents.clearFailedTitle,
        body: /no live session/,
      });
    });

    it('shows an error toast when compact fails', async () => {
      compactMock.mockRejectedValue(new Error('Agent dev-actions runtime is not at an idle REPL prompt'));
      renderIdleCard();

      await clickMenuItem(enUS.agents.compact);

      await expectToast({
        title: enUS.agents.compactFailedTitle,
        body: /idle REPL prompt/,
      });
    });

    it('disables all menu items while a compact is in flight', async () => {
      let resolveCompact: ((value: { compacted: boolean }) => void) | undefined;
      compactMock.mockReturnValue(new Promise(resolve => { resolveCompact = resolve; }));
      renderIdleCard();

      await clickMenuItem(enUS.agents.compact);
      openMenu();

      const items = screen.getAllByRole('menuitem') as HTMLButtonElement[];
      expect(items.every(item => item.disabled)).toBe(true);

      await act(async () => {
        resolveCompact?.({ compacted: true });
      });
    });

    it('invokes deleteAgent when the Delete menu item is chosen', async () => {
      deleteAgentMock.mockResolvedValue({ removed: ['dev-actions'], restartRequired: false });
      renderIdleCard();

      await clickMenuItem(enUS.common.delete);
      const dialog = await findConfirmDialog();
      expect(within(dialog).getByText(enUS.agents.deleteConfirmTitle('dev-actions'))).toBeTruthy();
      expect(within(dialog).getByText(enUS.agents.deleteConfirmBody)).toBeTruthy();
      await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: enUS.common.delete })); });

      expect(deleteAgentMock).toHaveBeenCalledWith('proj', 'dev-actions');
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('renders a delete error below the action row, not inside it', async () => {
      deleteAgentMock.mockRejectedValue(new Error('boom-delete-failed'));
      renderIdleCard();

      await clickMenuItem(enUS.common.delete);
      await settleConfirmDialog(enUS.common.delete);

      const errorEl = await screen.findByText('boom-delete-failed');
      const actionRow = screen.getByRole('link', { name: enUS.agents.terminal }).parentElement as HTMLElement;
      expect(actionRow.contains(errorEl)).toBe(false);
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

      const firstItem = screen.getByRole('menuitem', { name: enUS.agents.compact });
      expect(document.activeElement).toBe(firstItem);
    });

    it('disables the menu trigger while a deletion is in flight', async () => {
      let resolveDelete: ((value: { removed: string[]; restartRequired: boolean }) => void) | undefined;
      deleteAgentMock.mockReturnValue(new Promise(resolve => { resolveDelete = resolve; }));
      renderIdleCard();
      const trigger = kebab();

      await clickMenuItem(enUS.common.delete);
      await settleConfirmDialog(enUS.common.delete);

      expect((trigger as HTMLButtonElement).disabled).toBe(true);

      await act(async () => {
        resolveDelete?.({ removed: ['dev-actions'], restartRequired: false });
      });
    });
  });

  describe('footer actions', () => {
    function renderDevWithTask(): void {
      renderCard(makeSnapshot({
        id: 'dev-footer',
        binding: makeBinding('dev-footer', { taskId: 'task-1' }),
      }));
    }

    it('does not expose task workflow operations in the agent menu', () => {
      renderDevWithTask();
      openMenu();
      expect(screen.queryByRole('menuitem', { name: 'Call review' })).toBeNull();
    });

    it('keeps the action buttons on one horizontally scrollable line on narrow cards', () => {
      renderDevWithTask();
      // jsdom does no layout: these tokens are the only guard that actions scroll instead of wrapping or shrinking
      const actionRow = screen.getByRole('link', { name: enUS.agents.terminal }).parentElement as HTMLElement;
      const rowTokens = actionRow.className.split(/\s+/);
      expect(rowTokens).toEqual(expect.arrayContaining(['flex', 'overflow-x-auto', 'scrollbar-none']));
      expect(rowTokens).not.toContain('flex-wrap');
      expect(screen.getByRole('link', { name: enUS.agents.terminal }).className.split(/\s+/)).toContain('shrink-0');
    });

    it('keeps the kebab menu outside the scroll area so its dropdown is never clipped', () => {
      renderDevWithTask();
      const actionRow = screen.getByRole('link', { name: enUS.agents.terminal }).parentElement as HTMLElement;
      expect(actionRow.contains(kebab())).toBe(false);
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
    expect(screen.getByText(enUS.agents.agentStatusLoading)).toBeTruthy();
  });

  describe('Stop button', () => {
    it('stops a working agent through the session endpoint', async () => {
      stopMock.mockResolvedValue(undefined);
      renderCard(makeSnapshot({ id: 'dev-stop', runtimeStatus: 'working' }));

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: enUS.agents.stop })); });

      expect(stopMock).toHaveBeenCalledWith('dev-stop');
      expect(screen.getByRole('button', { name: enUS.agents.stop })).toBeTruthy();
    });

    it('shows Cancelling… while in flight and renders a failure below the actions', async () => {
      let rejectStop: ((err: Error) => void) | undefined;
      stopMock.mockReturnValue(new Promise((_resolve, reject) => { rejectStop = reject; }));
      renderCard(makeSnapshot({ id: 'dev-stop', runtimeStatus: 'working' }));

      fireEvent.click(screen.getByRole('button', { name: enUS.agents.stop }));
      expect((screen.getByRole('button', { name: enUS.agents.stopping }) as HTMLButtonElement).disabled).toBe(true);

      await act(async () => { rejectStop?.(new Error('no live pane')); });

      expect(screen.getByText('no live pane')).toBeTruthy();
      expect(screen.getByRole('button', { name: enUS.agents.stop })).toBeTruthy();
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

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: enUS.agents.retryBootstrap })); });

      expect(bootstrapMock).toHaveBeenCalledWith('proj');
      await expectToast({ title: enUS.agents.retryBootstrapSucceededTitle });
    });

    it('reports a still-failing bootstrap as a warning', async () => {
      bootstrapMock.mockResolvedValue({ ok: false, ran: 1 });
      renderBootstrapError();

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: enUS.agents.retryBootstrap })); });

      await expectToast({ title: enUS.agents.retryBootstrapStillFailingTitle });
    });

    it('reports a thrown bootstrap retry error as an error toast', async () => {
      bootstrapMock.mockRejectedValue(new Error('ssh unreachable'));
      renderBootstrapError();

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: enUS.agents.retryBootstrap })); });

      await expectToast({ title: enUS.agents.retryBootstrapFailedTitle, body: 'ssh unreachable' });
      expect(screen.getByRole('button', { name: enUS.agents.retryBootstrap })).toBeTruthy();
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
    expect(screen.queryByRole('button', { name: enUS.agents.retryBootstrap })).toBeNull();
  });

  describe('Agent Team deletion', () => {
    it('warns that the Agent Team member was removed together and flags the restart', async () => {
      deleteAgentMock.mockResolvedValue({ removed: ['dev-actions', 'qa-actions'], restartRequired: true });
      renderCard(makeSnapshot({ id: 'dev-actions' }));

      openMenu();
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: enUS.common.delete }));
      });
      await settleConfirmDialog(enUS.common.delete);

      expect(flagDirtyMock).toHaveBeenCalled();
      await expectToast({
        title: enUS.agents.deletedWithTeamTitle('dev-actions'),
        body: enUS.agents.deletedWithTeamBody('qa-actions'),
      });
    });

    it('includes post-commit cleanup warnings in the Agent Team deletion toast', async () => {
      deleteAgentMock.mockResolvedValue({
        removed: ['dev-actions', 'qa-actions'],
        restartRequired: false,
        warnings: ['lock release for qa-actions failed: ownership changed'],
      });
      renderCard(makeSnapshot({ id: 'dev-actions' }));

      openMenu();
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: enUS.common.delete }));
      });
      await settleConfirmDialog(enUS.common.delete);

      await expectToast({
        title: enUS.agents.deletedWithTeamTitle('dev-actions'),
        body:
          enUS.agents.deletedWithTeamBody('qa-actions') + '\n'
          + 'lock release for qa-actions failed: ownership changed',
      });
    });
  });
});
