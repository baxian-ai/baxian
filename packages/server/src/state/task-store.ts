import { readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskPhase, TaskState, TaskStatus } from '../shared/index.js';
import {
  effectiveTaskReviewRound,
  isRecord,
  mapWithConcurrency,
  FS_READ_CONCURRENCY,
  TASK_PHASE_SET,
} from '../shared/index.js';

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export interface TaskFilter {
  projectId?: string;
  status?: TaskStatus;
}

function withTaskFileContext(file: string, error: unknown): unknown {
  if (error instanceof Error) error.message = `task file "${file}": ${error.message}`;
  return error;
}

const TASK_FIELDS = [
  'id', 'projectId', 'title', 'description', 'preferredAgentId',
  'agentId', 'devAgentId', 'qaAgentId', 'prNumber', 'prUrl', 'branch', 'branchCreatedByBaxian', 'branchCleanupPending', 'branchCleanupSkipped', 'remoteCleanup', 'branchLocalCleaned', 'latestHeadSha', 'reviewHeadAnchorSha',
  'reviewDispatchedAt', 'prFeedbackReceivedAt', 'reviewConversationUpdatedAt', 'fixDispatchedAt', 'reviewRound', 'reviewRoundPending', 'specReviewRound', 'phase', 'deliveryConfirmation', 'signalToken',
  'status', 'createdAt', 'updatedAt', 'images',
  'maxRoundsContinues',
  'postApproveRevoked', 'postApproveHeadSha', 'verdictOverdue',
  'passToken', 'failToken', 'pendingPrSignalToken', 'postApproveToken', 'postApproveGeneration', 'postApprovePhase', 'reviewDispatch', 'platformBinding', 'baseBranch', 'replyActorId', 'replyActorStatus',
  'closedUnmergedAnchor', 'passProvenance', 'consumedFeedback', 'outbox', 'pendingRedispatch', 'redispatchCount',
] as const;

const REVIEW_TOKEN_RE = /^[0-9a-f]{12}$/;

const TASK_STATUSES = new Set<TaskStatus>([
  'pending', 'in_progress', 'review', 'fixing', 'spec-ready', 'approved', 'merge-ready',
  'merged', 'done', 'max_rounds', 'failed', 'cancelled',
]);
const HEAD_SHA_RE = /^[0-9a-f]{7,64}$/i;
const REMOTE_FAILURE_KINDS = new Set([
  'config', 'binding', 'close', 'persist', 'delete', 'probe', 'tip-changed',
]);

export class TaskSchemaError extends Error {
  constructor(readonly field: string, expected: string) {
    super(`invalid task field "${field}": expected ${expected}`);
    this.name = 'TaskSchemaError';
  }
}

function taskSchemaError(field: string, expected: string): Error {
  return new TaskSchemaError(field, expected);
}

function requireString(raw: Record<string, unknown>, field: string, allowEmpty = false): void {
  const value = raw[field];
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw taskSchemaError(field, allowEmpty ? 'a string' : 'a non-empty string');
  }
}

function optionalString(raw: Record<string, unknown>, field: string): void {
  const value = raw[field];
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
    throw taskSchemaError(field, 'a non-empty string when present');
  }
}

function optionalInteger(raw: Record<string, unknown>, field: string, min = 0): void {
  const value = raw[field];
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < min)) {
    throw taskSchemaError(field, `an integer >= ${min} when present`);
  }
}

function optionalBoolean(raw: Record<string, unknown>, field: string): void {
  const value = raw[field];
  if (value !== undefined && typeof value !== 'boolean') {
    throw taskSchemaError(field, 'a boolean when present');
  }
}

function validateCleanupPending(raw: Record<string, unknown>, field: string): void {
  const value = raw[field];
  if (value === undefined) return;
  if (!isRecord(value)) throw taskSchemaError(field, 'an object when present');
  for (const key of ['agentId', 'reason', 'updatedAt']) requireString(value, key);
}

