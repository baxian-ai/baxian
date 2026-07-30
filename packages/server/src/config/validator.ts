import { isAbsolute, normalize } from 'node:path';
import { isBareRepoSlug,
  CONTROL_CHAR_RE, TOOL_PATTERN,
  hasEmbeddedCredentials, isGitHubRepo, isRecord, isSafeGitHost, parseGitRemote, repoIdentityKey, repoSlug,
  type BaxianConfig, type AgentRole, type AgentRuntime, type AgentMode, type MergeStrategy, type ProjectConfig, type SpecApprovalStrategy,
} from '../shared/index.js';
import { mayShareHostAccount, resolveAgentHost } from '../agent/runner.js';

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationWarning {
  path: string;
  message: string;
}

const VALID_RUNTIMES: AgentRuntime[] = ['claude-code', 'codex', 'opencode', 'qodercli'];
const VALID_ROLES: AgentRole[] = ['dev', 'qa'];
const VALID_MODES: AgentMode[] = ['local', 'remote'];
const VALID_MERGE: MergeStrategy[] = ['auto', null];
const VALID_SPEC_APPROVAL: Array<SpecApprovalStrategy | undefined> = ['human', null, undefined];
const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const TOP_LEVEL_FIELDS = new Set(['language', 'review', 'server', 'host', 'project']);
const REVIEW_FIELDS = new Set(['rounds']);
const SERVER_FIELDS = new Set([
  'port', 'host', 'token', 'https', 'allowedHosts', 'githubPollIntervalMs',
  'tmuxProbePollIntervalMs', 'tmuxProbeTimeoutMs', 'tmuxProbeConcurrency',
  'bootstrapRetryIntervalMs', 'dispatchReconcileIntervalMs', 'dispatchBusyWaitBudgetMs',
  'dispatchReconcileMaxAttempts',
]);
const PROJECT_FIELDS = new Set(['id', 'repo', 'merge', 'specApproval', 'gitCli', 'agent']);
const AGENT_FIELDS = new Set([
  'id', 'runtime', 'mode', 'host', 'workdir', 'yolo', 'model', 'addDirs', 'role',
]);

function unknownKeyWarnings(
  value: unknown,
  allowed: ReadonlySet<string>,
  prefix: string,
): ValidationWarning[] {
  if (!isRecord(value)) return [];
  return Object.keys(value)
    .filter(key => !allowed.has(key))
    .map(key => ({
      path: prefix === '' ? key : `${prefix}.${key}`,
      message: 'unknown configuration key; it will be ignored',
    }));
}

export function collectUnknownConfigWarnings(config: Record<string, unknown>): ValidationWarning[] {
  const warnings = [
    ...unknownKeyWarnings(config, TOP_LEVEL_FIELDS, ''),
    ...unknownKeyWarnings(config.review, REVIEW_FIELDS, 'review'),
    ...unknownKeyWarnings(config.server, SERVER_FIELDS, 'server'),
  ];
  if (!Array.isArray(config.project)) return warnings;
  config.project.forEach((project, projectIndex) => {
    const projectPath = `project[${projectIndex}]`;
    warnings.push(...unknownKeyWarnings(project, PROJECT_FIELDS, projectPath));
    if (!isRecord(project) || !Array.isArray(project.agent)) return;
    project.agent.forEach((team, teamIndex) => {
      if (!Array.isArray(team)) return;
      team.forEach((agent, agentIndex) => {
        warnings.push(...unknownKeyWarnings(
          agent,
          AGENT_FIELDS,
          `${projectPath}.agent[${teamIndex}][${agentIndex}]`,
        ));
      });
    });
  });
  return warnings;
}

function isValidRepo(repo: string): boolean {
  if (isGitHubRepo(repo)) return REPO_SLUG_PATTERN.test(repoSlug(repo));
  const parsed = parseGitRemote(repo);
  if (!parsed || parsed.path === '' || !isSafeGitHost(parsed.host)) return false;
  return parsed.path.split('/').every(seg => REPO_SEGMENT_PATTERN.test(seg));
}

