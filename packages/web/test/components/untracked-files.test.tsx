import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../src/api.ts';
import { UntrackedFiles } from '../../src/components/untracked-files.tsx';
import { I18nProvider, syncLocaleFromConfig } from '../../src/i18n/index.tsx';
import { enUS } from '../../src/i18n/en-us.ts';
import { zhCN } from '../../src/i18n/zh-cn.ts';
import type { UntrackedFilesReport } from '../../src/shared/index.js';
import { makeTask } from '../helpers/fixtures.ts';

vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

const inspect = vi.mocked(api.tasks.untrackedFiles);
const resolve = vi.mocked(api.tasks.resolveUntrackedFiles);
const report: UntrackedFilesReport = {
  agentId: 'qa-1', host: 'remote-mac', workdir: '/work/qa/repo', token: 'a'.repeat(64),
  trackedChanges: false,
  files: [{ path: 'test-results/desktop.png', size: 123, kind: 'file' }],
};

beforeEach(() => {
  inspect.mockReset().mockResolvedValue(report);
  resolve.mockReset().mockResolvedValue(makeTask());
  syncLocaleFromConfig('en-US');
});

afterEach(() => { cleanup(); syncLocaleFromConfig('en-US'); });

function open() {
  return render(<I18nProvider><UntrackedFiles taskId="task-1" agentId="qa-1" /></I18nProvider>);
}

