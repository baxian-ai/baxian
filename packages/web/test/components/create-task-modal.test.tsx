import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { AgentSnapshot, ProjectConfig, TaskState } from '../../src/shared/index.js';

vi.mock('../../src/components/toast.tsx', async () => (await import('../helpers/toast-mock.tsx')).createToastMock());
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api, fileToBase64 } from '../../src/api.ts';
import { CreateTaskModal } from '../../src/components/create-task-modal.tsx';
import { TASK_IMAGE_MAX_COUNT } from '../../src/shared/index.ts';
import {
  makeAgent as makeAgentFixture,
  makeProject as makeProjectFixture,
  makeTask as makeTaskFixture,
} from '../helpers/fixtures.ts';

const projectsListMock = vi.mocked(api.projects.list);
const agentsListMock = vi.mocked(api.agents.list);
const tasksCreateMock = vi.mocked(api.tasks.create);
const tasksUpdateMock = vi.mocked(api.tasks.update);
const fileToBase64Mock = vi.mocked(fileToBase64);

const DRAFT_KEY_GLOBAL = 'baxian.draft.createTask:*';
const DRAFT_KEY_BAXIAN = 'baxian.draft.createTask:baxian';

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return makeProjectFixture({
    id: 'baxian',
    repo: 'baxian-ai/baxian',
    merge: 'auto',
    agent: [[
      { id: 'bx-dev', runtime: 'claude-code', role: 'dev', mode: 'local' },
      { id: 'bx-qa', runtime: 'claude-code', role: 'qa', mode: 'local' },
    ]],
    ...overrides,
  });
}

function makeAgent(id: string, overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return makeAgentFixture(id, {
    projectId: 'baxian',
    ...overrides,
  });
}

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return makeTaskFixture({
    id: 'task-100',
    projectId: 'baxian',
    title: 'existing title',
    description: 'existing description',
    preferredAgentId: 'bx-dev',
    agentId: '',
    reviewRound: 0,
    status: 'pending',
    createdAt: '2026-05-26T00:00:00.000Z',
    updatedAt: '2026-05-26T00:00:00.000Z',
    ...overrides,
  });
}

function flushApi(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

type Props = ComponentProps<typeof CreateTaskModal>;
type EditProps = Extract<Props, { mode: 'edit' }>;
type ModalProps = Partial<Exclude<Props, EditProps>> | (Pick<EditProps, 'mode' | 'task'> & Partial<EditProps>);

function renderModal(props: ModalProps = {}) {
  const result = render(
    <MemoryRouter>
      <CreateTaskModal open onClose={() => {}} {...props} />
    </MemoryRouter>,
  );
  return result;
}

async function mountModal(props: ModalProps = {}) {
  const result = renderModal(props);
  await flushApi();
  return result;
}

function seedDraft(key: string, draft: Record<string, unknown>): void {
  localStorage.setItem(key, JSON.stringify(draft));
}

function readDraft(key: string): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(key) as string);
}

function titleInput(): HTMLInputElement {
  return screen.getByLabelText('Title') as HTMLInputElement;
}

function descriptionInput(): HTMLTextAreaElement {
  return screen.getByLabelText('Description（可选）') as HTMLTextAreaElement;
}

function devSelect(): HTMLSelectElement {
  return screen.getByLabelText('Dev Agent') as HTMLSelectElement;
}

function restoreHint(): HTMLElement | null {
  return screen.queryByText('已恢复上次未提交的草稿');
}

beforeEach(() => {
  projectsListMock.mockReset();
  agentsListMock.mockReset();
  tasksCreateMock.mockReset();
  tasksUpdateMock.mockReset();
  fileToBase64Mock.mockResolvedValue('QkFTRTY0');
  projectsListMock.mockResolvedValue([makeProject()]);
  agentsListMock.mockResolvedValue([makeAgent('bx-dev'), makeAgent('bx-qa')]);
});

