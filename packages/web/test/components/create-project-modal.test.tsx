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
  fireEvent.change(screen.getByLabelText('项目 ID'), { target: { value: 'newproj' } });
  fireEvent.change(screen.getByLabelText('Git 仓库地址'), { target: { value: repoValue } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
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
  expect(createMock).toHaveBeenCalledWith({ id: 'newproj', repo, merge: null });
});

it('trims surrounding whitespace before submitting', async () => {
  await renderAndFill('  https://github.com/example-owner/example-repo.git ');
  expect(createMock).toHaveBeenCalledWith({
    id: 'newproj',
    repo: 'https://github.com/example-owner/example-repo.git',
    merge: null,
  });
});

it('submits specApproval human when Spec 需由人类审核 is checked', async () => {
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('项目 ID'), { target: { value: 'specproj' } });
  fireEvent.change(screen.getByLabelText('Git 仓库地址'), { target: { value: 'example-owner/example-repo' } });
  fireEvent.click(screen.getByLabelText('Spec 需由人类审核'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
  });
  expect(createMock).toHaveBeenCalledWith({
    id: 'specproj',
    repo: 'example-owner/example-repo',
    merge: null,
    specApproval: 'human',
  });
});

it('submits an explicit server review mode override', async () => {
  render(<CreateProjectModal open onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(configGetMock).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('项目 ID'), { target: { value: 'serverproj' } });
  fireEvent.change(screen.getByLabelText('Git 仓库地址'), { target: { value: 'example-owner/example-repo' } });
  fireEvent.click(screen.getByLabelText('Server'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
  });
  expect(createMock).toHaveBeenCalledWith({
    id: 'serverproj',
    repo: 'example-owner/example-repo',
    merge: null,
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
  expect(screen.getByText(/需为 git URL/)).toBeTruthy();
});
