import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRunner, SshRunner, shellQuote, type CommandRunner } from '../../src/agent/runner.js';
import { BranchManager } from '../../src/agent/branch.js';
import { inspectUntrackedFiles, UNTRACKED_FILES_TIMEOUT_MS } from '../../src/agent/untracked-files.js';
import { createManagerHarness } from '../helpers/manager-harness.js';
import { fakeRunner, RUNTIME_PROFILES } from '../helpers/fake-runner.js';
import { makeAgent, makeCommandRunner, makeConfig, makeTask } from '../helpers/fixtures.js';

vi.mock('node:os', async importOriginal => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, hostname: vi.fn(original.hostname) };
});

const runner = new LocalRunner();
const encodePaths = (paths: string[]) => paths.map(path => Buffer.from(path).toString('base64'));
let root: string;
let workdir: string;

async function git(args: string, directory = workdir) {
  const result = await runner.exec(`git -C ${shellQuote(directory)} ${args}`);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'baxian-untracked-'));
  workdir = join(root, 'repo');
  await mkdir(workdir);
  await git('init -q');
  await git('config user.name test');
  await git('config user.email test@example.com');
  await writeFile(join(workdir, 'tracked.txt'), 'tracked');
  await writeFile(join(workdir, '.gitignore'), 'ignored.txt\n');
  await git('add .');
  await git('commit -qm initial');
});