describe('CreateTaskModal — draft persistence', () => {
  it('opens with empty form when no draft is saved and shows no restore hint', async () => {
    await mountModal();

    expect(titleInput().value).toBe('');
    expect(descriptionInput().value).toBe('');
    expect(restoreHint()).toBeNull();
  });

  it('restores title/description/projectId/preferredAgentId from localStorage and shows the restore hint', async () => {
    seedDraft(DRAFT_KEY_GLOBAL, {
      title: 'half-typed title',
      description: 'half-typed body',
      projectId: 'baxian',
      preferredAgentId: 'bx-dev',
    });
    await mountModal();

    expect(titleInput().value).toBe('half-typed title');
    expect(descriptionInput().value).toBe('half-typed body');
    expect(screen.getByText('已恢复上次未提交的草稿')).toBeTruthy();
  });

  it('writes each input change to localStorage synchronously (no debounce) so even an immediate close right after typing never drops the last keystrokes', async () => {
    const { unmount } = await mountModal();

    fireEvent.change(titleInput(), { target: { value: 'WIP title' } });
    fireEvent.change(descriptionInput(), { target: { value: 'WIP body' } });

    unmount();

    const raw = localStorage.getItem(DRAFT_KEY_GLOBAL);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.title).toBe('WIP title');
    expect(parsed.description).toBe('WIP body');
  });

  it('does not persist a metadata-only draft (only projectId/preferredAgentId set, no user text) and shows no restore hint on the next open', async () => {
    const { unmount } = await mountModal({ projectId: 'baxian' });
    unmount();

    expect(localStorage.getItem(DRAFT_KEY_BAXIAN)).toBeNull();

    await mountModal({ projectId: 'baxian' });

    expect(restoreHint()).toBeNull();
  });

  it('clears the draft from localStorage after a successful task creation', async () => {
    seedDraft(DRAFT_KEY_GLOBAL, {
      title: 'about to submit',
      description: 'about to submit body',
      projectId: 'baxian',
      preferredAgentId: 'bx-dev',
    });
    tasksCreateMock.mockResolvedValue(makeTask({ id: 'task-new' }));

    await mountModal();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '创建' }));
    });
    await waitFor(() => {
      expect(tasksCreateMock).toHaveBeenCalledTimes(1);
    });

    expect(localStorage.getItem(DRAFT_KEY_GLOBAL)).toBeNull();
  });

  it('"丢弃" button removes the saved draft and resets the form to blank', async () => {
    seedDraft(DRAFT_KEY_GLOBAL, {
      title: 'to discard',
      description: 'to discard body',
      projectId: 'baxian',
      preferredAgentId: 'bx-dev',
    });
    await mountModal();

    fireEvent.click(screen.getByRole('button', { name: '丢弃' }));

    expect(titleInput().value).toBe('');
    expect(descriptionInput().value).toBe('');
    expect(restoreHint()).toBeNull();

    await flushApi();
    expect(localStorage.getItem(DRAFT_KEY_GLOBAL)).toBeNull();
  });

  it('projectIdProp from a project page wins over a draft.projectId from a different context, so the user is never silently switched away from the project they opened the modal in', async () => {
    seedDraft(DRAFT_KEY_BAXIAN, {
      title: 'stale draft',
      description: 'stale body',
      projectId: 'some-other-project',
      preferredAgentId: 'bx-dev',
    });
    await mountModal({ projectId: 'baxian' });

    const persisted = readDraft(DRAFT_KEY_BAXIAN);
    expect(persisted.projectId).toBe('baxian');
    expect(persisted.title).toBe('stale draft');
  });

  it('edit mode never writes or restores a draft (the task itself is the source of truth)', async () => {
    seedDraft(DRAFT_KEY_BAXIAN, {
      title: 'should-not-leak',
      description: 'should-not-leak body',
      projectId: 'baxian',
      preferredAgentId: 'bx-dev',
    });
    await mountModal({
      mode: 'edit',
      task: makeTask({ title: 'real title', description: 'real description' }),
    });

    expect(titleInput().value).toBe('real title');
    expect(descriptionInput().value).toBe('real description');
    expect(restoreHint()).toBeNull();

    fireEvent.change(titleInput(), { target: { value: 'edited' } });
    await flushApi();

    expect(readDraft(DRAFT_KEY_BAXIAN).title).toBe('should-not-leak');
  });

  it('restores draft and does not wipe localStorage when mounted inside <StrictMode> (which runs effects twice in dev — the real app entry is wrapped this way)', async () => {
    seedDraft(DRAFT_KEY_GLOBAL, {
      title: 'strict title',
      description: 'strict body',
      projectId: 'baxian',
      preferredAgentId: 'bx-dev',
    });
    render(
      <StrictMode>
        <MemoryRouter>
          <CreateTaskModal open onClose={() => {}} />
        </MemoryRouter>
      </StrictMode>,
    );
    await flushApi();

    expect(titleInput().value).toBe('strict title');
    expect(descriptionInput().value).toBe('strict body');
    expect(screen.getByText('已恢复上次未提交的草稿')).toBeTruthy();

    const persisted = readDraft(DRAFT_KEY_GLOBAL);
    expect(persisted.title).toBe('strict title');
    expect(persisted.description).toBe('strict body');
  });

  it('Dashboard draft (key=*) is restored when reopening from the matching Project page and migrated to the project-specific key', async () => {
    seedDraft(DRAFT_KEY_GLOBAL, {
      title: 'dashboard title',
      description: 'dashboard body',
      projectId: 'baxian',
      preferredAgentId: 'bx-dev',
    });

    await mountModal({ projectId: 'baxian' });

    expect(titleInput().value).toBe('dashboard title');
    expect(descriptionInput().value).toBe('dashboard body');
    expect(screen.getByText('已恢复上次未提交的草稿')).toBeTruthy();

    expect(localStorage.getItem(DRAFT_KEY_GLOBAL)).toBeNull();
    const migrated = readDraft(DRAFT_KEY_BAXIAN);
    expect(migrated.title).toBe('dashboard title');
    expect(migrated.projectId).toBe('baxian');
  });

  it('Dashboard draft (key=*) is NOT restored when reopening from a different Project page (mismatched draft.projectId), and the dashboard draft stays put', async () => {
    seedDraft(DRAFT_KEY_GLOBAL, {
      title: 'dashboard title for project-a',
      description: 'dashboard body',
      projectId: 'project-a',
      preferredAgentId: 'bx-dev',
    });

    await mountModal({ projectId: 'baxian' });

    expect(titleInput().value).toBe('');
    expect(restoreHint()).toBeNull();

    const intact = readDraft(DRAFT_KEY_GLOBAL);
    expect(intact.title).toBe('dashboard title for project-a');
    expect(intact.projectId).toBe('project-a');
  });

  it('restores a saved preferredAgentId from the draft even when projects/agents are still loading (does not silently switch to the first visible dev)', async () => {
    projectsListMock.mockResolvedValue([
      makeProject({
        agent: [[
          { id: 'bx-dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' },
          { id: 'bx-dev-2', runtime: 'claude-code', role: 'dev', mode: 'local' },
        ]],
      }),
    ]);
    agentsListMock.mockResolvedValue([
      makeAgent('bx-dev-1'),
      makeAgent('bx-dev-2'),
    ]);
    seedDraft(DRAFT_KEY_BAXIAN, {
      title: 'has draft',
      description: 'has body',
      projectId: 'baxian',
      preferredAgentId: 'bx-dev-2',
      updatedAt: Date.now(),
    });

    await mountModal({ projectId: 'baxian' });

    expect(devSelect().value).toBe('bx-dev-2');
  });

  it('cross-context migration: if setItem to the project key fails (e.g. quota), the dashboard draft is NOT cleared — no data loss', async () => {
    seedDraft(DRAFT_KEY_GLOBAL, {
      title: 'must-not-lose',
      description: 'body',
      projectId: 'baxian',
      preferredAgentId: 'bx-dev',
      updatedAt: Date.now(),
    });
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation((k: string) => {
      if (k === DRAFT_KEY_BAXIAN) throw new Error('QuotaExceededError');
    });

    try {
      await mountModal({ projectId: 'baxian' });

      expect(titleInput().value).toBe('must-not-lose');
      const intact = readDraft(DRAFT_KEY_GLOBAL);
      expect(intact.title).toBe('must-not-lose');
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('when both project-specific and matching dashboard drafts exist, picks the newer one by updatedAt and consolidates into the project key', async () => {
    const tNow = Date.now();
    seedDraft(DRAFT_KEY_BAXIAN, {
      title: 'older project draft',
      description: 'older body',
      projectId: 'baxian',
      preferredAgentId: 'bx-dev',
      updatedAt: tNow - 60_000,
    });
    seedDraft(DRAFT_KEY_GLOBAL, {
      title: 'newer dashboard draft',
      description: 'newer body',
      projectId: 'baxian',
      preferredAgentId: 'bx-dev',
      updatedAt: tNow,
    });

    await mountModal({ projectId: 'baxian' });

    expect(titleInput().value).toBe('newer dashboard draft');
    expect(localStorage.getItem(DRAFT_KEY_GLOBAL)).toBeNull();
    const persisted = readDraft(DRAFT_KEY_BAXIAN);
    expect(persisted.title).toBe('newer dashboard draft');
  });

  it('when the project-specific draft is newer than the matching dashboard draft, keeps the project draft and clears the stale dashboard key', async () => {
    const tNow = Date.now();
    seedDraft(DRAFT_KEY_BAXIAN, {
      title: 'newer project draft',
      description: 'newer body',
      projectId: 'baxian',
      preferredAgentId: 'bx-dev',
      updatedAt: tNow,
    });
    seedDraft(DRAFT_KEY_GLOBAL, {
      title: 'older dashboard draft',
      description: 'older body',
      projectId: 'baxian',
      preferredAgentId: 'bx-dev',
      updatedAt: tNow - 60_000,
    });

    await mountModal({ projectId: 'baxian' });

    expect(titleInput().value).toBe('newer project draft');
    expect(localStorage.getItem(DRAFT_KEY_GLOBAL)).toBeNull();
  });

  it('clicking the backdrop does not close the modal — guards against the most common path that loses a half-typed draft', async () => {
    const onClose = vi.fn();
    await mountModal({ onClose });

    fireEvent.click(screen.getByRole('presentation'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('CreateTaskModal — images', () => {
  beforeEach(() => {
    projectsListMock.mockResolvedValue([makeProject()]);
    agentsListMock.mockResolvedValue([makeAgent('bx-dev')]);
    tasksCreateMock.mockResolvedValue(makeTask({ id: 'task-img' }));
  });

  const fileInput = (): HTMLInputElement => document.querySelector('input[type=file]') as HTMLInputElement;
  const png = (name: string) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });

  it('lists selected images and removes them', async () => {
    await mountModal({ projectId: 'baxian' });
    await act(async () => { fireEvent.change(fileInput(), { target: { files: [png('a.png')] } }); });
    expect(screen.getByText('a.png')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /移除图片 a.png/ })); });
    expect(screen.queryByText('a.png')).toBeNull();
  });

  it('submits images as {dataBase64, filename} to api.tasks.create', async () => {
    await mountModal({ projectId: 'baxian' });
    fireEvent.change(titleInput(), { target: { value: '按图实现' } });
    fireEvent.change(descriptionInput(), { target: { value: '见附图' } });
    await act(async () => { fireEvent.change(fileInput(), { target: { files: [png('shot.png')] } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '创建' })); });
    await waitFor(() => expect(tasksCreateMock).toHaveBeenCalledTimes(1));
    expect(tasksCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      images: [{ dataBase64: 'QkFTRTY0', filename: 'shot.png' }],
    }));
  });

  it('caps the number of images at the max (soft validation)', async () => {
    await mountModal({ projectId: 'baxian' });
    const many = Array.from({ length: TASK_IMAGE_MAX_COUNT + 2 }, (_, i) => png(`f${i}.png`));
    await act(async () => { fireEvent.change(fileInput(), { target: { files: many } }); });
    expect(screen.getAllByText(/^f\d\.png$/).length).toBe(TASK_IMAGE_MAX_COUNT);
  });

  it('edit mode has no image control', async () => {
    await mountModal({ mode: 'edit', task: makeTask() });
    expect(screen.queryByRole('button', { name: /添加图片/ })).toBeNull();
  });
});

