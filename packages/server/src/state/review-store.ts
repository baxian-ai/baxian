import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RESEARCH_DOCS_DIR,
  SPEC_DOC_RELPATH,
  isRecord,
  renderSpecDocuments,
  type ReviewPhase,
  type ReviewFindings,
  type ReviewRound,
  type ServerResponseFailure,
  type ServerSignalRecoveryReason,
  type SpecDocument,
} from '../shared/index.js';

const ROUND_FILE_RE = /^round-(\d+)\.json$/;
const PHASES: readonly ReviewPhase[] = ['spec', 'code'];
const SHA256_RE = /^[0-9a-f]{64}$/;
const FAILURE_DISPOSITIONS = new Set([
  'auto-correct', 'hold-repeated-signature', 'hold-correction-limit',
]);
const FAILURE_REASONS = new Set<ServerResponseFailureReason>([
  'response-missing', 'response-invalid', 'round-mismatch', 'token-mismatch',
  'findings-digest-mismatch', 'coverage-gap',
]);

export const SERVER_FEEDBACK_AUTO_CORRECTION_LIMIT = 3;

type ServerResponseFailureReason = Extract<ServerSignalRecoveryReason,
  | 'response-missing'
  | 'response-invalid'
  | 'round-mismatch'
  | 'token-mismatch'
  | 'findings-digest-mismatch'
  | 'coverage-gap'>;

export interface ServerResponseFailureSignatureInput {
  phase: ReviewPhase;
  round: number;
  findingsDigest: string;
  reason: ServerResponseFailureReason;
  missingFindingIds?: readonly string[];
  unknownFindingIds?: readonly string[];
  schemaViolationCodes?: readonly string[];
}

export type RecordServerResponseFailureInput = Omit<ServerResponseFailure, 'disposition'>;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function reviewFindingsDigest(findings: ReviewFindings): string {
  return sha256Hex(JSON.stringify(findings));
}

export function serverResponseFailureSignature(input: ServerResponseFailureSignatureInput): string {
  return sha256Hex(JSON.stringify({
    version: 1,
    phase: input.phase,
    round: input.round,
    findingsDigest: input.findingsDigest,
    reason: input.reason,
    missingFindingIds: [...(input.missingFindingIds ?? [])].sort(),
    unknownFindingIds: [...(input.unknownFindingIds ?? [])].sort(),
    schemaViolationCodes: [...(input.schemaViolationCodes ?? [])].sort(),
  }));
}

function validateSortedStrings(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  const sorted = [...value].sort();
  if (new Set(value).size !== value.length || value.some((item, index) => item !== sorted[index])) {
    throw new Error(`${field} must be sorted and unique`);
  }
}

function validateServerResponseFailures(value: unknown, phase: ReviewPhase): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error('serverResponseFailures must be an array');
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) throw new Error(`serverResponseFailures[${index}] must be an object`);
    for (const field of ['signalKind', 'sourceToken', 'successorToken', 'failureSignature', 'reason', 'createdAt']) {
      if (typeof entry[field] !== 'string' || (entry[field] as string).trim() === '') {
        throw new Error(`serverResponseFailures[${index}].${field} must be a non-empty string`);
      }
    }
    if (entry.signalKind !== 'code-fixed' && entry.signalKind !== 'spec-fixed') {
      throw new Error(`serverResponseFailures[${index}].signalKind is invalid`);
    }
    if ((entry.signalKind === 'code-fixed' ? 'code' : 'spec') !== phase) {
      throw new Error(`serverResponseFailures[${index}].signalKind does not match round phase`);
    }
    if (entry.sourceToken === entry.successorToken) {
      throw new Error(`serverResponseFailures[${index}] tokens must identify different generations`);
    }
    if (!SHA256_RE.test(entry.failureSignature as string)) {
      throw new Error(`serverResponseFailures[${index}].failureSignature is invalid`);
    }
    if (!FAILURE_REASONS.has(entry.reason as ServerResponseFailureReason)) {
      throw new Error(`serverResponseFailures[${index}].reason is invalid`);
    }
    if (entry.responseDigest !== undefined
      && (typeof entry.responseDigest !== 'string' || !SHA256_RE.test(entry.responseDigest))) {
      throw new Error(`serverResponseFailures[${index}].responseDigest is invalid`);
    }
    if (entry.rawResponse !== undefined && typeof entry.rawResponse !== 'string') {
      throw new Error(`serverResponseFailures[${index}].rawResponse must be a string`);
    }
    if (typeof entry.disposition !== 'string' || !FAILURE_DISPOSITIONS.has(entry.disposition)) {
      throw new Error(`serverResponseFailures[${index}].disposition is invalid`);
    }
    validateSortedStrings(entry.missingFindingIds, `serverResponseFailures[${index}].missingFindingIds`);
    validateSortedStrings(entry.unknownFindingIds, `serverResponseFailures[${index}].unknownFindingIds`);
    validateSortedStrings(entry.schemaViolationCodes, `serverResponseFailures[${index}].schemaViolationCodes`);
  }
}

