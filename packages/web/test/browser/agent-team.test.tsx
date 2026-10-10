import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentTeam } from '../../src/components/agent-team.tsx';
import { ConfirmProvider } from '../../src/components/confirm-dialog.tsx';
import { ToastProvider } from '../../src/components/toast.tsx';
import { PendingRestartProvider } from '../../src/hooks/use-pending-restart.tsx';
import { enUS } from '../../src/i18n/en-us.ts';
import { zhCN } from '../../src/i18n/zh-cn.ts';
import { I18nProvider, syncLocaleFromConfig, __resetI18nForTests } from '../../src/i18n/index.tsx';
import { makeAgent, makeTask } from '../helpers/fixtures.ts';
import '../../src/index.css';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ startedAt: '2026-10-09T00:00:00Z' })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetI18nForTests();
});

describe('AgentTeam background in Chromium', () => {
  it.each([
    ['empty', 'en-US', enUS],
    ['active', 'en-US', enUS],
    ['empty', 'zh-CN', zhCN],
    ['active', 'zh-CN', zhCN],
  ] as const)('renders a localized %s panel in %s with a light background', async (state, locale, t) => {
    syncLocaleFromConfig(locale);
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

    const panel = screen.getByRole('group', { name: t.agents.teamLabel('dev-1 / qa-1') });
    expect(screen.getByText('Agent Team')).toBeTruthy();
    expect(screen.getByText('Dev agent')).toBeTruthy();
    expect(screen.getByText('QA agent')).toBeTruthy();
    expect(getComputedStyle(panel).backgroundColor).toBe('rgba(241, 242, 244, 0.6)');
  });
});
