import { useNavigate, useParams } from 'react-router-dom';
import type { GithubReviewItem, GithubReviewVerdict } from '../shared/index.js';
import { useTask } from '../hooks/use-events.ts';
import { useGithubReview } from '../hooks/use-github-review.ts';

const VERDICT_CLASS: Record<GithubReviewVerdict, string> = {
  approve: 'pill pill-live',
  'request-changes': 'pill pill-warn',
  comment: 'pill',
};

const VERDICT_LABEL: Record<GithubReviewVerdict, string> = {
  approve: 'approve',
  'request-changes': 'request-changes',
  comment: 'comment',
};

const REASON_TEXT: Record<NonNullable<ReturnType<typeof reasonOf>>, string> = {
  'server-mode': '该 task 为 server 评审模式，代码评审记录见任务详情的「评审记录」。',
  'no-pr': '该 task 还没有 PR，暂无代码评审记录。',
  'not-github': '该 task 的仓库不是 GitHub 仓库，无法拉取 PR 评审记录。',
};

function reasonOf(reason?: string): 'server-mode' | 'no-pr' | 'not-github' | undefined {
  return reason === 'server-mode' || reason === 'no-pr' || reason === 'not-github' ? reason : undefined;
}

function fmt(ts?: string): string {
  if (!ts) return '';
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : ts;
}

interface Round {
  items: GithubReviewItem[];
  review?: GithubReviewItem;
}

function groupRounds(items: GithubReviewItem[]): Round[] {
  const rounds: Round[] = [];
  let bucket: GithubReviewItem[] = [];
  for (const it of items) {
    if (it.kind === 'review') {
      rounds.push({ items: bucket, review: it });
      bucket = [];
    } else {
      bucket.push(it);
    }
  }
  if (bucket.length > 0) rounds.push({ items: bucket });
  return rounds;
}

export function GithubReviewPage() {
  const { taskId = '' } = useParams();
  const navigate = useNavigate();
  const { data: task } = useTask(taskId);
  const revision = task ? `${task.reviewRound}:${task.latestHeadSha ?? ''}:${task.status}` : undefined;
  const { data, loaded, error } = useGithubReview(taskId, revision);

  const prNumber = data?.prNumber ?? task?.prNumber;
  const prUrl = data?.prUrl ?? task?.prUrl;
  const rounds = data ? groupRounds(data.items) : [];

  return (
    <div className="mx-auto w-full max-w-5xl">
      <button type="button" onClick={() => navigate(-1)} className="btn-ghost mb-3">
        ← 返回
      </button>
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-og-400">{taskId}</span>
        <span className="text-[16px] font-semibold text-og-1000">{task?.title ?? ''}</span>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px] text-og-500">
        <span className="pill">代码评审</span>
        {prUrl && prNumber !== undefined && (
          <a href={prUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-hover">
            Open PR #{prNumber}
          </a>
        )}
      </div>

      {!loaded && <div className="text-[14px] text-og-500">加载中…</div>}
      {loaded && error && <div className="text-[14px] text-danger">加载评审记录失败：{error}</div>}
      {loaded && !error && data && !data.available && (
        <div className="text-[14px] text-og-500">{REASON_TEXT[reasonOf(data.reason) ?? 'no-pr']}</div>
      )}
      {loaded && !error && data?.available &&
        (data.items.length === 0 ? (
          data.error ? (
            <div className="text-[14px] text-warn">评审记录拉取失败：{data.error}</div>
          ) : (
            <div className="text-[14px] text-og-400">评审尚未开始</div>
          )
        ) : (
          <>
            {data.error && (
              <div className="mb-3 text-[13px] text-warn">部分评审记录拉取失败：{data.error}（仅展示已获取的部分）</div>
            )}
            <div className="space-y-5">
              {rounds.map((round, i) => (
                <RoundBlock key={i} round={round} index={i} />
              ))}
            </div>
          </>
        ))}
    </div>
  );
}

function RoundBlock({ round, index }: { round: Round; index: number }) {
  const label = round.review ? `第 ${index + 1} 轮` : '进行中';
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-og-700">{label}</div>
      <div className="space-y-2">
        {round.items.map((it) => (
          <ItemRow key={`${it.kind}-${it.id}`} item={it} />
        ))}
        {round.review && <ReviewBlock item={round.review} />}
      </div>
    </div>
  );
}

function ItemRow({ item }: { item: GithubReviewItem }) {
  if (item.kind === 'commit') {
    return (
      <div className="card p-3 text-[14px]">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="pill shrink-0">提交</span>
          {item.commitSha && <span className="font-mono text-[13px] text-og-500">{item.commitSha.slice(0, 9)}</span>}
          {item.author && <span className="text-[13px] text-og-400">{item.author}</span>}
          {item.createdAt && <span className="text-[13px] text-og-400">{fmt(item.createdAt)}</span>}
        </div>
        {item.body && <div className="whitespace-pre-wrap break-words text-og-800">{item.body}</div>}
      </div>
    );
  }
  const isInline = item.kind === 'review-comment';
  return (
    <div className="card p-3 text-[14px]">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="pill shrink-0">{isInline ? '行内评论' : '评论'}</span>
        {item.author && <span className="font-medium text-og-700">{item.author}</span>}
        {isInline && item.path && (
          <span className="min-w-0 break-all font-mono text-[13px] text-og-500">
            {item.line !== undefined ? `${item.path}:${item.line}` : item.path}
          </span>
        )}
        {item.inReplyTo && <span className="text-[13px] text-og-400">↩ 回复</span>}
        {item.createdAt && <span className="text-[13px] text-og-400">{fmt(item.createdAt)}</span>}
      </div>
      <Body item={item} />
    </div>
  );
}

function ReviewBlock({ item }: { item: GithubReviewItem }) {
  const verdict = item.verdict ?? 'comment';
  return (
    <div className="card p-3 text-[14px]">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="shrink-0 min-w-[1.75rem] text-[12px] font-semibold uppercase tracking-wide text-[#c2410c]">
          QA
        </span>
        <span className={VERDICT_CLASS[verdict]}>{VERDICT_LABEL[verdict]}</span>
        {item.author && <span className="text-[13px] text-og-400">{item.author}</span>}
        {item.commitSha && <span className="font-mono text-[13px] text-og-500">{item.commitSha.slice(0, 9)}</span>}
        {item.createdAt && <span className="text-[13px] text-og-400">{fmt(item.createdAt)}</span>}
      </div>
      <Body item={item} placeholder="（无评审正文）" />
    </div>
  );
}

function Body({ item, placeholder }: { item: GithubReviewItem; placeholder?: string }) {
  return (
    <>
      {item.body ? (
        <div className="whitespace-pre-wrap break-words text-og-800">{item.body}</div>
      ) : placeholder ? (
        <div className="text-og-400">{placeholder}</div>
      ) : null}
      {item.bodyTruncated && <div className="mt-1 text-[13px] text-warn">内容较大，已截断。</div>}
    </>
  );
}
