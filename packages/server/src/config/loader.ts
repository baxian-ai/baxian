import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { AfterDone, BaxianConfig, HostConfig, ProjectConfig, ReviewMode, ServerConfig } from '../shared/index.js';
import {
  CONFIG_FILE,
  DEFAULT_REVIEW_ROUNDS,
  DEFAULT_SERVER_PORT,
  STATE_DIR,
  USER_CONFIG_REL,
  USER_STATE_REL,
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
  // normalizeConfig silently coerces non-object raw to {}; combined with
  // missing-project being accepted (zero-config), that lets `"oops"` / `null`
  // / `[]` / `42` slip through as a phantom default config.
  // Pin top-level shape here so malformed JSON content (file was overwritten,
  // user wrote an array, etc.) fails fast before defaults paper over it.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const got = Array.isArray(raw) ? 'array' : raw === null ? 'null' : typeof raw;
    throw new ConfigValidationError([
      { path: '', message: `config must be a JSON object (got ${got})` },
    ]);
  }
  const normalized = normalizeConfig(raw);
  // Reject renamed keys so stale configs fail fast.
  const legacyErrors: Array<{ path: string; message: string }> = [];
  if ('codereview' in normalized) {
    legacyErrors.push({
      path: 'codereview',
      message: 'codereview was renamed to review — rename the top-level key in baxian.json',
    });
  }
  if (legacyErrors.length > 0) {
    throw new ConfigValidationError(legacyErrors);
  }
  // applyDefaults silently coerces non-array `project` to []; catch the malformed
  // shape before that coercion so users see "project must be an array" instead of
  // server starting as a phantom 0-project deployment.
  if ('project' in normalized && normalized.project !== undefined && !Array.isArray(normalized.project)) {
    throw new ConfigValidationError([
      { path: 'project', message: 'project must be an array' },
    ]);
  }
  // applyDefaults silently coerces a non-array host to []; catch the malformed shape first so a
  // hand-edited / PATCH config with host: null|"str"|{} fails as a 400 instead of dropping hosts.
  if ('host' in normalized && normalized.host !== undefined && !Array.isArray(normalized.host)) {
    throw new ConfigValidationError([
      { path: 'host', message: 'host must be an array' },
    ]);
  }
  // applyDefaults' filter(isRecord) would silently drop non-object entries (e.g. host: ["prod"]),
  // saving/booting host: [] and orphaning agents' host refs — reject those entries up front instead.
  if (Array.isArray(normalized.host)) {
    const hostShapeErrors = normalized.host.flatMap((h, i) =>
      isRecord(h) ? [] : [{ path: `host[${i}]`, message: `host[${i}] must be an object` }],
    );
    if (hostShapeErrors.length > 0) {
      throw new ConfigValidationError(hostShapeErrors);
    }
  }
  // applyDefaults filters non-record projects out silently and assumes each agent pair is an
  // array — so `project: [null]` would vanish and `agent: [{}]` would throw a raw TypeError.
  // Reject malformed element shapes here so every bad input surfaces as ConfigValidationError.
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
    // Only "really not there" is missing. Permission / loop / IO errors propagate
    // so the user sees the real cause instead of silent fallback to ~/.baxian/.
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

/**
 * Resolve config file path with fallback chain:
 *   1. explicit (from -c flag) — returned as-is, no fs check; loadConfig surfaces ENOENT
 *      if user pointed at a non-existent path on purpose.
 *   2. $CWD/baxian.json — if present.
 *   3. ~/.baxian/config.json — if present.
 * Returns null when no auto-discoverable config exists; caller decides whether to
 * auto-create one (the `baxian` zero-config path) or error out.
 */
export async function resolveConfigPath(explicit?: string): Promise<string | null> {
  if (explicit) return resolve(explicit);
  const cwdPath = resolve(process.cwd(), CONFIG_FILE);
  if (await pathExists(cwdPath)) return cwdPath;
  const userPath = userConfigPath();
  if (await pathExists(userPath)) return userPath;
  return null;
}

/**
 * State dir is sibling of cwd/baxian.json (preserves existing layout); for the
 * user-level config we land state in ~/.baxian/ directly so cwd-mode `./.baxian/`
 * subdirs (state/, locks/, events/) and user-mode `~/.baxian/{state,locks,events}/`
 * stay symmetric.
 *
 * Use dirname match (not configPath ===) so any config file that lives directly
 * in ~/.baxian/ — including aliases/symlinks like ~/.baxian/cfg-alias.json —
 * lands the same shared state dir instead of nesting into ~/.baxian/.baxian/.
 * Configs deeper than ~/.baxian/ (e.g. ~/.baxian/sub/cfg.json) intentionally
 * fall through to the sibling .baxian/ rule, since the user moved them out.
 */
