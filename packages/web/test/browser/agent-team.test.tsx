import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentTeam } from '../../src/components/agent-team.tsx';
import { ConfirmProvider } from '../../src/components/confirm-dialog.tsx';
import { ToastProvider } from '../../src/components/toast.tsx';
import { PendingRestartProvider } from '../../src/hooks/use-pending-restart.tsx';
import { I18nProvider } from '../../src/i18n/index.tsx';
import { makeAgent, makeTask } from '../helpers/fixtures.ts';
import '../../src/index.css';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ startedAt: '2026-10-09T00:00:00Z' })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AgentTeam background in Chromium', () => {
  it.each(['empty', 'active'])('keeps the %s panel background light and translucent', async state => {
    await act(async () => {
      render(
        <MemoryRouter>
          <I18nProvider>
            <PendingRestartProvider>
              <ToastProvider>
                <ConfirmProvider>
                  <AgentTeam
                    projectId="proj"
                    team={[
                      { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' },
                      { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local' },
                    ]}
                    agentsById={new Map([['dev-1', makeAgent('dev-1')], ['qa-1', makeAgent('qa-1')]])}
                    agentsLoaded
                    tasks={state === 'active' ? [makeTask({ status: 'in_progress' })] : []}
                  />
                </ConfirmProvider>
              </ToastProvider>
            </PendingRestartProvider>
          </I18nProvider>
        </MemoryRouter>,
      );
    });

    const panel = screen.getByRole('group', { name: 'Agent Team dev-1 / qa-1' });
    expect(getComputedStyle(panel).backgroundColor).toBe('rgba(241, 242, 244, 0.6)');
  });
});
