import { useEffect } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Finding, FindingResponse, FindingSeverity, ReviewRound } from '../shared/index.js';
import { useTask } from '../hooks/use-events.ts';
import { useReviewRounds } from '../hooks/use-review-rounds.ts';
import { DiffView } from '../components/diff-view.tsx';
import { useT } from '../i18n/index.tsx';

const SEVERITY_CLASS: Record<FindingSeverity, string> = {
  critical: 'pill pill-danger font-semibold',
  major: 'pill pill-warn',
  minor: 'pill',
};

const ACTION_CLASS: Record<FindingResponse['action'], string> = {
  fix: 'pill pill-live',
  reject: 'pill pill-warn',
  'out-of-scope': 'pill',
};

function fmt(ts?: string): string {
  if (!ts) return '';
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : ts;
}

function findingLocation(f: Finding): string {
  if (f.file) return f.line ? `${f.file}:${f.line}` : f.file;
  return f.location ?? '';
}

export function ReviewRoundPage() {
  const t = useT();
  const { taskId = '', phase = '', round = '' } = useParams();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const { data: task } = useTask(taskId);
  const revision = task
    ? `${task.specReviewRound ?? 0}:${task.reviewRound}:${task.status}:${task.phase ?? 'code'}`
    : undefined;
  const { rounds, loaded, error } = useReviewRounds(taskId, revision);

  const roundNum = Number(round);
  const data =
    (rounds ?? []).find((r) => r.phase === phase && r.round === roundNum) ?? null;

  useEffect(() => {
    if (!data || !hash) return;
    const el = document.getElementById(hash.replace('#', ''));
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [data, hash]);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <button type="button" onClick={() => navigate(-1)} className="btn-ghost mb-3">
        {t.common.back}
      </button>
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-og-400">{taskId}</span>
        <span className="text-sm font-semibold text-og-1000">{task?.title ?? ''}</span>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-og-500">
        <span className="pill">{phase}</span>
        <span>{t.agents.round(roundNum)}</span>
        {data?.findings && (
          <span className={data.findings.verdict === 'approve' ? 'pill pill-live' : 'pill pill-warn'}>
            {data.findings.verdict}
          </span>
        )}
        {data && (
          <span className="text-og-400">
            {fmt(data.startedAt)}
            {data.completedAt ? ` → ${fmt(data.completedAt)}` : ''}
          </span>
        )}
      </div>

      {!loaded && <div className="text-sm text-og-500">{t.common.loading}</div>}
      {loaded && error && (
        <div className="text-sm text-accent">{t.review.loadFailed(error)}</div>
      )}
      {loaded && !error && !data && (
        <div className="text-sm text-accent">{t.review.roundNotFound(phase, round)}</div>
      )}
      {data && <RoundDetail round={data} />}
    </div>
  );
}

function RoundDetail({ round }: { round: ReviewRound }) {
  const t = useT();
  const findings = round.findings?.findings ?? [];
  const responses = round.response?.responses ?? [];
  const findingById = new Map(findings.map((f) => [f.id, f]));

  return (
    <div className="space-y-6">
      <section id="diff">
        <h2 className="mb-2 text-sm font-semibold text-og-800">
          {round.phase === 'spec' ? t.review.specDraft : t.review.codeChanges}
        </h2>
        {round.contentTruncated && (
          <div className="mb-2 text-xs text-accent">{t.review.contentTruncated}</div>
        )}
        {round.content ? (
          round.phase === 'spec' ? (
            <pre className="card whitespace-pre-wrap break-words p-4 text-sm text-og-800">{round.content}</pre>
          ) : (
            <DiffView content={round.content} diffstat={round.diffstat} />
          )
        ) : (
          <div className="text-sm text-og-400">{t.review.noContent}</div>
        )}
      </section>

      <section id="review">
        <h2 className="mb-2 text-sm font-semibold text-og-800">{t.review.qaReviewHeading}</h2>
        {round.findings === undefined ? (
          <div className="text-sm text-og-400">{t.review.notSubmitted}</div>
        ) : findings.length === 0 ? (
          <div className="text-sm text-og-400">{t.review.noFindingsThisRound}</div>
        ) : (
          <div className="space-y-2">
            {findings.map((f) => (
              <div key={f.id} className="card p-3 text-sm">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-og-400">{f.id}</span>
                  <span className={SEVERITY_CLASS[f.severity]}>{f.severity}</span>
                  {findingLocation(f) && (
                    <span className="min-w-0 break-all font-mono text-xs text-og-500">{findingLocation(f)}</span>
                  )}
                </div>
                <div className="whitespace-pre-wrap break-words text-og-800">{f.message}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      {responses.length > 0 && (
        <section id="response">
          <h2 className="mb-2 text-sm font-semibold text-og-800">{t.review.devResponsesHeading}</h2>
          <div className="space-y-2">
            {responses.map((r) => {
              const f = findingById.get(r.findingId);
              return (
                <div key={r.findingId} className="card p-3 text-sm">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="font-mono text-og-400">{r.findingId}</span>
                    <span className={ACTION_CLASS[r.action]}>{r.action}</span>
                    {r.commitSha && (
                      <span className="font-mono text-xs text-og-500">{r.commitSha.slice(0, 9)}</span>
                    )}
                  </div>
                  {f && <div className="mb-1 break-words text-xs text-og-500">↳ {f.message}</div>}
                  <div className="whitespace-pre-wrap break-words text-og-800">{r.rationale}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
