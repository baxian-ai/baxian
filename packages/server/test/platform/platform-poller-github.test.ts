import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PlatformPoller, platformTaskView, type PlatformTaskView } from '../../src/platform/platform-poller.js';
import { platformPollerStatePath } from '../../src/platform/comment-cursor.js';
import { GitDriver, buildDriverRunContext, type DriverExec } from '../../src/platform/git-driver.js';
import { parseDriverSpec } from '../../src/platform/driver-spec.js';
import { buildReviewTokenLine, buildAckMarker } from '../../src/platform/markers.js';
import { bodyDigest } from '../../src/platform/body-digest.js';
import type { MappedEvent } from '../../src/platform/types.js';
import { AgentManager } from '../../src/agent/manager.js';
import { AgentStore } from '../../src/state/agent-store.js';
import { TaskStore } from '../../src/state/task-store.js';
import { LockManager } from '../../src/state/lock.js';
import { EventBus } from '../../src/event/bus.js';
import { EventLog } from '../../src/event/log.js';
import { initStateDir } from '../../src/state/init.js';
import { registerEventHandlers } from '../../src/event/handlers.js';
import { DEFAULT_SERVER_CONFIG, type BaxianConfig, type BaxianEvent } from '../../src/shared/index.js';

const DRIVER_JSON = join(dirname(fileURLToPath(import.meta.url)), '../../src/platform/plugins/github/driver.json');
const GH_SKILL = join(dirname(fileURLToPath(import.meta.url)), '../../src/platform/plugins/github/skills/baxian-cli-gh/SKILL.md');
const execFileAsync = promisify(execFile);
const SHA = 'd'.repeat(40);
const ANCHOR = SHA;
const PASS = 'ffffffffffff';
const FAIL = 'eeeeeeeeeeee';
const T0 = Date.parse('2026-07-17T12:00:00Z');
const OLD_TS = '2026-07-17T11:50:00Z';

const ghPull = {
  number: 42, html_url: 'https://github.com/owner/repo/pull/42', state: 'open', draft: false,
  merged_at: null, updated_at: OLD_TS, title: 'feat: something',
  head: { ref: 'bx/task-1', sha: SHA, repo: { id: 1001 } },
  base: { ref: 'main', repo: { id: 1001 } },
  user: { login: 'devbot', id: 77 },
};
const ghIssueComment = (id: number, body: string, user = { login: 'human', id: 55 }) => ({
  id, body, user, created_at: OLD_TS, updated_at: OLD_TS,
});
const ghReview = (id: number, body: string, state: string) => ({
  id, body, user: { login: 'qa', id: 88 }, submitted_at: OLD_TS, state, commit_id: SHA,
});

