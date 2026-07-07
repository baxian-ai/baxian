import { describe, expect, it } from 'vitest';
import {
  CLONE_EXEC_TIMEOUT_MS,
  GH_EXEC_TIMEOUT_MS,
  GIT_NET_ENV,
  NET_EXEC_TIMEOUT_MS,
  execNetwork,
  isTransientNetworkFailure,
} from '../../src/agent/net-exec.js';
import type { CommandRunner, ExecOptions, ExecResult } from '../../src/agent/runner.js';

interface RecordedCall {
  cmd: string;
  options: ExecOptions | undefined;
}

function scriptedRunner(script: Array<ExecResult | Error>): {
  runner: CommandRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: CommandRunner = {
    async exec(cmd: string, options?: ExecOptions): Promise<ExecResult> {
      calls.push({ cmd, options });
      const next = script.shift();
      if (!next) throw new Error('scripted runner exhausted');
      if (next instanceof Error) throw next;
      return next;
    },
    async writeFile(): Promise<void> {},
    async execWithStdin(): Promise<ExecResult> {
      throw new Error('unused');
    },
  };
  return { runner, calls };
}

function sleepRecorder(): { sleep: (ms: number) => Promise<void>; slept: number[] } {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
}

const ok: ExecResult = { stdout: 'ok', stderr: '', exitCode: 0 };
const dnsFail: ExecResult = {
  stdout: '',
  stderr: "fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com",
  exitCode: 128,
};
const authFail: ExecResult = {
  stdout: '',
  stderr: 'fatal: Authentication failed for https://github.com/o/r/',
  exitCode: 128,
};

describe('isTransientNetworkFailure', () => {
  it.each([
    "fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com",
    'ssh: Could not resolve hostname github.com: Temporary failure in name resolution',
    'fatal: unable to access: Failed to connect to github.com port 443',
    'connect to host github.com port 22: Connection refused',
    'Connection reset by peer',
    'Connection timed out',
    'Connection closed by remote host',
    'error: RPC failed; curl 18 transfer closed with outstanding read data remaining',
    'fetch-pack: unexpected disconnect while reading sideband packet — early EOF',
    'fatal: the remote end hung up unexpectedly',
    'curl 28: Operation too slow. Less than 1024 bytes/sec transferred the last 30 seconds',
    'gnutls_handshake() failed: GnuTLS recv error (-54)',
    'net/http: TLS handshake timeout',
    'curl 56: Recv failure: Connection reset by peer',
    "fatal: unable to access 'https://github.com/o/r/': LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443",
    "fatal: unable to access 'https://github.com/o/r/': OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443",
    "fatal: unable to access 'https://github.com/o/r/': SSL connection timeout",
    'ssh: connect to host github.com port 22: Network is unreachable',
    'ssh: connect to host github.com port 22: No route to host',
    'kex_exchange_identification: read: Connection reset by peer',
    'error connecting to api.github.com',
    'Post "https://api.github.com/graphql": context deadline exceeded',
    'dial tcp 20.205.243.166:443: i/o timeout',
    'gh: Bad Gateway (HTTP 502)',
    'The requested URL returned error: 503',
    'Command timed out after 60000ms',
  ])('flags %j as transient', (text) => {
    expect(isTransientNetworkFailure(text)).toBe(true);
  });

  it.each([
    '',
    'fatal: Authentication failed for https://github.com/o/r/',
    'Permission denied (publickey)',
    'ERROR: Repository not found.',
    'gh: Not Found (HTTP 404)',
    'gh: Must have admin rights to Repository (HTTP 403)',
    'error: failed to push some refs (non-fast-forward)',
    'error: remote ref does not exist',
    "fatal: unable to access 'https://github.com/o/r/': SSL certificate problem: unable to get local issuer certificate",
    'Command aborted',
  ])('treats %j as non-transient', (text) => {
    expect(isTransientNetworkFailure(text)).toBe(false);
  });
});

