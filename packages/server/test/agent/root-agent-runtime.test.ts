import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  RootAgentResponseInvalidError,
  RootAgentRuntime,
  RootAgentTerminationError,
  RootPromptNotSubmittedError,
} from '../../src/agent/root-agent-runtime.js';
import { launchCommandIn } from '../../src/agent/manager.js';
import { ExecOutcomeUnknownError } from '../../src/agent/net-exec.js';
import { LocalRunner, shellQuote, type CommandRunner } from '../../src/agent/runner.js';
import type { PaneStreamerManager } from '../../src/agent/pane-streamer-manager.js';
import { PaneGoneError, TmuxOutcomeUnknownError, type TmuxManager } from '../../src/agent/tmux.js';
import type { RootAgentConfig } from '../../src/shared/index.js';
import type { RootRecoveryRecord } from '../../src/state/root-recovery-store.js';

const ID = 'root-recovery-00000000-0000-4000-8000-000000000001';
const TOKEN = '0123456789abcdef0123456789abcdef';
const AT = '2026-07-21T01:02:03.000Z';

let tempDir: string;
let workdir: string;
let physicalWorkdir: string;
let runtime: RootAgentRuntime;
let paneStreamerManager: PaneStreamerManager;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'baxian-root-runtime-'));
  workdir = join(tempDir, 'workdir');
  await mkdir(workdir);
  physicalWorkdir = await realpath(workdir);
  paneStreamerManager = {
    ensure: vi.fn(() => ({
      subscribeAtomic: vi.fn(async () => ({ snapshot: { data: '' }, unsubscribe: vi.fn() })),
    })),
    destroy: vi.fn(async () => undefined),
  } as unknown as PaneStreamerManager;
  runtime = new RootAgentRuntime({
    config: {
      runtime: 'codex',
      mode: 'local',
      workdir,
      responseTimeoutMinutes: 15,
    },
    hosts: () => [],
    paneStreamerManager,
    runnerFactory: () => new LocalRunner(),
  });
});

afterEach(async () => {
  await runtime.stop();
  await rm(tempDir, { recursive: true });
});

function record(): RootRecoveryRecord {
  return {
    version: 1,
    id: ID,
    taskId: 'task-1',
    projectId: 'proj',
    status: 'inflight',
    attemptToken: TOKEN,
    trigger: { kind: 'runtime-stall', observedAt: AT, agentId: 'dev-1', reason: 'PENDING_IDLE' },
    guard: {
      status: 'in_progress',
      phase: 'code',
      signalToken: 'abcdef123456',
      agentId: 'dev-1',
      reviewRound: 1,
    },
    createdAt: AT,
    updatedAt: AT,
    dispatchedAt: AT,
  };
}

