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

vi.mock('../../src/components/toast.tsx', async () => (await import('../helpers/toast-mock.tsx')).createToastMock());
vi.mock('../../src/hooks/use-pending-restart.tsx', async () => (await import('../helpers/pending-restart-mock.tsx')).createPendingRestartMock());
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());
vi.mock('../../src/components/pane-terminal.tsx', async () => (await import('../helpers/pane-terminal-mock.tsx')).createPaneTerminalMock());

vi.mock('../../src/hooks/use-pets.ts', () => ({
  usePets: () => ({ pets: [], loading: false, error: null, refresh: vi.fn() }),
  usePetSpritesheet: (petId?: string) => (petId ? 'blob:mock-sprite' : null),
}));

import { api } from '../../src/api.ts';
import {
  AgentCard,
  agentHoldRecovery,
  resolveAgentBadge,
  type TerminalMode,
} from '../../src/components/agent-card.tsx';
import { ConfirmProvider } from '../../src/components/confirm-dialog.tsx';
import { enUS } from '../../src/i18n/en-us.ts';
import { flagDirtyMock } from '../helpers/pending-restart-mock.tsx';
import { toastShowMock } from '../helpers/toast-mock.tsx';
import { makeTask } from '../helpers/fixtures.ts';

const showMock = toastShowMock;
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
  return screen.getByRole('button', { name: /actions menu/ });
}

function openMenu(): void {
  fireEvent.click(kebab());
}

