import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BODY_DIGEST_SOURCE, sha256Hex } from './body-digest.js';
import { rowBodyDigest } from './markers.js';
import { versionTimeOf, type NormalizedRow } from './row-schema.js';
import { isRecord } from '../shared/index.js';
import { repoIdentityKey } from '../shared/git-url.js';

export interface SourceCursorView {
  watermarkTime: number | null;
  bucket: Record<string, string>;
  ledger: Record<string, string>;
}

interface CursorFile {
  version: 1;
  repoUrl: string;
  listPrs: { watermarkTime: number | null };
  generations: Record<string, Record<string, Record<string, SourceCursorView>>>;
}

export interface ClassifiedRows {
  fresh: NormalizedRow[];
  undated: number;
}

// 定长 digest 文件名：深层 namespace 不撞 ENAMETOOLONG；键出自 repoIdentityKey 单一归一化函数（spec §4）。
export function platformPollerStatePath(stateDir: string, repoUrl: string): string {
  return join(stateDir, 'state', `poller-git-${sha256Hex(repoIdentityKey(repoUrl))}.json`);
}

// 协议键（source key/comment id）的合法形态包含 'constructor'/'__proto__' 等原型特殊名：
// 普通对象上 `??=` 会读到继承的 Object 构造器、'__proto__' 赋值被 setter 吞掉——
// 所有 cursor 容器一律 null-prototype，磁盘加载后同样重建（JSON.parse 产出的是普通对象）。
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

const emptySource = (): SourceCursorView => ({ watermarkTime: null, bucket: dict(), ledger: dict() });

// 提交值均出自 Date.parse（整数毫秒）：1e300 这类「有限但超 Date 量程」的损坏值会把全部
// 真实行判旧、健康停页——按 ECMAScript Date 有效范围收紧。
const MAX_DATE_MS = 8_640_000_000_000_000;
const isWatermark = (v: unknown) =>
  v === null || (typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= MAX_DATE_MS);
const DIGEST_RE = new RegExp(`^${BODY_DIGEST_SOURCE}$`);
const isDigestMap = (v: unknown) => isRecord(v) && Object.values(v).every(x => typeof x === 'string' && DIGEST_RE.test(x));

// 类型断言不校验磁盘内容：watermarkTime 落成字符串会参与数值强转、把历史行静默判旧——
// 语法合法但结构损坏的文件与坏 JSON 同级：抛出而非带病运行。
function validateCursorFile(parsed: CursorFile): void {
  if (parsed.version !== 1) throw new Error(`cursor file version unsupported (got ${JSON.stringify(parsed.version)})`);
  const bad = (what: string): never => {
    throw new Error(`cursor file structure invalid: ${what}`);
  };
  if (!isRecord(parsed.listPrs) || !isWatermark(parsed.listPrs.watermarkTime)) bad('listPrs');
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
  return { version: 1, repoUrl: parsed.repoUrl, listPrs: { watermarkTime: parsed.listPrs.watermarkTime }, generations };
}

let tmpSeq = 0;

export class CommentCursorStore {
  private state: CursorFile;
  private readonly repoKey: string;
  private dirty = false;

  constructor(private readonly filePath: string, private readonly repoUrl: string) {
    this.repoKey = repoIdentityKey(repoUrl);
    this.state = { version: 1, repoUrl, listPrs: { watermarkTime: null }, generations: dict() };
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    // 损坏/失配一律抛出（周期跳过），空状态覆盖会把全部水位清零、整段历史重放。
    const parsed = JSON.parse(raw) as CursorFile;
    // 文件名已按 repoIdentityKey 归一：同一仓库的 https/ssh/.git 拼写变体命中同一文件，
    // 按原始配置串比较会在合法改写后永久拒载——一致性按归一化身份判。
    if (typeof parsed.repoUrl !== 'string' || repoIdentityKey(parsed.repoUrl) !== this.repoKey) {
      throw new Error(`cursor file repo mismatch: file has ${JSON.stringify(parsed.repoUrl)}, entry is ${this.repoUrl}`);
    }
    validateCursorFile(parsed);
    this.state = rebuildNullProto(parsed);
  }

  // persist 失败后内存已前移而磁盘落后：唯一会跳过重写的路径（水位未变早退/代际已删）需要
  // 这个补写钩子，调用方在每周期开头 flush 一次，磁盘在文件系统恢复后无需重启即收敛。
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

  // 提交条件由调用方保证：该源全部新 revision 的下游投递成功后才调用。可见性截断在此
  // 统一应用（与 classify 同源的稳定 cutoff）——靠调用方预过滤会让新调用方漏做时水位越过
  // held-back 行、评论永久跳过。桶在水位未前移时也重建——同秒编辑（d1→d2）消费后若桶残留
  // d1，同一 revision 每轮重判新；水位/桶/账本全部无变化的稳态周期跳过落盘。
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

  // 同款 cutoff 内化：水位 = 截断内最大 versionTime，未前移即免落盘。
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
    return Object.keys(this.state.generations);
  }

  async dropGeneration(taskId: string): Promise<void> {
    if (!(taskId in this.state.generations)) return;
    delete this.state.generations[taskId];
    await this.persist();
  }

  // 删除 key 即丢弃其 cursor（spec §5.3 增量①）：残留水位会让「删除后重加」的源
  // 把缺席期间的评论按旧水位永久跳过。
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
      // 计数器保证并发/同毫秒调用各持唯一 tmp 路径（防重入之外的纵深）。
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