function parseDocuments(value: unknown): SpecDocument[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('spec review round documents must be a non-empty array');
  }
  const documents = value.map((item, index) => {
    if (!isRecord(item) || typeof item.relPath !== 'string' || typeof item.content !== 'string') {
      throw new Error(`spec review round documents[${index}] is invalid`);
    }
    return { relPath: item.relPath, content: item.content };
  });
  if (documents[0]!.relPath !== SPEC_DOC_RELPATH) {
    throw new Error(`spec review round must start with ${SPEC_DOC_RELPATH}`);
  }
  const paths = documents.map(document => document.relPath);
  if (new Set(paths).size !== paths.length) throw new Error('spec review round document paths must be unique');
  const researchPrefix = `${RESEARCH_DOCS_DIR}/`;
  for (const path of paths.slice(1)) {
    const name = path.slice(researchPrefix.length);
    if (!path.startsWith(researchPrefix) || name === '' || name.includes('/') || !name.endsWith('.md')) {
      throw new Error(`invalid research document path: ${path}`);
    }
  }
  const sorted = [...paths.slice(1)].sort();
  if (paths.slice(1).some((path, index) => path !== sorted[index])) {
    throw new Error('research document paths must be sorted');
  }
  return documents;
}

function parseRound(value: unknown, phase: ReviewPhase, round: number): ReviewRound {
  if (!isRecord(value) || value.phase !== phase || value.round !== round) {
    throw new Error(`review round identity mismatch: expected ${phase}/${round}`);
  }
  if (typeof value.content !== 'string' || typeof value.startedAt !== 'string') {
    throw new Error(`review round ${phase}/${round} is missing required content or startedAt`);
  }
  validateServerResponseFailures(value.serverResponseFailures, phase);
  if (phase === 'spec') {
    const documents = parseDocuments(value.documents);
    if (value.content !== renderSpecDocuments(documents)) {
      throw new Error(`spec review round ${round} content does not match documents`);
    }
    return { ...value, phase, round, documents } as unknown as ReviewRound;
  }
  if (value.documents !== undefined) throw new Error(`code review round ${round} must not contain documents`);
  return { ...value, phase, round } as unknown as ReviewRound;
}

export class ReviewStore {
  private readonly memory = new Map<string, ReviewRound>();
  private readonly roundLocks = new Map<string, Promise<void>>();

  constructor(private readonly dir?: string) {}

