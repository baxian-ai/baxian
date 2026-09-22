import { enUS } from '../../src/i18n/en-us.ts';
import { it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HostConfig } from '../../src/shared/index.js';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { HostManagementModal } from '../../src/components/host-management-modal.tsx';
import { ToastProvider } from '../../src/components/toast.tsx';
import { makeRuntimes } from '../helpers/fixtures.ts';
import { expectToast } from '../helpers/toast.tsx';

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
  runtimes: makeRuntimes(),
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
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  expect(await screen.findByText(enUS.hostMgmt.emptyState)).toBeTruthy();
});

it('lists configured hosts with a password indicator', async () => {
  listMock.mockResolvedValue([HOST]);
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  expect(await screen.findByText('Prod')).toBeTruthy();
  expect(screen.getByText(enUS.hostMgmt.passwordSavedIndicator, { exact: false })).toBeTruthy();
});

it('shows a portless host with no :port suffix (not :22), reflecting that ~/.ssh/config decides the port', async () => {
  listMock.mockResolvedValue([{ id: 'nas', hostname: 'nas.local', user: 'agent' } as HostConfig]);
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  expect((await screen.findAllByText('agent@nas.local')).length).toBeGreaterThan(0);
  expect(screen.queryByText(/:22/)).toBeNull();
});

it('add flow: shows the password warning and creates a host on save', async () => {
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.hostMgmt.addHostButton));

  expect(screen.getByText(enUS.hostMgmt.plaintextWarningStrong)).toBeTruthy();

  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: enUS.common.save }));

  await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
  expect(createMock.mock.calls[0][0]).toMatchObject({ hostname: 'h.example.com' });
  expect(createMock.mock.calls[0][0]).not.toHaveProperty('port');
  await expectToast({ title: enUS.hostMgmt.createdToastTitle('h-example-com') });
});

it('port is optional: a blank port keeps Save enabled and sends NO port (so ~/.ssh/config Port is honored)', async () => {
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.hostMgmt.addHostButton));
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'h.example.com' } });

  const save = screen.getByRole('button', { name: enUS.common.save });
  expect(save.hasAttribute('disabled')).toBe(false);
  fireEvent.click(save);

  await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
  expect(createMock.mock.calls[0][0]).not.toHaveProperty('port');
});

it('a provided port flows through; an out-of-range one blocks Save', async () => {
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.hostMgmt.addHostButton));
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'h.example.com' } });

  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.portLabel), { target: { value: '70000' } });
  expect(screen.getByText(enUS.hostMgmt.portRangeError)).toBeTruthy();
  expect(screen.getByRole('button', { name: enUS.common.save }).hasAttribute('disabled')).toBe(true);

  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.portLabel), { target: { value: '2200' } });
  fireEvent.click(screen.getByRole('button', { name: enUS.common.save }));

  await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
  expect(createMock.mock.calls[0][0]).toMatchObject({ hostname: 'h.example.com', port: 2200 });
});

it('"Test connection" probes the inline host and renders SSH + tmux status', async () => {
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.hostMgmt.addHostButton));
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: enUS.hostMgmt.testConnection }));

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
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.hostMgmt.addHostButton));
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'bad.host' } });
  fireEvent.click(screen.getByRole('button', { name: enUS.hostMgmt.testConnection }));

  expect(await screen.findByText(/SSH: ⨯ SSH 不通/)).toBeTruthy();
  expect(screen.getByText(/tmux: ⨯ SSH 不通，无法探测/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: enUS.common.oneClickInstall })).toBeNull();
});

it('carries the typed password into the inline probe host', async () => {
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.hostMgmt.addHostButton));
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'h.example.com' } });
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.userLabel), { target: { value: 'agent' } });
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.portLabel), { target: { value: '2200' } });
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.passwordLabel), { target: { value: 'sekret' } });
  fireEvent.click(screen.getByRole('button', { name: enUS.hostMgmt.testConnection }));

  await waitFor(() => expect(probeMock).toHaveBeenCalledWith('remote', {
    host: { hostname: 'h.example.com', user: 'agent', port: 2200, password: 'sekret' },
  }, expect.anything()));
});

it('edit with unchanged connection fields probes by hostId so the stored password is reused', async () => {
  listMock.mockResolvedValue([HOST]);
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.common.edit));
  fireEvent.click(screen.getByRole('button', { name: enUS.hostMgmt.testConnection }));

  await waitFor(() => expect(probeMock).toHaveBeenCalledWith('remote', { hostId: 'box' }, expect.anything()));
});

it('edit with a changed hostname probes the inline host instead of the stored one', async () => {
  listMock.mockResolvedValue([HOST]);
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.common.edit));
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'new.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: enUS.hostMgmt.testConnection }));

  await waitFor(() => expect(probeMock).toHaveBeenCalledWith('remote', {
    host: { hostname: 'new.example.com', user: 'agent', port: 2222 },
  }, expect.anything()));
});

it('tmux missing: one-click install installs, refreshes the tmux row from the response, and shows the result', async () => {
  probeMock.mockResolvedValue(PROBE_TMUX_MISSING);
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.hostMgmt.addHostButton));
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: enUS.hostMgmt.testConnection }));

  expect(await screen.findByText(/tmux: ⨯ 请安装 tmux/)).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: enUS.common.oneClickInstall }));
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
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.hostMgmt.addHostButton));
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: enUS.hostMgmt.testConnection }));

  expect(await screen.findByText(/tmux: ⨯/)).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: enUS.common.oneClickInstall }));
  });

  expect(await screen.findByText(/⨯ cannot install automatically.*sudo apt-get install -y tmux/)).toBeTruthy();
  expect(screen.getByText(/tmux: ⨯ 请安装 tmux/)).toBeTruthy();
});

