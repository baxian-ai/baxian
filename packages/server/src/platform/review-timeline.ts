import type { CommentSourceOp } from './types.js';
import { DriverOpError, safeDriverErrorText } from './git-driver.js';
import { versionTimeOf, type NormalizedRow } from './row-schema.js';
import { classifyCommentSource, rowBodyDigest, rowTokens, stripBaxianMarkerLines, type CommentSourceClass } from './markers.js';
import { MAX_INLINE_CONTENT_BYTES } from '../shared/index.js';
import type { PrReviewItem, PrReviewItemKind } from '../shared/index.js';

export interface TimelineSourceReader {
  readonly commentSources: CommentSourceOp[];
  runCommentSource(
    source: CommentSourceOp,
    vars: { prNumber: number },
    projectPage?: (pageRows: NormalizedRow[]) => NormalizedRow[],
    shouldStop?: (pageRows: NormalizedRow[], page: number) => boolean,
  ): Promise<NormalizedRow[]>;
}

// 聚合上界：单条 10 KiB 只限一行，三源 × 100 页 × 100 条可达数百 MiB。预算按源均分并在
// 分页循环内生效（driver 的 all/seen 因此同受硬界），避免靠前的源吃光额度让 reviews 源
// 的裁决行整体消失；计量按投影后 item 的完整序列化长度，不只是正文。
const TIMELINE_MAX_ITEMS = 2_000;
// 为 items 数组的逗号/方括号与外层 payload 包装预留 framing 余量，硬边界按完整序列化成立。
const TIMELINE_PAYLOAD_MAX_BYTES = 2 * 1024 * 1024;
const TIMELINE_FRAMING_RESERVE = 8 * 1024;
const TIMELINE_MAX_BYTES = TIMELINE_PAYLOAD_MAX_BYTES - TIMELINE_FRAMING_RESERVE;

const KIND_BY_CLASS: Record<CommentSourceClass, PrReviewItemKind> = {
  reviews: 'review',
  threaded: 'review-comment',
  'top-level': 'issue-comment',
};

// 纯展示投影，不参与裁决；令牌提取与裁剪在页内钩子完成后即释放原文（跨页聚合无总量上限）。
interface TimelineEntry {
  item: PrReviewItem;
  sortTime?: number;
}

