import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import type { UntrackedFilesReport } from '../shared/index.js';
import { useT } from '../i18n/index.tsx';
import { Modal } from './modal.tsx';

function formatFileSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function UntrackedFiles({ taskId, agentId, onPendingChange }: {
  taskId: string;
  agentId: string;
  onPendingChange?: (pending: boolean) => void;
}) {
  const t = useT();
  const [report, setReport] = useState<UntrackedFilesReport | null>(null);
  const [confirmation, setConfirmation] = useState<UntrackedFilesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const inFlight = useRef(false);
  const requestSeq = useRef(0);

  useEffect(() => {
    onPendingChange?.(!!report);
    return () => onPendingChange?.(false);
  }, [report, onPendingChange]);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setNotice('');
    try {
      const next = await api.tasks.untrackedFiles(taskId, agentId);
      if (seq === requestSeq.current) setReport(next);
    } catch (err) {
      if (seq === requestSeq.current) {
        setReport(null);
        if (err instanceof ApiError && err.status === 409) setNotice(err.message);
        else setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [taskId, agentId]);

  useEffect(() => {
    setReport(null);
    setConfirmation(null);
    setError('');
    void refresh();
    return () => { requestSeq.current += 1; };
  }, [refresh]);

  const resolve = async (action: 'keep' | 'discard' | 'continue', selected: UntrackedFilesReport) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setConfirmation(null);
    try {
      await api.tasks.resolveUntrackedFiles(taskId, agentId, { action, token: selected.token });
      requestSeq.current += 1;
      setReport(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const files = (entries: UntrackedFilesReport['files']) => (
    <ul className="my-2 max-h-48 overflow-auto rounded bg-og-25 p-2 font-mono text-xs">
      {entries.map(file => (
        <li key={file.pathBase64 ?? file.path} className="flex justify-between gap-3">
          <span className="whitespace-pre-wrap break-all">{file.path}</span>
          <span className="shrink-0 text-og-500">{formatFileSize(file.size)}</span>
        </li>
      ))}
    </ul>
  );

  const hasFiles = !!report?.files.length;
  const hasConflicts = !!report?.conflicts?.length;
  if (!loading && !busy && !error && !notice && !report) return null;
  return (
    <section className="mb-2 rounded-md border border-accent/25 bg-accent-soft/60 p-3 text-sm" aria-label={t.untrackedFiles.heading}>
      {(loading || busy) && <p role="status">{busy ? t.untrackedFiles.working : t.untrackedFiles.loading}</p>}
      {notice && <p role="status">{t.untrackedFiles.unavailable} {notice}</p>}
      {error && <p role="alert" className="whitespace-pre-wrap break-words text-red-600">{error}</p>}
      {report && (
        <>
          {hasFiles && <><h3 className="font-semibold">{t.untrackedFiles.title(report.files.length)}</h3><p>{t.untrackedFiles.guidance}</p></>}
          {!hasFiles && !hasConflicts && <p>{t.untrackedFiles.readyToContinue}</p>}
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 text-xs">
            <dt>{t.untrackedFiles.agent}</dt><dd>{report.agentId}</dd>
            <dt>{t.untrackedFiles.host}</dt><dd>{report.host}</dd>
            <dt>{t.untrackedFiles.workdir}</dt><dd className="break-all">{report.workdir}</dd>
          </dl>
          {hasFiles && files(report.files)}
          {hasConflicts && <><p>{t.untrackedFiles.conflicts}</p>{files(report.conflicts!)}</>}
          {report.manualCleanupRequired && <p>{t.untrackedFiles.manualCleanup}</p>}
          {report.keepLimitExceeded && <p>{t.untrackedFiles.keepLimit}</p>}
          {report.trackedChanges && <p>{t.untrackedFiles.trackedChanges}</p>}
          {report.files.some(file => file.kind === 'directory') && <p>{t.untrackedFiles.directory}</p>}
          {hasFiles && <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={busy || loading || report.trackedChanges || report.keepLimitExceeded || hasConflicts} onClick={() => void resolve('keep', report)}>{t.untrackedFiles.keep}</button>
            <button type="button" className="btn-secondary" disabled={busy || loading || report.trackedChanges || report.manualCleanupRequired || report.files.some(file => file.kind === 'directory')} onClick={() => setConfirmation(report)}>{t.untrackedFiles.discard}</button>
          </div>}
          {!hasFiles && !hasConflicts && <button type="button" className="btn-primary mt-2" disabled={busy || loading || report.trackedChanges} onClick={() => void resolve('continue', report)}>{t.untrackedFiles.continue}</button>}
        </>
      )}
      <button type="button" className="btn-secondary mt-2" disabled={busy || loading} onClick={() => { setError(''); void refresh(); }}>{t.untrackedFiles.refresh}</button>
      <Modal open={confirmation !== null} title={t.untrackedFiles.confirmTitle} onClose={() => setConfirmation(null)} size="sm" footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => setConfirmation(null)}>{t.common.cancel}</button>
          <button type="button" className="btn-danger" disabled={busy} onClick={() => { if (confirmation) void resolve('discard', confirmation); }}>{t.untrackedFiles.discard}</button>
        </div>
      }>
        <p>{t.untrackedFiles.confirmBody}</p>
        {confirmation && files(confirmation.files)}
      </Modal>
    </section>
  );
}