describe('PlatformPoller over the real github driver.json (fake gh)', () => {
  let dir = '';
  const events: MappedEvent[] = [];
  const world = {
    pulls: [ghPull] as unknown[],
    prView: ghPull as unknown,
    issueComments: [] as unknown[],
    inlineComments: [] as unknown[],
    reviews: [] as unknown[],
  };
  let clockNow = T0;
  let poller: PlatformPoller;
  const tasks: PlatformTaskView[] = [{
    taskId: 'task-1', terminal: false, branch: 'bx/task-1',
  }];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bx-gh-poller-'));
    const parsed = parseDriverSpec(await readFile(DRIVER_JSON, 'utf8'), DRIVER_JSON);
    if ('errors' in parsed) throw new Error(parsed.errors.map(e => e.message).join('\n'));
    const exec: DriverExec = async (cmd) => {
      const page = Number(/[?&]page=(\d+)/.exec(cmd)?.[1] ?? '1');
      const body = (rows: unknown[]) => ({ stdout: JSON.stringify(page === 1 ? rows : []), stderr: '', exitCode: 0 });
      if (cmd.includes("'--version'")) return { stdout: 'gh version 2.40.0', stderr: '', exitCode: 0 };
      if (cmd.endsWith("'api' 'user'")) return { stdout: JSON.stringify({ id: 77, login: 'devbot' }), stderr: '', exitCode: 0 };
      if (cmd.includes('pulls?state=all')) return body(world.pulls);
      if (cmd.includes('/pulls/42/reviews')) return body(world.reviews);
      if (cmd.includes('/pulls/42/comments')) return body(world.inlineComments);
      if (cmd.includes('/issues/42/comments')) return body(world.issueComments);
      if (cmd.endsWith("'repos/owner/repo/pulls/42'")) return { stdout: JSON.stringify(world.prView), stderr: '', exitCode: 0 };
      if (cmd.endsWith("'repos/owner/repo'")) return {
        stdout: JSON.stringify({ node_id: 'R_repo', default_branch: 'main', permissions: { push: true } }),
        stderr: '', exitCode: 0,
      };
      throw new Error(`no gh fixture for: ${cmd}`);
    };
    const driver = new GitDriver({ spec: parsed.spec }, buildDriverRunContext('git@github.com:owner/repo.git', 'gh'), exec);
    poller = new PlatformPoller({
      onEvent: (_p, event) => { events.push(event); },
      tasks: async () => tasks,
      task: async taskId => tasks.find(task => task.taskId === taskId) ?? null,
      now: () => clockNow,
    });
    poller.add({ projectId: 'p1', repoUrl: 'git@github.com:owner/repo.git', driver, statePath: platformPollerStatePath(dir, 'git@github.com:owner/repo.git') });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('discovers and adopts the bx branch PR from raw gh JSON', async () => {
    await poller.poll();
    const created = events.filter(e => e.type === 'pr.created');
    expect(created).toHaveLength(1);
    expect(created[0]!.data).toMatchObject({
      prNumber: 42, branch: 'bx/task-1', headSha: SHA, targetBranch: 'main',
      prUrl: 'https://github.com/owner/repo/pull/42',
    });
    expect(created[0]!.taskId).toBe('task-1');
  });

  it('turns a fail-token native review into REQUEST_CHANGES and human feedback into comment events', async () => {
    Object.assign(tasks[0]!, {
      prNumber: 42, latestHeadSha: SHA, anchorSha: ANCHOR,
      passToken: PASS, failToken: FAIL, signalToken: 'abababababab',
      replyActorId: '77', replyActorStatus: 'verified', inReview: true,
    });
    world.reviews = [ghReview(900, `findings body\n${buildReviewTokenLine({ kind: 'fail', anchorSha: ANCHOR, token: FAIL })}`, 'CHANGES_REQUESTED')];
    world.issueComments = [ghIssueComment(300, 'please also fix naming')];
    events.length = 0;
    await poller.poll();

    const verdicts = events.filter(e => e.type === 'review.submitted');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.data).toMatchObject({
      action: 'REQUEST_CHANGES', prNumber: 42, headSha: ANCHOR, currentHeadSha: SHA,
      reviewPassToken: 'abababababab', source: 'platform-poller', branch: 'bx/task-1',
    });
    const feedback = events.filter(e => e.type === 'pr.updated' && e.data.kind === 'comment');
    expect(feedback).toHaveLength(1);
    expect(feedback[0]!.data.revision).toMatchObject({ sourceKey: 'issue-comments', id: '300' });
    // 事件的任务归属由 poller 收编时绑定，消费端不再按 branch/prNumber 反查
    expect(events.every(e => e.taskId === 'task-1')).toBe(true);
  });

  it('filters the dev ack reply and confirms the recheck pass across two cycles', async () => {
    const ack = buildAckMarker({ sourceKey: 'issue-comments', commentId: '300', bodyDigest: bodyDigest('please also fix naming') });
    world.issueComments = [
      ghIssueComment(300, 'please also fix naming'),
      ghIssueComment(301, `Fixed.\n${ack}`, { login: 'devbot', id: 77 }),
    ];
    world.reviews = [
      ...world.reviews,
      ghReview(901, `recheck LGTM\n${buildReviewTokenLine({ kind: 'pass', anchorSha: ANCHOR, token: PASS })}`, 'COMMENTED'),
    ];
    // 同 head 复检轮换新令牌对：旧轮 fail 属旧 pair、不参与本轮比较（spec §7）。
    Object.assign(tasks[0]!, { passToken: PASS, failToken: 'cccccccccccc' });
    events.length = 0;
    clockNow = T0 + 30_000;
    await poller.poll();
    expect(events.filter(e => e.type === 'review.submitted')).toHaveLength(0);
    expect(events.filter(e => e.type === 'pr.updated' && e.data.kind === 'comment')).toHaveLength(0);

    clockNow = T0 + 60_000;
    await poller.poll();
    const verdicts = events.filter(e => e.type === 'review.submitted');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.data).toMatchObject({
      action: 'APPROVE', reviewPassToken: 'abababababab', source: 'platform-poller',
    });
  });

  it('detects the merge through prView', async () => {
    world.prView = { ...ghPull, state: 'closed', merged_at: '2026-07-17T12:05:00Z' };
    events.length = 0;
    await poller.poll();
    expect(events.filter(e => e.type === 'pr.merged')).toHaveLength(1);
  });
});

