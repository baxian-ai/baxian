import { enUS } from '../../src/i18n/en-us.ts';
import { it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentConfig, BaxianConfig, ProjectConfig } from '../../src/shared/index.js';

vi.mock('../../src/hooks/use-pending-restart.tsx', async () => (await import('../helpers/pending-restart-mock.tsx')).createPendingRestartMock());
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { CreateAgentModal } from '../../src/components/create-agent-modal.tsx';
import { ToastProvider } from '../../src/components/toast.tsx';
import { flagDirtyMock } from '../helpers/pending-restart-mock.tsx';
import { expectToast } from '../helpers/toast.tsx';
import { makeRuntimes } from '../helpers/fixtures.ts';

const configGetMock = vi.mocked(api.config.get);
const probeMock = vi.mocked(api.agents.probe);
const installTmuxMock = vi.mocked(api.agents.installTmux);
const addAgentTeamMock = vi.mocked(api.projects.addAgentTeam);

function cfg(hosts: BaxianConfig['host']): BaxianConfig {
  return {
    review: { rounds: 10 },
    server: { port: 3000 },
    host: hosts,
    project: [{ id: 'baxian', repo: 'https://github.com/o/r.git', merge: null, agent: [] }],
  };
}

beforeEach(() => {
  configGetMock.mockReset();
  probeMock.mockReset().mockResolvedValue({
    ssh: { ok: true, message: 'SSH OK' },
    tmux: { ok: true, message: 'tmux' },
    runtimes: makeRuntimes(),
  });
  installTmuxMock.mockReset().mockResolvedValue({
    ok: true,
    method: 'apt-get',
    version: '3.4',
    message: 'tmux 3.4 installed via apt-get',
    tmux: { ok: true, path: '/usr/bin/tmux', message: 'tmux found' },
  });
  addAgentTeamMock.mockReset().mockResolvedValue({
    agents: [
      { id: 'dev-new', runtime: 'claude-code', role: 'dev', mode: 'local' },
      { id: 'qa-new', runtime: 'codex', role: 'qa', mode: 'local' },
    ],
    restartRequired: false,
  });
  flagDirtyMock.mockReset();
});

function cfgWithAgents(agent: ProjectConfig['agent']): BaxianConfig {
  return {
    review: { rounds: 10 },
    server: { port: 3000 },
    host: [],
    project: [{ id: 'baxian', repo: 'https://github.com/o/r.git', merge: null, agent }],
  };
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: name => [enUS.createAgent.continueLabel, enUS.createAgent.submitLabel, enUS.createAgent.submitting].includes(name) }) as HTMLButtonElement;
}

async function renderReady(config?: BaxianConfig): Promise<{ onClose: ReturnType<typeof vi.fn>; onCreated: ReturnType<typeof vi.fn> }> {
  configGetMock.mockResolvedValue(config ?? cfg([]));
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(<CreateAgentModal open projectId="baxian" onClose={onClose} onCreated={onCreated} />, { wrapper: ToastProvider });
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  return { onClose, onCreated };
}

async function fillValidForm(id: string, runtime: 'Claude Code' | 'Codex' = 'Claude Code'): Promise<void> {
  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: id } });
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(runtime) }));
  await waitFor(() => expect(submitButton().disabled).toBe(false));
}

async function continueWithDev(id = 'dev-new'): Promise<void> {
  await fillValidForm(id);
  fireEvent.click(submitButton());
  expect(addAgentTeamMock).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByText(enUS.createAgent.qaStepLabel)).toBeTruthy());
}

it('remote mode shows a host picker (not a raw hostname input)', async () => {
  configGetMock.mockResolvedValue(cfg([{ id: 'box', hostname: 'h.example.com', port: 2222, alias: 'Prod', user: 'agent' }]));
  render(<CreateAgentModal open projectId="baxian" onClose={() => {}} onCreated={() => {}} />, { wrapper: ToastProvider });
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());

  fireEvent.click(screen.getByRole('radio', { name: enUS.createAgent.remoteModeLabel }));

  expect(await screen.findByLabelText('Host')).toBeTruthy();
  expect(screen.getByText('Prod')).toBeTruthy();
  expect(screen.queryByLabelText('Hostname')).toBeNull();
});

