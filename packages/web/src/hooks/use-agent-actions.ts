import { useState } from 'react';
import { api } from '../api.ts';
import { useConfirm } from '../components/confirm-dialog.tsx';
import { useToast } from '../components/toast.tsx';
import { useT } from '../i18n/index.tsx';
import { usePendingRestart } from './use-pending-restart.tsx';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useAgentActions(projectId: string, agentIds: string[], onDeleted?: () => void) {
  const t = useT();
  const { show } = useToast();
  const confirmDialog = useConfirm();
  const { flagDirty } = usePendingRestart();
  const [compacting, setCompacting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const primaryId = agentIds[0] ?? '';
  const joinedIds = agentIds.join(' / ');
  const multiple = agentIds.length > 1;

  const collectFailures = async (call: (id: string) => Promise<unknown>): Promise<string[]> => {
    const results = await Promise.allSettled(agentIds.map(id => call(id)));
    return results.flatMap((result, index) =>
      result.status === 'rejected' ? [`${agentIds[index]}: ${errorMessage(result.reason)}`] : []);
  };

  const compact = async () => {
    setCompacting(true);
    try {
      const failures = await collectFailures(id => api.agents.compact(id));
      if (failures.length > 0) {
        show({ kind: 'error', title: t.agents.compactFailedTitle, body: failures.join('\n') });
        return;
      }
      show({
        kind: 'success',
        title: multiple ? t.agents.teamCompactSentTitle(joinedIds) : t.agents.compactSentTitle(primaryId),
      });
    } finally {
      setCompacting(false);
    }
  };

  const clear = async () => {
    const confirmed = await confirmDialog({
      title: multiple ? t.agents.teamClearConfirmTitle(joinedIds) : t.agents.clearConfirmTitle(primaryId),
      body: multiple ? t.agents.teamClearConfirmBody : t.agents.clearConfirmBody,
      confirmLabel: t.agents.clearConfirmLabel,
    });
    if (!confirmed) return;
    setClearing(true);
    try {
      const failures = await collectFailures(id => api.agents.clear(id));
      if (failures.length > 0) {
        show({ kind: 'error', title: t.agents.clearFailedTitle, body: failures.join('\n') });
        return;
      }
      show({
        kind: 'success',
        title: multiple ? t.agents.teamClearSentTitle(joinedIds) : t.agents.clearSentTitle(primaryId),
      });
    } finally {
      setClearing(false);
    }
  };

  const remove = async () => {
    const confirmed = await confirmDialog({
      title: multiple ? t.agents.teamDeleteConfirmTitle(joinedIds) : t.agents.deleteConfirmTitle(primaryId),
      body: t.agents.deleteConfirmBody,
      confirmLabel: t.common.delete,
    });
    if (!confirmed) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await api.projects.deleteAgent(projectId, primaryId);
      if (result?.restartRequired) flagDirty();
      const removed = result?.removed ?? [primaryId];
      const warningLines = [...(result?.warnings ?? [])];
      const unrequested = multiple ? [] : removed.filter(id => id !== primaryId);
      if (unrequested.length > 0) warningLines.unshift(t.agents.deletedWithTeamBody(unrequested.join(', ')));
      const title = multiple
        ? t.agents.teamDeletedTitle(joinedIds)
        : unrequested.length > 0
          ? t.agents.deletedWithTeamTitle(primaryId)
          : t.agents.deletedTitle(primaryId);
      show(warningLines.length > 0
        ? { kind: 'warn', title, body: warningLines.join('\n') }
        : { kind: 'success', title });
      onDeleted?.();
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  return {
    compact,
    clear,
    remove,
    compacting,
    clearing,
    deleting,
    deleteError,
    busy: compacting || clearing || deleting,
  };
}
