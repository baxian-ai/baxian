// baxian 标记线协议（spec §6/§7/§8）：verdict 令牌行与逐 revision ack 行的唯一定义，
// verdict engine / 事件过滤 / ack 完成集 / 展示剥离共用，防多处正则漂移。

import { BODY_DIGEST_SOURCE, bodyDigest } from './body-digest.js';
import { SHA_HEX_SOURCE, SOURCE_KEY_PATTERN } from './types.js';
import { LINE_SAFE_ID_RE, versionTimeOf, type NormalizedRow } from './row-schema.js';

export interface ReviewTokenMarker {
  kind: 'pass' | 'fail';
  anchorSha: string;
  token: string;
}

export interface AckMarker {
  sourceKey: string;
  commentId: string;
  bodyDigest: string;
}

// 段文法取自各自的具名定义：装机校验放行的键/id/digest 形态与线协议能解析回来的
// 必须是同一形态——各自内联会在任一侧收放后静默失配（ack 永判无效、反馈重派循环）。
const unanchored = (re: RegExp) => re.source.replace(/^\^/, '').replace(/\$$/, '');
const REVIEW_TOKEN_RE = new RegExp(
  `<!--\\s*baxian:review:(pass|fail):(${SHA_HEX_SOURCE}):([A-Za-z0-9_-]{6,64})\\s*-->`, 'g',
);
const ACK_RE = new RegExp(
  `<!--\\s*baxian:reply:ack:(${unanchored(SOURCE_KEY_PATTERN)}):(${unanchored(LINE_SAFE_ID_RE)}):(${BODY_DIGEST_SOURCE})\\s*-->`, 'g',
);
// (?:(?!-->).)* 禁止注释体内提前出现 -->：贪婪 .* 会从行首标记吞到行尾另一条注释，
// 把夹在中间的可见正文一并剥掉——只有「单条完整注释占满整行」才可剥。
const MARKER_ONLY_LINE_RE = /^<!--\s*baxian:(?:(?!-->).)*-->$/;

export function buildReviewTokenLine(m: ReviewTokenMarker): string {
  return `<!-- baxian:review:${m.kind}:${m.anchorSha}:${m.token} -->`;
}

export function extractReviewTokens(body: string): ReviewTokenMarker[] {
  return [...body.matchAll(REVIEW_TOKEN_RE)].map(m => ({
    kind: m[1] as 'pass' | 'fail',
    anchorSha: m[2].toLowerCase(),
    token: m[3],
  }));
}

export function buildAckMarker(m: AckMarker): string {
  return `<!-- baxian:reply:ack:${m.sourceKey}:${m.commentId}:${m.bodyDigest} -->`;
}

export function extractAckMarkers(body: string): AckMarker[] {
  return [...body.matchAll(ACK_RE)].map(m => ({ sourceKey: m[1], commentId: m[2], bodyDigest: m[3] }));
}

// 仅剥「整行只有 baxian 标记」的行——verdict engine 恒读原文，此函数只服务展示/正文投影（v1 分离原则）。
export function stripBaxianMarkerLines(body: string): string {
  return body
    .split('\n')
    .filter(line => !MARKER_ONLY_LINE_RE.test(line.trim()))
    .join('\n');
}

// 行投影（spec v1 §6 页内管线，v2 §5.3 继承）：正文一次性折算成 digest/令牌/ack/非空标记后
// 原文即释放——分页聚合与 scans 跨源滞留的都是投影行，内存不随评论原文总量线性增长。
// 读取端一律走 rowXxx 助手：投影行取 stash、未投影行（测试直构）现算，单点防两套语义漂移。
const PROJECTED = Symbol('bodyProjected');

export function projectCommentRow(row: NormalizedRow): void {
  const body = typeof row.body === 'string' ? row.body : '';
  const versionTime = versionTimeOf(row);
  row.bodyDigest = bodyDigest(body);
  row.bodyTokens = extractReviewTokens(body);
  row.bodyAcks = extractAckMarkers(body);
  row.hasBody = body !== '';
  if (versionTime !== undefined) row.versionTime = versionTime;
  (row as Record<PropertyKey, unknown>)[PROJECTED] = true;
  delete row.body;
}

const isProjected = (row: NormalizedRow): boolean =>
  (row as Record<PropertyKey, unknown>)[PROJECTED] === true;