function validateRemoteCleanup(raw: Record<string, unknown>): void {
  const value = raw.remoteCleanup;
  if (value === undefined) return;
  if (!isRecord(value)) throw taskSchemaError('remoteCleanup', 'an object when present');
  if (typeof value.generation !== 'string' || !REVIEW_TOKEN_RE.test(value.generation)) {
    throw taskSchemaError('remoteCleanup.generation', 'a 12-hex token');
  }
  if (value.stage !== 'close-pending' && value.stage !== 'delete-pending' && value.stage !== 'manual') {
    throw taskSchemaError('remoteCleanup.stage', 'close-pending, delete-pending, or manual');
  }
  if (!Number.isInteger(value.prNumber) || (value.prNumber as number) < 1) {
    throw taskSchemaError('remoteCleanup.prNumber', 'a positive integer');
  }
  for (const field of ['branch', 'updatedAt']) requireString(value, field);
  if (value.expectedHeadSha !== undefined
    && (typeof value.expectedHeadSha !== 'string' || !HEAD_SHA_RE.test(value.expectedHeadSha))) {
    throw taskSchemaError('remoteCleanup.expectedHeadSha', 'a hex commit sha when present');
  }
  optionalString(value, 'remoteProjectId');
  if (value.failure !== undefined) {
    if (!isRecord(value.failure) || typeof value.failure.kind !== 'string'
      || !REMOTE_FAILURE_KINDS.has(value.failure.kind)) {
      throw taskSchemaError('remoteCleanup.failure.kind', 'a known remote cleanup failure kind');
    }
    for (const field of ['message', 'at']) requireString(value.failure, field);
  }
  if (value.stage === 'delete-pending'
    && (value.expectedHeadSha === undefined || value.remoteProjectId === undefined)) {
    throw taskSchemaError('remoteCleanup', 'expectedHeadSha and remoteProjectId during delete-pending');
  }
  if (value.stage === 'manual' && value.failure === undefined) {
    throw taskSchemaError('remoteCleanup.failure', 'present during manual cleanup');
  }
}

function validateTask(raw: Record<string, unknown>): void {
  requireString(raw, 'id');
  requireString(raw, 'projectId');
  requireString(raw, 'title');
  requireString(raw, 'description', true);
  requireString(raw, 'preferredAgentId', true);
  requireString(raw, 'agentId', true);
  requireString(raw, 'devAgentId', true);
  requireString(raw, 'createdAt');
  requireString(raw, 'updatedAt');
  optionalString(raw, 'qaAgentId');
  for (const field of [
    'prUrl', 'branch', 'latestHeadSha', 'reviewHeadAnchorSha', 'reviewDispatchedAt',
    'prFeedbackReceivedAt', 'reviewConversationUpdatedAt', 'fixDispatchedAt', 'signalToken',
    'postApproveHeadSha',
  ]) optionalString(raw, field);
  if (!Number.isInteger(raw.reviewRound) || (raw.reviewRound as number) < 0) {
    throw taskSchemaError('reviewRound', 'an integer >= 0');
  }
  if (raw.phase !== undefined && (
    typeof raw.phase !== 'string' || !TASK_PHASE_SET.has(raw.phase as TaskPhase)
  )) {
    throw taskSchemaError('phase', 'spec or code when present');
  }
  if (raw.deliveryConfirmation !== undefined) {
    const confirmation = raw.deliveryConfirmation;
    if (!isRecord(confirmation)
      || (confirmation.phase !== 'spec' && confirmation.phase !== 'code')
      || (confirmation.source !== 'signal' && confirmation.source !== 'human')
      || typeof confirmation.at !== 'string' || !Number.isFinite(Date.parse(confirmation.at))) {
      throw taskSchemaError('deliveryConfirmation', 'a { phase, source, at } record');
    }
    if (confirmation.phase !== raw.phase) {
      throw taskSchemaError('deliveryConfirmation.phase', 'the current task phase');
    }
  }
  if (typeof raw.status !== 'string' || !TASK_STATUSES.has(raw.status as TaskStatus)) {
    throw taskSchemaError('status', 'a known task status');
  }
  optionalInteger(raw, 'prNumber', 1);
  optionalInteger(raw, 'specReviewRound', 0);
  optionalInteger(raw, 'maxRoundsContinues', 0);
  for (const field of ['branchCreatedByBaxian', 'verdictOverdue', 'reviewRoundPending']) optionalBoolean(raw, field);
  if (raw.images !== undefined && (
    !Array.isArray(raw.images)
    || raw.images.some(image => typeof image !== 'string' || image.trim() === '')
  )) {
    throw taskSchemaError('images', 'an array of non-empty strings when present');
  }
  validateCleanupPending(raw, 'branchCleanupPending');
  validateCleanupPending(raw, 'branchCleanupSkipped');
  validateRemoteCleanup(raw);
  if (raw.branchLocalCleaned !== undefined) {
    const cleaned = raw.branchLocalCleaned;
    if (!isRecord(cleaned)
      || typeof cleaned.remoteTipSha !== 'string'
      || !/^[0-9a-f]{40,64}$/i.test(cleaned.remoteTipSha)) {
      throw taskSchemaError('branchLocalCleaned', 'a record with a commit-sha remoteTipSha when present');
    }
    requireString(cleaned, 'updatedAt');
  }
  validateGitReviewFields(raw);
  const participantIds = [raw.devAgentId, raw.qaAgentId]
    .filter((value): value is string => typeof value === 'string' && value !== '');
  if (new Set(participantIds).size !== participantIds.length) {
    throw taskSchemaError('participants', 'distinct dev and qa agent ids');
  }
  if ((raw.devAgentId === '') !== (raw.qaAgentId === undefined)) {
    throw taskSchemaError('participants', 'a complete dev and qa pair, or neither when unassigned');
  }
  if (raw.agentId !== '' && raw.agentId !== raw.devAgentId) {
    throw taskSchemaError('agentId', 'the task dev agent id');
  }
}

