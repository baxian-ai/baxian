import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BODY_DIGEST_SOURCE, sha256Hex } from './body-digest.js';
import { rowBodyDigest } from './markers.js';
import { versionTimeOf, type NormalizedRow } from './row-schema.js';
import { isRecord } from '../shared/index.js';
import { repoIdentityKey } from './driver-host.js';

export interface SourceCursorView {
  watermarkTime: number | null;
  bucket: Record<string, string>;
  ledger: Record<string, string>;
}

interface CursorFile {
  version: 3;
  repoUrl: string;
  listPrs: { watermarkTime: number | null };
  adoptions: Record<string, number>;
  pendingAdoptions: Record<string, number>;
  generations: Record<string, Record<string, Record<string, SourceCursorView>>>;
}

export interface ClassifiedRows {
  fresh: NormalizedRow[];
  undated: number;
}

export function platformPollerStatePath(stateDir: string, repoUrl: string): string {
  return join(stateDir, 'state', `poller-git-${sha256Hex(repoIdentityKey(repoUrl))}.json`);
}

const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

const emptySource = (): SourceCursorView => ({ watermarkTime: null, bucket: dict(), ledger: dict() });

const MAX_DATE_MS = 8_640_000_000_000_000;
const isWatermark = (v: unknown) =>
  v === null || (typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= MAX_DATE_MS);
const DIGEST_RE = new RegExp(`^${BODY_DIGEST_SOURCE}$`);
const isDigestMap = (v: unknown) => isRecord(v) && Object.values(v).every(x => typeof x === 'string' && DIGEST_RE.test(x));

function validateCursorFile(parsed: CursorFile): void {
  if (parsed.version !== 3) throw new Error(`cursor file version unsupported (got ${JSON.stringify(parsed.version)})`);
  const bad = (what: string): never => {
    throw new Error(`cursor file structure invalid: ${what}`);
  };
  if (!isRecord(parsed.listPrs) || !isWatermark(parsed.listPrs.watermarkTime)) bad('listPrs');
  if (!isRecord(parsed.adoptions)
    || Object.values(parsed.adoptions).some(value => !Number.isInteger(value) || (value as number) < 1)) {
    bad('adoptions');
  }
  if (!isRecord(parsed.pendingAdoptions)
    || Object.values(parsed.pendingAdoptions).some(value => !Number.isInteger(value) || (value as number) < 1)) {
    bad('pendingAdoptions');
  }
  if (!isRecord(parsed.generations)) bad('generations');
  for (const [taskId, prs] of Object.entries(parsed.generations)) {
    if (!isRecord(prs)) bad(`generations.${taskId}`);
    for (const [pr, sources] of Object.entries(prs)) {
      if (!isRecord(sources)) bad(`generations.${taskId}.${pr}`);
      for (const [key, view] of Object.entries(sources as Record<string, unknown>)) {
        if (!isRecord(view) || !isWatermark(view.watermarkTime)
          || !isDigestMap(view.bucket) || !isDigestMap(view.ledger)) {
          bad(`generations.${taskId}.${pr}.${key}`);
        }
      }
    }
  }
}

function rebuildNullProto(parsed: CursorFile): CursorFile {
  const generations = dict<Record<string, Record<string, SourceCursorView>>>();
  for (const [taskId, prs] of Object.entries(parsed.generations)) {
    const prDict = dict<Record<string, SourceCursorView>>();
    for (const [pr, sources] of Object.entries(prs)) {
      const srcDict = dict<SourceCursorView>();
      for (const [key, view] of Object.entries(sources)) {
        srcDict[key] = {
          watermarkTime: view.watermarkTime,
          bucket: Object.assign(dict<string>(), view.bucket),
          ledger: Object.assign(dict<string>(), view.ledger),
        };
      }
      prDict[pr] = srcDict;
    }
    generations[taskId] = prDict;
  }
  return {
    version: 3,
    repoUrl: parsed.repoUrl,
    listPrs: { watermarkTime: parsed.listPrs.watermarkTime },
    adoptions: Object.assign(dict<number>(), parsed.adoptions),
    pendingAdoptions: Object.assign(dict<number>(), parsed.pendingAdoptions),
    generations,
  };
}

let tmpSeq = 0;

export class CommentCursorStore {
  private state: CursorFile;
  private readonly repoKey: string;
  private dirty = false;

  constructor(private readonly filePath: string, private readonly repoUrl: string) {
    this.repoKey = repoIdentityKey(repoUrl);
    this.state = {
      version: 3,
      repoUrl,
      listPrs: { watermarkTime: null },
      adoptions: dict(),
      pendingAdoptions: dict(),
      generations: dict(),
    };
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    const parsed = JSON.parse(raw) as CursorFile;
    if (typeof parsed.repoUrl !== 'string' || repoIdentityKey(parsed.repoUrl) !== this.repoKey) {
      throw new Error(`cursor file repo mismatch: file has ${JSON.stringify(parsed.repoUrl)}, entry is ${this.repoUrl}`);
    }
    validateCursorFile(parsed);
    this.state = rebuildNullProto(parsed);
  }

  async flushIfDirty(): Promise<void> {
    if (this.dirty) await this.persist();
  }

  source(taskId: string, prNumber: number, sourceKey: string): SourceCursorView {
    return this.state.generations[taskId]?.[String(prNumber)]?.[sourceKey] ?? emptySource();
  }