it('guides the user to manage hosts when no hosts are configured', async () => {
  configGetMock.mockResolvedValue(cfg([]));
  render(<CreateAgentModal open projectId="baxian" onClose={() => {}} onCreated={() => {}} />, { wrapper: ToastProvider });
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('radio', { name: enUS.createAgent.remoteModeLabel }));
  expect(await screen.findByText(enUS.createAgent.noHostsHint)).toBeTruthy();
});

it('probes by host id (resolved server-side) once a host is selected', async () => {
  configGetMock.mockResolvedValue(cfg([{ id: 'box', hostname: 'h.example.com', port: 22, user: 'agent' }]));
  render(<CreateAgentModal open projectId="baxian" onClose={() => {}} onCreated={() => {}} />, { wrapper: ToastProvider });
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('radio', { name: enUS.createAgent.remoteModeLabel }));
  fireEvent.change(await screen.findByLabelText('Host'), { target: { value: 'box' } });

  await waitFor(() => expect(probeMock).toHaveBeenCalledWith('remote', { hostId: 'box' }, expect.anything()));
});

it('hides Workdir/Model/Additional Dirs behind a collapsed Advanced options toggle', async () => {
  configGetMock.mockResolvedValue(cfg([]));
  render(<CreateAgentModal open projectId="baxian" onClose={() => {}} onCreated={() => {}} />, { wrapper: ToastProvider });
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());

  const toggle = screen.getByRole('button', { name: name => name.includes(enUS.createAgent.advancedOptionsLabel) });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-controls')).toBeNull();
  expect(document.getElementById('advanced-options')).toBeNull();
  expect(screen.queryByLabelText(enUS.createAgent.workdirLabel)).toBeNull();
  expect(screen.queryByLabelText(enUS.createAgent.modelLabel)).toBeNull();
  expect(screen.queryByLabelText(enUS.createAgent.addDirsLabel)).toBeNull();

  fireEvent.click(toggle);

  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.getAttribute('aria-controls')).toBe('advanced-options');
  expect(document.getElementById('advanced-options')).toBeTruthy();
  expect(screen.getByLabelText(enUS.createAgent.workdirLabel)).toBeTruthy();
  expect(screen.getByText(enUS.createAgent.workdirHint)).toBeTruthy();
  expect(screen.getByLabelText(enUS.createAgent.modelLabel)).toBeTruthy();
  expect(screen.getByLabelText(enUS.createAgent.addDirsLabel)).toBeTruthy();

  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-controls')).toBeNull();
  expect(screen.queryByLabelText(enUS.createAgent.workdirLabel)).toBeNull();
});

it('collects a complete Dev + QA team and submits it once', async () => {
  const { onClose, onCreated } = await renderReady();
  await continueWithDev('dev-new');
  await fillValidForm('qa-new', 'Codex');

  await act(async () => {
    fireEvent.click(submitButton());
  });

  expect(addAgentTeamMock).toHaveBeenCalledTimes(1);
  expect(addAgentTeamMock).toHaveBeenCalledWith('baxian', {
    agents: [
      {
        id: 'dev-new',
        role: 'dev',
        runtime: 'claude-code',
        mode: 'local',
        yolo: true,
      },
      {
        id: 'qa-new',
        role: 'qa',
        runtime: 'codex',
        mode: 'local',
        yolo: true,
      },
    ],
  });
  await expectToast({
    title: enUS.createAgent.addedToastTitle('dev-new', 'qa-new', 'baxian'),
  });
  expect(onCreated).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(flagDirtyMock).not.toHaveBeenCalled();
});

it('flags a pending server restart when the API reports restartRequired', async () => {
  addAgentTeamMock.mockResolvedValue({
    agents: [
      { id: 'dev-new', runtime: 'claude-code', role: 'dev', mode: 'local' },
      { id: 'qa-new', runtime: 'codex', role: 'qa', mode: 'local' },
    ],
    restartRequired: true,
    warnings: ['in-memory config switch failed after disk commit; restart the server'],
  });
  await renderReady();
  await continueWithDev();
  await fillValidForm('qa-new', 'Codex');

  await act(async () => {
    fireEvent.click(submitButton());
  });

  expect(flagDirtyMock).toHaveBeenCalledTimes(1);
  await expectToast({
    title: enUS.createAgent.addedToastTitle('dev-new', 'qa-new', 'baxian'),
    body: 'in-memory config switch failed after disk commit; restart the server',
  });
});