it('shows a loading hint while installing and ignores repeated clicks', async () => {
  probeMock.mockResolvedValue(PROBE_TMUX_MISSING);
  let resolveInstall: ((value: Awaited<ReturnType<typeof api.agents.installTmux>>) => void) | undefined;
  installTmuxMock.mockReturnValue(new Promise((resolve) => { resolveInstall = resolve; }));
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.hostMgmt.addHostButton));
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: enUS.hostMgmt.testConnection }));

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
  const { rerender } = render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.hostMgmt.addHostButton));
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: enUS.hostMgmt.testConnection }));

  await waitFor(() => expect(probeMock).toHaveBeenCalledTimes(1));
  const options = probeMock.mock.calls[0][2];
  expect(options?.signal?.aborted).toBe(false);

  rerender(<HostManagementModal open={false} onClose={() => {}} />);

  expect(options?.signal?.aborted).toBe(true);
});

it('editing a connection field aborts the in-flight probe and re-enables the button', async () => {
  probeMock.mockReturnValue(new Promise(() => {}));
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.hostMgmt.addHostButton));
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: enUS.hostMgmt.testConnection }));

  await waitFor(() => expect(probeMock).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: enUS.hostMgmt.testing })).toBeTruthy();
  const options = probeMock.mock.calls[0][2];

  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'h2.example.com' } });

  expect(options?.signal?.aborted).toBe(true);
  expect(await screen.findByRole('button', { name: enUS.hostMgmt.testConnection })).toBeTruthy();
});

it('editing a connection field clears the previous probe result', async () => {
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.hostMgmt.addHostButton));
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'h.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: enUS.hostMgmt.testConnection }));
  expect(await screen.findByText('SSH: ✓ SSH OK')).toBeTruthy();

  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'h2.example.com' } });
  await waitFor(() => expect(screen.queryByText('SSH: ✓ SSH OK')).toBeNull());
});

it('surfaces a connectivity-gate error from create (does not silently swallow)', async () => {
  createMock.mockRejectedValue(new Error('SSH 不通\n检查地址 / 端口 / 密码或 key 认证'));
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.hostMgmt.addHostButton));
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.addressLabel), { target: { value: 'h' } });
  fireEvent.click(screen.getByRole('button', { name: enUS.common.save }));
  const banner = await screen.findByText(/SSH 不通/);
  expect(banner.textContent).toBe('SSH 不通\n检查地址 / 端口 / 密码或 key 认证');
  expect(banner.classList.contains('whitespace-pre-line')).toBe(true);
});

it('deletes a host', async () => {
  listMock.mockResolvedValue([HOST]);
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.common.delete));
  await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('box'));
  await expectToast({ title: enUS.hostMgmt.deletedToastTitle('box') });
});

it('edit: clearing alias/user sends explicit empty strings so PATCH can clear them', async () => {
  listMock.mockResolvedValue([HOST]);
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.common.edit));
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.aliasLabel), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.userLabel), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: enUS.common.save }));

  await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
  expect(updateMock.mock.calls[0][0]).toBe('box');
  expect(updateMock.mock.calls[0][1]).toMatchObject({ alias: '', user: '' });
});

it('edit: clearing the port field sends port: null so the server can drop a wrongly-saved 22', async () => {
  listMock.mockResolvedValue([{ id: 'box', hostname: 'h.example.com', port: 2222, user: 'agent' } as HostConfig]);
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.common.edit));
  fireEvent.change(screen.getByLabelText(enUS.hostMgmt.portLabel), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: enUS.common.save }));

  await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
  expect(updateMock.mock.calls[0][1]).toMatchObject({ port: null });
});

it('edit: an unchanged prefilled port is sent as its number (not cleared)', async () => {
  listMock.mockResolvedValue([{ id: 'box', hostname: 'h.example.com', port: 2222, user: 'agent' } as HostConfig]);
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.common.edit));
  fireEvent.click(screen.getByRole('button', { name: enUS.common.save }));

  await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
  expect(updateMock.mock.calls[0][1]).toMatchObject({ port: 2222 });
});

it('edit: "clear saved password" checkbox sends password: "" so the server can drop it', async () => {
  listMock.mockResolvedValue([HOST]);
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.common.edit));
  fireEvent.click(screen.getByRole('checkbox', { name: enUS.hostMgmt.clearPasswordLabel }));
  fireEvent.click(screen.getByRole('button', { name: enUS.common.save }));

  await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
  expect(updateMock.mock.calls[0][1]).toMatchObject({ password: '' });
});

it('edit: omitting the password (no clear) does NOT send a password field (keep current)', async () => {
  listMock.mockResolvedValue([HOST]);
  render(<HostManagementModal open onClose={() => {}} />, { wrapper: ToastProvider });
  fireEvent.click(await screen.findByText(enUS.common.edit));
  fireEvent.click(screen.getByRole('button', { name: enUS.common.save }));

  await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
  expect(updateMock.mock.calls[0][1]).not.toHaveProperty('password');
});
