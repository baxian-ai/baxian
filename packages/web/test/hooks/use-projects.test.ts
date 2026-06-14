import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { __resetProjectsCacheForTests, refreshProjects, useProjects } from '../../src/hooks/use-projects.ts';
import type { ProjectConfig } from '../../src/shared/index.js';

const listMock = vi.fn();

vi.mock('../../src/api.ts', () => ({
  api: {
    projects: {
      list: () => listMock(),
    },
  },
  UNAUTHORIZED_EVENT: 'baxian:unauthorized',
}));

function makeProject(id: string): ProjectConfig {
  return { id, repo: `me/${id}`, merge: { strategy: 'squash' }, agent: [] } as unknown as ProjectConfig;
}

describe('useProjects', () => {
  beforeEach(() => {
    __resetProjectsCacheForTests();
    listMock.mockReset();
  });

  afterEach(() => {
    __resetProjectsCacheForTests();
  });

  it('fetches once on first mount and exposes the resolved list', async () => {
    listMock.mockResolvedValueOnce([makeProject('alpha')]);
    const { result } = renderHook(() => useProjects());
    expect(result.current.projects).toBeNull();
    await act(async () => { await refreshProjects(); });
    expect(result.current.projects).toEqual([makeProject('alpha')]);
    expect(result.current.error).toBeNull();
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('shares cache across consumers and propagates refresh to all subscribers', async () => {
    listMock.mockResolvedValueOnce([makeProject('alpha')]);
    const a = renderHook(() => useProjects());
    const b = renderHook(() => useProjects());
    await act(async () => { await refreshProjects(); });
    expect(a.result.current.projects?.map((p) => p.id)).toEqual(['alpha']);
    expect(b.result.current.projects?.map((p) => p.id)).toEqual(['alpha']);

    listMock.mockResolvedValueOnce([makeProject('alpha'), makeProject('beta')]);
    await act(async () => { await b.result.current.refresh(); });
    expect(a.result.current.projects?.map((p) => p.id)).toEqual(['alpha', 'beta']);
    expect(b.result.current.projects?.map((p) => p.id)).toEqual(['alpha', 'beta']);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent refresh calls into a single in-flight request', async () => {
    let resolve!: (v: ProjectConfig[]) => void;
    listMock.mockImplementationOnce(() => new Promise<ProjectConfig[]>((r) => { resolve = r; }));
    renderHook(() => useProjects());
    const p1 = refreshProjects();
    const p2 = refreshProjects();
    expect(p1).toBe(p2);
    expect(listMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve([makeProject('alpha')]);
      await p1;
    });
  });

  it('hook refresh queues a follow-up fetch when called mid-flight (mutation race)', async () => {
    let resolveFirst!: (v: ProjectConfig[]) => void;
    listMock.mockImplementationOnce(() => new Promise<ProjectConfig[]>((r) => { resolveFirst = r; }));
    const { result } = renderHook(() => useProjects());
    expect(listMock).toHaveBeenCalledTimes(1);

    listMock.mockResolvedValueOnce([makeProject('alpha'), makeProject('beta')]);
    let followup!: Promise<void>;
    act(() => {
      followup = result.current.refresh();
    });
    expect(listMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst([makeProject('alpha')]);
      await followup;
    });
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(result.current.projects?.map((p) => p.id)).toEqual(['alpha', 'beta']);
  });

  it('discards a stale pre-auth-reset response so it cannot overwrite the new session cache', async () => {
    let resolveStale!: (v: ProjectConfig[]) => void;
    listMock.mockImplementationOnce(() => new Promise<ProjectConfig[]>((r) => { resolveStale = r; }));
    const { result } = renderHook(() => useProjects());
    expect(listMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new CustomEvent('baxian:unauthorized'));
    });
    expect(result.current.projects).toBeNull();

    listMock.mockResolvedValueOnce([makeProject('beta')]);
    await act(async () => { await refreshProjects(); });
    expect(result.current.projects?.map((p) => p.id)).toEqual(['beta']);

    await act(async () => {
      resolveStale([makeProject('alpha')]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.projects?.map((p) => p.id)).toEqual(['beta']);
  });

  it('clears the shared cache on auth-unauthorized so the next consumer fetches fresh', async () => {
    listMock.mockResolvedValueOnce([makeProject('alpha')]);
    const first = renderHook(() => useProjects());
    await act(async () => { await refreshProjects(); });
    expect(first.result.current.projects?.map((p) => p.id)).toEqual(['alpha']);

    await act(async () => {
      window.dispatchEvent(new CustomEvent('baxian:unauthorized'));
    });
    expect(first.result.current.projects).toBeNull();

    listMock.mockResolvedValueOnce([makeProject('beta')]);
    const second = renderHook(() => useProjects());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(second.result.current.projects?.map((p) => p.id)).toEqual(['beta']);
  });

  it('captures error message on failure and exposes it via the hook', async () => {
    listMock.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useProjects());
    await act(async () => { await refreshProjects(); });
    expect(result.current.error).toBe('network down');
    expect(result.current.projects).toBeNull();
  });
});
