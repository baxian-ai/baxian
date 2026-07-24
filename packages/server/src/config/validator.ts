import { isAbsolute, normalize } from 'node:path';
import { isBareRepoSlug,
  CONTROL_CHAR_RE, TOOL_PATTERN,
  hasEmbeddedCredentials, isGitHubRepo, isRecord, isSafeGitHost, parseGitRemote, repoIdentityKey, repoSlug,
  ROOT_AGENT_ID,
  type AfterDone, type BaxianConfig, type AgentRole, type AgentRuntime, type AgentMode, type MergeStrategy, type ProjectConfig, type ReviewMode, type SpecApprovalStrategy,
} from '../shared/index.js';
import { mayShareHostAccount, resolveAgentHost } from '../agent/runner.js';

const VALID_REVIEW_MODES: ReadonlySet<string> = new Set(['git', 'server']);

export interface ValidationError {
  path: string;
  message: string;
}

const VALID_RUNTIMES: AgentRuntime[] = ['claude-code', 'codex', 'opencode', 'qodercli'];
const VALID_ROLES: AgentRole[] = ['dev', 'qa', 'research'];
const VALID_MODES: AgentMode[] = ['local', 'remote'];
const VALID_MERGE: MergeStrategy[] = ['auto', null];
const VALID_SPEC_APPROVAL: Array<SpecApprovalStrategy | undefined> = ['human', null, undefined];
const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const ROOT_FIELDS = new Set([
  'runtime', 'mode', 'host', 'workdir', 'yolo', 'model', 'projects', 'responseTimeoutMinutes',
]);

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
  validateGitMode(config, errors);
  validateServerPublishTool(config, errors);
  validatePlatformRepoUniqueness(config, errors);
  validateProjectIds(config, errors);
  validateAgentFields(config, errors);
  validateAgentIds(config, errors);
  validateAgentWorkdirUniqueness(config, errors);
  validateAgentPairs(config, errors);
  validateRemoteHosts(config, errors);
  validateRootAgent(config, errors);

  return errors;
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}


export function projectReviewMode(config: BaxianConfig, project: ProjectConfig): ReviewMode {
  const review = (project as { review?: unknown }).review;
  return (isRecord(review) && review.mode !== undefined ? review.mode : (config.review.mode ?? 'git')) as ReviewMode;
}

// tool 解析的唯一定义（spec v2 §4）：显式 gitCli.tool 优先；github 仓库零配置自动 'gh'（内置插件）；
// 非 github 且未声明 → undefined（validator 已报配置错误，消费端跳过）。
export function resolveProjectTool(project: ProjectConfig): string | undefined {
  if (isRecord(project.gitCli) && typeof project.gitCli.tool === 'string') return project.gitCli.tool;
  return nonEmptyString(project.repo) && isGitHubRepo(project.repo) ? 'gh' : undefined;
}

// afterDone 的唯一投影：非 github 仓库不支持开 PR，'pr'/未声明一律落到 'branch'。
export function projectAfterDone(config: BaxianConfig, project: ProjectConfig): AfterDone {
  if (!isGitHubRepo(project.repo)) {
    const configured = config.review.afterDone;
    return configured === 'pr' || configured === undefined ? 'branch' : configured;
  }
  return config.review.afterDone ?? null;
}

export function projectNeedsPlatformEntry(config: BaxianConfig, project: ProjectConfig): boolean {
  if (resolveProjectTool(project) === undefined) return false;
  return projectReviewMode(config, project) === 'git' || projectAfterDone(config, project) === 'pr';
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
  if (config.review.mode !== undefined && !VALID_REVIEW_MODES.has(config.review.mode)) {
    errors.push({ path: 'review.mode', message: "review.mode must be 'git' or 'server'" });
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
      if (review.mode !== undefined && !(typeof review.mode === 'string' && VALID_REVIEW_MODES.has(review.mode))) {
        errors.push({ path: `${path}.review.mode`, message: "project.review.mode must be 'git' or 'server'" });
      }
    }

  });
}

