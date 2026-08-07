import { isAbsolute, normalize } from 'node:path';
import {
  CONTROL_CHAR_RE,
  hasEmbeddedCredentials, isRecord,
  type BaxianConfig, type AgentRole, type AgentRuntime, type AgentMode, type MergeStrategy, type SpecApprovalStrategy,
} from '../shared/index.js';
import { AmbiguousRepoClaimError, InvalidRepoClaimError, resolveRepo, type ResolvedRepo } from '../platform/driver-host.js';
import { mayShareHostAccount, resolveAgentHost } from '../agent/runner.js';

export interface ValidationError {
  path: string;
  message: string;
}

const VALID_RUNTIMES: AgentRuntime[] = ['claude-code', 'codex', 'opencode', 'qodercli'];
const VALID_ROLES: AgentRole[] = ['dev', 'qa'];
const VALID_MODES: AgentMode[] = ['local', 'remote'];
const VALID_MERGE: MergeStrategy[] = ['auto', null];
const VALID_SPEC_APPROVAL: Array<SpecApprovalStrategy | undefined> = ['human', null, undefined];
const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const TOP_LEVEL_FIELDS = new Set(['language', 'review', 'server', 'host', 'project']);
const REVIEW_FIELDS = new Set(['rounds']);
const SERVER_FIELDS = new Set([
  'port', 'host', 'token', 'https', 'allowedHosts', 'platformPollIntervalMs',
  'tmuxProbePollIntervalMs', 'tmuxProbeTimeoutMs', 'tmuxProbeConcurrency',
  'bootstrapRetryIntervalMs', 'dispatchReconcileIntervalMs', 'dispatchBusyWaitBudgetMs',
  'dispatchReconcileMaxAttempts',
]);
const PROJECT_FIELDS = new Set(['id', 'repo', 'merge', 'specApproval', 'agent']);
const AGENT_FIELDS = new Set([
  'id', 'runtime', 'mode', 'host', 'workdir', 'yolo', 'model', 'addDirs', 'role',
]);
const HOST_FIELDS = new Set(['id', 'hostname', 'port', 'alias', 'user', 'password']);
const HTTPS_FIELDS = new Set(['keyFile', 'certFile']);

function unknownKeyErrors(
  value: unknown,
  allowed: ReadonlySet<string>,
  prefix: string,
): ValidationError[] {
  if (!isRecord(value)) return [];
  return Object.keys(value)
    .filter(key => !allowed.has(key))
    .map(key => ({
      path: prefix === '' ? key : `${prefix}.${key}`,
      message: 'unknown configuration key',
    }));
}

export function collectUnknownConfigErrors(config: Record<string, unknown>): ValidationError[] {
  const errors = [
    ...unknownKeyErrors(config, TOP_LEVEL_FIELDS, ''),
    ...unknownKeyErrors(config.review, REVIEW_FIELDS, 'review'),
    ...unknownKeyErrors(config.server, SERVER_FIELDS, 'server'),
  ];
  if (isRecord(config.server) && config.server.https !== undefined) {
    errors.push(...unknownKeyErrors(config.server.https, HTTPS_FIELDS, 'server.https'));
  }
  if (Array.isArray(config.host)) {
    config.host.forEach((host, hostIndex) => {
      errors.push(...unknownKeyErrors(host, HOST_FIELDS, `host[${hostIndex}]`));
    });
  }
  if (!Array.isArray(config.project)) return errors;
  config.project.forEach((project, projectIndex) => {
    const projectPath = `project[${projectIndex}]`;
    errors.push(...unknownKeyErrors(project, PROJECT_FIELDS, projectPath));
    if (!isRecord(project) || !Array.isArray(project.agent)) return;
    project.agent.forEach((team, teamIndex) => {
      if (!Array.isArray(team)) return;
      team.forEach((agent, agentIndex) => {
        errors.push(...unknownKeyErrors(
          agent,
          AGENT_FIELDS,
          `${projectPath}.agent[${teamIndex}][${agentIndex}]`,
        ));
      });
    });
  });
  return errors;
}

function resolveRepoForValidation(repo: string): ResolvedRepo | AmbiguousRepoClaimError | InvalidRepoClaimError | null {
  try {
    return resolveRepo(repo);
  } catch (err) {
    if (err instanceof AmbiguousRepoClaimError || err instanceof InvalidRepoClaimError) return err;
    throw err;
  }
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

function validateGlobals(config: BaxianConfig, errors: ValidationError[]): void {
  const language = config.language as unknown;
  if (language !== undefined && language !== 'zh-CN' && language !== 'en-US') {
    errors.push({ path: 'language', message: "language must be 'zh-CN' or 'en-US'" });
  }
  if (!Number.isInteger(config.server.port) || config.server.port <= 0 || config.server.port > 65535) {
    errors.push({ path: 'server.port', message: 'server.port must be a positive integer ≤ 65535' });
  }
  if (!nonEmptyString(config.server.host)) {
    errors.push({ path: 'server.host', message: 'server.host must be a non-empty string' });
  }
  if (config.server.token !== undefined && !nonEmptyString(config.server.token)) {
    errors.push({ path: 'server.token', message: 'server.token must be a non-empty string when set' });
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
    config.server.platformPollIntervalMs,
    'server.platformPollIntervalMs',
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
    const resolved = nonEmptyString(project.repo) ? resolveRepoForValidation(project.repo) : null;
    if (resolved === null || resolved instanceof Error) return;
    const norm = resolved.identityKey;
    const prev = seen.get(norm);
    if (prev !== undefined) {
      errors.push({
        path: `project[${i}].repo`,
        message: `normalized repo URL must be unique across projects (already used by project '${prev}')`,
      });
    } else {
      seen.set(norm, project.id);
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
          + 'or "ssh://user:secret@host/…"). Configure auth via a git credential helper or an SSH key '
          + 'so the secret stays out of the config file, API responses, and logs.',
      });
    } else {
      const resolved = resolveRepoForValidation(project.repo);
      if (resolved instanceof AmbiguousRepoClaimError) {
        errors.push({
          path: `${path}.repo`,
          message: `${resolved.message} — uninstall one of the conflicting plugins or change project.repo`,
        });
      } else if (resolved instanceof InvalidRepoClaimError) {
        errors.push({
          path: `${path}.repo`,
          message: `${resolved.message} — fix or uninstall that plugin`,
        });
      } else if (resolved === null) {
        errors.push({
          path: `${path}.repo`,
          message:
            'project.repo is not recognized by any installed platform — built-in GitHub accepts a full github.com '
            + 'HTTPS or SSH Git URL with an owner/repository path; other platforms need their plugin installed '
            + '(baxian plugin install <package>)',
        });
      }
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
        if (typeof agent.host !== 'string') {
          errors.push({
            path: `${base}.host`,
            message: 'agent.host must reference a top-level host id',
          });
        } else if (!hostIds.has(agent.host)) {
          errors.push({
            path: `${base}.host`,
            message: `Remote agent "${agent.id}" references unknown host id "${agent.host}" — add it via Host 管理`,
          });
        }
      }
    }
  }
}