export function validateConfig(config: BaxianConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!Array.isArray(config.project)) {
    errors.push({ path: 'project', message: 'project must be an array' });
    return errors;
  }

  validateGlobals(config, errors);
  validateHosts(config, errors);
  validateProjectFields(config, errors);
  validatePlatformProjects(config, errors);
  validatePlatformRepoUniqueness(config, errors);
  validateProjectIds(config, errors);
  validateAgentFields(config, errors);
  validateAgentIds(config, errors);
  validateAgentWorkdirUniqueness(config, errors);
  validateAgentTeams(config, errors);
  validateRemoteHosts(config, errors);

  return errors;
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

export function resolveProjectTool(project: ProjectConfig): string | undefined {
  if (isRecord(project.gitCli) && typeof project.gitCli.tool === 'string') return project.gitCli.tool;
  return nonEmptyString(project.repo) && isGitHubRepo(project.repo) ? 'gh' : undefined;
}

export function projectNeedsPlatformEntry(_config: BaxianConfig, project: ProjectConfig): boolean {
  return resolveProjectTool(project) !== undefined;
}

function validateGlobals(config: BaxianConfig, errors: ValidationError[]): void {
  const language = config.language as unknown;
  if (language !== undefined && language !== 'zh-CN' && language !== 'en-US') {
    errors.push({ path: 'language', message: "language must be 'zh-CN' or 'en-US'" });
  }
  if (!Number.isInteger(config.server.port) || config.server.port <= 0 || config.server.port > 65535) {
    errors.push({ path: 'server.port', message: 'server.port must be a positive integer ≤ 65535' });
  }
  validateOptionalBoundedInteger(
    config.server.tmuxProbePollIntervalMs,
    'server.tmuxProbePollIntervalMs',
    1000,
    2_147_483_647,
    errors,
  );
  validateOptionalPositiveInteger(
    config.server.tmuxProbeTimeoutMs,
    'server.tmuxProbeTimeoutMs',
    errors,
  );
  validateOptionalPositiveInteger(
    config.server.tmuxProbeConcurrency,
    'server.tmuxProbeConcurrency',
    errors,
  );
  validateOptionalBoundedInteger(
    config.server.bootstrapRetryIntervalMs,
    'server.bootstrapRetryIntervalMs',
    1000,
    2_147_483_647,
    errors,
  );
  validateOptionalBoundedInteger(
    config.server.dispatchReconcileIntervalMs,
    'server.dispatchReconcileIntervalMs',
    1000,
    2_147_483_647,
    errors,
  );
  validateOptionalPositiveInteger(
    config.server.dispatchBusyWaitBudgetMs,
    'server.dispatchBusyWaitBudgetMs',
    errors,
  );
  validateOptionalPositiveInteger(
    config.server.dispatchReconcileMaxAttempts,
    'server.dispatchReconcileMaxAttempts',
    errors,
  );
  validateOptionalBoundedInteger(
    config.server.githubPollIntervalMs,
    'server.githubPollIntervalMs',
    1000,
    2_147_483_647,
    errors,
  );
  if (!Number.isInteger(config.review.rounds) || config.review.rounds <= 0) {
    errors.push({ path: 'review.rounds', message: 'review.rounds must be a positive integer' });
  }
  if (config.server.https !== undefined) {
    const https = config.server.https as unknown;
    if (typeof https !== 'object' || https === null || Array.isArray(https)) {
      errors.push({
        path: 'server.https',
        message: 'server.https must be an object with keyFile and certFile',
      });
    } else {
      for (const field of ['keyFile', 'certFile'] as const) {
        const value = (https as Record<string, unknown>)[field];
        if (!nonEmptyString(value)) {
          errors.push({
            path: `server.https.${field}`,
            message: `server.https.${field} must be a non-empty string`,
          });
          continue;
        }
        if (!isAbsolute(value as string)) {
          errors.push({
            path: `server.https.${field}`,
            message: `server.https.${field} must be an absolute path`,
          });
        }
      }
    }
  }
  if (config.server.allowedHosts !== undefined) {
    if (!Array.isArray(config.server.allowedHosts)) {
      errors.push({ path: 'server.allowedHosts', message: 'server.allowedHosts must be an array of non-empty strings' });
    } else {
      for (let i = 0; i < config.server.allowedHosts.length; i++) {
        if (!nonEmptyString(config.server.allowedHosts[i])) {
          errors.push({
            path: `server.allowedHosts[${i}]`,
            message: 'server.allowedHosts[*] must be a non-empty string',
          });
        }
      }
    }
  }
}

