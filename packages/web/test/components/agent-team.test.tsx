import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgentConfig, AgentSnapshot, TaskState } from '../../src/shared/index.js';

vi.mock('../../src/components/toast.tsx', async () => (await import('../helpers/toast-mock.tsx')).createToastMock());
vi.mock('../../src/hooks/use-pending-restart.tsx', async () => (await import('../helpers/pending-restart-mock.tsx')).createPendingRestartMock());
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());
vi.mock('../../src/components/pane-terminal.tsx', async () => (await import('../helpers/pane-terminal-mock.tsx')).createPaneTerminalMock());

vi.mock('../../src/hooks/use-pets.ts', () => ({
  usePets: () => ({ pets: [], loading: false, error: null, refresh: vi.fn() }),
  usePetSpritesheet: (petId?: string) => (petId ? 'blob:mock-sprite' : null),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));

import { api } from '../../src/api.ts';
import { AgentTeam } from '../../src/components/agent-team.tsx';
import { ConfirmProvider } from '../../src/components/confirm-dialog.tsx';
import { makeAgent, makeTask } from '../helpers/fixtures.ts';

const tasksAdvanceMock = vi.mocked(api.tasks.advance);

beforeEach(() => {
  tasksAdvanceMock.mockReset();
  navigateMock.mockReset();
});

const TEAM: AgentConfig[] = [
  { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' },
  { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local' },
];

const NOW = '2026-05-16T00:00:00.000Z';

function agent(id: string): AgentSnapshot {
  return makeAgent(id);
}

function task(overrides: Partial<TaskState> = {}): TaskState {
  return makeTask({
    title: '梳理绑定逻辑',
    description: 'details',
    qaAgentId: 'qa-1',
    status: 'in_progress',
    branch: 'bx/task-001',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function activate(cardOrId: HTMLElement | string): void {
  const card = typeof cardOrId === 'string'
    ? document.querySelector(`[data-agent-card="${cardOrId}"]`) as HTMLElement
    : cardOrId;
  const trigger = within(card).getByRole('button', { name: /Activate .* terminal/ });
  fireEvent.click(trigger);
}

function classToken(el: HTMLElement, prefix: string): string {
  return el.className.split(/\s+/).find(token => token.startsWith(prefix)) ?? '';
}

type RenderTeamOptions = {
  team?: AgentConfig[];
  agentsById?: Map<string, AgentSnapshot>;
  agentsLoaded?: boolean;
  agentsError?: boolean;
  terminalMode?: 'embedded-full';
};

function defaultAgentsById(): Map<string, AgentSnapshot> {
  return new Map([
    ['dev-1', agent('dev-1')],
    ['qa-1', agent('qa-1')],
  ]);
}

function renderTeam(tasks: TaskState[], options: RenderTeamOptions = {}): void {
  const {
    team = TEAM,
    agentsById = defaultAgentsById(),
    agentsLoaded = true,
    agentsError,
    terminalMode,
  } = options;
  render(
    <MemoryRouter>
      <ConfirmProvider>
        <AgentTeam
          team={team}
          projectId="proj"
          agentsById={agentsById}
          agentsLoaded={agentsLoaded}
          agentsError={agentsError}
          tasks={tasks}
          terminalMode={terminalMode}
        />
      </ConfirmProvider>
    </MemoryRouter>,
  );
}

describe('AgentTeam', () => {
  it('shows active task summary above the team\'s agent cards', () => {
    renderTeam([task()]);

    const region = screen.getByRole('group', { name: 'Agent Team dev-1 / qa-1' });
    const idCell = within(region).getByText('001');
    expect(idCell.getAttribute('title')).toBe('task-001');
    expect(within(region).getByText('梳理绑定逻辑')).toBeTruthy();
    const taskButton = within(region).getByRole('button', { name: /梳理绑定逻辑/ });
    const round = within(taskButton).getByText('Round 0');
    const status = within(taskButton).getByText('In progress');
    expect(round.className).not.toContain('pill');
    expect(status.className).toContain('pill-live');
    expect(round.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(status.nextElementSibling).toBeNull();
    expect(within(taskButton).queryByRole('img', { name: 'in_progress' })).toBeNull();
    expect(within(region).getAllByText('dev-1').length).toBeGreaterThanOrEqual(1);
    expect(within(region).getAllByText('qa-1').length).toBeGreaterThanOrEqual(1);
    fireEvent.click(taskButton);
    expect(navigateMock).toHaveBeenCalledWith('/project/proj/task/task-001');
  });

  it('keeps an active task visible when the configured QA differs from its stable QA participant', () => {
    renderTeam([task()], {
      team: [
        TEAM[0]!,
        { id: 'qa-2', runtime: 'codex', role: 'qa', mode: 'local' },
      ],
      agentsById: new Map([
        ['dev-1', agent('dev-1')],
        ['qa-2', agent('qa-2')],
      ]),
    });

    const region = screen.getByRole('group', { name: 'Agent Team dev-1 / qa-2' });
    expect(within(region).getByText('梳理绑定逻辑')).toBeTruthy();
  });

  it('passes configured runtime labels to the team\'s agent card names', () => {
    renderTeam([]);

    const region = screen.getByRole('group', { name: 'Agent Team dev-1 / qa-1' });
    expect(within(region).getByText('dev-1').getAttribute('title')).toBe('dev-1 (Claude Code)');
    expect(within(region).getByText('qa-1').getAttribute('title')).toBe('qa-1 (Codex)');
    expect(within(region).getByText('(Claude Code)').className).toContain('text-og-400');
    expect(within(region).getByText('(Codex)').className).toContain('text-og-400');
  });

  it('passes the configured model through to the agent card runtime label', () => {
    renderTeam([], {
      team: [
        { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', model: 'opus' },
        { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local' },
      ],
    });

    const region = screen.getByRole('group', { name: 'Agent Team dev-1 / qa-1' });
    expect(within(region).getByText('dev-1').getAttribute('title')).toBe('dev-1 (Claude Code · opus)');
    expect(within(region).getByText('(Claude Code · opus)').className).toContain('text-og-400');
    expect(within(region).getByText('qa-1').getAttribute('title')).toBe('qa-1 (Codex)');
  });

  it('task summary shows Round as text without re-printing the dev/qa agent ids that the cards below already show', () => {
    renderTeam([task({ reviewRound: 3 })]);

    const region = screen.getByRole('group', { name: 'Agent Team dev-1 / qa-1' });
    const taskButton = within(region).getByRole('button', { name: /梳理绑定逻辑/ });
    const round = within(taskButton).getByText('Round 3');
    expect(round.className).not.toContain('pill');
    expect(within(taskButton).queryByText(/Dev /)).toBeNull();
    expect(within(taskButton).queryByText(/QA /)).toBeNull();
  });

  it('uses specReviewRound for the Round text when the task is in the spec phase', () => {
    renderTeam([task({ phase: 'spec', specReviewRound: 2, reviewRound: 0 })]);

    const region = screen.getByRole('group', { name: 'Agent Team dev-1 / qa-1' });
    expect(within(region).getByText('Round 2')).toBeTruthy();
  });

  it('shows a muted "No active task" placeholder above the agent cards when no active task is bound to the team', () => {
    renderTeam([]);

    const region = screen.getByRole('group', { name: 'Agent Team dev-1 / qa-1' });
    expect(within(region).getByText('No active task')).toBeTruthy();
    expect(within(region).queryByRole('button', { name: /task-/ })).toBeNull();
  });

  it('shows the same placeholder when the only matching task has reached a terminal status', () => {
    renderTeam([task({ status: 'merged' })]);

    const region = screen.getByRole('group', { name: 'Agent Team dev-1 / qa-1' });
    expect(within(region).queryByText('001')).toBeNull();
    expect(within(region).queryByText('梳理绑定逻辑')).toBeNull();
    expect(within(region).getByText('No active task')).toBeTruthy();
  });

  it('keeps the grid flush below the task bar even with a card pet — the pet may overlap it (no extra top gap)', () => {
    renderTeam([task()], {
      agentsById: new Map([
        ['dev-1', { ...agent('dev-1'), petId: 'pet-1' }],
        ['qa-1', agent('qa-1')],
      ]),
    });

    const pet = screen.getByRole('img');
    const petFrame = pet.parentElement as HTMLElement;
    const card = pet.closest('.card') as HTMLElement;
    const grid = card.parentElement as HTMLElement;
    expect(classToken(grid, 'pt-')).toBe('');
    expect(classToken(petFrame, '-top-').length).toBeGreaterThan(0);
  });

  it('does not add grid top spacing when no card pet is rendered', () => {
    renderTeam([task()]);

    const card = within(screen.getByRole('group', { name: 'Agent Team dev-1 / qa-1' }))
      .getByText('dev-1')
      .closest('.card') as HTMLElement;
    const grid = card.parentElement as HTMLElement;
    expect(classToken(grid, 'pt-')).toBe('');
  });

  it('embedded mode defaults to non-interactive previews so scroll stays smooth', () => {
    renderTeam([], { terminalMode: 'embedded-full' });

    const terminals = screen.getAllByTestId('pane-terminal');
    expect(terminals).toHaveLength(2);
    expect(terminals.map(t => t.getAttribute('data-mode'))).toEqual(['preview', 'preview']);
    expect(terminals.map(t => t.getAttribute('data-interactive'))).toEqual(['false', 'false']);
  });

  it('clicking a preview card upgrades only that one to interactive full', () => {
    renderTeam([], { terminalMode: 'embedded-full' });

    const devCard = document.querySelector('[data-agent-card="dev-1"]') as HTMLElement;
    activate(devCard);

    const terminals = screen.getAllByTestId('pane-terminal');
    expect(terminals[0].getAttribute('data-mode')).toBe('full');
    expect(terminals[0].getAttribute('data-interactive')).toBe('true');
    expect(terminals[1].getAttribute('data-mode')).toBe('preview');
    expect(terminals[1].getAttribute('data-interactive')).toBe('false');
    expect(devCard.className).toContain('ring-accent');
  });

  it('clicking a second card switches active and demotes the first back to preview', () => {
    renderTeam([], { terminalMode: 'embedded-full' });

    const devCard = document.querySelector('[data-agent-card="dev-1"]') as HTMLElement;
    const qaCard = document.querySelector('[data-agent-card="qa-1"]') as HTMLElement;
    activate(devCard);
    activate(qaCard);

    const terminals = screen.getAllByTestId('pane-terminal');
    expect(terminals[0].getAttribute('data-mode')).toBe('preview');
    expect(terminals[1].getAttribute('data-mode')).toBe('full');
    expect(devCard.className).not.toContain('ring-accent');
    expect(qaCard.className).toContain('ring-accent');
  });

  it('keeps active when the click target was inside a card but got detached before the document handler ran', () => {
    renderTeam([], { terminalMode: 'embedded-full' });

    const devCard = document.querySelector('[data-agent-card="dev-1"]') as HTMLElement;
    activate(devCard);
    expect(devCard.className).toContain('ring-accent');

    const detached = document.createElement('div');
    const event = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(event, 'composedPath', {
      value: () => [detached, devCard, document.body, document.documentElement, document],
    });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(devCard.className).toContain('ring-accent');
  });

  it('clicking outside any card resets every terminal back to preview', () => {
    renderTeam([], { terminalMode: 'embedded-full' });

    const devCard = document.querySelector('[data-agent-card="dev-1"]') as HTMLElement;
    activate(devCard);
    expect(screen.getAllByTestId('pane-terminal')[0].getAttribute('data-mode')).toBe('full');

    act(() => {
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(screen.getAllByTestId('pane-terminal')[0].getAttribute('data-mode')).toBe('preview');
  });

  it('pressing Escape resets every terminal back to preview', () => {
    renderTeam([], { terminalMode: 'embedded-full' });

    const devCard = document.querySelector('[data-agent-card="dev-1"]') as HTMLElement;
    activate(devCard);
    expect(screen.getAllByTestId('pane-terminal')[0].getAttribute('data-mode')).toBe('full');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(screen.getAllByTestId('pane-terminal')[0].getAttribute('data-mode')).toBe('preview');
  });

  it('ignores Escape when focus is inside the active card (Esc goes to the terminal app, not the demote handler)', () => {
    renderTeam([], { terminalMode: 'embedded-full' });

    const devCard = document.querySelector('[data-agent-card="dev-1"]') as HTMLElement;
    activate(devCard);
    expect(devCard.className).toContain('ring-accent');

    const fakeFocus = document.createElement('input');
    devCard.appendChild(fakeFocus);
    fakeFocus.focus();
    expect(document.activeElement).toBe(fakeFocus);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(devCard.className).toContain('ring-accent');
  });

  it('activating a card in one team demotes the active card in another team', () => {
    render(
      <MemoryRouter>
        <ConfirmProvider>
        <div>
          <AgentTeam
            team={TEAM}
            projectId="proj"
            agentsById={new Map([
              ['dev-1', agent('dev-1')],
              ['qa-1', agent('qa-1')],
            ])}
            agentsLoaded
            tasks={[]}
            terminalMode="embedded-full"
          />
          <AgentTeam
            team={[
              { id: 'dev-2', runtime: 'claude-code', role: 'dev', mode: 'local' },
              { id: 'qa-2', runtime: 'codex', role: 'qa', mode: 'local' },
            ]}
            projectId="proj"
            agentsById={new Map([
              ['dev-2', agent('dev-2')],
              ['qa-2', agent('qa-2')],
            ])}
            agentsLoaded
            tasks={[]}
            terminalMode="embedded-full"
          />
        </div>
        </ConfirmProvider>
      </MemoryRouter>,
    );

    const dev1 = document.querySelector('[data-agent-card="dev-1"]') as HTMLElement;
    const dev2 = document.querySelector('[data-agent-card="dev-2"]') as HTMLElement;

    activate(dev1);
    expect(dev1.className).toContain('ring-accent');

    activate(dev2);
    expect(dev1.className).not.toContain('ring-accent');
    expect(dev2.className).toContain('ring-accent');
  });

  it('defers embedded terminals until agent snapshots are loaded', () => {
    renderTeam([], { agentsById: new Map(), agentsLoaded: false, terminalMode: 'embedded-full' });

    expect(screen.queryByTestId('pane-terminal')).toBeNull();
    expect(screen.getAllByText('Agent status loading')).toHaveLength(2);
  });

  it('claimable list: shows pending task assigned to dev with a Start button when no active task is bound', () => {
    renderTeam([task({ id: 'task-q', status: 'pending', preferredAgentId: 'dev-1', agentId: '' })]);
    const region = screen.getByRole('group', { name: 'Agent Team dev-1 / qa-1' });
    expect(within(region).getByText('task-q')).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Start' })).toBeTruthy();
  });

  it('claimable list: unassigned task (preferredAgentId="") shows "Unassigned" pill and is still claimable', () => {
    renderTeam([task({ id: 'task-u', status: 'pending', preferredAgentId: '', agentId: '' })]);
    const region = screen.getByRole('group', { name: 'Agent Team dev-1 / qa-1' });
    expect(within(region).getByText('task-u')).toBeTruthy();
    expect(within(region).getByText('Unassigned')).toBeTruthy();
  });

  it('claimable list: clicking Start calls api.tasks.advance with Dev and agentId=dev-1', async () => {
    tasksAdvanceMock.mockResolvedValue(makeTask({ id: 'task-d' }));
    renderTeam([task({ id: 'task-d', status: 'pending', preferredAgentId: 'dev-1', agentId: '' })]);

    const startBtn = screen.getByRole('button', { name: 'Start' });
    await act(async () => {
      fireEvent.click(startBtn);
    });

    expect(tasksAdvanceMock).toHaveBeenCalledWith('task-d', { executor: 'dev', agentId: 'dev-1' });
  });

  it('projectId filter: cross-project unassigned task does NOT appear in another project\'s claimable list', () => {
    renderTeam([
      task({ id: 'task-other', projectId: 'OTHER', status: 'pending', preferredAgentId: '', agentId: '' }),
    ]);
    const region = screen.getByRole('group', { name: 'Agent Team dev-1 / qa-1' });
    expect(within(region).queryByText('task-other')).toBeNull();
    expect(within(region).getByText('No active task')).toBeTruthy();
  });

  it('claimable list renders ALONGSIDE active task summary when dev is idle (post-approve / approved state)', () => {
    const activeApproved = task({ id: 'task-old', status: 'approved', preferredAgentId: 'dev-1', agentId: 'dev-1' });
    const pendingForDev = task({ id: 'task-new', status: 'pending', preferredAgentId: 'dev-1', agentId: '' });
    renderTeam([activeApproved, pendingForDev]);
    const region = screen.getByRole('group', { name: 'Agent Team dev-1 / qa-1' });
    expect(within(region).getByText('task-old')).toBeTruthy();
    expect(within(region).getByText('task-new')).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Start' })).toBeTruthy();
  });

  it('Start button is disabled when dev is not in idle runtimeStatus', () => {
    renderTeam(
      [task({ id: 'task-w', status: 'pending', preferredAgentId: 'dev-1', agentId: '' })],
      {
        agentsById: new Map([
          ['dev-1', { ...agent('dev-1'), runtimeStatus: 'working' as const }],
          ['qa-1', agent('qa-1')],
        ]),
      },
    );

    const btn = screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('claimable list renders ABOVE the active task summary so the in-progress task sits closer to the AgentCard', () => {
    const activeApproved = task({ id: 'task-old', status: 'approved', preferredAgentId: 'dev-1', agentId: 'dev-1' });
    const pendingForDev = task({ id: 'task-new', status: 'pending', preferredAgentId: 'dev-1', agentId: '' });
    renderTeam([activeApproved, pendingForDev]);
    const region = screen.getByRole('group', { name: 'Agent Team dev-1 / qa-1' });
    const claimable = within(region).getByRole('group', { name: /claimable tasks for dev-1/ });
    const activeRow = within(region).getByRole('button', { name: /task-old/ });
    expect(claimable.compareDocumentPosition(activeRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const claimableRow = within(claimable).getByText('task-new').closest('div')!;
    const paddingClasses = (className: string) => (className.match(/\bp[xy]?-\d+\b/g) ?? []).sort();
    const activePadding = paddingClasses(activeRow.className);
    const claimablePadding = paddingClasses(claimableRow.className);
    expect(activePadding.length).toBeGreaterThan(0);
    expect(claimablePadding).toEqual(activePadding);
  });

  it('claimable Start button is a plain text button (no btn-secondary frame) so single-task row height matches the active row', () => {
    renderTeam([task({ id: 'task-q', status: 'pending', preferredAgentId: 'dev-1', agentId: '' })]);
    const startBtn = screen.getByRole('button', { name: 'Start' });
    expect(startBtn.className).not.toContain('btn-secondary');
    expect(startBtn.className).not.toContain('border');
    expect(startBtn.className).toContain('text-accent');
  });

  it('claimable row does not paint a block hover background — hover affordance is text-color only', () => {
    renderTeam([task({ id: 'task-h', status: 'pending', preferredAgentId: 'dev-1', agentId: '' })]);
    const region = screen.getByRole('group', { name: 'Agent Team dev-1 / qa-1' });
    const claimable = within(region).getByRole('group', { name: /claimable tasks for dev-1/ });
    const rowButton = within(claimable).getByRole('button', { name: /task-h/ });
    expect(rowButton.className).not.toContain('hover:bg-');
    expect(rowButton.className).toContain('hover:text-accent-hover');
    expect(claimable.className).toContain('max-h-28');
  });

  it('keeps terminal entrypoints enabled when the agents stream has failed before loading', () => {
    renderTeam([], {
      agentsById: new Map(),
      agentsLoaded: false,
      agentsError: true,
      terminalMode: 'embedded-full',
    });

    expect(screen.getAllByTestId('pane-terminal')).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Terminal' }).map(link => link.getAttribute('href')))
      .toEqual(['/terminal/dev-1', '/terminal/qa-1']);
    expect(screen.queryByText('Agent status loading')).toBeNull();
  });
});
