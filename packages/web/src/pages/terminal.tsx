import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PaneTerminal } from '../components/pane-terminal.tsx';
import { useProjects } from '../hooks/use-projects.ts';
import { agentRuntimeTitle } from '../shared/index.js';
import { useT } from '../i18n/index.tsx';

export function Terminal() {
  const { agentId } = useParams<{ agentId: string }>();
  const { projects } = useProjects();
  const t = useT();
  const configuredAgent = useMemo(() => {
    if (!agentId) return undefined;
    for (const project of projects ?? []) {
      for (const team of project.agent) {
        const found = team.find(agent => agent.id === agentId);
        if (found) return { runtime: found.runtime, projectId: project.id };
      }
    }
    return undefined;
  }, [agentId, projects]);

  if (!agentId) return <div className="text-sm text-accent">No agent specified</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-hairline bg-surface">
      <div className="flex h-8 flex-none select-none items-center gap-3 border-b border-hairline bg-page px-3 font-mono text-xs text-og-500">
        <span aria-hidden className="block h-1.5 w-1.5 rounded-full bg-og-1000" />
        <span className="text-og-700" title={agentRuntimeTitle(agentId, configuredAgent?.runtime)}>{agentId}</span>
        {configuredAgent && (
          <Link to={`/project/${encodeURIComponent(configuredAgent.projectId)}`} className="ml-auto text-accent">
            {t.terminal.backToProject}
          </Link>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <PaneTerminal agentId={agentId} mode="full" interactive arrowKeys />
      </div>
    </div>
  );
}