describe('execNetwork', () => {
  it('returns a first-try success without retrying', async () => {
    const { runner, calls } = scriptedRunner([ok]);
    const result = await execNetwork(runner, 'git fetch origin');
    expect(result).toEqual(ok);
    expect(calls).toHaveLength(1);
  });

  it('applies the default network timeout when none is given', async () => {
    const { runner, calls } = scriptedRunner([ok]);
    await execNetwork(runner, 'git fetch origin');
    expect(calls[0]!.options?.timeout).toBe(NET_EXEC_TIMEOUT_MS);
  });

  it('keeps an explicitly provided timeout', async () => {
    const { runner, calls } = scriptedRunner([ok]);
    await execNetwork(runner, 'git clone --bare x y', { timeout: CLONE_EXEC_TIMEOUT_MS });
    expect(calls[0]!.options?.timeout).toBe(CLONE_EXEC_TIMEOUT_MS);
  });

  it('retries a transient failure and returns the eventual success', async () => {
    const { runner, calls } = scriptedRunner([dnsFail, ok]);
    const { sleep, slept } = sleepRecorder();
    const result = await execNetwork(runner, 'git fetch origin', { sleep });
    expect(result).toEqual(ok);
    expect(calls).toHaveLength(2);
    expect(slept).toHaveLength(1);
  });

  it('does not retry a non-transient failure', async () => {
    const { runner, calls } = scriptedRunner([authFail]);
    const { sleep, slept } = sleepRecorder();
    const result = await execNetwork(runner, 'git fetch origin', { sleep });
    expect(result).toEqual(authFail);
    expect(calls).toHaveLength(1);
    expect(slept).toHaveLength(0);
  });

  it('returns the last failure once the retry budget is exhausted', async () => {
    const { runner, calls } = scriptedRunner([dnsFail, dnsFail, dnsFail]);
    const { sleep } = sleepRecorder();
    const result = await execNetwork(runner, 'git fetch origin', { sleep });
    expect(result).toEqual(dnsFail);
    expect(calls).toHaveLength(3);
  });

  it('retries a timeout rejection and rethrows once the budget is exhausted', async () => {
    const timeoutErr = new Error('Command timed out after 60000ms');
    const { runner, calls } = scriptedRunner([timeoutErr, timeoutErr, timeoutErr]);
    const { sleep } = sleepRecorder();
    await expect(execNetwork(runner, 'git fetch origin', { sleep })).rejects.toThrow(
      /timed out/,
    );
    expect(calls).toHaveLength(3);
  });

  it('recovers when a timeout rejection is followed by a success', async () => {
    const { runner, calls } = scriptedRunner([new Error('Command timed out after 60000ms'), ok]);
    const { sleep } = sleepRecorder();
    const result = await execNetwork(runner, 'git fetch origin', { sleep });
    expect(result).toEqual(ok);
    expect(calls).toHaveLength(2);
  });

  it('does not retry a non-timeout rejection', async () => {
    const { runner, calls } = scriptedRunner([new Error('Command aborted')]);
    const { sleep } = sleepRecorder();
    await expect(execNetwork(runner, 'git fetch origin', { sleep })).rejects.toThrow(/aborted/);
    expect(calls).toHaveLength(1);
  });

  it('honors retries: 0 by returning the transient failure as-is', async () => {
    const { runner, calls } = scriptedRunner([dnsFail]);
    const { sleep, slept } = sleepRecorder();
    const result = await execNetwork(runner, 'git fetch origin', { retries: 0, sleep });
    expect(result).toEqual(dnsFail);
    expect(calls).toHaveLength(1);
    expect(slept).toHaveLength(0);
  });

  it('waits with exponential backoff between attempts', async () => {
    const { runner } = scriptedRunner([dnsFail, dnsFail, ok]);
    const { sleep, slept } = sleepRecorder();
    await execNetwork(runner, 'git fetch origin', { sleep, random: () => 0 });
    expect(slept).toEqual([2000, 4000]);
  });

  it('retries when the transient error is on stdout while stderr carries an unrelated warning', async () => {
    const noisyFail: ExecResult = {
      stdout: 'gh: Bad Gateway (HTTP 502)',
      stderr: 'A new release of gh is available: 2.40.0 → 2.41.0',
      exitCode: 1,
    };
    const { runner, calls } = scriptedRunner([noisyFail, ok]);
    const { sleep } = sleepRecorder();
    const result = await execNetwork(runner, 'gh pr view 1', { sleep });
    expect(result).toEqual(ok);
    expect(calls).toHaveLength(2);
  });

  it('does not retry when both streams carry only non-transient content', async () => {
    const noisyAuthFail: ExecResult = {
      stdout: 'gh: Not Found (HTTP 404)',
      stderr: 'A new release of gh is available: 2.40.0 → 2.41.0',
      exitCode: 1,
    };
    const { runner, calls } = scriptedRunner([noisyAuthFail]);
    const { sleep } = sleepRecorder();
    const result = await execNetwork(runner, 'gh pr view 1', { sleep });
    expect(result).toEqual(noisyAuthFail);
    expect(calls).toHaveLength(1);
  });
});

describe('constants', () => {
  it('exposes the git low-speed guard as a shell env prefix', () => {
    expect(GIT_NET_ENV).toBe('GIT_HTTP_LOW_SPEED_LIMIT=1024 GIT_HTTP_LOW_SPEED_TIME=30');
  });

  it('keeps gh timeout tighter than the git default', () => {
    expect(GH_EXEC_TIMEOUT_MS).toBeLessThan(NET_EXEC_TIMEOUT_MS);
  });
});
