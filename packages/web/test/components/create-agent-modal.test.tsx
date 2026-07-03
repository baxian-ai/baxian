import { it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentConfig, BaxianConfig, ProjectConfig } from '../../src/shared/index.js';

vi.mock('../../src/components/toast.tsx', async () => (await import('../helpers/toast-mock.tsx')).createToastMock());
vi.mock('../../src/hooks/use-pending-restart.tsx', async () => (await import('../helpers/pending-restart-mock.tsx')).createPendingRestartMock());
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { CreateAgentModal } from '../../src/components/create-agent-modal.tsx';
import { flagDirtyMock } from '../helpers/pending-restart-mock.tsx';
import { toastShowMock } from '../helpers/toast-mock.tsx';

const configGetMock = vi.mocked(api.config.get);
const probeMock = vi.mocked(api.agents.probe);
const addAgentMock = vi.mocked(api.projects.addAgent);

function cfg(hosts: BaxianConfig['host']): BaxianConfig {
  return {
    review: { rounds: 10 },
    server: { port: 3000 },
    host: hosts,
    project: [{ id: 'baxian', repo: 'o/r', merge: null, agent: [] }],
  };
}

beforeEach(() => {
  configGetMock.mockReset();
  probeMock.mockReset().mockResolvedValue({
    ssh: { ok: true, message: 'SSH OK' },
    tmux: { ok: true, message: 'tmux' },
    runtimes: { 'claude-code': { ok: true, message: '' }, codex: { ok: true, message: '' } },
  });
  addAgentMock.mockReset().mockResolvedValue({
    agent: { id: 'x', runtime: 'claude-code', role: 'dev', mode: 'local' },
    restartRequired: false,
  });
  toastShowMock.mockReset();
  flagDirtyMock.mockReset();
});

function cfgWithAgents(agent: ProjectConfig['agent']): BaxianConfig {
  return {
    review: { rounds: 10 },
    server: { port: 3000 },
    host: [],
    project: [{ id: 'baxian', repo: 'o/r', merge: null, agent }],
  };
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /添加 Agent|添加中/ }) as HTMLButtonElement;
}

async function renderReady(config?: BaxianConfig): Promise<{ onClose: ReturnType<typeof vi.fn>; onCreated: ReturnType<typeof vi.fn> }> {
  configGetMock.mockResolvedValue(config ?? cfg([]));
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(<CreateAgentModal open projectId="baxian" onClose={onClose} onCreated={onCreated} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  return { onClose, onCreated };
}

async function fillValidDevForm(id = 'kk-cc'): Promise<void> {
  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: id } });
  fireEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
  await waitFor(() => expect(submitButton().disabled).toBe(false));
}

it('remote mode shows a host picker (not a raw hostname input)', async () => {
  configGetMock.mockResolvedValue(cfg([{ id: 'box', hostname: 'h.example.com', port: 2222, alias: 'Prod', user: 'agent' }]));
  render(<CreateAgentModal open projectId="baxian" onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());

  fireEvent.click(screen.getByRole('radio', { name: /远程/ }));

  expect(await screen.findByLabelText('Host')).toBeTruthy();
  expect(screen.getByText('Prod')).toBeTruthy();
  expect(screen.queryByLabelText('Hostname')).toBeNull();
});

it('guides the user to Host 管理 when no hosts are configured', async () => {
  configGetMock.mockResolvedValue(cfg([]));
  render(<CreateAgentModal open projectId="baxian" onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('radio', { name: /远程/ }));
  expect(await screen.findByText(/还没有配置 Host/)).toBeTruthy();
});

it('probes by host id (resolved server-side) once a host is selected', async () => {
  configGetMock.mockResolvedValue(cfg([{ id: 'box', hostname: 'h.example.com', port: 22, user: 'agent' }]));
  render(<CreateAgentModal open projectId="baxian" onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('radio', { name: /远程/ }));
  fireEvent.change(await screen.findByLabelText('Host'), { target: { value: 'box' } });

  await waitFor(() => expect(probeMock).toHaveBeenCalledWith('remote', { hostId: 'box' }, expect.anything()));
});