it('surfaces post-commit initialization warnings without flagging a restart', async () => {
  addAgentTeamMock.mockResolvedValue({
    agents: [
      { id: 'dev-new', runtime: 'claude-code', role: 'dev', mode: 'local' },
      { id: 'qa-new', runtime: 'codex', role: 'qa', mode: 'local' },
    ],
    restartRequired: false,
    warnings: [
      'agent qa-new state initialization failed after config commit: disk full',
      'bootstrap will retry',
    ],
  });
  await renderReady();
  await continueWithDev();
  await fillValidForm('qa-new', 'Codex');

  await act(async () => {
    fireEvent.click(submitButton());
  });

  expect(flagDirtyMock).not.toHaveBeenCalled();
  await expectToast({
    title: enUS.createAgent.addedToastTitle('dev-new', 'qa-new', 'baxian'),
    body: 'agent qa-new state initialization failed after config commit: disk full\nbootstrap will retry',
  });
});

it('trims the QA advanced options before submitting the complete team', async () => {
  await renderReady();
  await continueWithDev('dev-a');
  await fillValidForm('qa-a', 'Codex');
  fireEvent.click(screen.getByRole('button', { name: name => name.includes(enUS.createAgent.advancedOptionsLabel) }));
  fireEvent.change(screen.getByLabelText(enUS.createAgent.workdirLabel), { target: { value: '/tmp/qa-wd' } });
  fireEvent.change(screen.getByLabelText(enUS.createAgent.modelLabel), { target: { value: '  o3  ' } });
  fireEvent.change(screen.getByLabelText(enUS.createAgent.addDirsLabel), { target: { value: ' /a \n\n/b\n   ' } });
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(submitButton().disabled).toBe(false));

  await act(async () => {
    fireEvent.click(submitButton());
  });

  expect(addAgentTeamMock).toHaveBeenCalledWith('baxian', {
    agents: [
      {
        id: 'dev-a',
        role: 'dev',
        runtime: 'claude-code',
        mode: 'local',
        yolo: true,
      },
      {
        id: 'qa-a',
        role: 'qa',
        runtime: 'codex',
        mode: 'local',
        workdir: '/tmp/qa-wd',
        yolo: false,
        model: 'o3',
        addDirs: ['/a', '/b'],
      },
    ],
  });
});

it('Back restores the Dev draft without mutating the server', async () => {
  await renderReady();
  expect((screen.getByLabelText('Agent ID') as HTMLInputElement).placeholder)
    .toBe(enUS.createAgent.idPlaceholder('baxian', 'dev'));
  await continueWithDev('dev-back');
  expect((screen.getByLabelText('Agent ID') as HTMLInputElement).placeholder)
    .toBe(enUS.createAgent.idPlaceholder('baxian', 'qa'));
  expect(screen.getByText(enUS.createAgent.teamDevLabel('dev-back'))).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: enUS.common.back }));

  expect(screen.getByText(enUS.createAgent.devStepLabel)).toBeTruthy();
  expect((screen.getByLabelText('Agent ID') as HTMLInputElement).value).toBe('dev-back');
  expect((screen.getByLabelText('Agent ID') as HTMLInputElement).placeholder)
    .toBe(enUS.createAgent.idPlaceholder('baxian', 'dev'));
  expect(addAgentTeamMock).not.toHaveBeenCalled();
});

