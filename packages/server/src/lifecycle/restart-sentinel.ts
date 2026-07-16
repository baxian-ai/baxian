import fs from 'node:fs';
import path from 'node:path';

export interface RestartSentinel {
  kind: 'restart';
  restartId: string;
  parentPid: number;
  createdAt: number;
  ttlMs: number;
  actor: string;
}

const SENTINEL_FILENAME = 'restart-intent.json';

function sentinelPath(stateDir: string): string {
  return path.join(stateDir, 'state', SENTINEL_FILENAME);
}

export function writeRestartSentinelSync(opts: {
  stateDir: string;
  restartId: string;
  parentPid: number;
  actor: string;
  ttlMs?: number;
}): void {
  const payload: RestartSentinel = {
    kind: 'restart',
    restartId: opts.restartId,
    parentPid: opts.parentPid,
    createdAt: Date.now(),
    ttlMs: opts.ttlMs ?? 60_000,
    actor: opts.actor,
  };
  const target = sentinelPath(opts.stateDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(payload) + '\n');
}

export function clearRestartSentinelSync(stateDir: string): void {
  const target = sentinelPath(stateDir);
  try {
    fs.unlinkSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[restart-sentinel] failed to remove ${target}:`, err);
    }
  }
}

export async function consumeRestartSentinel(
  stateDir: string,
): Promise<RestartSentinel | null> {
  const target = sentinelPath(stateDir);
  let raw: string;
  try {
    raw = await fs.promises.readFile(target, 'utf-8');
  } catch {
    return null;
  }
  await fs.promises.unlink(target).catch((err: NodeJS.ErrnoException) => {
    if (err?.code !== 'ENOENT') console.warn(`[restart-sentinel] failed to remove ${target}:`, err);
  });

  let parsed: Partial<RestartSentinel>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed.kind !== 'restart') return null;
  if (typeof parsed.restartId !== 'string') return null;
  if (typeof parsed.parentPid !== 'number') return null;
  if (typeof parsed.createdAt !== 'number') return null;
  if (typeof parsed.ttlMs !== 'number') return null;
  if (typeof parsed.actor !== 'string') return null;

  if (Date.now() - parsed.createdAt > parsed.ttlMs) return null;

  return parsed as RestartSentinel;
}
