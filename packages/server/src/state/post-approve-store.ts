import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface PostApproveCompletion {
  token: string;
  approvedHeadSha: string;
  updatedAt: string;
  // Capped by REDISPATCH_CAP in handlers.ts; over-cap escalates to intervention.
  redispatchCount?: number;
  // Set when feedback arrives mid-pass; handlers redispatch instead of auto-merging.
  pendingRedispatch?: boolean;
}

function sanitizeCompletion(raw: unknown): PostApproveCompletion | null {
  const value = (raw ?? {}) as Partial<PostApproveCompletion>;
  if (typeof value.token !== 'string' || value.token.trim() === '') return null;
  if (typeof value.approvedHeadSha !== 'string' || value.approvedHeadSha.trim() === '') return null;
  return {
    token: value.token,
    approvedHeadSha: value.approvedHeadSha,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    ...(typeof value.redispatchCount === 'number' && Number.isFinite(value.redispatchCount)
      ? { redispatchCount: value.redispatchCount }
      : {}),
    ...(value.pendingRedispatch === true ? { pendingRedispatch: true } : {}),
  };
}

export class PostApproveStore {
  private readonly memory = new Map<string, PostApproveCompletion>();

  constructor(private readonly dir?: string) {}

  async get(taskId: string): Promise<PostApproveCompletion | null> {
    if (!this.dir) return this.memory.get(taskId) ?? null;
    let content: string;
    try {
      content = await readFile(this.path(taskId), 'utf-8');
    } catch (err) {
      // ENOENT = no completion; corrupt/permission/IO errors must surface, not look "absent".
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
      throw err;
    }
    return sanitizeCompletion(JSON.parse(content));
  }

  async set(
    taskId: string,
    value: {
      token: string;
      approvedHeadSha: string;
      redispatchCount?: number;
      pendingRedispatch?: boolean;
    },
  ): Promise<void> {
    const completion: PostApproveCompletion = {
      token: value.token,
      approvedHeadSha: value.approvedHeadSha,
      updatedAt: new Date().toISOString(),
      ...(typeof value.redispatchCount === 'number' ? { redispatchCount: value.redispatchCount } : {}),
      ...(value.pendingRedispatch === true ? { pendingRedispatch: true } : {}),
    };
    if (!this.dir) {
      this.memory.set(taskId, completion);
      return;
    }
    await mkdir(this.dir, { recursive: true });
    const final = this.path(taskId);
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(completion, null, 2) + '\n');
    await rename(tmp, final);
  }

  async clear(taskId: string): Promise<void> {
    if (!this.dir) {
      this.memory.delete(taskId);
      return;
    }
    try {
      await unlink(this.path(taskId));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') throw err;
    }
  }

  async clearIfMatches(taskId: string, token: string): Promise<boolean> {
    const current = await this.get(taskId);
    if (!current || current.token !== token) return false;
    await this.clear(taskId);
    return true;
  }

  private path(taskId: string): string {
    return join(this.dir!, `${encodeURIComponent(taskId)}.json`);
  }
}
