import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  api,
  ApiError,
  UNAUTHORIZED_EVENT,
  getAuthToken,
  setAuthToken,
  clearAuthToken,
  fileToBase64,
} from '../src/api.ts';

function jsonResponse(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetchOk(json: unknown = {}) {
  return vi.fn<typeof fetch>(async () => jsonResponse(json));
}

function lastCall(spy: ReturnType<typeof mockFetchOk>): { url: string; init: RequestInit } {
  const call = spy.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  const [input, init] = call;
  return { url: String(input), init: init ?? {} };
}

let fetchSpy: ReturnType<typeof mockFetchOk>;

beforeEach(() => {
  fetchSpy = mockFetchOk({ acceptedAt: '2026-05-06T00:00:00Z' });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAuthToken();
});

describe('auth token', () => {
  it('getAuthToken round-trips set/clear through localStorage', () => {
    expect(getAuthToken()).toBeNull();
    setAuthToken('tok-1');
    expect(getAuthToken()).toBe('tok-1');
    clearAuthToken();
    expect(getAuthToken()).toBeNull();
  });

  it('getAuthToken returns null when localStorage.getItem throws', () => {
    const getItemSpy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(getAuthToken()).toBeNull();
    } finally {
      getItemSpy.mockRestore();
    }
  });

  it('attaches Authorization header when a token is present, omits it otherwise', async () => {
    await api.agents.list();
    let headers = lastCall(fetchSpy).init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('Authorization');

    setAuthToken('tok-2');
    await api.agents.list();
    headers = lastCall(fetchSpy).init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-2');
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
});

describe('request contract per endpoint', () => {
  const host = { hostname: 'mac-1', user: 'u' };
  const cases: Array<{
    name: string;
    run: () => Promise<unknown>;
    url: string;
    method?: string;
    body?: unknown;
  }> = [
    { name: 'agents.list', run: () => api.agents.list(), url: '/api/agents' },
    { name: 'agents.get', run: () => api.agents.get('dev/1'), url: '/api/agents/dev%2F1' },
    { name: 'agents.stop', run: () => api.agents.stop('dev-1'), url: '/api/agents/dev-1/session', method: 'DELETE' },
    { name: 'agents.compact', run: () => api.agents.compact('dev-1'), url: '/api/agents/dev-1/compact', method: 'POST' },
    { name: 'agents.clear', run: () => api.agents.clear('dev-1'), url: '/api/agents/dev-1/clear', method: 'POST' },
    {
      name: 'agents.probe',
      run: () => api.agents.probe('local', { hostId: 'h-1' }),
      url: '/api/agents/probe',
      method: 'POST',
      body: { mode: 'local', hostId: 'h-1' },
    },
    {
      name: 'agents.installTmux',
      run: () => api.agents.installTmux('remote', { host }),
      url: '/api/agents/install-tmux',
      method: 'POST',
      body: { mode: 'remote', host },
    },
    {
      name: 'agents.setPet',
      run: () => api.agents.setPet('dev-1', 'cat'),
      url: '/api/agents/dev-1/pet',
      method: 'PUT',
      body: { petId: 'cat' },
    },
    { name: 'pets.list', run: () => api.pets.list(), url: '/api/pets' },
    { name: 'pets.remove', run: () => api.pets.remove('p 1'), url: '/api/pets/p%201', method: 'DELETE' },
    { name: 'tasks.get', run: () => api.tasks.get('t-1'), url: '/api/tasks/t-1' },
    {
      name: 'tasks.update',
      run: () => api.tasks.update('t-1', { title: 'new', status: 'cancelled' }),
      url: '/api/tasks/t-1',
      method: 'PATCH',
      body: { title: 'new', status: 'cancelled' },
    },
    { name: 'tasks.retry', run: () => api.tasks.retry('t-1'), url: '/api/tasks/t-1/retry', method: 'POST' },
    { name: 'tasks.advance', run: () => api.tasks.advance('t-1'), url: '/api/tasks/t-1/advance', method: 'POST' },
    {
      name: 'tasks.advance recovery',
      run: () => api.tasks.advance('t-1', { executor: 'qa', stage: 'spec', actorId: '77', prNumber: 73 }),
      url: '/api/tasks/t-1/advance',
      method: 'POST',
      body: { executor: 'qa', stage: 'spec', actorId: '77', prNumber: 73 },
    },
    {
      name: 'tasks.verdict',
      run: () => api.tasks.verdict('t-1', { action: 'request-changes', comments: 'fix it' }),
      url: '/api/tasks/t-1/verdict',
      method: 'POST',
      body: { action: 'request-changes', comments: 'fix it' },
    },
    { name: 'tasks.prReview', run: () => api.tasks.prReview('t-1'), url: '/api/tasks/t-1/pr-review' },
    { name: 'projects.list', run: () => api.projects.list(), url: '/api/projects' },
    { name: 'projects.get', run: () => api.projects.get('p-1'), url: '/api/projects/p-1' },
    {
      name: 'projects.create',
      run: () => api.projects.create({ id: 'p-1', repo: 'https://x/y.git' }),
      url: '/api/projects',
      method: 'POST',
      body: { id: 'p-1', repo: 'https://x/y.git' },
    },
    { name: 'projects.delete', run: () => api.projects.delete('p-1'), url: '/api/projects/p-1', method: 'DELETE' },
    {
      name: 'projects.addAgentTeam',
      run: () =>
        api.projects.addAgentTeam('p-1', {
          agents: [
            { id: 'dev-3', runtime: 'claude-code', role: 'dev', mode: 'local' },
            { id: 'qa-3', runtime: 'codex', role: 'qa', mode: 'local' },
          ],
        }),
      url: '/api/projects/p-1/agents',
      method: 'POST',
      body: {
        agents: [
          { id: 'dev-3', runtime: 'claude-code', role: 'dev', mode: 'local' },
          { id: 'qa-3', runtime: 'codex', role: 'qa', mode: 'local' },
        ],
      },
    },
    {
      name: 'projects.replaceAgent',
      run: () =>
        api.projects.replaceAgent('p-1', 'qa-3', {
          id: 'qa-4',
          runtime: 'codex',
          role: 'qa',
          mode: 'local',
        }),
      url: '/api/projects/p-1/agents/qa-3',
      method: 'PUT',
      body: { id: 'qa-4', runtime: 'codex', role: 'qa', mode: 'local' },
    },
    {
      name: 'projects.deleteAgent',
      run: () => api.projects.deleteAgent('p-1', 'dev-3'),
      url: '/api/projects/p-1/agents/dev-3',
      method: 'DELETE',
    },
    {
      name: 'projects.resumeAgent',
      run: () => api.projects.resumeAgent('p-1', 'dev-3'),
      url: '/api/projects/p-1/agents/dev-3/resume',
      method: 'POST',
    },
    {
      name: 'projects.restartRepl',
      run: () => api.projects.restartRepl('p-1', 'dev-3'),
      url: '/api/projects/p-1/agents/dev-3/restart-repl',
      method: 'POST',
    },
    {
      name: 'projects.retryAgent',
      run: () => api.projects.retryAgent('p-1', 'dev-3'),
      url: '/api/projects/p-1/agents/dev-3/retry',
      method: 'POST',
    },
    {
      name: 'projects.bootstrap',
      run: () => api.projects.bootstrap('p-1'),
      url: '/api/projects/p-1/bootstrap',
      method: 'POST',
    },
    { name: 'hosts.list', run: () => api.hosts.list(), url: '/api/hosts' },
    {
      name: 'hosts.create',
      run: () => api.hosts.create(host),
      url: '/api/hosts',
      method: 'POST',
      body: host,
    },
    {
      name: 'hosts.update',
      run: () => api.hosts.update('h-1', { alias: 'mini' }),
      url: '/api/hosts/h-1',
      method: 'PATCH',
      body: { alias: 'mini' },
    },
    { name: 'hosts.delete', run: () => api.hosts.delete('h-1'), url: '/api/hosts/h-1', method: 'DELETE' },
    {
      name: 'hosts.check',
      run: () => api.hosts.check({ ...host, id: 'h-1' }),
      url: '/api/hosts/check',
      method: 'POST',
      body: { ...host, id: 'h-1' },
    },
    { name: 'config.get', run: () => api.config.get(), url: '/api/config' },
    { name: 'health.get', run: () => api.health.get(), url: '/health' },
    { name: 'server.restart', run: () => api.server.restart(), url: '/api/restart', method: 'POST' },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.method ?? 'GET'} ${c.url}`, async () => {
      await c.run();
      const { url, init } = lastCall(fetchSpy);
      expect(url).toBe(c.url);
      expect(init.method).toBe(c.method);
      if (c.body !== undefined) {
        expect(JSON.parse(init.body as string)).toEqual(c.body);
      }
    });
  }

  it('pets.fetchSpritesheet returns the raw blob', async () => {
    fetchSpy.mockImplementationOnce(
      async () => new Response('png-bytes', { headers: { 'Content-Type': 'image/png' } }),
    );
    const blob = await api.pets.fetchSpritesheet('cat');
    expect(lastCall(fetchSpy).url).toBe('/api/pets/cat/spritesheet');
    expect(blob.size).toBe('png-bytes'.length);
    expect(blob.type).toBe('image/png');
  });

  it('pets.create encodes the spritesheet file into the body', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await api.pets.create({ id: 'cat' }, new File([bytes], 'cat.png'));
    const { url, init } = lastCall(fetchSpy);
    expect(url).toBe('/api/pets');
    const body = JSON.parse(init.body as string) as { petJson: unknown; spritesheetBase64: string };
    expect(body.petJson).toEqual({ id: 'cat' });
    expect(body.spritesheetBase64).toBe(btoa(String.fromCharCode(...bytes)));
  });
});

describe('response handling helpers', () => {
  it('PATCH resolves undefined on 204 and on empty body', async () => {
    fetchSpy.mockImplementationOnce(async () => new Response(null, { status: 204 }));
    await expect(api.tasks.update('t-1', { title: 'x' })).resolves.toBeUndefined();

    fetchSpy.mockImplementationOnce(async () => new Response('', { status: 200 }));
    await expect(api.tasks.update('t-1', { title: 'x' })).resolves.toBeUndefined();
  });

  it('PUT resolves undefined on 204 and serializes null body fallback', async () => {
    fetchSpy.mockImplementationOnce(async () => new Response(null, { status: 204 }));
    await expect(api.agents.setPet('dev-1', null)).resolves.toBeUndefined();
    expect(lastCall(fetchSpy).init.body).toBe(JSON.stringify({ petId: null }));
  });

  it('DELETE resolves undefined on 204 and parses a JSON body when present', async () => {
    fetchSpy.mockImplementationOnce(async () => new Response(null, { status: 204 }));
    await expect(api.agents.stop('dev-1')).resolves.toBeUndefined();

    fetchSpy.mockImplementationOnce(async () => jsonResponse({ removed: 'p-1', restartRequired: true }));
    await expect(api.projects.delete('p-1')).resolves.toEqual({ removed: 'p-1', restartRequired: true });
  });

  it('throws ApiError with message from JSON error field and structured details', async () => {
    fetchSpy.mockImplementationOnce(async () =>
      jsonResponse({ error: 'title required', details: [{ path: 'title', message: 'required' }] }, 422),
    );
    const err = await api.tasks.get('t-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).message).toBe('title required\ntitle: required');
    expect((err as ApiError).details).toEqual([{ path: 'title', message: 'required' }]);
  });

  it('renders every valid action detail and ignores malformed detail entries', async () => {
    fetchSpy.mockImplementationOnce(async () => jsonResponse({
      error: 'Invalid config',
      details: [
        { path: 'project[0].gitCli.tool', message: 'required for non-GitHub repositories' },
        { path: 7, message: 'invalid path' },
        null,
      ],
    }, 400));
    const err = await api.projects.list().catch((e: unknown) => e) as ApiError;
    expect(err.message).toBe(
      'Invalid config\nproject[0].gitCli.tool: required for non-GitHub repositories',
    );
    expect(err.details).toEqual([
      { path: 'project[0].gitCli.tool', message: 'required for non-GitHub repositories' },
    ]);
  });

  it('falls back to raw text message for non-JSON error bodies', async () => {
    fetchSpy.mockImplementationOnce(async () => new Response('plain failure', { status: 500 }));
    await expect(api.tasks.get('t-1')).rejects.toMatchObject({ status: 500, message: 'plain failure' });
  });

  it('falls back to HTTP <status> message for empty error bodies', async () => {
    fetchSpy.mockImplementationOnce(async () => new Response('', { status: 502 }));
    await expect(api.tasks.get('t-1')).rejects.toMatchObject({ status: 502, message: 'HTTP 502' });
  });
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
    fetchSpy.mockImplementationOnce(async () => jsonResponse({ error: 'Unauthorized' }, 401));
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
    fetchSpy.mockImplementationOnce(async () => jsonResponse({ error: 'boom' }, 500));
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener);

    try {
      await expect(api.config.get()).rejects.toBeInstanceOf(ApiError);
    } finally {
      window.removeEventListener(UNAUTHORIZED_EVENT, listener);
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it('sets Content-Type and serializes body for POSTs with payload', async () => {
    fetchSpy.mockImplementationOnce(async () => jsonResponse({ id: 'task-1' }, 201));
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

  it('forwards AbortSignal to fetch for probe requests', async () => {
    const controller = new AbortController();
    await api.agents.probe('local', {}, { signal: controller.signal });
    expect(lastCall(fetchSpy).init.signal).toBe(controller.signal);
  });
});

describe('tasks query', () => {
  it('tasks.list fetches active + pending separately and merges them', async () => {
    fetchSpy.mockImplementation(async (input) => {
      const body = String(input).includes('category=active')
        ? { tasks: [{ id: 'a-1' }], hasMore: false, nextOffset: 1 }
        : { tasks: [{ id: 'p-1' }], hasMore: false, nextOffset: 1 };
      return jsonResponse(body);
    });
    const tasks = await api.tasks.list('proj-1');
    expect(tasks.map((t) => t.id).sort()).toEqual(['a-1', 'p-1']);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('/api/tasks?projectId=proj-1&category=active&offset=0');
    expect(urls).toContain('/api/tasks?projectId=proj-1&category=pending&offset=0');
  });

  it('tasks.list pages each category to completion (stable id-paged 待处理 drops nothing)', async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      let body: unknown;
      if (url.includes('category=active')) {
        body = { tasks: [{ id: 'a-1' }], hasMore: false, nextOffset: 1 };
      } else if (url.includes('offset=20')) {
        body = { tasks: [{ id: 'p-21' }], hasMore: false, nextOffset: 21 };
      } else {
        body = { tasks: Array.from({ length: 20 }, (_, i) => ({ id: `p-${i + 1}` })), hasMore: true, nextOffset: 20 };
      }
      return jsonResponse(body);
    });

    const tasks = await api.tasks.list('proj-1');
    expect(tasks).toHaveLength(22);
    expect(tasks.map((t) => t.id)).toContain('p-21');
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('/api/tasks?projectId=proj-1&category=pending&offset=20');
  });

  it('tasks.list de-dupes by id across pages', async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      const body = url.includes('category=active')
        ? (url.includes('offset=20')
          ? { tasks: [{ id: 'dup' }], hasMore: false, nextOffset: 21 }
          : { tasks: Array.from({ length: 19 }, (_, i) => ({ id: `a-${i}` })).concat([{ id: 'dup' }]), hasMore: true, nextOffset: 20 })
        : { tasks: [], hasMore: false, nextOffset: 0 };
      return jsonResponse(body);
    });
    const tasks = await api.tasks.list('proj-1');
    const ids = tasks.map((t) => t.id);
    expect(ids.filter((id) => id === 'dup')).toHaveLength(1);
  });

  it('tasks.list stops paging a category when a page returns empty with hasMore=true', async () => {
    fetchSpy.mockImplementation(async (input) => {
      const body = String(input).includes('category=active')
        ? { tasks: [], hasMore: true, nextOffset: 0 }
        : { tasks: [], hasMore: false, nextOffset: 0 };
      return jsonResponse(body);
    });
    await expect(api.tasks.list('proj-1')).resolves.toEqual([]);
  });

  it('tasks.page requests a category with offset', async () => {
    fetchSpy.mockImplementationOnce(async () => jsonResponse({ tasks: [], hasMore: false, nextOffset: 0 }));
    await api.tasks.page('proj-1', { category: 'done', offset: 20 });
    const { url } = lastCall(fetchSpy);
    expect(url).toBe('/api/tasks?projectId=proj-1&category=done&offset=20');
  });

  it('tasks.page defaults offset to 0 and omits category when not given', async () => {
    fetchSpy.mockImplementationOnce(async () => jsonResponse({ tasks: [], hasMore: false, nextOffset: 0 }));
    await api.tasks.page('proj-1');
    const { url } = lastCall(fetchSpy);
    expect(url).toBe('/api/tasks?projectId=proj-1&offset=0');
  });

  it('tasks.page builds active/pending category URLs', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ tasks: [], hasMore: false, nextOffset: 0 }));
    await api.tasks.page('p', { category: 'active' });
    expect(lastCall(fetchSpy).url).toBe('/api/tasks?projectId=p&category=active&offset=0');
    await api.tasks.page('p', { category: 'pending', offset: 40 });
    expect(lastCall(fetchSpy).url).toBe('/api/tasks?projectId=p&category=pending&offset=40');
  });
});

describe('fileToBase64', () => {
  it('strips the data-URL prefix', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await expect(fileToBase64(new File([bytes], 'x.png'))).resolves.toBe(
      btoa(String.fromCharCode(...bytes)),
    );
  });

  it('rejects when the FileReader errors', async () => {
    class FailingReader {
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      error = new Error('disk detached');
      readAsDataURL() {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('FileReader', FailingReader);
    await expect(fileToBase64(new File(['x'], 'x.png'))).rejects.toThrow('disk detached');
  });

  it('rejects on non-string FileReader results', async () => {
    class BinaryReader {
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      result = new ArrayBuffer(4);
      readAsDataURL() {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('FileReader', BinaryReader);
    await expect(fileToBase64(new File(['x'], 'x.png'))).rejects.toThrow('unexpected FileReader result');
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