describe('untracked file recovery choices', () => {
  it('shows the machine, workdir and files, and retains them through the task recovery API', async () => {
    open();
    const keep = await screen.findByRole('button', { name: enUS.untrackedFiles.keep });
    expect(screen.getByText('remote-mac')).toBeTruthy();
    expect(screen.getByText('/work/qa/repo')).toBeTruthy();
    expect(screen.getByText('test-results/desktop.png')).toBeTruthy();
    expect(screen.getByText('123 B')).toBeTruthy();
    fireEvent.click(keep);
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('task-1', 'qa-1', { action: 'keep', token: report.token }));
    await waitFor(() => expect(screen.queryByRole('button', { name: enUS.untrackedFiles.keep })).toBeNull());
  });

  it('requires confirmation of the displayed files before discarding and permits cancellation', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: enUS.untrackedFiles.discard }));
    let dialog = screen.getByRole('dialog', { name: enUS.untrackedFiles.confirmTitle });
    expect(within(dialog).getByText('test-results/desktop.png')).toBeTruthy();
    expect(resolve).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: enUS.common.cancel }));
    expect(resolve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: enUS.untrackedFiles.discard }));
    dialog = screen.getByRole('dialog', { name: enUS.untrackedFiles.confirmTitle });
    fireEvent.click(within(dialog).getByRole('button', { name: enUS.untrackedFiles.discard }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('task-1', 'qa-1', { action: 'discard', token: report.token }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('refreshes a stale list without automatically repeating the destructive action', async () => {
    inspect.mockResolvedValueOnce(report).mockResolvedValue({ ...report, token: 'b'.repeat(64), files: [...report.files, { path: 'new.txt', size: 1, kind: 'file' }] });
    resolve.mockRejectedValueOnce(new Error('Files changed; refresh the list'));
    open();
    fireEvent.click(await screen.findByRole('button', { name: enUS.untrackedFiles.discard }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: enUS.untrackedFiles.discard }));
    expect(await screen.findByText('new.txt')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Files changed');
    expect(resolve).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: enUS.untrackedFiles.keep }));
    await waitFor(() => expect(resolve).toHaveBeenLastCalledWith('task-1', 'qa-1', { action: 'keep', token: 'b'.repeat(64) }));
  });

  it('does not offer destructive recovery for nested repositories or bypass tracked changes', async () => {
    inspect.mockResolvedValue({ ...report, files: [{ path: 'nested/', size: 0, kind: 'directory' }] });
    open();
    const discard = await screen.findByRole('button', { name: enUS.untrackedFiles.discard });
    expect((discard as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: enUS.untrackedFiles.keep }) as HTMLButtonElement).disabled).toBe(false);
    inspect.mockResolvedValue({ ...report, trackedChanges: true });
    fireEvent.click(screen.getByRole('button', { name: enUS.untrackedFiles.refresh }));
    await screen.findByText(enUS.untrackedFiles.trackedChanges);
    expect((screen.getByRole('button', { name: enUS.untrackedFiles.keep }) as HTMLButtonElement).disabled).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('updates both choices and the confirmation when the language changes', async () => {
    open();
    await screen.findByRole('button', { name: enUS.untrackedFiles.keep });
    act(() => syncLocaleFromConfig('zh-CN'));
    expect(screen.getByRole('button', { name: zhCN.untrackedFiles.keep })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: zhCN.untrackedFiles.discard }));
    expect(screen.getByRole('dialog', { name: zhCN.untrackedFiles.confirmTitle })).toBeTruthy();
    expect(screen.getAllByText('test-results/desktop.png')).toHaveLength(2);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('surfaces inspection failures with a retry and offers continuation when no files remain', async () => {
    inspect.mockRejectedValueOnce(new Error('Host unavailable')).mockResolvedValue({ ...report, files: [] });
    open();
    expect((await screen.findByRole('alert')).textContent).toContain('Host unavailable');
    fireEvent.click(screen.getByRole('button', { name: enUS.untrackedFiles.refresh }));
    fireEvent.click(await screen.findByRole('button', { name: enUS.untrackedFiles.continue }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('task-1', 'qa-1', { action: 'continue', token: report.token }));
  });

  it('offers a retry after files were handled and continuation failed, using the refreshed token', async () => {
    inspect.mockResolvedValueOnce(report).mockResolvedValue({ ...report, token: 'b'.repeat(64), files: [] });
    resolve.mockRejectedValueOnce(new Error('Files were kept, but continuing the task failed')).mockResolvedValue(makeTask());
    const onPendingChange = vi.fn();
    render(<I18nProvider><UntrackedFiles taskId="task-1" agentId="qa-1" onPendingChange={onPendingChange} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: enUS.untrackedFiles.keep }));
    const retry = await screen.findByRole('button', { name: enUS.untrackedFiles.continue });
    expect(screen.getByRole('alert').textContent).toContain('Files were kept');
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(retry);
    await waitFor(() => expect(resolve).toHaveBeenLastCalledWith('task-1', 'qa-1', { action: 'continue', token: 'b'.repeat(64) }));
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
  });

  it('blocks empty-list continuation while tracked changes remain', async () => {
    inspect.mockResolvedValue({ ...report, files: [], trackedChanges: true });
    open();
    expect((await screen.findByRole('button', { name: enUS.untrackedFiles.continue }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(enUS.untrackedFiles.trackedChanges)).toBeTruthy();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('treats a temporary inspection conflict as a status message and supports refresh', async () => {
    inspect.mockRejectedValueOnce(new ApiError(409, 'Agent maintenance is in progress')).mockResolvedValue(report);
    open();
    expect((await screen.findByText(/Agent maintenance is in progress/)).getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: enUS.untrackedFiles.refresh }));
    expect(await screen.findByRole('button', { name: enUS.untrackedFiles.keep })).toBeTruthy();
    expect(screen.queryByText(/Agent maintenance is in progress/)).toBeNull();
  });

  it('hides unsupported file recovery without an error', async () => {
    inspect.mockResolvedValue(null);
    open();
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps ignored or retained checkout conflicts visible even with no pending files', async () => {
    inspect.mockResolvedValue({ ...report, files: [], conflicts: [{ path: 'ignored.bin', size: 2097152, kind: 'file' }], manualCleanupRequired: true });
    open();
    expect(await screen.findByText('ignored.bin')).toBeTruthy();
    expect(screen.getByText('2.0 MiB')).toBeTruthy();
    expect(screen.getByText(enUS.untrackedFiles.manualCleanup)).toBeTruthy();
    expect(screen.queryByRole('button', { name: enUS.untrackedFiles.keep })).toBeNull();
    expect(screen.queryByRole('button', { name: enUS.untrackedFiles.discard })).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['limit', 'checkout'] as const)('blocks an ineffective Keep for %s while offering confirmed discard', async reason => {
    inspect.mockResolvedValue({ ...report, ...(reason === 'limit' ? { keepLimitExceeded: true } : { conflicts: report.files }) });
    open();
    const keep = await screen.findByRole('button', { name: enUS.untrackedFiles.keep });
    expect((keep as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: enUS.untrackedFiles.discard }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('retains the file outcome when continuation fails and a refresh is temporarily unavailable', async () => {
    inspect.mockResolvedValueOnce(report).mockRejectedValue(new ApiError(409, 'Agent maintenance is in progress'));
    resolve.mockRejectedValue(new ApiError(409, 'Listed files were discarded, but continuing the task failed: checkout conflict'));
    open();
    fireEvent.click(await screen.findByRole('button', { name: enUS.untrackedFiles.discard }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: enUS.untrackedFiles.discard }));
    await screen.findByText(/Agent maintenance is in progress/);
    expect(screen.getByRole('alert').textContent).toContain('Listed files were discarded');
  });
});