it('hides Workdir/Model/Additional Dirs behind a collapsed 高级选项 toggle', async () => {
  configGetMock.mockResolvedValue(cfg([]));
  render(<CreateAgentModal open projectId="baxian" onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());

  const toggle = screen.getByRole('button', { name: /高级选项/ });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-controls')).toBeNull();
  expect(document.getElementById('advanced-options')).toBeNull();
  expect(screen.queryByLabelText(/Workdir/)).toBeNull();
  expect(screen.queryByLabelText(/Model/)).toBeNull();
  expect(screen.queryByLabelText(/Additional Dirs/)).toBeNull();

  fireEvent.click(toggle);

  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.getAttribute('aria-controls')).toBe('advanced-options');
  expect(document.getElementById('advanced-options')).toBeTruthy();
  expect(screen.getByLabelText(/Workdir/)).toBeTruthy();
  expect(screen.getByLabelText(/Model/)).toBeTruthy();
  expect(screen.getByLabelText(/Additional Dirs/)).toBeTruthy();

  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-controls')).toBeNull();
  expect(screen.queryByLabelText(/Workdir/)).toBeNull();
});

it('submits a minimal local dev agent and closes on success', async () => {
  const { onClose, onCreated } = await renderReady();
  await fillValidDevForm();

  await act(async () => {
    fireEvent.click(submitButton());
  });

  expect(addAgentMock).toHaveBeenCalledWith('baxian', {
    id: 'kk-cc',
    role: 'dev',
    runtime: 'claude-code',
    mode: 'local',
    yolo: true,
  });
  expect(toastShowMock).toHaveBeenCalledWith({ kind: 'success', title: 'Agent x 已添加到 baxian' });
  expect(onCreated).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(flagDirtyMock).not.toHaveBeenCalled();
});

it('flags a pending server restart when the API reports restartRequired', async () => {
  addAgentMock.mockResolvedValue({
    agent: { id: 'kk-cc', runtime: 'claude-code', role: 'dev', mode: 'local' },
    restartRequired: true,
  });
  await renderReady();
  await fillValidDevForm();

  await act(async () => {
    fireEvent.click(submitButton());
  });

  expect(flagDirtyMock).toHaveBeenCalledTimes(1);
});

it('submits a QA agent paired with an unpaired dev, with trimmed advanced options', async () => {
  const dev: AgentConfig = { id: 'dev-a', runtime: 'claude-code', role: 'dev', mode: 'local' };
  await renderReady(cfgWithAgents([[dev]]));

  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'qa-a' } });
  fireEvent.click(screen.getByRole('radio', { name: 'QA' }));
  fireEvent.change(await screen.findByLabelText('配对 Dev Agent'), { target: { value: 'dev-a' } });
  fireEvent.click(screen.getByRole('radio', { name: /Codex/ }));
  fireEvent.click(screen.getByRole('button', { name: /高级选项/ }));
  fireEvent.change(screen.getByLabelText(/Workdir/), { target: { value: '/tmp/qa-wd' } });
  fireEvent.change(screen.getByLabelText(/Model/), { target: { value: '  o3  ' } });
  fireEvent.change(screen.getByLabelText(/Additional Dirs/), { target: { value: ' /a \n\n/b\n   ' } });
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(submitButton().disabled).toBe(false));

  await act(async () => {
    fireEvent.click(submitButton());
  });

  expect(addAgentMock).toHaveBeenCalledWith('baxian', {
    id: 'qa-a',
    role: 'qa',
    runtime: 'codex',
    mode: 'local',
    workdir: '/tmp/qa-wd',
    yolo: false,
    model: 'o3',
    addDirs: ['/a', '/b'],
    pairWith: 'dev-a',
  });
});