function validatePlatformRepoUniqueness(config: BaxianConfig, errors: ValidationError[]): void {
  const seen = new Map<string, string>();
  config.project.forEach((project, i) => {
    if (!nonEmptyString(project.repo) || !projectNeedsPlatformEntry(config, project)) return;
    const norm = repoIdentityKey(project.repo);
    const prev = seen.get(norm);
    if (prev !== undefined) {
      errors.push({
        path: `project[${i}].repo`,
        message: `normalized repo URL must be unique across platform-polled projects (already used by project '${prev}')`,
      });
    } else {
      seen.set(norm, project.id);
    }
  });
}

function validatePlatformProjects(config: BaxianConfig, errors: ValidationError[]): void {
  config.project.forEach((project, i) => {
    const path = `project[${i}]`;
    const gitCli = project.gitCli;

    if (!nonEmptyString(project.repo)) return;

    if (!isGitHubRepo(project.repo)) {
      if (!/^https?:\/\//i.test(project.repo)) {
        errors.push({
          path: `${path}.repo`,
          message: 'non-GitHub repos require an http(s):// repo URL because the platform driver derives its API endpoint from it',
        });
      } else {
        try {
          new URL(project.repo);
        } catch {
          errors.push({ path: `${path}.repo`, message: 'repo is not a parseable URL' });
        }
      }

      if (gitCli === undefined) {
        errors.push({
          path: `${path}.gitCli`,
          message: 'non-GitHub repos require gitCli.tool and a matching git-driver plugin under <home>/plugins/',
        });
      }
    } else if (isBareRepoSlug(project.repo) && resolveProjectTool(project) !== 'gh') {
      errors.push({
        path: `${path}.repo`,
        message: "a bare owner/repo slug requires the resolved tool 'gh' (plain git cannot clone a bare slug) — declare the full https:// or ssh URL, or drop gitCli.tool",
      });
    }

  });
}

function validateOptionalPositiveInteger(
  value: number | undefined,
  path: string,
  errors: ValidationError[],
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) {
    errors.push({ path, message: `${path} must be a positive integer` });
  }
}

function validateOptionalBoundedInteger(
  value: number | undefined,
  path: string,
  min: number,
  max: number,
  errors: ValidationError[],
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push({ path, message: `${path} must be an integer in [${min}, ${max}]` });
  }
}

function validateProjectFields(config: BaxianConfig, errors: ValidationError[]): void {
  for (let i = 0; i < config.project.length; i++) {
    const project = config.project[i];
    const path = `project[${i}]`;
    if (!nonEmptyString(project.id)) {
      errors.push({ path: `${path}.id`, message: 'project.id must be a non-empty string' });
    } else if (!ID_PATTERN.test(project.id)) {
      errors.push({ path: `${path}.id`, message: 'project.id must match /^[a-z][a-z0-9-]{1,31}$/' });
    }
    if (!nonEmptyString(project.repo)) {
      errors.push({ path: `${path}.repo`, message: 'project.repo must be a non-empty string' });
    } else if (CONTROL_CHAR_RE.test(project.repo)) {
      errors.push({ path: `${path}.repo`, message: 'project.repo must not contain control characters' });
    } else if (hasEmbeddedCredentials(project.repo)) {
      errors.push({
        path: `${path}.repo`,
        message:
          'project.repo must not embed credentials in the URL (e.g. "https://user:token@host/…" '
          + 'or "ssh://user:secret@host/…"). Configure auth via a git credential helper, an SSH key, '
          + 'or GITLAB_TOKEN so the secret stays out of the config file, API responses, and logs.',
      });
    } else if (!isValidRepo(project.repo)) {
      errors.push({
        path: `${path}.repo`,
        message:
          'project.repo must be a git URL (https / ssh / scp) or legacy "owner/repo". '
          + 'GitHub uses the "owner/repo" single-segment form; non-GitHub hosts accept a parseable '
          + 'host with a path whose segments match [A-Za-z0-9_-][A-Za-z0-9._-]* (no empty / "." / ".." segments).',
      });
    }
    if (!VALID_MERGE.includes(project.merge)) {
      errors.push({ path: `${path}.merge`, message: 'project.merge must be "auto" or null' });
    }
    if (!VALID_SPEC_APPROVAL.includes(project.specApproval)) {
      errors.push({ path: `${path}.specApproval`, message: 'project.specApproval must be "human" or null' });
    }
    if (!Array.isArray(project.agent)) {
      errors.push({ path: `${path}.agent`, message: 'project.agent must be an array of Agent Teams' });
    }
    validateGitCliShape(project, path, errors);
  }
}