describe('RootAgentRuntime file mailbox', () => {
  it('moves a complete request into inbox and reads an atomically published response', async () => {
    const request = '{"version":1}\n';
    await runtime.writeRequest(record(), request);
    expect(await readFile(join(workdir, '.baxian/root-agent/inbox', `${ID}.json`), 'utf8')).toBe(request);

    expect(await runtime.readResponse(record())).toBeNull();
    const outbox = join(workdir, '.baxian/root-agent/outbox');
    const tmp = join(outbox, `${ID}.json.tmp-test`);
    const final = join(outbox, `${ID}.json`);
    const response = {
      version: 1,
      requestId: ID,
      attemptToken: TOKEN,
      decision: { action: 'no-op', reason: 'The Server has already resumed progress.' },
    };
    await writeFile(tmp, JSON.stringify(response));
    await rename(tmp, final);
    await expect(runtime.readResponse(record())).resolves.toEqual(response);

    await runtime.cleanup(record());
    await expect(readFile(join(workdir, '.baxian/root-agent/inbox', ID + '.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(final, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps existing mailbox directories and new request files private', async () => {
    const baxianDir = join(workdir, '.baxian');
    const rootDir = join(baxianDir, 'root-agent');
    const inbox = join(rootDir, 'inbox');
    const outbox = join(rootDir, 'outbox');
    await mkdir(inbox, { recursive: true });
    await mkdir(outbox);
    await Promise.all([baxianDir, rootDir, inbox, outbox].map(path => chmod(path, 0o777)));

    await runtime.writeRequest(record(), '{}\n');

    for (const path of [baxianDir, rootDir, inbox, outbox]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
    expect((await stat(join(inbox, `${ID}.json`))).mode & 0o777).toBe(0o600);
  });

  it('fails closed when mailbox chmod does not establish mode 700', async () => {
    const baxianDir = join(workdir, '.baxian');
    const rootDir = join(baxianDir, 'root-agent');
    const inbox = join(rootDir, 'inbox');
    const outbox = join(rootDir, 'outbox');
    await mkdir(inbox, { recursive: true });
    await mkdir(outbox);
    await Promise.all([baxianDir, rootDir, inbox, outbox].map(path => chmod(path, 0o755)));
    const fakeBin = join(tempDir, 'fake-bin');
    const fakeChmod = join(fakeBin, 'chmod');
    await mkdir(fakeBin);
    await writeFile(fakeChmod, '#!/bin/sh\nexit 0\n');
    await chmod(fakeChmod, 0o755);
    const local = new LocalRunner();
    const runner: CommandRunner = {
      exec: (command, options) => local.exec(
        command.startsWith('sh -c ')
          ? `PATH=${shellQuote(fakeBin)}:"$PATH" ${command}`
          : command,
        options,
      ),
      writeFile: local.writeFile.bind(local),
      execWithStdin: local.execWithStdin.bind(local),
    };
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      paneStreamerManager,
      runnerFactory: () => runner,
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /root mailbox directory is not private and owner-controlled/,
    );
    expect((await stat(inbox)).mode & 0o777).toBe(0o755);
  });

  it.each([0o775, 0o777])(
    'rejects a root Workdir with non-owner write mode %s before creating the mailbox',
    async (mode) => {
      await chmod(workdir, mode);

      await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
        /root Workdir ancestor is writable by other users/,
      );
      await expect(stat(join(workdir, '.baxian'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('rejects a root Workdir beneath a non-sticky writable ancestor', async () => {
    const sharedParent = join(tempDir, 'shared-parent');
    const nestedWorkdir = join(sharedParent, 'root-workdir');
    await mkdir(sharedParent);
    await mkdir(nestedWorkdir);
    await chmod(sharedParent, 0o777);
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex',
        mode: 'local',
        workdir: nestedWorkdir,
        responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /root Workdir ancestor is writable by other users/,
    );
    await expect(stat(join(nestedWorkdir, '.baxian'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows a root Workdir beneath a root-owned sticky writable ancestor', async () => {
    const sharedParent = join(tempDir, 'sticky-parent');
    const nestedWorkdir = join(sharedParent, 'root-workdir');
    await mkdir(sharedParent);
    await mkdir(nestedWorkdir);
    await chmod(sharedParent, 0o1777);
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex',
        mode: 'local',
        workdir: nestedWorkdir,
        responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).resolves.toBeUndefined();
    expect((await stat(join(nestedWorkdir, '.baxian'))).mode & 0o777).toBe(0o700);
  });

  it('zero-pads BSD permission bits before combining them with the sticky mode', async () => {
    const sharedParent = join(tempDir, 'sticky-parent');
    const nestedWorkdir = join(sharedParent, 'root-workdir');
    const fakeBin = join(tempDir, 'fake-bin');
    const fakeStat = join(fakeBin, 'stat');
    await mkdir(nestedWorkdir, { recursive: true });
    await mkdir(fakeBin);
    await writeFile(fakeStat, [
      '#!/bin/sh',
      '[ "$1" = "-c" ] && exit 1',
      '[ "$1" = "-f" ] || exit 1',
      '[ "$2" = "%u %Mp%03Lp" ] || exit 1',
      `if [ "$3" = ${shellQuote(sharedParent)} ]; then`,
      '  printf \'%s 1007\\n\' "$(id -u)"',
      'else',
      '  printf \'%s 0700\\n\' "$(id -u)"',
      'fi',
    ].join('\n'));
    await chmod(fakeStat, 0o755);
    const local = new LocalRunner();
    const runner: CommandRunner = {
      exec: (command, options) => local.exec(
        command.startsWith('sh -c ')
          ? `PATH=${shellQuote(fakeBin)}:"$PATH" ${command}`
          : command,
        options,
      ),
      writeFile: local.writeFile.bind(local),
      execWithStdin: local.execWithStdin.bind(local),
    };
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex',
        mode: 'local',
        workdir: nestedWorkdir,
        responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      paneStreamerManager,
      runnerFactory: () => runner,
    });

    await expect(runtime.writeRequest(record(), '{}\n')).resolves.toBeUndefined();
    expect((await stat(join(nestedWorkdir, '.baxian'))).mode & 0o777).toBe(0o700);
  });

  it('rejects an ancestor symlink introduced after physical Workdir resolution', async () => {
    const rootParent = join(tempDir, 'root-parent');
    const nestedWorkdir = join(rootParent, 'root-workdir');
    const movedParent = join(tempDir, 'root-parent-moved');
    await mkdir(rootParent);
    await mkdir(nestedWorkdir);
    const local = new LocalRunner();
    let replaced = false;
    const runner: CommandRunner = {
      exec: async (command, options) => {
        if (!replaced && command.startsWith('sh -c ')) {
          await rename(rootParent, movedParent);
          await symlink(movedParent, rootParent);
          replaced = true;
        }
        return local.exec(command, options);
      },
      writeFile: local.writeFile.bind(local),
      execWithStdin: local.execWithStdin.bind(local),
    };
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex',
        mode: 'local',
        workdir: nestedWorkdir,
        responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      paneStreamerManager,
      runnerFactory: () => runner,
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /owner-controlled canonical Workdir/,
    );
    await expect(stat(join(movedParent, 'root-workdir', '.baxian')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses a bounded metadata size probe and command deadline when reading a response', async () => {
    const local = new LocalRunner();
    const exec = vi.fn(local.exec.bind(local));
    const runner: CommandRunner = {
      exec,
      writeFile: local.writeFile.bind(local),
      execWithStdin: local.execWithStdin.bind(local),
    };
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      paneStreamerManager,
      runnerFactory: () => runner,
    });

    await runtime.writeRequest(record(), '{}\n');
    await expect(runtime.readResponse(record())).resolves.toBeNull();

    const [command, options] = exec.mock.calls.at(-1)!;
    expect(command).toContain('-size +16384c');
    expect(command).not.toContain('wc -c');
    expect(options).toEqual({ timeout: 10_000, maxBuffer: 16 * 1024 + 1 });
  });

  it.each([
    'dev agent stuck: git push failed with Connection refused',
    'QA pane shows fatal: Failed to connect to github.com port 443',
    'transient i/o timeout already retried by the server',
    'Command timed out after 30s while waiting for the REPL',
  ])('accepts a valid response whose reason contains transport wording: %s', async (reason) => {
    await runtime.writeRequest(record(), '{}\n');
    const response = {
      version: 1,
      requestId: ID,
      attemptToken: TOKEN,
      decision: { action: 'escalate', reason },
    };
    await writeFile(
      join(workdir, '.baxian/root-agent/outbox', `${ID}.json`),
      JSON.stringify(response),
    );

    await expect(runtime.readResponse(record())).resolves.toEqual(response);
  });

  it('still treats a failed response read with transient transport output as unknown', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: workdir + '\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'ssh: connection timed out', stderr: '', exitCode: 255 });
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      paneStreamerManager,
      runnerFactory: () => ({ exec, writeFile: vi.fn() }),
    });

    const read = runtime.readResponse(record());
    await expect(read).rejects.toBeInstanceOf(ExecOutcomeUnknownError);
    await expect(read).rejects.toThrow(/outcome unknown/);
  });

  it('fails closed when an outbox ancestor is replaced by a symlink', async () => {
    await runtime.writeRequest(record(), '{}\n');
    const outbox = join(workdir, '.baxian/root-agent/outbox');
    const external = join(tempDir, 'external');
    await mkdir(external);
    await writeFile(join(external, `${ID}.json`), '{"secret":"must-not-be-read"}');
    await rm(outbox, { recursive: true });
    await symlink(external, outbox);

    const read = runtime.readResponse(record());
    await expect(read).rejects.toBeInstanceOf(RootAgentResponseInvalidError);
    await expect(read).rejects.toThrow(/owner-controlled|real directories|unsafe/);
  });

  it('fails closed when the response path is a dangling symlink', async () => {
    await runtime.writeRequest(record(), '{}\n');
    const target = join(workdir, '.baxian/root-agent/outbox', `${ID}.json`);
    await symlink(join(tempDir, 'missing-response-target'), target);

    const read = runtime.readResponse(record());
    await expect(read).rejects.toBeInstanceOf(RootAgentResponseInvalidError);
    await expect(read).rejects.toThrow(/unsafe or not a regular file/);
  });

  it('rejects an oversized response instead of parsing a prefix', async () => {
    await runtime.writeRequest(record(), '{}\n');
    const target = join(workdir, '.baxian/root-agent/outbox', `${ID}.json`);
    await writeFile(target, JSON.stringify({ value: 'x'.repeat(17 * 1024) }));
    const read = runtime.readResponse(record());
    await expect(read).rejects.toBeInstanceOf(RootAgentResponseInvalidError);
    await expect(read).rejects.toThrow(/exceeds 16384 bytes/);
  });

  it('classifies a published invalid JSON response as terminal validation failure', async () => {
    await runtime.writeRequest(record(), '{}\n');
    const target = join(workdir, '.baxian/root-agent/outbox', `${ID}.json`);
    await writeFile(target, '{not-json}\n');
    const read = runtime.readResponse(record());
    await expect(read).rejects.toBeInstanceOf(RootAgentResponseInvalidError);
    await expect(read).rejects.toThrow(/invalid JSON/);
  });

  it('keeps a non-structural mailbox I/O failure outside response validation errors', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: workdir + '\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'permission denied', exitCode: 12 });
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      paneStreamerManager,
      runnerFactory: () => ({ exec, writeFile: vi.fn() }),
    });

    let failure: unknown;
    try {
      await runtime.readResponse(record());
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(RootAgentResponseInvalidError);
  });

  it('rejects different logical Workdirs that resolve to one physical directory on the same host', async () => {
    const shared = join(tempDir, 'shared-workdir');
    const rootLink = join(tempDir, 'root-link');
    const agentLink = join(tempDir, 'agent-link');
    await mkdir(shared);
    await symlink(shared, rootLink);
    await symlink(shared, agentLink);
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir: rootLink, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-1', role: 'dev', runtime: 'codex', mode: 'local', workdir: agentLink, yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /resolve to the same physical directory/,
    );
  });

  it('rejects a yolo task agent on the root mailbox OS account even with unrelated Workdirs', async () => {
    const agentWorkdir = join(tempDir, 'unrelated-agent-workdir');
    await mkdir(agentWorkdir);
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-yolo',
        role: 'dev',
        runtime: 'codex',
        mode: 'local',
        workdir: agentWorkdir,
        yolo: true,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /cannot share an OS account with yolo agent dev-yolo/,
    );
  });

  it('allows a yolo task agent only when a different remote account is explicit', async () => {
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: 'host.example.test', user: 'root', port: 22 },
        workdir,
        responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-yolo',
        role: 'dev',
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: 'host.example.test', user: 'runner', port: 22 },
        workdir,
        yolo: true,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).resolves.toBeUndefined();
  });

  it('rejects a yolo task agent on the same host and account despite a distinct SSH port', async () => {
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: 'host.example.test', user: 'runner', port: 22 },
        workdir,
        responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-yolo',
        role: 'dev',
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: 'host.example.test', user: 'runner', port: 2222 },
        workdir,
        yolo: true,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /cannot share an OS account with yolo agent dev-yolo/,
    );
  });

  it('rejects a yolo peer that SSHes back to the root local account', async () => {
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-yolo',
        role: 'dev',
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: '127.0.0.1', user: userInfo().username },
        workdir: join(tempDir, 'dev-yolo'),
        yolo: true,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /cannot share an OS account with yolo agent dev-yolo/,
    );
  });

  it('rejects a same-host addDir that resolves to the root Workdir', async () => {
    const agentWorkdir = join(tempDir, 'agent-workdir');
    const addDirLink = join(tempDir, 'root-add-dir');
    await mkdir(agentWorkdir);
    await symlink(workdir, addDirLink);
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-1', role: 'dev', runtime: 'codex', mode: 'local', workdir: agentWorkdir,
        addDirs: [addDirLink], yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /agent dev-1 addDir .*resolve to the same physical directory/,
    );
  });

  it('resolves relative addDirs from the agent Workdir before checking isolation', async () => {
    const agentWorkdir = join(tempDir, 'agent-workdir');
    await mkdir(agentWorkdir);
    await symlink(workdir, join(agentWorkdir, 'root-link'));
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-1', role: 'dev', runtime: 'claude-code', mode: 'local', workdir: agentWorkdir,
        addDirs: ['root-link'], yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /resolve to the same physical directory/,
    );
  });

  it('resolves relative parent addDirs from the physical agent Workdir', async () => {
    const safeRoot = join(tempDir, 'safe');
    const physicalAgentWorkdir = join(safeRoot, 'repo');
    const physicalRootWorkdir = join(safeRoot, 'root');
    const configuredRoot = join(tempDir, 'configured');
    const configuredAgentWorkdir = join(configuredRoot, 'agent');
    await mkdir(physicalAgentWorkdir, { recursive: true });
    await mkdir(physicalRootWorkdir);
    await mkdir(join(configuredRoot, 'root'), { recursive: true });
    await symlink(physicalAgentWorkdir, configuredAgentWorkdir);
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir: physicalRootWorkdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-1',
        role: 'dev',
        runtime: 'codex',
        mode: 'local',
        workdir: configuredAgentWorkdir,
        addDirs: ['../root'],
        yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /agent dev-1 addDir .*resolve to the same physical directory/,
    );
  });

  it('re-resolves a peer symlink before every mailbox mutation', async () => {
    const agentWorkdir = join(tempDir, 'agent-workdir');
    const safeWorkdir = join(tempDir, 'safe-workdir');
    const peerLink = join(tempDir, 'peer-link');
    await mkdir(agentWorkdir);
    await mkdir(safeWorkdir);
    await symlink(safeWorkdir, peerLink);
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-1', role: 'dev', runtime: 'codex', mode: 'local', workdir: agentWorkdir,
        addDirs: [peerLink], yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).resolves.toBeUndefined();
    await rm(peerLink);
    await symlink(workdir, peerLink);

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /resolve to the same physical directory/,
    );
  });

  it('rejects a missing addDir whose prospective path overlaps the future mailbox', async () => {
    const agentWorkdir = join(tempDir, 'agent-workdir');
    const futureMailbox = join(workdir, '.baxian', 'root-agent');
    await mkdir(agentWorkdir);
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-1', role: 'dev', runtime: 'codex', mode: 'local', workdir: agentWorkdir,
        addDirs: [futureMailbox], yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /agent dev-1 addDir .*overlap as physical directories/,
    );
    await expect(stat(futureMailbox)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a same-host addDir that physically contains the root Workdir', async () => {
    const agentWorkdir = join(tempDir, 'agent-workdir');
    await mkdir(agentWorkdir);
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-1', role: 'dev', runtime: 'codex', mode: 'local', workdir: agentWorkdir,
        addDirs: [tempDir], yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(/overlap as physical directories/);
  });

  it('rejects a same-host addDir contained by the root Workdir', async () => {
    const agentWorkdir = join(tempDir, 'agent-workdir');
    const nestedRootDir = join(workdir, 'shared');
    await mkdir(agentWorkdir);
    await mkdir(nestedRootDir);
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-1', role: 'dev', runtime: 'codex', mode: 'local', workdir: agentWorkdir,
        addDirs: [nestedRootDir], yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(/overlap as physical directories/);
  });

  it('allows unrelated same-host addDirs', async () => {
    const agentWorkdir = join(tempDir, 'agent-workdir');
    const extraDir = join(tempDir, 'extra-dir');
    await mkdir(agentWorkdir);
    await mkdir(extraDir);
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-1', role: 'dev', runtime: 'codex', mode: 'local', workdir: agentWorkdir,
        addDirs: [extraDir], yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).resolves.toBeUndefined();
  });

  it('allows a missing unrelated addDir and rechecks it when it appears', async () => {
    const agentWorkdir = join(tempDir, 'agent-workdir');
    const missingAddDir = join(tempDir, 'missing-add-dir');
    await mkdir(agentWorkdir);
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-1', role: 'dev', runtime: 'codex', mode: 'local', workdir: agentWorkdir,
        addDirs: [missingAddDir], yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).resolves.toBeUndefined();
    await symlink(workdir, missingAddDir);
    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /resolve to the same physical directory/,
    );
  });

  it('canonicalizes a prospective peer path below the filesystem root', async () => {
    const missingPeer = `/baxian-${tempDir.split('/').at(-1)}-missing`;
    const local = new LocalRunner();
    let prospectiveOutput: string | undefined;
    const runner: CommandRunner = {
      exec: async (command, options) => {
        const result = await local.exec(command, options);
        if (command.startsWith(`bx_path='${missingPeer}'`)) {
          prospectiveOutput = result.stdout.trim();
        }
        return result;
      },
      writeFile: local.writeFile.bind(local),
      execWithStdin: local.execWithStdin.bind(local),
    };
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-missing', role: 'dev', runtime: 'codex', mode: 'local',
        workdir: missingPeer, yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => runner,
    });

    await expect(runtime.writeRequest(record(), '{}\n')).resolves.toBeUndefined();
    expect(prospectiveOutput).toBe(missingPeer);
  });

  it('revalidates physical Workdir isolation after agent config changes', async () => {
    const distinct = join(tempDir, 'distinct-workdir');
    const agentLink = join(tempDir, 'agent-link');
    await mkdir(distinct);
    await symlink(workdir, agentLink);
    let agentWorkdir = distinct;
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-1', role: 'dev', runtime: 'codex', mode: 'local', workdir: agentWorkdir, yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await runtime.writeRequest(record(), '{}\n');
    agentWorkdir = agentLink;

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /resolve to the same physical directory/,
    );
  });

  it('checks the derived default agent Workdir on the root host', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: '/physical/shared\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '/physical/home\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '/physical/shared\n', stderr: '', exitCode: 0 });
    const runner = {
      exec,
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    } as CommandRunner;
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir: '/logical/root', responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{ id: 'dev-default', role: 'dev', runtime: 'codex', mode: 'local', yolo: false }],
      paneStreamerManager,
      runnerFactory: () => runner,
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /agent dev-default Workdir \/physical\/home\/\.baxian\/agents\/dev-default\/repo.*same physical directory/,
    );
  });

  it('rejects a missing derived default Workdir that would be created under root', async () => {
    const exec = vi.fn(async (command: string) => {
      if (command.includes("cd -- '/logical/root'")) {
        return { stdout: '/physical/home/.baxian\n', stderr: '', exitCode: 0 };
      }
      if (command.includes('cd --') && command.includes('pwd -P')
        && !command.includes('/physical/home/.baxian/agents/dev-default/repo')) {
        return { stdout: '/physical/home\n', stderr: '', exitCode: 0 };
      }
      if (command.startsWith("bx_path='/physical/home/.baxian/agents/dev-default/repo'")) {
        return {
          stdout: '/physical/home/.baxian/agents/dev-default/repo',
          stderr: '',
          exitCode: 0,
        };
      }
      if (command.includes('/physical/home/.baxian/agents/dev-default/repo')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const runner = {
      exec,
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    } as CommandRunner;
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir: '/logical/root', responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{ id: 'dev-default', role: 'dev', runtime: 'codex', mode: 'local', yolo: false }],
      paneStreamerManager,
      runnerFactory: () => runner,
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /agent dev-default Workdir .*overlap as physical directories/,
    );
  });

  it.each([
    ['mailbox directory', '.baxian/root-agent'],
    ['mailbox descendant', '.baxian/root-agent/agent-repo'],
    ['mailbox parent', '.baxian'],
  ])('rejects a missing explicit Workdir at the future %s', async (_label, relativePath) => {
    const futurePeer = join(workdir, relativePath);
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-future', role: 'dev', runtime: 'codex', mode: 'local',
        workdir: futurePeer, yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /agent dev-future Workdir .*overlap as physical directories/,
    );
    await expect(stat(join(workdir, '.baxian'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resolves an existing symlink ancestor of a missing explicit Workdir', async () => {
    const rootAlias = join(tempDir, 'root-alias');
    const futurePeer = join(rootAlias, '.baxian', 'root-agent', 'agent-repo');
    await symlink(workdir, rootAlias);
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-future', role: 'dev', runtime: 'codex', mode: 'local',
        workdir: futurePeer, yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /agent dev-future Workdir .*overlap as physical directories/,
    );
    await expect(stat(join(workdir, '.baxian'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats an unknown prospective Workdir probe as unknown', async () => {
    const missingPeer = join(tempDir, 'missing-peer');
    const local = new LocalRunner();
    const exec = vi.fn(async (command: string) => {
      if (command.startsWith(`bx_path='${missingPeer}'`)) {
        return { stdout: '', stderr: 'ssh: connect to host timed out', exitCode: 255 };
      }
      return local.exec(command);
    });
    const runner: CommandRunner = {
      exec,
      writeFile: local.writeFile.bind(local),
      execWithStdin: local.execWithStdin.bind(local),
    };
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-missing', role: 'dev', runtime: 'codex', mode: 'local',
        workdir: missingPeer, yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => runner,
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toBeInstanceOf(
      ExecOutcomeUnknownError,
    );
    await expect(stat(join(workdir, '.baxian'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows an absent unrelated peer Workdir but rechecks it when the directory appears', async () => {
    const missingPeer = join(tempDir, 'missing-peer');
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-missing', role: 'dev', runtime: 'codex', mode: 'local', workdir: missingPeer, yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).resolves.toBeUndefined();
    await symlink(workdir, missingPeer);
    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /resolve to the same physical directory/,
    );
  });

  it('re-resolves both present and absent peer Workdirs before each mailbox mutation', async () => {
    const resolvedPeer = join(tempDir, 'resolved-peer');
    const missingPeer = join(tempDir, 'missing-peer');
    await mkdir(resolvedPeer);
    const local = new LocalRunner();
    const exec = vi.fn(local.exec.bind(local));
    const runner: CommandRunner = {
      exec,
      writeFile: local.writeFile.bind(local),
      execWithStdin: local.execWithStdin.bind(local),
    };
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [
        { id: 'dev-resolved', role: 'dev', runtime: 'codex', mode: 'local', workdir: resolvedPeer, yolo: false },
        { id: 'dev-missing', role: 'dev', runtime: 'codex', mode: 'local', workdir: missingPeer, yolo: false },
      ],
      paneStreamerManager,
      runnerFactory: () => runner,
    });

    await runtime.writeRequest(record(), '{}\n');
    await runtime.writeRequest(record(), '{}\n');

    const probeCount = (path: string) => exec.mock.calls.filter(([command]) =>
      command.includes(`cd -- '${path}'`) && command.includes('pwd -P'),
    ).length;
    expect(probeCount(resolvedPeer)).toBe(2);
    expect(probeCount(missingPeer)).toBe(2);
  });

  it('allows the same Workdir path on a different host', async () => {
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-remote',
        role: 'dev',
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: 'example.test' },
        workdir,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.writeRequest(record(), '{}\n')).resolves.toBeUndefined();
  });

  it('treats case-only DNS hostname variants as the same isolation host', async () => {
    const exec = vi.fn(async (command: string) => {
      if (command.includes("cd -- '/logical/root'") || command.includes("cd -- '/logical/agent'")) {
        return { stdout: '/physical/shared\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const runner = {
      exec,
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    } as CommandRunner;
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex',
        mode: 'remote',
        host: 'root-host',
        workdir: '/logical/root',
        responseTimeoutMinutes: 15,
      },
      hosts: () => [
        { id: 'root-host', hostname: 'Host.EXAMPLE.com', user: 'agent' },
        { id: 'peer-host', hostname: 'host.example.com', user: 'agent' },
      ],
      agents: () => [{
        id: 'dev-remote',
        role: 'dev',
        runtime: 'codex',
        mode: 'remote',
        host: 'peer-host',
        workdir: '/logical/agent',
        yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => runner,
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /agent dev-remote Workdir .*same physical directory/,
    );
  });

  it('checks a yolo-disabled peer on the same host despite a distinct SSH port', async () => {
    const exec = vi.fn(async (command: string) => {
      if (command.includes("cd -- '/logical/root'") || command.includes("cd -- '/logical/agent'")) {
        return { stdout: '/physical/shared\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const runner = {
      exec,
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    } as CommandRunner;
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: 'host.example.com', user: 'agent', port: 22 },
        workdir: '/logical/root',
        responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-remote',
        role: 'dev',
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: 'host.example.com', user: 'agent', port: 2222 },
        workdir: '/logical/agent',
        yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => runner,
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /agent dev-remote Workdir .*same physical directory/,
    );
  });

  it('fails closed when an implicit SSH user may be the peer explicit user', async () => {
    const exec = vi.fn(async (command: string) => {
      if (command.includes("cd -- '/logical/root'") || command.includes("cd -- '/logical/agent'")) {
        return { stdout: '/physical/shared\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const runner = {
      exec,
      writeFile: vi.fn(async () => undefined),
      execWithStdin: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    } as CommandRunner;
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: 'host.example.com' },
        workdir: '/logical/root',
        responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-remote',
        role: 'dev',
        runtime: 'codex',
        mode: 'remote',
        host: { hostname: 'HOST.example.com', user: 'runner' },
        workdir: '/logical/agent',
        yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => runner,
    });

    await expect(runtime.writeRequest(record(), '{}\n')).rejects.toThrow(
      /agent dev-remote Workdir .*same physical directory/,
    );
  });

  it('treats a peer Workdir overlap during response reads as a terminal invalid response', async () => {
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex',
        mode: 'local',
        workdir,
        yolo: false,
        responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      agents: () => [{
        id: 'dev-overlap',
        role: 'dev',
        runtime: 'codex',
        mode: 'local',
        workdir,
        yolo: false,
      }],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
    });

    await expect(runtime.readResponse(record())).rejects.toBeInstanceOf(
      RootAgentResponseInvalidError,
    );
  });

  it('attempts inbox and outbox cleanup independently and reports each failed target', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: workdir + '\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 9 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'permission denied', exitCode: 10 });
    const runner = {
      exec,
      writeFile: vi.fn(async () => undefined),
    } as unknown as CommandRunner;
    runtime = new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15,
      },
      hosts: () => [],
      paneStreamerManager,
      runnerFactory: () => runner,
    });

    await expect(runtime.cleanup(record())).rejects.toThrow(
      new RegExp(`inbox/${ID}\\.json.*exit 9.*outbox/${ID}\\.json.*exit 10`),
    );
    const cleanupCommands = exec.mock.calls
      .map(call => call[0] as string)
      .filter(command => command.includes('rm -f'));
    expect(cleanupCommands).toHaveLength(2);
    expect(cleanupCommands[0]).toContain(`/inbox/${ID}.json`);
    expect(cleanupCommands[1]).toContain(`/outbox/${ID}.json`);
  });
});

