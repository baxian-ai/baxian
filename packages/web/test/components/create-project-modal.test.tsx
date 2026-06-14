import { it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';

vi.mock('../../src/components/toast.tsx', () => ({
  useToast: () => ({ show: vi.fn() }),
}));
vi.mock('../../src/hooks/use-pending-restart.tsx', () => ({
  usePendingRestart: () => ({ flagDirty: vi.fn() }),
}));

const configGetMock = vi.fn();
const createMock = vi.fn();
vi.mock('../../src/api.ts', () => ({
  api: {
    config: { get: (...a: unknown[]) => configGetMock(...a) },
    projects: { create: (...a: unknown[]) => createMock(...a) },
  },
}));

import { CreateProjectModal } from '../../src/components/create-project-modal.tsx';

beforeEach(() => {
  configGetMock.mockReset().mockResolvedValue({ project: [] });
  createMock.mockReset().mockResolvedValue({ project: { id: 'p' }, restartRequired: false });
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

it.each([
  ['single token, no slash', 'justaname'],
  ['contains a space', 'https://gitlab.example.com/group/ proj'],
  ['scheme only, no path', 'https://gitlab.example.com'],
])('rejects %s with the URL-format field error', async (_label, repo) => {
  await renderAndFill(repo);
  expect(createMock).not.toHaveBeenCalled();
  expect(screen.getByText(/需为 git URL/)).toBeTruthy();
});