export async function buildDriverReviewTimeline(
  driver: TimelineSourceReader,
  prNumber: number,
): Promise<{ items: PrReviewItem[]; error?: string; rateLimited?: boolean; truncated?: boolean }> {
  const entries: TimelineEntry[] = [];
  const errors: string[] = [];
  let rateLimited = false;
  let truncated = false;
  const sourceCount = Math.max(driver.commentSources.length, 1);
  const itemQuota = Math.max(1, Math.floor(TIMELINE_MAX_ITEMS / sourceCount));
  const byteQuota = Math.max(1, Math.floor(TIMELINE_MAX_BYTES / sourceCount));
  for (const source of driver.commentSources) {
    const kind = KIND_BY_CLASS[classifyCommentSource(source)];
    const collected: TimelineEntry[] = [];
    let sourceBytes = 0;
    // 截断标志只驱动响应提示；停止谓词必须只看**本源**配额，否则前一个源截断后每个后续源
    // 都会在第一页即停（reviews 的新裁决因此消失）。
    let sourceTruncated = false;
    const markTruncated = (): void => {
      sourceTruncated = true;
      truncated = true;
    };
    // 命中硬配额即声明截断：停止谓词让 runPaged 停在配额边界，后续页永不读取，
    // 只在「又多看见一条」时才置位会把不完整时间线当成完整结果返回。
    const overQuota = (): boolean => {
      if (sourceTruncated) return true;
      if (collected.length >= itemQuota || sourceBytes >= byteQuota) {
        markTruncated();
        return true;
      }
      return false;
    };
    const seenRows = new Map<string, string>();
    const admit = (pageRows: NormalizedRow[]): void => {
      for (const row of pageRows) {
        compactRowForTimeline(row);
        if (row.system === true) continue;
        // 页内投影先于 runPaged 的跨页去重，重叠页会把同一行送来两次——身份键在此自查重。
        const id = String(row.id);
        const digest = String(row.bodyDigest ?? '');
        if (seenRows.get(id) === digest) continue;
        seenRows.set(id, digest);
        const entry = projectRow(source.key, kind, row);
        const size = Buffer.byteLength(JSON.stringify(entry.item), 'utf8') + 1;
        // 判定先于计入：单条本身超额时也必须丢弃，否则一条超大投影就能撑爆响应。
        if (collected.length >= itemQuota || sourceBytes + size > byteQuota) {
          markTruncated();
          break;
        }
        sourceBytes += size;
        collected.push(entry);
      }
    };
    let pagedInline = false;
    let rows: NormalizedRow[];
    try {
      rows = await driver.runCommentSource(
        source,
        { prNumber },
        pageRows => {
          pagedInline = true;
          admit(pageRows);
          // 只回传身份+指纹的瘦身行：driver 的 all/seen 不再滞留正文，但跨页重复页检测与
          // 同 id 冲突检测仍按原语义工作。
          return pageRows.map(r => ({ id: r.id, bodyDigest: r.bodyDigest }));
        },
        () => overQuota(),
      );
      // reader 未消费页内钩子时（projectPage 是可选契约）仍按同一预算收集，绝不静默空时间线。
      if (!pagedInline) admit(rows);
      entries.push(...collected);
    } catch (err) {
      console.warn(`[review-timeline] source ${source.key} failed:`, safeDriverErrorText(err));
      errors.push(`${source.key}: ${safeDriverErrorText(err)}`);
      // 限流即停扫其余源并向上如实声明：抹平成普通 error 会让展示端按秒级重试，
      // 绕过平台退避（GitHub 明示持续撞限流可致集成被禁用）。
      if (err instanceof DriverOpError && err.info.errorClass === 'RATE_LIMIT') {
        rateLimited = true;
        break;
      }
      continue;
    }
  }
  sortTimeline(entries);
  return {
    items: entries.map(e => e.item),
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
    ...(rateLimited ? { rateLimited: true } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

interface TimelineBodyStash {
  timelineToken?: ReturnType<typeof rowTokens>[number];
  timelineBody: { body?: string; bodyTruncated?: boolean };
}

function compactRowForTimeline(row: NormalizedRow): void {
  const token = rowTokens(row)[0];
  // 摘要必须在删正文前落到行上：瘦身分页行以它作指纹，缺失会让 runPaged 把「同 id 不同正文」
  // 误判成完全相同的重复行（该形态的契约是拒绝本轮扫描、下轮重试）。
  if (row.bodyDigest === undefined) row.bodyDigest = rowBodyDigest(row);
  const body = sizedBody(stripBaxianMarkerLines(typeof row.body === 'string' ? row.body : ''));
  (row as NormalizedRow & TimelineBodyStash).timelineToken = token;
  (row as NormalizedRow & TimelineBodyStash).timelineBody = body;
  delete row.body;
}

function timelineStash(row: NormalizedRow): TimelineBodyStash {
  const stashed = row as NormalizedRow & Partial<TimelineBodyStash>;
  if (stashed.timelineBody !== undefined) {
    return { timelineToken: stashed.timelineToken, timelineBody: stashed.timelineBody };
  }
  return {
    timelineToken: rowTokens(row)[0],
    timelineBody: sizedBody(stripBaxianMarkerLines(typeof row.body === 'string' ? row.body : '')),
  };
}

function projectRow(sourceKey: string, kind: PrReviewItemKind, row: NormalizedRow): TimelineEntry {
  const id = String(row.id);
  const { timelineToken: token, timelineBody } = timelineStash(row);
  const line = typeof row.line === 'number' ? row.line
    : typeof row.originalLine === 'number' ? row.originalLine : undefined;
  const createdAt = typeof row.createdAt === 'string' ? row.createdAt
    : typeof row.updatedAt === 'string' ? row.updatedAt : undefined;
  const threaded = kind === 'review-comment' && row.discussionId !== null && row.discussionId !== undefined;
  // 回复身份只信显式 parentId 映射（时间/顺序推断在秒精度与仅 updatedAt 的合法源上都不成立）；
  // 未映射的源不标注，仅少一个回复徽标。
  const isReply = row.parentId !== null && row.parentId !== undefined && String(row.parentId) !== String(row.id);
  return {
    item: {
      kind,
      id,
      sourceKey,
      threadKey: `${sourceKey}:${threaded ? String(row.discussionId) : id}`,
      ...(typeof row.author === 'string' && row.author !== '' ? { author: row.author } : {}),
      ...timelineBody,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(token !== undefined
        ? {
          verdict: token.kind === 'pass' ? 'approve' as const : 'request-changes' as const,
          roundToken: token.token,
          anchorSha: token.anchorSha,
        }
        : {}),
      ...(typeof row.reviewState === 'string' ? { reviewState: row.reviewState } : {}),
      ...(typeof row.path === 'string' ? { path: row.path } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(typeof row.commitSha === 'string' ? { commitSha: row.commitSha } : {}),
      ...(isReply ? { inReplyTo: true } : {}),
    },
    sortTime: versionTimeOf(row),
  };
}

function sizedBody(raw: string): { body?: string; bodyTruncated?: boolean } {
  const trimmed = raw.replace(/\n+$/, '');
  const buf = Buffer.from(trimmed, 'utf8');
  if (buf.byteLength <= MAX_INLINE_CONTENT_BYTES) {
    return trimmed !== '' ? { body: trimmed } : {};
  }
  let cut = MAX_INLINE_CONTENT_BYTES;
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return { body: buf.subarray(0, cut).toString('utf8'), bodyTruncated: true };
}

// 数值 versionTime（updatedAt ?? createdAt）排序：编辑过的行（含后补 verdict token）按修订
// 时刻落位，RFC3339 任意 offset 也正确比较；同刻 review 排后，分轮不把随行评论溢进下一轮。
function sortTimeline(entries: TimelineEntry[]): void {
  // 同刻权重覆盖一切裁决载体（含降级评论）：裁决闭轮，排前会把同轮评论挤进下一轮。
  const rank = (e: TimelineEntry): number =>
    (e.item.kind === 'review' || e.item.verdict !== undefined ? 1 : 0);
  entries.sort((a, b) => {
    if (a.sortTime !== undefined && b.sortTime !== undefined) {
      if (a.sortTime !== b.sortTime) return a.sortTime - b.sortTime;
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
    }
    if (a.sortTime !== undefined) return -1;
    if (b.sortTime !== undefined) return 1;
    return 0;
  });
}