export function resolveStateDir(configPath: string): string {
  if (resolve(dirname(configPath)) === userStateDir()) return userStateDir();
  return resolve(dirname(configPath), STATE_DIR);
}

const DEFAULT_CONFIG_TEMPLATE = {
  review: { rounds: DEFAULT_REVIEW_ROUNDS },
  server: { port: DEFAULT_SERVER_PORT, host: '127.0.0.1' },
  host: [] as HostConfig[],
  project: [] as ProjectConfig[],
};

/**
 * Write a minimal `project: []` config at the given path (creating parent dirs).
 * Validator must accept empty project lists or this file will fail loadConfig.
 * Used by `baxian` zero-config first-run: user adds projects/agents via the web UI,
 * which writes them back through saveConfig.
 */
export async function createDefaultConfig(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(DEFAULT_CONFIG_TEMPLATE, null, 2) + '\n');
}

export async function saveConfig(configPath: string, config: BaxianConfig): Promise<void> {
  await backupConfig(configPath);
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Element-level shape guard run before applyDefaults coerces. Without it, applyDefaults silently
// drops non-record projects (filter(isRecord)) and throws a raw TypeError on a non-array agent pair.
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
  // Carry the host registry through (allowlist trap: anything not copied here is silently dropped).
  // An omitted port stays omitted so ssh honors ~/.ssh/config's Port; an invalid value (string,
  // out-of-range) still survives to validateHosts and fails cleanly instead of being coerced.
  const hosts = Array.isArray(normalized.host)
    ? normalized.host.filter(isRecord).map(h => ({ ...(h as unknown as HostConfig) }))
    : [];

  // Pass https / allowedHosts raw so the validator (not the loader) can surface a 400 on misconfig.
  const hasHttps = sv !== undefined && Object.prototype.hasOwnProperty.call(sv, 'https');
  const hasAllowedHosts = sv !== undefined && Object.prototype.hasOwnProperty.call(sv, 'allowedHosts');

  return {
    review: {
      rounds: isFiniteNumber(rv.rounds) ? rv.rounds : DEFAULT_REVIEW_ROUNDS,
      // Raw values survive to the validator so misconfig surfaces as a clear error.
      mode: (rv.mode === undefined ? 'github' : rv.mode) as ReviewMode,
      // Deliberately NOT defaulted to null: an OMITTED afterDone must stay distinguishable from
      // an explicit null so non-GitHub repos can deliver-by-default (unset → 'branch') while an
      // explicit null still means review-only (see AgentManager.coerceAfterDone). For GitHub both
      // collapse to null via `?? null`, so this is behavior-neutral there.
      afterDone: rv.afterDone as AfterDone | undefined,
    },
    server: {
      port: isFiniteNumber(sv.port) ? sv.port : DEFAULT_SERVER_PORT,
      ...(typeof sv.host === 'string' ? { host: sv.host } : {}),
      ...(typeof sv.token === 'string' && sv.token.trim().length > 0 ? { token: sv.token } : {}),
      ...(hasHttps ? { https: sv.https as unknown as ServerConfig['https'] } : {}),
      ...(hasAllowedHosts ? { allowedHosts: sv.allowedHosts as unknown as string[] } : {}),
      // Type-narrow only; range checks live in the validator.
      ...(isFiniteNumber(sv.githubPollIntervalMs)
        ? { githubPollIntervalMs: sv.githubPollIntervalMs }
        : {}),
      ...(isFiniteNumber(sv.tmuxProbePollIntervalMs)
        ? { tmuxProbePollIntervalMs: sv.tmuxProbePollIntervalMs }
        : {}),
      ...(isFiniteNumber(sv.tmuxProbeTimeoutMs)
        ? { tmuxProbeTimeoutMs: sv.tmuxProbeTimeoutMs }
        : {}),
      ...(isFiniteNumber(sv.tmuxProbeConcurrency)
        ? { tmuxProbeConcurrency: sv.tmuxProbeConcurrency }
        : {}),
      ...(isFiniteNumber(sv.bootstrapRetryIntervalMs)
        ? { bootstrapRetryIntervalMs: sv.bootstrapRetryIntervalMs }
        : {}),
    },
    host: hosts,
    project: projects.map(p => ({
      ...(p as unknown as ProjectConfig),
      merge: (p.merge as ProjectConfig['merge'] | undefined) ?? null,
      // yolo defaults true so legacy configs load; validator rejects explicit false.
      agent: Array.isArray(p.agent)
        ? (p.agent as unknown as Record<string, unknown>[][]).map(pair => pair.map(a => ({
          ...a,
          yolo: a.yolo === undefined ? true : a.yolo,
        }))) as unknown as ProjectConfig['agent']
        : [],
    })),
  };
}
