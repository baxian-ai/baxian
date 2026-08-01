import type {
  AgentSnapshot,
  AgentConfig,
  AgentRuntime,
  TaskState,
  ProjectConfig,
  BaxianConfig,
  AgentMode,
  HostConfig,
  MergeStrategy,
  SpecApprovalStrategy,
  PrReviewConversation,
  PetMeta,
} from './shared/index.js';

const BASE = '/api';
const TOKEN_KEY = 'baxian.token';

export const UNAUTHORIZED_EVENT = 'baxian:unauthorized';

export function getAuthToken(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null;
  } catch {
    return null;
  }
}

export function setAuthToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch (e) {
    console.error('Failed to save auth token to localStorage', e);
  }
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (e) {
    console.error('Failed to clear auth token from localStorage', e);
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getAuthToken();
  return {
    ...(extra ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export interface ApiErrorDetail {
  path: string;
  message: string;
}

export interface TaskPage {
  tasks: TaskState[];
  hasMore: boolean;
  nextOffset: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function parseApiErrorDetails(value: unknown): ApiErrorDetail[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const details = value.filter((detail): detail is ApiErrorDetail =>
    typeof detail === 'object' && detail !== null
    && typeof (detail as { path?: unknown }).path === 'string'
    && typeof (detail as { message?: unknown }).message === 'string');
  return details.length > 0 ? details : undefined;
}

async function throwApiError(res: Response): Promise<never> {
  const text = await res.text();
  let message = text || `HTTP ${res.status}`;
  let details: ApiErrorDetail[] | undefined;
  try {
    const body = JSON.parse(text) as { error?: string; details?: unknown };
    if (typeof body.error === 'string') message = body.error;
    details = parseApiErrorDetails(body.details);
  } catch {}
  if (details !== undefined) {
    message = `${message}\n${details.map(detail => `${detail.path}: ${detail.message}`).join('\n')}`;
  }
  if (res.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
  throw new ApiError(res.status, message, details);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) await throwApiError(res);
  return res.json();
}

async function fetchHealth(): Promise<{ status: string; startedAt: string }> {
  const res = await fetch('/health');
  if (!res.ok) await throwApiError(res);
  return res.json();
}

async function post<T>(path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
  const hasBody = body !== undefined;
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: hasBody ? authHeaders({ 'Content-Type': 'application/json' }) : authHeaders(),
    body: hasBody ? JSON.stringify(body) : undefined,
    signal: options?.signal,
  });
  if (!res.ok) await throwApiError(res);
  return res.json();
}

async function patch<T>(path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined,
    signal: options?.signal,
  });
  if (!res.ok) await throwApiError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function put<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body ?? null),
  });
  if (!res.ok) await throwApiError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function del<T = void>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) await throwApiError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

const enc = encodeURIComponent;

interface ProbeStatus {
  ok: boolean;
  path?: string;
  message: string;
}

export interface ProbeResponse {
  ssh?: { ok: boolean; message: string };
  tmux: ProbeStatus;
  runtimes: Record<AgentRuntime, ProbeStatus>;
}

export interface TmuxInstallResponse {
  ok: boolean;
  method?: string;
  version?: string;
  message: string;
  tmux: ProbeStatus;
}

export interface AddAgentTeamBody {
  agents: AgentConfig[];
}

