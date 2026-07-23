import type { EventType } from '../shared/types.js';

export interface MappedEvent {
  type: EventType;
  repo: string;
  data: Record<string, unknown>;
  // poller 侧已完成的任务绑定：消费端不得再按 branch/prNumber 反查（收编谓词只此一处）
  taskId?: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  kind: 'git-driver';
  tool: string;
  minToolVersion: string;
  driverSchema: 1;
}

export interface PluginValidationError {
  pluginPath: string;
  message: string;
}

// 加载期（driver-spec）与渲染期（command-renderer）共用同一份 env key 形状约束，防两处漂移。
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type MapValueSpec = string | { sources: string[]; optional?: boolean; values?: Record<string, string> };

export interface DriverOp {
  argv: string[];
  env?: Record<string, string>;
  parse?: 'json' | 'json-paged';
  responseEnvelope?: 'graphql';
  flatten?: string;
  map?: Record<string, MapValueSpec>;
  optional?: boolean;
  treatAsSuccess?: string[];
}

export const SOURCE_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface CommentSourceOp extends DriverOp {
  key: string;
}

export interface DriverSpec {
  ops: Record<string, DriverOp>;
  // listComments 在解析期归一化拆出：单对象 → [{...op, key: 'default'}]。评论水位按 (PR, source key)
  // 独立持久化，key 是跨插件升级稳定的 cursor 身份（spec §5.3 增量①）。
  commentSources: CommentSourceOp[];
  visibilityLagSeconds: number;
  preflight: Array<{ argv: string[]; env?: Record<string, string>; fixMessage: string; versionCheck?: boolean }>;
  // agent 面 skill 的运行期命令依赖：每组任一命令在 PATH 即满足（如 [["openssl"],["shasum","sha256sum"]]）
  agentCommands: string[][];
  errorClasses: Array<{ class: string; regex: string[] }>;
}

export const PLACEHOLDERS: ReadonlySet<string> = new Set([
  'scheme', 'hostname', 'host', 'hostUrl', 'repoPath', 'repoPathEncoded',
  'prNumber', 'expectedHeadSha', 'remoteProjectId', 'branch', 'branchEncoded', 'binary',
]);

// preflight 跑在任务收编前，没有任务上下文占位符可用——从 PLACEHOLDERS 派生以强制子集不变量。
const TASK_CONTEXT_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'prNumber', 'expectedHeadSha', 'remoteProjectId', 'branch', 'branchEncoded',
]);
export const PREFLIGHT_PLACEHOLDERS: ReadonlySet<string> = new Set(
  [...PLACEHOLDERS].filter(p => !TASK_CONTEXT_PLACEHOLDERS.has(p)),
);

export const PLACEHOLDERS_WITH_PAGE: ReadonlySet<string> = new Set([...PLACEHOLDERS, 'page']);
export const PREFLIGHT_FIXMESSAGE_PLACEHOLDERS: ReadonlySet<string> = new Set([...PREFLIGHT_PLACEHOLDERS, 'minToolVersion']);

// 字段登记表是允许集与行 schema 类型分派的唯一来源：两份手工清单会静默漂移——
// 漏登类型的字段经默认分支不校验透传，与本模块 fail-closed 纪律相反。
export type MapFieldKind = 'id' | 'prNumber' | 'sha' | 'timestamp' | 'state' | 'boolean' | 'integer' | 'string';
export const MAP_FIELD_KINDS: Readonly<Record<string, MapFieldKind>> = {
  prNumber: 'prNumber',
  prUrl: 'string', branch: 'string', targetBranch: 'string', title: 'string', body: 'string',
  author: 'string', prAuthor: 'string', reviewState: 'string', detailedMergeStatus: 'string',
  defaultBranch: 'string', username: 'string', path: 'string', state: 'state',
  headSha: 'sha', commitSha: 'sha',
  mergedAt: 'timestamp', updatedAt: 'timestamp', createdAt: 'timestamp', approvedAt: 'timestamp',
  sourceProjectId: 'id', targetProjectId: 'id', remoteProjectId: 'id', id: 'id', discussionId: 'id', parentId: 'id',
  authorId: 'id', prAuthorId: 'id',
  draft: 'boolean', system: 'boolean', resolvable: 'boolean', resolved: 'boolean', pushPermitted: 'boolean',
  line: 'integer', originalLine: 'integer',
};
export const MAP_TARGET_FIELDS: ReadonlySet<string> = new Set(Object.keys(MAP_FIELD_KINDS));

// 生命周期 op 分类为加载期契约与运行期执行共用（parse 形态门 ↔ 单行基数门、
// treatAsSuccess 允许域 ↔ 幂等成功折叠），两处各自拼写会改一漏一。
export const SINGLE_RESOURCE_OPS: ReadonlySet<string> = new Set(['prView', 'projectView', 'branchView']);
export const WRITE_OPS: ReadonlySet<string> = new Set(['merge', 'close', 'deleteBranch']);

// sha 段文法单点定义：加载期/渲染期/行 schema/线协议共用，收放接受域不再多处同步。
export const SHA_HEX_SOURCE = '[0-9a-fA-F]{7,64}';
