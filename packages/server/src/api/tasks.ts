import type { FastifyInstance } from 'fastify';
import type { TaskState, TaskStatus, PrReviewItem } from '../shared/index.js';
import {
  TASK_IMAGE_MAX_COUNT,
  TASK_CREATE_ROUTE_BODY_LIMIT,
  TASK_LIST_PAGE_SIZE,
  TASK_TERMINAL_STATUS_SET,
  TASK_ACTIVE_STATUS_SET,
  TASK_STATUS_SET,
} from '../shared/index.js';
import { decodeBase64Image, ImageValidationError } from '../agent/image-input.js';
import { buildDriverReviewTimeline } from '../platform/review-timeline.js';
import { PrConversationCache, prReviewCacheRevision } from '../platform/pr-conversation-cache.js';
import type { TaskVerdictAction } from '../agent/manager.js';
import { ApiError } from '../errors.js';

const TITLE_MAX_LEN = 200;
const DESCRIPTION_MAX_LEN = 16_000;

interface TaskQuery {
  projectId?: string;
  category?: string;
  status?: string;
  offset?: string;
}

interface TaskPage {
  tasks: TaskState[];
  hasMore: boolean;
  nextOffset: number;
}

function taskIdNum(id: string): number {
  const match = id.match(/^task-(\d+)$/);
  return match ? parseInt(match[1], 10) : Number.NaN;
}

function compareTaskId(a: TaskState, b: TaskState, dir: 1 | -1): number {
  const na = taskIdNum(a.id);
  const nb = taskIdNum(b.id);
  if (Number.isNaN(na) || Number.isNaN(nb)) return a.id.localeCompare(b.id) * dir;
  return (na - nb) * dir;
}