export interface HostInput {
  hostname: string;
  port?: number | null;
  alias?: string;
  user?: string;
  password?: string;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('unexpected FileReader result'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export const api = {
  agents: {
    list: () => get<AgentSnapshot[]>('/agents'),
    get: (id: string) => get<AgentSnapshot>(`/agents/${enc(id)}`),
    stop: (id: string) => del(`/agents/${enc(id)}/session`),
    compact: (id: string) => post<{ compacted: boolean }>(`/agents/${enc(id)}/compact`),
    clear: (id: string) => post<{ cleared: boolean }>(`/agents/${enc(id)}/clear`),
    probe: (
      mode: AgentMode,
      target: { host?: HostConfig; hostId?: string } = {},
      options?: { signal?: AbortSignal },
    ) =>
      post<ProbeResponse>('/agents/probe', { mode, host: target.host, hostId: target.hostId }, options),
    installTmux: (mode: AgentMode, target: { host?: HostConfig; hostId?: string } = {}) =>
      post<TmuxInstallResponse>('/agents/install-tmux', { mode, host: target.host, hostId: target.hostId }),
    uploadImage: async (id: string, file: File) =>
      post<{ path: string }>(`/agents/${enc(id)}/images`, { dataBase64: await fileToBase64(file) }),
    setPet: (id: string, petId: string | null) =>
      put<{ petId: string | null }>(`/agents/${enc(id)}/pet`, { petId }),
  },
  pets: {
    list: () => get<PetMeta[]>('/pets'),
    create: async (petJson: unknown, spritesheet: File) =>
      post<PetMeta>('/pets', { petJson, spritesheetBase64: await fileToBase64(spritesheet) }),
    remove: (id: string) => del(`/pets/${enc(id)}`),
    fetchSpritesheet: async (id: string): Promise<Blob> => {
      const res = await fetch(`${BASE}/pets/${enc(id)}/spritesheet`, { headers: authHeaders() });
      if (!res.ok) await throwApiError(res);
      return res.blob();
    },
  },
  tasks: {
    list: async (projectId: string): Promise<TaskState[]> => {
      const byId = new Map<string, TaskState>();
      for (const category of ['active', 'pending'] as const) {
        let offset = 0;
        for (;;) {
          const page = await api.tasks.page(projectId, { category, offset });
          for (const t of page.tasks) byId.set(t.id, t);
          if (!page.hasMore || page.tasks.length === 0) break;
          offset = page.nextOffset;
        }
      }
      return [...byId.values()];
    },
    page: (
      projectId: string,
      opts: { category?: 'active' | 'pending' | 'done'; offset?: number } = {},
    ) => {
      const qs = [`projectId=${enc(projectId)}`];
      if (opts.category) qs.push(`category=${opts.category}`);
      qs.push(`offset=${opts.offset ?? 0}`);
      return get<TaskPage>(`/tasks?${qs.join('&')}`);
    },
    get: (id: string) => get<TaskState>(`/tasks/${enc(id)}`),
    create: (body: {
      projectId: string;
      title: string;
      description: string;
      preferredAgentId?: string;
      images?: { dataBase64: string; filename?: string }[];
    }) => post<TaskState>('/tasks', body),
    update: (
      id: string,
      body: {
        title?: string;
        description?: string;
        preferredAgentId?: string;
        status?: 'cancelled';
      },
    ) => patch<TaskState>(`/tasks/${enc(id)}`, body),
    retry: (id: string) => post<TaskState>(`/tasks/${enc(id)}/retry`),
    advance: (
      id: string,
      body?: {
        executor?: 'dev' | 'qa';
        agentId?: string;
        stage?: 'spec' | 'code';
        actorId?: string;
        prNumber?: number;
        confirmRevoked?: boolean;
        note?: string;
      },
    ) =>
      post<TaskState>(`/tasks/${enc(id)}/advance`, body),
    verdict: (
      id: string,
      body: {
        action: 'approve' | 'request-changes' | 'pass' | 'continue' | 'complete' | 'confirm-merge';
        comments?: string;
        note?: string;
      },
    ) => post<TaskState>(`/tasks/${enc(id)}/verdict`, body),
    prReview: (id: string) =>
      get<PrReviewConversation>(`/tasks/${enc(id)}/pr-review`),
    prReviewRefresh: (id: string) =>
      post<PrReviewConversation>(`/tasks/${enc(id)}/pr-review/refresh`),
  },
  projects: {
    list: () => get<ProjectConfig[]>('/projects'),
    get: (id: string) => get<ProjectConfig>(`/projects/${enc(id)}`),
    create: (body: { id: string; repo: string; merge?: MergeStrategy; specApproval?: SpecApprovalStrategy }) =>
      post<{ project: ProjectConfig; restartRequired: boolean }>('/projects', body),
    delete: (id: string) =>
      del<{ removed: string; restartRequired: boolean }>(`/projects/${enc(id)}`),
    addAgentTeam: (projectId: string, body: AddAgentTeamBody) =>
      post<{ agents: AgentConfig[]; restartRequired: boolean; warnings?: string[] }>(
        `/projects/${enc(projectId)}/agents`,
        body,
      ),
    replaceAgent: (projectId: string, agentId: string, body: AgentConfig) =>
      put<{ agent: AgentConfig; replaced: string; restartRequired: boolean; warnings?: string[] }>(
        `/projects/${enc(projectId)}/agents/${enc(agentId)}`,
        body,
      ),
    deleteAgent: (projectId: string, agentId: string) =>
      del<{ removed: string[]; restartRequired: boolean; warnings?: string[] }>(
        `/projects/${enc(projectId)}/agents/${enc(agentId)}`,
      ),
    resumeAgent: (projectId: string, agentId: string) =>
      post<{ agentId: string; resumed: boolean; releasedBinding: boolean; reason?: string }>(
        `/projects/${enc(projectId)}/agents/${enc(agentId)}/resume`,
      ),
    restartRepl: (projectId: string, agentId: string) =>
      post<{ ok: boolean; agentId: string; runtimeStatus?: string; message?: string }>(
        `/projects/${enc(projectId)}/agents/${enc(agentId)}/restart-repl`,
      ),
    retryAgent: (projectId: string, agentId: string) =>
      post<{ ok: boolean; agentId: string; runtimeStatus?: string; message?: string }>(
        `/projects/${enc(projectId)}/agents/${enc(agentId)}/retry`,
      ),
    bootstrap: (projectId: string) =>
      post<{ ok: boolean; ran: number; message?: string }>(
        `/projects/${enc(projectId)}/bootstrap`,
      ),
  },
  hosts: {
    list: () => get<HostConfig[]>('/hosts'),
    create: (body: HostInput) =>
      post<{ host: HostConfig; restartRequired: boolean }>('/hosts', body),
    update: (id: string, body: Partial<HostInput>) =>
      patch<{ host: HostConfig; restartRequired: boolean }>(`/hosts/${enc(id)}`, body),
    delete: (id: string) =>
      del<{ removed: string; restartRequired: boolean }>(`/hosts/${enc(id)}`),
    check: (body: HostInput & { id?: string }) =>
      post<{ ok: boolean; message: string }>('/hosts/check', body),
  },
  config: {
    get: () => get<BaxianConfig>('/config'),
    patch: (body: Partial<BaxianConfig>) =>
      patch<{
        config: BaxianConfig;
        restartRequired: boolean;
        warnings?: Array<{ path: string; message: string }>;
        note: string;
      }>('/config', body),
  },
  health: {
    get: fetchHealth,
  },
  server: {
    restart: () => post<{ acceptedAt: string }>('/restart'),
  },
};
