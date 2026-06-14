import { writeFile, readFile, unlink } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const LOCK_FILE = '.baxian-server.lock';
const STALE_PROBE_SIGNAL = 0;

export interface ProcessLockInfo {
  pid: number;
  acquiredAt: string;
  ownerId: string;
}

export class ProcessLockError extends Error {
  constructor(message: string, public readonly existing?: ProcessLockInfo) {
    super(message);
    this.name = 'ProcessLockError';
  }
}

/** Single-instance guard. Stale locks require manual cleanup (auto-unlink races). */
export class ProcessLock {
  private acquired = false;
  private ownerId: string | null = null;
  private readonly path: string;

  constructor(stateDir: string, fileName: string = LOCK_FILE) {
    this.path = join(stateDir, fileName);
  }

  /** Returns the lock info on success; throws {@link ProcessLockError} otherwise. */
  async acquire(): Promise<ProcessLockInfo> {
    const ownerId = randomUUID();
    const info: ProcessLockInfo = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      ownerId,
    };
    const payload = `${JSON.stringify(info)}\n`;

    try {
      await writeFile(this.path, payload, { flag: 'wx' });
      this.acquired = true;
      this.ownerId = ownerId;
      return info;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw err;
    }

    const status = await this.readExistingDetailed();
    if (status.kind === 'info' && isAlive(status.info.pid)) {
      throw new ProcessLockError(
        `another baxian server appears to hold the lock at ${this.path} ` +
          `(pid=${status.info.pid}, acquiredAt=${status.info.acquiredAt}); refusing to start`,
        status.info,
      );
    }

    const detail =
      status.kind === 'info'
        ? `(prior owner pid=${status.info.pid} acquiredAt=${status.info.acquiredAt} no longer alive); `
        : status.kind === 'malformed'
          ? '(file is malformed / unreadable owner info); '
          : '(file vanished between EEXIST and re-read; another process may be racing); ';
    throw new ProcessLockError(
      `stale lock file at ${this.path} ${detail}` +
        `verify no baxian server is running and remove the file manually before retrying`,
      status.kind === 'info' ? status.info : undefined,
    );
  }

  async release(): Promise<void> {
    if (!this.acquired) return;
    const ownerId = this.ownerId;

    const status = await this.readExistingDetailed();
    if (status.kind === 'missing') {
      this.acquired = false;
      this.ownerId = null;
      return;
    }
    if (status.kind === 'malformed') {
      throw new ProcessLockError(
        `lock file at ${this.path} is malformed; cannot prove ownership, refusing to delete. ` +
          `Verify no baxian server is running and remove the file manually if appropriate.`,
      );
    }
    if (status.info.ownerId !== ownerId) {
      this.acquired = false;
      this.ownerId = null;
      throw new ProcessLockError(
        `lock at ${this.path} was replaced by a different owner ` +
          `(expected ${ownerId}, found ${status.info.ownerId} pid=${status.info.pid}); ` +
          `not deleting another process's lock`,
        status.info,
      );
    }
    try {
      await unlink(this.path);
      this.acquired = false;
      this.ownerId = null;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        this.acquired = false;
        this.ownerId = null;
        return;
      }
      throw err;
    }
  }

  // Best-effort sync release for `process.once('exit', ...)` where async fs is dropped.
  releaseSync(): void {
    if (!this.acquired) return;
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.acquired = false;
        this.ownerId = null;
      }
      return;
    }
    let parsed: Partial<ProcessLockInfo>;
    try {
      parsed = JSON.parse(raw) as Partial<ProcessLockInfo>;
    } catch {
      return;
    }
    if (typeof parsed.ownerId !== 'string' || parsed.ownerId !== this.ownerId) {
      return;
    }
    try {
      unlinkSync(this.path);
      this.acquired = false;
      this.ownerId = null;
    } catch {
      // best-effort: process is exiting anyway
    }
  }

  isAcquired(): boolean {
    return this.acquired;
  }

  getPath(): string {
    return this.path;
  }

  private async readExistingDetailed(): Promise<
    | { kind: 'missing' }
    | { kind: 'malformed' }
    | { kind: 'info'; info: ProcessLockInfo }
  > {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf-8');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return { kind: 'missing' };
      throw err;
    }
    let parsed: Partial<ProcessLockInfo>;
    try {
      parsed = JSON.parse(raw) as Partial<ProcessLockInfo>;
    } catch {
      return { kind: 'malformed' };
    }
    if (typeof parsed.pid !== 'number' || typeof parsed.acquiredAt !== 'string') {
      return { kind: 'malformed' };
    }
    return {
      kind: 'info',
      info: {
        pid: parsed.pid,
        acquiredAt: parsed.acquiredAt,
        ownerId: typeof parsed.ownerId === 'string' ? parsed.ownerId : '',
      },
    };
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, STALE_PROBE_SIGNAL);
    return true;
  } catch (err: unknown) {
    // EPERM: process exists, owned by another user.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}
