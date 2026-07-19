import {
  ackCarrierKey, ackRevisionKey, classifyCommentSource, collectValidAcks, projectCommentRow,
  rowAcks, rowBodyDigest, rowHasBody, rowTokens,
  type AckActorContext, type AckCarrierRow, type AckCollection, type CommentSourceClass,
} from './markers.js';
import { versionTimeOf, type NormalizedRow } from './row-schema.js';
import type { CommentSourceOp } from './types.js';
import type { OpVars } from './git-driver.js';
import { deadTokens, type VerdictSourceScan } from './verdict-engine.js';

export interface FeedbackSourceScan {
  key: string;
  sourceClass: CommentSourceClass;
  ok: boolean;
  rows: NormalizedRow[];
}

export interface PendingFeedbackResult {
  allSourcesOk: boolean;
  pending: Map<string, { sourceKey: string; id: string; bodyDigest: string }>;
}

export interface CommentSourceReader {
  commentSources: CommentSourceOp[];
  runCommentSource(
    source: CommentSourceOp,
    vars: OpVars,
    projectPage?: (pageRows: NormalizedRow[]) => NormalizedRow[],
  ): Promise<NormalizedRow[]>;
}

// 单次全源抓取（poller 周期与 manager 权威复核共用）：行投影后释放正文、system 行统一过滤；
// 失败源保留在 scans（ok=false）供完整性门/fail-closed 判定。onFailure 在失败源入列后立即
// 调用——poller 以它承载 RATE_LIMIT 中止（抛错停止余下源），manager 侧默认继续扫完。
export async function scanCommentSourcesOnce(
  driver: CommentSourceReader,
  prNumber: number,
  now: () => number,
  onFailure?: (key: string, error: unknown) => void,
): Promise<VerdictSourceScan[]> {
  const scans: VerdictSourceScan[] = [];
  for (const source of driver.commentSources) {
    const sourceClass = classifyCommentSource(source);
    const scanStartedAt = now();
    try {
      const rows = await driver.runCommentSource(source, { prNumber }, pageRows => {
        for (const row of pageRows) projectCommentRow(row);
        return pageRows;
      });
      scans.push({ key: source.key, sourceClass, ok: true, scanStartedAt, rows: rows.filter(r => r.system !== true) });
    } catch (error) {
      scans.push({ key: source.key, sourceClass, ok: false, scanStartedAt, rows: [] });
      onFailure?.(source.key, error);
    }
  }
  return scans;
}

export function buildAckCarrierRows(scans: readonly FeedbackSourceScan[]): AckCarrierRow[] {
  return scans.flatMap(scan => scan.rows.map(row => ({
    sourceKey: scan.key,
    sourceClass: scan.sourceClass,
    id: String(row.id),
    authorId: typeof row.authorId === 'string' ? row.authorId : undefined,
    discussionId: row.discussionId === null || row.discussionId === undefined ? null : String(row.discussionId),
    acks: rowAcks(row),
    carriesToken: rowTokens(row).length > 0,
  })));
}

function unackedRevision(
  row: NormalizedRow,
  sourceKey: string,
  acks: AckCollection,
): { id: string; digest: string } | undefined {
  if (row.system === true) return undefined;
  if (versionTimeOf(row) === undefined) return undefined;
  if (!rowHasBody(row)) return undefined;
  const id = String(row.id);
  if (acks.carrierRowKeys.has(ackCarrierKey(sourceKey, id))) return undefined;
  const digest = rowBodyDigest(row);
  if (acks.acks.has(ackRevisionKey(sourceKey, id, digest))) return undefined;
  return { id, digest };
}

// poller 事件合成矩阵的行谓词（spec §6）：令牌行走裁决通道、载体行是 dev 回复、已 ack 的
// revision 已处置——三类都不合成反馈事件。
export function feedbackEventTarget(
  row: NormalizedRow,
  sourceKey: string,
  acks: AckCollection,
): { id: string; digest: string } | undefined {
  if (rowTokens(row).length > 0) return undefined;
  return unackedRevision(row, sourceKey, acks);
}

// 待 ack 集合（spec §6 矩阵②/§8）：目标 = 无标记人类评论 + fail 裁决正文（pass-only 行无 fix
// 轮不入集合）；有效 ack 逐 revision 判定。事件合成与 no-op/merge 复核共用此一个定义。
export function collectPendingFeedback(
  scans: readonly FeedbackSourceScan[],
  ctx: AckActorContext,
): PendingFeedbackResult {
  const acks = collectValidAcks(buildAckCarrierRows(scans), ctx);
  // dismiss 是受信人类的显式解除（spec §7 令牌级撤销）：被判死的 fail 不再构成待 ack 目标，
  // 复制到其它源的同 token 行同样出列
  const dead = deadTokens(scans.map(s => ({ ...s, scanStartedAt: 0 })));
  const pending: PendingFeedbackResult['pending'] = new Map();
  for (const scan of scans) {
    if (!scan.ok) continue;
    for (const row of scan.rows) {
      const tokens = rowTokens(row);
      if (tokens.length > 0 && !tokens.some(t => t.kind === 'fail' && !dead.has(t.token))) continue;
      const target = unackedRevision(row, scan.key, acks);
      if (target === undefined) continue;
      pending.set(ackRevisionKey(scan.key, target.id, target.digest), {
        sourceKey: scan.key, id: target.id, bodyDigest: target.digest,
      });
    }
  }
  return { allSourcesOk: scans.every(s => s.ok), pending };
}