function validateGitReviewFields(raw: Record<string, unknown>): void {
  optionalBoolean(raw, 'pendingRedispatch');
  optionalInteger(raw, 'redispatchCount', 0);
  for (const field of ['passToken', 'failToken']) {
    const value = raw[field];
    if (value !== undefined && (typeof value !== 'string' || !REVIEW_TOKEN_RE.test(value))) {
      throw taskSchemaError(field, 'a 12-hex review token when present');
    }
  }
  optionalString(raw, 'pendingPrSignalToken');
  optionalString(raw, 'postApproveToken');
  if (raw.postApproveGeneration !== undefined
    && (typeof raw.postApproveGeneration !== 'string' || !REVIEW_TOKEN_RE.test(raw.postApproveGeneration))) {
    throw taskSchemaError('postApproveGeneration', 'a 12-hex generation when present');
  }
  if (raw.postApprovePhase !== undefined
    && raw.postApprovePhase !== 'installed' && raw.postApprovePhase !== 'delivered'
    && raw.postApprovePhase !== 'signaled') {
    throw taskSchemaError('postApprovePhase', 'installed, delivered, or signaled when present');
  }
  const revoked = raw.postApproveRevoked;
  if (revoked !== undefined && (!isRecord(revoked)
    || typeof revoked.generation !== 'string' || !REVIEW_TOKEN_RE.test(revoked.generation)
    || (revoked.reason !== 'request-changes' && revoked.reason !== 'redispatch-cap'))) {
    throw taskSchemaError('postApproveRevoked', 'a generation-bound revocation record when present');
  }
  if (isRecord(revoked)) requireString(revoked, 'at');
  const activeFields = [
    raw.postApproveGeneration,
    raw.postApproveHeadSha,
    raw.postApproveToken,
    raw.postApprovePhase,
  ];
  const activeCount = activeFields.filter(value => value !== undefined).length;
  if (activeCount !== 0 && activeCount !== activeFields.length) {
    throw taskSchemaError('postApproveGeneration', 'a complete post-approve episode');
  }
  const activeEpisode = activeCount === activeFields.length;
  if (activeEpisode) {
    if (raw.status !== 'approved' || revoked !== undefined) {
      throw taskSchemaError('postApproveGeneration', 'an active episode only while approved and not revoked');
    }
    if (typeof raw.postApproveHeadSha !== 'string' || !HEAD_SHA_RE.test(raw.postApproveHeadSha)) {
      throw taskSchemaError('postApproveHeadSha', 'a commit sha for an active episode');
    }
  }
  if (revoked !== undefined && (raw.status !== 'approved' || activeCount !== 0)) {
    throw taskSchemaError('postApproveRevoked', 'a revoked approved episode without active fields');
  }
  if (!activeEpisode && (raw.pendingRedispatch !== undefined || raw.redispatchCount !== undefined)) {
    throw taskSchemaError('pendingRedispatch', 'part of an active post-approve episode');
  }
  if (raw.status !== 'approved' && (activeEpisode || revoked !== undefined
    || raw.pendingRedispatch !== undefined || raw.redispatchCount !== undefined)) {
    throw taskSchemaError('postApproveGeneration', 'no post-approve effects outside approved');
  }
  if (raw.reviewDispatch !== undefined) {
    const lease = raw.reviewDispatch;
    if (!isRecord(lease)) throw taskSchemaError('reviewDispatch', 'an object when present');
    for (const field of ['generation', 'signalToken', 'passToken', 'failToken']) {
      if (typeof lease[field] !== 'string' || !REVIEW_TOKEN_RE.test(lease[field] as string)) {
        throw taskSchemaError(`reviewDispatch.${field}`, 'a 12-hex token');
      }
    }
    if (typeof lease.headSha !== 'string' || !HEAD_SHA_RE.test(lease.headSha)) {
      throw taskSchemaError('reviewDispatch.headSha', 'a hex commit sha');
    }
    if (lease.phase !== 'pending' && lease.phase !== 'claimed' && lease.phase !== 'uncertain') {
      throw taskSchemaError('reviewDispatch.phase', 'pending, claimed, or uncertain');
    }
    if (lease.qaPhase !== 'review' && lease.qaPhase !== 'recheck') {
      throw taskSchemaError('reviewDispatch.qaPhase', 'review or recheck');
    }
    if (!Number.isInteger(lease.effectiveRound) || (lease.effectiveRound as number) < 1) {
      throw taskSchemaError('reviewDispatch.effectiveRound', 'an integer >= 1');
    }
    requireString(lease, 'updatedAt');
    if (lease.phase === 'pending') {
      if (lease.claimId !== undefined || lease.claimedAt !== undefined) {
        throw taskSchemaError('reviewDispatch', 'no claim fields while pending');
      }
    } else {
      if (typeof lease.claimId !== 'string' || !REVIEW_TOKEN_RE.test(lease.claimId)) {
        throw taskSchemaError('reviewDispatch.claimId', 'a 12-hex token while claimed or uncertain');
      }
      requireString(lease, 'claimedAt');
    }
    const effectiveRound = effectiveTaskReviewRound(raw as unknown as TaskState);
    if (raw.status !== 'review' || raw.signalToken !== lease.signalToken
      || raw.reviewHeadAnchorSha !== lease.headSha
      || raw.passToken !== lease.passToken
      || raw.failToken !== lease.failToken
      || lease.effectiveRound !== effectiveRound) {
      throw taskSchemaError('reviewDispatch', 'the current git review pass tuple');
    }
  }
  if (raw.platformBinding !== undefined) {
    const binding = raw.platformBinding;
    const keys = ['mode', 'repoKey', 'tool'];
    if (!isRecord(binding) || keys.some(key => typeof binding[key] !== 'string' || (binding[key] as string).trim() === '')) {
      throw taskSchemaError('platformBinding', 'a { mode, repoKey, tool } identity record when present');
    }
  }
  optionalString(raw, 'baseBranch');
  optionalString(raw, 'replyActorId');
  if (raw.replyActorStatus !== undefined
    && raw.replyActorStatus !== 'verified' && raw.replyActorStatus !== 'provisional') {
    throw taskSchemaError('replyActorStatus', 'verified or provisional when present');
  }
  if (raw.closedUnmergedAnchor !== undefined) {
    const anchor = raw.closedUnmergedAnchor;
    if (!isRecord(anchor)
      || !Number.isInteger(anchor.prNumber) || (anchor.prNumber as number) < 1
      || !Number.isInteger(anchor.generation) || (anchor.generation as number) < 1
      || (anchor.cleared !== undefined && typeof anchor.cleared !== 'boolean')) {
      throw taskSchemaError('closedUnmergedAnchor', 'a { prNumber >= 1, generation >= 1 } record when present');
    }
  }
  if (raw.passProvenance !== undefined) {
    const prov = raw.passProvenance;
    const keys = ['sourceKey', 'id', 'bodyDigest', 'token', 'failToken', 'anchorSha'];
    if (!isRecord(prov) || keys.some(key => typeof prov[key] !== 'string' || (prov[key] as string).trim() === '')) {
      throw taskSchemaError('passProvenance', 'a carrier provenance record when present');
    }
  }
  if (raw.consumedFeedback !== undefined) {
    const consumed = raw.consumedFeedback;
    if (!isRecord(consumed) || Array.isArray(consumed)
      || Object.values(consumed).some(v => typeof v !== 'number' || !Number.isFinite(v))) {
      throw taskSchemaError('consumedFeedback', 'a record of finite versionTime numbers when present');
    }
  }
  if (raw.outbox !== undefined) {
    const outbox = raw.outbox;
    if (!Array.isArray(outbox)) throw taskSchemaError('outbox', 'an array of pending operation entries when present');
    const keys = new Set<string>();
    let hasSpecVerdict = false;
    for (const entry of outbox) {
      if (!isRecord(entry) || typeof entry.key !== 'string' || entry.key.trim() === ''
        || keys.has(entry.key) || !isRecord(entry.data)) {
        throw taskSchemaError('outbox', 'entries with unique non-empty keys and object data');
      }
      keys.add(entry.key);
      if (entry.type === 'human.intervention') continue;
      if (entry.type !== 'git.spec-verdict') {
        throw taskSchemaError('outbox.type', 'human.intervention or git.spec-verdict');
      }
      if (hasSpecVerdict) throw taskSchemaError('outbox', 'at most one git.spec-verdict entry');
      hasSpecVerdict = true;
      const data = entry.data;
      if (!REVIEW_TOKEN_RE.test(entry.key)
        || !Number.isInteger(data.prNumber) || (data.prNumber as number) < 1
        || typeof data.comments !== 'string' || data.comments.trim() === ''
        || (data.writeAttemptedAt !== undefined
          && (typeof data.writeAttemptedAt !== 'string' || data.writeAttemptedAt.trim() === ''))
        || raw.phase !== 'spec' || raw.prNumber !== data.prNumber
        || (raw.status !== 'spec-ready' && raw.status !== 'max_rounds')
        || !Number.isInteger(raw.specReviewRound) || (raw.specReviewRound as number) < 1) {
        throw taskSchemaError('outbox', 'a valid current spec-phase git verdict operation');
      }
    }
  }
}

