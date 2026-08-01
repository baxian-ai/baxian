import type { BaxianConfig } from '../shared/types.js';
import { repoIdentityKey } from '../shared/git-url.js';
import type { AgentManager } from '../agent/manager.js';

export interface GitBindingBlocker {
  projectId: string;
  taskIds: string[];
  lockedByProjectId?: string;
  participantIds?: string[];
}

export function gitBindingBlockerDetails(
  blockers: readonly GitBindingBlocker[],
): Array<{ path: string; message: string }> {
  return blockers.map(blocker => {
    if (blocker.participantIds !== undefined) {
      return {
        path: `project.${blocker.projectId}.agent`,
        message: `active tasks pin their participants' role and project: ${blocker.taskIds.join(', ')} (agents: ${blocker.participantIds.join(', ')})`,
      };
    }
    return blocker.lockedByProjectId === undefined
      ? {
          path: `project.${blocker.projectId}`,
          message: `active platform-bound tasks prevent identity changes: ${blocker.taskIds.join(', ')}`,
        }
      : {
          path: `project.${blocker.projectId}.repo`,
          message: `repo is locked by active tasks in project ${blocker.lockedByProjectId}: ${blocker.taskIds.join(', ')}`,
        };
  });
}

function agentSeats(config: BaxianConfig): Map<string, { projectId: string; role: string }> {
  const seats = new Map<string, { projectId: string; role: string }>();
  for (const project of config.project) {
    for (const team of project.agent) {
      for (const agent of team) seats.set(agent.id, { projectId: project.id, role: agent.role });
    }
  }
  return seats;
}

function correctSeat(
  taskProjectId: string,
  participant: { agentId: string; expectedRole?: string },
  seat: { projectId: string; role: string } | undefined,
): boolean {
  return seat !== undefined
    && seat.projectId === taskProjectId
    && (participant.expectedRole === undefined || seat.role === participant.expectedRole);
}

function sameSeat(
  left: { projectId: string; role: string } | undefined,
  right: { projectId: string; role: string } | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.projectId === right.projectId && left.role === right.role;
}

export async function activeParticipantBlockers(
  manager: AgentManager,
  current: BaxianConfig,
  next: BaxianConfig,
): Promise<GitBindingBlocker[]> {
  const before = agentSeats(current);
  const after = agentSeats(next);
  const byProject = new Map<string, { taskIds: Set<string>; participantIds: Set<string> }>();
  for (const seatRef of await manager.listActiveParticipantSeats()) {
    const broken = seatRef.participants.filter(participant =>
      !sameSeat(before.get(participant.agentId), after.get(participant.agentId))
      && !correctSeat(seatRef.projectId, participant, after.get(participant.agentId)));
    if (broken.length === 0) continue;
    const bucket = byProject.get(seatRef.projectId) ?? { taskIds: new Set<string>(), participantIds: new Set<string>() };
    bucket.taskIds.add(seatRef.taskId);
    for (const participant of broken) bucket.participantIds.add(participant.agentId);
    byProject.set(seatRef.projectId, bucket);
  }
  return [...byProject.entries()].map(([projectId, bucket]) => ({
    projectId,
    taskIds: [...bucket.taskIds],
    participantIds: [...bucket.participantIds],
  }));
}

function platformIdentity(
  config: BaxianConfig,
  projectId: string,
): { repoKey: string } | undefined {
  const project = config.project.find(p => p.id === projectId);
  if (!project) return undefined;
  return {
    repoKey: repoIdentityKey(project.repo),
  };
}

function sameIdentity(
  left: ReturnType<typeof platformIdentity>,
  right: ReturnType<typeof platformIdentity>,
): boolean {
  return left !== undefined && right !== undefined
    && left.repoKey === right.repoKey;
}

function restoresEveryBinding(
  identity: ReturnType<typeof platformIdentity>,
  tasks: Awaited<ReturnType<AgentManager['listActiveGitTasks']>>,
): boolean {
  return identity !== undefined && tasks.every(task =>
    task.platformBinding !== undefined
    && task.platformBinding.repoKey === identity.repoKey);
}

function startsOccupyingRepo(
  current: BaxianConfig,
  next: BaxianConfig,
  project: BaxianConfig['project'][number],
  repoKey: string,
): boolean {
  const previous = current.project.find(candidate => candidate.id === project.id);
  return previous === undefined
    || repoIdentityKey(previous.repo) !== repoKey;
}

export async function gitBindingBlockers(
  manager: AgentManager,
  current: BaxianConfig,
  next: BaxianConfig,
): Promise<GitBindingBlocker[]> {
  const blockers: GitBindingBlocker[] = [];
  const push = (projectId: string, taskIds: string[], lockedByProjectId?: string): void => {
    blockers.push({ projectId, taskIds: [...taskIds], ...(lockedByProjectId ? { lockedByProjectId } : {}) });
  };

  for (const project of current.project) {
    const before = platformIdentity(current, project.id);
    const after = platformIdentity(next, project.id);
    if (sameIdentity(before, after)) continue;
    const tasks = await manager.listActiveGitTasks(project.id);
    if (tasks.length === 0) continue;
    if (!restoresEveryBinding(after, tasks)) push(project.id, tasks.map(t => t.id));
  }

  const lockedByRepo = new Map<string, Map<string, string[]>>();
  for (const task of await manager.listActiveGitTasks()) {
    const key = task.platformBinding?.repoKey;
    if (key === undefined) continue;
    const owners = lockedByRepo.get(key) ?? new Map<string, string[]>();
    const taskIds = owners.get(task.projectId) ?? [];
    taskIds.push(task.id);
    owners.set(task.projectId, taskIds);
    lockedByRepo.set(key, owners);
  }
  for (const project of next.project) {
    const key = repoIdentityKey(project.repo);
    const owners = lockedByRepo.get(key);
    if (owners === undefined || owners.has(project.id)) continue;
    if (!startsOccupyingRepo(current, next, project, key)) continue;
    for (const [owner, taskIds] of [...owners].sort(([left], [right]) => left.localeCompare(right))) {
      push(project.id, taskIds, owner);
    }
  }
  return blockers;
}
