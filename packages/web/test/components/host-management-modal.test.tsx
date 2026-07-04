import { it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HostConfig } from '../../src/shared/index.js';

vi.mock('../../src/components/toast.tsx', async () => (await import('../helpers/toast-mock.tsx')).createToastMock());
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { HostManagementModal } from '../../src/components/host-management-modal.tsx';

const listMock = vi.mocked(api.hosts.list);
const createMock = vi.mocked(api.hosts.create);
const updateMock = vi.mocked(api.hosts.update);
const deleteMock = vi.mocked(api.hosts.delete);
const probeMock = vi.mocked(api.agents.probe);
const installTmuxMock = vi.mocked(api.agents.installTmux);

const HOST: HostConfig = { id: 'box', hostname: 'h.example.com', port: 2222, alias: 'Prod', user: 'agent', password: '***' };

const PROBE_OK = {
  ssh: { ok: true, message: 'SSH OK' },
  tmux: { ok: true, path: '/usr/bin/tmux', message: 'tmux found' },
  runtimes: {
    'claude-code': { ok: true, message: '' },
    codex: { ok: true, message: '' },
  },
};

const PROBE_TMUX_MISSING = {
  ...PROBE_OK,
  tmux: { ok: false, message: '请安装 tmux' },
};

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([]);
  createMock.mockReset().mockResolvedValue({ host: { id: 'h-example-com', hostname: 'h.example.com', port: 22 }, restartRequired: false });
  updateMock.mockReset().mockResolvedValue({ host: HOST, restartRequired: false });
  deleteMock.mockReset().mockResolvedValue({ removed: 'box', restartRequired: false });
  probeMock.mockReset().mockResolvedValue(PROBE_OK);
  installTmuxMock.mockReset().mockResolvedValue({
    ok: true,
    method: 'apt-get',
    version: '3.4',
    message: 'tmux 3.4 installed via apt-get',
    tmux: { ok: true, path: '/usr/bin/tmux', message: 'tmux found' },
  });
});

it('shows an empty state when no hosts are configured', async () => {
  render(<HostManagementModal open onClose={() => {}} />);
  expect(await screen.findByText(/还没有配置 Host/)).toBeTruthy();
});

it('lists configured hosts with a password indicator', async () => {
  listMock.mockResolvedValue([HOST]);
  render(<HostManagementModal open onClose={() => {}} />);
  expect(await screen.findByText('Prod')).toBeTruthy();
  expect(screen.getByText(/密码已保存/)).toBeTruthy();
});

it('shows a portless host with no :port suffix (not :22), reflecting that ~/.ssh/config decides the port', async () => {
  listMock.mockResolvedValue([{ id: 'nas', hostname: 'nas.local', user: 'agent' } as HostConfig]);
  render(<HostManagementModal open onClose={() => {}} />);
  expect((await screen.findAllByText('agent@nas.local')).length).toBeGreaterThan(0);
  expect(screen.queryByText(/:22/)).toBeNull();
});

it('add flow: shows the password warning and creates a host on save', async () => {
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('+ 添加 Host'));

  expect(screen.getByText(/明文/)).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));

  await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
  expect(createMock.mock.calls[0][0]).toMatchObject({ hostname: 'h.example.com' });
  expect(createMock.mock.calls[0][0]).not.toHaveProperty('port');
});

it('port is optional: a blank port keeps Save enabled and sends NO port (so ~/.ssh/config Port is honored)', async () => {
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('+ 添加 Host'));
  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'h.example.com' } });

  const save = screen.getByRole('button', { name: '保存' });
  expect(save.hasAttribute('disabled')).toBe(false);
  fireEvent.click(save);

  await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
  expect(createMock.mock.calls[0][0]).not.toHaveProperty('port');
});

it('a provided port flows through; an out-of-range one blocks Save', async () => {
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('+ 添加 Host'));
  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'h.example.com' } });

  fireEvent.change(screen.getByLabelText('端口（可选）'), { target: { value: '70000' } });
  expect(screen.getByText(/端口需为 1–65535/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true);

  fireEvent.change(screen.getByLabelText('端口（可选）'), { target: { value: '2200' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));

  await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
  expect(createMock.mock.calls[0][0]).toMatchObject({ hostname: 'h.example.com', port: 2200 });
});

it('does not render the connectivity-gate help line', async () => {
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('+ 添加 Host'));
  expect(screen.queryByText(/保存时会先检查连通性/)).toBeNull();
});