  async getRound(taskId: string, phase: ReviewPhase, round: number): Promise<ReviewRound | null> {
    if (!this.dir) {
      const value = this.memory.get(this.key(taskId, phase, round));
      return value ? parseRound(value, phase, round) : null;
    }
    let content: string;
    try {
      content = await readFile(this.path(taskId, phase, round), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
      throw err;
    }
    return parseRound(JSON.parse(content), phase, round);
  }

  async putRound(taskId: string, phase: ReviewPhase, data: ReviewRound): Promise<void> {
    await this.withRoundLock(taskId, phase, data.round, async () => {
      await this.writeRound(taskId, phase, data);
    });
  }

  async recordServerResponseFailure(
    taskId: string,
    phase: ReviewPhase,
    round: number,
    input: RecordServerResponseFailureInput,
  ): Promise<ServerResponseFailure> {
    return this.withRoundLock(taskId, phase, round, async () => {
      const stored = await this.getRound(taskId, phase, round);
      if (!stored) throw new Error(`review round ${taskId}/${phase}/${round} not found`);
      const existing = stored.serverResponseFailures?.find(entry =>
        entry.signalKind === input.signalKind && entry.sourceToken === input.sourceToken,
      );
      if (existing) return existing;
      const failures = stored.serverResponseFailures ?? [];
      const disposition = failures.some(entry => entry.failureSignature === input.failureSignature)
        ? 'hold-repeated-signature'
        : failures.filter(entry => entry.disposition === 'auto-correct').length >= SERVER_FEEDBACK_AUTO_CORRECTION_LIMIT
          ? 'hold-correction-limit'
          : 'auto-correct';
      const entry: ServerResponseFailure = {
        ...input,
        missingFindingIds: [...input.missingFindingIds].sort(),
        unknownFindingIds: [...input.unknownFindingIds].sort(),
        schemaViolationCodes: [...input.schemaViolationCodes].sort(),
        disposition,
      };
      await this.writeRound(taskId, phase, {
        ...stored,
        serverResponseFailures: [...failures, entry],
      });
      return entry;
    });
  }

  private async writeRound(taskId: string, phase: ReviewPhase, data: ReviewRound): Promise<void> {
    const parsed = parseRound(data, phase, data.round);
    if (!this.dir) {
      this.memory.set(this.key(taskId, phase, parsed.round), parsed);
      return;
    }
    const phaseDir = join(this.dir, encodeURIComponent(taskId), phase);
    await mkdir(phaseDir, { recursive: true });
    const final = join(phaseDir, `round-${parsed.round}.json`);
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(parsed, null, 2) + '\n');
    await rename(tmp, final);
  }

  private async withRoundLock<T>(
    taskId: string,
    phase: ReviewPhase,
    round: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = this.key(taskId, phase, round);
    const previous = this.roundLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    this.roundLocks.set(key, queued);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.roundLocks.get(key) === queued) this.roundLocks.delete(key);
    }
  }

  async listRounds(taskId: string, phase?: ReviewPhase): Promise<ReviewRound[]> {
    const phases = phase ? [phase] : PHASES;
    const out: ReviewRound[] = [];
    for (const p of phases) {
      if (!this.dir) {
        const prefix = `${taskId}::${p}::`;
        const rounds = [...this.memory.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([, v]) => v)
          .sort((a, b) => a.round - b.round);
        out.push(...rounds);
        continue;
      }
      let files: string[];
      try {
        files = await readdir(join(this.dir, encodeURIComponent(taskId), p));
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue;
        throw err;
      }
      const rounds = files
        .map(f => ROUND_FILE_RE.exec(f)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(n => Number.parseInt(n, 10))
        .sort((a, b) => a - b);
      for (const r of rounds) {
        const data = await this.getRound(taskId, p, r);
        if (data) out.push(data);
      }
    }
    return out;
  }

  async clear(taskId: string): Promise<void> {
    if (!this.dir) {
      for (const k of [...this.memory.keys()]) {
        if (k.startsWith(`${taskId}::`)) this.memory.delete(k);
      }
      return;
    }
    await rm(join(this.dir, encodeURIComponent(taskId)), { recursive: true, force: true });
  }

  private key(taskId: string, phase: ReviewPhase, round: number): string {
    return `${taskId}::${phase}::${round}`;
  }

  private path(taskId: string, phase: ReviewPhase, round: number): string {
    return join(this.dir!, encodeURIComponent(taskId), phase, `round-${round}.json`);
  }
}