const rawBody = (row: NormalizedRow): string => (typeof row.body === 'string' ? row.body : '');

export function rowBodyDigest(row: NormalizedRow): string {
  return isProjected(row) ? (row.bodyDigest as string) : bodyDigest(rawBody(row));
}

export function rowTokens(row: NormalizedRow): ReviewTokenMarker[] {
  return isProjected(row) ? (row.bodyTokens as ReviewTokenMarker[]) : extractReviewTokens(rawBody(row));
}

export function rowAcks(row: NormalizedRow): AckMarker[] {
  return isProjected(row) ? (row.bodyAcks as AckMarker[]) : extractAckMarkers(rawBody(row));
}

export function rowHasBody(row: NormalizedRow): boolean {
  return isProjected(row) ? row.hasBody === true : rawBody(row) !== '';
}

export type CommentSourceClass = 'reviews' | 'threaded' | 'top-level';

// 载体类按声明结构推导而非 key 字面（用户插件的 key 集合任意，spec §6 矩阵须平台中立）：
// 声明 reviewState 的源承载 native review（恒非 ack 载体），声明 discussionId 的源有线程结构。
export function classifyCommentSource(source: { map?: Record<string, unknown> }): CommentSourceClass {
  const map = source.map ?? {};
  if ('reviewState' in map) return 'reviews';
  if ('discussionId' in map) return 'threaded';
  return 'top-level';
}

export interface AckActorContext {
  replyActorId?: string;
  replyActorStatus?: 'verified' | 'provisional';
}

export interface AckCarrierRow {
  sourceKey: string;
  sourceClass: CommentSourceClass;
  id: string;
  authorId?: string;
  discussionId?: string | null;
  acks: AckMarker[];
  carriesToken: boolean;
}

export interface AckCollection {
  acks: Set<string>;
  carrierRowKeys: Set<string>;
}

// 集合成员键的拼法与产出同居：消费侧手工重拼在键形变更时会静默 miss（已 ack 反馈重发）。
export const ackRevisionKey = (sourceKey: string, id: string, digest: string) => `${sourceKey}:${id}:${digest}`;
export const ackCarrierKey = (sourceKey: string, id: string) => `${sourceKey}:${id}`;

// ack 载体矩阵（spec §6 矩阵修订③④）：唯一授权谓词 = verified 且 authorId 相等；
// reviews 类行与携令牌行恒非载体（同账号 confused-deputy 结构隔离）；threaded 行可 ack
// **同一线程内任意成员**（根或回复 revision——poller 对 reply 行投递的 revision id 即行自身 id，
// 只认线程根会让合法 ack 永判无效并把 dev 回复再当新反馈）；隶属以传入行集解析，
// 目标行不在集合内按 fail-closed 拒绝。行集可跨源（issue 类顶层 ack 可指向任意源），
// 载体键与隶属表一律 (sourceKey, id)——三源是不同对象表、数值 id 无跨表唯一性契约（spec §5.3 增量①）。
export function collectValidAcks(rows: AckCarrierRow[], ctx: AckActorContext): AckCollection {
  const acks = new Set<string>();
  const carrierRowKeys = new Set<string>();
  if (ctx.replyActorStatus !== 'verified' || ctx.replyActorId === undefined) return { acks, carrierRowKeys };
  const threadRootById = new Map<string, string>();
  for (const row of rows) {
    threadRootById.set(ackCarrierKey(row.sourceKey, row.id), row.discussionId ?? row.id);
  }
  for (const row of rows) {
    if (row.authorId === undefined || row.authorId !== ctx.replyActorId) continue;
    if (row.sourceClass === 'reviews') continue;
    if (row.carriesToken) continue;
    if (row.sourceClass === 'threaded' && (row.discussionId === null || row.discussionId === undefined)) continue;
    let carried = false;
    for (const m of row.acks) {
      if (row.sourceClass === 'threaded') {
        if (m.sourceKey !== row.sourceKey) continue;
        const targetRoot = threadRootById.get(ackCarrierKey(m.sourceKey, m.commentId));
        if (targetRoot === undefined || targetRoot !== row.discussionId) continue;
      }
      acks.add(ackRevisionKey(m.sourceKey, m.commentId, m.bodyDigest));
      carried = true;
    }
    if (carried) carrierRowKeys.add(ackCarrierKey(row.sourceKey, row.id));
  }
  return { acks, carrierRowKeys };
}
