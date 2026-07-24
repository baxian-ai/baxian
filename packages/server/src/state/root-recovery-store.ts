import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isRecord,
  TASK_PHASE_SET,
  TASK_STATUS_SET,
  type TaskGenerationGuard,
  type TaskPhase,
  type TaskStatus,
} from '../shared/index.js';

export const ROOT_RECOVERY_ACTIONS = ['redispatch-current-phase', 'escalate', 'no-op'] as const;
export type RootRecoveryAction = (typeof ROOT_RECOVERY_ACTIONS)[number];
export const ROOT_RECOVERY_OUTCOMES = [
  'executed', 'stale', 'escalated', 'ignored', 'failed', 'unknown', 'timeout',
] as const;
export type RootRecoveryOutcomeKind = (typeof ROOT_RECOVERY_OUTCOMES)[number];
export const ROOT_RECOVERY_MAX_REASON_BYTES = 2_000;

export interface RootRecoveryDecision {
  action: RootRecoveryAction;
  reason: string;
}

export type RootRecoveryGuard = TaskGenerationGuard;

export interface RootRecoveryTrigger {
  kind: 'intervention' | 'runtime-stall';
  observedAt: string;
  agentId?: string;
  eventId?: string;
  phase?: string;
  reason?: string;
  message?: string;
  holdPhase?: string;
  holdSince?: string;
  holdNonce?: string;
}

export interface RootRecoveryOutcome {
  kind: RootRecoveryOutcomeKind;
  detail: string;
  at: string;
}

export interface RootRecoveryRecord {
  version: 1;
  id: string;
  taskId: string;
  projectId: string;
  status: 'pending' | 'inflight' | 'done';
  attemptToken: string;
  trigger: RootRecoveryTrigger;
  guard: RootRecoveryGuard;
  createdAt: string;
  updatedAt: string;
  dispatchedAt?: string;
  deliveredAt?: string;
  decision?: RootRecoveryDecision;
  executionStartedAt?: string;
  outcome?: RootRecoveryOutcome;
}

interface RootRecoveryStoreDeps {
  now?: () => Date;
  idFactory?: () => string;
  tokenFactory?: () => string;
  readDirectory?: (dir: string) => Promise<string[]>;
  readTextFile?: (path: string) => Promise<string>;
  renameFile?: typeof rename;
  unlinkFile?: typeof unlink;
}

const SAFE_ID = /^root-recovery-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const ACTIVE_STATUSES = new Set<RootRecoveryRecord['status']>(['pending', 'inflight']);
export const ROOT_RECOVERY_ACTION_SET: ReadonlySet<string> = new Set(ROOT_RECOVERY_ACTIONS);
const ROOT_RECOVERY_OUTCOME_SET: ReadonlySet<string> = new Set(ROOT_RECOVERY_OUTCOMES);

export class RootRecoveryStore {
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private records?: Map<string, RootRecoveryRecord>;
  private loadPromise?: Promise<void>;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly tokenFactory: () => string;
  private readonly readDirectory: (dir: string) => Promise<string[]>;
  private readonly readTextFile: (path: string) => Promise<string>;
  private readonly renameFile: typeof rename;
  private readonly unlinkFile: typeof unlink;

  constructor(
    private readonly dir: string,
    deps: RootRecoveryStoreDeps = {},
  ) {
    this.now = deps.now ?? (() => new Date());
    this.idFactory = deps.idFactory ?? (() => `root-recovery-${randomUUID()}`);
    this.tokenFactory = deps.tokenFactory ?? (() => randomBytes(16).toString('hex'));
    this.readDirectory = deps.readDirectory ?? (path => readdir(path));
    this.readTextFile = deps.readTextFile ?? (path => readFile(path, 'utf8'));
    this.renameFile = deps.renameFile ?? rename;
    this.unlinkFile = deps.unlinkFile ?? unlink;
  }

