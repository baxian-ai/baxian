import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveEventRouting } from '../../src/github/resolver.js';
import { createTestContext } from '../helpers/context.js';
import type { TaskStore } from '../../src/state/task-store.js';
import type { TaskState } from '../../src/shared/index.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-resolver-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true });
});

async function seedTask(taskStore: TaskStore, t: Partial<TaskState>): Promise<void> {
  const now = new Date().toISOString();
  await taskStore.set({
    id: 'task-001',
    projectId: 'proj',
    title: 'seed',
    description: 'seed task',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    devAgentId: 'dev-1',
    phase: 'code',
    reviewRound: 0,
    status: 'in_progress',
    branch: 'bx/task-001',
    createdAt: now,
    updatedAt: now,
    ...t,
  });
}

describe('resolveEventRouting', () => {
  it('returns {} when event repo is not a configured project (fail closed)', async () => {
    const ctx = await createTestContext(tempDir);
    await seedTask(ctx.taskStore, { prNumber: 7 });

    const result = await resolveEventRouting(ctx.agentManager, {
      type: 'pr.created',
      repo: 'unrelated/other-repo',
      data: { branch: 'bx/task-001', prNumber: 7 },
    });
    expect(result).toEqual({});
  });

  it('routes a repo-identity-keyed event exactly like the legacy slug form', async () => {
    const ctx = await createTestContext(tempDir);
    await seedTask(ctx.taskStore, { id: 'task-009' });
    expect(ctx.agentManager.getProjectByRepoIdentity('github.com/user/repo')?.id).toBe('proj');
    const result = await resolveEventRouting(ctx.agentManager, {
      type: 'pr.created',
      repo: 'github.com/user/repo',
      data: { branch: 'bx/task-009' },
    });
    expect(result.taskId).toBe('task-009');
  });

  it('routes via bx/<task-id> branch when project matches', async () => {
    const ctx = await createTestContext(tempDir);
    await seedTask(ctx.taskStore, { id: 'task-007' });
    const result = await resolveEventRouting(ctx.agentManager, {
      type: 'pr.created',
      repo: 'user/repo',
      data: { branch: 'bx/task-007' },
    });
    expect(result.taskId).toBe('task-007');
    expect(result.agentId).toBe('dev-1');
  });

  it('routes via prNumber within the project', async () => {
    const ctx = await createTestContext(tempDir);
    await seedTask(ctx.taskStore, { prNumber: 99 });
    const result = await resolveEventRouting(ctx.agentManager, {
      type: 'pr.updated',
      repo: 'user/repo',
      data: { prNumber: 99 },
    });
    expect(result.taskId).toBe('task-001');
  });

  it('does not cross-route bx/<task-id> from a task in a different project', async () => {
    const ctx = await createTestContext(tempDir);
    await seedTask(ctx.taskStore, { projectId: 'other-project' });
    const result = await resolveEventRouting(ctx.agentManager, {
      type: 'pr.created',
      repo: 'user/repo',
      data: { branch: 'bx/task-001' },
    });
    expect(result).toEqual({});
  });

  it('routes via custom branch (non-bx/ prefix) when task.branch matches', async () => {
    const ctx = await createTestContext(tempDir);
    await seedTask(ctx.taskStore, { id: 'task-010', branch: 'feat/my-feature' });
    const result = await resolveEventRouting(ctx.agentManager, {
      type: 'pr.created',
      repo: 'user/repo',
      data: { branch: 'feat/my-feature' },
    });
    expect(result.taskId).toBe('task-010');
    expect(result.agentId).toBe('dev-1');
  });

  it('does not route custom branch from a different project', async () => {
    const ctx = await createTestContext(tempDir);
    await seedTask(ctx.taskStore, { id: 'task-011', branch: 'feat/other', projectId: 'other-project' });
    const result = await resolveEventRouting(ctx.agentManager, {
      type: 'pr.created',
      repo: 'user/repo',
      data: { branch: 'feat/other' },
    });
    expect(result).toEqual({});
  });

  it('prefers bx/ prefix route over custom branch fallback', async () => {
    const ctx = await createTestContext(tempDir);
    await seedTask(ctx.taskStore, { id: 'task-012', branch: 'bx/task-012' });
    const result = await resolveEventRouting(ctx.agentManager, {
      type: 'pr.created',
      repo: 'user/repo',
      data: { branch: 'bx/task-012' },
    });
    expect(result.taskId).toBe('task-012');
  });

  it('routes when project.repo is configured as a git URL (poller events carry the slug)', async () => {
    const ctx = await createTestContext(tempDir);
    await seedTask(ctx.taskStore, { id: 'task-009', branch: 'bx/task-009' });
    ctx.agentManager.replaceConfig({
      ...ctx.config,
      project: ctx.config.project.map(p => ({ ...p, repo: 'https://github.com/user/repo.git' })),
    });
    const result = await resolveEventRouting(ctx.agentManager, {
      type: 'pr.created',
      repo: 'user/repo',
      data: { branch: 'bx/task-009' },
    });
    expect(result.taskId).toBe('task-009');
    expect(result.agentId).toBe('dev-1');
  });
});