function validatePlatformRepoUniqueness(config: BaxianConfig, errors: ValidationError[]): void {
  // 查重范围 = platform entry 集合（spec §4/§5.5 同谓词）：共用一个 repo 就共用一份 cursor
  // 与观察缓存，两个 entry 指向同一仓库会互相吞事件。都不进 entry 的项目共用 repo 无妨。
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

// server 模式 + afterDone 解析 'pr' 的 agent 发布面走 baxian-server-feedback 的 gh 契约；
// server 生命周期面复用 driver。gitCli 若声明 tool 必须为 'gh'，binary 仅覆盖 server 面可执行文件。
function validateServerPublishTool(config: BaxianConfig, errors: ValidationError[]): void {
  config.project.forEach((project, i) => {
    if (!nonEmptyString(project.repo)) return;
    if (projectReviewMode(config, project) !== 'server' || projectAfterDone(config, project) !== 'pr') return;
    const gitCli = project.gitCli;
    if (isRecord(gitCli) && typeof gitCli.tool === 'string' && gitCli.tool !== 'gh') {
      errors.push({
        path: `project[${i}].gitCli.tool`,
        message: "server-mode projects that publish PRs (afterDone: 'pr') may only declare gitCli.tool 'gh' (the agent publish contract uses gh); drop the tool or use a git-mode project",
      });
    }
  });
}

function validateGitMode(config: BaxianConfig, errors: ValidationError[]): void {
  config.project.forEach((project, i) => {
    const path = `project[${i}]`;
    const gitCli = project.gitCli;

    // project.repo 的存在性/类型错误已由 validateProjectFields 报告；此处短路，避免对畸形 repo 重复报告或在 isGitHubRepo/dedupe 上崩溃
    if (!nonEmptyString(project.repo)) return;

    if (projectReviewMode(config, project) !== 'git') return;

    // github 仓库豁免 http(s) 形态与 gitCli 声明：内置 gh 驱动只用 {hostname}/{repoPath} 占位符
    // 且 tool 自动解析为 'gh'（spec v2 §4），SSH/scp/裸 slug 形态照常合法。
    if (!isGitHubRepo(project.repo)) {
      // scheme 大小写不敏感（WHATWG）：大写 HTTPS:// 由 isValidRepo 统一拒，此处小写敏感会对它误报「ssh/scp 打到 SSH 端口」。
      if (!/^https?:\/\//i.test(project.repo)) {
        errors.push({
          path: `${path}.repo`,
          message: "mode 'git' requires an http(s):// repo URL (the git-driver CLI derives its API endpoint from it; ssh/scp forms would target the SSH port instead)",
        });
      } else {
        // 补 isValidRepo 段模式不查的 URL 结构错误（如非数字端口）；退化路径形态
        // （纯 host/query/fragment）由 validateProjectFields 的 isValidRepo 单点把守。
        try {
          new URL(project.repo);
        } catch {
          errors.push({ path: `${path}.repo`, message: 'repo is not a parseable URL' });
        }
      }

      if (gitCli === undefined) {
        errors.push({
          path: `${path}.gitCli`,
          message: "non-GitHub repos in review.mode 'git' require gitCli.tool — declare it and install the matching git-driver plugin under ~/.baxian/plugins/, or use review.mode 'server'",
        });
      }
    } else if (isBareRepoSlug(project.repo) && resolveProjectTool(project) !== 'gh') {
      // 裸 slug 只有 gh 能 clone；不代用户合成 URL——https 与 ssh 的凭据通道不同（spec §4）。
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
      // repo 会进入 descriptor 行协议与 argv 渲染；段模式对 Cc 的拒绝是巧合而非声明，这里钉死不变量（spec §4）。
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
      errors.push({ path: `${path}.agent`, message: 'project.agent must be an array of agent groups' });
    }
    validateGitCliShape(project, path, errors);
  }
}

// gitCli 形状与 review mode 无关（对任意项目合法，spec v2 §4），归字段形状层——
// 放 validateGitMode 会被其 repo 短路压掉，repo 与 gitCli 同坏时用户要修两轮才见全错。
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
  // isAbsolute 单独挡不住换行伪造（isAbsolute('/x\nbase: forged') 为真），行协议值一律拒 Cc（spec §4）。
  if (gitCli.binary !== undefined
    && (typeof gitCli.binary !== 'string' || !isAbsolute(gitCli.binary) || CONTROL_CHAR_RE.test(gitCli.binary))) {
    errors.push({ path: `${path}.gitCli.binary`, message: 'gitCli.binary must be an absolute path without control characters' });
  }
  // 长度约束按 spec §8 属 cli-notes 渲染层的截断语义（512B + 警告）；控制字符在此拒——
  // cli-notes 是行式派发描述符，\n 可伪造额外 cli-*: 行，截断不移除换行。
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

function validateAgentWorkdirUniqueness(config: BaxianConfig, errors: ValidationError[]): void {
  const hosts = Array.isArray(config.host) ? config.host : [];
  const seen: Array<{
    id: string;
    mode: AgentMode;
    host: ReturnType<typeof resolveAgentHost>;
    workdir: string;
  }> = [];
  const root = config.root;
  if (
    root
    && VALID_MODES.includes(root.mode)
    && nonEmptyString(root.workdir)
    && isAbsolute(root.workdir)
  ) {
    const host = resolveAgentHost(hosts, root.host);
    if (root.mode === 'local' || host) {
      seen.push({
        id: ROOT_AGENT_ID,
        mode: root.mode,
        host,
        workdir: normalize(root.workdir),
      });
    }
  }
  for (const project of config.project) {
    if (!Array.isArray(project.agent)) continue;
    for (let i = 0; i < project.agent.length; i++) {
      const pair = project.agent[i];
      if (!Array.isArray(pair)) continue;
      for (let j = 0; j < pair.length; j++) {
        const agent = pair[j];
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

function validateRootAgent(config: BaxianConfig, errors: ValidationError[]): void {
  for (const project of config.project) {
    if (!Array.isArray(project.agent)) continue;
    for (const group of project.agent) {
      if (!Array.isArray(group)) continue;
      if (group.some(agent => isRecord(agent) && agent.id === ROOT_AGENT_ID)) {
        errors.push({
          path: `project.${project.id}.agent.${ROOT_AGENT_ID}`,
          message: `Agent id "${ROOT_AGENT_ID}" is reserved for the root agent`,
        });
      }
    }
  }

  const root = config.root as unknown;
  if (root === undefined) return;
  if (!isRecord(root)) {
    errors.push({ path: 'root', message: 'root must be an object' });
    return;
  }
  for (const field of Object.keys(root)) {
    if (!ROOT_FIELDS.has(field)) {
      errors.push({ path: `root.${field}`, message: `unsupported root field: ${field}` });
    }
  }
  if (!VALID_RUNTIMES.includes(root.runtime as AgentRuntime)) {
    errors.push({
      path: 'root.runtime',
      message: `root.runtime must be one of: ${VALID_RUNTIMES.join(', ')}`,
    });
  }
  if (!VALID_MODES.includes(root.mode as AgentMode)) {
    errors.push({
      path: 'root.mode',
      message: `root.mode must be one of: ${VALID_MODES.join(', ')}`,
    });
  }
  if (!nonEmptyString(root.workdir)) {
    errors.push({ path: 'root.workdir', message: 'root.workdir must be a non-empty string' });
  } else if (!isAbsolute(root.workdir as string)) {
    errors.push({ path: 'root.workdir', message: 'root.workdir must be an absolute path' });
  } else if (normalize(root.workdir as string) === '/') {
    errors.push({ path: 'root.workdir', message: 'root.workdir must not be the filesystem root' });
  }
  if (root.model !== undefined && !nonEmptyString(root.model)) {
    errors.push({ path: 'root.model', message: 'root.model, when set, must be a non-empty string' });
  }
  if (root.yolo !== undefined && typeof root.yolo !== 'boolean') {
    errors.push({ path: 'root.yolo', message: 'root.yolo must be a boolean if present' });
  }
  if (!Number.isInteger(root.responseTimeoutMinutes)
    || (root.responseTimeoutMinutes as number) < 1
    || (root.responseTimeoutMinutes as number) > 1440) {
    errors.push({
      path: 'root.responseTimeoutMinutes',
      message: 'root.responseTimeoutMinutes must be an integer in [1, 1440]',
    });
  }

  const projectIds = new Set(config.project.map(project => project.id));
  if (root.projects !== undefined) {
    if (!Array.isArray(root.projects)) {
      errors.push({ path: 'root.projects', message: 'root.projects must be an array of project ids' });
    } else {
      if (root.projects.length === 0) {
        errors.push({ path: 'root.projects', message: 'root.projects must contain at least one project id' });
      }
      const seen = new Set<string>();
      root.projects.forEach((projectId, index) => {
        if (!nonEmptyString(projectId)) {
          errors.push({ path: `root.projects[${index}]`, message: 'root.projects[*] must be a non-empty string' });
          return;
        }
        if (!projectIds.has(projectId as string)) {
          errors.push({
            path: `root.projects[${index}]`,
            message: `root.projects references unknown project id "${projectId as string}"`,
          });
        }
        if (seen.has(projectId as string)) {
          errors.push({ path: `root.projects[${index}]`, message: `Duplicate root project id: ${projectId as string}` });
        }
        seen.add(projectId as string);
      });
    }
  }

  validateRootHost(config, root, errors);
  validateRootAccountIsolation(config, errors);
}

function validateRootAccountIsolation(config: BaxianConfig, errors: ValidationError[]): void {
  const root = config.root;
  if (!root || !VALID_MODES.includes(root.mode)) return;
  const rootHost = resolveAgentHost(config.host, root.host);
  if (root.mode === 'remote' && !rootHost) return;
  for (const project of config.project) {
    for (const group of project.agent) {
      for (const agent of group) {
        if (agent.yolo === false || !VALID_MODES.includes(agent.mode)) continue;
        const agentHost = resolveAgentHost(config.host, agent.host);
        if (agent.mode === 'remote' && !agentHost) continue;
        if (!mayShareHostAccount(root.mode, rootHost, agent.mode, agentHost)) continue;
        errors.push({
          path: `project.${project.id}.agent.${agent.id}.yolo`,
          message:
            `yolo agent "${agent.id}" may share the root mailbox OS account; ` +
            'set yolo: false or use a different explicit SSH user or hostname',
        });
      }
    }
  }
}

function validateRootHost(
  config: BaxianConfig,
  root: Record<string, unknown>,
  errors: ValidationError[],
): void {
  if (root.mode === 'local') {
    if (root.host !== undefined) {
      errors.push({ path: 'root.host', message: 'local root agent must not configure root.host' });
    }
    return;
  }
  if (root.mode !== 'remote') return;
  if (root.host === undefined || root.host === null) {
    errors.push({ path: 'root.host', message: 'remote root agent must reference a host' });
    return;
  }
  if (typeof root.host === 'string') {
    if (!config.host.some(host => host.id === root.host)) {
      errors.push({
        path: 'root.host',
        message: `remote root agent references unknown host id "${root.host}" — add it via Host 管理`,
      });
    }
    return;
  }
  if (!isRecord(root.host)) {
    errors.push({ path: 'root.host', message: 'root.host must be a host id (string) or an inline host object' });
    return;
  }
  if (!nonEmptyString(root.host.hostname)) {
    errors.push({ path: 'root.host.hostname', message: 'host.hostname must be a non-empty string' });
  }
  if (root.host.port !== undefined
    && (!Number.isInteger(root.host.port) || (root.host.port as number) <= 0 || (root.host.port as number) > 65535)) {
    errors.push({ path: 'root.host.port', message: 'host.port must be a positive integer ≤ 65535' });
  }
  if (root.host.user !== undefined && !nonEmptyString(root.host.user)) {
    errors.push({ path: 'root.host.user', message: 'host.user, if set, must be a non-empty string' });
  }
  if (root.host.password !== undefined) {
    errors.push({
      path: 'root.host.password',
      message: 'inline root.host must not carry a password; define it in the top-level host registry and reference it by id',
    });
  }
}

function validateAgentPairs(config: BaxianConfig, errors: ValidationError[]): void {
  for (const project of config.project) {
    if (!Array.isArray(project.agent)) continue;
    for (let i = 0; i < project.agent.length; i++) {
      const group = project.agent[i];
      const path = `project.${project.id}.agent[${i}]`;

      if (!Array.isArray(group)) {
        errors.push({ path, message: 'Agent group must be an array' });
        continue;
      }
      if (group.length === 0) {
        errors.push({ path, message: 'Agent group cannot be empty' });
        continue;
      }
      if (group.length > 3) {
        errors.push({ path, message: 'Agent group can have at most 3 agents' });
      }
      const counts = new Map<AgentRole, number>();
      for (const agent of group) counts.set(agent.role, (counts.get(agent.role) ?? 0) + 1);
      if (counts.get('dev') !== 1) {
        errors.push({ path, message: 'Agent group must contain exactly one dev agent' });
      }
      if ((counts.get('qa') ?? 0) > 1) {
        errors.push({ path, message: 'Agent group can contain at most one qa agent' });
      }
      if ((counts.get('research') ?? 0) > 1) {
        errors.push({ path, message: 'Agent group can contain at most one research agent' });
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
