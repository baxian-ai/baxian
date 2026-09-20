import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());
vi.mock('../../src/components/pane-terminal.tsx', async () => (await import('../helpers/pane-terminal-mock.tsx')).createPaneTerminalMock());

import { api } from '../../src/api.ts';
import { __resetProjectsCacheForTests } from '../../src/hooks/use-projects.ts';
import { Terminal } from '../../src/pages/terminal.tsx';

const projectsListMock = vi.mocked(api.projects.list);

beforeEach(() => {
  __resetProjectsCacheForTests();
  projectsListMock.mockReset();
});

describe('Terminal page', () => {
  it('renders the terminal without advertising Ctrl+Q detach', async () => {
    projectsListMock.mockResolvedValue([{
      id: 'proj',
      repo: 'https://github.com/owner/repo.git',
      merge: null,
      agent: [[{ id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' }]],
    }]);

    render(
      <MemoryRouter initialEntries={['/terminal/dev-1']}>
        <Routes>
          <Route path="/terminal/:agentId" element={<Terminal />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('dev-1').getAttribute('title')).toBe('dev-1 (Claude Code)'));
    expect(screen.queryByText(/Ctrl\+Q/i)).toBeNull();
    const terminal = screen.getByTestId('pane-terminal');
    expect(terminal.getAttribute('data-agent-id')).toBe('dev-1');
    expect(terminal.getAttribute('data-mode')).toBe('full');
    expect(terminal.getAttribute('data-interactive')).toBe('true');
    expect(terminal.getAttribute('data-arrow-keys')).toBe('true');
  });
});
