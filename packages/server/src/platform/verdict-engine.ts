import { rowBodyDigest, rowTokens } from './markers.js';
import { versionTimeOf, versionTimestampOf, type NormalizedRow } from './row-schema.js';
import type { CommentSourceClass } from './markers.js';

export interface VerdictSourceScan {
  key: string;
  sourceClass: CommentSourceClass;
  ok: boolean;
  scanStartedAt: number;
  rows: NormalizedRow[];
}

export interface VerdictTokenPair {
  passToken: string;
  failToken: string;
}

export interface VerdictInput {
  taskId: string;
  prNumber: number;
  anchorSha: string;
  pair: VerdictTokenPair;
  sources: VerdictSourceScan[];
  visibilityLagMs: number;
}

export interface VerdictCarrier {
  sourceKey: string;
  id: string;
  bodyDigest: string;
}

export interface VerdictDecision {
  kind: 'pass' | 'fail';
  token: string;
  anchorSha: string;
  conflict: boolean;
  carrier: VerdictCarrier;
  submittedAt?: string;
}

export interface PassProvenanceRecord {
  token: string;
  failToken: string;
  anchorSha: string;
  carrier: VerdictCarrier;
}

interface PassCandidate {
  token: string;
  recordedScanAt: number;
}

interface TokenMatch {
  sourceKey: string;
  row: NormalizedRow;
}

// 协议载体行 = 已发布（有时间戳）且非 system 的行：GitHub PENDING review 未提交、仅作者可见
// （同账号部署下 server 凭据即 QA 凭据能看到自己的草稿），拿它当载体会在 QA 定稿前放出裁决；
// system note（GitLab push/label 类）按 spec §6 矩阵恒不入裁决通道。提交后行获时间戳自然入流。
function isProtocolCarrier(row: NormalizedRow): boolean {
  return row.system !== true && versionTimeOf(row) !== undefined;
}

// 令牌一经发布即公开可复制：某令牌只要存在任一 DISMISSED 的 reviews 源承载行，
// 即在全部载体上失效——只跳行会让被撤销的 pass 借复制行复活（spec §7 撤销过滤）。
export function deadTokens(sources: VerdictSourceScan[]): Set<string> {
  const dead = new Set<string>();
  for (const s of sources) {
    if (s.sourceClass !== 'reviews') continue;
    for (const row of s.rows) {
      if (row.reviewState !== 'DISMISSED' || !isProtocolCarrier(row)) continue;
      for (const m of rowTokens(row)) dead.add(m.token);
    }
  }
  return dead;
}

// 无状态：merge 前复核由 manager 独立调用，不依赖 poller 的 engine 实例（spec §6 merge 条）。
export function recheckPassProvenance(
  record: PassProvenanceRecord,
  sources: VerdictSourceScan[],
): { ok: true } | { ok: false; reason: string } {
  if (sources.some(s => !s.ok)) return { ok: false, reason: 'source-scan-incomplete' };
  const row = sources.find(s => s.key === record.carrier.sourceKey)?.rows.find(r => String(r.id) === record.carrier.id);
  if (row === undefined) return { ok: false, reason: 'carrier-row-missing' };
  if (rowBodyDigest(row) !== record.carrier.bodyDigest) return { ok: false, reason: 'carrier-body-edited' };
  // digest 相同不代表载体真的携带该 pass 对：malformed provenance（普通评论行）不得复核通过
  if (!rowTokens(row).some(m => m.kind === 'pass' && m.token === record.token
    && m.anchorSha === record.anchorSha.toLowerCase())) {
    return { ok: false, reason: 'carrier-token-missing' };
  }
  const dead = deadTokens(sources);
  if (dead.has(record.token)) return { ok: false, reason: 'token-dismissed' };
  const anchor = record.anchorSha.toLowerCase();
  for (const s of sources) {
    for (const r of s.rows) {
      if (!isProtocolCarrier(r)) continue;
      for (const m of rowTokens(r)) {
        if (m.kind === 'fail' && m.token === record.failToken && m.anchorSha === anchor && !dead.has(m.token)) {
          return { ok: false, reason: 'fail-token-present' };
        }
      }
    }
  }
  return { ok: true };
}

