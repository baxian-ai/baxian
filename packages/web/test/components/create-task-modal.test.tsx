import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { AgentSnapshot, ProjectConfig, TaskState } from '../../src/shared/index.js';

vi.mock('../../src/components/toast.tsx', () => ({
  useToast: () => ({ show: vi.fn() }),
}));

const projectsListMock = vi.fn();
const agentsListMock = vi.fn();
const tasksCreateMock = vi.fn();
const tasksUpdateMock = vi.fn();
const fileToBase64Mock = vi.fn(async () => 'QkFTRTY0');
vi.mock('../../src/api.ts', () => ({
  api: {
    projects: { list: (...args: unknown[]) => projectsListMock(...args) },
    agents: { list: (...args: unknown[]) => agentsListMock(...args) },
    tasks: {
      create: (...args: unknown[]) => tasksCreateMock(...args),
      update: (...args: unknown[]) => tasksUpdateMock(...args),
    },
  },
  fileToBase64: (...args: unknown[]) => fileToBase64Mock(...args),
}));

import { CreateTaskModal } from '../../src/components/create-task-modal.tsx';
import { TASK_IMAGE_MAX_COUNT } from '../../src/shared/index.ts';

const DRAFT_KEY_GLOBAL = 'baxian.draft.createTask:*';
const DRAFT_KEY_BAXIAN = 'baxian.draft.createTask:baxian';

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'baxian',
    repo: 'baxian-ai/baxian',
    merge: 'auto',
    agent: [[
      { id: 'bx-dev', runtime: 'claude-code', role: 'dev', mode: 'local' },
      { id: 'bx-qa', runtime: 'claude-code', role: 'qa', mode: 'local' },
    ]],
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id,
    projectId: 'baxian',
    runtimeStatus: 'idle',
    tmuxSessionStatus: 'present',
    stale: false,
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
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
  };
}

function flushApi(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  projectsListMock.mockReset();
  agentsListMock.mockReset();
  tasksCreateMock.mockReset();
  tasksUpdateMock.mockReset();
  projectsListMock.mockResolvedValue([makeProject()]);
  agentsListMock.mockResolvedValue([makeAgent('bx-dev'), makeAgent('bx-qa')]);
});

