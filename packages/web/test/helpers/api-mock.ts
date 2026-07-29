import { vi } from 'vitest';

type ApiModule = typeof import('../../src/api.ts');

class MockApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function createApiMock(): ApiModule {
  return {
    UNAUTHORIZED_EVENT: 'baxian:unauthorized',
    getAuthToken: vi.fn(),
    setAuthToken: vi.fn(),
    clearAuthToken: vi.fn(),
    fileToBase64: vi.fn(),
    ApiError: MockApiError,
    api: {
      agents: {
        list: vi.fn(),
        get: vi.fn(),
        stop: vi.fn(),
        compact: vi.fn(),
        clear: vi.fn(),
        probe: vi.fn(),
        installTmux: vi.fn(),
        uploadImage: vi.fn(),
        setPet: vi.fn(),
      },
      pets: {
        list: vi.fn(),
        create: vi.fn(),
        remove: vi.fn(),
        fetchSpritesheet: vi.fn(),
      },
      tasks: {
        list: vi.fn(),
        page: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        retry: vi.fn(),
        review: vi.fn(),
        complete: vi.fn(),
        continue: vi.fn(),
        spec: vi.fn(),
        prReview: vi.fn(),
        dispatch: vi.fn(),
      },
      projects: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
        addAgentGroup: vi.fn(),
        replaceAgent: vi.fn(),
        deleteAgent: vi.fn(),
        resumeAgent: vi.fn(),
        restartRepl: vi.fn(),
        retryAgent: vi.fn(),
        bootstrap: vi.fn(),
      },
      hosts: {
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        check: vi.fn(),
      },
      config: {
        get: vi.fn(),
        patch: vi.fn(),
      },
      health: {
        get: vi.fn(),
      },
      server: {
        restart: vi.fn(),
      },
    },
  };
}
