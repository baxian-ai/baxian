import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  ReviewFindings,
  ReviewResponse,
  ReviewRound,
  TaskPhase,
  TaskState,
} from '../shared/index.js';
import { useReviewRounds } from '../hooks/use-review-rounds.ts';

interface Props {
  task: TaskState;
  onClose: () => void;
}

const PHASE_LABEL: Record<TaskPhase, string> = {
  spec: '规格评审 (spec)',
  code: '代码评审 (code)',
};

const VERDICT_CLASS: Record<ReviewFindings['verdict'], string> = {
  approve: 'pill pill-live',
  'request-changes': 'pill pill-warn',
};

function lineCount(content: string): number {
  if (!content) return 0;
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  return trimmed === '' ? 0 : trimmed.split('\n').length;
}

function devSummary(round: ReviewRound): string {
  if (round.phase === 'code') {
    const stat = (round.diffstat ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    return stat ?? `diff ${lineCount(round.content)} 行`;
  }
  return `规格文档 ${lineCount(round.content)} 行`;
}

function findingsSummary(findings: ReviewFindings): string {
  const by = { critical: 0, major: 0, minor: 0 };
  for (const f of findings.findings) {
    if (f.severity in by) by[f.severity]++;
  }
  const parts: string[] = [];
  if (by.critical) parts.push(`${by.critical} critical`);
  if (by.major) parts.push(`${by.major} major`);
  if (by.minor) parts.push(`${by.minor} minor`);
  const total = findings.findings.length;
  return `${total} 条 findings${parts.length ? `（${parts.join(', ')}）` : ''}`;
}

function responseSummary(response: ReviewResponse): string {
  const by = { fix: 0, reject: 0, 'out-of-scope': 0 };
  for (const r of response.responses) {
    if (r.action in by) by[r.action]++;
  }
  const parts: string[] = [];
  if (by.fix) parts.push(`${by.fix} fixed`);
  if (by.reject) parts.push(`${by.reject} rejected`);
  if (by['out-of-scope']) parts.push(`${by['out-of-scope']} out-of-scope`);
  return parts.join(' · ') || `${response.responses.length} 条反馈`;
}

export function ReviewConversation({ task, onClose }: Props) {
  const hasReviewRecords = task.reviewMode === 'server' || (task.specReviewRound ?? 0) > 0;
  if (!hasReviewRecords) return null;
  return <ReviewConversationBody task={task} onClose={onClose} />;
}

function ReviewConversationBody({ task, onClose }: Props) {
  const navigate = useNavigate();
  const revision = `${task.specReviewRound ?? 0}:${task.reviewRound}:${task.status}:${task.phase ?? 'code'}`;
  const { rounds, loaded, error } = useReviewRounds(task.id, revision);

  function openRound(phase: TaskPhase, round: number, hash: string) {
    onClose();
    navigate(`/tasks/${encodeURIComponent(task.id)}/rounds/${phase}/${round}${hash}`);
  }

  const hasRounds = (rounds?.length ?? 0) > 0;

  return (
    <section className="mt-4" aria-label="Dev ↔ QA 评审记录">
      <div className="mb-2 text-[11px] font-normal uppercase tracking-[0.05em] text-og-500">
        Dev ↔ QA 评审记录
      </div>
      {error && <div className="text-[13px] text-danger">加载评审记录失败：{error}</div>}
      {!loaded && !error && <div className="text-[13px] text-og-400">加载评审记录…</div>}
      {loaded && !error && !hasRounds && (
        <div className="text-[13px] text-og-400">评审尚未开始</div>
      )}
      {loaded && hasRounds && (
        <div className="space-y-4">
          {(['spec', 'code'] as TaskPhase[]).map((phase) => {
            const phaseRounds = (rounds ?? [])
              .filter((r) => r.phase === phase)
              .sort((a, b) => a.round - b.round);
            if (phaseRounds.length === 0) return null;
            return (
              <div key={phase}>
                <div className="mb-1.5 text-[12px] font-medium text-og-700">{PHASE_LABEL[phase]}</div>
                <div className="space-y-3">
                  {phaseRounds.map((round) => (
                    <RoundBlock key={`${phase}-${round.round}`} round={round} onOpen={openRound} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RoundBlock({
  round,
  onOpen,
}: {
  round: ReviewRound;
  onOpen: (phase: TaskPhase, round: number, hash: string) => void;
}) {
  const isSpec = round.phase === 'spec';
  return (
    <div>
      <div className="mb-1 text-[11px] text-og-400">第 {round.round} 轮</div>
      <div className="space-y-1.5">
        <TurnRow
          role="dev"
          label={isSpec ? '提交规格稿' : '提交代码改动'}
          summary={devSummary(round)}
          onClick={() => onOpen(round.phase, round.round, '')}
        />
        {round.findings && (
          <TurnRow
            role="qa"
            label="评审"
            badge={<span className={VERDICT_CLASS[round.findings.verdict]}>{round.findings.verdict}</span>}
            summary={findingsSummary(round.findings)}
            onClick={() => onOpen(round.phase, round.round, '#review')}
          />
        )}
        {round.response && (
          <TurnRow
            role="dev"
            label="反馈"
            summary={responseSummary(round.response)}
            onClick={() => onOpen(round.phase, round.round, '#response')}
          />
        )}
      </div>
    </div>
  );
}

function TurnRow({
  role,
  label,
  summary,
  badge,
  onClick,
}: {
  role: 'dev' | 'qa';
  label: string;
  summary: string;
  badge?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:border-accent"
    >
      <span className={`pill shrink-0 ${role === 'qa' ? 'pill-review' : ''}`}>{role === 'qa' ? 'QA' : 'dev'}</span>
      <span className="shrink-0 font-medium text-og-800">{label}</span>
      {badge}
      <span className="min-w-0 flex-1 truncate text-og-500">{summary}</span>
      <span aria-hidden className="shrink-0 text-og-300">›</span>
    </button>
  );
}