it('keeps the modal open after creation fails and allows correcting the form and retrying', async () => {
  addAgentTeamMock.mockRejectedValue(new Error('id already used\nsomewhere else'));
  const { onClose, onCreated } = await renderReady();
  await continueWithDev();
  await fillValidForm('qa-new', 'Codex');

  await act(async () => {
    fireEvent.click(submitButton());
  });

  const banner = screen.getByText(/id already used/);
  expect(banner.textContent).toBe('id already used\nsomewhere else');
  expect(banner.classList.contains('whitespace-pre-line')).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  expect(onCreated).not.toHaveBeenCalled();
  expect(submitButton().disabled).toBe(false);

  addAgentTeamMock.mockResolvedValueOnce({
    agents: [
      { id: 'dev-new', role: 'dev', runtime: 'claude-code', mode: 'local' },
      { id: 'qa-retry', role: 'qa', runtime: 'codex', mode: 'local' },
    ],
    restartRequired: false,
  });
  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'qa-retry' } });
  await act(async () => { fireEvent.click(submitButton()); });

  expect(addAgentTeamMock).toHaveBeenCalledTimes(2);
  expect(addAgentTeamMock).toHaveBeenLastCalledWith('baxian', {
    agents: [
      expect.objectContaining({ id: 'dev-new', role: 'dev' }),
      expect.objectContaining({ id: 'qa-retry', role: 'qa' }),
    ],
  });
  expect(onCreated).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('Cancel closes the modal, but dismissal is blocked while a submit is in flight', async () => {
  let resolveAdd: ((value: { agents: AgentConfig[]; restartRequired: boolean }) => void) | undefined;
  addAgentTeamMock.mockReturnValue(new Promise((resolve) => { resolveAdd = resolve; }));
  const { onClose } = await renderReady();
  await continueWithDev();
  await fillValidForm('qa-new', 'Codex');

  fireEvent.click(screen.getByRole('button', { name: enUS.common.cancel }));
  expect(onClose).toHaveBeenCalledTimes(1);

  await act(async () => {
    fireEvent.click(submitButton());
  });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveAdd?.({
      agents: [
        { id: 'dev-new', runtime: 'claude-code', role: 'dev', mode: 'local' },
        { id: 'qa-new', runtime: 'codex', role: 'qa', mode: 'local' },
      ],
      restartRequired: false,
    });
  });
});

it('shows the probe error and blocks submission when probing fails', async () => {
  probeMock.mockRejectedValue(new Error('probe exploded'));
  await renderReady();

  expect(await screen.findByText('probe exploded')).toBeTruthy();
  expect(screen.getAllByText('?')).toHaveLength(4);

  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'kk-cc' } });
  fireEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
  expect(submitButton().disabled).toBe(true);
});

it('marks an unavailable runtime with the probe message and disables its radio', async () => {
  probeMock.mockResolvedValue({
    tmux: { ok: true, path: '/usr/bin/tmux', message: 'tmux ok' },
    runtimes: makeRuntimes({
      'claude-code': { ok: false, message: 'claude-code not found' },
      codex: { ok: true, path: '/usr/local/bin/codex', message: '' },
    }),
  });
  await renderReady();

  expect(await screen.findByText('⨯ claude-code not found')).toBeTruthy();
  expect((screen.getByRole('radio', { name: /Claude Code/ }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('radio', { name: /Codex/ }) as HTMLInputElement).disabled).toBe(false);
  expect(screen.getByText('✓ /usr/local/bin/codex')).toBeTruthy();
  expect(screen.getByText('tmux: ✓ /usr/bin/tmux')).toBeTruthy();
});

it('shows a tmux probe failure', async () => {
  probeMock.mockResolvedValue({
    tmux: { ok: false, message: 'tmux missing' },
    runtimes: makeRuntimes(),
  });
  await renderReady();

  expect(await screen.findByText('tmux: ⨯ tmux missing')).toBeTruthy();
});

it('shows an SSH probe failure for remote hosts and clears it when switching back to Local', async () => {
  probeMock.mockResolvedValue({
    ssh: { ok: false, message: 'auth failed' },
    tmux: { ok: true, message: '' },
    runtimes: makeRuntimes(),
  });
  await renderReady(cfg([{ id: 'box', hostname: 'h.example.com' }]));

  fireEvent.click(screen.getByRole('radio', { name: enUS.createAgent.remoteModeLabel }));
  fireEvent.change(await screen.findByLabelText('Host'), { target: { value: 'box' } });
  expect(await screen.findByText('SSH: ⨯ auth failed')).toBeTruthy();

  fireEvent.click(screen.getByRole('radio', { name: enUS.createAgent.localModeLabel }));
  await waitFor(() => expect(screen.queryByText('SSH: ⨯ auth failed')).toBeNull());
});

it('renders installed runtime and tmux probe results with a ✓ and the resolved path', async () => {
  probeMock.mockResolvedValue({
    tmux: { ok: true, path: '/usr/bin/tmux', message: 'tmux found' },
    runtimes: makeRuntimes({
      'claude-code': { ok: true, path: '/usr/local/bin/claude', message: '' },
      codex: { ok: true, path: '/usr/local/bin/codex', message: '' },
    }),
  });
  await renderReady();

  expect(await screen.findByText('✓ /usr/local/bin/claude')).toBeTruthy();
  expect(screen.getByText('✓ /usr/local/bin/codex')).toBeTruthy();
  expect(screen.getByText('tmux: ✓ /usr/bin/tmux')).toBeTruthy();
});

it('renders the SSH ✓ line and the tmux install success message', async () => {
  probeMock.mockResolvedValue({ ssh: { ok: true, message: 'SSH OK' }, ...TMUX_MISSING });
  await renderReady(cfg([{ id: 'box', hostname: 'h.example.com' }]));

  fireEvent.click(screen.getByRole('radio', { name: enUS.createAgent.remoteModeLabel }));
  fireEvent.change(await screen.findByLabelText('Host'), { target: { value: 'box' } });
  expect(await screen.findByText('SSH: ✓ SSH OK')).toBeTruthy();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: enUS.common.oneClickInstall }));
  });

  expect(await screen.findByText(/tmux 3.4 installed via apt-get/)).toBeTruthy();
});