describe('CreateTaskModal — Dev Agent 默认选中第一个 dev', () => {
  it('defaults the Dev select to the first available dev once agents load, with 暂不指定 as the first option', async () => {
    projectsListMock.mockResolvedValue([
      makeProject({
        agent: [[
          { id: 'bx-dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' },
          { id: 'bx-dev-2', runtime: 'claude-code', role: 'dev', mode: 'local' },
        ]],
      }),
    ]);
    agentsListMock.mockResolvedValue([makeAgent('bx-dev-1'), makeAgent('bx-dev-2')]);
    await mountModal({ projectId: 'baxian' });

    const select = devSelect();
    expect(select.value).toBe('bx-dev-1');
    expect(select.querySelector('option')?.textContent).toContain('暂不指定');
  });

  it('submits the defaulted first dev when the user does not change the select', async () => {
    tasksCreateMock.mockResolvedValue(makeTask({ id: 'task-201', preferredAgentId: 'bx-dev' }));
    await mountModal({ projectId: 'baxian' });

    fireEvent.change(titleInput(), { target: { value: '默认 dev' } });
    fireEvent.change(descriptionInput(), { target: { value: '不改 dev 选择' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await flushApi();

    expect(tasksCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      preferredAgentId: 'bx-dev',
      projectId: 'baxian',
    }));
  });

  it('submits with an empty description (description optional)', async () => {
    tasksCreateMock.mockResolvedValue(makeTask({ id: 'task-nodesc', description: '' }));
    await mountModal({ projectId: 'baxian' });

    fireEvent.change(titleInput(), { target: { value: '只填标题' } });
    expect((screen.getByRole('button', { name: '创建' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await flushApi();

    expect(tasksCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      title: '只填标题',
      description: '',
      projectId: 'baxian',
    }));
  });

  it('lets the user re-select 暂不指定 and submits preferredAgentId="" without snapping back to the first dev', async () => {
    tasksCreateMock.mockResolvedValue(makeTask({ id: 'task-200', preferredAgentId: '', agentId: '' }));
    await mountModal({ projectId: 'baxian' });

    const select = devSelect();
    expect(select.value).toBe('bx-dev');
    fireEvent.change(select, { target: { value: '' } });
    await flushApi();
    expect(select.value).toBe('');

    fireEvent.change(titleInput(), { target: { value: '未指派任务' } });
    fireEvent.change(descriptionInput(), { target: { value: '稍后再选 dev' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await flushApi();

    expect(tasksCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      preferredAgentId: '',
      projectId: 'baxian',
    }));
  });

  it('leaves the Dev select on 暂不指定 when the project has no running dev', async () => {
    projectsListMock.mockResolvedValue([
      makeProject({ agent: [[{ id: 'bx-qa', runtime: 'claude-code', role: 'qa', mode: 'local' }]] }),
    ]);
    agentsListMock.mockResolvedValue([makeAgent('bx-qa')]);
    await mountModal({ projectId: 'baxian' });

    expect(devSelect().value).toBe('');
  });

  it('preserves a restored draft that explicitly selected 暂不指定 (empty preferredAgentId) instead of defaulting', async () => {
    seedDraft(DRAFT_KEY_BAXIAN, {
      title: '草稿标题',
      description: '草稿内容',
      projectId: 'baxian',
      preferredAgentId: '',
      updatedAt: Date.now(),
    });
    await mountModal({ projectId: 'baxian' });

    expect(devSelect().value).toBe('');
  });

  it('does not re-default a project the user set to 暂不指定 after switching away and back (global modal)', async () => {
    projectsListMock.mockResolvedValue([
      makeProject({ id: 'proj-a', agent: [[{ id: 'a-dev', runtime: 'claude-code', role: 'dev', mode: 'local' }]] }),
      makeProject({ id: 'proj-b', agent: [[{ id: 'b-dev', runtime: 'claude-code', role: 'dev', mode: 'local' }]] }),
    ]);
    agentsListMock.mockResolvedValue([makeAgent('a-dev'), makeAgent('b-dev')]);
    await mountModal();

    const projectSelect = screen.getByLabelText('Project') as HTMLSelectElement;

    fireEvent.change(projectSelect, { target: { value: 'proj-a' } });
    await waitFor(() => expect(devSelect().value).toBe('a-dev'));

    fireEvent.change(devSelect(), { target: { value: '' } });
    await waitFor(() => expect(devSelect().value).toBe(''));

    fireEvent.change(projectSelect, { target: { value: 'proj-b' } });
    await waitFor(() => expect(devSelect().value).toBe('b-dev'));

    fireEvent.change(projectSelect, { target: { value: 'proj-a' } });
    await waitFor(() => expect(devSelect().value).toBe(''));
  });
});
