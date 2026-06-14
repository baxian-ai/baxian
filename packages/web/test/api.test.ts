import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError, UNAUTHORIZED_EVENT, setAuthToken, clearAuthToken } from '../src/api.ts';

function mockFetchOk(json: unknown = {}) {
  return vi.fn(async () =>
    new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function lastCall(spy: ReturnType<typeof mockFetchOk>): { url: string; init: RequestInit } {
  const [url, init] = spy.mock.calls[spy.mock.calls.length - 1] as [string, RequestInit];
  return { url, init };
}

let fetchSpy: ReturnType<typeof mockFetchOk>;

beforeEach(() => {
  fetchSpy = mockFetchOk({ acceptedAt: '2026-05-06T00:00:00Z' });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('post helper', () => {
  it('omits Content-Type and body for body-less POST (e.g. /restart)', async () => {
    await api.server.restart();
    const { url, init } = lastCall(fetchSpy);
    expect(url).toBe('/api/restart');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('Content-Type');
  });

  it('dispatches a window unauthorized event when a request returns 401', async () => {
    fetchSpy.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener);

    try {
      await expect(api.config.get()).rejects.toBeInstanceOf(ApiError);
    } finally {
      window.removeEventListener(UNAUTHORIZED_EVENT, listener);
    }
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch unauthorized event for non-401 errors', async () => {
    fetchSpy.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener);

    try {
      await expect(api.config.get()).rejects.toBeInstanceOf(ApiError);
    } finally {
      window.removeEventListener(UNAUTHORIZED_EVENT, listener);
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it('setAuthToken logs to console.error when localStorage.setItem throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const setItemSpy = vi
      .spyOn(localStorage, 'setItem')
      .mockImplementation(() => { throw new Error('QuotaExceeded'); });
    try {
      setAuthToken('any-token');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toBeInstanceOf(Error);
    } finally {
      setItemSpy.mockRestore();
      spy.mockRestore();
    }
  });

  it('clearAuthToken logs to console.error when localStorage.removeItem throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const removeItemSpy = vi
      .spyOn(localStorage, 'removeItem')
      .mockImplementation(() => { throw new Error('SecurityError'); });
    try {
      clearAuthToken();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toBeInstanceOf(Error);
    } finally {
      removeItemSpy.mockRestore();
      spy.mockRestore();
    }
  });

  it('sets Content-Type and serializes body for POSTs with payload', async () => {
    fetchSpy.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ id: 'task-1' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await api.tasks.create({
      projectId: 'p1',
      title: 't',
      description: 'd',
      preferredAgentId: 'a1',
    });
    const { url, init } = lastCall(fetchSpy);
    expect(url).toBe('/api/tasks');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(
      JSON.stringify({ projectId: 'p1', title: 't', description: 'd', preferredAgentId: 'a1' }),
    );
  });
});

describe('tasks query', () => {
  it('tasks.list fetches active + pending separately and merges them', async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      const body = url.includes('category=active')
        ? { tasks: [{ id: 'a-1' }], hasMore: false, nextOffset: 1 }
        : { tasks: [{ id: 'p-1' }], hasMore: false, nextOffset: 1 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const tasks = await api.tasks.list('proj-1');
    expect(tasks.map((t) => (t as { id: string }).id).sort()).toEqual(['a-1', 'p-1']);
    const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain('/api/tasks?projectId=proj-1&category=active&offset=0');
    expect(urls).toContain('/api/tasks?projectId=proj-1&category=pending&offset=0');
  });

  it('tasks.list pages each category to completion (stable id-paged 待处理 drops nothing)', async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      let body: unknown;
      if (url.includes('category=active')) {
        body = { tasks: [{ id: 'a-1' }], hasMore: false, nextOffset: 1 };
      } else if (url.includes('offset=20')) {
        body = { tasks: [{ id: 'p-21' }], hasMore: false, nextOffset: 21 };
      } else {
        body = { tasks: Array.from({ length: 20 }, (_, i) => ({ id: `p-${i + 1}` })), hasMore: true, nextOffset: 20 };
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const tasks = await api.tasks.list('proj-1');
    expect(tasks).toHaveLength(22); // 1 active + 21 pending
    expect(tasks.map((t) => (t as { id: string }).id)).toContain('p-21');
    const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain('/api/tasks?projectId=proj-1&category=pending&offset=20');
  });

  it('tasks.list de-dupes by id across pages', async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      // active returns the same id twice across two pages — must collapse to one.
      const body = url.includes('category=active')
        ? (url.includes('offset=20')
          ? { tasks: [{ id: 'dup' }], hasMore: false, nextOffset: 21 }
          : { tasks: Array.from({ length: 19 }, (_, i) => ({ id: `a-${i}` })).concat([{ id: 'dup' }]), hasMore: true, nextOffset: 20 })
        : { tasks: [], hasMore: false, nextOffset: 0 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const tasks = await api.tasks.list('proj-1');
    const ids = tasks.map((t) => (t as { id: string }).id);
    expect(ids.filter((id) => id === 'dup')).toHaveLength(1);
  });

  it('tasks.page requests a category with offset', async () => {
    fetchSpy.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ tasks: [], hasMore: false, nextOffset: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await api.tasks.page('proj-1', { category: 'done', offset: 20 });
    const { url } = lastCall(fetchSpy);
    expect(url).toBe('/api/tasks?projectId=proj-1&category=done&offset=20');
  });

  it('tasks.page defaults offset to 0 and omits category when not given', async () => {
    fetchSpy.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ tasks: [], hasMore: false, nextOffset: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await api.tasks.page('proj-1');
    const { url } = lastCall(fetchSpy);
    expect(url).toBe('/api/tasks?projectId=proj-1&offset=0');
  });

  it('tasks.page builds active/pending category URLs', async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ tasks: [], hasMore: false, nextOffset: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await api.tasks.page('p', { category: 'active' });
    expect(lastCall(fetchSpy).url).toBe('/api/tasks?projectId=p&category=active&offset=0');
    await api.tasks.page('p', { category: 'pending', offset: 40 });
    expect(lastCall(fetchSpy).url).toBe('/api/tasks?projectId=p&category=pending&offset=40');
  });
});

describe('image upload', () => {
  it('agents.uploadImage encodes the file to base64 and POSTs it', async () => {
    const spy = mockFetchOk({ path: '/tmp/baxian/upload/dev-1/x.png' });
    vi.stubGlobal('fetch', spy);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const file = new File([bytes], 'shot.png', { type: 'image/png' });

    const res = await api.agents.uploadImage('dev-1', file);

    expect(res.path).toBe('/tmp/baxian/upload/dev-1/x.png');
    const { url, init } = lastCall(spy);
    expect(url).toBe('/api/agents/dev-1/images');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { dataBase64: string };
    expect(body.dataBase64).toBe(btoa(String.fromCharCode(...bytes)));
  });

  it('tasks.create forwards images through the request body', async () => {
    const spy = mockFetchOk({ id: 'task-1' });
    vi.stubGlobal('fetch', spy);

    await api.tasks.create({
      projectId: 'p', title: 't', description: 'd',
      images: [{ dataBase64: 'AAA' }],
    });

    const { url, init } = lastCall(spy);
    expect(url).toBe('/api/tasks');
    const body = JSON.parse(init.body as string) as { images: unknown };
    expect(body.images).toEqual([{ dataBase64: 'AAA' }]);
  });
});
