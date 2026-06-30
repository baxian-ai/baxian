import { isAbsolute } from 'node:path';
import {
  hasEmbeddedCredentials, isGitHubRepo, isRecord, isSafeGitHost, parseGitRemote, repoSlug,
  type BaxianConfig, type AgentRole, type AgentRuntime, type AgentMode, type MergeStrategy, type ProjectConfig, type ReviewMode,
} from '../shared/index.js';

export interface ValidationError {
  path: string;
  message: string;
}

const VALID_RUNTIMES: AgentRuntime[] = ['claude-code', 'codex'];
const VALID_ROLES: AgentRole[] = ['dev', 'qa'];
const VALID_MODES: AgentMode[] = ['local', 'remote'];
const VALID_MERGE: MergeStrategy[] = ['auto', null];
const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

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
  validateProjectReviewModes(config, errors);
  validateProjectIds(config, errors);
  validateAgentFields(config, errors);
  validateAgentIds(config, errors);
  validateAgentPairs(config, errors);
  validateRemoteHosts(config, errors);

  return errors;
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}


function projectReviewMode(config: BaxianConfig, project: ProjectConfig): ReviewMode {
  const review = (project as { review?: unknown }).review;
  return (isRecord(review) && review.mode !== undefined ? review.mode : (config.review.mode ?? 'github')) as ReviewMode;
}

function validateGlobals(config: BaxianConfig, errors: ValidationError[]): void {
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
    config.server.githubPollIntervalMs,
    'server.githubPollIntervalMs',
    1000,
    2_147_483_647,
    errors,
  );
  if (!Number.isInteger(config.review.rounds) || config.review.rounds <= 0) {
    errors.push({ path: 'review.rounds', message: 'review.rounds must be a positive integer' });
  }
  if (config.review.mode !== undefined && config.review.mode !== 'github' && config.review.mode !== 'server') {
    errors.push({ path: 'review.mode', message: "review.mode must be 'github' or 'server'" });
  }
  const afterDone = config.review.afterDone;
  if (afterDone !== undefined && afterDone !== null && afterDone !== 'pr' && afterDone !== 'branch') {
    errors.push({ path: 'review.afterDone', message: "review.afterDone must be 'pr', 'branch', or null" });
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

function validateProjectReviewModes(config: BaxianConfig, errors: ValidationError[]): void {
  config.project.forEach((project, i) => {
    const path = `project[${i}]`;
    const review = (project as { review?: unknown }).review;
    if (review !== undefined) {
      if (!isRecord(review)) {
        errors.push({ path: `${path}.review`, message: 'project.review must be an object' });
        return;
      }
      if (review.mode !== undefined && review.mode !== 'github' && review.mode !== 'server') {
        errors.push({ path: `${path}.review.mode`, message: "project.review.mode must be 'github' or 'server'" });
      }
    }

    if (
      nonEmptyString(project.repo)
      && !hasEmbeddedCredentials(project.repo)
      && isValidRepo(project.repo)
      && !isGitHubRepo(project.repo)
      && projectReviewMode(config, project) !== 'server'
    ) {
      errors.push({
        path: `${path}.review.mode`,
        message: "non-GitHub projects require effective review.mode 'server'",
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
    if (!Array.isArray(project.agent)) {
      errors.push({ path: `${path}.agent`, message: 'project.agent must be an array of pairs' });
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
      const pair = project.agent[i];
      if (!Array.isArray(pair)) continue;
      for (let j = 0; j < pair.length; j++) {
        const agent = pair[j];
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
        if (agent.yolo !== undefined && typeof agent.yolo !== 'boolean') {
          errors.push({
            path: `${path}.yolo`,
            message: 'agent.yolo must be a boolean if present',
          });
        } else if (agent.yolo === false) {
          errors.push({
            path: `${path}.yolo`,
            message:
              'agent.yolo=false is rejected: interactive REPL only supports ' +
              'YOLO/bypass-permission mode. Either omit yolo (defaults to true) or set true.',
          });
        }
      }
    }
  }
}

function validateAgentIds(config: BaxianConfig, errors: ValidationError[]): void {
  const seen = new Set<string>();
  for (const project of config.project) {
    for (const pair of project.agent) {
      for (const agent of pair) {
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

function validateAgentPairs(config: BaxianConfig, errors: ValidationError[]): void {
  for (const project of config.project) {
    for (let i = 0; i < project.agent.length; i++) {
      const pair = project.agent[i];
      const path = `project.${project.id}.agent[${i}]`;

      if (pair.length === 0) {
        errors.push({ path, message: 'Agent pair cannot be empty' });
        continue;
      }

      if (pair[0].role !== 'dev') {
        errors.push({ path: `${path}[0]`, message: 'The first agent in a pair must have role "dev"' });
      }

      if (pair.length > 1 && pair[1].role !== 'qa') {
        errors.push({ path: `${path}[1]`, message: 'The second agent in a pair must have role "qa"' });
      }

      if (pair.length > 2) {
        errors.push({ path, message: 'Agent pair can have at most 2 agents' });
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
    for (const pair of project.agent) {
      for (const agent of pair) {
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