it('测试连接 probes the inline host and renders SSH + tmux status', async () => {
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('+ 添加 Host'));
  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

  expect(await screen.findByText('SSH: ✓ SSH OK')).toBeTruthy();
  expect(screen.getByText('tmux: ✓ /usr/bin/tmux')).toBeTruthy();
  expect(probeMock).toHaveBeenCalledWith('remote', { host: { hostname: 'h.example.com' } }, expect.anything());
});

it('renders an SSH failure and offers no tmux install button when SSH is down', async () => {
  probeMock.mockResolvedValue({
    ssh: { ok: false, message: 'SSH 不通，请检查地址 / 端口 / 密码或 key 认证' },
    tmux: { ok: false, message: 'SSH 不通，无法探测' },
    runtimes: PROBE_OK.runtimes,
  });
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('+ 添加 Host'));
  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'bad.host' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

  expect(await screen.findByText(/SSH: ⨯ SSH 不通/)).toBeTruthy();
  expect(screen.getByText(/tmux: ⨯ SSH 不通，无法探测/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '一键安装' })).toBeNull();
});

it('carries the typed password into the inline probe host', async () => {
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('+ 添加 Host'));
  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'h.example.com' } });
  fireEvent.change(screen.getByLabelText('用户名（可选）'), { target: { value: 'agent' } });
  fireEvent.change(screen.getByLabelText('端口（可选）'), { target: { value: '2200' } });
  fireEvent.change(screen.getByLabelText('密码（可选）'), { target: { value: 'sekret' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

  await waitFor(() => expect(probeMock).toHaveBeenCalledWith('remote', {
    host: { hostname: 'h.example.com', user: 'agent', port: 2200, password: 'sekret' },
  }, expect.anything()));
});

it('edit with unchanged connection fields probes by hostId so the stored password is reused', async () => {
  listMock.mockResolvedValue([HOST]);
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('编辑'));
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

  await waitFor(() => expect(probeMock).toHaveBeenCalledWith('remote', { hostId: 'box' }, expect.anything()));
});

it('edit with a changed hostname probes the inline host instead of the stored one', async () => {
  listMock.mockResolvedValue([HOST]);
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('编辑'));
  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'new.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

  await waitFor(() => expect(probeMock).toHaveBeenCalledWith('remote', {
    host: { hostname: 'new.example.com', user: 'agent', port: 2222 },
  }, expect.anything()));
});

it('tmux missing: 一键安装 installs, refreshes the tmux row from the response, and shows the result', async () => {
  probeMock.mockResolvedValue(PROBE_TMUX_MISSING);
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('+ 添加 Host'));
  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

  expect(await screen.findByText(/tmux: ⨯ 请安装 tmux/)).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '一键安装' }));
  });

  expect(installTmuxMock).toHaveBeenCalledWith('remote', { host: { hostname: 'h.example.com' } });
  expect(await screen.findByText('tmux: ✓ /usr/bin/tmux')).toBeTruthy();
  expect(screen.getByText(/✓ tmux 3\.4 installed via apt-get/)).toBeTruthy();
});

it('install failure keeps the tmux row red and surfaces the manual command', async () => {
  probeMock.mockResolvedValue(PROBE_TMUX_MISSING);
  installTmuxMock.mockResolvedValue({
    ok: false,
    method: 'apt-get',
    message: 'cannot install automatically: not root and passwordless sudo is unavailable — run "sudo apt-get install -y tmux" on the host',
    tmux: { ok: false, message: '请安装 tmux' },
  });
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('+ 添加 Host'));
  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

  expect(await screen.findByText(/tmux: ⨯/)).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '一键安装' }));
  });

  expect(await screen.findByText(/⨯ cannot install automatically.*sudo apt-get install -y tmux/)).toBeTruthy();
  expect(screen.getByText(/tmux: ⨯ 请安装 tmux/)).toBeTruthy();
});

