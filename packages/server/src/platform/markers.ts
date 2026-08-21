import { bodyDigest } from './body-digest.js';
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
}

const unanchored = (re: RegExp) => re.source.replace(/^\^/, '').replace(/\$$/, '');
const REVIEW_TOKEN_RE = new RegExp(
  `<!--\\s*baxian:review:(pass|fail):(${SHA_HEX_SOURCE}):([A-Za-z0-9_-]{6,64})\\s*-->`, 'g',
);
const ACK_RE = new RegExp(
  `<!--\\s*baxian:reply:ack:(${unanchored(SOURCE_KEY_PATTERN)}):(${unanchored(LINE_SAFE_ID_RE)})\\s*-->`, 'g',
);
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
  return `<!-- baxian:reply:ack:${m.sourceKey}:${m.commentId} -->`;
}

export function extractAckMarkers(body: string): AckMarker[] {
  return [...body.matchAll(ACK_RE)].map(m => ({ sourceKey: m[1], commentId: m[2] }));
}

export function stripBaxianMarkerLines(body: string): string {
  return body
    .split('\n')
    .filter(line => !MARKER_ONLY_LINE_RE.test(line.trim()))
    .join('\n');
}

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

export interface AckCarrierRow {
  sourceKey: string;
  id: string;
  acks: AckMarker[];
}

export const ackRevisionKey = (sourceKey: string, id: string, digest: string) => `${sourceKey}:${id}:${digest}`;
export const ackCarrierKey = (sourceKey: string, id: string) => `${sourceKey}:${id}`;

// Settled keys: comments that were acked, plus the ack-carrying replies themselves.
export function collectValidAcks(rows: AckCarrierRow[]): Set<string> {
  const settled = new Set<string>();
  for (const row of rows) {
    if (row.acks.length === 0) continue;
    for (const m of row.acks) settled.add(ackCarrierKey(m.sourceKey, m.commentId));
    settled.add(ackCarrierKey(row.sourceKey, row.id));
  }
  return settled;
}