  classify(view: SourceCursorView, rows: NormalizedRow[], cutoffMs: number): ClassifiedRows {
    const fresh: NormalizedRow[] = [];
    let undated = 0;
    for (const row of rows) {
      const vt = versionTimeOf(row);
      if (vt === undefined) {
        undated++;
        continue;
      }
      if (vt > cutoffMs) continue;
      if (view.watermarkTime === null || vt > view.watermarkTime) {
        fresh.push(row);
        continue;
      }
      if (vt === view.watermarkTime) {
        if (view.bucket[String(row.id)] !== rowBodyDigest(row)) fresh.push(row);
      }
    }
    return { fresh, undated };
  }

  isDelivered(view: SourceCursorView, id: string, digest: string): boolean {
    return view.ledger[id] === digest;
  }

  async markDelivered(taskId: string, prNumber: number, sourceKey: string, id: string, digest: string): Promise<void> {
    this.mutableSource(taskId, prNumber, sourceKey).ledger[id] = digest;
    await this.persist();
  }

  async commitSource(
    taskId: string, prNumber: number, sourceKey: string, rows: NormalizedRow[], cutoffMs: number,
  ): Promise<void> {
    const settled = rows.filter(row => {
      const vt = versionTimeOf(row);
      return vt !== undefined && vt <= cutoffMs;
    });
    const cursor = this.mutableSource(taskId, prNumber, sourceKey);
    let max = cursor.watermarkTime;
    for (const row of settled) {
      const vt = versionTimeOf(row);
      if (vt !== undefined && (max === null || vt > max)) max = vt;
    }
    const bucket = dict<string>();
    for (const row of settled) {
      if (versionTimeOf(row) !== max || max === null) continue;
      bucket[String(row.id)] = rowBodyDigest(row);
    }
    const unchanged = max === cursor.watermarkTime
      && Object.keys(cursor.ledger).length === 0
      && Object.keys(bucket).length === Object.keys(cursor.bucket).length
      && Object.entries(bucket).every(([id, digest]) => cursor.bucket[id] === digest);
    if (unchanged) return;
    cursor.watermarkTime = max;
    cursor.bucket = bucket;
    cursor.ledger = dict();
    await this.persist();
  }

  listPrsCursor(): { watermarkTime: number | null } {
    return this.state.listPrs;
  }

  async commitListPrs(rows: NormalizedRow[], cutoffMs: number): Promise<void> {
    let max = this.state.listPrs.watermarkTime;
    for (const row of rows) {
      const vt = versionTimeOf(row);
      if (vt !== undefined && vt <= cutoffMs && (max === null || vt > max)) max = vt;
    }
    if (max === null || max === this.state.listPrs.watermarkTime) return;
    this.state.listPrs = { watermarkTime: max };
    await this.persist();
  }

  generations(): string[] {
    return [...new Set([
      ...Object.keys(this.state.generations),
      ...Object.keys(this.state.adoptions),
      ...Object.keys(this.state.pendingAdoptions),
    ])];
  }

  async dropGeneration(taskId: string): Promise<void> {
    if (!(taskId in this.state.generations)
      && !(taskId in this.state.adoptions)
      && !(taskId in this.state.pendingAdoptions)) return;
    delete this.state.generations[taskId];
    delete this.state.adoptions[taskId];
    delete this.state.pendingAdoptions[taskId];
    await this.persist();
  }

  isAdoptionDelivered(taskId: string, prNumber: number): boolean {
    return this.state.adoptions[taskId] === prNumber;
  }

  async markAdoptionDelivered(taskId: string, prNumber: number): Promise<void> {
    if (this.isAdoptionDelivered(taskId, prNumber) && !(taskId in this.state.pendingAdoptions)) return;
    this.state.adoptions[taskId] = prNumber;
    delete this.state.pendingAdoptions[taskId];
    await this.persist();
  }

  pendingAdoptions(): Array<{ taskId: string; prNumber: number }> {
    return Object.entries(this.state.pendingAdoptions).map(([taskId, prNumber]) => ({ taskId, prNumber }));
  }

  isAdoptionPending(taskId: string, prNumber: number): boolean {
    return this.state.pendingAdoptions[taskId] === prNumber;
  }

  async markAdoptionPending(taskId: string, prNumber: number): Promise<void> {
    if (this.isAdoptionDelivered(taskId, prNumber) || this.isAdoptionPending(taskId, prNumber)) return;
    this.state.pendingAdoptions[taskId] = prNumber;
    await this.persist();
  }

  async clearAdoptionPending(taskId: string, prNumber: number): Promise<void> {
    if (!this.isAdoptionPending(taskId, prNumber)) return;
    delete this.state.pendingAdoptions[taskId];
    await this.persist();
  }

  async pruneSources(activeKeys: ReadonlySet<string>): Promise<void> {
    let changed = false;
    for (const prs of Object.values(this.state.generations)) {
      for (const sources of Object.values(prs)) {
        for (const key of Object.keys(sources)) {
          if (!activeKeys.has(key)) {
            delete sources[key];
            changed = true;
          }
        }
      }
    }
    if (changed) await this.persist();
  }

  private mutableSource(taskId: string, prNumber: number, sourceKey: string): SourceCursorView {
    const gen = (this.state.generations[taskId] ??= dict());
    const pr = (gen[String(prNumber)] ??= dict());
    return (pr[sourceKey] ??= emptySource());
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${Date.now()}.${tmpSeq++}.tmp`;
      await writeFile(tmp, JSON.stringify(this.state));
      await rename(tmp, this.filePath);
      this.dirty = false;
    } catch (e) {
      this.dirty = true;
      throw e;
    }
  }
}
