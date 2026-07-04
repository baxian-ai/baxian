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

interface Props {
  task: TaskState;
}

const REASON_TEXT: Record<string, string> = {
  'server-mode': '该 task 为 server 评审模式，代码评审记录见 server 评审轮次。',
  'no-pr': '该 task 还没有 PR，暂无代码评审记录。',
  'not-github': '该 task 的仓库不是 GitHub 仓库，无法拉取 PR 评审记录。',
};

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

function truncatedSuffix(item: GithubReviewItem): string {
  return item.bodyTruncated ? '（已截断）' : '';
}

function itemSummary(item: GithubReviewItem): string {
  const body = firstLine(item.body);
  const suffix = truncatedSuffix(item);
  if (item.kind === 'commit') {
    const sha = shortSha(item);
    if (sha && body) return `${sha} ${body}${suffix}`;
    return `${body || sha || 'commit'}${suffix}`;
  }
  if (item.kind === 'review-comment') {
    const loc = inlineLocation(item);
    if (item.inReplyTo) {
      const parts = [item.author, loc, body].filter((part): part is string => !!part);
      if (parts.length > 0) return `${parts.join(' · ')}${suffix}`;
    }
    if (loc && body) return `${loc} · ${body}${suffix}`;
    return `${body || loc || '行内评论'}${suffix}`;
  }
  if (item.kind === 'issue-comment') {
    if (item.author && body) return `${item.author} · ${body}${suffix}`;
    return `${body || item.author || '评论'}${suffix}`;
  }
  return `${body || '无评审正文'}${suffix}`;
}

function itemLabel(item: GithubReviewItem): string {
  if (item.kind === 'commit') return '提交代码改动';
  if (item.kind === 'review') return '评审';
  if (item.kind === 'review-comment') return item.inReplyTo ? '反馈' : '行内评论';
  return '评论';
}

function itemRole(item: GithubReviewItem): 'dev' | 'qa' {
  return item.kind === 'commit' || item.kind === 'issue-comment' || item.inReplyTo ? 'dev' : 'qa';
}

export function GithubReviewEntry({ task }: Props) {
  const navigate = useNavigate();
  const revision = githubReviewRevision(task);
  const { data, loaded, error } = useGithubReview(task.id, revision);

  function open() {
    navigate(`/tasks/${encodeURIComponent(task.id)}/github-review`);
  }

  if (error) {
    return (
      <ReviewGroup>
        <div className="text-sm text-accent">加载评审记录失败：{error}</div>
      </ReviewGroup>
    );
  }

  if (!loaded) {
    return (
      <ReviewGroup>
        <div className="text-sm text-og-400">加载评审记录…</div>
      </ReviewGroup>
    );
  }

  if (!data?.available) {
    return (
      <ReviewGroup>
        <div className="text-sm text-og-400">{REASON_TEXT[data?.reason ?? 'no-pr'] ?? REASON_TEXT['no-pr']}</div>
      </ReviewGroup>
    );
  }

  if (data.items.length === 0) {
    return (
      <ReviewGroup>
        {data.error ? (
          <div className="text-sm text-accent">评审记录拉取失败：{data.error}</div>
        ) : (
          <div className="text-sm text-og-400">评审尚未开始</div>
        )}
      </ReviewGroup>
    );
  }

  const rounds = groupGithubReviewRounds(data.items);

  return (
    <ReviewGroup>
      {data.error && (
        <div className="text-xs text-accent">部分评审记录拉取失败：{data.error}（仅展示已获取的部分）</div>
      )}
      {rounds.map((round, index) => (
        <RoundBlock key={githubReviewRoundKey(round, String(index))} round={round} index={index} onOpen={open} />
      ))}
    </ReviewGroup>
  );
}

function ReviewGroup({ children }: { children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs text-og-700">代码评审</div>
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
  const label = round.review ? `第 ${index + 1} 轮` : '进行中';
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
  const verdict = item.kind === 'review' ? item.verdict : undefined;
  return (
    <TurnRow
      role={itemRole(item)}
      label={itemLabel(item)}
      badge={verdict ? <span className={GITHUB_REVIEW_VERDICT_CLASS[verdict]}>{verdict}</span> : undefined}
      summary={itemSummary(item)}
      onClick={onOpen}
    />
  );
}