  async createIfIdle(input: {
    taskId: string;
    projectId: string;
    trigger: RootRecoveryTrigger;
    guard: RootRecoveryGuard;
  }): Promise<{ created: boolean; record: RootRecoveryRecord }> {
    return this.mutate(async () => {
      const records = await this.listUnlocked();
      const duplicate = input.trigger.eventId
        ? records.find(record => record.trigger.eventId === input.trigger.eventId)
        : undefined;
      if (duplicate) return { created: false, record: duplicate };
      const active = records.find(record =>
        record.taskId === input.taskId && ACTIVE_STATUSES.has(record.status),
      );
      if (active) return { created: false, record: active };
      const at = this.now().toISOString();
      const record: RootRecoveryRecord = {
        version: 1,
        id: this.idFactory(),
        taskId: input.taskId,
        projectId: input.projectId,
        status: 'pending',
        attemptToken: this.tokenFactory(),
        trigger: input.trigger,
        guard: input.guard,
        createdAt: at,
        updatedAt: at,
      };
      validateRecord(record);
      await this.writeUnlocked(record);
      return { created: true, record };
    });
  }

  async markDispatchStarted(id: string): Promise<RootRecoveryRecord | null> {
    return this.mutate(async () => {
      const record = await this.getUnlocked(id);
      if (!record || record.status !== 'pending' || record.dispatchedAt !== undefined) return record;
      const at = this.now().toISOString();
      const next: RootRecoveryRecord = {
        ...record,
        dispatchedAt: at,
        updatedAt: at,
      };
      await this.writeUnlocked(next);
      return next;
    });
  }

  async markDispatched(id: string): Promise<RootRecoveryRecord | null> {
    return this.mutate(async () => {
      const record = await this.getUnlocked(id);
      if (!record || record.status !== 'pending') return record;
      const at = this.now().toISOString();
      const next: RootRecoveryRecord = {
        ...record,
        status: 'inflight',
        dispatchedAt: record.dispatchedAt ?? at,
        updatedAt: at,
      };
      await this.writeUnlocked(next);
      return next;
    });
  }

  async markDelivered(id: string, attemptToken: string): Promise<RootRecoveryRecord | null> {
    return this.mutate(async () => {
      const record = await this.getUnlocked(id);
      if (
        !record
        || record.status !== 'inflight'
        || record.attemptToken !== attemptToken
        || record.decision
      ) return record;
      const at = this.now().toISOString();
      const next: RootRecoveryRecord = {
        ...record,
        deliveredAt: at,
        updatedAt: at,
      };
      await this.writeUnlocked(next);
      return next;
    });
  }

  async requeueUndelivered(
    id: string,
    attemptToken: string,
  ): Promise<{ requeued: boolean; record: RootRecoveryRecord | null }> {
    return this.mutate(async () => {
      const record = await this.getUnlocked(id);
      if (
        !record
        || record.status !== 'inflight'
        || record.attemptToken !== attemptToken
        || record.deliveredAt !== undefined
        || record.decision !== undefined
      ) return { requeued: false, record };
      const next: RootRecoveryRecord = {
        ...record,
        status: 'pending',
        updatedAt: this.now().toISOString(),
      };
      await this.writeUnlocked(next);
      return { requeued: true, record: next };
    });
  }

  async claimDecision(
    id: string,
    attemptToken: string,
    decision: RootRecoveryDecision,
  ): Promise<{ claimed: boolean; record: RootRecoveryRecord | null }> {
    return this.mutate(async () => {
      const record = await this.getUnlocked(id);
      if (!record || record.status !== 'inflight' || record.attemptToken !== attemptToken) {
        return { claimed: false, record };
      }
      if (record.decision) return { claimed: false, record };
      const at = this.now().toISOString();
      const next: RootRecoveryRecord = {
        ...record,
        decision,
        executionStartedAt: at,
        updatedAt: at,
      };
      await this.writeUnlocked(next);
      return { claimed: true, record: next };
    });
  }

  async complete(
    id: string,
    outcome: RootRecoveryOutcome,
    expected: RootRecoveryRecord,
  ): Promise<{ completed: boolean; record: RootRecoveryRecord | null }> {
    return this.mutate(async () => {
      const record = await this.getUnlocked(id);
      if (!record || record.status === 'done' || !sameMutableState(record, expected)) {
        return { completed: false, record };
      }
      const next: RootRecoveryRecord = {
        ...record,
        status: 'done',
        outcome,
        updatedAt: outcome.at,
      };
      await this.writeUnlocked(next);
      return { completed: true, record: next };
    });
  }

