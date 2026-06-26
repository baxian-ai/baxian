import { it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BaxianConfig } from '../../src/shared/index.js';

vi.mock('../../src/components/toast.tsx', () => ({
  useToast: () => ({ show: vi.fn() }),
}));
vi.mock('../../src/hooks/use-pending-restart.tsx', () => ({
  usePendingRestart: () => ({ flagDirty: vi.fn() }),
}));

const configGetMock = vi.fn();
const probeMock = vi.fn();
const addAgentMock = vi.fn();
vi.mock('../../src/api.ts', () => ({
  api: {
    config: { get: (...a: unknown[]) => configGetMock(...a) },
    agents: { probe: (...a: unknown[]) => probeMock(...a) },
    projects: { addAgent: (...a: unknown[]) => addAgentMock(...a) },
  },
}));

import { CreateAgentModal } from '../../src/components/create-agent-modal.tsx';

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
  addAgentMock.mockReset().mockResolvedValue({ agent: { id: 'x' }, restartRequired: false });
});

it('remote mode shows a host picker (not a raw hostname input)', async () => {
  configGetMock.mockResolvedValue(cfg([{ id: 'box', hostname: 'h.example.com', port: 2222, alias: 'Prod', user: 'agent' }]));
  render(<CreateAgentModal open projectId="baxian" onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());

  fireEvent.click(screen.getByRole('radio', { name: /远程/ }));

  expect(await screen.findByLabelText('Host')).toBeTruthy();
  expect(screen.getByText('Prod')).toBeTruthy();
  // The old raw inputs are gone.
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
  // 收起时不渲染 advanced-options，aria-controls 不得指向不存在的节点。
  expect(toggle.getAttribute('aria-controls')).toBeNull();
  expect(document.getElementById('advanced-options')).toBeNull();
  expect(screen.queryByLabelText(/Workdir/)).toBeNull();
  expect(screen.queryByLabelText(/Model/)).toBeNull();
  expect(screen.queryByLabelText(/Additional Dirs/)).toBeNull();

  fireEvent.click(toggle);

  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  // 展开后才提供 aria-controls，并指向真实存在的区块。
  expect(toggle.getAttribute('aria-controls')).toBe('advanced-options');
  expect(document.getElementById('advanced-options')).toBeTruthy();
  expect(screen.getByLabelText(/Workdir/)).toBeTruthy();
  expect(screen.getByLabelText(/Model/)).toBeTruthy();
  expect(screen.getByLabelText(/Additional Dirs/)).toBeTruthy();

  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-controls')).toBeNull();
  expect(screen.queryByLabelText(/Workdir/)).toBeNull();
});