it('describes YOLO by the selected runtime real launch flag instead of explaining the mode', async () => {
  await renderReady();

  expect(screen.getByText('--permission-mode bypassPermissions')).toBeTruthy();

  fireEvent.click(screen.getByRole('radio', { name: /Codex/ }));
  expect(screen.getByText('--dangerously-bypass-approvals-and-sandbox')).toBeTruthy();

  fireEvent.click(screen.getByRole('radio', { name: /OpenCode/ }));
  expect(screen.getByText('--auto')).toBeTruthy();

  fireEvent.click(screen.getByRole('radio', { name: /Qoder CLI/ }));
  expect(screen.getByText('--dangerously-skip-permissions')).toBeTruthy();

  expect(screen.queryByText(/without asking for confirmation|controlled environment/)).toBeNull();
});

it('validates the agent id format and global uniqueness', async () => {
  const dev: AgentConfig = { id: 'dev-a', runtime: 'claude-code', role: 'dev', mode: 'local' };
  const qa: AgentConfig = { id: 'qa-a', runtime: 'codex', role: 'qa', mode: 'local' };
  await renderReady(cfgWithAgents([[dev, qa]]));
  fireEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
  await waitFor(() => expect(probeMock).toHaveBeenCalled());

  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: '1bad' } });
  expect(screen.getByText(enUS.common.idFormatError)).toBeTruthy();
  await waitFor(() => expect(submitButton().disabled).toBe(true));

  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'dev-a' } });
  expect(screen.getByText(enUS.createAgent.idTakenGlobalError)).toBeTruthy();
  expect(submitButton().disabled).toBe(true);
});

it('rejects a QA id that duplicates the Dev draft id', async () => {
  await renderReady();
  await continueWithDev('same-id');

  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'same-id' } });

  expect(screen.getByText(enUS.createAgent.idTakenGlobalError)).toBeTruthy();
  expect(submitButton().disabled).toBe(true);
  expect(addAgentTeamMock).not.toHaveBeenCalled();
});

it('Re-probe re-runs the probe on demand', async () => {
  await renderReady();
  await waitFor(() => expect(probeMock).toHaveBeenCalledTimes(1));

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: enUS.createAgent.reprobeButton }));
  });

  expect(probeMock).toHaveBeenCalledTimes(2);
});

const TMUX_MISSING = {
  tmux: { ok: false, message: '请安装 tmux' },
  runtimes: makeRuntimes(),
};

it('offers a one-click install when tmux is missing; success re-probes and flips the status to ✓', async () => {
  probeMock
    .mockResolvedValueOnce(TMUX_MISSING)
    .mockResolvedValueOnce({
      tmux: { ok: true, path: '/usr/bin/tmux', message: 'tmux found' },
      runtimes: makeRuntimes(),
    });
  await renderReady();

  expect(await screen.findByText(/tmux: ⨯ 请安装 tmux/)).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: enUS.common.oneClickInstall }));
  });

  expect(installTmuxMock).toHaveBeenCalledWith('local', {});
  await waitFor(() => expect(probeMock).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('tmux: ✓ /usr/bin/tmux')).toBeTruthy();
});