export class VerdictEngine {
  private readonly candidates = new Map<string, PassCandidate>();

  evaluate(input: VerdictInput): VerdictDecision | undefined {
    // 完整性门：成功源里较旧的 pass 会遮蔽失败源里较新的 fail（spec §6 verdict ①）。
    if (input.sources.some(s => !s.ok)) return undefined;

    const anchor = input.anchorSha.toLowerCase();
    const dead = deadTokens(input.sources);
    let passMatch: TokenMatch | undefined;
    let failMatch: TokenMatch | undefined;
    for (const s of input.sources) {
      for (const row of s.rows) {
        if (!isProtocolCarrier(row)) continue;
        for (const m of rowTokens(row)) {
          if (m.anchorSha !== anchor || dead.has(m.token)) continue;
          if (m.kind === 'fail' && m.token === input.pair.failToken) failMatch ??= { sourceKey: s.key, row };
          if (m.kind === 'pass' && m.token === input.pair.passToken) passMatch ??= { sourceKey: s.key, row };
        }
      }
    }

    const key = `${input.taskId}:${input.prNumber}`;
    if (failMatch) {
      this.candidates.delete(key);
      return this.decision('fail', input.pair.failToken, anchor, passMatch !== undefined, failMatch);
    }
    if (!passMatch) {
      this.candidates.delete(key);
      return undefined;
    }

    // fail 无需等待滞后可见性（迟到的 pass 改变不了 fail 优先的结果）；pass 须过 fence + 确认周期：
    // 扫描开始时刻只证明请求何时发出，读副本可让 fence 前的 fail 暂不可见（spec §6 verdict ③）。
    const minScanStart = Math.min(...input.sources.map(s => s.scanStartedAt));
    const fence = minScanStart - input.visibilityLagMs;
    const vt = versionTimeOf(passMatch.row);
    if (vt === undefined || vt >= fence) {
      // 载体回到 fence 内（如确认期内被编辑）说明观察对象不再稳定：清掉候选、重走两周期
      // 确认——保留旧候选会把不稳定期当成第二个合格周期直接放行。
      this.candidates.delete(key);
      return undefined;
    }
    const candidate = this.candidates.get(key);
    if (candidate === undefined || candidate.token !== input.pair.passToken) {
      this.candidates.set(key, { token: input.pair.passToken, recordedScanAt: minScanStart });
      return undefined;
    }
    if (minScanStart <= candidate.recordedScanAt) return undefined;
    // 候选保留：确认后的 pass 每周期如实重产出（调用方按决策指纹去重），投递失败下一周期即重试，
    // 不必重走确认周期——与「确认状态仅内存、重启多等一轮无正确性影响」同一容忍度（spec §6③）。
    return this.decision('pass', input.pair.passToken, anchor, false, passMatch);
  }

  recheckPassProvenance(
    record: PassProvenanceRecord,
    sources: VerdictSourceScan[],
  ): { ok: true } | { ok: false; reason: string } {
    return recheckPassProvenance(record, sources);
  }

  // 裁决资格门失败（draft/closed/绑定失配/head 偏离锚点/令牌或 signal 缺失）时由调用方显式
  // 清候选：确认周期语义是「连续两个合格扫描」，跨越不可裁决状态存活的候选会把恢复后的
  // 首个扫描当成第二个确认周期直接 APPROVE（spec §6 verdict ③）。
  dropCandidate(taskId: string, prNumber: number): void {
    this.candidates.delete(`${taskId}:${prNumber}`);
  }

  dropTask(taskId: string): void {
    for (const key of this.candidates.keys()) {
      if (key.startsWith(`${taskId}:`)) this.candidates.delete(key);
    }
  }

  private decision(
    kind: 'pass' | 'fail', token: string, anchorSha: string, conflict: boolean, match: TokenMatch,
  ): VerdictDecision {
    return {
      kind, token, anchorSha, conflict,
      carrier: { sourceKey: match.sourceKey, id: String(match.row.id), bodyDigest: rowBodyDigest(match.row) },
      submittedAt: versionTimestampOf(match.row),
    };
  }
}
