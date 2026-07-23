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
  ['non-github HTTPS URL', 'https://gitlab.example.com/group/proj.git'],
  ['non-github subgroup path', 'https://gitlab.example.com/group/sub/proj.git'],
  ['non-github scp URL', 'git@gitlab.example.com:group/proj.git'],
  ['legacy owner/repo shorthand', 'example-owner/example-repo'],
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
  fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'example-owner/example-repo' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  });
  expect(createMock).toHaveBeenCalledWith({
    id: 'specproj',
    repo: 'example-owner/example-repo',
    merge: null,
    specApproval: 'human',
  });
});

it('omits specApproval when Auto-start coding after QA approval is selected', async () => {
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Project ID'), { target: { value: 'autoproj' } });
  fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'example-owner/example-repo' } });
  fireEvent.click(screen.getByLabelText('Auto-start coding after QA approval'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  });
  expect(createMock).toHaveBeenCalledWith({
    id: 'autoproj',
    repo: 'example-owner/example-repo',
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

it('submits an explicit server review mode override', async () => {
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Project ID'), { target: { value: 'serverproj' } });
  fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'example-owner/example-repo' } });
  fireEvent.click(screen.getByLabelText('Server'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  });
  expect(createMock).toHaveBeenCalledWith({
    id: 'serverproj',
    repo: 'example-owner/example-repo',
    merge: null,
    specApproval: 'human',
    review: { mode: 'server' },
  });
});

it.each([
  ['single token, no slash', 'justaname'],
  ['contains a space', 'https://gitlab.example.com/group/ proj'],
  ['scheme only, no path', 'https://gitlab.example.com'],
])('rejects %s with the URL-format field error', async (_label, repo) => {
  await renderAndFill(repo);
  expect(createMock).not.toHaveBeenCalled();
  expect(screen.getByText(/Must be a Git URL/)).toBeTruthy();
});

it('surfaces a config load failure instead of silently rendering the github default', async () => {
  configGetMock.mockRejectedValue(new Error('boom'));
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(screen.getByText(/Failed to load/)).toBeTruthy());
});

it('preserves line breaks in a multiline create failure', async () => {
  createMock.mockRejectedValue(new Error('project invalid\nrepo: unreachable'));
  await renderAndFill('example-owner/example-repo');
  const banner = await screen.findByText(/project invalid/);
  expect(banner.textContent).toBe('project invalid\nrepo: unreachable');
  expect(banner.classList.contains('whitespace-pre-line')).toBe(true);
});

it('submits the git mode value behind the neutral Git (PR/MR) label', async () => {
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Project ID'), { target: { value: 'gitproj' } });
  fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'example-owner/example-repo' } });
  fireEvent.click(screen.getByLabelText('Git (PR/MR)'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  });
  expect(createMock).toHaveBeenCalledWith({
    id: 'gitproj',
    repo: 'example-owner/example-repo',
    merge: null,
    specApproval: 'human',
    review: { mode: 'git' },
  });
});

it('offers a tool override for an explicit GitHub URL under git mode', async () => {
  configGetMock.mockResolvedValue({
    review: { rounds: 2, mode: 'git' },
    server: { port: 7080 },
    host: [],
    project: [],
  });
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'https://github.com/o/r.git' } });
  expect(await screen.findByLabelText('Git CLI tool')).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'owner/repo' } });
  expect(screen.queryByLabelText('Git CLI tool')).toBeNull();
});

it('hides the git CLI inputs once the effective mode resolves to server', async () => {
  configGetMock.mockResolvedValue({
    review: { rounds: 2, mode: 'server' },
    server: { port: 7080 },
    host: [],
    project: [],
  });
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'https://gitlab.example.com/group/proj.git' } });
  expect(screen.queryByLabelText('Git CLI tool')).toBeNull();
});

it('surfaces the git CLI inputs for a non-github repo under the git default', async () => {
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'https://gitlab.example.com/group/proj.git' } });
  expect(await screen.findByLabelText('Git CLI tool')).toBeTruthy();
});

it('surfaces the git CLI inputs for a non-github repo once the effective mode resolves to git', async () => {
  configGetMock.mockResolvedValue({
    review: { rounds: 2, mode: 'git' },
    server: { port: 7080 },
    host: [],
    project: [],
  });
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Project ID'), { target: { value: 'forgeproj' } });
  fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'https://git.corp.example.com/g/p.git' } });
  const toolInput = await screen.findByLabelText('Git CLI tool');
  fireEvent.change(toolInput, { target: { value: 'forge' } });
  fireEvent.change(screen.getByLabelText('CLI instance notes (optional)'), { target: { value: 'runs behind :8443' } });

  fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'owner/repo' } });
  expect(screen.queryByLabelText('Git CLI tool')).toBeNull();
  fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'https://git.corp.example.com/g/p.git' } });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  });
  expect(createMock).toHaveBeenCalledWith({
    id: 'forgeproj',
    repo: 'https://git.corp.example.com/g/p.git',
    merge: null,
    specApproval: 'human',
    gitCli: { tool: 'forge', notes: 'runs behind :8443' },
  });
});