it('does not render the one-click install button when tmux is already present', async () => {
  await renderReady();
  expect(await screen.findByText(/tmux: ✓/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: enUS.common.oneClickInstall })).toBeNull();
});

it('targets the selected host when installing from remote mode', async () => {
  probeMock.mockResolvedValue({ ssh: { ok: true, message: 'SSH OK' }, ...TMUX_MISSING });
  await renderReady(cfg([{ id: 'box', hostname: 'h.example.com' }]));

  fireEvent.click(screen.getByRole('radio', { name: enUS.createAgent.remoteModeLabel }));
  fireEvent.change(await screen.findByLabelText('Host'), { target: { value: 'box' } });
  expect(await screen.findByText(/tmux: ⨯/)).toBeTruthy();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: enUS.common.oneClickInstall }));
  });

  expect(installTmuxMock).toHaveBeenCalledWith('remote', { hostId: 'box' });
});

it('hides the one-click install button when remote SSH is unreachable (tmux state is unknowable)', async () => {
  probeMock.mockResolvedValue({
    ssh: { ok: false, message: 'SSH 不通，请检查地址 / 端口 / 密码或 key 认证' },
    tmux: { ok: false, message: 'SSH 不通，无法探测' },
    runtimes: makeRuntimes({}, { ok: false, message: 'SSH 不通，无法探测' }),
  });
  await renderReady(cfg([{ id: 'box', hostname: 'h.example.com' }]));

  fireEvent.click(screen.getByRole('radio', { name: enUS.createAgent.remoteModeLabel }));
  fireEvent.change(await screen.findByLabelText('Host'), { target: { value: 'box' } });

  expect(await screen.findByText(/tmux: ⨯ SSH 不通，无法探测/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: enUS.common.oneClickInstall })).toBeNull();
});

it('shows the install failure message with the manual command and does not re-probe', async () => {
  probeMock.mockResolvedValue(TMUX_MISSING);
  installTmuxMock.mockResolvedValue({
    ok: false,
    method: 'apt-get',
    message: 'cannot install automatically: not root and passwordless sudo is unavailable — run "sudo apt-get install -y tmux" on the host',
    tmux: { ok: false, message: '请安装 tmux' },
  });
  await renderReady();

  expect(await screen.findByText(/tmux: ⨯/)).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: enUS.common.oneClickInstall }));
  });

  expect(await screen.findByText(/⨯ cannot install automatically.*sudo apt-get install -y tmux/)).toBeTruthy();
  expect(probeMock).toHaveBeenCalledTimes(1);
});

it('shows a loading hint while installing and ignores repeated clicks', async () => {
  probeMock.mockResolvedValueOnce(TMUX_MISSING);
  let resolveInstall: ((value: Awaited<ReturnType<typeof api.agents.installTmux>>) => void) | undefined;
  installTmuxMock.mockReturnValue(new Promise((resolve) => { resolveInstall = resolve; }));
  await renderReady();

  expect(await screen.findByText(/tmux: ⨯/)).toBeTruthy();
  const install = () => screen.getByRole('button', { name: name => [enUS.common.oneClickInstall, enUS.common.installing].some(label => name.includes(label)) });
  fireEvent.click(install());

  expect(await screen.findByText(enUS.common.installingTmuxNotice)).toBeTruthy();
  expect((install() as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(install());
  fireEvent.click(install());
  expect(installTmuxMock).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveInstall?.({
      ok: true,
      method: 'brew',
      version: '3.5',
      message: 'tmux 3.5 installed via brew',
      tmux: { ok: true, path: '/opt/homebrew/bin/tmux', message: 'tmux found' },
    });
  });
  await waitFor(() => expect(probeMock).toHaveBeenCalledTimes(2));
});

it('aborts the in-flight probe controller when the modal closes', async () => {
  configGetMock.mockResolvedValue(cfg([]));
  const { rerender } = render(<CreateAgentModal open projectId="baxian" onClose={() => {}} onCreated={() => {}} />, { wrapper: ToastProvider });
  await waitFor(() => expect(probeMock).toHaveBeenCalled());
  const options = probeMock.mock.calls[0][2];
  expect(options?.signal?.aborted).toBe(false);

  rerender(<CreateAgentModal open={false} projectId="baxian" onClose={() => {}} onCreated={() => {}} />);

  expect(options?.signal?.aborted).toBe(true);
});
