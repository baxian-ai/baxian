import { computeBackoffMs } from '../timing/backoff.js';
import type { CommandRunner, ExecResult } from './runner.js';

export class ExecOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecOutcomeUnknownError';
  }
}

// Aborts a stalled HTTP(S) transfer at the git layer (curl low-speed guard);
// SSH transports ignore it and rely on the exec timeout below.
export const GIT_NET_ENV = 'GIT_HTTP_LOW_SPEED_LIMIT=1024 GIT_HTTP_LOW_SPEED_TIME=30';

export const NET_EXEC_TIMEOUT_MS = 60_000;
export const GH_EXEC_TIMEOUT_MS = 30_000;
export const CLONE_EXEC_TIMEOUT_MS = 600_000;
const NET_EXEC_RETRIES = 2;

const BACKOFF = { baseMs: 2_000, maxMs: 8_000, factor: 2, jitter: 0.2 };

const TRANSIENT_PATTERNS: RegExp[] = [
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /failed to connect/i,
  /connection (refused|reset|timed out|closed by)/i,
  /operation timed out/i,
  /operation too slow/i,
  /transfer closed with outstanding/i,
  /early EOF/i,
  /RPC failed/i,
  /the remote end hung up unexpectedly/i,
  /GnuTLS recv error/i,
  /SSL_read/i,
  /SSL_connect/i,
  /SSL_ERROR_SYSCALL/i,
  /SSL connection timeout/i,
  /TLS handshake timeout/i,
  /recv failure/i,
  /send failure/i,
  /network is unreachable/i,
  /no route to host/i,
  /kex_exchange_identification/i,
  /ssh_exchange_identification/i,
  /banner exchange/i,
  /error connecting to /i,
  /context deadline exceeded/i,
  /i\/o timeout/i,
  /HTTP 5\d\d/,
  /returned error: 5\d\d/,
  /Command timed out after/,
];

export function isTransientNetworkFailure(text: string): boolean {
  if (!text) return false;
  return TRANSIENT_PATTERNS.some((p) => p.test(text));
}

// exit 255 or transient noise on either stream: the command's outcome is unknown, not negative.
export function execOutcomeUnknown(result: Pick<ExecResult, 'exitCode' | 'stdout' | 'stderr'>): boolean {
  return result.exitCode === 255
    || isTransientNetworkFailure(result.stderr)
    || isTransientNetworkFailure(result.stdout);
}

export interface NetExecOptions {
  timeout?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let sleepImpl: (ms: number) => Promise<void> = defaultSleep;

export function __setNetExecSleepForTests(fn?: (ms: number) => Promise<void>): void {
  sleepImpl = fn ?? defaultSleep;
}

export async function execNetwork(
  runner: CommandRunner,
  command: string,
  opts: NetExecOptions = {},
): Promise<ExecResult> {
  const timeout = opts.timeout ?? NET_EXEC_TIMEOUT_MS;
  const retries = opts.retries ?? NET_EXEC_RETRIES;
  const sleep = opts.sleep ?? sleepImpl;
  const backoff = opts.random ? { ...BACKOFF, random: opts.random } : BACKOFF;

  for (let attempt = 1; ; attempt++) {
    let result: ExecResult;
    try {
      result = await runner.exec(command, { timeout });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt > retries || !isTransientNetworkFailure(message)) throw err;
      await sleep(computeBackoffMs(attempt, backoff));
      continue;
    }
    if (result.exitCode === 0) return result;
    // Check both streams independently: an unrelated stderr warning (e.g. a gh
    // update notice) must not mask a transient error reported on stdout.
    const transient = isTransientNetworkFailure(result.stderr) || isTransientNetworkFailure(result.stdout);
    if (attempt > retries || !transient) {
      return result;
    }
    await sleep(computeBackoffMs(attempt, backoff));
  }
}
