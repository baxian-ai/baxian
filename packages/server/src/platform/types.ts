import type { EventType } from '../shared/types.js';
import type { NormalizedRow } from './row-schema.js';

const SAFE_ERROR_SUMMARY_CHARS = 200;
export const COMMENT_BODY_MAX_BYTES = 64 * 1024;
// Shared with the completion-signal decoder: an actor id that rows accept must survive the signal round-trip.
export const PLATFORM_ACTOR_ID_MAX_BYTES = 128;

export interface PlatformEvent {
  type: EventType;
  repo: string;
  data: Record<string, unknown>;
  taskId?: string;
}

export const COMMENT_SOURCE_CLASSES = ['top-level', 'threaded', 'reviews'] as const;
export type CommentSourceClass = (typeof COMMENT_SOURCE_CLASSES)[number];

export interface CommentSource {
  key: string;
  category: CommentSourceClass;
}

export interface PlatformAgentPrompts {
  common: string;
  publish: string;
  feedback: string;
  review: string;
}

export interface PlatformPromptContext {
  repo: string;
  prompts: PlatformAgentPrompts;
}

export interface DriverExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type DriverExec = (
  command: string,
  opts: { timeout: number; maxBuffer: number; stdin?: Buffer },
) => Promise<DriverExecResult>;

export interface PlatformDriver {
  readonly visibilityLagMs: number;
  readonly commentSources: readonly CommentSource[];
  runPreflightSteps(): Promise<Array<{ step: string; ok: boolean; message: string }>>;
  projectView(): Promise<NormalizedRow>;
  prView(prNumber: number): Promise<NormalizedRow>;
  branchView(remoteProjectId: string, branch: string): Promise<NormalizedRow>;
  listPrs(
    shouldStop?: (pageRows: NormalizedRow[], page: number) => boolean,
  ): Promise<NormalizedRow[]>;
  listComments(
    source: CommentSource,
    prNumber: number,
    projectPage?: (pageRows: NormalizedRow[]) => NormalizedRow[],
    shouldStop?: (pageRows: NormalizedRow[], page: number) => boolean,
  ): Promise<NormalizedRow[]>;
  postComment(prNumber: number, body: string): Promise<void>;
  mergePr(prNumber: number, expectedHeadSha: string): Promise<void>;
  closePr(prNumber: number): Promise<void>;
  deleteBranch(remoteProjectId: string, branch: string, expectedHeadSha: string): Promise<void>;
}

export interface PlatformProvider {
  readonly platform: string;
  normalizeRepoUrl(url: string): string | null;
  createDriver(repoSlug: string, exec: DriverExec): PlatformDriver;
  readonly prompts: PlatformAgentPrompts;
}

export const PLATFORM_PLUGIN_API_VERSION = 1;

export interface PlatformPluginHost {
  readonly DriverOpError: typeof DriverOpError;
  readonly DriverInputError: typeof DriverInputError;
  readonly validateCommentBody: (body: string) => void;
  readonly shellQuote: (value: string) => string;
}

export interface PlatformPlugin {
  readonly apiVersion: typeof PLATFORM_PLUGIN_API_VERSION;
  readonly provider: PlatformProvider;
}

export class DriverOpError extends Error {
  constructor(
    message: string,
    readonly info: { opName: string; errorClass?: string; exitCode?: number; stderrTail?: string },
  ) {
    super(message);
    this.name = 'DriverOpError';
  }
}

export class DriverInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverInputError';
  }
}

export function safeDriverErrorText(err: unknown): string {
  if (err instanceof DriverOpError) {
    const cls = err.info.errorClass ? `, class ${err.info.errorClass}` : '';
    return `op ${err.info.opName} failed (exit ${err.info.exitCode ?? 'n/a'}${cls})`;
  }
  if (err instanceof Error) {
    const head = err.message.slice(0, SAFE_ERROR_SUMMARY_CHARS);
    const clipped = err.message.length > SAFE_ERROR_SUMMARY_CHARS ? '…' : '';
    return `${err.name}: ${head}${clipped}`;
  }
  return String(err).slice(0, SAFE_ERROR_SUMMARY_CHARS);
}

export function validateCommentBody(body: string): void {
  if (body.trim() === '') throw new DriverInputError('comment body must be non-empty');
  if (body.includes('\0')) throw new DriverInputError('comment body must not contain NUL');
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > COMMENT_BODY_MAX_BYTES) {
    throw new DriverInputError(`comment body exceeds ${COMMENT_BODY_MAX_BYTES} bytes`);
  }
}

export const SOURCE_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;
export const SHA_HEX_SOURCE = '[0-9a-fA-F]{7,64}';