  async listDoneBefore(cutoff: string): Promise<RootRecoveryRecord[]> {
    return (await this.list()).filter(record =>
      record.status === 'done' && record.updatedAt < cutoff,
    );
  }

  async removeDone(id: string, expectedUpdatedAt: string): Promise<boolean> {
    return this.mutate(async () => {
      const record = await this.getUnlocked(id);
      if (!record || record.status !== 'done' || record.updatedAt !== expectedUpdatedAt) return false;
      const target = join(this.dir, `${id}.json`);
      try {
        await this.unlinkFile(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
          console.warn(`[root-recovery-store] failed to remove retained record ${target}:`, err);
          throw err;
        }
      }
      this.records?.delete(id);
      return true;
    });
  }

  async get(id: string): Promise<RootRecoveryRecord | null> {
    await this.mutationQueue;
    return this.getUnlocked(id);
  }

  async list(): Promise<RootRecoveryRecord[]> {
    await this.mutationQueue;
    return this.listUnlocked();
  }

  async listActive(): Promise<RootRecoveryRecord[]> {
    return (await this.list()).filter(record => ACTIVE_STATUSES.has(record.status));
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn);
    this.mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async getUnlocked(id: string): Promise<RootRecoveryRecord | null> {
    if (!SAFE_ID.test(id)) return null;
    await this.loadUnlocked();
    return this.records!.get(id) ?? null;
  }