type LifecycleKind = 'github' | 'forge';

const FORGE_FIELD_PATHS = new Map<string, string>([
  ['number', 'iid'],
  ['html_url', 'web_url'],
  ['state', 'status'],
  ['draft', 'is_draft'],
  ['merged_at', 'merged_on'],
  ['updated_at', 'updated_on'],
  ['title', 'summary'],
  ['head.ref', 'source.branch'],
  ['head.sha', 'source.oid'],
  ['head.repo.id', 'source.project.uid'],
  ['base.ref', 'target.branch'],
  ['base.repo.id', 'target.project.uid'],
  ['user.login', 'author.handle'],
  ['user.id', 'author.uid'],
  ['mergeable_state', 'merge_state'],
  ['default_branch', 'primary_branch'],
  ['node_id', 'project_uid'],
  ['permissions.push', 'capabilities.push'],
  ['id', 'uid'],
  ['body', 'text'],
  ['created_at', 'created_on'],
  ['submitted_at', 'submitted_on'],
  ['commit_id', 'commit_oid'],
  ['in_reply_to_id', 'parent_uid'],
  ['path', 'file_path'],
  ['line', 'line_number'],
  ['original_line', 'original_line_number'],
  ['api', 'rest'],
]);

function forgeDriverValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const mapped = FORGE_FIELD_PATHS.get(value) ?? value;
    return mapped
      .replaceAll('repos/{repoPath}/issues/{prNumber}/comments', 'projects/{repoPath}/tickets/{prNumber}/notes')
      .replaceAll('repos/{repoPath}/pulls/{prNumber}/comments', 'projects/{repoPath}/changes/{prNumber}/inline-notes')
      .replaceAll('repos/{repoPath}/pulls', 'projects/{repoPath}/changes')
      .replaceAll('repos/{repoPath}/git/refs/heads', 'projects/{repoPath}/refs/heads')
      .replaceAll('repos/{repoPath}', 'projects/{repoPath}');
  }
  if (Array.isArray(value)) return value.map(forgeDriverValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key === 'GH_HOST' ? 'FORGE_HOST' : key,
      forgeDriverValue(child),
    ]));
  }
  return value;
}

function lifecyclePr(
  kind: LifecycleKind,
  branch: string,
  headSha: string,
  updatedAt: string,
  state: 'open' | 'closed' = 'open',
  mergedAt: string | null = null,
  mergeState = 'clean',
): unknown {
  if (kind === 'github') {
    return {
      number: 42, html_url: 'https://github.com/owner/repo/pull/42', state, draft: false,
      merged_at: mergedAt, updated_at: updatedAt, title: 'feat: lifecycle',
      head: { ref: branch, sha: headSha, repo: { id: 1001 } },
      base: { ref: 'main', repo: { id: 1001 } },
      user: { login: 'devbot', id: 77 }, mergeable_state: mergeState,
    };
  }
  return {
    iid: 42, web_url: 'https://forge.example.com/owner/repo/changes/42', status: state,
    is_draft: false, merged_on: mergedAt, updated_on: updatedAt, summary: 'feat: lifecycle',
    source: { branch, oid: headSha, project: { uid: 1001 } },
    target: { branch: 'main', project: { uid: 1001 } },
    author: { handle: 'devbot', uid: 77 }, merge_state: mergeState,
  };
}

function lifecycleComment(
  kind: LifecycleKind,
  id: number,
  body: string,
  at: string,
  authorId: number,
): unknown {
  return kind === 'github'
    ? { id, body, user: { login: `user-${authorId}`, id: authorId }, created_at: at, updated_at: at }
    : { uid: id, text: body, author: { handle: `user-${authorId}`, uid: authorId }, created_on: at, updated_on: at };
}

function lifecycleReview(
  kind: LifecycleKind,
  id: number,
  body: string,
  at: string,
  state: string,
  commitSha: string,
  authorId: number,
): unknown {
  return kind === 'github'
    ? {
        id, body, user: { login: `user-${authorId}`, id: authorId },
        submitted_at: at, state, commit_id: commitSha,
      }
    : {
        uid: id, text: body, author: { handle: `user-${authorId}`, uid: authorId },
        submitted_on: at, status: state, commit_oid: commitSha,
      };
}

