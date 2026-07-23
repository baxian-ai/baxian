import { readFile, writeFile, access, mkdir, stat, open, rename, rm, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isRecord, type AfterDone, type BaxianConfig, type HostConfig, type ProjectConfig, type ReviewMode, type ServerConfig } from '../shared/index.js';
import {
  CONFIG_FILE,
  DEFAULT_BOOTSTRAP_RETRY_INTERVAL_MS,
  DEFAULT_DISPATCH_RECONCILE_INTERVAL_MS,
  DEFAULT_DISPATCH_BUSY_WAIT_BUDGET_MS,
  DEFAULT_DISPATCH_RECONCILE_MAX_ATTEMPTS,
  DEFAULT_GITHUB_POLL_INTERVAL_MS,
  DEFAULT_REVIEW_ROUNDS,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  DEFAULT_TMUX_PROBE_CONCURRENCY,
  DEFAULT_TMUX_PROBE_POLL_INTERVAL_MS,
  DEFAULT_TMUX_PROBE_TIMEOUT_MS,
  STATE_DIR,
  USER_CONFIG_REL,
  USER_STATE_REL,
  isGitHubRepo,
} from '../shared/index.js';
import { normalizeConfig } from './normalizer.js';
import { validateConfig, type ValidationError } from './validator.js';
import { backupConfig } from './backup.js';

export class ConfigValidationError extends Error {
  constructor(public readonly errors: ValidationError[]) {
    const details = errors.map(e => `  ${e.path}: ${e.message}`).join('\n');
    super(`Config validation failed:\n${details}`);
    this.name = 'ConfigValidationError';
  }
}

export function prepareConfig(raw: unknown): BaxianConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const got = Array.isArray(raw) ? 'array' : raw === null ? 'null' : typeof raw;
    throw new ConfigValidationError([
      { path: '', message: `config must be a JSON object (got ${got})` },
    ]);
  }
  const normalized = normalizeConfig(raw);
  if ('project' in normalized && normalized.project !== undefined && !Array.isArray(normalized.project)) {
    throw new ConfigValidationError([
      { path: 'project', message: 'project must be an array' },
    ]);
  }
  if ('host' in normalized && normalized.host !== undefined && !Array.isArray(normalized.host)) {
    throw new ConfigValidationError([
      { path: 'host', message: 'host must be an array' },
    ]);
  }
  if (Array.isArray(normalized.host)) {
    const hostShapeErrors = normalized.host.flatMap((h, i) =>
      isRecord(h) ? [] : [{ path: `host[${i}]`, message: `host[${i}] must be an object` }],
    );
    if (hostShapeErrors.length > 0) {
      throw new ConfigValidationError(hostShapeErrors);
    }
  }
  const shapeErrors = validateProjectShapes(normalized.project);
  if (shapeErrors.length > 0) {
    throw new ConfigValidationError(shapeErrors);
  }
  const config = applyDefaults(normalized);
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }
  return config;
}

export async function loadConfig(configPath: string): Promise<BaxianConfig> {
  const raw = await readFile(configPath, 'utf-8');
  return prepareConfig(JSON.parse(raw));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
}

export function userConfigPath(): string {
  return resolve(homedir(), USER_CONFIG_REL);
}

export function userStateDir(): string {
  return resolve(homedir(), USER_STATE_REL);
}

export async function resolveConfigPath(explicit?: string): Promise<string | null> {
  if (explicit) return resolve(explicit);
  const cwdPath = resolve(process.cwd(), CONFIG_FILE);
  if (await pathExists(cwdPath)) return cwdPath;
  const userPath = userConfigPath();
  if (await pathExists(userPath)) return userPath;
  return null;
}

export function resolveStateDir(configPath: string): string {
  if (resolve(dirname(configPath)) === userStateDir()) return userStateDir();
  return resolve(dirname(configPath), STATE_DIR);
}

const DEFAULT_CONFIG_TEMPLATE = {
  review: { rounds: DEFAULT_REVIEW_ROUNDS },
  server: { port: DEFAULT_SERVER_PORT, host: DEFAULT_SERVER_HOST },
  host: [] as HostConfig[],
  project: [] as ProjectConfig[],
};

export async function createDefaultConfig(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(DEFAULT_CONFIG_TEMPLATE, null, 2) + '\n');
}

