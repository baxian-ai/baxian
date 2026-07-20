import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Finding, FindingResponse, FindingSeverity, ReviewRound } from '../shared/index.js';
import { useTask } from '../hooks/use-events.ts';
import { useReviewRounds, reviewRevision } from '../hooks/use-review-rounds.ts';
import { DiffView, parseDiffFiles, type DiffExpandRequest } from '../components/diff-view.tsx';
import { MarkdownLite } from '../components/markdown-lite.tsx';
import { useInterdiff, type InterdiffUnavailableReason } from '../hooks/use-interdiff.ts';
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

const DECISION_CLASS: Record<'approve' | 'request-changes' | 'archive', string> = {
  approve: 'pill pill-live',
  'request-changes': 'pill pill-warn',
  archive: 'pill',
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
  const revision = task ? reviewRevision(task) : undefined;
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
      {data && <RoundDetail key={`${taskId}:${phase}:${roundNum}`} round={data} taskId={taskId} />}
    </div>
  );
}

function RoundDetail({ round, taskId }: { round: ReviewRound; taskId: string }) {
  const t = useT();
  const canInterdiff = round.phase === 'code' && round.round >= 2;
  const [viewMode, setViewMode] = useState<'full' | 'interdiff'>('full');
  const inter = useInterdiff(taskId, round.round, canInterdiff && viewMode === 'interdiff');
  const showInterdiff = canInterdiff && viewMode === 'interdiff' && inter.status === 'ready';
  const interdiffPending = canInterdiff && viewMode === 'interdiff' && inter.status === 'loading';
  const fullActive = !showInterdiff && !interdiffPending;

  function interdiffReasonText(reason: InterdiffUnavailableReason): string {
    if (reason === 'historical') return t.review.interdiffUnavailableHistorical;
    if (reason === 'released') return t.review.interdiffUnavailableReleased;
    return t.review.interdiffUnavailableGeneric;
  }

  const responses = round.response?.responses ?? [];
  // Pre-aggregation, each batch's finding ids are only unique within the batch; prefix
  // with the server's own b{i}- scheme so DOM anchors and gutter jumps stay unambiguous.
  const batchFindings = useMemo(
    () => (round.batchFindings ?? [])
      .filter(Boolean)
      .map((b, i) => b.findings.map((f) => ({ ...f, id: /^b\d+-/.test(f.id) ? f.id : `b${i}-${f.id}` }))),
    [round.batchFindings],
  );
  const findings = round.findings?.findings ?? [];
  const findingById = new Map(findings.map((f) => [f.id, f]));

  const sectionFiles = useMemo(
    () => new Set(parseDiffFiles(round.content).map((s) => s.file)),
    [round.content],
  );
  const diffFindings = useMemo(
    () => (round.findings?.findings ?? batchFindings.flat()),
    [round.findings, batchFindings],
  );

  const [expandReq, setExpandReq] = useState<DiffExpandRequest | undefined>();
  const [flashFinding, setFlashFinding] = useState<{ id: string; nonce: number } | null>(null);

  useEffect(() => {
    if (!flashFinding) return;
    document.getElementById(`finding-${flashFinding.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timer = setTimeout(() => setFlashFinding(null), 2000);
    return () => clearTimeout(timer);
  }, [flashFinding]);

  const jumpToDiff = (f: Finding) => {
    if (!f.file) return;
    setExpandReq((prev) => ({ file: f.file!, line: f.line, nonce: (prev?.nonce ?? 0) + 1 }));
  };
  const flashFindingCard = (id: string) => setFlashFinding((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));

  function locationEl(f: Finding) {
    const loc = findingLocation(f);
    if (!loc) return null;
    if (f.file && sectionFiles.has(f.file)) {
      return (
        <button
          type="button"
          onClick={() => jumpToDiff(f)}
          className="min-w-0 break-all font-mono text-xs text-accent hover:underline"
        >
          {loc}
        </button>
      );
    }
    return (
      <span
        title={f.file ? t.review.locationNotInDiff : undefined}
        className="min-w-0 break-all font-mono text-xs text-og-500"
      >
        {loc}
      </span>
    );
  }

  function findingCard(f: Finding) {
    return (
      <div
        key={f.id}
        id={`finding-${f.id}`}
        className={`card p-3 text-sm ${flashFinding?.id === f.id ? 'ring-2 ring-accent' : ''}`}
      >
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="font-mono text-og-400">{f.id}</span>
          <span className={SEVERITY_CLASS[f.severity]}>{f.severity}</span>
          {f.id.startsWith('u-') && <span className="pill pill-warn">{t.review.roleUser}</span>}
          {locationEl(f)}
        </div>
        <div className="text-og-800">
          <MarkdownLite text={f.message} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section id="diff">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-og-800">
            {round.phase === 'spec' ? t.review.specDraft : t.review.codeChanges}
          </h2>
          {canInterdiff && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setViewMode('full')}
                className={`btn-ghost px-2 py-0.5 text-xs ${fullActive ? 'text-accent' : ''}`}
              >
                {t.review.viewFull}
              </button>
              <button
                type="button"
                onClick={() => setViewMode('interdiff')}
                disabled={inter.status === 'unavailable'}
                title={inter.status === 'unavailable' ? interdiffReasonText(inter.reason) : undefined}
                className={`btn-ghost px-2 py-0.5 text-xs ${showInterdiff || interdiffPending ? 'text-accent' : ''}`}
              >
                {t.review.viewInterdiff}
              </button>
            </div>
          )}
        </div>
        {round.contentTruncated && fullActive && (
          <div className="mb-2 text-xs text-accent">{t.review.contentTruncated}</div>
        )}
        {round.phase === 'spec' ? (
          round.content ? (
            <div className="card p-4 text-sm text-og-800">
              <MarkdownLite text={round.content} />
            </div>
          ) : (
            <div className="text-sm text-og-400">{t.review.noContent}</div>
          )
        ) : interdiffPending ? (
          <div className="text-sm text-og-500">{t.review.interdiffLoading}</div>
        ) : showInterdiff ? (
          <DiffView content={inter.diff} />
        ) : round.content ? (
          <DiffView
            content={round.content}
            diffstat={round.diffstat}
            findings={diffFindings}
            onFindingClick={flashFindingCard}
            expandRequest={expandReq}
          />
        ) : (
          <div className="text-sm text-og-400">{t.review.noContent}</div>
        )}
      </section>

      <section id="review">
        <h2 className="mb-2 text-sm font-semibold text-og-800">{t.review.qaReviewHeading}</h2>
        {round.findings === undefined ? (
          batchFindings.length > 0 ? (
            <div className="space-y-3">
              {batchFindings.map((batch, i) => (
                <div key={i} id={`batch-${i}`} className="space-y-2">
                  <div className="text-xs text-og-500">{t.review.batchPartialHeading(i + 1)}</div>
                  {batch.length === 0
                    ? <div className="text-sm text-og-400">{t.review.noFindingsThisRound}</div>
                    : batch.map(findingCard)}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-og-400">{t.review.notSubmitted}</div>
          )
        ) : findings.length === 0 ? (
          <div className="text-sm text-og-400">{t.review.noFindingsThisRound}</div>
        ) : (
          <div className="space-y-2">{findings.map(findingCard)}</div>
        )}
      </section>

      {round.response && (
        <section id="response">
          <h2 className="mb-2 text-sm font-semibold text-og-800">{t.review.devResponsesHeading}</h2>
          {responses.length === 0 ? (
            <div className="text-sm text-og-400">{t.review.noContent}</div>
          ) : (
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
                    <div className="text-og-800">
                      <MarkdownLite text={r.rationale} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {round.userDecision && (
        <section id="user-decision">
          <h2 className="mb-2 text-sm font-semibold text-og-800">{t.review.userDecisionHeading}</h2>
          <div className="card p-3 text-sm">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className={DECISION_CLASS[round.userDecision.verdict]}>{round.userDecision.verdict}</span>
              <span className="text-xs text-og-400">{fmt(round.userDecision.at)}</span>
            </div>
            {round.userDecision.comments && (
              <div className="text-og-800">
                <MarkdownLite text={round.userDecision.comments} />
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
