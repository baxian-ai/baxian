import { writeFile, unlink, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class LockManager {
  constructor(private dir: string) {}

  async acquire(agentId: string, owner?: string): Promise<boolean> {
    try {
      await writeFile(
        this.path(agentId),
        JSON.stringify({ agentId, acquiredAt: new Date().toISOString(), ...(owner !== undefined ? { owner } : {}) }) + '\n',
        { flag: 'wx' },
      );
      return true;
    } catch {
      return false;
    }
  }

  async release(agentId: string): Promise<void> {
    try {
      await unlink(this.path(agentId));
    } catch { }
  }

  async isLocked(agentId: string): Promise<boolean> {
    try {
      await stat(this.path(agentId));
      return true;
    } catch {
      return false;
    }
  }

  async ownerOf(agentId: string): Promise<string | null> {
    try {
      const raw = await readFile(this.path(agentId), 'utf8');
      const parsed = JSON.parse(raw) as { owner?: unknown };
      return typeof parsed.owner === 'string' ? parsed.owner : null;
    } catch {
      return null;
    }
  }

  private path(agentId: string): string {
    return join(this.dir, `${agentId}.lock`);
  }
}
