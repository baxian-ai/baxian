import type { PlatformProvider } from '../../src/platform/types.js';
import type { AgentConfig, BaxianConfig, TaskState } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';

type ConfigOverrides = Omit<Partial<BaxianConfig>, 'review' | 'server'> & {
  review?: Partial<BaxianConfig['review']>;
  server?: Partial<BaxianConfig['server']>;
};

export function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'dev-1',
    runtime: 'claude-code',
    role: 'dev',
    mode: 'local',
    workdir: '/tmp/repo',
    ...structuredClone(overrides),
  };
}

export function makeConfig(overrides: ConfigOverrides = {}): BaxianConfig {
  const defaults: BaxianConfig = {
    review: { rounds: 10 },
    server: { ...DEFAULT_SERVER_CONFIG },
    host: [],
    project: [{
      id: 'proj',
      repo: 'https://github.com/user/repo.git',
      merge: null,
      agent: [[
        makeAgent(),
        makeAgent({
          id: 'qa-1',
          runtime: 'codex',
          role: 'qa',
          workdir: '/tmp/qa-repo',
        }),
      ]],
    }],
  };
  const cloned = structuredClone(overrides);
  return {
    ...defaults,
    ...cloned,
    review: { ...defaults.review, ...cloned.review },
    server: { ...defaults.server, ...cloned.server },
    host: cloned.host ?? defaults.host,
    project: cloned.project ?? defaults.project,
  };
}

export function makePlatformProvider(
  overrides: Partial<PlatformProvider> & { platform: string; claimPrefix?: string },
): PlatformProvider {
  const { claimPrefix, ...rest } = overrides;
  const prefix = claimPrefix ?? `https://${overrides.platform}/`;
  return {
    normalizeRepoUrl: url =>
      (url.startsWith(prefix) ? url.slice(prefix.length).replace(/\.git$/, '') : null),
    createDriver: () => {
      throw new Error('makePlatformProvider stub does not create drivers');
    },
    prompts: { common: 'c', publish: 'p', feedback: 'f', review: 'r' },
    ...rest,
  };
}

export function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const cloned = structuredClone(overrides);
  const id = cloned.id ?? 'task-1';
  const branch = cloned.branch ?? `bx/${id}`;
  return {
    id,
    projectId: 'proj',
    title: 'T',
    description: 'D',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    devAgentId: 'dev-1',
    qaAgentId: 'qa-1',
    branch,
    branchCreatedByBaxian: cloned.branchCreatedByBaxian ?? branch === `bx/${id}`,
    reviewRound: 0,
    platformBinding: { repoKey: 'github.com/user/repo' },
    status: 'in_progress',
    createdAt: '2026-05-14T05:00:00.000Z',
    updatedAt: '2026-05-14T05:00:00.000Z',
    ...cloned,
  };
}