it('shows a loading hint while installing and ignores repeated clicks', async () => {
  probeMock.mockResolvedValue(PROBE_TMUX_MISSING);
  let resolveInstall: ((value: Awaited<ReturnType<typeof api.agents.installTmux>>) => void) | undefined;
  installTmuxMock.mockReturnValue(new Promise((resolve) => { resolveInstall = resolve; }));
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('+ 添加 Host'));
  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

  expect(await screen.findByText(/tmux: ⨯/)).toBeTruthy();
  const install = () => screen.getByRole('button', { name: /一键安装|安装中/ });
  fireEvent.click(install());

  expect(await screen.findByText(/正在安装 tmux，可能需要几分钟/)).toBeTruthy();
  expect((install() as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(install());
  fireEvent.click(install());
  expect(installTmuxMock).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveInstall?.({
      ok: true,
      method: 'apt-get',
      version: '3.4',
      message: 'tmux 3.4 installed via apt-get',
      tmux: { ok: true, path: '/usr/bin/tmux', message: 'tmux found' },
    });
  });
  expect(await screen.findByText('tmux: ✓ /usr/bin/tmux')).toBeTruthy();
});

it('closing the modal aborts the in-flight probe controller', async () => {
  probeMock.mockReturnValue(new Promise(() => {}));
  const { rerender } = render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('+ 添加 Host'));
  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

  await waitFor(() => expect(probeMock).toHaveBeenCalledTimes(1));
  const options = probeMock.mock.calls[0][2];
  expect(options?.signal?.aborted).toBe(false);

  rerender(<HostManagementModal open={false} onClose={() => {}} />);

  expect(options?.signal?.aborted).toBe(true);
});

it('editing a connection field aborts the in-flight probe and re-enables the button', async () => {
  probeMock.mockReturnValue(new Promise(() => {}));
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('+ 添加 Host'));
  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

  await waitFor(() => expect(probeMock).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: '测试中…' })).toBeTruthy();
  const options = probeMock.mock.calls[0][2];

  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'h2.example.com' } });

  expect(options?.signal?.aborted).toBe(true);
  expect(await screen.findByRole('button', { name: '测试连接' })).toBeTruthy();
});

it('editing a connection field clears the previous probe result', async () => {
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('+ 添加 Host'));
  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  expect(await screen.findByText('SSH: ✓ SSH OK')).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'h2.example.com' } });
  await waitFor(() => expect(screen.queryByText('SSH: ✓ SSH OK')).toBeNull());
});

it('surfaces a connectivity-gate error from create (does not silently swallow)', async () => {
  createMock.mockRejectedValue(new Error('SSH 不通：检查地址 / 端口 / 密码或 key 认证'));
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('+ 添加 Host'));
  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'h' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByText(/SSH 不通/)).toBeTruthy();
});

it('deletes a host', async () => {
  listMock.mockResolvedValue([HOST]);
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('删除'));
  await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('box'));
});

it('edit: clearing alias/user sends explicit empty strings so PATCH can clear them', async () => {
  listMock.mockResolvedValue([HOST]);
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('编辑'));
  fireEvent.change(screen.getByLabelText('别名（可选）'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('用户名（可选）'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));

  await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
  expect(updateMock.mock.calls[0][0]).toBe('box');
  expect(updateMock.mock.calls[0][1]).toMatchObject({ alias: '', user: '' });
});

it('edit: clearing the port field sends port: null so the server can drop a wrongly-saved 22', async () => {
  listMock.mockResolvedValue([{ id: 'box', hostname: 'h.example.com', port: 2222, user: 'agent' } as HostConfig]);
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('编辑'));
  fireEvent.change(screen.getByLabelText('端口（可选）'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));

  await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
  expect(updateMock.mock.calls[0][1]).toMatchObject({ port: null });
});

it('edit: an unchanged prefilled port is sent as its number (not cleared)', async () => {
  listMock.mockResolvedValue([{ id: 'box', hostname: 'h.example.com', port: 2222, user: 'agent' } as HostConfig]);
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('编辑'));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));

  await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
  expect(updateMock.mock.calls[0][1]).toMatchObject({ port: 2222 });
});

it('edit: "clear saved password" checkbox sends password: "" so the server can drop it', async () => {
  listMock.mockResolvedValue([HOST]);
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('编辑'));
  fireEvent.click(screen.getByRole('checkbox', { name: /清除已保存的密码/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));

  await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
  expect(updateMock.mock.calls[0][1]).toMatchObject({ password: '' });
});

it('edit: omitting the password (no clear) does NOT send a password field (keep current)', async () => {
  listMock.mockResolvedValue([HOST]);
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('编辑'));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));

  await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
  expect(updateMock.mock.calls[0][1]).not.toHaveProperty('password');
});
