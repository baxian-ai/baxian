import type { FastifyInstance } from 'fastify';
import type { TaskState, TaskStatus } from '../shared/index.js';
import {
  TASK_IMAGE_MAX_COUNT,
  TASK_CREATE_ROUTE_BODY_LIMIT,
  TASK_LIST_PAGE_SIZE,
  TASK_TERMINAL_STATUS_SET,
  TASK_ACTIVE_STATUS_SET,
  TASK_STATUS_SET,
} from '../shared/index.js';
import { decodeBase64Image, ImageValidationError } from '../agent/image-input.js';

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

// Numeric task-NNN order; non-conforming ids fall back to a stable string compare.
function compareTaskId(a: TaskState, b: TaskState, dir: 1 | -1): number {
  const na = taskIdNum(a.id);
  const nb = taskIdNum(b.id);
  if (Number.isNaN(na) || Number.isNaN(nb)) return a.id.localeCompare(b.id) * dir;
  return (na - nb) * dir;
}

// Recently-updated first; tolerates legacy tasks that lack updatedAt (sanitizeTask
// drops missing fields), tie-breaking on id so the order stays deterministic.
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

// Every task-list query returns at most TASK_LIST_PAGE_SIZE rows; the category /
// status filter picks the pool and its sort. Default (no filter) = open working
// set, active first.
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
  issueNumber?: number;
  images?: unknown;
}

interface UpdateTaskBody {
  title?: string;
  description?: string;
  preferredAgentId?: string;
  status?: string;
}

interface DispatchTaskBody {
  agentId?: string;
}

export async function taskRoutes(app: FastifyInstance): Promise<void> {
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

    if (body.title !== undefined && body.issueNumber !== undefined) {
      return reply.status(400).send({ error: 'title and issueNumber are mutually exclusive' });
    }

    if (body.title === undefined) {
      if (body.issueNumber !== undefined) {
        return reply
          .status(400)
          .send({ error: 'issue-bound tasks are no longer supported; use title' });
      }
      return reply.status(400).send({ error: 'title is required (manual task)' });
    }

    const titleTrimmed = typeof body.title === 'string' ? body.title.trim() : '';
    if (titleTrimmed.length < 1 || titleTrimmed.length > TITLE_MAX_LEN) {
      return reply.status(400).send({ error: `title must be 1-${TITLE_MAX_LEN} characters` });
    }
    if (/[\r\n]/.test(titleTrimmed)) {
      // Title is embedded as a single line in the prompt's <task> block.
      return reply.status(400).send({ error: 'title must be a single line (no \\r or \\n)' });
    }

    if (body.description === undefined) {
      return reply.status(400).send({ error: 'description is required' });
    }
    const descriptionTrimmed = typeof body.description === 'string' ? body.description.trim() : '';
    if (descriptionTrimmed.length < 1 || descriptionTrimmed.length > DESCRIPTION_MAX_LEN) {
      return reply
        .status(400)
        .send({ error: `description must be 1-${DESCRIPTION_MAX_LEN} characters` });
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

    // Validate + decode images in the route (the authoritative gate);
    // pass ready bytes to the manager, which persists them before any dispatch.
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

    // Return as soon as the task record exists; the agent bootstrap runs in the background so the
    // create UI isn't blocked on tens of seconds of worktree/REPL startup (the task list tracks it live).
    const task = await app.ctx.agentManager.createAndStartTask(projectIdTrimmed, {
      title: titleTrimmed,
      description: descriptionTrimmed,
      preferredAgentId: preferredAgentIdTrimmed,
      ...(branchTrimmed ? { branch: branchTrimmed } : {}),
      ...(decodedImages && decodedImages.length ? { images: decodedImages } : {}),
    }, { background: true });
    return reply.status(201).send(task);
  });

  app.post<{ Params: { id: string }; Body: DispatchTaskBody }>(
    '/tasks/:id/dispatch',
    async (request, reply) => {
      const taskId = request.params.id;
      const rawBody = request.body;
      if (rawBody !== undefined
        && (rawBody === null || typeof rawBody !== 'object' || Array.isArray(rawBody))) {
        return reply.status(400).send({ error: 'request body must be a JSON object' });
      }
      const body = rawBody ?? {};
      if (body.agentId !== undefined && typeof body.agentId !== 'string') {
        return reply.status(400).send({ error: 'agentId must be a string when provided' });
      }
      const requestedAgentId = typeof body.agentId === 'string' && body.agentId.trim() !== ''
        ? body.agentId.trim()
        : undefined;

      const result = await app.ctx.agentManager.dispatchPendingTask(taskId, requestedAgentId);
      if (result.errorCode !== undefined) {
        return reply.status(result.errorCode).send({ error: result.error });
      }
      return reply.status(200).send(result.task);
    },
  );

  app.post<{ Params: { id: string } }>('/tasks/:id/retry', async (request, reply) => {
    const fresh = await app.ctx.agentManager.retryTask(request.params.id);
    return reply.status(201).send(fresh);
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/review', async (request, reply) => {
    const updated = await app.ctx.agentManager.dispatchReviewToQa(request.params.id);
    return reply.status(202).send(updated);
  });

  // Manually finish a max_rounds task: merge its PR + run the normal post-merge cleanup.
  app.post<{ Params: { id: string } }>('/tasks/:id/complete', async (request, reply) => {
    const updated = await app.ctx.agentManager.markTaskComplete(request.params.id);
    return reply.status(202).send(updated);
  });

  // Review-round history (ReviewStore); [] when the task has no recorded rounds (unknown task / no spec or server review ran).
  app.get<{ Params: { id: string } }>('/tasks/:id/reviews', async (request, reply) => {
    const store = app.ctx.agentManager.getReviewStore();
    if (!store) return reply.send([]);
    const rounds = await store.listRounds(request.params.id);
    return reply.send(rounds);
  });

  // Manually push a max_rounds task through one more dev fix round (→ QA review).
  app.post<{ Params: { id: string } }>('/tasks/:id/continue', async (request, reply) => {
    const updated = await app.ctx.agentManager.continueDevRound(request.params.id);
    return reply.status(202).send(updated);
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
        const trimmed = typeof body.description === 'string' ? body.description.trim() : '';
        if (trimmed.length < 1 || trimmed.length > DESCRIPTION_MAX_LEN) {
          return reply
            .status(400)
            .send({ error: `description must be 1-${DESCRIPTION_MAX_LEN} characters` });
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
