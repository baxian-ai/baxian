import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GithubReviewItem, TaskState } from '../shared/index.js';
import {
  GITHUB_REVIEW_VERDICT_CLASS,
  groupGithubReviewRounds,
  githubReviewItemKey,
  githubReviewRevision,
  githubReviewRoundKey,
  type GithubReviewRound,
} from '../shared/github-review.js';
import { useGithubReview } from '../hooks/use-github-review.ts';
import { TurnRow } from './review-turn-row.tsx';
import { useT, type Messages } from '../i18n/index.tsx';

interface Props {
  task: TaskState;
}

function reasonText(t: Messages): Record<string, string> {
  return {
    'server-mode': t.githubReview.reasonServerModeEntry,
    'no-pr': t.githubReview.reasonNoPr,
    'not-github': t.githubReview.reasonNotGithub,
  };
}

function firstLine(value?: string): string {
  return value?.trim().split('\n', 1)[0] ?? '';
}

function shortSha(item: GithubReviewItem): string | undefined {
  return item.commitSha?.slice(0, 9);
}

function inlineLocation(item: GithubReviewItem): string | undefined {
  if (item.kind !== 'review-comment' || !item.path) return undefined;
  return item.line !== undefined ? `${item.path}:${item.line}` : item.path;
}

function truncatedSuffix(t: Messages, item: GithubReviewItem): string {
  return item.bodyTruncated ? t.githubReview.truncatedSuffix : '';
}

function itemSummary(t: Messages, item: GithubReviewItem): string {
  const body = firstLine(item.body);
  const suffix = truncatedSuffix(t, item);
  if (item.kind === 'commit') {
    const sha = shortSha(item);
    if (sha && body) return `${sha} ${body}${suffix}`;
    return `${body || sha || t.githubReview.commitFallback}${suffix}`;
  }
  if (item.kind === 'review-comment') {
    const loc = inlineLocation(item);
    if (item.inReplyTo) {
      const parts = [item.author, loc, body].filter((part): part is string => !!part);
      if (parts.length > 0) return `${parts.join(' · ')}${suffix}`;
    }
    if (loc && body) return `${loc} · ${body}${suffix}`;
    return `${body || loc || t.githubReview.inlineComment}${suffix}`;
  }
  if (item.kind === 'issue-comment') {
    if (item.author && body) return `${item.author} · ${body}${suffix}`;
    return `${body || item.author || t.githubReview.comment}${suffix}`;
  }
  return `${body || t.githubReview.noReviewBodyFallback}${suffix}`;
}

function itemLabel(t: Messages, item: GithubReviewItem): string {
  if (item.kind === 'commit') return t.review.submitCodeChanges;
  if (item.kind === 'review') return t.review.reviewTurnLabel;
  if (item.kind === 'review-comment') return item.inReplyTo ? t.review.responseTurnLabel : t.githubReview.inlineComment;
  return t.githubReview.comment;
}

function itemRole(item: GithubReviewItem): 'dev' | 'qa' {
  return item.kind === 'commit' || item.kind === 'issue-comment' || item.inReplyTo ? 'dev' : 'qa';
}

export function GithubReviewEntry({ task }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const revision = githubReviewRevision(task);
  const { data, loaded, error } = useGithubReview(task.id, revision);

  function open() {
    navigate(`/tasks/${encodeURIComponent(task.id)}/github-review`);
  }

  if (error) {
    return (
      <ReviewGroup>
        <div className="text-sm text-accent">{t.review.loadFailed(error)}</div>
      </ReviewGroup>
    );
  }

  if (!loaded) {
    return (
      <ReviewGroup>
        <div className="text-sm text-og-400">{t.review.loadingRecords}</div>
      </ReviewGroup>
    );
  }

  if (!data?.available) {
    const reasons = reasonText(t);
    return (
      <ReviewGroup>
        <div className="text-sm text-og-400">{reasons[data?.reason ?? 'no-pr'] ?? reasons['no-pr']}</div>
      </ReviewGroup>
    );
  }

  if (data.items.length === 0) {
    return (
      <ReviewGroup>
        {data.error ? (
          <div className="text-sm text-accent">{t.githubReview.fetchFailed(data.error)}</div>
        ) : (
          <div className="text-sm text-og-400">{t.review.notStarted}</div>
        )}
      </ReviewGroup>
    );
  }

  const rounds = groupGithubReviewRounds(data.items);

  return (
    <ReviewGroup>
      {data.error && (
        <div className="text-xs text-accent">{t.githubReview.partialFetchFailed(data.error)}</div>
      )}
      {rounds.map((round, index) => (
        <RoundBlock key={githubReviewRoundKey(round, String(index))} round={round} index={index} onOpen={open} />
      ))}
    </ReviewGroup>
  );
}

function ReviewGroup({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div>
      <div className="mb-1.5 text-xs text-og-700">{t.githubReview.codeReviewHeading}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function RoundBlock({
  round,
  index,
  onOpen,
}: {
  round: GithubReviewRound;
  index: number;
  onOpen: () => void;
}) {
  const t = useT();
  const label = round.review ? t.agents.round(index + 1) : t.status.in_progress;
  return (
    <div>
      <div className="mb-1 text-xs text-og-400">{label}</div>
      <div className="space-y-1.5">
        {round.items.map((item, itemIndex) => (
          <GithubTurnRow key={githubReviewItemKey(item, `${index}-${itemIndex}`)} item={item} onOpen={onOpen} />
        ))}
        {round.review && <GithubTurnRow item={round.review} onOpen={onOpen} />}
      </div>
    </div>
  );
}

function GithubTurnRow({ item, onOpen }: { item: GithubReviewItem; onOpen: () => void }) {
  const t = useT();
  const verdict = item.kind === 'review' ? item.verdict : undefined;
  return (
    <TurnRow
      role={itemRole(item)}
      label={itemLabel(t, item)}
      badge={verdict ? <span className={GITHUB_REVIEW_VERDICT_CLASS[verdict]}>{verdict}</span> : undefined}
      summary={itemSummary(t, item)}
      onClick={onOpen}
    />
  );
}