describe('CreateTaskModal — draft persistence', () => {
  it('opens with empty form when no draft is saved and shows no restore hint', async () => {
    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} />
      </MemoryRouter>,
    );
    await flushApi();

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByText('已恢复上次未提交的草稿')).toBeNull();
  });

  it('restores title/description/projectId/preferredAgentId from localStorage and shows the restore hint', async () => {
    localStorage.setItem(
      DRAFT_KEY_GLOBAL,
      JSON.stringify({
        title: 'half-typed title',
        description: 'half-typed body',
        projectId: 'baxian',
        preferredAgentId: 'bx-dev',
      }),
    );
    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} />
      </MemoryRouter>,
    );
    await flushApi();

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('half-typed title');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('half-typed body');
    expect(screen.getByText('已恢复上次未提交的草稿')).toBeTruthy();
  });

  it('writes each input change to localStorage synchronously (no debounce) so even an immediate close right after typing never drops the last keystrokes', async () => {
    const { unmount } = render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} />
      </MemoryRouter>,
    );
    await flushApi();

    const title = screen.getByLabelText('Title') as HTMLInputElement;
    const description = screen.getByLabelText('Description') as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: 'WIP title' } });
    fireEvent.change(description, { target: { value: 'WIP body' } });

    unmount();

    const raw = localStorage.getItem(DRAFT_KEY_GLOBAL);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.title).toBe('WIP title');
    expect(parsed.description).toBe('WIP body');
  });

  it('does not persist a metadata-only draft (only projectId/preferredAgentId set, no user text) and shows no restore hint on the next open', async () => {
    const { unmount } = render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} projectId="baxian" />
      </MemoryRouter>,
    );
    await flushApi();
    unmount();

    expect(localStorage.getItem(DRAFT_KEY_BAXIAN)).toBeNull();

    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} projectId="baxian" />
      </MemoryRouter>,
    );
    await flushApi();

    expect(screen.queryByText('已恢复上次未提交的草稿')).toBeNull();
  });

  it('clears the draft from localStorage after a successful task creation', async () => {
    localStorage.setItem(
      DRAFT_KEY_GLOBAL,
      JSON.stringify({
        title: 'about to submit',
        description: 'about to submit body',
        projectId: 'baxian',
        preferredAgentId: 'bx-dev',
      }),
    );
    tasksCreateMock.mockResolvedValue(makeTask({ id: 'task-new' }));

    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} />
      </MemoryRouter>,
    );
    await flushApi();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '创建' }));
    });
    await waitFor(() => {
      expect(tasksCreateMock).toHaveBeenCalledTimes(1);
    });

    expect(localStorage.getItem(DRAFT_KEY_GLOBAL)).toBeNull();
  });

  it('"丢弃" button removes the saved draft and resets the form to blank', async () => {
    localStorage.setItem(
      DRAFT_KEY_GLOBAL,
      JSON.stringify({
        title: 'to discard',
        description: 'to discard body',
        projectId: 'baxian',
        preferredAgentId: 'bx-dev',
      }),
    );
    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} />
      </MemoryRouter>,
    );
    await flushApi();

    fireEvent.click(screen.getByRole('button', { name: '丢弃' }));

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByText('已恢复上次未提交的草稿')).toBeNull();

    await flushApi();
    expect(localStorage.getItem(DRAFT_KEY_GLOBAL)).toBeNull();
  });

  it('projectIdProp from a project page wins over a draft.projectId from a different context, so the user is never silently switched away from the project they opened the modal in', async () => {
    localStorage.setItem(
      DRAFT_KEY_BAXIAN,
      JSON.stringify({
        title: 'stale draft',
        description: 'stale body',
        projectId: 'some-other-project',
        preferredAgentId: 'bx-dev',
      }),
    );
    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} projectId="baxian" />
      </MemoryRouter>,
    );
    await flushApi();

    const persisted = JSON.parse(localStorage.getItem(DRAFT_KEY_BAXIAN) as string);
    expect(persisted.projectId).toBe('baxian');
    expect(persisted.title).toBe('stale draft');
  });

  it('edit mode never writes or restores a draft (the task itself is the source of truth)', async () => {
    localStorage.setItem(
      DRAFT_KEY_BAXIAN,
      JSON.stringify({
        title: 'should-not-leak',
        description: 'should-not-leak body',
        projectId: 'baxian',
        preferredAgentId: 'bx-dev',
      }),
    );
    render(
      <MemoryRouter>
        <CreateTaskModal
          mode="edit"
          open
          onClose={() => {}}
          task={makeTask({ title: 'real title', description: 'real description' })}
        />
      </MemoryRouter>,
    );
    await flushApi();

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('real title');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('real description');
    expect(screen.queryByText('已恢复上次未提交的草稿')).toBeNull();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'edited' } });
    await flushApi();

    expect(JSON.parse(localStorage.getItem(DRAFT_KEY_BAXIAN) as string).title).toBe('should-not-leak');
  });

  it('restores draft and does not wipe localStorage when mounted inside <StrictMode> (which runs effects twice in dev — the real app entry is wrapped this way)', async () => {
    localStorage.setItem(
      DRAFT_KEY_GLOBAL,
      JSON.stringify({
        title: 'strict title',
        description: 'strict body',
        projectId: 'baxian',
        preferredAgentId: 'bx-dev',
      }),
    );
    render(
      <StrictMode>
        <MemoryRouter>
          <CreateTaskModal open onClose={() => {}} />
        </MemoryRouter>
      </StrictMode>,
    );
    await flushApi();

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('strict title');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('strict body');
    expect(screen.getByText('已恢复上次未提交的草稿')).toBeTruthy();

    const persisted = JSON.parse(localStorage.getItem(DRAFT_KEY_GLOBAL) as string);
    expect(persisted.title).toBe('strict title');
    expect(persisted.description).toBe('strict body');
  });

  it('Dashboard draft (key=*) is restored when reopening from the matching Project page and migrated to the project-specific key', async () => {
    localStorage.setItem(
      DRAFT_KEY_GLOBAL,
      JSON.stringify({
        title: 'dashboard title',
        description: 'dashboard body',
        projectId: 'baxian',
        preferredAgentId: 'bx-dev',
      }),
    );

    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} projectId="baxian" />
      </MemoryRouter>,
    );
    await flushApi();

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('dashboard title');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('dashboard body');
    expect(screen.getByText('已恢复上次未提交的草稿')).toBeTruthy();

    expect(localStorage.getItem(DRAFT_KEY_GLOBAL)).toBeNull();
    const migrated = JSON.parse(localStorage.getItem(DRAFT_KEY_BAXIAN) as string);
    expect(migrated.title).toBe('dashboard title');
    expect(migrated.projectId).toBe('baxian');
  });

  it('Dashboard draft (key=*) is NOT restored when reopening from a different Project page (mismatched draft.projectId), and the dashboard draft stays put', async () => {
    localStorage.setItem(
      DRAFT_KEY_GLOBAL,
      JSON.stringify({
        title: 'dashboard title for project-a',
        description: 'dashboard body',
        projectId: 'project-a',
        preferredAgentId: 'bx-dev',
      }),
    );

    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} projectId="baxian" />
      </MemoryRouter>,
    );
    await flushApi();

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('已恢复上次未提交的草稿')).toBeNull();

    const intact = JSON.parse(localStorage.getItem(DRAFT_KEY_GLOBAL) as string);
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
    localStorage.setItem(
      DRAFT_KEY_BAXIAN,
      JSON.stringify({
        title: 'has draft',
        description: 'has body',
        projectId: 'baxian',
        preferredAgentId: 'bx-dev-2',
        updatedAt: Date.now(),
      }),
    );

    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} projectId="baxian" />
      </MemoryRouter>,
    );
    await flushApi();

    const devSelect = screen.getByLabelText('Dev Agent') as HTMLSelectElement;
    expect(devSelect.value).toBe('bx-dev-2');
  });

  it('cross-context migration: if setItem to the project key fails (e.g. quota), the dashboard draft is NOT cleared — no data loss', async () => {
    localStorage.setItem(
      DRAFT_KEY_GLOBAL,
      JSON.stringify({
        title: 'must-not-lose',
        description: 'body',
        projectId: 'baxian',
        preferredAgentId: 'bx-dev',
        updatedAt: Date.now(),
      }),
    );
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation((k: string) => {
      if (k === DRAFT_KEY_BAXIAN) throw new Error('QuotaExceededError');
    });

    try {
      render(
        <MemoryRouter>
          <CreateTaskModal open onClose={() => {}} projectId="baxian" />
        </MemoryRouter>,
      );
      await flushApi();

      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('must-not-lose');
      const intact = JSON.parse(localStorage.getItem(DRAFT_KEY_GLOBAL) as string);
      expect(intact.title).toBe('must-not-lose');
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('when both project-specific and matching dashboard drafts exist, picks the newer one by updatedAt and consolidates into the project key', async () => {
    const tNow = Date.now();
    localStorage.setItem(
      DRAFT_KEY_BAXIAN,
      JSON.stringify({
        title: 'older project draft',
        description: 'older body',
        projectId: 'baxian',
        preferredAgentId: 'bx-dev',
        updatedAt: tNow - 60_000,
      }),
    );
    localStorage.setItem(
      DRAFT_KEY_GLOBAL,
      JSON.stringify({
        title: 'newer dashboard draft',
        description: 'newer body',
        projectId: 'baxian',
        preferredAgentId: 'bx-dev',
        updatedAt: tNow,
      }),
    );

    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} projectId="baxian" />
      </MemoryRouter>,
    );
    await flushApi();

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('newer dashboard draft');
    expect(localStorage.getItem(DRAFT_KEY_GLOBAL)).toBeNull();
    const persisted = JSON.parse(localStorage.getItem(DRAFT_KEY_BAXIAN) as string);
    expect(persisted.title).toBe('newer dashboard draft');
  });

  it('when the project-specific draft is newer than the matching dashboard draft, keeps the project draft and clears the stale dashboard key', async () => {
    const tNow = Date.now();
    localStorage.setItem(
      DRAFT_KEY_BAXIAN,
      JSON.stringify({
        title: 'newer project draft',
        description: 'newer body',
        projectId: 'baxian',
        preferredAgentId: 'bx-dev',
        updatedAt: tNow,
      }),
    );
    localStorage.setItem(
      DRAFT_KEY_GLOBAL,
      JSON.stringify({
        title: 'older dashboard draft',
        description: 'older body',
        projectId: 'baxian',
        preferredAgentId: 'bx-dev',
        updatedAt: tNow - 60_000,
      }),
    );

    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} projectId="baxian" />
      </MemoryRouter>,
    );
    await flushApi();

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('newer project draft');
    expect(localStorage.getItem(DRAFT_KEY_GLOBAL)).toBeNull();
  });

  it('clicking the backdrop does not close the modal — guards against the most common path that loses a half-typed draft', async () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={onClose} />
      </MemoryRouter>,
    );
    await flushApi();

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
    render(<MemoryRouter><CreateTaskModal open onClose={() => undefined} projectId="baxian" /></MemoryRouter>);
    await flushApi();
    await act(async () => { fireEvent.change(fileInput(), { target: { files: [png('a.png')] } }); });
    expect(screen.getByText('a.png')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /移除图片 a.png/ })); });
    expect(screen.queryByText('a.png')).toBeNull();
  });

  it('submits images as {dataBase64, filename} to api.tasks.create', async () => {
    render(<MemoryRouter><CreateTaskModal open onClose={() => undefined} projectId="baxian" /></MemoryRouter>);
    await flushApi();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '按图实现' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '见附图' } });
    await act(async () => { fireEvent.change(fileInput(), { target: { files: [png('shot.png')] } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '创建' })); });
    await waitFor(() => expect(tasksCreateMock).toHaveBeenCalledTimes(1));
    expect(tasksCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      images: [{ dataBase64: 'QkFTRTY0', filename: 'shot.png' }],
    }));
  });

  it('caps the number of images at the max (soft validation)', async () => {
    render(<MemoryRouter><CreateTaskModal open onClose={() => undefined} projectId="baxian" /></MemoryRouter>);
    await flushApi();
    const many = Array.from({ length: TASK_IMAGE_MAX_COUNT + 2 }, (_, i) => png(`f${i}.png`));
    await act(async () => { fireEvent.change(fileInput(), { target: { files: many } }); });
    expect(screen.getAllByText(/^f\d\.png$/).length).toBe(TASK_IMAGE_MAX_COUNT);
  });

  it('edit mode has no image control', async () => {
    render(<MemoryRouter><CreateTaskModal mode="edit" open onClose={() => undefined} task={makeTask()} /></MemoryRouter>);
    await flushApi();
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
    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} projectId="baxian" />
      </MemoryRouter>,
    );
    await flushApi();

    const select = screen.getByLabelText('Dev Agent') as HTMLSelectElement;
    expect(select.value).toBe('bx-dev-1');
    expect(select.querySelector('option')?.textContent).toContain('暂不指定');
  });

  it('submits the defaulted first dev when the user does not change the select', async () => {
    tasksCreateMock.mockResolvedValue(makeTask({ id: 'task-201', preferredAgentId: 'bx-dev' }));
    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} projectId="baxian" />
      </MemoryRouter>,
    );
    await flushApi();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '默认 dev' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '不改 dev 选择' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await flushApi();

    expect(tasksCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      preferredAgentId: 'bx-dev',
      projectId: 'baxian',
    }));
  });

  it('lets the user re-select 暂不指定 and submits preferredAgentId="" without snapping back to the first dev', async () => {
    tasksCreateMock.mockResolvedValue(makeTask({ id: 'task-200', preferredAgentId: '', agentId: '' }));
    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} projectId="baxian" />
      </MemoryRouter>,
    );
    await flushApi();

    const select = screen.getByLabelText('Dev Agent') as HTMLSelectElement;
    expect(select.value).toBe('bx-dev');
    fireEvent.change(select, { target: { value: '' } });
    await flushApi();
    expect(select.value).toBe('');

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '未指派任务' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '稍后再选 dev' } });
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
    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} projectId="baxian" />
      </MemoryRouter>,
    );
    await flushApi();

    const select = screen.getByLabelText('Dev Agent') as HTMLSelectElement;
    expect(select.value).toBe('');
  });

  it('preserves a restored draft that explicitly selected 暂不指定 (empty preferredAgentId) instead of defaulting', async () => {
    localStorage.setItem(
      DRAFT_KEY_BAXIAN,
      JSON.stringify({
        title: '草稿标题',
        description: '草稿内容',
        projectId: 'baxian',
        preferredAgentId: '',
        updatedAt: Date.now(),
      }),
    );
    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} projectId="baxian" />
      </MemoryRouter>,
    );
    await flushApi();

    const select = screen.getByLabelText('Dev Agent') as HTMLSelectElement;
    expect(select.value).toBe('');
  });

  it('does not re-default a project the user set to 暂不指定 after switching away and back (global modal)', async () => {
    projectsListMock.mockResolvedValue([
      makeProject({ id: 'proj-a', agent: [[{ id: 'a-dev', runtime: 'claude-code', role: 'dev', mode: 'local' }]] }),
      makeProject({ id: 'proj-b', agent: [[{ id: 'b-dev', runtime: 'claude-code', role: 'dev', mode: 'local' }]] }),
    ]);
    agentsListMock.mockResolvedValue([makeAgent('a-dev'), makeAgent('b-dev')]);
    render(
      <MemoryRouter>
        <CreateTaskModal open onClose={() => {}} />
      </MemoryRouter>,
    );
    await flushApi();

    const projectSelect = screen.getByLabelText('Project') as HTMLSelectElement;
    const devSelect = () => screen.getByLabelText('Dev Agent') as HTMLSelectElement;

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
