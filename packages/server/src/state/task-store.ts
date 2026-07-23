import { readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskPhase, TaskState, TaskStatus } from '../shared/index.js';
import { isRecord, mapWithConcurrency, FS_READ_CONCURRENCY } from '../shared/index.js';

// a store id becomes a filename; constrain it so a path-like id can't escape the store dir
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
  'agentId', 'devAgentId', 'qaAgentId', 'researchAgentId', 'prNumber', 'prUrl', 'branch', 'branchCreatedByBaxian', 'branchCleanupPending', 'branchCleanupSkipped', 'remoteCleanup', 'branchLocalCleaned', 'latestHeadSha', 'reviewHeadAnchorSha',
  'reviewDispatchedAt', 'prFeedbackReceivedAt', 'reviewConversationUpdatedAt', 'fixDispatchedAt', 'reviewRound', 'reviewRoundPending', 'specReviewRound', 'phase', 'signalToken',
  'serverSignalRecovery',
  'status', 'createdAt', 'updatedAt', 'images',
  'reviewMode', 'batchIndex', 'batchTotal', 'reviewCheckoutMode', 'maxRoundsContinues', 'afterDone', 'publishDispatchedAt',
  'postApproveRevoked', 'postApproveHeadSha', 'verdictOverdue',
  'passToken', 'failToken', 'pendingPrSignalToken', 'postApproveToken', 'postApproveGeneration', 'postApprovePhase', 'reviewDispatch', 'platformBinding', 'baseBranch', 'replyActorId', 'replyActorStatus',
  'closedUnmergedAnchor', 'passProvenance', 'consumedFeedback', 'outbox', 'pendingRedispatch', 'redispatchCount',
] as const;

const REVIEW_TOKEN_RE = /^[0-9a-f]{12}$/;

const TASK_STATUSES = new Set<TaskStatus>([
  'pending', 'in_progress', 'review', 'fixing', 'spec-ready', 'approved', 'merge-ready',
  'ready', 'merged', 'done', 'max_rounds', 'failed', 'cancelled',
]);
const TASK_PHASES = new Set<TaskPhase>(['research', 'spec', 'code']);
const SERVER_SIGNAL_KINDS = new Set([
  'code-done', 'code-reviewed', 'code-fixed', 'code-ready', 'spec-done', 'spec-reviewed', 'spec-fixed',
]);
const SERVER_RECOVERY_MODES = new Set(['classify-response', 'correct-response', 'hold']);
const SERVER_RECOVERY_REASONS = new Set([
  'response-missing', 'response-invalid', 'round-mismatch', 'token-mismatch',
  'findings-digest-mismatch', 'coverage-gap', 'fix-no-dev-agent', 'fix-findings-missing',
  'response-read-failed', 'verdict-store-failed', 'handler-failed',
]);
const SERVER_RESPONSE_REASONS = new Set([
  'response-missing', 'response-invalid', 'round-mismatch', 'token-mismatch',
  'findings-digest-mismatch', 'coverage-gap',
]);
const SHA256_RE = /^[0-9a-f]{64}$/;
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
  if (raw.reviewMode !== 'git') throw taskSchemaError('remoteCleanup', 'present only for git review tasks');
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

function validateSortedStringArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw taskSchemaError(field, 'an array of non-empty strings when present');
  }
  const sorted = [...value].sort();
  if (new Set(value).size !== value.length || value.some((item, index) => item !== sorted[index])) {
    throw taskSchemaError(field, 'a sorted array of unique strings when present');
  }
}