function sanitizeTask(state: unknown): TaskState {
  if (!isRecord(state)) throw new Error('invalid task: expected an object');
  const raw = state;
  if ('reviewDispatchPending' in raw) {
    throw taskSchemaError('reviewDispatchPending', 'unsupported; use reviewDispatch');
  }
  const out: Partial<TaskState> = {};
  for (const k of TASK_FIELDS) {
    const value = raw[k];
    if (value !== undefined) {
      (out as Record<string, unknown>)[k] = value;
    }
  }
  validateTask(out as Record<string, unknown>);
  return out as TaskState;
}

export type TaskStoreChangeKind = 'set' | 'delete';
export type TaskStoreListener = (kind: TaskStoreChangeKind, taskId: string) => void;

export class TaskStore {
  private listeners = new Set<TaskStoreListener>();

  constructor(private dir: string) {}

  onChange(fn: TaskStoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async get(id: string): Promise<TaskState | null> {
    if (!SAFE_ID.test(id)) return null;
    let content: string;
    try {
      content = await readFile(this.path(id), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
      throw err;
    }
    return sanitizeTask({ ...(JSON.parse(content) as Record<string, unknown>), id });
  }

  async set(state: TaskState): Promise<void> {
    if (!SAFE_ID.test(state.id)) throw new Error(`invalid task id: ${state.id}`);
    const sanitized = sanitizeTask(state);
    const final = this.path(state.id);
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(sanitized, null, 2) + '\n');
    await rename(tmp, final);
    this.fire('set', state.id);
  }

  async list(filter?: TaskFilter): Promise<TaskState[]> {
    return this.listInternal(filter, false);
  }

  async listStrict(filter?: TaskFilter): Promise<TaskState[]> {
    return this.listInternal(filter, true);
  }

  private async listInternal(filter: TaskFilter | undefined, strict: boolean): Promise<TaskState[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      if (strict) throw err;
      return [];
    }
    const loaded = await mapWithConcurrency(
      files.filter(f => f.endsWith('.json')),
      FS_READ_CONCURRENCY,
      async (file) => {
        try {
          const content = await readFile(join(this.dir, file), 'utf-8');
          const raw = JSON.parse(content) as Record<string, unknown>;
          return sanitizeTask({ ...raw, id: file.slice(0, -'.json'.length) });
        } catch (err) {
          if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
          if (strict || err instanceof TaskSchemaError) throw withTaskFileContext(file, err);
          console.warn(`[TaskStore] skipping unreadable file ${file}:`, err);
          return null;
        }
      },
    );
    return loaded.filter((task): task is TaskState => {
      if (!task) return false;
      if (filter?.projectId && task.projectId !== filter.projectId) return false;
      if (filter?.status && task.status !== filter.status) return false;
      return true;
    });
  }

  async nextId(): Promise<string> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      files = [];
    }
    const maxNum = files.reduce((max, f) => {
      const match = f.match(/^task-(\d+)\.json$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
    return `task-${String(maxNum + 1).padStart(3, '0')}`;
  }

  async delete(id: string): Promise<void> {
    if (!SAFE_ID.test(id)) return;
    try {
      await unlink(this.path(id));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') {
        console.error(`[TaskStore] delete ${id} failed; not broadcasting:`, err);
        return;
      }
    }
    this.fire('delete', id);
  }

  private fire(kind: TaskStoreChangeKind, id: string): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(kind, id);
      } catch (err) {
        console.error(`[TaskStore] listener threw on ${kind} ${id}:`, err);
      }
    }
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}
