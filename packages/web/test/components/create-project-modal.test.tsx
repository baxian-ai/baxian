import { enUS } from '../../src/i18n/en-us.ts';
import { it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';

vi.mock('../../src/hooks/use-pending-restart.tsx', async () => (await import('../helpers/pending-restart-mock.tsx')).createPendingRestartMock());
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { CreateProjectModal } from '../../src/components/create-project-modal.tsx';
import { ToastProvider } from '../../src/components/toast.tsx';
import { makeProject } from '../helpers/fixtures.ts';
import { expectToast } from '../helpers/toast.tsx';

const configGetMock = vi.mocked(api.config.get);
const createMock = vi.mocked(api.projects.create);

beforeEach(() => {
  configGetMock.mockReset().mockResolvedValue({
    review: { rounds: 2 },
    server: { port: 7080 },
    host: [],
    project: [],
  });
  createMock.mockReset().mockResolvedValue({ project: makeProject({ id: 'p' }), restartRequired: false });
});

async function renderAndFill(repoValue: string) {
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />, { wrapper: ToastProvider });
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText(enUS.createProject.idLabel), { target: { value: 'newproj' } });
  fireEvent.change(screen.getByLabelText(enUS.createProject.repoLabel), { target: { value: repoValue } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: enUS.common.create }));
  });
}

it.each([
  ['github HTTPS URL', 'https://github.com/example-owner/example-repo.git'],
  ['github SSH URL', 'git@github.com:example-owner/example-repo.git'],
  ['github ssh URL', 'ssh://git@github.com/example-owner/example-repo.git'],
])('submits a %s repo as entered', async (_label, repo) => {
  await renderAndFill(repo);
  expect(createMock).toHaveBeenCalledWith({ id: 'newproj', repo, merge: null, specApproval: 'human' });
});

it('trims surrounding whitespace before submitting', async () => {
  await renderAndFill('  https://github.com/example-owner/example-repo.git ');
  expect(createMock).toHaveBeenCalledWith({
    id: 'newproj',
    repo: 'https://github.com/example-owner/example-repo.git',
    merge: null,
    specApproval: 'human',
  });
});

it('requires the user to approve the plan by default and submits specApproval human', async () => {
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />, { wrapper: ToastProvider });
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  expect((screen.getByLabelText(enUS.createProject.specApprovalHumanLabel) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText(enUS.createProject.specApprovalAutoLabel) as HTMLInputElement).checked).toBe(false);
  fireEvent.change(screen.getByLabelText(enUS.createProject.idLabel), { target: { value: 'specproj' } });
  fireEvent.change(screen.getByLabelText(enUS.createProject.repoLabel), { target: { value: 'https://github.com/example-owner/example-repo.git' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: enUS.common.create }));
  });
  expect(createMock).toHaveBeenCalledWith({
    id: 'specproj',
    repo: 'https://github.com/example-owner/example-repo.git',
    merge: null,
    specApproval: 'human',
  });
  await expectToast({ title: enUS.createProject.createdToastTitle('p') });
});

it('omits specApproval when automatic development after plan review is selected', async () => {
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />, { wrapper: ToastProvider });
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText(enUS.createProject.idLabel), { target: { value: 'autoproj' } });
  fireEvent.change(screen.getByLabelText(enUS.createProject.repoLabel), { target: { value: 'https://github.com/example-owner/example-repo.git' } });
  fireEvent.click(screen.getByLabelText(enUS.createProject.specApprovalAutoLabel));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: enUS.common.create }));
  });
  expect(createMock).toHaveBeenCalledWith({
    id: 'autoproj',
    repo: 'https://github.com/example-owner/example-repo.git',
    merge: null,
  });
});

it('resets plan approval to require user confirmation when the modal reopens', async () => {
  const { rerender } = render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />, { wrapper: ToastProvider });
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.click(screen.getByLabelText(enUS.createProject.specApprovalAutoLabel));
  expect((screen.getByLabelText(enUS.createProject.specApprovalAutoLabel) as HTMLInputElement).checked).toBe(true);
  rerender(<CreateProjectModal open={false} onClose={() => {}} onCreated={() => {}} />);
  rerender(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect((screen.getByLabelText(enUS.createProject.specApprovalHumanLabel) as HTMLInputElement).checked).toBe(true));
});

it('submits a non-GitHub repository URL and leaves platform validation to the server', async () => {
  const repo = 'https://git.corp.example/group/subgroup/proj.git';
  await renderAndFill(repo);
  expect(createMock).toHaveBeenCalledWith({ id: 'newproj', repo, merge: null, specApproval: 'human' });
});

it('surfaces the server-side repository validation error', async () => {
  createMock.mockRejectedValue(new Error(
    'project[0].repo: project.repo is not recognized by any installed platform',
  ));
  await renderAndFill('justaname');
  expect(createMock).toHaveBeenCalled();
  expect(await screen.findByText(/not recognized by any installed platform/)).toBeTruthy();
});

it('keeps blocking an empty repository URL client-side', async () => {
  await renderAndFill('   ');
  expect(createMock).not.toHaveBeenCalled();
  expect(screen.getByText(enUS.createProject.required)).toBeTruthy();
});

it('surfaces a config load failure instead of silently rendering the github default', async () => {
  configGetMock.mockRejectedValue(new Error('boom'));
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />, { wrapper: ToastProvider });
  await waitFor(() => expect(screen.getByText(enUS.common.loadFailed('boom'))).toBeTruthy());
});

it('preserves line breaks in a multiline create failure', async () => {
  createMock.mockRejectedValue(new Error('project invalid\nrepo: unreachable'));
  await renderAndFill('https://github.com/example-owner/example-repo.git');
  const banner = await screen.findByText(/project invalid/);
  expect(banner.textContent).toBe('project invalid\nrepo: unreachable');
  expect(banner.classList.contains('whitespace-pre-line')).toBe(true);
});

it('submits project defaults without a review mode', async () => {
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />, { wrapper: ToastProvider });
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText(enUS.createProject.idLabel), { target: { value: 'gitproj' } });
  fireEvent.change(screen.getByLabelText(enUS.createProject.repoLabel), { target: { value: 'https://github.com/example-owner/example-repo.git' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: enUS.common.create }));
  });
  expect(createMock).toHaveBeenCalledWith({
    id: 'gitproj',
    repo: 'https://github.com/example-owner/example-repo.git',
    merge: null,
    specApproval: 'human',
  });
});