function terminalHrefs(): (string | null)[] {
  return screen.getAllByRole('link', { name: 'Terminal' }).map(link => link.getAttribute('href'));
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

describe('resolveAgentBadge', () => {
  const t = enUS.agents;

  function badgeFor(overrides: Partial<AgentSnapshot> = {}) {
    return resolveAgentBadge(makeSnapshot(overrides), t);
  }

  it('ranks host unreachable above every other signal', () => {
    const badge = badgeFor({
      runtimeStatus: 'error',
      tmuxSessionStatus: 'unreachable',
      stale: true,
      binding: makeBinding('dev-1', {
        status: 'awaiting_human',
        awaitingReason: 'stuck',
        needInput: { epoch: 1, askSeq: 1, answeredSeq: 0, at: '2026-07-06T10:00:00Z' },
      }),
    });
    expect(badge.label).toBe('Host unreachable');
    expect(badge.cls).toBe('pill pill-danger');
    expect(badge.kind).toBe('alert');
  });

  it('shows Starting while bootstrapping even though the session is still absent', () => {
    const badge = badgeFor({
      runtimeStatus: 'pending',
      tmuxSessionStatus: 'absent',
      binding: makeBinding('dev-1', { creationToken: 'create-1' }),
    });
    expect(badge.label).toBe('Starting');
    expect(badge.cls).toBe('pill pill-review');
    expect(badge.kind).toBe('runtime');
  });

  it('ranks a missing session above a runtime error outside bootstrap', () => {
    const badge = badgeFor({ runtimeStatus: 'error', tmuxSessionStatus: 'absent' });
    expect(badge.label).toBe('No session');
    expect(badge.cls).toBe('pill pill-warn');
    expect(badge.kind).toBe('alert');
  });

  it('ranks a runtime error above a human hold', () => {
    const badge = badgeFor({
      runtimeStatus: 'error',
      binding: makeBinding('dev-1', { status: 'awaiting_human' }),
    });
    expect(badge.label).toBe('Error');
    expect(badge.cls).toBe('pill pill-warn');
    expect(badge.kind).toBe('alert');
  });

  it('ranks a human hold above an unanswered question and titles it with the awaiting reason', () => {
    const badge = badgeFor({
      runtimeStatus: 'pending',
      binding: makeBinding('dev-1', {
        status: 'awaiting_human',
        awaitingReason: 'recheck dispatch failed',
        needInput: { epoch: 1, askSeq: 1, answeredSeq: 0, at: '2026-07-06T10:00:00Z' },
      }),
    });
    expect(badge.label).toBe('Held');
    expect(badge.kind).toBe('alert');
    expect(badge.title).toBe('recheck dispatch failed');
  });

  it('falls back to the default hold reason when the binding carries none', () => {
    const badge = badgeFor({ binding: makeBinding('dev-1', { status: 'awaiting_human' }) });
    expect(badge.label).toBe('Held');
    expect(badge.title).toBe('Needs human attention');
  });

  it('ranks an unanswered question above the pending runtime status', () => {
    const badge = badgeFor({
      runtimeStatus: 'pending',
      binding: makeBinding('dev-1', { needInput: { epoch: 1, askSeq: 1, answeredSeq: 0, at: '2026-07-06T10:00:00Z' } }),
    });
    expect(badge.label).toBe('Awaiting reply');
    expect(badge.kind).toBe('alert');
    expect(badge.title).toContain('Agent is waiting for your reply');
  });

  it('reports the pending runtime status as an alert', () => {
    const badge = badgeFor({ runtimeStatus: 'pending' });
    expect(badge.label).toBe('Awaiting human');
    expect(badge.cls).toBe('pill pill-warn');
    expect(badge.kind).toBe('alert');
  });

  it.each([
    ['working', 'Working', 'pill pill-live'],
    ['waiting', 'Waiting', 'pill pill-review'],
    ['idle', 'Idle', 'pill pill-idle'],
    ['unknown', 'Unknown', 'pill pill-idle'],
  ] as const)('maps the %s runtime status to a plain %s badge', (status, label, cls) => {
    const badge = badgeFor({ runtimeStatus: status });
    expect(badge.label).toBe(label);
    expect(badge.cls).toBe(cls);
    expect(badge.kind).toBe('runtime');
  });

  it('lets the runtime status speak while the first session probe is still pending', () => {
    const badge = badgeFor({ runtimeStatus: 'idle', tmuxSessionStatus: 'unknown' });
    expect(badge.label).toBe('Idle');
  });

  it('does not treat an agent with a live pane as bootstrapping', () => {
    const badge = badgeFor({
      runtimeStatus: 'pending',
      binding: makeBinding('dev-1', { creationToken: 'create-1', paneId: '%1' }),
    });
    expect(badge.label).toBe('Awaiting human');
  });

  it('does not treat a startup-dialog hold as bootstrapping once the probe reports PENDING_HUMAN', () => {
    const badge = badgeFor({
      runtimeStatus: 'pending',
      reason: 'PENDING_HUMAN',
      binding: makeBinding('dev-1', { creationToken: 'create-1' }),
    });
    expect(badge.label).toBe('Awaiting human');
  });

  it('marks any badge as stale and appends the last-observed note to its title', () => {
    const badge = badgeFor({
      runtimeStatus: 'working',
      stale: true,
      observedAt: '2026-07-06T10:00:00Z',
    });
    expect(badge.label).toBe('Working');
    expect(badge.stale).toBe(true);
    expect(badge.title).toContain('stale');
    expect(badge.title).toContain(new Date('2026-07-06T10:00:00Z').toLocaleString());
  });

  it('keeps the hold reason and the stale note together in the title', () => {
    const badge = badgeFor({
      stale: true,
      binding: makeBinding('dev-1', { status: 'awaiting_human', awaitingReason: 'stuck' }),
    });
    expect(badge.title).toContain('stuck');
    expect(badge.title).toContain('stale');
  });

  it('leaves fresh badges without a stale marker', () => {
    const badge = badgeFor({ runtimeStatus: 'working' });
    expect(badge.stale).toBe(false);
    expect(badge.title).toBeUndefined();
  });
});

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
    showMock.mockReset();
  });

  it('links an active runtime-recovery hold to task actions instead of agent deletion', () => {
    const task = makeTask({ id: 'task-active', projectId: 'proj', status: 'in_progress' });
    renderCard(makeSnapshot({
      runtimeStatus: 'pending',
      binding: makeBinding('dev-1', {
        taskId: task.id,
        status: 'awaiting_human',
        awaitingPhase: 'agent_dialog_resolved_runtime',
      }),
    }), { task });

    expect(screen.getByRole('link', { name: 'Open task actions' }).getAttribute('href'))
      .toBe('/project/proj/task/task-active');
    expect(screen.queryByRole('button', { name: 'Delete agent' })).toBeNull();
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
      return screen.getByRole('button', { name: /^(Resume|Restart \/ retry runtime)$/ });
    }

    it('routes Resume to restart-repl (re-greet) for a greeting_failed hold with a live session', async () => {
      restartReplMock.mockResolvedValue({ ok: true, agentId: 'dev-greet' });
      heldCard('dev-greet', 'greeting_failed', 'present');

      fireEvent.click(recoveryButton());
      const dialog = await findConfirmDialog();
      expect(within(dialog).getByText('Resume agent dev-greet?')).toBeTruthy();
      expect(within(dialog).getByText(/re-run the handshake/)).toBeTruthy();
      await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Resume' })); });

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
        await settleConfirmDialog('Resume');

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
      expect(within(dialog).getByText(/baxian will clear the awaiting_human state/)).toBeTruthy();
      await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Resume' })); });

      expect(resumeAgentMock).toHaveBeenCalledWith('proj', 'dev-hold');
      expect(restartReplMock).not.toHaveBeenCalled();
    });

    it('gives the greeting_failed Resume button a distinct tooltip from the plain hold', () => {
      heldCard('dev-greet', 'greeting_failed');
      expect(recoveryButton().getAttribute('title')).toMatch(/greeting|Restart REPL/i);
    });

    it('surfaces a Resume failure as an error toast and re-enables the button', async () => {
      resumeAgentMock.mockRejectedValue(new Error('binding busy'));
      heldCard('dev-hold', 'cancel-interrupt-failed');

      fireEvent.click(recoveryButton());
      await settleConfirmDialog('Resume');

      expect(showMock).toHaveBeenCalledWith({ kind: 'error', title: 'Resume failed', body: 'binding busy' });
      expect((recoveryButton() as HTMLButtonElement).disabled).toBe(false);
    });

    it('does not call any resume endpoint when the confirm dialog is cancelled', async () => {
      heldCard('dev-hold', 'cancel-interrupt-failed');

      fireEvent.click(recoveryButton());
      await settleConfirmDialog('Cancel');

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

  it('appends the configured model after the runtime label when set', () => {
    renderCard(makeSnapshot({ id: 'dev-codex' }), { runtime: 'codex', model: 'gpt-5.4' });

    const name = screen.getByText('dev-codex');
    const runtime = screen.getByText('(Codex · gpt-5.4)');
    expect(name.getAttribute('title')).toBe('dev-codex (Codex · gpt-5.4)');
    expect(runtime.className).toContain('text-og-400');
  });

  it('shows the model alone when the runtime is unknown', () => {
    renderCard(makeSnapshot({ id: 'dev-x' }), { model: 'opus' });

    expect(screen.getByText('(opus)')).toBeTruthy();
    expect(screen.getByText('dev-x').getAttribute('title')).toBe('dev-x (opus)');
  });

  it('shows bootstrap as starting and keeps the terminal gated until the tmux session appears', () => {
    renderCard(makeSnapshot({
      id: 'dev-new',
      runtimeStatus: 'pending',
      tmuxSessionStatus: 'absent',
      binding: makeBinding('dev-new', { creationToken: 'create-1' }),
    }));

    expect(screen.getByText('Starting')).toBeTruthy();
    expect(screen.getByText(/Agent is starting/)).toBeTruthy();
    expect(screen.queryByText('Awaiting human intervention')).toBeNull();
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

    expect(screen.getByText('Awaiting human')).toBeTruthy();
    expect(screen.getByText('Awaiting human intervention')).toBeTruthy();
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

    expect(screen.getByText('Awaiting human')).toBeTruthy();
    expect(screen.getByText('Awaiting human intervention')).toBeTruthy();
    expect(terminalHrefs()).toEqual(['/terminal/dev-pending-no-pane', '/terminal/dev-pending-no-pane']);
    expect(screen.queryByText(/Agent is starting/)).toBeNull();
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
    expect(screen.queryByText(/Agent is starting/)).toBeNull();
  });

  it('shows the need-input badge and hint when the needInput watermark is lit', () => {
    renderCard(makeSnapshot({
      id: 'dev-asking',
      runtimeStatus: 'working',
      binding: makeBinding('dev-asking', {
        taskId: 'task-9',
        needInput: { epoch: 1, askSeq: 1, answeredSeq: 0, at: '2026-07-06T10:00:00Z' },
      }),
    }));

    expect(screen.getByText('Awaiting reply')).toBeTruthy();
    expect(screen.getByText('Agent is waiting for your reply')).toBeTruthy();
    expect(terminalHrefs()).toContain('/terminal/dev-asking');
  });

  it('renders no need-input badge without a lit needInput watermark', () => {
    renderCard(makeSnapshot({
      id: 'dev-quiet',
      runtimeStatus: 'working',
      binding: makeBinding('dev-quiet', { taskId: 'task-9' }),
    }));

    expect(screen.queryByText('Awaiting reply')).toBeNull();
    expect(screen.queryByText('Agent is waiting for your reply')).toBeNull();
  });

  it('reveals the live terminal during in-flight bootstrap once the tmux session is present', () => {
    renderCard(makeSnapshot({
      id: 'dev-launching',
      runtimeStatus: 'pending',
      tmuxSessionStatus: 'present',
      binding: makeBinding('dev-launching', { creationToken: 'create-1' }),
    }));

    expect(screen.getByText('Starting')).toBeTruthy();
    expect(screen.queryByText('Awaiting human intervention')).toBeNull();
    expect(screen.queryByText(/Agent is starting/)).toBeNull();
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
    expect(screen.queryByText(/Agent is starting/)).toBeNull();
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
    expect(screen.getByText('Agent is starting')).toBeTruthy();
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

    it('tags root with data-agent-card so team click-outside detection can find it', () => {
      renderSelectable(false);
      const tagged = document.querySelector('[data-agent-card="dev-sel"]');
      expect(tagged).not.toBeNull();
    });

    it('invokes onActivate when the terminal container is clicked', () => {
      const { onActivate } = renderSelectable(false);
      const trigger = screen.getByRole('button', { name: 'Activate dev-sel terminal' });
      fireEvent.click(trigger);
      expect(onActivate).toHaveBeenCalledTimes(1);
    });

    it('does not activate when an inner control (e.g. the kebab menu button) inside the card is clicked', () => {
      const { onActivate } = renderSelectable(false);
      const menuTrigger = screen.getByRole('button', { name: /Agent dev-sel actions menu/ });
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
      const trigger = screen.getByRole('button', { name: 'Activate dev-sel terminal' });
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

  describe('unified status badge', () => {
    it('renders exactly one status badge even when several signals fire at once', () => {
      renderCard(makeSnapshot({
        id: 'dev-multi',
        runtimeStatus: 'working',
        tmuxSessionStatus: 'unreachable',
        stale: true,
        binding: makeBinding('dev-multi', {
          status: 'awaiting_human',
          needInput: { epoch: 1, askSeq: 1, answeredSeq: 0, at: '2026-07-06T10:00:00Z' },
        }),
      }));

      const badge = screen.getByText('Host unreachable');
      expect(badge.className).toContain('pill-danger');
      expect(screen.queryByText('Working')).toBeNull();
      expect(screen.queryByText('Held')).toBeNull();
      expect(screen.queryByText('Awaiting reply')).toBeNull();
    });

    it.each([
      ['absent', 'No session', 'pill-warn'],
      ['unreachable', 'Host unreachable', 'pill-danger'],
    ] as const)('renders a %s tmux session as a %s badge', (status, label, cls) => {
      renderCard(makeSnapshot({ id: `dev-${status}`, tmuxSessionStatus: status }));
      expect(screen.getByText(label).className).toContain(cls);
    });

    it('keeps the runtime badge as the only indicator while the first session probe is pending', () => {
      renderCard(makeSnapshot({ id: 'dev-probe', runtimeStatus: 'idle', tmuxSessionStatus: 'unknown' }));

      expect(screen.getByText('Idle')).toBeTruthy();
      expect(screen.queryByRole('img', { name: /[Ss]ession/ })).toBeNull();
    });

    it('outlines the stale badge without dimming its text and explains the staleness on hover', () => {
      renderCard(makeSnapshot({
        id: 'dev-stale',
        runtimeStatus: 'working',
        stale: true,
        observedAt: '2026-07-06T10:00:00Z',
      }));

      const badge = screen.getByText('Working');
      expect(badge.className).toContain('pill--stale');
      expect(badge.className).not.toContain('opacity');
      expect(badge.getAttribute('title')).toContain('stale');
      expect(badge.getAttribute('aria-label')).toBeNull();
    });

    it('exposes the staleness as real visually-hidden text next to the badge', () => {
      renderCard(makeSnapshot({
        id: 'dev-stale-sr',
        runtimeStatus: 'working',
        stale: true,
        observedAt: '2026-07-06T10:00:00Z',
      }));

      const note = screen.getByText(/Data may be stale/);
      expect(note.className).toContain('sr-only');
      expect(note.parentElement).toBe(screen.getByText('Working').parentElement);
    });

    it('folds the hold reason into the hidden stale note', () => {
      renderCard(makeSnapshot({
        id: 'dev-held-stale',
        stale: true,
        binding: makeBinding('dev-held-stale', { status: 'awaiting_human', awaitingReason: 'stuck' }),
      }));

      const note = screen.getByText(/Data may be stale/);
      expect(note.textContent).toContain('stuck');
    });

    it('keeps a fresh badge solid, untitled, and free of hidden notes', () => {
      renderCard(makeSnapshot({ id: 'dev-fresh', runtimeStatus: 'working' }));

      const badge = screen.getByText('Working');
      expect(badge.className).not.toContain('pill--stale');
      expect(badge.getAttribute('title')).toBeNull();
      expect(badge.getAttribute('aria-label')).toBeNull();
      expect(screen.queryByText(/Data may be stale/)).toBeNull();
    });

    it('keeps the outlined stale badge and its hidden note next to a pet so the staleness stays visible', () => {
      renderCard(makeSnapshot({
        id: 'dev-pet-stale',
        petId: 'pet-1',
        runtimeStatus: 'working',
        stale: true,
        observedAt: '2026-07-06T10:00:00Z',
      }));

      const badge = screen.getByText('Working');
      expect(badge.className).toContain('pill--stale');
      expect(badge.getAttribute('title')).toContain('stale');
      expect(screen.getByText(/Data may be stale/).className).toContain('sr-only');
    });

    it('keeps alert badges visible when a pet replaces the runtime badge', () => {
      renderCard(makeSnapshot({
        id: 'dev-pet-alert',
        petId: 'pet-1',
        binding: makeBinding('dev-pet-alert', {
          status: 'awaiting_human',
          awaitingReason: 'stuck on dialog',
        }),
      }));

      expect(screen.getByText('Held').getAttribute('title')).toContain('stuck on dialog');
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
      expect(items[1].textContent).toBe('Compact context');
      expect(items[2].textContent).toBe('Clear context');
      expect(items[3].textContent).toBe('Delete');
    });

    it('labels the menu via the trigger so screen readers know which agent owns it', () => {
      renderIdleCard();
      const trigger = kebab();

      fireEvent.click(trigger);

      const menu = screen.getByRole('menu');
      expect(menu.getAttribute('aria-labelledby')).toBe(trigger.id);
      expect(trigger.id).toBeTruthy();
      expect(screen.getByRole('menu', { name: /Agent dev-actions actions menu/ })).toBe(menu);
    });

    it('sends /compact via the Compact menu item and closes the menu', async () => {
      compactMock.mockResolvedValue({ compacted: true });
      renderIdleCard();

      await clickMenuItem('Compact context');

      expect(compactMock).toHaveBeenCalledWith('dev-actions');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
    });

    it('sends /clear via the Clear menu item after user confirms', async () => {
      clearMock.mockResolvedValue({ cleared: true });
      renderIdleCard();

      await clickMenuItem('Clear context');
      const dialog = await findConfirmDialog();
      expect(within(dialog).getByText('Clear the context for agent dev-actions?')).toBeTruthy();
      expect(within(dialog).getByText(/This sends \/clear/)).toBeTruthy();
      await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Clear' })); });

      expect(clearMock).toHaveBeenCalledWith('dev-actions');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
    });

    it('does not send /clear when user cancels the confirmation', async () => {
      renderIdleCard();

      await clickMenuItem('Clear context');
      await settleConfirmDialog('Cancel');

      expect(clearMock).not.toHaveBeenCalled();
    });

    it('shows an error toast when clear fails', async () => {
      clearMock.mockRejectedValue(new Error('Agent dev-actions has no live session'));
      renderIdleCard();

      await clickMenuItem('Clear context');
      await settleConfirmDialog('Clear');

      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'error',
        title: 'Failed to clear context',
        body: expect.stringContaining('no live session'),
      }));
    });

    it('shows an error toast when compact fails', async () => {
      compactMock.mockRejectedValue(new Error('Agent dev-actions runtime is not at an idle REPL prompt'));
      renderIdleCard();

      await clickMenuItem('Compact context');

      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'error',
        title: 'Failed to compact context',
        body: expect.stringContaining('idle REPL prompt'),
      }));
    });

    it('disables all menu items while a compact is in flight', async () => {
      let resolveCompact: ((value: { compacted: boolean }) => void) | undefined;
      compactMock.mockReturnValue(new Promise(resolve => { resolveCompact = resolve; }));
      renderIdleCard();

      await clickMenuItem('Compact context');
      openMenu();

      const items = screen.getAllByRole('menuitem') as HTMLButtonElement[];
      expect(items[1].textContent).toBe('Compacting…');
      expect(items.every(item => item.disabled)).toBe(true);

      await act(async () => {
        resolveCompact?.({ compacted: true });
      });
    });

    it('invokes deleteAgent when the Delete menu item is chosen', async () => {
      deleteAgentMock.mockResolvedValue({ removed: ['dev-actions'], restartRequired: false });
      renderIdleCard();

      await clickMenuItem('Delete');
      const dialog = await findConfirmDialog();
      expect(within(dialog).getByText('Delete the Agent Team containing dev-actions?')).toBeTruthy();
      expect(within(dialog).getByText('All agents in this Agent Team will be removed. This action cannot be undone.')).toBeTruthy();
      await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' })); });

      expect(deleteAgentMock).toHaveBeenCalledWith('proj', 'dev-actions');
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('renders a delete error as a full-width block below the action row, not squeezed inside it', async () => {
      deleteAgentMock.mockRejectedValue(new Error('boom-delete-failed'));
      renderIdleCard();

      await clickMenuItem('Delete');
      await settleConfirmDialog('Delete');

      const errorEl = await screen.findByText('boom-delete-failed');
      expect(errorEl.tagName).toBe('DIV');
      expect(errorEl.className).toContain('break-words');
      const actionRow = screen.getByRole('link', { name: 'Terminal' }).parentElement as HTMLElement;
      expect(actionRow.className).toContain('flex');
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

      const firstItem = screen.getByRole('menuitem', { name: 'Agent Pet' });
      expect(document.activeElement).toBe(firstItem);
    });

    it('disables the menu trigger while a deletion is in flight', async () => {
      let resolveDelete: ((value: { removed: string[]; restartRequired: boolean }) => void) | undefined;
      deleteAgentMock.mockReturnValue(new Promise(resolve => { resolveDelete = resolve; }));
      renderIdleCard();
      const trigger = kebab();

      await clickMenuItem('Delete');
      await settleConfirmDialog('Delete');

      expect((trigger as HTMLButtonElement).disabled).toBe(true);
      expect(trigger.className).toContain('disabled:opacity-50');
      expect(trigger.className).toContain('disabled:cursor-not-allowed');

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
    expect(screen.getByText('Agent status loading')).toBeTruthy();
  });

  describe('Stop button', () => {
    it('stops a working agent through the session endpoint', async () => {
      stopMock.mockResolvedValue(undefined);
      renderCard(makeSnapshot({ id: 'dev-stop', runtimeStatus: 'working' }));

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel task' })); });

      expect(stopMock).toHaveBeenCalledWith('dev-stop');
      expect(screen.getByRole('button', { name: 'Cancel task' })).toBeTruthy();
    });

    it('shows Cancelling… while in flight and renders a failure below the actions', async () => {
      let rejectStop: ((err: Error) => void) | undefined;
      stopMock.mockReturnValue(new Promise((_resolve, reject) => { rejectStop = reject; }));
      renderCard(makeSnapshot({ id: 'dev-stop', runtimeStatus: 'working' }));

      fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }));
      expect((screen.getByRole('button', { name: 'Cancelling…' }) as HTMLButtonElement).disabled).toBe(true);

      await act(async () => { rejectStop?.(new Error('no live pane')); });

      expect(screen.getByText('no live pane')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Cancel task' })).toBeTruthy();
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

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry bootstrap' })); });

      expect(bootstrapMock).toHaveBeenCalledWith('proj');
      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', title: 'Retry bootstrap succeeded' }));
    });

    it('reports a still-failing bootstrap as a warning', async () => {
      bootstrapMock.mockResolvedValue({ ok: false, ran: 1 });
      renderBootstrapError();

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry bootstrap' })); });

      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warn', title: 'Retry bootstrap still failed' }));
    });

    it('reports a thrown bootstrap retry error as an error toast', async () => {
      bootstrapMock.mockRejectedValue(new Error('ssh unreachable'));
      renderBootstrapError();

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry bootstrap' })); });

      expect(showMock).toHaveBeenCalledWith({ kind: 'error', title: 'Retry bootstrap failed', body: 'ssh unreachable' });
      expect(screen.getByRole('button', { name: 'Retry bootstrap' })).toBeTruthy();
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
    expect(screen.queryByRole('button', { name: 'Retry bootstrap' })).toBeNull();
  });

  describe('Agent Team deletion', () => {
    it('warns that the Agent Team member was removed together and flags the restart', async () => {
      deleteAgentMock.mockResolvedValue({ removed: ['dev-actions', 'qa-actions'], restartRequired: true });
      renderCard(makeSnapshot({ id: 'dev-actions' }));

      openMenu();
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
      });
      await settleConfirmDialog('Delete');

      expect(flagDirtyMock).toHaveBeenCalled();
      expect(showMock).toHaveBeenCalledWith({
        kind: 'warn',
        title: 'Deleted the Agent Team containing dev-actions',
        body: 'The Agent Team member qa-actions was removed as well.',
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
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
      });
      await settleConfirmDialog('Delete');

      expect(showMock).toHaveBeenCalledWith({
        kind: 'warn',
        title: 'Deleted the Agent Team containing dev-actions',
        body:
          'The Agent Team member qa-actions was removed as well.\n'
          + 'lock release for qa-actions failed: ownership changed',
      });
    });
  });
});