function compareByUpdatedDesc(a: TaskState, b: TaskState): number {
  const cmp = (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  return cmp !== 0 ? cmp : compareTaskId(a, b, -1);
}

function paginate(pool: TaskState[], rawOffset: string | undefined): TaskPage {
  const parsed = Number.parseInt(rawOffset ?? '0', 10);
  const offset = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const page = pool.slice(offset, offset + TASK_LIST_PAGE_SIZE);
  return {
    tasks: page,
    hasMore: offset + page.length < pool.length,
    nextOffset: offset + page.length,
  };
}

function selectTaskPool(all: TaskState[], category?: string, status?: TaskStatus): TaskState[] {
  if (status) {
    return all.filter((t) => t.status === status).sort((a, b) => compareTaskId(a, b, -1));
  }
  if (category === 'done') {
    return all.filter((t) => TASK_TERMINAL_STATUS_SET.has(t.status)).sort((a, b) => compareTaskId(a, b, -1));
  }
  if (category === 'active') {
    return all.filter((t) => TASK_ACTIVE_STATUS_SET.has(t.status)).sort(compareByUpdatedDesc);
  }
  if (category === 'pending') {
    return all.filter((t) => t.status === 'pending').sort((a, b) => compareTaskId(a, b, 1));
  }
  const active = all.filter((t) => TASK_ACTIVE_STATUS_SET.has(t.status)).sort(compareByUpdatedDesc);
  const pending = all.filter((t) => t.status === 'pending').sort((a, b) => compareTaskId(a, b, 1));
  return [...active, ...pending];
}

interface CreateTaskBody {
  projectId?: string;
  title?: string;
  description?: string;
  preferredAgentId?: string;
  branch?: string;
  images?: unknown;
}

interface UpdateTaskBody {
  title?: string;
  description?: string;
  preferredAgentId?: string;
  status?: string;
}

interface AdvanceTaskBody {
  executor?: string;
  agentId?: string;
  stage?: string;
  prNumber?: number;
  confirmRevoked?: boolean;
  note?: string;
}

interface TaskVerdictBody {
  action?: string;
  comments?: string;
  note?: string;
}

const TASK_VERDICT_ACTIONS = new Set<TaskVerdictAction>([
  'approve',
  'request-changes',
  'pass',
  'continue',
  'complete',
  'confirm-merge',
]);

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  const prConversationCache = app.ctx.prConversationCache ?? new PrConversationCache();
  app.get<{ Querystring: TaskQuery }>('/tasks', async (request, reply) => {
    const projectId = typeof request.query.projectId === 'string' ? request.query.projectId.trim() : '';
    if (projectId.length === 0) {
      return reply.status(400).send({ error: 'projectId is required' });
    }

    const { category } = request.query;
    let status: TaskStatus | undefined;
    if (request.query.status !== undefined) {
      if (!TASK_STATUS_SET.has(request.query.status as TaskStatus)) {
        return reply.status(400).send({ error: `unknown status: ${request.query.status}` });
      }
      status = request.query.status as TaskStatus;
    }

    const all = await app.ctx.taskStore.list({ projectId });
    const pool = selectTaskPool(all, category, status);
    return paginate(pool, request.query.offset);
  });

  app.get<{ Params: { id: string } }>('/tasks/:id', async (request, reply) => {
    const task = await app.ctx.taskStore.get(request.params.id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }
    return task;
  });

  app.post<{ Body: CreateTaskBody }>(
    '/tasks',
    { bodyLimit: TASK_CREATE_ROUTE_BODY_LIMIT },
    async (request, reply) => {
    const body = request.body ?? {};

    if (body.title === undefined) {
      return reply.status(400).send({ error: 'title is required' });
    }

    const titleTrimmed = typeof body.title === 'string' ? body.title.trim() : '';
    if (titleTrimmed.length < 1 || titleTrimmed.length > TITLE_MAX_LEN) {
      return reply.status(400).send({ error: `title must be 1-${TITLE_MAX_LEN} characters` });
    }
    if (/[\r\n]/.test(titleTrimmed)) {
      return reply.status(400).send({ error: 'title must be a single line (no \\r or \\n)' });
    }

    if (body.description !== undefined && typeof body.description !== 'string') {
      return reply.status(400).send({ error: 'description must be a string when provided' });
    }
    const descriptionTrimmed = body.description?.trim() ?? '';
    if (descriptionTrimmed.length > DESCRIPTION_MAX_LEN) {
      return reply
        .status(400)
        .send({ error: `description must be at most ${DESCRIPTION_MAX_LEN} characters` });
    }

    if (body.preferredAgentId !== undefined && typeof body.preferredAgentId !== 'string') {
      return reply.status(400).send({ error: 'preferredAgentId must be a string when provided' });
    }
    const preferredAgentIdTrimmed = typeof body.preferredAgentId === 'string'
      ? body.preferredAgentId.trim() : '';

    const projectIdTrimmed = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    if (projectIdTrimmed.length === 0) {
      return reply.status(400).send({ error: 'projectId is required' });
    }

    const project = app.ctx.agentManager.getProjectConfig(projectIdTrimmed);
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const branchTrimmed = typeof body.branch === 'string' ? body.branch.trim() : undefined;
    if (branchTrimmed !== undefined && branchTrimmed.length === 0) {
      return reply.status(400).send({ error: 'branch must be non-empty when provided' });
    }

    await app.ctx.agentManager.validateTaskDispatch(projectIdTrimmed, {
      title: titleTrimmed,
      description: descriptionTrimmed,
      preferredAgentId: preferredAgentIdTrimmed,
    });

    let decodedImages: { bytes: Buffer; ext: string }[] | undefined;
    if (body.images !== undefined) {
      if (!Array.isArray(body.images)) {
        return reply.status(400).send({ error: 'images must be an array' });
      }
      if (body.images.length > TASK_IMAGE_MAX_COUNT) {
        return reply.status(400).send({ error: `最多 ${TASK_IMAGE_MAX_COUNT} 张图片` });
      }
      try {
        decodedImages = body.images.map((img) => {
          const data = (img as { dataBase64?: unknown } | null)?.dataBase64;
          if (typeof data !== 'string') {
            throw new ImageValidationError('each image requires a dataBase64 string');
          }
          return decodeBase64Image(data);
        });
      } catch (err) {
        if (err instanceof ImageValidationError) return reply.status(400).send({ error: err.message });
        throw err;
      }
    }

    const task = await app.ctx.agentManager.createAndStartTask(projectIdTrimmed, {
      title: titleTrimmed,
      description: descriptionTrimmed,
      preferredAgentId: preferredAgentIdTrimmed,
      ...(branchTrimmed ? { branch: branchTrimmed } : {}),
      ...(decodedImages && decodedImages.length ? { images: decodedImages } : {}),
    }, { background: true });
    return reply.status(201).send(task);
  });

  app.post<{ Params: { id: string }; Body: AdvanceTaskBody }>(
    '/tasks/:id/advance',
    async (request, reply) => {
      const taskId = request.params.id;
      const rawBody = request.body;
      if (rawBody !== undefined
        && (rawBody === null || typeof rawBody !== 'object' || Array.isArray(rawBody))) {
        return reply.status(400).send({ error: 'request body must be a JSON object' });
      }
      const body = rawBody ?? {};
      if (body.executor !== undefined && body.executor !== 'dev' && body.executor !== 'qa') {
        return reply.status(400).send({ error: 'executor must be "dev" or "qa" when provided' });
      }
      if (body.agentId !== undefined && typeof body.agentId !== 'string') {
        return reply.status(400).send({ error: 'agentId must be a string when provided' });
      }
      if (body.stage !== undefined && body.stage !== 'spec' && body.stage !== 'code') {
        return reply.status(400).send({ error: 'stage must be "spec" or "code" when provided' });
      }
      if (body.prNumber !== undefined && (!Number.isSafeInteger(body.prNumber) || body.prNumber < 1)) {
        return reply.status(400).send({ error: 'prNumber must be a positive safe integer when provided' });
      }
      if (body.confirmRevoked !== undefined && typeof body.confirmRevoked !== 'boolean') {
        return reply.status(400).send({ error: 'confirmRevoked must be a boolean when provided' });
      }
      if (body.note !== undefined && typeof body.note !== 'string') {
        return reply.status(400).send({ error: 'note must be a string when provided' });
      }
      const requestedAgentId = typeof body.agentId === 'string' && body.agentId.trim() !== ''
        ? body.agentId.trim()
        : undefined;
      const updated = await app.ctx.agentManager.advanceTask(taskId, {
        ...(body.executor !== undefined ? { executor: body.executor } : {}),
        ...(requestedAgentId !== undefined ? { agentId: requestedAgentId } : {}),
        ...(body.stage !== undefined ? { stage: body.stage } : {}),
        ...(body.prNumber !== undefined ? { prNumber: body.prNumber } : {}),
        ...(body.confirmRevoked !== undefined ? { confirmRevoked: body.confirmRevoked } : {}),
        ...(body.note?.trim() ? { note: body.note.trim() } : {}),
      });
      app.ctx.dispatchReconciler?.resetTask(taskId);
      return reply.status(202).send(updated);
    },
  );

  app.post<{ Params: { id: string } }>('/tasks/:id/retry', async (request, reply) => {
    const source = await app.ctx.agentManager.getTask(request.params.id);
    if (!source) throw new ApiError(404, 'Task not found');
    const fresh = await app.ctx.agentManager.retryTask(request.params.id);
    await app.ctx.agentManager.auditHumanTaskOperation(
      source,
      'retry',
      'retry',
      undefined,
      { replacementTaskId: fresh.id },
    );
    return reply.status(201).send(fresh);
  });

  app.post<{ Params: { id: string }; Body: TaskVerdictBody }>(
    '/tasks/:id/verdict',
    async (request, reply) => {
      const rawBody = request.body;
      if (rawBody === null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
        return reply.status(400).send({ error: 'request body must be a JSON object' });
      }
      const body = rawBody;
      if (typeof body.action !== 'string' || !TASK_VERDICT_ACTIONS.has(body.action as TaskVerdictAction)) {
        return reply.status(400).send({ error: 'action is not a supported task verdict' });
      }
      if (body.comments !== undefined && typeof body.comments !== 'string') {
        return reply.status(400).send({ error: 'comments must be a string when provided' });
      }
      if (body.note !== undefined && typeof body.note !== 'string') {
        return reply.status(400).send({ error: 'note must be a string when provided' });
      }
      const updated = await app.ctx.agentManager.submitTaskVerdict(
        request.params.id,
        body.action as TaskVerdictAction,
        body.comments,
        body.note,
      );
      return reply.status(202).send(updated);
    },
  );

  const prReviewTimeline = async (
    taskId: string,
    mode: 'get' | 'force',
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const task = await app.ctx.taskStore.get(taskId);
    if (!task) return { status: 404, body: { error: 'task not found' } };
    const empty: PrReviewItem[] = [];
    if (task.prNumber === undefined) {
      return { status: 200, body: { available: false, reason: 'no-pr', items: empty } };
    }
    const binding = task.platformBinding;
    const live = app.ctx.agentManager.getProjectConfig(task.projectId) === undefined
      ? undefined
      : app.ctx.agentManager.platformBindingFields(task.projectId).platformBinding;
    const bindingIntact = binding !== undefined && live !== undefined
      && binding.repoKey === live.repoKey;
    const driver = bindingIntact ? app.ctx.agentManager.platformDriverFor(task.projectId) : undefined;
    if (!driver || binding === undefined) {
      return { status: 200, body: { available: false, reason: 'driver-unavailable', items: empty } };
    }
    const prNumber = task.prNumber;
    const revision = prReviewCacheRevision(task, binding.repoKey);
    const build = () => buildDriverReviewTimeline(driver, prNumber);
    const timeline = mode === 'force'
      ? await prConversationCache.force(task.id, revision, build, task.reviewConversationUpdatedAt ?? '')
      : await prConversationCache.get(task.id, revision, build, task.reviewConversationUpdatedAt ?? '');
    const prClosedUnmerged = task.closedUnmergedAnchor !== undefined && task.closedUnmergedAnchor.cleared !== true;
    const autoRefresh = !TASK_TERMINAL_STATUS_SET.has(task.status) && !prClosedUnmerged;
    return {
      status: 200,
      body: {
        available: true,
        prNumber: task.prNumber,
        ...(task.prUrl ? { prUrl: task.prUrl } : {}),
        items: timeline.items,
        ...(timeline.error ? { error: timeline.error } : {}),
        ...(timeline.rateLimited ? { rateLimited: true } : {}),
        ...(timeline.truncated ? { truncated: true } : {}),
        ...(timeline.fetchedAt ? { fetchedAt: timeline.fetchedAt } : {}),
        autoRefresh,
        ...(autoRefresh ? { autoRefreshIntervalMs: app.ctx.config.server.platformPollIntervalMs } : {}),
      },
    };
  };

  app.get<{ Params: { id: string } }>('/tasks/:id/pr-review', async (request, reply) => {
    const result = await prReviewTimeline(request.params.id, 'get');
    return reply.status(result.status).send(result.body);
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/pr-review/refresh', async (request, reply) => {
    const result = await prReviewTimeline(request.params.id, 'force');
    return reply.status(result.status).send(result.body);
  });

  app.patch<{ Params: { id: string }; Body: UpdateTaskBody }>(
    '/tasks/:id',
    async (request, reply) => {
      const taskId = request.params.id;
      const body = request.body ?? {};

      if (body.status !== undefined && body.status !== 'cancelled') {
        return reply
          .status(400)
          .send({ error: "Only 'cancelled' is accepted as a status update" });
      }

      const hasEditField =
        body.title !== undefined ||
        body.description !== undefined ||
        body.preferredAgentId !== undefined;
      const hasStatus = body.status === 'cancelled';

      if (hasStatus && hasEditField) {
        return reply.status(400).send({ error: 'Cannot combine cancellation with edits' });
      }

      if (!hasStatus && !hasEditField) {
        return reply.status(400).send({ error: 'no fields to update' });
      }

      if (hasStatus) {
        const task = await app.ctx.agentManager.cancelTask(taskId);
        await app.ctx.agentManager.auditHumanTaskOperation(task, 'cancel', 'cancel');
        return reply.status(200).send(task);
      }

      const patch: { title?: string; description?: string; preferredAgentId?: string } = {};

      if (body.title !== undefined) {
        const trimmed = typeof body.title === 'string' ? body.title.trim() : '';
        if (trimmed.length < 1 || trimmed.length > TITLE_MAX_LEN) {
          return reply.status(400).send({ error: `title must be 1-${TITLE_MAX_LEN} characters` });
        }
        if (/[\r\n]/.test(trimmed)) {
          return reply.status(400).send({ error: 'title must be a single line (no \\r or \\n)' });
        }
        patch.title = trimmed;
      }

      if (body.description !== undefined) {
        if (typeof body.description !== 'string') {
          return reply.status(400).send({ error: 'description must be a string when provided' });
        }
        const trimmed = body.description.trim();
        if (trimmed.length > DESCRIPTION_MAX_LEN) {
          return reply
            .status(400)
            .send({ error: `description must be at most ${DESCRIPTION_MAX_LEN} characters` });
        }
        patch.description = trimmed;
      }

      if (body.preferredAgentId !== undefined) {
        if (typeof body.preferredAgentId !== 'string') {
          return reply.status(400).send({ error: 'preferredAgentId must be a string when provided' });
        }
        patch.preferredAgentId = body.preferredAgentId.trim();
      }

      const task = await app.ctx.agentManager.editTask(taskId, patch);
      return reply.status(200).send(task);
    },
  );
}
