import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { PaneTerminal } from '../components/pane-terminal.tsx';
import { useProjects } from '../hooks/use-projects.ts';
import { agentRuntimeTitle, type AgentRuntime } from '../shared/index.js';

export function Terminal() {
  const { agentId } = useParams<{ agentId: string }>();
  const { projects } = useProjects();
  const runtime = useMemo<AgentRuntime | undefined>(() => {
    if (!agentId) return undefined;
    for (const project of projects ?? []) {
      for (const group of project.agent) {
        const found = group.find(agent => agent.id === agentId);
        if (found) return found.runtime;
      }
    }
    return undefined;
  }, [agentId, projects]);

  if (!agentId) return <div className="text-[13px] text-danger">No agent specified</div>;

  return (
    <div data-testid="terminal-page-container" className="flex min-h-0 flex-1 flex-col overflow-hidden border border-hairline bg-surface">
      <div className="flex h-8 flex-none select-none items-center gap-3 border-b border-hairline bg-page px-3 font-mono text-[11px] text-og-500">
        <span aria-hidden className="block h-1.5 w-1.5 rounded-full bg-success" />
        <span className="text-og-700" title={agentRuntimeTitle(agentId, runtime)}>{agentId}</span>
      </div>
      <div className="min-h-0 flex-1">
        <PaneTerminal agentId={agentId} mode="full" interactive arrowKeys />
      </div>
    </div>
  );
}