async function lifecycleHarness(kind: LifecycleKind) {
  const dir = await mkdtemp(join(tmpdir(), `bx-${kind}-lifecycle-`));
  onTestFinished(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  await initStateDir(dir);

  const githubDriverJson = await readFile(DRIVER_JSON, 'utf8');
  const driverJson = kind === 'github'
    ? githubDriverJson
    : JSON.stringify(forgeDriverValue(JSON.parse(githubDriverJson)));
  const parsed = parseDriverSpec(driverJson, `${kind}-driver.json`);
  if ('errors' in parsed) throw new Error(parsed.errors.map(e => e.message).join('\n'));

  let now = Date.now();
  const commands: string[] = [];
  const world = {
    branch: '',
    headSha: SHA,
    updatedAt: new Date(now - 10_000).toISOString(),
    state: 'open' as 'open' | 'closed',
    mergedAt: null as string | null,
    issueComments: [] as unknown[],
    inlineComments: [] as unknown[],
    reviews: [] as unknown[],
    mergedSha: undefined as string | undefined,
    branchDeleted: false,
    mergeBlocked: false,
    mergeState: 'clean',
  };
  const currentPr = () => lifecyclePr(
    kind, world.branch, world.headSha, world.updatedAt, world.state, world.mergedAt, world.mergeState,
  );
  const exec: DriverExec = async (command) => {
    commands.push(command);
    const page = Number(/[?&]page=(\d+)/.exec(command)?.[1] ?? '1');
    const pageBody = (rows: unknown[]) => ({
      stdout: JSON.stringify(page === 1 ? rows : []), stderr: '', exitCode: 0,
    });
    if (command.includes("'--version'")) {
      return { stdout: `${kind === 'github' ? 'gh' : 'forge'} version 2.40.0`, stderr: '', exitCode: 0 };
    }
    if (command.endsWith("'api' 'user'") || command.endsWith("'rest' 'user'")) {
      return { stdout: JSON.stringify({ id: 77, login: 'devbot' }), stderr: '', exitCode: 0 };
    }
    if (command.includes("'PUT'") && command.includes("/merge'")) {
      if (world.mergeBlocked) {
        return { stdout: '', stderr: 'GraphQL: Pull Request is not mergeable (HTTP 405)', exitCode: 1 };
      }
      world.mergedSha = /sha=([0-9a-f]+)/.exec(command)?.[1];
      world.state = 'closed';
      world.mergedAt = new Date(now).toISOString();
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (command.includes("'PATCH'") && command.includes("'state=closed'")) {
      world.state = 'closed';
      world.mergedAt = null;
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (command.includes('updateRefs')) {
      world.branchDeleted = true;
      return { stdout: JSON.stringify({ data: { updateRefs: { clientMutationId: null } } }), stderr: '', exitCode: 0 };
    }
    if (command.includes('refName=refs/heads/')) {
      return {
        stdout: JSON.stringify({ data: { node: { id: 'R_repo', ref: null } } }),
        stderr: '', exitCode: 0,
      };
    }
    if (command.includes('?state=all')) return pageBody([currentPr()]);
    if (command.includes('/issues/42/comments?') || command.includes('/tickets/42/notes?')) {
      return pageBody(world.issueComments);
    }
    if (command.includes('/pulls/42/comments?') || command.includes('/changes/42/inline-notes?')) {
      return pageBody(world.inlineComments);
    }
    if (command.includes('/reviews?')) return pageBody(world.reviews);
    if (/(?:pulls|changes)\/42'$/.test(command)) {
      return { stdout: JSON.stringify(currentPr()), stderr: '', exitCode: 0 };
    }
    if (command.endsWith("'repos/owner/repo'") || command.endsWith("'projects/owner/repo'")) {
      const project = kind === 'github'
        ? { node_id: 'R_repo', default_branch: 'main', permissions: { push: true } }
        : { project_uid: 'R_repo', primary_branch: 'main', capabilities: { push: true } };
      return { stdout: JSON.stringify(project), stderr: '', exitCode: 0 };
    }
    throw new Error(`no ${kind} lifecycle fixture for: ${command}`);
  };

  const repo = kind === 'github'
    ? 'git@github.com:owner/repo.git'
    : 'https://forge.example.com/owner/repo.git';
  const driver = new GitDriver(
    { spec: parsed.spec },
    buildDriverRunContext(repo, kind === 'github' ? 'gh' : 'forge'),
    exec,
  );
  const config: BaxianConfig = {
    review: { rounds: 3, mode: 'git' },
    server: DEFAULT_SERVER_CONFIG,
    host: [],
    project: [{
      id: 'proj', repo, merge: 'auto',
      ...(kind === 'forge' ? { gitCli: { tool: 'forge' } } : {}),
      agent: [[
        { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local', workdir: '/tmp/lifecycle-dev' },
        { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/lifecycle-qa' },
      ]],
    }],
  };
  const taskStore = new TaskStore(join(dir, 'state', 'tasks'));
  const eventBus = new EventBus(new EventLog(join(dir, 'events')));
  const manager = new AgentManager({
    config,
    agentStore: new AgentStore(join(dir, 'state', 'agents')),
    taskStore,
    lockManager: new LockManager(join(dir, 'locks')),
    eventBus,
  });
  vi.spyOn(manager, 'platformDriverFor').mockReturnValue(driver);
  vi.spyOn(manager, 'acquireAgentForTask').mockResolvedValue(true);
  vi.spyOn(manager, 'releaseAgentForTask').mockResolvedValue(true);
  vi.spyOn(manager, 'markAgentWaiting').mockResolvedValue(true);
  vi.spyOn(manager, 'continueSession').mockResolvedValue(true);
  vi.spyOn(manager, 'startSession').mockResolvedValue(true);
  vi.spyOn(manager, 'cleanupAfterMerge').mockResolvedValue(undefined);
  let rotated = 0;
  vi.spyOn(manager, 'rotateAndSetupPhaseSignal').mockImplementation(async (taskId) => {
    const token = (++rotated).toString(16).padStart(12, '0');
    await manager.updateTask(taskId, { signalToken: token });
    return { token, armed: true };
  });
  registerEventHandlers(eventBus, manager);

  const emittedEvents: BaxianEvent[] = [];
  eventBus.on('*', event => { emittedEvents.push(event); });

  const verdictLog = join(dir, 'fake-gh-verdict.log');
  const fakeGh = join(dir, 'gh');
  if (kind === 'github') {
    await writeFile(fakeGh, `#!/bin/sh
printf '%s\\t%s\\n' "$GH_HOST" "$*" >> "$FAKE_GH_LOG"
case " $* " in
  *" --approve "*)
    echo 'failed to create review: GraphQL: Review Can not approve your own pull request (addPullRequestReview)' >&2
    exit 1
    ;;
  *" --request-changes "*)
    echo 'failed to create review: GraphQL: Review Can not request changes on your own pull request (addPullRequestReview)' >&2
    exit 1
    ;;
  *" --comment "*) exit 0 ;;
esac
echo "unexpected fake gh invocation: $*" >&2
exit 2
`, { mode: 0o755 });
  }

  const sameAccountReview = async (
    id: number,
    body: string,
    commitSha: string,
    at: string,
  ): Promise<unknown> => {
    if (kind !== 'github') throw new Error('same-account gh fallback is github-only');
    const bodyFile = join(dir, `verdict-${id}.txt`);
    await writeFile(bodyFile, body);
    const action = body.includes('baxian:review:pass') ? '--approve' : '--request-changes';
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      GH_HOST: 'github.com',
      FAKE_GH_LOG: verdictLog,
    };
    try {
      await execFileAsync('gh', ['pr', 'review', '42', '-R', 'owner/repo', action, '--body-file', bodyFile], { env });
      throw new Error('fake gh unexpectedly allowed a same-account native verdict');
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      if (!/Can not (approve|request changes on) your own pull request/.test(stderr)) throw error;
    }
    await execFileAsync('gh', [
      'pr', 'review', '42', '-R', 'owner/repo', '--comment', '--body-file', bodyFile,
    ], { env });
    return lifecycleReview(kind, id, body, at, 'COMMENTED', commitSha, 77);
  };

  const mappedEvents: MappedEvent[] = [];
  const poller = new PlatformPoller({
    now: () => now,
    tasks: async () => (await taskStore.list()).map(platformTaskView),
    task: async taskId => {
      const task = await taskStore.get(taskId);
      return task ? platformTaskView(task) : null;
    },
    onEvent: async (projectId, mapped) => {
      mappedEvents.push(mapped);
      const task = mapped.taskId === undefined ? null : await taskStore.get(mapped.taskId);
      const event: BaxianEvent = {
        id: '', type: mapped.type, timestamp: new Date(now).toISOString(),
        projectId: task?.projectId ?? projectId,
        ...(task ? { taskId: task.id, ...(task.agentId ? { agentId: task.agentId } : {}) } : {}),
        data: mapped.data,
      };
      await eventBus.emit(event);
    },
  });
  poller.add({
    projectId: 'proj', repoUrl: repo, driver,
    statePath: platformPollerStatePath(dir, repo),
  });

  return {
    manager, taskStore, eventBus, poller, world, commands, mappedEvents, emittedEvents,
    advance(ms = 20_000) {
      now += ms;
      return new Date(now - 10_000).toISOString();
    },
    publish(branch: string, headSha = SHA) {
      world.branch = branch;
      world.headSha = headSha;
      world.state = 'open';
      world.mergedAt = null;
      world.updatedAt = new Date(now - 10_000).toISOString();
    },
    push(headSha: string) {
      world.headSha = headSha;
      world.updatedAt = new Date(now - 10_000).toISOString();
    },
    comment(id: number, body: string, authorId: number, at: string) {
      return lifecycleComment(kind, id, body, at, authorId);
    },
    review(id: number, body: string, state: string, commitSha: string, authorId: number, at: string) {
      return lifecycleReview(kind, id, body, at, state, commitSha, authorId);
    },
    sameAccountReview,
    async verdictCommands() {
      if (kind !== 'github') return [];
      return (await readFile(verdictLog, 'utf8')).trim().split('\n');
    },
  };
}

describe.each(['github', 'forge'] as const)('%s driver lifecycle integration', (kind) => {
  it('runs task creation, adoption, same-account fallback, fix, recheck, and merge end to end', async () => {
    const h = await lifecycleHarness(kind);
    if (kind === 'github') {
      const skill = await readFile(GH_SKILL, 'utf8');
      expect(skill).toContain('gh pr review <pr> -R <cli-repo> --approve --body-file <verdict-file>');
      expect(skill).toContain('Can not approve your own pull request');
      expect(skill).toContain('gh pr review <pr> -R <cli-repo> --comment --body-file <verdict-file>');
    }
    const created = await h.manager.createTask('proj', {
      title: 'Lifecycle', description: 'exercise the complete platform path', preferredAgentId: 'dev-1',
    });
    const publishToken = '111111111111';
    await h.manager.updateTask(created.id, {
      signalToken: publishToken,
      pendingPrSignalToken: publishToken,
    });
    h.publish(created.branch!);

    await h.poller.poll();
    let task = (await h.taskStore.get(created.id))!;
    expect(task).toMatchObject({
      status: 'in_progress', prNumber: 42, latestHeadSha: SHA,
      replyActorId: '77', replyActorStatus: 'provisional',
    });
    expect(task.reviewHeadAnchorSha).toBeUndefined();

    await h.eventBus.emit({
      id: '', type: 'pr.created', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: created.id,
      data: {
        source: 'pane-signal', prNumber: 42, token: publishToken,
        actorB64: Buffer.from('77', 'utf8').toString('base64url'),
      },
    });
    task = (await h.taskStore.get(created.id))!;
    expect(task).toMatchObject({
      status: 'review', phase: 'code', prNumber: 42, latestHeadSha: SHA,
      reviewHeadAnchorSha: SHA, replyActorId: '77', replyActorStatus: 'verified',
    });

    const humanBody = 'please handle the edge case';
    const failBody = `same-account request changes\n${buildReviewTokenLine({
      kind: 'fail', anchorSha: SHA, token: task.failToken!,
    })}`;
    const failAt = h.advance();
    const humanComment = h.comment(300, humanBody, 55, failAt);
    const failReview = kind === 'github'
      ? await h.sameAccountReview(900, failBody, SHA, failAt)
      : h.review(900, failBody, 'COMMENTED', SHA, 77, failAt);
    h.world.issueComments = [humanComment];
    h.world.reviews = [failReview];

    await h.poller.poll();
    task = (await h.taskStore.get(created.id))!;
    expect(task.status).toBe('fixing');
    expect(task.signalToken).toMatch(/^[0-9a-f]{12}$/);

    const ackAt = h.advance();
    h.world.issueComments = [
      humanComment,
      h.comment(301, `fixed\n${buildAckMarker({
        sourceKey: 'issue-comments', commentId: '300', bodyDigest: bodyDigest(humanBody),
      })}`, 77, ackAt),
      h.comment(302, `addressed review\n${buildAckMarker({
        sourceKey: 'reviews', commentId: '900', bodyDigest: bodyDigest(failBody),
      })}`, 77, ackAt),
    ];
    const fixToken = task.signalToken!;
    const firstPassToken = task.passToken;
    const firstFailToken = task.failToken;
    await h.eventBus.emit({
      id: '', type: 'pr.fix.submitted', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: created.id,
      data: { kind: 'pr-fixed', token: fixToken, source: 'pane-signal' },
    });
    task = (await h.taskStore.get(created.id))!;
    expect(task).toMatchObject({ status: 'review', latestHeadSha: SHA, reviewHeadAnchorSha: SHA });
    expect(task.passToken).not.toBe(firstPassToken);
    expect(task.failToken).not.toBe(firstFailToken);

    const passBody = `same-account approve fallback\n${buildReviewTokenLine({
      kind: 'pass', anchorSha: SHA, token: task.passToken!,
    })}`;
    const passAt = h.advance();
    const passReview = kind === 'github'
      ? await h.sameAccountReview(901, passBody, SHA, passAt)
      : h.review(901, passBody, 'COMMENTED', SHA, 77, passAt);
    h.world.reviews = [failReview, passReview];
    await h.poller.poll();
    expect((await h.taskStore.get(created.id))?.status).toBe('review');
    h.advance();
    await h.poller.poll();
    task = (await h.taskStore.get(created.id))!;
    expect(task.status).toBe('approved');
    expect(task.passProvenance).toMatchObject({ sourceKey: 'reviews', id: '901', anchorSha: SHA });

    const firstCompletion = await h.manager.getPostApproveCompletion(created.id);
    expect(firstCompletion?.pendingRedispatch).toBe(false);

    const c1Body = 'post-approve C1';
    const c1At = h.advance();
    const c1 = h.comment(400, c1Body, 55, c1At);
    h.world.issueComments = [...h.world.issueComments, c1];
    await h.poller.poll();
    expect((await h.taskStore.get(created.id))?.pendingRedispatch).toBe(true);

    const r1At = h.advance();
    const c2Body = 'post-approve C2 arrived after R1';
    const c2 = h.comment(402, c2Body, 55, r1At);
    h.world.issueComments = [
      ...h.world.issueComments,
      h.comment(401, `handled C1\n${buildAckMarker({
        sourceKey: 'issue-comments', commentId: '400', bodyDigest: bodyDigest(c1Body),
      })}`, 77, r1At),
      c2,
    ];
    await h.poller.poll();
    await h.eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: created.id,
      data: {
        kind: 'pr-merge-ready', prNumber: 42, token: firstCompletion!.token,
        verdictAgentId: 'dev-1', source: 'pane-signal',
      },
    });
    task = (await h.taskStore.get(created.id))!;
    expect(task.status).toBe('approved');
    const redispatchedCompletion = await h.manager.getPostApproveCompletion(created.id);
    expect(redispatchedCompletion?.token).not.toBe(firstCompletion?.token);
    expect(redispatchedCompletion?.redispatchCount).toBe(1);

    const r2At = h.advance();
    h.world.issueComments = [
      ...h.world.issueComments,
      h.comment(403, `handled C2\n${buildAckMarker({
        sourceKey: 'issue-comments', commentId: '402', bodyDigest: bodyDigest(c2Body),
      })}`, 77, r2At),
    ];
    await h.eventBus.emit({
      id: '', type: 'pr.updated', timestamp: new Date().toISOString(),
      projectId: 'proj', agentId: 'dev-1', taskId: created.id,
      data: {
        kind: 'pr-merge-ready', prNumber: 42, token: redispatchedCompletion!.token,
        verdictAgentId: 'dev-1', source: 'pane-signal',
      },
    });
    expect((await h.taskStore.get(created.id))?.status).toBe('merge-ready');

    h.world.mergeBlocked = true;
    h.world.mergeState = 'blocked-by-checks';
    await expect(h.manager.confirmHumanGate(created.id)).rejects.toThrow(
      /merge blocked by platform \(blocked-by-checks\).*Pull Request is not mergeable/,
    );
    expect((await h.taskStore.get(created.id))?.status).toBe('merge-ready');
    h.world.mergeBlocked = false;
    h.world.mergeState = 'clean';
    await h.manager.confirmHumanGate(created.id);
    expect((await h.taskStore.get(created.id))?.status).toBe('merged');
    expect(h.world.mergedSha).toBe(SHA);
    expect(h.mappedEvents.map(event => event.type)).toEqual(expect.arrayContaining([
      'pr.created', 'review.submitted', 'pr.updated',
    ]));
    const mergeCommands = h.commands.filter(command => command.includes("'PUT'") && command.includes("/merge'"));
    expect(mergeCommands).toHaveLength(2);
    expect(mergeCommands.every(command => command.includes(`'sha=${SHA}'`))).toBe(true);
    if (kind === 'github') {
      const verdictCommands = await h.verdictCommands();
      expect(verdictCommands).toHaveLength(4);
      expect(verdictCommands.filter(command => command.includes('--request-changes'))).toHaveLength(1);
      expect(verdictCommands.filter(command => command.includes('--approve'))).toHaveLength(1);
      expect(verdictCommands.filter(command => command.includes('--comment'))).toHaveLength(2);
      expect(verdictCommands.every(command => command.startsWith('github.com\tpr review 42 -R owner/repo'))).toBe(true);
      expect(h.emittedEvents.some(event => event.type === 'review.submitted'
        && event.data.source === 'pane-signal')).toBe(false);
    }
    if (kind === 'forge') {
      expect(h.commands.some(command => command.includes("FORGE_HOST='forge.example.com'"))).toBe(true);
      expect(h.commands.every(command => !command.includes('github.com'))).toBe(true);
    }
  });

  it('routes cancellation cleanup through the declared close and deleteBranch operations', async () => {
    const h = await lifecycleHarness(kind);
    const task = await h.manager.createTask('proj', {
      title: 'Cancel lifecycle', description: 'close and delete', preferredAgentId: 'dev-1',
    });
    h.publish(task.branch!);
    await h.manager.updateTask(task.id, {
      prNumber: 42, prUrl: 'https://example.test/pr/42', baseBranch: 'main', latestHeadSha: SHA,
    });

    const generation = 'abc123abc123';
    await h.taskStore.set({
      ...(await h.taskStore.get(task.id))!,
      status: 'cancelled',
      remoteCleanup: {
        generation,
        stage: 'close-pending',
        prNumber: 42,
        branch: task.branch!,
        expectedHeadSha: SHA,
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    });
    await h.manager.processGitRemoteCleanup(task.id, generation);

    expect(h.world.state).toBe('closed');
    expect(h.world.branchDeleted).toBe(true);
    expect(h.commands.some(command => command.includes("'PATCH'") && command.includes("'state=closed'"))).toBe(true);
    expect(h.commands.some(command => command.includes('updateRefs') && command.includes(task.branch!))).toBe(true);
  });

  it('anchors a closed-unmerged PR once and clears the durable gate when it reopens', async () => {
    const h = await lifecycleHarness(kind);
    const created = await h.manager.createTask('proj', {
      title: 'Close lifecycle', description: 'close without merge', preferredAgentId: 'dev-1',
    });
    h.publish(created.branch!);
    await h.poller.poll();
    expect((await h.taskStore.get(created.id))?.prNumber).toBe(42);

    h.world.state = 'closed';
    h.world.mergedAt = null;
    h.world.updatedAt = h.advance();
    await h.poller.poll();
    expect((await h.taskStore.get(created.id))?.closedUnmergedAnchor).toMatchObject({
      prNumber: 42, generation: 1,
    });
    expect(h.emittedEvents.filter(event => event.type === 'human.intervention'
      && event.data.phase === 'mr-closed-unmerged')).toHaveLength(1);

    await h.poller.poll();
    expect(h.emittedEvents.filter(event => event.type === 'human.intervention'
      && event.data.phase === 'mr-closed-unmerged')).toHaveLength(1);

    h.world.state = 'open';
    h.world.updatedAt = h.advance();
    await h.poller.poll();
    expect((await h.taskStore.get(created.id))?.closedUnmergedAnchor).toMatchObject({
      prNumber: 42, generation: 1, cleared: true,
    });
    expect(h.mappedEvents.some(event => event.type === 'pr.updated'
      && event.data.kind === 'reopened')).toBe(true);
  });
});