function validateServerSignalRecovery(raw: Record<string, unknown>): void {
  const value = raw.serverSignalRecovery;
  if (value === undefined) return;
  if (!isRecord(value)) throw taskSchemaError('serverSignalRecovery', 'an object when present');
  if (typeof value.mode !== 'string' || !SERVER_RECOVERY_MODES.has(value.mode)) {
    throw taskSchemaError('serverSignalRecovery.mode', 'classify-response, correct-response, or hold');
  }
  if (typeof value.signalKind !== 'string' || !SERVER_SIGNAL_KINDS.has(value.signalKind)) {
    throw taskSchemaError('serverSignalRecovery.signalKind', 'a server review signal kind');
  }
  if (value.phase !== 'spec' && value.phase !== 'code') {
    throw taskSchemaError('serverSignalRecovery.phase', 'spec or code');
  }
  if (!Number.isInteger(value.round) || (value.round as number) < 0) {
    throw taskSchemaError('serverSignalRecovery.round', 'an integer >= 0');
  }
  for (const field of ['sourceToken', 'createdAt']) requireString(value, field);
  if (typeof value.reason !== 'string' || !SERVER_RECOVERY_REASONS.has(value.reason)) {
    throw taskSchemaError('serverSignalRecovery.reason', 'a known recovery reason');
  }
  for (const field of ['findingsDigest', 'failureSignature', 'responseDigest']) {
    const digest = value[field];
    if (digest !== undefined && (typeof digest !== 'string' || !SHA256_RE.test(digest))) {
      throw taskSchemaError(`serverSignalRecovery.${field}`, 'a lowercase SHA-256 digest when present');
    }
  }
  optionalString(value, 'failurePhase');
  for (const field of ['missingFindingIds', 'unknownFindingIds', 'schemaViolationCodes']) {
    validateSortedStringArray(value[field], `serverSignalRecovery.${field}`);
  }
  const responseMode = value.mode === 'classify-response' || value.mode === 'correct-response';
  if (responseMode && (
    !SERVER_RESPONSE_REASONS.has(value.reason as string)
    || (value.signalKind !== 'code-fixed' && value.signalKind !== 'spec-fixed')
    || typeof value.findingsDigest !== 'string'
    || typeof value.failureSignature !== 'string'
    || (value.reason !== 'response-missing' && typeof value.responseDigest !== 'string')
  )) {
    throw taskSchemaError('serverSignalRecovery', 'response recovery fields for classify/correct mode');
  }
  const expectedPhase = String(value.signalKind).startsWith('spec-') ? 'spec' : 'code';
  if (value.phase !== expectedPhase) {
    throw taskSchemaError('serverSignalRecovery.signalKind', `a ${value.phase} signal kind`);
  }
  const taskPhaseMatches = value.phase === 'spec'
    ? raw.phase !== 'code'
    : raw.phase === 'code' || raw.phase === undefined;
  if (!taskPhaseMatches) {
    throw taskSchemaError('serverSignalRecovery.phase', 'the current task phase');
  }
  const currentRound = value.phase === 'spec' ? (raw.specReviewRound ?? 0) : raw.reviewRound;
  if (value.round !== currentRound) {
    throw taskSchemaError('serverSignalRecovery.round', 'the current task review round');
  }
  if (typeof raw.signalToken !== 'string' || raw.signalToken === value.sourceToken) {
    throw taskSchemaError('serverSignalRecovery.sourceToken', 'a token superseded by task.signalToken');
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
  optionalString(raw, 'researchAgentId');
  for (const field of [
    'prUrl', 'branch', 'latestHeadSha', 'reviewHeadAnchorSha', 'reviewDispatchedAt',
    'prFeedbackReceivedAt', 'reviewConversationUpdatedAt', 'fixDispatchedAt', 'signalToken',
    'publishDispatchedAt', 'postApproveHeadSha',
  ]) optionalString(raw, field);
  if (!Number.isInteger(raw.reviewRound) || (raw.reviewRound as number) < 0) {
    throw taskSchemaError('reviewRound', 'an integer >= 0');
  }
  if (raw.phase !== undefined && (
    typeof raw.phase !== 'string' || !TASK_PHASES.has(raw.phase as TaskPhase)
  )) {
    throw taskSchemaError('phase', 'research, spec, or code when present');
  }
  if (typeof raw.status !== 'string' || !TASK_STATUSES.has(raw.status as TaskStatus)) {
    throw taskSchemaError('status', 'a known task status');
  }
  optionalInteger(raw, 'prNumber', 1);
  optionalInteger(raw, 'specReviewRound', 0);
  optionalInteger(raw, 'batchIndex', 0);
  optionalInteger(raw, 'batchTotal', 1);
  optionalInteger(raw, 'maxRoundsContinues', 0);
  for (const field of ['branchCreatedByBaxian', 'verdictOverdue', 'reviewRoundPending']) optionalBoolean(raw, field);
  if (raw.images !== undefined && (
    !Array.isArray(raw.images)
    || raw.images.some(image => typeof image !== 'string' || image.trim() === '')
  )) {
    throw taskSchemaError('images', 'an array of non-empty strings when present');
  }
  if (raw.reviewMode !== 'git' && raw.reviewMode !== 'server') {
    throw taskSchemaError('reviewMode', 'git or server');
  }
  if (raw.reviewCheckoutMode !== undefined
    && raw.reviewCheckoutMode !== 'head' && raw.reviewCheckoutMode !== 'base') {
    throw taskSchemaError('reviewCheckoutMode', 'head or base when present');
  }
  if (raw.afterDone !== undefined && raw.afterDone !== null
    && raw.afterDone !== 'pr' && raw.afterDone !== 'branch') {
    throw taskSchemaError('afterDone', 'pr, branch, or null when present');
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
  validateServerSignalRecovery(raw);
  validateGitReviewFields(raw);
  const participantIds = [raw.devAgentId, raw.qaAgentId, raw.researchAgentId]
    .filter((value): value is string => typeof value === 'string' && value !== '');
  if (new Set(participantIds).size !== participantIds.length) {
    throw taskSchemaError('participants', 'distinct dev, qa, and research agent ids');
  }
  if (raw.agentId !== '' && raw.agentId !== raw.devAgentId && raw.agentId !== raw.researchAgentId) {
    throw taskSchemaError('agentId', 'the task dev or research agent id');
  }
  if (raw.phase === 'research' && raw.researchAgentId === undefined) {
    throw taskSchemaError('researchAgentId', 'a non-empty string during research phase');
  }
  if (raw.phase === undefined && raw.researchAgentId !== undefined) {
    throw taskSchemaError('phase', 'research when a research participant is present');
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
  const hasPostApproveState = activeEpisode || revoked !== undefined
    || raw.pendingRedispatch !== undefined || raw.redispatchCount !== undefined;
  if (hasPostApproveState && raw.reviewMode !== 'git') {
    throw taskSchemaError('postApproveGeneration', 'post-approve state only for git review tasks');
  }
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
    const effectiveRound = Math.max(1, Number(raw.reviewRound) + (raw.reviewRoundPending === true ? 1 : 0));
    if (raw.reviewMode !== 'git' || raw.status !== 'review'
      || raw.signalToken !== lease.signalToken
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
  if (raw.afterDone === 'pr' && raw.platformBinding === undefined) {
    throw taskSchemaError('platformBinding', "present when afterDone is 'pr'");
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
    const validEntry = (entry: unknown): boolean =>
      isRecord(entry)
      && typeof entry.key === 'string' && entry.key.trim() !== ''
      && entry.type === 'human.intervention'
      && isRecord(entry.data);
    if (!Array.isArray(outbox) || !outbox.every(validEntry)) {
      throw taskSchemaError('outbox', 'an array of pending notification entries when present');
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
    // the filename is the store key; it overrides whatever id the file body carries
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

  // ids come from filenames, so the max scan never needs to read file contents
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
