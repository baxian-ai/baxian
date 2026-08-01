import { it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';

vi.mock('../../src/components/toast.tsx', async () => (await import('../helpers/toast-mock.tsx')).createToastMock());
vi.mock('../../src/hooks/use-pending-restart.tsx', async () => (await import('../helpers/pending-restart-mock.tsx')).createPendingRestartMock());
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { CreateProjectModal } from '../../src/components/create-project-modal.tsx';
import { makeProject } from '../helpers/fixtures.ts';

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
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Project ID'), { target: { value: 'newproj' } });
  fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: repoValue } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
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

it('shows baxian as the Project ID placeholder', async () => {
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  expect((screen.getByLabelText('Project ID') as HTMLInputElement).placeholder).toBe('baxian');
});

it('defaults Spec review to Human review and submits specApproval human', async () => {
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  expect((screen.getByLabelText('Human review (default)') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('Auto-start coding after QA approval') as HTMLInputElement).checked).toBe(false);
  fireEvent.change(screen.getByLabelText('Project ID'), { target: { value: 'specproj' } });
  fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'https://github.com/example-owner/example-repo.git' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  });
  expect(createMock).toHaveBeenCalledWith({
    id: 'specproj',
    repo: 'https://github.com/example-owner/example-repo.git',
    merge: null,
    specApproval: 'human',
  });
});

it('omits specApproval when Auto-start coding after QA approval is selected', async () => {
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Project ID'), { target: { value: 'autoproj' } });
  fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'https://github.com/example-owner/example-repo.git' } });
  fireEvent.click(screen.getByLabelText('Auto-start coding after QA approval'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  });
  expect(createMock).toHaveBeenCalledWith({
    id: 'autoproj',
    repo: 'https://github.com/example-owner/example-repo.git',
    merge: null,
  });
});

it('resets Spec review to Human review when the modal reopens', async () => {
  const { rerender } = render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.click(screen.getByLabelText('Auto-start coding after QA approval'));
  expect((screen.getByLabelText('Auto-start coding after QA approval') as HTMLInputElement).checked).toBe(true);
  rerender(<CreateProjectModal open={false} onClose={() => {}} onCreated={() => {}} />);
  rerender(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect((screen.getByLabelText('Human review (default)') as HTMLInputElement).checked).toBe(true));
});

it.each([
  ['single token, no slash', 'justaname'],
  ['contains a space', 'https://gitlab.example.com/group/ proj'],
  ['scheme only, no path', 'https://gitlab.example.com'],
  ['non-github SSH URL', 'ssh://git@gitlab.example.com/group/proj.git'],
  ['non-github scp URL', 'git@gitlab.example.com:group/proj.git'],
  ['multi-segment path', 'https://github.com/group/subgroup/proj.git'],
  ['query suffix', 'https://github.com/group/proj.git?token=x'],
  ['fragment suffix', 'https://github.com/group/proj.git#readme'],
])('rejects %s with the URL-format field error', async (_label, repo) => {
  await renderAndFill(repo);
  expect(createMock).not.toHaveBeenCalled();
  expect(screen.getByText(/full github\.com HTTPS or SSH Git URL/)).toBeTruthy();
});

it('surfaces a config load failure instead of silently rendering the github default', async () => {
  configGetMock.mockRejectedValue(new Error('boom'));
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(screen.getByText(/Failed to load/)).toBeTruthy());
});

it('preserves line breaks in a multiline create failure', async () => {
  createMock.mockRejectedValue(new Error('project invalid\nrepo: unreachable'));
  await renderAndFill('https://github.com/example-owner/example-repo.git');
  const banner = await screen.findByText(/project invalid/);
  expect(banner.textContent).toBe('project invalid\nrepo: unreachable');
  expect(banner.classList.contains('whitespace-pre-line')).toBe(true);
});

it('does not render or submit a review mode', async () => {
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Project ID'), { target: { value: 'gitproj' } });
  fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'https://github.com/example-owner/example-repo.git' } });
  expect(screen.queryByText('Review mode')).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  });
  expect(createMock).toHaveBeenCalledWith({
    id: 'gitproj',
    repo: 'https://github.com/example-owner/example-repo.git',
    merge: null,
    specApproval: 'human',
  });
});
