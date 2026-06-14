import { writeFile, unlink, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class LockManager {
  constructor(private dir: string) {}

  // owner: optional identity of the flow holding the lock (e.g. a taskId). Lets callers later
  // distinguish "I still hold this lock" from "someone else does" without a separate registry —
  // see ownerOf(). The file lock itself is anonymous; owner is the only ownership proof.
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
    } catch { /* ignore */ }
  }

  async isLocked(agentId: string): Promise<boolean> {
    try {
      await stat(this.path(agentId));
      return true;
    } catch {
      return false;
    }
  }

  // Returns the owner recorded at acquire time, or null when the lock is absent / unowned /
  // unreadable. Used to prove a specific flow still holds the lock (owner === expected).
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
