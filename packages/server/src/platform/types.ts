import type { EventType } from '../shared/types.js';

export interface MappedEvent {
  type: EventType;
  repo: string;
  data: Record<string, unknown>;
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

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type MapValueSpec = string | { sources: string[]; optional?: boolean; values?: Record<string, string> };

export interface DriverOp {
  argv: string[];
  env?: Record<string, string>;
  stdin?: string;
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
  commentSources: CommentSourceOp[];
  visibilityLagSeconds: number;
  preflight: Array<{ argv: string[]; env?: Record<string, string>; fixMessage: string; versionCheck?: boolean }>;
  agentCommands: string[][];
  errorClasses: Array<{ class: string; regex: string[] }>;
}

export const PLACEHOLDERS: ReadonlySet<string> = new Set([
  'scheme', 'hostname', 'host', 'hostUrl', 'repoPath', 'repoPathEncoded',
  'prNumber', 'expectedHeadSha', 'remoteProjectId', 'branch', 'branchEncoded', 'body', 'binary',
]);

const TASK_CONTEXT_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'prNumber', 'expectedHeadSha', 'remoteProjectId', 'branch', 'branchEncoded', 'body',
]);
export const PREFLIGHT_PLACEHOLDERS: ReadonlySet<string> = new Set(
  [...PLACEHOLDERS].filter(p => !TASK_CONTEXT_PLACEHOLDERS.has(p)),
);

export const PLACEHOLDERS_WITH_PAGE: ReadonlySet<string> = new Set([...PLACEHOLDERS, 'page']);
export const PREFLIGHT_FIXMESSAGE_PLACEHOLDERS: ReadonlySet<string> = new Set([...PREFLIGHT_PLACEHOLDERS, 'minToolVersion']);

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

export const SINGLE_RESOURCE_OPS: ReadonlySet<string> = new Set(['prView', 'projectView', 'branchView']);
export const WRITE_OPS: ReadonlySet<string> = new Set(['comment', 'merge', 'close', 'deleteBranch']);

export const SHA_HEX_SOURCE = '[0-9a-fA-F]{7,64}';