  private async listUnlocked(): Promise<RootRecoveryRecord[]> {
    await this.loadUnlocked();
    return [...this.records!.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async loadUnlocked(): Promise<void> {
    if (this.records) return;
    const pending = this.loadPromise ?? this.loadFromDisk();
    this.loadPromise = pending;
    try {
      await pending;
    } catch (err) {
      if (this.loadPromise === pending) this.loadPromise = undefined;
      throw err;
    }
  }

  private async loadFromDisk(): Promise<void> {
    let files: string[];
    try {
      files = await this.readDirectory(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        this.records = new Map();
        return;
      }
      throw err;
    }
    const records = new Map<string, RootRecoveryRecord>();
    for (const file of files.filter(name => name.endsWith('.json')).sort()) {
      const id = file.slice(0, -'.json'.length);
      if (!SAFE_ID.test(id)) continue;
      const raw = await this.readTextFile(join(this.dir, file));
      records.set(id, validateRecord({ ...(JSON.parse(raw) as Record<string, unknown>), id }));
    }
    this.records = records;
  }

  private async writeUnlocked(record: RootRecoveryRecord): Promise<void> {
    validateRecord(record);
    await mkdir(this.dir, { recursive: true });
    const final = join(this.dir, `${record.id}.json`);
    try {
      if ((await lstat(final)).isDirectory()) {
        throw new Error(`root recovery target is a directory: ${final}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw err;
    }
    const tmp = `${final}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    let renamed = false;
    try {
      await writeFile(tmp, JSON.stringify(record, null, 2) + '\n');
      await this.renameFile(tmp, final);
      renamed = true;
      if (!(await lstat(final)).isFile()) {
        throw new Error(`root recovery target is not a regular file after rename: ${final}`);
      }
      this.records?.set(record.id, record);
    } catch (err) {
      console.warn(`[root-recovery-store] failed to persist ${final}:`, err);
      if (!renamed) await cleanupTemporaryFile(tmp, this.unlinkFile);
      throw err;
    }
  }
}

async function cleanupTemporaryFile(tmp: string, unlinkFile: typeof unlink): Promise<void> {
  try {
    await unlinkFile(tmp);
    console.warn(`[root-recovery-store] removed temporary file after persistence failure: ${tmp}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      console.warn(`[root-recovery-store] failed to remove temporary file ${tmp}:`, err);
    }
  }
}

function sameMutableState(current: RootRecoveryRecord, expected: RootRecoveryRecord): boolean {
  return current.status === expected.status
    && current.attemptToken === expected.attemptToken
    && current.updatedAt === expected.updatedAt
    && current.dispatchedAt === expected.dispatchedAt
    && current.deliveredAt === expected.deliveredAt
    && current.executionStartedAt === expected.executionStartedAt
    && JSON.stringify(current.decision) === JSON.stringify(expected.decision);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`invalid root recovery field ${field}`);
  }
  return value;
}

function validateRecord(value: unknown): RootRecoveryRecord {
  if (!isRecord(value) || value.version !== 1) throw new Error('invalid root recovery record');
  const id = requireString(value, 'id');
  if (!SAFE_ID.test(id)) throw new Error(`invalid root recovery id: ${id}`);
  requireString(value, 'taskId');
  requireString(value, 'projectId');
  requireString(value, 'createdAt');
  requireString(value, 'updatedAt');
  const token = requireString(value, 'attemptToken');
  if (!TOKEN_RE.test(token)) throw new Error('invalid root recovery attemptToken');
  if (value.status !== 'pending' && value.status !== 'inflight' && value.status !== 'done') {
    throw new Error('invalid root recovery status');
  }
  validateTrigger(value.trigger);
  validateGuard(value.guard);
  if (value.dispatchedAt !== undefined && typeof value.dispatchedAt !== 'string') {
    throw new Error('invalid root recovery dispatchedAt');
  }
  if (value.deliveredAt !== undefined && typeof value.deliveredAt !== 'string') {
    throw new Error('invalid root recovery deliveredAt');
  }
  if (value.decision !== undefined) validateDecision(value.decision);
  if (value.executionStartedAt !== undefined && typeof value.executionStartedAt !== 'string') {
    throw new Error('invalid root recovery executionStartedAt');
  }
  if (value.outcome !== undefined) validateOutcome(value.outcome);
  if (value.status === 'done' && value.outcome === undefined) {
    throw new Error('done root recovery record requires outcome');
  }
  return value as unknown as RootRecoveryRecord;
}

function validateTrigger(value: unknown): void {
  if (!isRecord(value) || (value.kind !== 'intervention' && value.kind !== 'runtime-stall')) {
    throw new Error('invalid root recovery trigger');
  }
  requireString(value, 'observedAt');
  for (const field of [
    'agentId', 'eventId', 'phase', 'reason', 'message', 'holdPhase', 'holdSince', 'holdNonce',
  ]) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw new Error(`invalid root recovery trigger ${field}`);
    }
  }
}

function validateGuard(value: unknown): void {
  if (!isRecord(value)) throw new Error('invalid root recovery guard');
  if (typeof value.status !== 'string' || !TASK_STATUS_SET.has(value.status as TaskStatus)) {
    throw new Error('invalid root recovery guard status');
  }
  if (typeof value.agentId !== 'string') throw new Error('invalid root recovery guard agentId');
  if (!Number.isInteger(value.reviewRound) || (value.reviewRound as number) < 0) {
    throw new Error('invalid root recovery guard reviewRound');
  }
  if (value.specReviewRound !== undefined
    && (!Number.isInteger(value.specReviewRound) || (value.specReviewRound as number) < 0)) {
    throw new Error('invalid root recovery guard specReviewRound');
  }
  if (value.phase !== undefined
    && (typeof value.phase !== 'string' || !TASK_PHASE_SET.has(value.phase as TaskPhase))) {
    throw new Error('invalid root recovery guard phase');
  }
  if (value.signalToken !== undefined && typeof value.signalToken !== 'string') {
    throw new Error('invalid root recovery guard signalToken');
  }
}

function validateDecision(value: unknown): asserts value is RootRecoveryDecision {
  if (!isRecord(value) || !ROOT_RECOVERY_ACTION_SET.has(value.action as string)) {
    throw new Error('invalid root recovery decision action');
  }
  const reason = requireString(value, 'reason');
  if (Buffer.byteLength(reason, 'utf8') > ROOT_RECOVERY_MAX_REASON_BYTES) {
    throw new Error(`root recovery decision reason exceeds ${ROOT_RECOVERY_MAX_REASON_BYTES} bytes`);
  }
}

function validateOutcome(value: unknown): void {
  if (!isRecord(value) || !ROOT_RECOVERY_OUTCOME_SET.has(value.kind as string)) {
    throw new Error('invalid root recovery outcome');
  }
  requireString(value, 'detail');
  requireString(value, 'at');
}
