import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { useProjectsMock } = vi.hoisted(() => ({ useProjectsMock: vi.fn() }));

vi.mock('../../src/hooks/use-projects.ts', () => ({
  useProjects: useProjectsMock,
}));

vi.mock('../../src/components/pane-terminal.tsx', async () => (await import('../helpers/pane-terminal-mock.tsx')).createPaneTerminalMock());

import { Terminal } from '../../src/pages/terminal.tsx';

describe('Terminal page', () => {
  it('renders the terminal without advertising Ctrl+Q detach', () => {
    useProjectsMock.mockReturnValue({
      projects: [{
        id: 'proj',
        repo: 'owner/repo',
        merge: null,
        agent: [[{ id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' }]],
      }],
      error: null,
      refresh: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={['/terminal/dev-1']}>
        <Routes>
          <Route path="/terminal/:agentId" element={<Terminal />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('dev-1').getAttribute('title')).toBe('dev-1 (Claude Code)');
    expect(screen.queryByText(/Ctrl\+Q/i)).toBeNull();
    const terminal = screen.getByTestId('pane-terminal');
    expect(terminal.getAttribute('data-agent-id')).toBe('dev-1');
    expect(terminal.getAttribute('data-mode')).toBe('full');
    expect(terminal.getAttribute('data-interactive')).toBe('true');
    expect(terminal.getAttribute('data-arrow-keys')).toBe('true');
    const terminalPageFrame = screen.getByTestId('terminal-page-container');
    expect(terminalPageFrame.className).toContain('border');
    expect(terminalPageFrame.className).not.toContain('rounded');
  });
});
