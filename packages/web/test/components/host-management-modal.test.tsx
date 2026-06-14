import { it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HostConfig } from '../../src/shared/index.js';

vi.mock('../../src/components/toast.tsx', () => ({
  useToast: () => ({ show: vi.fn() }),
}));

const listMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const checkMock = vi.fn();
vi.mock('../../src/api.ts', () => ({
  api: {
    hosts: {
      list: (...a: unknown[]) => listMock(...a),
      create: (...a: unknown[]) => createMock(...a),
      update: (...a: unknown[]) => updateMock(...a),
      delete: (...a: unknown[]) => deleteMock(...a),
      check: (...a: unknown[]) => checkMock(...a),
    },
  },
}));

import { HostManagementModal } from '../../src/components/host-management-modal.tsx';

const HOST: HostConfig = { id: 'box', hostname: 'h.example.com', port: 2222, alias: 'Prod', user: 'agent', password: '***' };

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([]);
  createMock.mockReset().mockResolvedValue({ host: { id: 'h-example-com', hostname: 'h.example.com', port: 22 }, restartRequired: false });
  updateMock.mockReset().mockResolvedValue({ host: HOST, restartRequired: false });
  deleteMock.mockReset().mockResolvedValue({ removed: 'box', restartRequired: false });
  checkMock.mockReset().mockResolvedValue({ ok: true, message: 'SSH OK' });
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

  // the warning is shown in the form.
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

it('test connection calls the check endpoint and renders the result', async () => {
  checkMock.mockResolvedValue({ ok: false, message: 'SSH 不通：检查地址 / 端口 / 密码或 key 认证' });
  render(<HostManagementModal open onClose={() => {}} />);
  fireEvent.click(await screen.findByText('+ 添加 Host'));
  fireEvent.change(screen.getByLabelText('Host 地址'), { target: { value: 'bad.host' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  expect(await screen.findByText(/SSH 不通/)).toBeTruthy();
  expect(checkMock).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'bad.host' }));
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
  // Form is prefilled; clear alias + user.
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
  listMock.mockResolvedValue([HOST]); // HOST.password === '***' → checkbox is shown
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