function validateGitCliShape(project: ProjectConfig, path: string, errors: ValidationError[]): void {
  const gitCli = project.gitCli;
  if (gitCli === undefined) return;
  if (!isRecord(gitCli)) {
    errors.push({ path: `${path}.gitCli`, message: 'gitCli must be an object' });
    return;
  }
  if (typeof gitCli.tool !== 'string' || !TOOL_PATTERN.test(gitCli.tool)) {
    errors.push({ path: `${path}.gitCli.tool`, message: `gitCli.tool must match ${TOOL_PATTERN}` });
  }
  if (gitCli.binary !== undefined
    && (typeof gitCli.binary !== 'string' || !isAbsolute(gitCli.binary) || CONTROL_CHAR_RE.test(gitCli.binary))) {
    errors.push({ path: `${path}.gitCli.binary`, message: 'gitCli.binary must be an absolute path without control characters' });
  }
  if (gitCli.notes !== undefined
    && (typeof gitCli.notes !== 'string' || CONTROL_CHAR_RE.test(gitCli.notes))) {
    errors.push({ path: `${path}.gitCli.notes`, message: 'gitCli.notes must be a string without control characters' });
  }
}

function validateProjectIds(config: BaxianConfig, errors: ValidationError[]): void {
  const seen = new Set<string>();
  for (const project of config.project) {
    if (seen.has(project.id)) {
      errors.push({
        path: `project.${project.id}`,
        message: `Duplicate project id: ${project.id}`,
      });
    }
    seen.add(project.id);
  }
}

