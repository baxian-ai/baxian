import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  ReviewFindings,
  ReviewPhase,
  ReviewResponse,
  ReviewRound,
  TaskState,
} from '../shared/index.js';
import { useReviewRounds, reviewRevision } from '../hooks/use-review-rounds.ts';
import { PrReviewEntry } from './pr-review-entry.tsx';
import { TurnRow } from './review-turn-row.tsx';
import { useT, type Messages } from '../i18n/index.tsx';

interface Props {
  task: TaskState;
}

const VERDICT_CLASS: Record<'approve' | 'request-changes' | 'archive', string> = {
  approve: 'pill pill-live',
  'request-changes': 'pill pill-warn',
  archive: 'pill',
};

function lineCount(content: string): number {
  if (!content) return 0;
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  return trimmed === '' ? 0 : trimmed.split('\n').length;
}

function devSummary(t: Messages, round: ReviewRound): string {
  if (round.phase === 'code') {
    const stat = (round.diffstat ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    return stat ?? t.review.diffLineCount(lineCount(round.content));
  }
  return t.review.specDocLineCount(lineCount(round.content));
}

function findingsSummary(t: Messages, findings: ReviewFindings): string {
  const by = { critical: 0, major: 0, minor: 0 };
  for (const f of findings.findings) {
    if (f.severity in by) by[f.severity]++;
  }
  const parts: string[] = [];
  if (by.critical) parts.push(`${by.critical} critical`);
  if (by.major) parts.push(`${by.major} major`);
  if (by.minor) parts.push(`${by.minor} minor`);
  const total = findings.findings.length;
  return t.review.findingsSummary(total, parts.join(', '));
}

function responseSummary(t: Messages, response: ReviewResponse): string {
  const by = { fix: 0, reject: 0, 'out-of-scope': 0 };
  for (const r of response.responses) {
    if (r.action in by) by[r.action]++;
  }
  const parts: string[] = [];
  if (by.fix) parts.push(`${by.fix} fixed`);
  if (by.reject) parts.push(`${by.reject} rejected`);
  if (by['out-of-scope']) parts.push(`${by['out-of-scope']} out-of-scope`);
  return parts.join(' · ') || t.review.responsesSummary(response.responses.length);
}

export function ReviewConversation({ task }: Props) {
  const t = useT();
  const hasRoundRecords = task.reviewMode === 'server' || (task.specReviewRound ?? 0) > 0;
  const hasPrReview = task.reviewMode !== 'server' && task.prNumber !== undefined;
  if (!hasRoundRecords && !hasPrReview) return null;
  return (
    <section className="mt-4" aria-label={t.review.sectionTitle}>
      <div className="mb-2 text-sm text-og-700">
        {t.review.sectionTitle}
      </div>
      <div className="space-y-4">
        {hasRoundRecords && <ReviewRounds task={task} />}
        {hasPrReview && <PrReviewEntry task={task} />}
      </div>
    </section>
  );
}

function ReviewRounds({ task }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const { rounds, loaded, error } = useReviewRounds(task.id, reviewRevision(task));

  function openRound(phase: ReviewPhase, round: number, hash: string) {
    navigate(`/tasks/${encodeURIComponent(task.id)}/rounds/${phase}/${round}${hash}`);
  }

  if (error) return <div className="text-sm text-accent">{t.review.loadFailed(error)}</div>;
  if (!loaded) return <div className="text-sm text-og-400">{t.review.loadingRecords}</div>;
  if ((rounds?.length ?? 0) === 0) return <div className="text-sm text-og-400">{t.review.notStarted}</div>;

  return (
    <>
      {(['spec', 'code'] as ReviewPhase[]).map((phase) => {
        const phaseRounds = (rounds ?? [])
          .filter((r) => r.phase === phase)
          .sort((a, b) => a.round - b.round);
        if (phaseRounds.length === 0) return null;
        return (
          <ReviewGroup key={phase} title={t.review.phaseLabel[phase]}>
            {phaseRounds.map((round) => (
              <RoundBlock key={`${phase}-${round.round}`} round={round} task={task} onOpen={openRound} />
            ))}
          </ReviewGroup>
        );
      })}
    </>
  );
}

function ReviewGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs text-og-700">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function RoundBlock({
  round,
  task,
  onOpen,
}: {
  round: ReviewRound;
  task: TaskState;
  onOpen: (phase: ReviewPhase, round: number, hash: string) => void;
}) {
  const t = useT();
  const isSpec = round.phase === 'spec';
  const phase = task.phase ?? 'code';
  const currentRound = phase === 'spec' ? Math.max(task.specReviewRound ?? 0, 1) : Math.max(task.reviewRound, 1);
  const isCurrent = round.phase === phase && round.round === currentRound;
  const inProgress = isCurrent
    && (task.status === 'fixing' || (task.status === 'review' && round.findings === undefined));
  const partialBatches = round.findings === undefined ? (round.batchFindings ?? []).filter(Boolean) : [];
  return (
    <div>
      <div className="mb-1 text-xs text-og-400">{t.agents.round(round.round)}</div>
      <div className="space-y-1.5">
        <TurnRow
          role="dev"
          label={isSpec ? t.review.submitSpecDraft : t.review.submitCodeChanges}
          summary={devSummary(t, round)}
          onClick={() => onOpen(round.phase, round.round, '#diff')}
        />
        {partialBatches.map((b, i) => (
          <TurnRow
            key={i}
            role="qa"
            label={t.review.batchTurn(i + 1)}
            summary={findingsSummary(t, b)}
            onClick={() => onOpen(round.phase, round.round, `#batch-${i}`)}
          />
        ))}
        {round.findings && (
          <TurnRow
            role="qa"
            label={t.review.reviewTurnLabel}
            badge={<span className={VERDICT_CLASS[round.findings.verdict]}>{round.findings.verdict}</span>}
            summary={findingsSummary(t, round.findings)}
            onClick={() => onOpen(round.phase, round.round, '#review')}
          />
        )}
        {round.response && (
          <TurnRow
            role="dev"
            label={t.review.responseTurnLabel}
            summary={responseSummary(t, round.response)}
            onClick={() => onOpen(round.phase, round.round, '#response')}
          />
        )}
        {round.userDecision && (
          <TurnRow
            role="user"
            label={round.userDecision.verdict === 'approve'
              ? t.taskDetail.specApprove
              : round.userDecision.verdict === 'archive'
                ? t.taskDetail.specArchive
                : (round.phase === 'spec' ? t.taskDetail.specReject : t.taskDetail.codeReject)}
            badge={<span className={VERDICT_CLASS[round.userDecision.verdict]}>{round.userDecision.verdict}</span>}
            summary={round.userDecision.comments ?? ''}
            onClick={() => onOpen(round.phase, round.round, '#user-decision')}
          />
        )}
        {inProgress && <InProgressRow t={t} task={task} round={round} />}
      </div>
    </div>
  );
}

function InProgressRow({ t, task, round }: { t: Messages; task: TaskState; round: ReviewRound }) {
  const findingCount = round.findings?.findings.length
    ?? (round.batchFindings ?? []).filter(Boolean).reduce((a, b) => a + b.findings.length, 0);
  const label = task.status === 'review'
    ? (task.batchTotal !== undefined
        ? t.review.reviewingBatch((task.batchIndex ?? 0) + 1, task.batchTotal)
        : t.review.reviewing)
    : t.review.fixingCount(findingCount);
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm text-og-500">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      <span>{label}</span>
    </div>
  );
}