describe('task untracked-file recovery', () => {
  let harness: Awaited<ReturnType<typeof createManagerHarness>>;
  let terminal: ReturnType<typeof fakeRunner>;

  async function getReport(taskId = 'task-1', agentId = 'qa-1') {
    const report = await harness.manager.getUntrackedFiles(taskId, agentId);
    expect(report).not.toBeNull();
    return report!;
  }

  async function hold(taskId = 'task-1', phase = 'branch-cleanup-pending') {
    await harness.seedAgent({
      id: 'qa-1', taskId, workdir, paneId: '%2', status: 'awaiting_human',
      awaitingPhase: phase, awaitingSince: new Date().toISOString(),
    });
  }

  beforeEach(async () => {
    await git('branch -M main');
    await git('symbolic-ref refs/remotes/origin/HEAD refs/heads/main');
    terminal = fakeRunner({ agents: { 'qa-1': { paneId: '%2', process: 'codex' } } });
    const config = makeConfig({
      project: [{ id: 'proj', repo: 'https://github.com/user/repo.git', merge: null, agent: [[
        makeAgent({ workdir: join(root, 'dev-repo') }), makeAgent({ id: 'qa-1', role: 'qa', runtime: 'codex', workdir }),
      ]] }],
    });
    harness = await createManagerHarness(join(root, 'state'), {
      config, lockSeededAgents: true,
      deps: {
        cleanComposerWaitMs: 30, readyStableSpacingMs: 1, runtimeLivenessProbeMs: 1, compactIdlePollMs: 1,
        runnerFactory: () => ({
          exec: (command, options) => command.includes('tmux ') ? terminal.exec(command, options) : runner.exec(command, options),
          execWithStdin: (command, input, options) => command.startsWith('node -e ')
            ? runner.execWithStdin(command, input, options) : terminal.execWithStdin(command, input, options),
          writeFile: runner.writeFile.bind(runner),
        }),
      },
    });
    await harness.seedTask({ id: 'task-1', status: 'fixing', phase: 'code', platformBinding: undefined });
    await writeFile(join(workdir, 'notes.txt'), 'keep notes');
    await hold();
  });

  afterEach(() => { vi.mocked(hostname).mockReset(); vi.restoreAllMocks(); });

  it('does not block unrelated task updates during a slow inspection and rejects a changed task after scanning', async () => {
    let finish!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const scanning = new Promise<void>(resolve => { entered = resolve; });
    const exec = runner.execWithStdin.bind(runner);
    vi.spyOn(runner, 'execWithStdin').mockImplementation(async (command, input, options) => {
      entered();
      await pending;
      return exec(command, input, options);
    });
    await harness.seedTask({ id: 'task-2' });
    const inspection = harness.manager.getUntrackedFiles('task-1', 'qa-1');
    const outcome = expect(inspection).rejects.toMatchObject({ status: 409 });
    await scanning;
    let updated = false;
    const update = harness.manager.updateTask('task-2', { title: 'updated independently' }).then(() => { updated = true; });
    try {
      await vi.waitFor(() => expect(updated).toBe(true), { timeout: 1000 });
      await harness.manager.updateTask('task-1', { reviewRound: 9 });
    } finally { finish(); }
    await update;
    await outcome;
    expect((await harness.taskStore.get('task-2'))?.title).toBe('updated independently');
  });

  it.each(['keep', 'discard', 'continue'] as const)('does not hold the global task lock during %s confirmation scanning and rejects a changed generation', async action => {
    if (action === 'continue') await rm(join(workdir, 'notes.txt'));
    const report = await getReport();
    await harness.seedTask({ id: 'task-2' });
    let finish!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const scanning = new Promise<void>(resolve => { entered = resolve; });
    const exec = runner.execWithStdin.bind(runner);
    vi.spyOn(runner, 'execWithStdin').mockImplementation(async (command, input, options) => {
      entered();
      await blocked;
      return exec(command, input, options);
    });
    const confirmation = harness.manager.resolveUntrackedFiles('task-1', 'qa-1', action, report.token);
    const outcome = confirmation.then(() => null, (error: unknown) => error);
    await scanning;
    let updated = false;
    const update = harness.manager.updateTask('task-2', { title: 'unblocked' }).then(() => { updated = true; });
    try {
      await vi.waitFor(() => expect(updated).toBe(true), { timeout: 1000 });
      await harness.manager.updateTask('task-1', { reviewRound: 9 });
    } finally { finish(); await Promise.all([update, outcome]); }
    expect(await outcome).toMatchObject({ status: 409 });
    expect((await harness.taskStore.get('task-1'))?.retainedUntrackedFiles).toBeUndefined();
    if (action !== 'continue') expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('keep notes');
  });

  it('keeps discard verification outside the global task lock, rejects duplicate work and stops stale continuation', async () => {
    const report = await getReport();
    await harness.seedTask({ id: 'task-2' });
    let finish!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const deleting = new Promise<void>(resolve => { entered = resolve; });
    const exec = runner.execWithStdin.bind(runner);
    vi.spyOn(runner, 'execWithStdin').mockImplementation(async (command, input, options) => {
      if (JSON.parse(input.toString()).discard) { entered(); await blocked; }
      return exec(command, input, options);
    });
    const release = vi.spyOn(harness.manager, 'releaseAgentForTask');
    const confirmation = harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'discard', report.token);
    const outcome = confirmation.then(() => null, (error: unknown) => error);
    await deleting;
    let updated = false;
    const update = harness.manager.updateTask('task-2', { title: 'unblocked' }).then(() => { updated = true; });
    try {
      await vi.waitFor(() => expect(updated).toBe(true), { timeout: 1000 });
      await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'discard', report.token)).rejects.toThrow('Agent operation is in progress');
      await harness.manager.updateTask('task-1', { reviewRound: 9 });
    } finally { finish(); await Promise.all([update, outcome]); }
    expect(await outcome).toMatchObject({ message: expect.stringContaining('Listed files were discarded, but continuing the task failed: Task changed') });
    expect(release).not.toHaveBeenCalled();
    await expect(lstat(join(workdir, 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await harness.agentStore.get('qa-1'))?.status).toBe('awaiting_human');
  });

  it('rejects unsupported QA recovery before deleting or retaining any files', async () => {
    await harness.manager.updateTask('task-1', { status: 'review' });
    await hold('task-1', 'restart-redispatch-failed');
    expect(await harness.manager.getUntrackedFiles('task-1', 'qa-1')).toBeNull();
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'discard', 'a'.repeat(64))).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('keep notes');
    expect((await harness.taskStore.get('task-1'))?.retainedUntrackedFiles).toBeUndefined();
  });

  it('rejects revoked Dev continuation before handling files', async () => {
    const devWorkdir = join(root, 'dev-repo');
    await git(`clone -q ${shellQuote(workdir)} ${shellQuote(devWorkdir)}`);
    await writeFile(join(devWorkdir, 'notes.txt'), 'keep');
    await harness.manager.updateTask('task-1', {
      status: 'approved', postApproveRevoked: { generation: 'abcdef123456', reason: 'request-changes', at: new Date().toISOString() },
    });
    await harness.seedAgent({ id: 'dev-1', taskId: 'task-1', workdir: devWorkdir, status: 'awaiting_human', awaitingPhase: 'dirty-workdir' });
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'dev-1', 'discard', 'a'.repeat(64))).rejects.toThrow('Post-approval work was revoked');
    expect(await readFile(join(devWorkdir, 'notes.txt'), 'utf8')).toBe('keep');
  });

  it('accepts a local file decision after the displayed hostname changes', async () => {
    vi.mocked(hostname).mockReturnValue('qa-mac.local');
    const report = await getReport();
    expect(report.host).toBe('qa-mac.local');
    vi.mocked(hostname).mockReturnValue('qa-mac-2.local');
    expect((await getReport()).host).toBe('qa-mac-2.local');
    await harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'keep', report.token);
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('keep notes');
  });

  it('retains local files across hostname changes and manager restarts', async () => {
    vi.mocked(hostname).mockReturnValue('qa-mac.local');
    const report = await getReport();
    await harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'keep', report.token);
    vi.mocked(hostname).mockReturnValue('qa-mac-2.local');
    harness.manager = harness.createManager();
    await hold();
    const retry = await getReport();
    expect(retry.host).toBe('qa-mac-2.local');
    expect(retry.files).toEqual([]);
    await harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'continue', retry.token);
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('keep notes');
  });

  it.each([{ hostname: 'second.example' }, { user: 'other' }, { port: 22 }, { port: 2222 }])('does not reuse a remote host retention choice after SSH destination configuration changes: %j', async changedHost => {
    const remoteConfig = makeConfig({
      host: [{ id: 'box', hostname: 'first.example', user: 'qa' }],
      project: [{ id: 'proj', repo: 'https://github.com/user/repo.git', merge: null, agent: [[
        makeAgent({ workdir: join(root, 'dev-repo') }),
        makeAgent({ id: 'qa-1', role: 'qa', runtime: 'codex', workdir, mode: 'remote', host: 'box' }),
      ]] }],
    });
    harness.manager = harness.createManager({ config: remoteConfig });
    const report = await getReport();
    expect(report.host).toBe('box');
    await harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'keep', report.token);
    await hold();
    expect((await getReport()).files).toEqual([]);
    Object.assign(remoteConfig.host[0]!, changedHost);
    harness.manager = harness.createManager({ config: remoteConfig });
    expect((await getReport()).files.map(file => file.path)).toEqual(['notes.txt']);
  });

  it.each(['keep', 'discard'] as const)('reports that files were handled if %s succeeds but continuation fails', async action => {
    const report = await getReport();
    vi.spyOn(harness.manager, 'releaseAgentForTask').mockRejectedValueOnce(new Error('remote unavailable'));
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', action, report.token))
      .rejects.toThrow(`${action === 'keep' ? 'Files were kept' : 'Listed files were discarded'}, but continuing the task failed: remote unavailable`);
    if (action === 'keep') expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('keep notes');
    else await expect(lstat(join(workdir, 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const retry = await getReport();
    expect(retry.files).toEqual([]);
    await harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'continue', retry.token);
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it('requires a new decision when Continue encounters new files and rejects stale or busy retries', async () => {
    await rm(join(workdir, 'notes.txt'));
    const empty = await getReport();
    await writeFile(join(workdir, 'new.txt'), 'new');
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'continue', empty.token)).rejects.toThrow('Files or task changed');
    const pending = await getReport();
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'continue', pending.token)).rejects.toThrow('Untracked files need a decision');
    expect(await readFile(join(workdir, 'new.txt'), 'utf8')).toBe('new');
    await rm(join(workdir, 'new.txt'));
    const ready = await getReport();
    terminal.sessions.markWorking('qa-1', RUNTIME_PROFILES.codex.workingFrame);
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'continue', ready.token)).rejects.toThrow();
    expect((await harness.agentStore.get('qa-1'))?.status).toBe('awaiting_human');
  });

  it('does not continue past tracked changes with an empty untracked list', async () => {
    await rm(join(workdir, 'notes.txt'));
    await writeFile(join(workdir, 'tracked.txt'), 'changed');
    const report = await getReport();
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'continue', report.token)).rejects.toThrow('Tracked changes must be saved');
  });

  it('bounds the total retained list across agents while still allowing confirmed discard', async () => {
    const task = (await harness.taskStore.get('task-1'))!;
    const existing = [{ agentId: 'previous-qa', host: 'old-host', workdir: '/old', pathsBase64: encodePaths(Array.from({ length: 1000 }, (_, i) => `artifact-${i}`)) }];
    await harness.taskStore.set({ ...task, retainedUntrackedFiles: existing });
    const report = await getReport();
    expect(report.keepLimitExceeded).toBe(true);
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'keep', report.token)).rejects.toThrow('Retained file limit exceeded');
    expect((await harness.taskStore.get('task-1'))?.retainedUntrackedFiles).toEqual(existing);
    await harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'discard', report.token);
    await expect(lstat(join(workdir, 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('shows checkout conflicts including ignored=%s, and rejects ineffective choices before file mutation', async ignored => {
    const filename = ignored ? 'ignored.txt' : 'notes.txt';
    await git('switch -qc target');
    await writeFile(join(workdir, filename), 'committed target');
    await git(`add -f ${filename}`);
    await git('commit -qm target');
    await git('switch -q main');
    await git('symbolic-ref refs/remotes/origin/HEAD refs/heads/target');
    await writeFile(join(workdir, filename), 'local data');
    const report = await getReport();
    expect(report.conflicts.map(file => file.path)).toEqual([filename]);
    expect(report.manualCleanupRequired).toBe(ignored);
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'keep', report.token)).rejects.toThrow('Checkout would overwrite');
    expect((await harness.taskStore.get('task-1'))?.retainedUntrackedFiles).toBeUndefined();
    if (ignored) {
      await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'discard', report.token)).rejects.toThrow('Checkout would overwrite');
      expect(await readFile(join(workdir, filename), 'utf8')).toBe('local data');
    } else {
      await harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'discard', report.token);
      expect(await readFile(join(workdir, filename), 'utf8')).toBe('committed target');
    }
  });

  it('persists Keep through manager recreation, releases the hold and does not apply it to the next task', async () => {
    const report = await getReport();
    expect(report).toMatchObject({ agentId: 'qa-1', workdir, files: [{ path: 'notes.txt', kind: 'file', size: 10 }] });
    await harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'keep', report.token);
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
    expect(await harness.lockManager.isLocked('qa-1')).toBe(false);
    expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('keep notes');
    harness.manager = harness.createManager();
    await hold();
    expect((await getReport()).files).toEqual([]);
    expect(await harness.manager.releaseAgentForTask('qa-1', 'task-1', 'idle', { allowAwaitingHuman: true })).toBe(true);
    await harness.seedTask({ id: 'task-2', status: 'fixing', phase: 'code', platformBinding: undefined });
    await hold('task-2');
    expect(await harness.manager.releaseAgentForTask('qa-1', 'task-2', 'idle', { allowAwaitingHuman: true })).toBe(false);
    expect((await getReport('task-2')).files.map(file => file.path)).toEqual(['notes.txt']);
  });

  it('discards the displayed files and completes release without touching ignored or tracked files', async () => {
    await writeFile(join(workdir, 'ignored.txt'), 'keep ignored');
    const report = await getReport();
    await harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'discard', report.token);
    await expect(lstat(join(workdir, 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(workdir, 'ignored.txt'), 'utf8')).toBe('keep ignored');
    expect(await readFile(join(workdir, 'tracked.txt'), 'utf8')).toBe('tracked');
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it('asks about new files and discards only those, preserving the earlier Keep choice', async () => {
    const first = await getReport();
    await harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'keep', first.token);
    await writeFile(join(workdir, 'new.txt'), 'new');
    await hold();
    const next = await getReport();
    expect(next.files.map(file => file.path)).toEqual(['new.txt']);
    await harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'discard', next.token);
    expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('keep notes');
    await expect(lstat(join(workdir, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it.each(['paneId', 'creationToken', 'awaitingNonce'] as const)('rejects a confirmation after the agent %s changes', async field => {
    const report = await getReport();
    await harness.agentStore.update('qa-1', binding => ({ ...binding!, [field]: 'changed' }));
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'discard', report.token)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('keep notes');
  });

  it('accepts only one of two concurrent confirmations and applies only the accepted choice', async () => {
    const report = await getReport();
    const results = await Promise.allSettled([
      harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'keep', report.token),
      harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'discard', report.token),
    ]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    if (results[0].status === 'fulfilled') expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('keep notes');
    else await expect(lstat(join(workdir, 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await harness.agentStore.get('qa-1'))?.taskId).toBeUndefined();
  });

  it.each(['keep', 'discard'] as const)('rejects stale %s choices after files or task generation change', async action => {
    const report = await getReport();
    await writeFile(join(workdir, 'notes.txt'), 'changed');
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', action, report.token)).rejects.toMatchObject({ status: 409 });
    const fresh = await getReport();
    const task = (await harness.taskStore.get('task-1'))!;
    await harness.taskStore.set({ ...task, reviewRound: task.reviewRound + 1 });
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', action, fresh.token)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('changed');
    expect((await harness.taskStore.get('task-1'))?.retainedUntrackedFiles).toBeUndefined();
  });

  it('keeps the files and hold when the runtime is busy', async () => {
    const report = await getReport();
    terminal.sessions.markWorking('qa-1', RUNTIME_PROFILES.codex.workingFrame);
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'discard', report.token)).rejects.toThrow();
    expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('keep notes');
    expect((await harness.taskStore.get('task-1'))?.retainedUntrackedFiles).toBeUndefined();
  });

  it('rejects a choice while runtime maintenance is in progress', async () => {
    const report = await getReport();
    expect(harness.manager.tryBeginMaintenance('qa-1')).toBe(true);
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'discard', report.token)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('keep notes');
  });

  it('does not bypass uncertain prompt delivery', async () => {
    await hold('task-1', 'dispatch-failed:ack_unknown');
    await expect(harness.manager.getUntrackedFiles('task-1', 'qa-1')).resolves.toBeNull();
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'discard', 'a'.repeat(64))).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('keep notes');
  });

  it('creates the initial Dev branch before replay when checkout was blocked before branch creation', async () => {
    const devWorkdir = join(root, 'dev-repo');
    await git(`clone -q ${shellQuote(workdir)} ${shellQuote(devWorkdir)}`);
    await writeFile(join(devWorkdir, 'notes.txt'), 'keep notes');
    await harness.taskStore.set(makeTask({ id: 'task-1', status: 'in_progress', phase: 'code', platformBinding: undefined }));
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-1', workdir: devWorkdir, bootstrappingTaskId: 'task-1',
      status: 'awaiting_human', awaitingPhase: 'dirty-workdir',
    });
    const advance = vi.spyOn(harness.manager, 'advanceTask').mockImplementation(async taskId => {
      expect((await git('branch --show-current', devWorkdir)).trim()).toBe('bx/task-1');
      expect(await readFile(join(devWorkdir, 'notes.txt'), 'utf8')).toBe('keep notes');
      return (await harness.taskStore.get(taskId))!;
    });
    const report = await getReport('task-1', 'dev-1');
    await harness.manager.resolveUntrackedFiles('task-1', 'dev-1', 'keep', report.token);
    expect(advance).toHaveBeenCalledWith('task-1', { executor: 'dev', agentId: 'dev-1' });
  });

  it.each(['keep', 'discard'] as const)('can retry initial Dev checkout after %s succeeds and checkout fails', async action => {
    const devWorkdir = join(root, 'dev-repo');
    await git(`clone -q ${shellQuote(workdir)} ${shellQuote(devWorkdir)}`);
    await writeFile(join(devWorkdir, 'notes.txt'), 'keep notes');
    await harness.taskStore.set(makeTask({ id: 'task-1', status: 'in_progress', phase: 'code', platformBinding: undefined }));
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-1', workdir: devWorkdir, bootstrappingTaskId: 'task-1',
      status: 'awaiting_human', awaitingPhase: 'dirty-workdir',
    });
    await git('symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/missing', devWorkdir);
    const report = await getReport('task-1', 'dev-1');
    await expect(harness.manager.resolveUntrackedFiles('task-1', 'dev-1', action, report.token)).rejects.toThrow('continuing the task failed');
    await git('symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main', devWorkdir);
    harness.manager = harness.createManager();
    const retry = await getReport('task-1', 'dev-1');
    expect(retry.files).toEqual([]);
    const advance = vi.spyOn(harness.manager, 'advanceTask').mockImplementation(async taskId => {
      expect((await git('branch --show-current', devWorkdir)).trim()).toBe('bx/task-1');
      return (await harness.taskStore.get(taskId))!;
    });
    await harness.manager.resolveUntrackedFiles('task-1', 'dev-1', 'continue', retry.token);
    expect(advance).toHaveBeenCalledOnce();
    if (action === 'keep') expect(await readFile(join(devWorkdir, 'notes.txt'), 'utf8')).toBe('keep notes');
    else await expect(lstat(join(devWorkdir, 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('checks the actual initial Dev checkout tree with existing task branch=%s', async existing => {
    const devWorkdir = join(root, 'dev-repo');
    await git(`clone -q ${shellQuote(workdir)} ${shellQuote(devWorkdir)}`);
    if (existing) await new BranchManager(runner).switchToTaskBranch(devWorkdir, 'task-1', 'bx/task-1', true);
    await writeFile(join(workdir, 'collision.txt'), 'default branch');
    await git('add collision.txt');
    await git('commit -qm default');
    await git('fetch -q origin', devWorkdir);
    await writeFile(join(devWorkdir, 'collision.txt'), 'local data');
    await harness.taskStore.set(makeTask({ id: 'task-1', status: 'in_progress', phase: 'code', platformBinding: undefined }));
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-1', workdir: devWorkdir, bootstrappingTaskId: 'task-1',
      status: 'awaiting_human', awaitingPhase: 'dirty-workdir',
    });
    const report = await getReport('task-1', 'dev-1');
    expect(report.conflicts.map(file => file.path)).toEqual(existing ? [] : ['collision.txt']);
    if (!existing) {
      await expect(harness.manager.resolveUntrackedFiles('task-1', 'dev-1', 'keep', report.token)).rejects.toThrow('Checkout would overwrite');
      expect((await harness.taskStore.get('task-1'))?.retainedUntrackedFiles).toBeUndefined();
    }
    expect(await readFile(join(devWorkdir, 'collision.txt'), 'utf8')).toBe('local data');
  });

  it('restores a cleaned Dev branch from its remote credential rather than recreating it from the default branch', async () => {
    await git('switch -qc bx/task-1');
    await writeFile(join(workdir, 'committed-work.txt'), 'prior work');
    await git('add committed-work.txt');
    await git('commit -qm work');
    const remoteTipSha = (await git('rev-parse HEAD')).trim();
    await git('switch -q main');
    const devWorkdir = join(root, 'dev-repo');
    await git(`clone -q ${shellQuote(workdir)} ${shellQuote(devWorkdir)}`);
    await writeFile(join(devWorkdir, 'notes.txt'), 'keep notes');
    await harness.taskStore.set(makeTask({
      id: 'task-1', status: 'in_progress', phase: 'code', platformBinding: undefined,
      branchLocalCleaned: { remoteTipSha, updatedAt: new Date().toISOString() },
    }));
    await harness.seedAgent({
      id: 'dev-1', taskId: 'task-1', workdir: devWorkdir, bootstrappingTaskId: 'task-1',
      status: 'awaiting_human', awaitingPhase: 'dirty-workdir',
    });
    vi.spyOn(harness.manager, 'advanceTask').mockImplementation(async taskId => {
      expect((await git('rev-parse HEAD', devWorkdir)).trim()).toBe(remoteTipSha);
      expect(await readFile(join(devWorkdir, 'committed-work.txt'), 'utf8')).toBe('prior work');
      expect((await harness.taskStore.get(taskId))?.branchLocalCleaned).toBeUndefined();
      return (await harness.taskStore.get(taskId))!;
    });
    const report = await getReport('task-1', 'dev-1');
    await harness.manager.resolveUntrackedFiles('task-1', 'dev-1', 'keep', report.token);
  });

  it('releases and reacquires QA to dispatch the pending review after handling files', async () => {
    await harness.taskStore.set(makeTask({
      id: 'task-1', status: 'review', phase: 'code', prNumber: 90,
      deliveryConfirmation: { phase: 'code', source: 'signal', at: new Date().toISOString() },
    }));
    await harness.manager.beginGitReviewPass('task-1', {
      fromStatus: ['review'], headSha: (await git('rev-parse HEAD')).trim(), bumpRound: false, qaPhase: 'review',
    });
    const oldLock = (await harness.agentStore.get('qa-1'))!.lockToken;
    const start = vi.spyOn(harness.manager, 'startSession').mockImplementation(async () => {
      const binding = await harness.agentStore.get('qa-1');
      expect(binding?.taskId).toBe('task-1');
      expect(binding?.status).not.toBe('awaiting_human');
      expect(binding?.lockToken).not.toBe(oldLock);
      expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('keep notes');
      return true;
    });
    const report = await getReport();
    const task = await harness.manager.resolveUntrackedFiles('task-1', 'qa-1', 'keep', report.token);
    expect(start).toHaveBeenCalledWith('task-1', 'qa-1', 'review', expect.objectContaining({ bypassTaskStatusGate: true }));
    expect(task.reviewDispatch).toBeUndefined();
    expect(task.status).toBe('review');
  });
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('untracked file decisions on real workdirs', () => {
  it('checks conflicts within a Git output budget even with a large unrelated ignored directory', async () => {
    await writeFile(join(workdir, '.gitignore'), 'cache/\n');
    await git('add .gitignore');
    await git('commit -qm ignore');
    await mkdir(join(workdir, 'cache'));
    for (let i = 0; i < 500; i++) await writeFile(join(workdir, 'cache', `${'artifact-'.repeat(25)}${i}`), 'ignored');
    await writeFile(join(workdir, 'notes.txt'), 'notes');
    const preload = join(root, 'budget.cjs');
    await writeFile(preload, `const child = require('node:child_process'); const exec = child.execFileSync;
      child.execFileSync = (file, args, options) => exec(file, args, { ...options, maxBuffer: 64 * 1024 });`);
    const limitedRunner = makeCommandRunner({
      execWithStdin: (command, input, options) => runner.execWithStdin(command, input, { ...options, env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } }),
    });
    const report = await inspectUntrackedFiles(limitedRunner, workdir, undefined, ['HEAD']);
    expect(report.files.map(file => file.path)).toEqual(['notes.txt']);
    expect(report.conflicts).toEqual([]);
  });

  it('finds ignored conflicts at target paths and file-directory boundaries while pruning unrelated subtrees', async () => {
    await writeFile(join(workdir, '.gitignore'), 'artifacts/\nancestor\nreplaced/\n');
    await git('add .gitignore');
    await git('commit -qm ignore');
    await git('branch base');
    await mkdir(join(workdir, 'artifacts'));
    await mkdir(join(workdir, 'ancestor'));
    await writeFile(join(workdir, 'artifacts', 'collision.txt'), 'target');
    await writeFile(join(workdir, 'ancestor', 'child.txt'), 'target');
    await writeFile(join(workdir, 'replaced'), 'target');
    await git('add -f artifacts ancestor replaced');
    await git('commit -qm target');
    await git('branch target');
    await git('switch -q base');
    await mkdir(join(workdir, 'artifacts'));
    await mkdir(join(workdir, 'replaced'));
    await writeFile(join(workdir, 'artifacts', 'collision.txt'), 'local');
    await writeFile(join(workdir, 'artifacts', 'unrelated.txt'), 'unrelated');
    await writeFile(join(workdir, 'replaced', 'child.txt'), 'local');
    await symlink(join(root, 'outside'), join(workdir, 'ancestor'));
    const report = await inspectUntrackedFiles(runner, workdir, undefined, ['target']);
    expect(report.files).toEqual([]);
    expect(report.conflicts.map(file => file.path)).toEqual(['ancestor', 'artifacts/collision.txt', 'replaced/child.txt']);
  });

  it.each(['file', 'symlink'])('preserves a replacement %s arriving between validation and removal', async kind => {
    await writeFile(join(workdir, 'notes.txt'), 'confirmed');
    const report = await inspectUntrackedFiles(runner, workdir);
    const preload = join(root, 'replacement.cjs');
    await writeFile(preload, `
      const fs = require('node:fs');
      const rename = fs.renameSync, unlink = fs.unlinkSync;
      const original = fs.realpathSync(${JSON.stringify(workdir)}) + '/notes.txt';
      let replaced = false;
      const replace = file => {
        if (String(file) !== original || replaced) return;
        replaced = true;
        fs.writeFileSync(${JSON.stringify(join(root, 'replacement-injected'))}, 'yes');
        ${kind === 'file' ? "fs.writeFileSync(original + '.new', 'unconfirmed replacement');" : `fs.symlinkSync(${JSON.stringify(join(root, 'missing-target'))}, original + '.new');`}
        rename(original + '.new', original);
      };
      fs.renameSync = (from, to) => { replace(from); return rename(from, to); };
      fs.unlinkSync = file => { replace(file); return unlink(file); };
    `);
    const changingRunner = makeCommandRunner({
      execWithStdin: (command, input, options) => runner.execWithStdin(command, input, { ...options, env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } }),
    });
    const error = await inspectUntrackedFiles(changingRunner, workdir, { fingerprint: report.fingerprint, pathsBase64: encodePaths(['notes.txt']) }).catch(error => error);
    expect(await readFile(join(root, 'replacement-injected'), 'utf8')).toBe('yes');
    if (kind === 'file') expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('unconfirmed replacement');
    else expect((await lstat(join(workdir, 'notes.txt'))).isSymbolicLink()).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('changed');
  });

  it('preserves both the quarantined file and a new original path when restoration cannot replace it', async () => {
    await writeFile(join(workdir, 'notes.txt'), 'confirmed');
    const report = await inspectUntrackedFiles(runner, workdir);
    const preload = join(root, 'restore-race.cjs');
    await writeFile(preload, `
      const fs = require('node:fs'); const rename = fs.renameSync;
      const original = fs.realpathSync(${JSON.stringify(workdir)}) + '/notes.txt';
      fs.renameSync = (from, to) => {
        rename(from, to);
        if (String(from) === original) {
          fs.writeFileSync(to, 'changed while moving');
          fs.writeFileSync(original, 'new original path');
        }
      };
    `);
    const changingRunner = makeCommandRunner({
      execWithStdin: (command, input, options) => runner.execWithStdin(command, input, { ...options, env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } }),
    });
    await expect(inspectUntrackedFiles(changingRunner, workdir, { fingerprint: report.fingerprint, pathsBase64: encodePaths(['notes.txt']) })).rejects.toThrow('File preserved at');
    expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('new original path');
    const saved = (await readdir(workdir)).find(name => name.startsWith('.baxian-discard-'))!;
    expect(await readFile(join(workdir, saved, 'notes.txt'), 'utf8')).toBe('changed while moving');
  });

  it('deletes only the isolated confirmed object when a new file appears at its old path', async () => {
    await writeFile(join(workdir, 'notes.txt'), 'confirmed');
    const report = await inspectUntrackedFiles(runner, workdir);
    const preload = join(root, 'after-move.cjs');
    await writeFile(preload, `
      const fs = require('node:fs'); const rename = fs.renameSync;
      const original = fs.realpathSync(${JSON.stringify(workdir)}) + '/notes.txt';
      fs.renameSync = (from, to) => { rename(from, to); if (String(from) === original) fs.writeFileSync(original, 'new file'); };
    `);
    const changingRunner = makeCommandRunner({
      execWithStdin: (command, input, options) => runner.execWithStdin(command, input, { ...options, env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } }),
    });
    await inspectUntrackedFiles(changingRunner, workdir, { fingerprint: report.fingerprint, pathsBase64: encodePaths(['notes.txt']) });
    expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe('new file');
    expect((await readdir(workdir)).some(name => name.startsWith('.baxian-discard-'))).toBe(false);
  });

  it('survives SSH shell quoting and login-shell output while applying the inspection timeout', async () => {
    await writeFile(join(workdir, "literal ' $() file.txt"), 'keep');
    const local: CommandRunner = {
      exec: runner.exec.bind(runner), writeFile: runner.writeFile.bind(runner),
      execWithStdin: async (command, stdin, options) => {
        expect(options?.timeout).toBe(UNTRACKED_FILES_TIMEOUT_MS);
        return runner.execWithStdin(String.raw`ssh() { printf 'login banner\n'; /bin/sh -c "${'${@: -1}'}"; baxian_result=$?; printf 'logout message\n'; return "$baxian_result"; }; ` + command,
          stdin, { ...options, env: { SHELL: '/bin/bash' } });
      },
    };
    const remote = new SshRunner({ hostname: 'inspection-test.invalid', user: 'tester' }, local);
    const report = await inspectUntrackedFiles(remote, workdir);
    expect(report.files.map(file => file.path)).toEqual(["literal ' $() file.txt"]);
    await inspectUntrackedFiles(remote, workdir, { fingerprint: report.fingerprint, pathsBase64: report.files.map(file => file.pathBase64) });
    expect((await inspectUntrackedFiles(remote, workdir)).files).toEqual([]);
  });

  it('reports concise remote failures without exposing the evaluated Node script or stack', async () => {
    await expect(inspectUntrackedFiles(runner, join(root, 'missing'))).rejects.toThrow('Untracked file inspection failed: ENOENT');
    try { await inspectUntrackedFiles(runner, join(root, 'missing')); }
    catch (error) { expect(String(error)).not.toMatch(/\[eval\]|at run|const fs/); }
    const missingNode = makeCommandRunner({ execWithStdin: async () => ({ exitCode: 127, stdout: 'banner', stderr: 'node: command not found' }) });
    await expect(inspectUntrackedFiles(missingNode, workdir)).rejects.toThrow('node: command not found');
  });

  it.skipIf(process.platform !== 'linux' && !process.env.BAXIAN_UNTRACKED_TEST_HOST)('keeps distinct non-UTF-8 filenames byte-exact through inspection, Keep and Discard', async () => {
    const linux = process.platform === 'linux' ? runner : new SshRunner({ hostname: process.env.BAXIAN_UNTRACKED_TEST_HOST! });
    const created = await linux.exec('mktemp -d /tmp/baxian-byte-paths.XXXXXX');
    expect(created.exitCode).toBe(0);
    const directory = created.stdout.trim();
    expect(directory).toMatch(/^\/tmp\/baxian-byte-paths\.[a-zA-Z0-9]+$/);
    try {
      const init = await linux.exec(`git -C ${shellQuote(directory)} init -q && git -C ${shellQuote(directory)} -c user.name=test -c user.email=test@example.com commit --allow-empty -qm initial`);
      expect(init.exitCode).toBe(0);
      const setup = await linux.execWithStdin(`node -e ${shellQuote("const fs=require('node:fs');const root=fs.readFileSync(0,'utf8');for(const name of [Buffer.from([0x66,0x66,0xff]),Buffer.from([0x66,0x66,0xfe]),Buffer.from('ff�')])fs.writeFileSync(Buffer.concat([Buffer.from(root+'/'),name]),'keep');")}`, Buffer.from(directory));
      expect(setup.exitCode).toBe(0);
      const report = await inspectUntrackedFiles(linux, directory);
      expect(new Set(report.files.map(file => file.pathBase64)).size).toBe(3);
      const pathsBase64 = report.files.map(file => file.pathBase64);
      await expect(new BranchManager(linux, async () => pathsBase64).assertClean(directory)).resolves.toBeUndefined();
      await inspectUntrackedFiles(linux, directory, { fingerprint: report.fingerprint, pathsBase64 });
      expect((await inspectUntrackedFiles(linux, directory)).files).toEqual([]);
    } finally {
      const cleanup = await linux.exec(`rm -rf -- ${shellQuote(directory)}`);
      expect(cleanup.exitCode).toBe(0);
    }
  }, 30_000);

  it('lists untracked paths literally without reading ignored files into the response', async () => {
    await mkdir(join(workdir, 'test-results'));
    await writeFile(join(workdir, 'test-results', 'desktop.png'), 'image');
    await writeFile(join(workdir, 'space\n中文.txt'), 'secret file contents');
    await writeFile(join(workdir, 'ignored.txt'), 'ignored');
    const report = await inspectUntrackedFiles(runner, workdir);
    expect(report.files.map(file => file.path)).toEqual(['space\n中文.txt', 'test-results/desktop.png']);
    expect(report.trackedChanges).toBe(false);
    expect(JSON.stringify(report)).not.toContain('secret file contents');
    expect((await inspectUntrackedFiles(runner, workdir)).fingerprint).toBe(report.fingerprint);
  });

  it('discards only confirmed literal paths and preserves ignored, retained and tracked files', async () => {
    for (const name of [':(glob)*', '-notes', 'retained.txt', 'ignored.txt']) await writeFile(join(workdir, name), name);
    const report = await inspectUntrackedFiles(runner, workdir);
    await inspectUntrackedFiles(runner, workdir, { fingerprint: report.fingerprint, pathsBase64: encodePaths([':(glob)*', '-notes']) });
    for (const name of [':(glob)*', '-notes']) await expect(lstat(join(workdir, name))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const name of ['retained.txt', 'ignored.txt']) expect(await readFile(join(workdir, name), 'utf8')).toBe(name);
    expect(await readFile(join(workdir, 'tracked.txt'), 'utf8')).toBe('tracked');
  });

  it.each(['staged', 'ignored', 'modified'] as const)('stops a partial discard if the next file becomes %s and reports the completed deletions', async change => {
    await writeFile(join(workdir, 'a.txt'), 'a');
    await writeFile(join(workdir, 'b.txt'), 'b');
    const report = await inspectUntrackedFiles(runner, workdir);
    const preload = join(root, 'race.cjs');
    const mutation = change === 'staged'
      ? `require('node:child_process').execFileSync('git',['-C',${JSON.stringify(workdir)},'add','b.txt']);`
      : change === 'ignored'
        ? `fs.appendFileSync(${JSON.stringify(join(workdir, '.gitignore'))},'b.txt\\n');`
        : `fs.writeFileSync(${JSON.stringify(join(workdir, 'b.txt'))},'changed');`;
    await writeFile(preload, `const fs=require('node:fs');const unlink=fs.unlinkSync;fs.unlinkSync=file=>{unlink(file);${mutation}};`);
    const changingRunner = makeCommandRunner({
      execWithStdin: (command, input, options) => runner.execWithStdin(command, input, { ...options, env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } }),
    });
    await expect(inspectUntrackedFiles(changingRunner, workdir, { fingerprint: report.fingerprint, pathsBase64: report.files.map(file => file.pathBase64) }))
      .rejects.toThrow('1 file was discarded before processing stopped');
    await expect(lstat(join(workdir, 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(workdir, 'b.txt'), 'utf8')).toBe(change === 'modified' ? 'changed' : 'b');
  });

  it.each(['edit', 'new-file', 'staged', 'head'] as const)('rejects an outdated confirmation after %s changes', async change => {
    await writeFile(join(workdir, 'notes.txt'), 'old');
    const report = await inspectUntrackedFiles(runner, workdir);
    if (change === 'edit') await writeFile(join(workdir, 'notes.txt'), 'new');
    if (change === 'new-file') await writeFile(join(workdir, 'new.txt'), 'new');
    if (change === 'staged') await git('add notes.txt');
    if (change === 'head') await git('commit --allow-empty -qm changed');
    await expect(inspectUntrackedFiles(runner, workdir, { fingerprint: report.fingerprint, pathsBase64: encodePaths(['notes.txt']) })).rejects.toThrow('Files changed');
    expect(await readFile(join(workdir, 'notes.txt'), 'utf8')).toBe(change === 'edit' ? 'new' : 'old');
  });

  it('removes symlinks without deleting their targets, including dangling symlinks', async () => {
    await writeFile(join(root, 'outside.txt'), 'keep');
    await symlink(join(root, 'outside.txt'), join(workdir, 'link'));
    await symlink(join(root, 'missing'), join(workdir, 'broken'));
    const report = await inspectUntrackedFiles(runner, workdir);
    expect(report.files.every(file => file.kind === 'symlink')).toBe(true);
    await inspectUntrackedFiles(runner, workdir, { fingerprint: report.fingerprint, pathsBase64: encodePaths(['link', 'broken']) });
    expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe('keep');
    expect((await inspectUntrackedFiles(runner, workdir)).files).toEqual([]);
  });

  it('refuses to recursively discard an untracked nested repository', async () => {
    await git('init -q nested');
    await writeFile(join(workdir, 'nested', 'notes.txt'), 'keep');
    const report = await inspectUntrackedFiles(runner, workdir);
    expect(report.files).toEqual([expect.objectContaining({ path: 'nested/', kind: 'directory' })]);
    await expect(inspectUntrackedFiles(runner, workdir, { fingerprint: report.fingerprint, pathsBase64: encodePaths(['nested/']) })).rejects.toThrow('Only listed files');
    expect(await readFile(join(workdir, 'nested', 'notes.txt'), 'utf8')).toBe('keep');
  });
});