function validateAgentFields(config: BaxianConfig, errors: ValidationError[]): void {
  for (const project of config.project) {
    if (!Array.isArray(project.agent)) continue;
    for (let i = 0; i < project.agent.length; i++) {
      const team = project.agent[i];
      if (!Array.isArray(team)) continue;
      for (let j = 0; j < team.length; j++) {
        const agent = team[j];
        const path = `project.${project.id}.agent[${i}][${j}]`;
        if (!nonEmptyString(agent.id)) {
          errors.push({ path: `${path}.id`, message: 'agent.id must be a non-empty string' });
        } else if (!ID_PATTERN.test(agent.id)) {
          errors.push({ path: `${path}.id`, message: 'agent.id must match /^[a-z][a-z0-9-]{1,31}$/' });
        }
        if (!VALID_RUNTIMES.includes(agent.runtime)) {
          errors.push({
            path: `${path}.runtime`,
            message: `agent.runtime must be one of: ${VALID_RUNTIMES.join(', ')}`,
          });
        }
        if (!VALID_ROLES.includes(agent.role)) {
          errors.push({
            path: `${path}.role`,
            message: `agent.role must be one of: ${VALID_ROLES.join(', ')}`,
          });
        }
        if (!VALID_MODES.includes(agent.mode)) {
          errors.push({
            path: `${path}.mode`,
            message: `agent.mode must be one of: ${VALID_MODES.join(', ')}`,
          });
        }
        if (agent.workdir !== undefined && !nonEmptyString(agent.workdir)) {
          errors.push({ path: `${path}.workdir`, message: 'agent.workdir, when set, must be a non-empty string' });
        } else if (agent.workdir !== undefined && !isAbsolute(agent.workdir)) {
          errors.push({ path: `${path}.workdir`, message: 'agent.workdir must be an absolute path' });
        }
        if (agent.model !== undefined && !nonEmptyString(agent.model)) {
          errors.push({
            path: `${path}.model`,
            message: 'agent.model, when set, must be a non-empty string',
          });
        }
        if (agent.addDirs !== undefined) {
          if (!Array.isArray(agent.addDirs)) {
            errors.push({
              path: `${path}.addDirs`,
              message: 'agent.addDirs, when set, must be an array of non-empty strings',
            });
          } else {
            for (let k = 0; k < agent.addDirs.length; k++) {
              if (!nonEmptyString(agent.addDirs[k])) {
                errors.push({
                  path: `${path}.addDirs[${k}]`,
                  message: 'agent.addDirs[*] must be a non-empty string',
                });
              }
            }
          }
        }
        if (agent.runtime === 'opencode' && Array.isArray(agent.addDirs) && agent.addDirs.length > 0) {
          errors.push({
            path: `${path}.addDirs`,
            message: 'agent.addDirs is not supported for opencode runtime; opencode has no --add-dir, grant extra roots via its permission config',
          });
        }
        if (agent.yolo !== undefined && typeof agent.yolo !== 'boolean') {
          errors.push({
            path: `${path}.yolo`,
            message: 'agent.yolo must be a boolean if present',
          });
        }
      }
    }
  }
}

function validateAgentIds(config: BaxianConfig, errors: ValidationError[]): void {
  const seen = new Set<string>();
  for (const project of config.project) {
    for (const team of project.agent) {
      for (const agent of team) {
        if (seen.has(agent.id)) {
          errors.push({
            path: `project.${project.id}.agent.${agent.id}`,
            message: `Duplicate agent id: ${agent.id}`,
          });
        }
        seen.add(agent.id);
      }
    }
  }
}

function validateAgentWorkdirUniqueness(config: BaxianConfig, errors: ValidationError[]): void {
  const hosts = Array.isArray(config.host) ? config.host : [];
  const seen: Array<{
    id: string;
    mode: AgentMode;
    host: ReturnType<typeof resolveAgentHost>;
    workdir: string;
  }> = [];
  for (const project of config.project) {
    if (!Array.isArray(project.agent)) continue;
    for (let i = 0; i < project.agent.length; i++) {
      const team = project.agent[i];
      if (!Array.isArray(team)) continue;
      for (let j = 0; j < team.length; j++) {
        const agent = team[j];
        if (
          !VALID_MODES.includes(agent.mode)
          || !nonEmptyString(agent.workdir)
          || !isAbsolute(agent.workdir!)
        ) continue;
        const host = resolveAgentHost(hosts, agent.host);
        if (agent.mode === 'remote' && !host) continue;
        const workdir = normalize(agent.workdir!);
        const existing = seen.find(entry =>
          entry.workdir === workdir
          && mayShareHostAccount(entry.mode, entry.host, agent.mode, host),
        );
        const path = `project.${project.id}.agent[${i}][${j}].workdir`;
        if (existing) {
          errors.push({
            path,
            message: `Workdir is already used by agent "${existing.id}" on the same host; different agents must not share a directory`,
          });
        } else if (nonEmptyString(agent.id)) {
          seen.push({ id: agent.id, mode: agent.mode, host, workdir });
        }
      }
    }
  }
}