it('keeps the QA radio disabled when the project has no unpaired dev', async () => {
  await renderReady();
  expect((screen.getByRole('radio', { name: 'QA' }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByLabelText('配对 Dev Agent')).toBeNull();
});

it('surfaces an addAgent failure inline and keeps the modal open', async () => {
  addAgentMock.mockRejectedValue(new Error('id already used somewhere'));
  const { onClose, onCreated } = await renderReady();
  await fillValidDevForm();

  await act(async () => {
    fireEvent.click(submitButton());
  });

  expect(screen.getByText('id already used somewhere')).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  expect(onCreated).not.toHaveBeenCalled();
  expect(submitButton().textContent).toBe('添加 Agent');
});

it('取消 closes the modal, but dismissal is blocked while a submit is in flight', async () => {
  let resolveAdd: ((value: { agent: AgentConfig; restartRequired: boolean }) => void) | undefined;
  addAgentMock.mockReturnValue(new Promise((resolve) => { resolveAdd = resolve; }));
  const { onClose } = await renderReady();
  await fillValidDevForm();

  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(onClose).toHaveBeenCalledTimes(1);

  await act(async () => {
    fireEvent.click(submitButton());
  });
  expect(submitButton().textContent).toBe('添加中…');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveAdd?.({ agent: { id: 'kk-cc', runtime: 'claude-code', role: 'dev', mode: 'local' }, restartRequired: false });
  });
});

it('shows the probe error and blocks submission when probing fails', async () => {
  probeMock.mockRejectedValue(new Error('probe exploded'));
  await renderReady();

  expect(await screen.findByText('probe exploded')).toBeTruthy();
  expect(screen.getAllByText('?')).toHaveLength(2);

  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'kk-cc' } });
  fireEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
  expect(submitButton().disabled).toBe(true);
});

it('marks an unavailable runtime with the probe message and disables its radio', async () => {
  probeMock.mockResolvedValue({
    tmux: { ok: true, path: '/usr/bin/tmux', message: 'tmux ok' },
    runtimes: {
      'claude-code': { ok: false, message: 'claude-code not found' },
      codex: { ok: true, path: '/usr/local/bin/codex', message: '' },
    },
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
    runtimes: { 'claude-code': { ok: true, message: '' }, codex: { ok: true, message: '' } },
  });
  await renderReady();

  expect(await screen.findByText('tmux: ⨯ tmux missing')).toBeTruthy();
});

it('shows an SSH probe failure for remote hosts and clears it when switching back to 本机', async () => {
  probeMock.mockResolvedValue({
    ssh: { ok: false, message: 'auth failed' },
    tmux: { ok: true, message: '' },
    runtimes: { 'claude-code': { ok: true, message: '' }, codex: { ok: true, message: '' } },
  });
  await renderReady(cfg([{ id: 'box', hostname: 'h.example.com' }]));

  fireEvent.click(screen.getByRole('radio', { name: /远程/ }));
  fireEvent.change(await screen.findByLabelText('Host'), { target: { value: 'box' } });
  expect(await screen.findByText('SSH: ⨯ auth failed')).toBeTruthy();

  fireEvent.click(screen.getByRole('radio', { name: '本机' }));
  await waitFor(() => expect(screen.queryByText('SSH: ⨯ auth failed')).toBeNull());
});

it('validates the agent id format and global uniqueness', async () => {
  const dev: AgentConfig = { id: 'dev-a', runtime: 'claude-code', role: 'dev', mode: 'local' };
  await renderReady(cfgWithAgents([[dev]]));
  fireEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
  await waitFor(() => expect(probeMock).toHaveBeenCalled());

  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: '1bad' } });
  expect(screen.getByText(/小写字母开头/)).toBeTruthy();
  await waitFor(() => expect(submitButton().disabled).toBe(true));

  fireEvent.change(screen.getByLabelText('Agent ID'), { target: { value: 'dev-a' } });
  expect(screen.getByText('该 id 已被占用（全局唯一）')).toBeTruthy();
  expect(submitButton().disabled).toBe(true);
});

it('重新探测 re-runs the probe on demand', async () => {
  await renderReady();
  await waitFor(() => expect(probeMock).toHaveBeenCalledTimes(1));

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '↻ 重新探测' }));
  });

  expect(probeMock).toHaveBeenCalledTimes(2);
});

it('aborts the in-flight probe controller when the modal closes', async () => {
  configGetMock.mockResolvedValue(cfg([]));
  const { rerender } = render(<CreateAgentModal open projectId="baxian" onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(probeMock).toHaveBeenCalled());
  const options = probeMock.mock.calls[0][2];
  expect(options?.signal?.aborted).toBe(false);

  rerender(<CreateAgentModal open={false} projectId="baxian" onClose={() => {}} onCreated={() => {}} />);

  expect(options?.signal?.aborted).toBe(true);
});