// Atomic + credential-safe (config can hold a plaintext HostConfig.password): O_EXCL temp with the target's mode, rename-swapped over the realpath'd target so a symlink keeps its link and a failure leaves the original untouched.
export async function saveConfig(configPath: string, config: BaxianConfig): Promise<void> {
  await backupConfig(configPath);
  const physical = await realpathOrSelf(configPath);
  let mode = 0o600;
  try {
    mode = (await stat(physical)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw err;
  }
  const tmp = `${physical}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const cleanupTmp = async (): Promise<void> => {
    await rm(tmp, { force: true }).catch((rmErr) => {
      console.warn(`[config] failed to remove config temp ${tmp}:`, rmErr);
    });
  };
  // close() shares the cleanup path: a deferred write/fsync error surfaced at close (ENOSPC/NFS) must not leave the plaintext temp behind.
  let handle;
  try {
    handle = await open(tmp, 'wx', mode);
    await handle.writeFile(JSON.stringify(config, null, 2) + '\n');
    await handle.chmod(mode);
    await handle.close();
    handle = undefined;
    await rename(tmp, physical);
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await cleanupTmp();
    throw err;
  }
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return p;
    throw err;
  }
}


function validateProjectShapes(project: unknown): ValidationError[] {
  if (!Array.isArray(project)) return [];
  const errors: ValidationError[] = [];
  project.forEach((proj, i) => {
    if (!isRecord(proj)) {
      errors.push({ path: `project[${i}]`, message: `project[${i}] must be an object` });
      return;
    }
    if (proj.agent === undefined) return;
    if (!Array.isArray(proj.agent)) {
      errors.push({ path: `project[${i}].agent`, message: `project[${i}].agent must be an array of pairs` });
      return;
    }
    proj.agent.forEach((pair, j) => {
      if (!Array.isArray(pair)) {
        errors.push({ path: `project[${i}].agent[${j}]`, message: `project[${i}].agent[${j}] must be an array of agents` });
        return;
      }
      pair.forEach((agent, k) => {
        if (!isRecord(agent)) {
          errors.push({ path: `project[${i}].agent[${j}][${k}]`, message: `project[${i}].agent[${j}][${k}] must be an object` });
        }
      });
    });
  });
  return errors;
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function applyDefaults(normalized: Record<string, unknown>): BaxianConfig {
  const rv = isRecord(normalized.review) ? normalized.review : {};
  const sv = isRecord(normalized.server) ? normalized.server : {};
  const projects = Array.isArray(normalized.project)
    ? normalized.project.filter(isRecord)
    : [];
  const hosts = Array.isArray(normalized.host)
    ? normalized.host.filter(isRecord).map(h => ({ ...(h as unknown as HostConfig) }))
    : [];

  const hasHttps = sv !== undefined && Object.prototype.hasOwnProperty.call(sv, 'https');
  const hasAllowedHosts = sv !== undefined && Object.prototype.hasOwnProperty.call(sv, 'allowedHosts');

  const reviewMode = (rv.mode === undefined ? 'git' : rv.mode) as ReviewMode;

  return {
    ...(normalized.language !== undefined
      ? { language: normalized.language as BaxianConfig['language'] }
      : {}),
    review: {
      rounds: isFiniteNumber(rv.rounds) ? rv.rounds : DEFAULT_REVIEW_ROUNDS,
      mode: reviewMode,
      afterDone: rv.afterDone as AfterDone | undefined,
    },
    server: {
      port: isFiniteNumber(sv.port) ? sv.port : DEFAULT_SERVER_PORT,
      host: typeof sv.host === 'string' ? sv.host : DEFAULT_SERVER_HOST,
      ...(typeof sv.token === 'string' && sv.token.trim().length > 0 ? { token: sv.token } : {}),
      ...(hasHttps ? { https: sv.https as unknown as ServerConfig['https'] } : {}),
      ...(hasAllowedHosts ? { allowedHosts: sv.allowedHosts as unknown as string[] } : {}),
      githubPollIntervalMs: isFiniteNumber(sv.githubPollIntervalMs) ? sv.githubPollIntervalMs : DEFAULT_GITHUB_POLL_INTERVAL_MS,
      tmuxProbePollIntervalMs: isFiniteNumber(sv.tmuxProbePollIntervalMs) ? sv.tmuxProbePollIntervalMs : DEFAULT_TMUX_PROBE_POLL_INTERVAL_MS,
      tmuxProbeTimeoutMs: isFiniteNumber(sv.tmuxProbeTimeoutMs) ? sv.tmuxProbeTimeoutMs : DEFAULT_TMUX_PROBE_TIMEOUT_MS,
      tmuxProbeConcurrency: isFiniteNumber(sv.tmuxProbeConcurrency) ? sv.tmuxProbeConcurrency : DEFAULT_TMUX_PROBE_CONCURRENCY,
      bootstrapRetryIntervalMs: isFiniteNumber(sv.bootstrapRetryIntervalMs) ? sv.bootstrapRetryIntervalMs : DEFAULT_BOOTSTRAP_RETRY_INTERVAL_MS,
      dispatchReconcileIntervalMs: isFiniteNumber(sv.dispatchReconcileIntervalMs) ? sv.dispatchReconcileIntervalMs : DEFAULT_DISPATCH_RECONCILE_INTERVAL_MS,
      dispatchBusyWaitBudgetMs: isFiniteNumber(sv.dispatchBusyWaitBudgetMs) ? sv.dispatchBusyWaitBudgetMs : DEFAULT_DISPATCH_BUSY_WAIT_BUDGET_MS,
      dispatchReconcileMaxAttempts: isFiniteNumber(sv.dispatchReconcileMaxAttempts) ? sv.dispatchReconcileMaxAttempts : DEFAULT_DISPATCH_RECONCILE_MAX_ATTEMPTS,
    },
    host: hosts,
    project: projects.map(p => applyProjectDefaults(p, reviewMode)),
  };
}

function applyProjectDefaults(p: Record<string, unknown>, globalReviewMode: ReviewMode): ProjectConfig {
  const project: ProjectConfig = {
    ...(p as unknown as ProjectConfig),
    merge: (p.merge as ProjectConfig['merge'] | undefined) ?? null,
    agent: Array.isArray(p.agent)
      ? (p.agent as unknown as Record<string, unknown>[][]).map(pair => pair.map(a => ({
        ...a,
        yolo: a.yolo === undefined ? true : a.yolo,
      }))) as unknown as ProjectConfig['agent']
      : [],
  };
  const review = project.review as unknown;
  if (review !== undefined && !isRecord(review)) return project;
  if (isRecord(review) && review.mode !== undefined) return project;
  if (typeof project.repo === 'string' && isGitHubRepo(project.repo)) return project;
  const mode = globalReviewMode;
  return { ...project, review: { ...(isRecord(review) ? project.review : {}), mode } };
}