function validateAgentTeams(config: BaxianConfig, errors: ValidationError[]): void {
  for (const project of config.project) {
    if (!Array.isArray(project.agent)) continue;
    for (let i = 0; i < project.agent.length; i++) {
      const team = project.agent[i];
      const path = `project.${project.id}.agent[${i}]`;

      if (!Array.isArray(team)) {
        errors.push({ path, message: 'Agent Team must be an array' });
        continue;
      }
      if (team.length === 0) {
        errors.push({ path, message: 'Agent Team cannot be empty' });
        continue;
      }
      if (team.length > 2) {
        errors.push({ path, message: 'Agent Team can have at most 2 agents' });
      }
      const counts = new Map<AgentRole, number>();
      for (const agent of team) counts.set(agent.role, (counts.get(agent.role) ?? 0) + 1);
      if (counts.get('dev') !== 1) {
        errors.push({ path, message: 'Agent Team must contain exactly one dev agent' });
      }
      if (counts.get('qa') !== 1) {
        errors.push({ path, message: 'Agent Team must contain exactly one qa agent' });
      }
    }
  }
}

function validateHosts(config: BaxianConfig, errors: ValidationError[]): void {
  if (!Array.isArray(config.host)) {
    errors.push({ path: 'host', message: 'host must be an array' });
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i < config.host.length; i++) {
    const host = config.host[i];
    const path = `host[${i}]`;
    const hid = host.id;
    if (typeof hid !== 'string' || hid.trim().length === 0) {
      errors.push({ path: `${path}.id`, message: 'host.id must be a non-empty string' });
    } else if (!ID_PATTERN.test(hid)) {
      errors.push({ path: `${path}.id`, message: 'host.id must match /^[a-z][a-z0-9-]{1,31}$/' });
    } else {
      if (seen.has(hid)) {
        errors.push({ path: `${path}.id`, message: `Duplicate host id: ${hid}` });
      }
      seen.add(hid);
    }
    if (!nonEmptyString(host.hostname)) {
      errors.push({ path: `${path}.hostname`, message: 'host.hostname must be a non-empty string' });
    }
    if (host.port !== undefined && (!Number.isInteger(host.port) || host.port <= 0 || host.port > 65535)) {
      errors.push({ path: `${path}.port`, message: 'host.port must be a positive integer ≤ 65535' });
    }
    for (const field of ['user', 'alias', 'password'] as const) {
      if (host[field] !== undefined && !nonEmptyString(host[field])) {
        errors.push({ path: `${path}.${field}`, message: `host.${field}, if set, must be a non-empty string` });
      }
    }
  }
}

function validateRemoteHosts(config: BaxianConfig, errors: ValidationError[]): void {
  const hostIds = new Set(
    (Array.isArray(config.host) ? config.host : [])
      .map(h => h.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  for (const project of config.project) {
    for (const team of project.agent) {
      for (const agent of team) {
        if (agent.mode !== 'remote') continue;
        const base = `project.${project.id}.agent.${agent.id}`;
        if (agent.host === undefined || agent.host === null) {
          errors.push({ path: base, message: `Remote agent "${agent.id}" must reference a host` });
          continue;
        }
        if (typeof agent.host === 'string') {
          if (!hostIds.has(agent.host)) {
            errors.push({
              path: `${base}.host`,
              message: `Remote agent "${agent.id}" references unknown host id "${agent.host}" — add it via Host 管理`,
            });
          }
          continue;
        }
        if (typeof agent.host !== 'object' || Array.isArray(agent.host)) {
          errors.push({ path: `${base}.host`, message: 'agent.host must be a host id (string) or an inline host object' });
          continue;
        }
        if (!nonEmptyString(agent.host.hostname)) {
          errors.push({ path: `${base}.host.hostname`, message: 'host.hostname must be a non-empty string' });
        }
        if (agent.host.port !== undefined
          && (!Number.isInteger(agent.host.port) || agent.host.port <= 0 || agent.host.port > 65535)) {
          errors.push({ path: `${base}.host.port`, message: 'host.port must be a positive integer ≤ 65535' });
        }
        if (agent.host.user !== undefined && !nonEmptyString(agent.host.user)) {
          errors.push({
            path: `${base}.host.user`,
            message: 'host.user, if set, must be a non-empty string (omit it to let ~/.ssh/config decide)',
          });
        }
        if (agent.host.password !== undefined) {
          errors.push({
            path: `${base}.host.password`,
            message: 'inline agent.host must not carry a password; define the host in the top-level host registry and reference it by id',
          });
        }
      }
    }
  }
}
