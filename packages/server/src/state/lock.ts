import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { assertInsideManagedDir } from './managed-path.js';
import { join } from 'node:path';

export interface AgentLockClaim {
  agentId: string;
  taskId: string;
  token: string;
  acquiredAt: string;
}

export class LockManager {
  private mutex = new Map<string, Promise<unknown>>();

  constructor(private dir: string) {}

  async acquire(agentId: string, taskId: string): Promise<string | null> {
    return this.runExclusive(agentId, async () => {
      const token = randomUUID();
      const claim: AgentLockClaim = {
        agentId,
        taskId,
        token,
        acquiredAt: new Date().toISOString(),
      };
      try {
        await writeFile(this.path(agentId), JSON.stringify(claim) + '\n', { flag: 'wx' });
        return token;
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') return null;
        throw err;
      }
    });
  }

  async releaseIfOwner(agentId: string, taskId: string, token: string): Promise<boolean> {
    return this.runExclusive(agentId, async () => {
      const claim = await this.readClaim(agentId);
      if (!claim || claim.taskId !== taskId || claim.token !== token) return false;
      try {
        await unlink(assertInsideManagedDir(this.dir, this.path(agentId)));
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
        throw err;
      }
    });
  }

  async rotateClaim(
    agentId: string,
    expected: { taskId: string; token: string } | { unbound: true },
    to: { taskId: string; token: string },
  ): Promise<boolean> {
    return this.runExclusive(agentId, async () => {
      const claim = await this.readClaim(agentId);
      if ('unbound' in expected) {
        if (claim) return false;
      } else if (!claim || claim.taskId !== expected.taskId || claim.token !== expected.token) {
        return false;
      }
      const next: AgentLockClaim = {
        agentId,
        taskId: to.taskId,
        token: to.token,
        acquiredAt: new Date().toISOString(),
      };
      const tmp = `${this.path(agentId)}.${process.pid}.rotate`;
      await writeFile(tmp, JSON.stringify(next) + '\n');
      await rename(tmp, this.path(agentId));
      return true;
    });
  }

  async isOwner(agentId: string, taskId: string, token: string): Promise<boolean> {
    const claim = await this.claimOf(agentId);
    return claim?.taskId === taskId && claim.token === token;
  }

  async runIfOwner<T>(
    agentId: string,
    taskId: string,
    token: string,
    operation: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> {
    return this.runExclusive(agentId, async () => {
      const claim = await this.readClaim(agentId);
      if (!claim || claim.taskId !== taskId || claim.token !== token) return { ran: false };
      return { ran: true, value: await operation() };
    });
  }

  async claimOf(agentId: string): Promise<AgentLockClaim | null> {
    return this.runExclusive(agentId, () => this.readClaim(agentId));
  }

  async isLocked(agentId: string): Promise<boolean> {
    try {
      await stat(this.path(agentId));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
      throw err;
    }
  }

  async ownerOf(agentId: string): Promise<string | null> {
    return (await this.claimOf(agentId))?.taskId ?? null;
  }

  async listClaims(): Promise<AgentLockClaim[]> {
    let entries;
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return [];
      throw err;
    }
    const claims: AgentLockClaim[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.lock')) continue;
      const agentId = entry.name.slice(0, -'.lock'.length);
      if (!agentId) continue;
      const claim = await this.claimOf(agentId);
      if (claim) claims.push(claim);
    }
    return claims;
  }

  private async readClaim(agentId: string): Promise<AgentLockClaim | null> {
    return this.readStoredClaim(agentId);
  }

  private async readStoredClaim(agentId: string): Promise<AgentLockClaim | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(agentId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
      throw err;
    }
    const parsed = JSON.parse(raw) as Partial<AgentLockClaim>;
    if (
      parsed.agentId !== agentId
      || typeof parsed.taskId !== 'string'
      || parsed.taskId === ''
      || typeof parsed.token !== 'string'
      || parsed.token === ''
      || typeof parsed.acquiredAt !== 'string'
    ) {
      throw new Error(`Invalid lock claim for agent ${agentId}`);
    }
    return parsed as AgentLockClaim;
  }

  private runExclusive<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutex.get(agentId) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    const settled = current.then(() => undefined, () => undefined);
    this.mutex.set(agentId, settled);
    void settled.finally(() => {
      if (this.mutex.get(agentId) === settled) this.mutex.delete(agentId);
    });
    return current;
  }

  private path(agentId: string): string {
    return join(this.dir, `${agentId}.lock`);
  }
}