describe('RootAgentRuntime tmux ownership and prompt protocol', () => {
  const ref = { sessionId: '$7', serverPid: '4242', serverStart: '1700000000' };
  const pane = { session: ref, paneId: '%1', claim: 'root-agent' };

  function rootLaunchCommand(config: Partial<RootAgentConfig> = {}): string {
    return launchCommandIn(physicalWorkdir, {
      id: 'root-agent',
      runtime: 'codex',
      mode: 'local',
      workdir,
      ...config,
    });
  }

  function runtimeWithTmux(
    tmux: TmuxManager,
    config: Partial<RootAgentConfig> = {},
  ): RootAgentRuntime {
    return new RootAgentRuntime({
      config: {
        runtime: 'codex', mode: 'local', workdir, responseTimeoutMinutes: 15, ...config,
      },
      hosts: () => [],
      paneStreamerManager,
      runnerFactory: () => new LocalRunner(),
      tmuxFactory: () => tmux,
    });
  }

  it('adopts only a claimed root-agent session and keeps the literal completion signal out of the prompt', async () => {
    const injectPrompt = vi.fn(async (_pane: unknown, _prompt: string, _agentId: string) => undefined);
    const tmux = {
      getSessionSnapshot: vi.fn(async () => ({ ref, claim: 'root-agent' })),
      getSinglePaneByRef: vi.fn(async () => pane),
      getPaneCurrentPath: vi.fn(async () => workdir),
      getSessionOptionByRef: vi.fn(async () => rootLaunchCommand()),
      setSessionOptionsIfAlive: vi.fn(async () => 'applied'),
      classifyPaneForAdopt: vi.fn(async () => ({ kind: 'live-runtime', paneCurrentCommand: 'codex' })),
      waitReplReady: vi.fn(async () => undefined),
      capturePaneSnapshot: vi.fn(async () => ({ data: '', cursorX: 0, cursorY: 0 })),
      injectPrompt,
      sendEnter: vi.fn(async () => undefined),
      waitSubmitAck: vi.fn(async () => undefined),
    } as unknown as TmuxManager;
    runtime = runtimeWithTmux(tmux);

    await runtime.start(() => undefined);
    await runtime.notify(record());

    const prompt = injectPrompt.mock.calls[0]![1] as string;
    expect(prompt).toContain('[bx:root-done:<attemptToken>]');
    expect(prompt).not.toContain(`[bx:root-done:${TOKEN}]`);
    expect(injectPrompt).toHaveBeenCalledWith(pane, expect.any(String), 'root-agent');
  });

  it('refuses to adopt a live root session launched with different permission settings', async () => {
    const tmux = {
      getSessionSnapshot: vi.fn(async () => ({ ref, claim: 'root-agent' })),
      getSinglePaneByRef: vi.fn(async () => pane),
      getPaneCurrentPath: vi.fn(async () => workdir),
      getSessionOptionByRef: vi.fn(async () => rootLaunchCommand()),
      setSessionOptionsIfAlive: vi.fn(async () => 'applied'),
      classifyPaneForAdopt: vi.fn(async () => ({ kind: 'live-runtime', paneCurrentCommand: 'codex' })),
    } as unknown as TmuxManager;
    runtime = runtimeWithTmux(tmux, { yolo: false });

    await expect(runtime.start(() => undefined)).rejects.toThrow(
      /launch configuration differs.*stop root-agent/,
    );
    expect(tmux.setSessionOptionsIfAlive).not.toHaveBeenCalled();
  });

  it('attributes a missing launch option to a legacy root session', async () => {
    const tmux = {
      getSessionSnapshot: vi.fn(async () => ({ ref, claim: 'root-agent' })),
      getSinglePaneByRef: vi.fn(async () => pane),
      getPaneCurrentPath: vi.fn(async () => workdir),
      getSessionOptionByRef: vi.fn(async () => null),
      setSessionOptionsIfAlive: vi.fn(async () => 'applied'),
      classifyPaneForAdopt: vi.fn(async () => ({ kind: 'live-runtime', paneCurrentCommand: 'codex' })),
    } as unknown as TmuxManager;
    runtime = runtimeWithTmux(tmux);

    await expect(runtime.start(() => undefined)).rejects.toThrow(
      /predates launch-command tracking.*stop root-agent once/,
    );
    expect(tmux.setSessionOptionsIfAlive).not.toHaveBeenCalled();
  });

  it('reports a startup dialog before inspecting launch configuration', async () => {
    const getSessionOptionByRef = vi.fn(async () => null);
    const tmux = {
      getSessionSnapshot: vi.fn(async () => ({ ref, claim: 'root-agent' })),
      getSinglePaneByRef: vi.fn(async () => pane),
      getPaneCurrentPath: vi.fn(async () => workdir),
      getSessionOptionByRef,
      classifyPaneForAdopt: vi.fn(async () => ({ kind: 'startup-dialog', paneCurrentCommand: 'codex' })),
    } as unknown as TmuxManager;
    runtime = runtimeWithTmux(tmux);

    await expect(runtime.start(() => undefined)).rejects.toThrow(/startup dialog.*attach and dismiss/);
    expect(getSessionOptionByRef).not.toHaveBeenCalled();
  });

  it('classifies a readiness failure before injection as definitely not submitted', async () => {
    const injectPrompt = vi.fn(async () => undefined);
    const tmux = {
      getSessionSnapshot: vi.fn(async () => ({ ref, claim: 'root-agent' })),
      getSinglePaneByRef: vi.fn(async () => pane),
      getPaneCurrentPath: vi.fn(async () => workdir),
      getSessionOptionByRef: vi.fn(async () => rootLaunchCommand()),
      setSessionOptionsIfAlive: vi.fn(async () => 'applied'),
      classifyPaneForAdopt: vi.fn(async () => ({ kind: 'live-runtime', paneCurrentCommand: 'codex' })),
      waitReplReady: vi.fn(async () => { throw new Error('repl not ready'); }),
      capturePaneSnapshot: vi.fn(),
      injectPrompt,
    } as unknown as TmuxManager;
    runtime = runtimeWithTmux(tmux);

    await expect(runtime.notify(record())).rejects.toBeInstanceOf(RootPromptNotSubmittedError);
    expect(injectPrompt).not.toHaveBeenCalled();
  });

  it('keeps an injection failure outside definitely-not-submitted errors', async () => {
    const tmux = {
      getSessionSnapshot: vi.fn(async () => ({ ref, claim: 'root-agent' })),
      getSinglePaneByRef: vi.fn(async () => pane),
      getPaneCurrentPath: vi.fn(async () => workdir),
      getSessionOptionByRef: vi.fn(async () => rootLaunchCommand()),
      setSessionOptionsIfAlive: vi.fn(async () => 'applied'),
      classifyPaneForAdopt: vi.fn(async () => ({ kind: 'live-runtime', paneCurrentCommand: 'codex' })),
      waitReplReady: vi.fn(async () => undefined),
      capturePaneSnapshot: vi.fn(async () => ({ data: '', cursorX: 0, cursorY: 0 })),
      injectPrompt: vi.fn(async () => { throw new Error('paste outcome unknown'); }),
    } as unknown as TmuxManager;
    runtime = runtimeWithTmux(tmux);

    let failure: unknown;
    try {
      await runtime.notify(record());
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(RootPromptNotSubmittedError);
  });

  it('classifies a pane identity loss during injection as definitely not submitted', async () => {
    const tmux = {
      getSessionSnapshot: vi.fn(async () => ({ ref, claim: 'root-agent' })),
      getSinglePaneByRef: vi.fn(async () => pane),
      getPaneCurrentPath: vi.fn(async () => workdir),
      getSessionOptionByRef: vi.fn(async () => rootLaunchCommand()),
      setSessionOptionsIfAlive: vi.fn(async () => 'applied'),
      classifyPaneForAdopt: vi.fn(async () => ({ kind: 'live-runtime', paneCurrentCommand: 'codex' })),
      waitReplReady: vi.fn(async () => undefined),
      capturePaneSnapshot: vi.fn(async () => ({ data: '', cursorX: 0, cursorY: 0 })),
      injectPrompt: vi.fn(async () => {
        throw new PaneGoneError('%1', 'identity condition failed before paste');
      }),
    } as unknown as TmuxManager;
    runtime = runtimeWithTmux(tmux);

    await expect(runtime.notify(record())).rejects.toBeInstanceOf(RootPromptNotSubmittedError);
  });

  it('classifies a pane identity loss before Enter as definitely not submitted', async () => {
    const tmux = {
      getSessionSnapshot: vi.fn(async () => ({ ref, claim: 'root-agent' })),
      getSinglePaneByRef: vi.fn(async () => pane),
      getPaneCurrentPath: vi.fn(async () => workdir),
      getSessionOptionByRef: vi.fn(async () => rootLaunchCommand()),
      setSessionOptionsIfAlive: vi.fn(async () => 'applied'),
      classifyPaneForAdopt: vi.fn(async () => ({ kind: 'live-runtime', paneCurrentCommand: 'codex' })),
      waitReplReady: vi.fn(async () => undefined),
      capturePaneSnapshot: vi.fn(async () => ({ data: '', cursorX: 0, cursorY: 0 })),
      injectPrompt: vi.fn(async () => undefined),
      sendEnter: vi.fn(async () => {
        throw new PaneGoneError('%1', 'identity condition failed before Enter');
      }),
    } as unknown as TmuxManager;
    runtime = runtimeWithTmux(tmux);

    await expect(runtime.notify(record())).rejects.toBeInstanceOf(RootPromptNotSubmittedError);
  });

  it('keeps a pane loss while waiting for acknowledgement as an unknown submission outcome', async () => {
    const tmux = {
      getSessionSnapshot: vi.fn(async () => ({ ref, claim: 'root-agent' })),
      getSinglePaneByRef: vi.fn(async () => pane),
      getPaneCurrentPath: vi.fn(async () => workdir),
      getSessionOptionByRef: vi.fn(async () => rootLaunchCommand()),
      setSessionOptionsIfAlive: vi.fn(async () => 'applied'),
      classifyPaneForAdopt: vi.fn(async () => ({ kind: 'live-runtime', paneCurrentCommand: 'codex' })),
      waitReplReady: vi.fn(async () => undefined),
      capturePaneSnapshot: vi.fn(async () => ({ data: '', cursorX: 0, cursorY: 0 })),
      injectPrompt: vi.fn(async () => undefined),
      sendEnter: vi.fn(async () => undefined),
      waitSubmitAck: vi.fn(async () => {
        throw new PaneGoneError('%1', 'pane vanished after Enter');
      }),
    } as unknown as TmuxManager;
    runtime = runtimeWithTmux(tmux);

    let failure: unknown;
    try {
      await runtime.notify(record());
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(PaneGoneError);
    expect(failure).not.toBeInstanceOf(RootPromptNotSubmittedError);
  });

  it('refuses a same-name tmux session without the Baxian root claim', async () => {
    const tmux = {
      getSessionSnapshot: vi.fn(async () => ({ ref, claim: 'someone-else' })),
      killSessionRef: vi.fn(),
    } as unknown as TmuxManager;
    runtime = runtimeWithTmux(tmux);

    await expect(runtime.start(() => undefined)).rejects.toThrow(/not owned by baxian/);
    await expect(runtime.isLive()).resolves.toBe(false);
    expect((tmux as unknown as { killSessionRef: ReturnType<typeof vi.fn> }).killSessionRef).not.toHaveBeenCalled();
  });

  it('creates, claims, and launches a missing root-agent session', async () => {
    const tmux = {
      getSessionSnapshot: vi.fn(async () => null),
      createSession: vi.fn(async () => ref),
      setSessionOptionsIfAlive: vi.fn(async () => 'applied'),
      setServerOption: vi.fn(async () => undefined),
      appendServerOptionIfMissing: vi.fn(async () => undefined),
      getSinglePaneByRef: vi.fn(async () => pane),
      sendKeysLiteral: vi.fn(async () => undefined),
      sendEnter: vi.fn(async () => undefined),
      handleTrustDialog: vi.fn(async () => undefined),
      waitReplReady: vi.fn(async () => undefined),
      killSessionRef: vi.fn(),
    } as unknown as TmuxManager;
    runtime = runtimeWithTmux(tmux);

    await runtime.start(() => undefined);

    expect(tmux.createSession).toHaveBeenCalledWith(
      'root-agent',
      expect.stringMatching(/\/workdir$/),
    );
    expect(tmux.setSessionOptionsIfAlive).toHaveBeenCalledWith(
      ref,
      expect.arrayContaining([
        ['@baxian-agent-id', 'root-agent'],
        ['@baxian-launch-command', rootLaunchCommand()],
      ]),
      { expectedClaim: '' },
    );
    expect(tmux.sendKeysLiteral).toHaveBeenCalledWith(pane, expect.stringContaining('codex'));
    expect(tmux.killSessionRef).not.toHaveBeenCalled();
  });

  it('terminates only the generation-bound root-agent session', async () => {
    const tmux = {
      getSessionSnapshot: vi.fn(async () => ({ ref, claim: 'root-agent' })),
      killSessionRef: vi.fn(async () => 'killed'),
    } as unknown as TmuxManager;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runtime = runtimeWithTmux(tmux);

    await expect(runtime.terminate()).resolves.toBeUndefined();
    expect(tmux.killSessionRef).toHaveBeenCalledWith(
      ref,
      { kind: 'equals', claim: 'root-agent' },
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stopped owned tmux session'));
    log.mockRestore();
  });

  it.each([null, 'someone-else'])('refuses to terminate a same-name session with claim %s', async (claim) => {
    const tmux = {
      getSessionSnapshot: vi.fn(async () => ({ ref, claim })),
      killSessionRef: vi.fn(),
    } as unknown as TmuxManager;
    runtime = runtimeWithTmux(tmux);

    let failure: unknown;
    try {
      await runtime.terminate();
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(RootAgentTerminationError);
    expect((failure as RootAgentTerminationError).message).toMatch(/not owned by baxian/);
    expect((failure as RootAgentTerminationError).hostConnectionUnknown).toBe(false);
    expect(tmux.killSessionRef).not.toHaveBeenCalled();
  });

  it('classifies a pure transient host failure as repairable', async () => {
    const tmux = {
      getSessionSnapshot: vi.fn(async () => {
        throw new TmuxOutcomeUnknownError('typed tmux outcome is uncertain');
      }),
    } as unknown as TmuxManager;
    runtime = runtimeWithTmux(tmux);

    let failure: unknown;
    try {
      await runtime.terminate();
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(RootAgentTerminationError);
    expect((failure as RootAgentTerminationError).hostConnectionUnknown).toBe(true);
  });

  it('does not infer an unknown host outcome from an untyped error message', async () => {
    const tmux = {
      getSessionSnapshot: vi.fn(async () => {
        throw new Error('tmux probe outcome unknown (transient): synthetic failure');
      }),
    } as unknown as TmuxManager;
    runtime = runtimeWithTmux(tmux);

    const failure = await runtime.terminate().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(RootAgentTerminationError);
    expect((failure as RootAgentTerminationError).hostConnectionUnknown).toBe(false);
  });

  it('keeps a mixed streamer and transient tmux failure non-repairable', async () => {
    vi.mocked(paneStreamerManager.destroy).mockRejectedValueOnce(new Error('streamer cleanup failed'));
    const tmux = {
      getSessionSnapshot: vi.fn(async () => {
        throw new TmuxOutcomeUnknownError('typed tmux outcome is uncertain');
      }),
    } as unknown as TmuxManager;
    runtime = runtimeWithTmux(tmux);

    const failure = await runtime.terminate().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(RootAgentTerminationError);
    expect((failure as RootAgentTerminationError).message).toContain('streamer cleanup failed');
    expect((failure as RootAgentTerminationError).message).toContain('typed tmux outcome is uncertain');
    expect((failure as RootAgentTerminationError).hostConnectionUnknown).toBe(false);
  });

  it.each(['killed', 'refused', 'absent'] as const)(
    'uses the generation-bound rollback credential when startup fails and cleanup reports %s',
    async (rollbackOutcome) => {
      const startupError = new Error('server option failed');
      const tmux = {
        getSessionSnapshot: vi.fn(async () => null),
        createSession: vi.fn(async () => ref),
        setSessionOptionsIfAlive: vi.fn(async () => 'applied'),
        setServerOption: vi.fn(async () => {
          throw startupError;
        }),
        killSessionRef: vi.fn(async () => rollbackOutcome),
      } as unknown as TmuxManager;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      runtime = runtimeWithTmux(tmux);

      await expect(runtime.start(() => undefined)).rejects.toBe(startupError);
      expect(tmux.killSessionRef).toHaveBeenCalledWith(
        ref,
        { kind: 'emptyOr', claim: 'root-agent' },
      );
      if (rollbackOutcome === 'killed') {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('rolled back newly created'));
      } else if (rollbackOutcome === 'refused') {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('ownership changed'));
      }
      warn.mockRestore();
    },
  );
});
