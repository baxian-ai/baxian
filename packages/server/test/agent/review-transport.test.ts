import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ReviewExchangeError,
  ReviewTransport,
  resolveServerPayloads,
  validateReviewFindings,
  validateReviewResponse,
} from '../../src/agent/review-transport.js';
import { MAX_INLINE_CONTENT_BYTES } from '../../src/shared/index.js';
import { LocalRunner, shellQuote } from '../../src/agent/runner.js';
import type { ExecOptions, ExecResult } from '../../src/agent/runner.js';
import { GIT_NET_ENV, NET_EXEC_TIMEOUT_MS, __setNetExecSleepForTests } from '../../src/agent/net-exec.js';
import type { AgentConfig, TaskState } from '../../src/shared/index.js';

const DEV: AgentConfig = { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' };
const QA: AgentConfig = { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local' };

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 't1',
    projectId: 'p1',
    title: 'T',
    description: 'D',
    preferredAgentId: 'dev-1',
    agentId: 'dev-1',
    devAgentId: 'dev-1',
    reviewRound: 0,
    phase: 'code',
    status: 'review',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    ...overrides,
  };
}

type Rule = { match: (cmd: string) => boolean; result: Partial<ExecResult> };

function makeTransport(rules: Rule[], worktree = '/wt/dev') {
  const calls: string[] = [];
  const execOptions: Array<ExecOptions | undefined> = [];
  const writes: Array<{ path: string; content: string }> = [];
  const runner = {
    exec: async (cmd: string, options?: ExecOptions): Promise<ExecResult> => {
      calls.push(cmd);
      execOptions.push(options);
      const rule = rules.find(r => r.match(cmd));
      return { stdout: '', stderr: '', exitCode: 0, ...(rule?.result ?? {}) };
    },
    writeFile: async (path: string, content: string | Buffer) => {
      writes.push({ path, content: content.toString() });
    },
    execWithStdin: async (cmd: string, stdin: Buffer): Promise<ExecResult> => {
      calls.push(cmd);
      const staged = /cat > '([^']+)'/.exec(cmd);
      const rule = rules.find(r => r.match(cmd));
      const result = { stdout: '', stderr: '', exitCode: 0, ...(rule?.result ?? {}) };
      if (staged && result.exitCode === 0) writes.push({ path: staged[1], content: stdin.toString() });
      return result;
    },
  };
  const transport = new ReviewTransport({
    createRunnerFor: () => runner,
    resolveWorkdir: () => worktree,
  });
  return { transport, calls, execOptions, writes };
}

const FINDINGS_JSON = JSON.stringify({
  round: 1,
  verdict: 'request-changes',
  findings: [{ id: 'f-1', severity: 'major', message: 'broken', file: 'a.ts', line: 3 }],
});

const RESPONSE_JSON = JSON.stringify({
  round: 1,
  token: 'abcdef123456',
  findingsDigest: 'a'.repeat(64),
  responses: [{ findingId: 'f-1', action: 'fix', rationale: 'fixed', commitSha: 'abc123' }],
});
const RESPONSE_GENERATION = {
  token: 'abcdef123456',
  findingsDigest: 'a'.repeat(64),
};

describe('readContent (code)', () => {
  it('fetches, detects default branch, captures merge-base, head tree, and binary diff', async () => {
    const { transport, calls } = makeTransport([
      { match: c => c.includes('symbolic-ref'), result: { stdout: 'origin/main\n' } },
      { match: c => c.includes('rev-parse HEAD'), result: { stdout: 'headsha123\n' } },
      { match: c => c.includes('merge-base'), result: { stdout: 'basesha123\n' } },
      { match: c => c.includes('headsha123^{tree}'), result: { stdout: 'treesha123\n' } },
      { match: c => c.includes('--stat'), result: { stdout: ' a.ts | 2 +-\n' } },
      { match: c => / diff\b/.test(c) && !c.includes('--stat'), result: { stdout: 'diff --git a/a.ts b/a.ts\n+x' } },
    ]);
    const result = await transport.readContent(task(), DEV, 'code');
    expect(result.content).toContain('diff --git');
    expect(result.baseSha).toBe('basesha123');
    expect(result.headSha).toBe('headsha123');
    expect(result.headTree).toBe('treesha123');
    expect(result.defaultBranch).toBe('main');
    expect(result.diffstat).toContain('a.ts');
    expect(calls.some(c => c.includes('git fetch origin'))).toBe(true);
    expect(calls.some(c => c.includes("'basesha123' 'headsha123'"))).toBe(true);
    expect(calls.some(c => c.includes('diff --binary'))).toBe(true);
  });

  it('runs diff and diffstat with core.quotepath=false so non-ascii paths stay verbatim', async () => {
    const { transport, calls } = makeTransport([
      { match: c => c.includes('symbolic-ref'), result: { stdout: 'origin/main\n' } },
      { match: c => c.includes('rev-parse HEAD'), result: { stdout: 'headsha123\n' } },
      { match: c => c.includes('merge-base'), result: { stdout: 'basesha123\n' } },
      { match: c => c.includes('headsha123^{tree}'), result: { stdout: 'treesha123\n' } },
      { match: c => c.includes('--stat'), result: { stdout: ' x | 1 +\n' } },
      { match: c => / diff\b/.test(c) && !c.includes('--stat'), result: { stdout: 'diff --git a/x b/x' } },
    ]);
    await transport.readContent(task(), DEV, 'code');
    const diffCalls = calls.filter(c => / diff\b/.test(c));
    expect(diffCalls).toHaveLength(2);
    for (const c of diffCalls) expect(c).toContain('-c core.quotepath=false');
  });

  it('uses an expanded stdout buffer for binary review patches', async () => {
    const { transport, calls, execOptions } = makeTransport([
      { match: c => c.includes('symbolic-ref'), result: { stdout: 'origin/main\n' } },
      { match: c => c.includes('rev-parse HEAD'), result: { stdout: 'headsha123\n' } },
      { match: c => c.includes('merge-base'), result: { stdout: 'basesha123\n' } },
      { match: c => c.includes('headsha123^{tree}'), result: { stdout: 'treesha123\n' } },
      { match: c => c.includes('--stat'), result: { stdout: ' x | 1 +\n' } },
      { match: c => / diff\b/.test(c) && !c.includes('--stat'), result: { stdout: 'diff --git a/x b/x' } },
    ]);

    await transport.readContent(task(), DEV, 'code');

    const diffIndex = calls.findIndex(c => c.includes('diff --binary'));
    expect(diffIndex).toBeGreaterThan(-1);
    expect(execOptions[diffIndex]?.maxBuffer).toBeGreaterThan(16 * 1024 * 1024);
  });

  it('throws ReviewExchangeError when diff fails', async () => {
    const { transport } = makeTransport([
      { match: c => c.includes('symbolic-ref'), result: { stdout: 'origin/main\n' } },
      { match: c => c.includes('rev-parse HEAD'), result: { stdout: 'headsha123\n' } },
      { match: c => c.includes('merge-base'), result: { stdout: 'basesha123\n' } },
      { match: c => c.includes('headsha123^{tree}'), result: { stdout: 'treesha123\n' } },
      { match: c => / diff\b/.test(c) && !c.includes('--stat'), result: { exitCode: 128, stderr: 'fatal' } },
    ]);
    await expect(transport.readContent(task(), DEV, 'code')).rejects.toThrow(ReviewExchangeError);
  });

  it.each([
    ['git fetch', 'fetch-failed'],
    ['symbolic-ref', 'default-branch-failed'],
    ['rev-parse HEAD', 'head-failed'],
    ['merge-base', 'merge-base-failed'],
    ['headsha123^{tree}', 'head-tree-failed'],
    ['--stat', 'diffstat-failed'],
  ])('fails loud when %s step fails (%s)', async (step, reason) => {
    const { transport } = makeTransport([
      { match: c => c.includes('symbolic-ref') && step !== 'symbolic-ref', result: { stdout: 'origin/main\n' } },
      { match: c => c.includes('rev-parse HEAD') && step !== 'rev-parse HEAD', result: { stdout: 'headsha123\n' } },
      { match: c => c.includes('merge-base') && step !== 'merge-base', result: { stdout: 'basesha123\n' } },
      { match: c => c.includes('headsha123^{tree}') && step !== 'headsha123^{tree}', result: { stdout: 'treesha123\n' } },
      { match: c => c.includes(step), result: { exitCode: 1, stderr: 'boom' } },
    ]);
    await expect(transport.readContent(task(), DEV, 'code')).rejects.toThrow(
      expect.objectContaining({ reason }),
    );
  });

  it('runs the fetch under the network timeout with the low-speed guard', async () => {
    const seen: Array<{ cmd: string; timeout?: number }> = [];
    const runner = {
      exec: async (cmd: string, options?: { timeout?: number }): Promise<ExecResult> => {
        seen.push({ cmd, ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}) });
        if (cmd.includes('symbolic-ref')) return { stdout: 'origin/main\n', stderr: '', exitCode: 0 };
        if (cmd.includes('rev-parse HEAD')) return { stdout: 'headsha123\n', stderr: '', exitCode: 0 };
        if (cmd.includes('merge-base')) return { stdout: 'basesha123\n', stderr: '', exitCode: 0 };
        if (cmd.includes('headsha123^{tree}')) return { stdout: 'treesha123\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      writeFile: async () => {},
      execWithStdin: async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
    };
    const transport = new ReviewTransport({
      createRunnerFor: () => runner,
      resolveWorkdir: () => '/wt/dev',
    });
    await transport.readContent(task(), DEV, 'code');
    const fetch = seen.find(c => c.cmd.includes('git fetch origin'));
    expect(fetch).toBeDefined();
    expect(fetch!.cmd).toContain(`${GIT_NET_ENV} git fetch origin --quiet`);
    expect(fetch!.timeout).toBe(NET_EXEC_TIMEOUT_MS);
  });

  it('retries a transient fetch failure before reading the diff', async () => {
    __setNetExecSleepForTests(async () => {});
    try {
      let fetchAttempts = 0;
      const runner = {
        exec: async (cmd: string): Promise<ExecResult> => {
          if (cmd.includes('git fetch origin')) {
            fetchAttempts++;
            return fetchAttempts === 1
              ? { stdout: '', stderr: 'fatal: unable to access: Could not resolve host: github.com', exitCode: 128 }
              : { stdout: '', stderr: '', exitCode: 0 };
          }
          if (cmd.includes('symbolic-ref')) return { stdout: 'origin/main\n', stderr: '', exitCode: 0 };
          if (cmd.includes('rev-parse HEAD')) return { stdout: 'headsha123\n', stderr: '', exitCode: 0 };
          if (cmd.includes('merge-base')) return { stdout: 'basesha123\n', stderr: '', exitCode: 0 };
          if (cmd.includes('headsha123^{tree}')) return { stdout: 'treesha123\n', stderr: '', exitCode: 0 };
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        writeFile: async () => {},
        execWithStdin: async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
      };
      const transport = new ReviewTransport({
        createRunnerFor: () => runner,
        resolveWorkdir: () => '/wt/dev',
      });
      await expect(transport.readContent(task(), DEV, 'code')).resolves.toBeDefined();
      expect(fetchAttempts).toBe(2);
    } finally {
      __setNetExecSleepForTests();
    }
  });

  it('wraps an exec timeout rejection as fetch-failed', async () => {
    __setNetExecSleepForTests(async () => {});
    try {
      const runner = {
        exec: async (cmd: string): Promise<ExecResult> => {
          if (cmd.includes('git fetch origin')) throw new Error('Command timed out after 60000ms');
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        writeFile: async () => {},
        execWithStdin: async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
      };
      const transport = new ReviewTransport({
        createRunnerFor: () => runner,
        resolveWorkdir: () => '/wt/dev',
      });
      await expect(transport.readContent(task(), DEV, 'code')).rejects.toThrow(
        expect.objectContaining({ reason: 'fetch-failed' }),
      );
    } finally {
      __setNetExecSleepForTests();
    }
  });
});

describe('readContent (spec)', () => {
  it('reads the spec doc from the worktree', async () => {
    const { transport, calls } = makeTransport([
      { match: c => c.startsWith('if [ -f') && c.includes('.baxian/spec.md'), result: { stdout: '# Spec\nbody' } },
    ]);
    const result = await transport.readContent(task({ phase: 'spec' }), DEV, 'spec');
    expect(result.content).toBe('# Spec\nbody');
    expect(result.documents).toEqual([{ relPath: '.baxian/spec.md', content: '# Spec\nbody' }]);
    expect(calls.find(call => call.startsWith('if [ -f'))).toContain('.baxian/spec.md');
  });

  it('throws when the spec doc is missing', async () => {
    const { transport } = makeTransport([
      { match: c => c.startsWith('if [ -f') && c.includes('.baxian/spec.md'), result: { exitCode: 4, stderr: 'No such file' } },
    ]);
    await expect(transport.readContent(task({ phase: 'spec' }), DEV, 'spec')).rejects.toThrow(
      expect.objectContaining({ reason: 'spec-missing' }),
    );
  });

  it('reads sorted research documents and renders them with path headings', async () => {
    const { transport } = makeTransport([
      { match: c => c.startsWith('if [ -f') && c.includes('.baxian/spec.md'), result: { stdout: '# Spec' } },
      {
        match: c => c.includes("find '/wt/dev/.baxian/research'") && c.includes('-print0'),
        result: { stdout: '/wt/dev/.baxian/research/z.md\0/wt/dev/.baxian/research/a.md\0' },
      },
      { match: c => c === "cat '/wt/dev/.baxian/research/a.md'", result: { stdout: '# A' } },
      { match: c => c === "cat '/wt/dev/.baxian/research/z.md'", result: { stdout: '# Z' } },
    ]);

    const result = await transport.readContent(task({ phase: 'spec' }), DEV, 'spec');

    expect(result.documents).toEqual([
      { relPath: '.baxian/spec.md', content: '# Spec' },
      { relPath: '.baxian/research/a.md', content: '# A' },
      { relPath: '.baxian/research/z.md', content: '# Z' },
    ]);
    expect(result.content).toContain('=== .baxian/research/a.md ===\n# A');
  });

  it('rejects symlinked research markdown files', async () => {
    const { transport } = makeTransport([
      { match: c => c.startsWith('if [ -f') && c.includes('.baxian/spec.md'), result: { stdout: '# Spec' } },
      { match: c => c.includes('-type l'), result: { exitCode: 5 } },
    ]);

    await expect(transport.readSpecDocuments(DEV)).rejects.toThrow(
      expect.objectContaining({ reason: 'research-docs-list-failed' }),
    );
  });
});

describe('readInterdiff', () => {
  const PREV = 'a'.repeat(40);
  const CUR = 'b'.repeat(40);

  it('runs a direct two-arg tree diff (not three-dot) with core.quotepath=false in the worktree', async () => {
    const { transport, calls } = makeTransport([
      { match: c => / diff\b/.test(c), result: { stdout: 'diff --git a/x b/x\n+y' } },
    ]);
    const out = await transport.readInterdiff(DEV, PREV, CUR);
    expect(out).toContain('diff --git');
    const diffCall = calls.find(c => c.includes('git -c core.quotepath=false diff'));
    expect(diffCall).toBeDefined();
    expect(diffCall).toContain(`diff '${PREV}' '${CUR}'`);
    expect(diffCall).not.toContain(`${PREV}...${CUR}`);
    expect(diffCall).toContain('/wt/dev');
  });

  it('throws interdiff-failed when git diff exits non-zero', async () => {
    const { transport } = makeTransport([
      { match: c => / diff\b/.test(c), result: { exitCode: 128, stderr: 'fatal: bad object' } },
    ]);
    await expect(transport.readInterdiff(DEV, PREV, CUR)).rejects.toThrow(
      expect.objectContaining({ reason: 'interdiff-failed' }),
    );
  });
});

describe('readInterdiff (e2e: real git, rewritten review head)', () => {
  it('shows only this round’s net delta between the two snapshots when the head was amended', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'review-interdiff-e2e-'));
    const runner = new LocalRunner();
    const git = async (argline: string): Promise<string> => {
      const r = await runner.exec(`git -C '${worktree}' ${argline}`);
      if (r.exitCode !== 0) throw new Error(`git ${argline} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    try {
      await git('init -q');
      await git('config user.email t@example.com');
      await git('config user.name tester');
      await writeFile(join(worktree, 'alpha.txt'), '0\n');
      await writeFile(join(worktree, 'beta.txt'), '0\n');
      await git('add -A');
      await git('commit -q -m base');

      // round-1 reviewed head: change alpha.txt
      await writeFile(join(worktree, 'alpha.txt'), '1\n');
      await git('add -A');
      await git('commit -q -m round1');
      const prev = await git('rev-parse HEAD');

      // round-2 reviewed head: amend (rewrite history) — keep alpha.txt, change beta.txt.
      // cur is no longer a descendant of prev; merge-base(prev, cur) regresses to base.
      await writeFile(join(worktree, 'beta.txt'), '2\n');
      await git('add -A');
      await git('commit -q --amend -m round2');
      const cur = await git('rev-parse HEAD');
      expect(cur).not.toBe(prev);

      const transport = new ReviewTransport({
        createRunnerFor: () => runner,
        resolveWorkdir: () => worktree,
      });
      const diff = await transport.readInterdiff(DEV, prev, cur);
      // only beta.txt changed this round; alpha.txt was already reviewed last round
      expect(diff).toContain('beta.txt');
      expect(diff).not.toContain('alpha.txt');

      // the discarded three-dot form would regress to the whole patchset and re-surface alpha.txt
      const threeDot = await git(`-c core.quotepath=false diff '${prev}...${cur}'`);
      expect(threeDot).toContain('alpha.txt');
      expect(threeDot).toContain('beta.txt');
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});

describe('readFindings / readResponse', () => {
  it('parses and validates findings.json', async () => {
    const { transport } = makeTransport([
      { match: c => c.includes('findings.json'), result: { stdout: FINDINGS_JSON } },
    ]);
    const findings = await transport.readFindings(task(), QA);
    expect(findings?.verdict).toBe('request-changes');
    expect(findings?.findings[0].id).toBe('f-1');
  });

  it('returns null when the file is missing', async () => {
    const { transport } = makeTransport([
      { match: c => c.includes('findings.json'), result: { exitCode: 1, stderr: 'cat: no such file' } },
    ]);
    expect(await transport.readFindings(task(), QA)).toBeNull();
  });

  it('throws on schema violation', async () => {
    const { transport } = makeTransport([
      { match: c => c.includes('findings.json'), result: { stdout: '{"round":1,"verdict":"maybe","findings":[]}' } },
    ]);
    await expect(transport.readFindings(task(), QA)).rejects.toThrow(ReviewExchangeError);
  });

  it('parses response.json and delete issues an ancestor-guarded rm -f', async () => {
    const { transport, calls } = makeTransport([
      { match: c => c.includes('response.json') && c.startsWith('cat'), result: { stdout: RESPONSE_JSON } },
    ]);
    const response = await transport.readResponse(task(), DEV);
    expect(response?.responses[0].action).toBe('fix');
    await transport.deleteResponse(DEV);
    const rm = calls.find(c => c.includes('rm -f --') && c.includes('response.json'));
    expect(rm).toBeDefined();
    expect(rm).toContain(`[ "$(cd -- '/wt/dev' 2>/dev/null && pwd -P)" = '/wt/dev' ]`);
    expect(rm).toContain("[ ! -L '/wt/dev/.baxian/review' ]");
    expect(rm).toContain("[ ! -L '/wt/dev/.baxian/review/response.json' ] && rm -f --");
  });

  it('preserves invalid response bytes and computes their digest before parsing', async () => {
    const raw = '{\n  "round": 1,\n';
    const { transport } = makeTransport([
      { match: c => c.includes('response.json') && c.startsWith('cat'), result: { stdout: raw } },
    ]);
    const result = await transport.readResponseWithRaw(task(), DEV);
    expect(result).toMatchObject({
      kind: 'invalid',
      raw,
    });
    if (result.kind !== 'invalid') throw new Error('expected invalid response');
    expect(result.responseDigest).toBe(
      'e4447dee699b34f682298ce615eaf945665aed197e14776dd0abd58cb9a29df0',
    );
    expect(result.schemaViolationCodes).toEqual(['malformed-json']);
  });

  it.each([
    ['exit 255', { exitCode: 255, stderr: 'ssh disconnected' }],
    ['transient stderr', { exitCode: 1, stderr: 'Connection timed out' }],
    ['transient stdout', { exitCode: 1, stdout: 'Connection reset by peer' }],
    ['transient stderr with exit zero', { exitCode: 0, stderr: 'Connection timed out' }],
  ])('classifies an unknown response read from %s without treating it as absent', async (_label, result) => {
    const { transport } = makeTransport([
      { match: c => c.includes('response.json') && c.startsWith('cat'), result },
    ]);
    await expect(transport.readResponseWithRaw(task(), DEV)).resolves.toMatchObject({
      kind: 'unknown',
      error: { reason: 'read-unknown' },
    });
  });

  it('fails closed instead of deleting when the exchange dir has been swapped for a symlink (real fs)', async () => {
    const worktree = await realpath(await mkdtemp(join(tmpdir(), 'review-exchange-symlink-')));
    const outside = await mkdtemp(join(tmpdir(), 'review-exchange-outside-'));
    try {
      const initialized = await new LocalRunner().exec(`git -C ${shellQuote(worktree)} init -q`);
      expect(initialized.exitCode).toBe(0);
      await writeFile(join(outside, 'response.json'), 'foreign-precious');
      await mkdir(join(worktree, '.baxian'), { recursive: true });
      await symlink(outside, join(worktree, '.baxian', 'review'));
      const transport = new ReviewTransport({
        createRunnerFor: () => new LocalRunner(),
        resolveWorkdir: () => worktree,
      });

      await expect(transport.deleteResponse(DEV)).rejects.toThrow(ReviewExchangeError);

      expect(await readFile(join(outside, 'response.json'), 'utf-8')).toBe('foreign-precious');
    } finally {
      await rm(worktree, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('clearDispatchOutputs', () => {
  it('clears stale review outputs and all spec documents before develop', async () => {
    const { transport, calls } = makeTransport([]);

    await transport.clearDispatchOutputs(DEV, '/wt/dev', 'develop');

    const command = calls.find(call => call.includes("rm -f -- '/wt/dev/.baxian/review/findings.json'"))!;
    expect(command).toContain("'/wt/dev/.baxian/review/findings.json'");
    expect(command).toContain("'/wt/dev/.baxian/review/response.json'");
    expect(command).toContain("'/wt/dev/.baxian/spec.md'");
    expect(calls.some(c => c.includes("rm -rf -- '/wt/dev/.baxian/research'"))).toBe(true);
  });

  it('removes Research handoff documents before the next real develop dispatch', async () => {
    const worktree = await realpath(await mkdtemp(join(tmpdir(), 'review-develop-cleanup-')));
    const runner = new LocalRunner();
    const specPath = join(worktree, '.baxian', 'spec.md');
    const researchDir = join(worktree, '.baxian', 'research');
    try {
      const initialized = await runner.exec(`git -C ${shellQuote(worktree)} init -q`);
      expect(initialized.exitCode).toBe(0);
      await mkdir(researchDir, { recursive: true });
      await writeFile(specPath, '# Previous Spec');
      await writeFile(join(researchDir, 'previous-task.md'), '# Previous Research');
      const transport = new ReviewTransport({
        createRunnerFor: () => runner,
        resolveWorkdir: () => worktree,
      });

      await transport.clearDispatchOutputs(DEV, worktree, 'develop');

      await expect(readFile(specPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(researchDir)).toEqual([]);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it('fails closed when stale output cleanup fails', async () => {
    const { transport } = makeTransport([
      { match: command => command.includes('rm -f --'), result: { exitCode: 1, stderr: 'permission denied' } },
    ]);

    await expect(transport.clearDispatchOutputs(QA, '/wt/qa', 'server-review'))
      .rejects.toThrow(expect.objectContaining({ reason: 'artifact-cleanup-failed' }));
  });

  it('fails closed when stale output cleanup has an unknown transport outcome with exit zero', async () => {
    const { transport } = makeTransport([
      { match: command => command.includes('rm -f --'), result: { exitCode: 0, stderr: 'Connection timed out' } },
    ]);

    await expect(transport.clearDispatchOutputs(QA, '/wt/qa', 'server-review'))
      .rejects.toThrow(expect.objectContaining({ reason: 'artifact-cleanup-failed' }));
  });

  it('fails closed when stale Research document cleanup fails before develop', async () => {
    const { transport } = makeTransport([
      {
        match: command => command.includes("rm -rf -- '/wt/dev/.baxian/research'"),
        result: { exitCode: 1, stderr: 'permission denied' },
      },
    ]);

    await expect(transport.clearDispatchOutputs(DEV, '/wt/dev', 'develop'))
      .rejects.toThrow(expect.objectContaining({
        reason: 'artifact-cleanup-failed',
        message: expect.stringContaining('failed to clear stale research docs'),
      }));
  });

  it('fails closed when Research cleanup has an unknown transport outcome with exit zero', async () => {
    const { transport } = makeTransport([
      {
        match: command => command.includes("rm -rf -- '/wt/dev/.baxian/research'"),
        result: { exitCode: 0, stderr: 'Connection reset by peer' },
      },
    ]);

    await expect(transport.clearDispatchOutputs(DEV, '/wt/dev', 'develop'))
      .rejects.toThrow(expect.objectContaining({ reason: 'artifact-cleanup-failed' }));
  });
});

describe('readFileRange security contract', () => {
  const ok: Rule[] = [
    { match: c => c.startsWith('sed'), result: { stdout: 'line80\nline81' } },
  ];

  it('reads a valid range after the symlink walk', async () => {
    const { transport, calls } = makeTransport(ok);
    const text = await transport.readFileRange(DEV, 'src/a.ts', 80, 120);
    expect(text).toBe('line80\nline81');
    expect(calls.some(c => c.includes('-L "$p"'))).toBe(true);
    expect(calls.some(c => c.includes('realpath'))).toBe(false);
    expect(calls.some(c => c.includes("'80,120p'"))).toBe(true);
  });

  it.each([
    ['/etc/passwd', 1, 10, 'abs-path'],
    ['a/../../x', 1, 10, 'traversal'],
    ['-flag.ts', 1, 10, 'leading-dash'],
    ['bad\nname', 1, 10, 'ctrl-char'],
    ['a.ts', 10, 5, 'range'],
    ['a.ts', 1, 300, 'range'],
  ])('rejects %s (%d-%d) with %s', async (file, start, end, reason) => {
    const { transport } = makeTransport(ok);
    await expect(transport.readFileRange(DEV, file, start, end)).rejects.toThrow(
      expect.objectContaining({ reason }),
    );
  });

  it('rejects symlinked components via the walk', async () => {
    const { transport } = makeTransport([
      { match: c => c.includes('-L "$p"'), result: { exitCode: 9 } },
    ]);
    await expect(transport.readFileRange(DEV, 'link.ts', 1, 10)).rejects.toThrow(
      expect.objectContaining({ reason: 'escape' }),
    );
  });

  it('truncates output beyond MAX_READ_FILE_BYTES', async () => {
    const big = 'x'.repeat(60 * 1024);
    const { transport } = makeTransport([
      { match: c => c.startsWith('realpath'), result: { stdout: '/wt/dev/src/a.ts\n' } },
      { match: c => c.startsWith('sed'), result: { stdout: big } },
    ]);
    const text = await transport.readFileRange(DEV, 'src/a.ts', 1, 200);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(50 * 1024 + 64);
    expect(text).toContain('[truncated]');
  });
});

describe('validators', () => {
  it('accepts approve with empty findings', () => {
    expect(() => validateReviewFindings({ round: 1, verdict: 'approve', findings: [] })).not.toThrow();
  });

  it('rejects duplicate finding ids', () => {
    expect(() => validateReviewFindings({
      round: 1,
      verdict: 'request-changes',
      findings: [
        { id: 'f-1', severity: 'major', message: 'a' },
        { id: 'f-1', severity: 'minor', message: 'b' },
      ],
    })).toThrow(ReviewExchangeError);
  });

  it('rejects unknown severity and missing message', () => {
    expect(() => validateReviewFindings({
      round: 1, verdict: 'request-changes',
      findings: [{ id: 'f-1', severity: 'blocker', message: 'x' }],
    })).toThrow(ReviewExchangeError);
    expect(() => validateReviewFindings({
      round: 1, verdict: 'request-changes',
      findings: [{ id: 'f-1', severity: 'major' }],
    })).toThrow(ReviewExchangeError);
  });

  it('rejects approve carrying non-minor findings', () => {
    expect(() => validateReviewFindings({
      round: 1, verdict: 'approve',
      findings: [{ id: 'f-1', severity: 'major', message: 'blocker' }],
    })).toThrow(expect.objectContaining({ reason: 'verdict-conflict' }));
    expect(() => validateReviewFindings({
      round: 1, verdict: 'approve',
      findings: [{ id: 'f-1', severity: 'minor', message: 'nit' }],
    })).not.toThrow();
  });

  it('rejects request-changes with no findings', () => {
    expect(() => validateReviewFindings({
      round: 1, verdict: 'request-changes', findings: [],
    })).toThrow(expect.objectContaining({ reason: 'verdict-conflict' }));
  });

  it('rejects response with unknown action or empty rationale', () => {
    expect(() => validateReviewResponse({
      round: 1, ...RESPONSE_GENERATION,
      responses: [{ findingId: 'f-1', action: 'ignore', rationale: 'x' }],
    })).toThrow(expect.objectContaining({ violationCode: 'invalid-action' }));
    expect(() => validateReviewResponse({
      round: 1, ...RESPONSE_GENERATION,
      responses: [{ findingId: 'f-1', action: 'reject', rationale: '' }],
    })).toThrow(expect.objectContaining({ violationCode: 'missing-rationale' }));
  });
});

describe('response validators', () => {
  it('rejects duplicate response findingIds', () => {
    expect(() => validateReviewResponse({
      round: 1,
      ...RESPONSE_GENERATION,
      responses: [
        { findingId: 'f-1', action: 'fix', rationale: 'a' },
        { findingId: 'f-1', action: 'reject', rationale: 'b' },
      ],
    })).toThrow(expect.objectContaining({ reason: 'schema', violationCode: 'duplicate-finding-id' }));
  });

  it.each([
    ['token', { findingsDigest: 'a'.repeat(64) }, 'missing-or-invalid-token'],
    ['findings digest', { token: 'abcdef123456' }, 'missing-or-invalid-findings-digest'],
  ])('requires the response %s generation field', (_label, generation, violationCode) => {
    expect(() => validateReviewResponse({
      round: 1,
      ...generation,
      responses: [],
    })).toThrow(expect.objectContaining({ violationCode }));
  });
});

describe('deliverToInbox', () => {
  const QA_WT = '/wt/qa';

  it('writes a temp sibling then renames to the final name, returns relative path and byte size', async () => {
    const { transport, calls, writes } = makeTransport([]);
    const content = '# spec\n内容';
    const ref = await transport.deliverToInbox(QA, QA_WT, 'spec-round-2.md', content);
    expect(ref).toEqual({
      path: '.baxian/review/inbox/spec-round-2.md',
      bytes: Buffer.byteLength(content, 'utf8'),
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toMatch(/^\/wt\/qa\/\.baxian\/review\/inbox\/\.tmp-[0-9a-f]{12}$/);
    expect(writes[0].content).toBe(content);
    const mv = calls.find(c => c.includes('mv -f --'));
    expect(mv).toBeDefined();
    expect(mv).toContain(writes[0].path);
    expect(mv).toContain("'/wt/qa/.baxian/review/inbox/spec-round-2.md'");
  });

  it('strips a trailing slash from the worktree path', async () => {
    const { transport, writes } = makeTransport([]);
    await transport.deliverToInbox(QA, '/wt/qa/', 'findings-round-1.json', '{}');
    expect(writes[0].path.startsWith('/wt/qa/.baxian/')).toBe(true);
  });

  it('mv failure removes the temp file and throws deliver-failed, final name never targeted twice', async () => {
    const { transport, calls } = makeTransport([
      { match: c => c.includes('mv -f --'), result: { exitCode: 1, stderr: 'disk full' } },
      { match: c => c.includes('rm -f --') && c.includes('.tmp-'), result: { stdout: 'BX_SWEEP_REMOVED' } },
    ]);
    await expect(
      transport.deliverToInbox(QA, QA_WT, 'diff-round-1.patch', 'x'),
    ).rejects.toThrow(expect.objectContaining({ reason: 'deliver-failed' }));
    expect(calls.some(c => c.includes('rm -f --') && c.includes('.tmp-'))).toBe(true);
  });

  it('logs a resolved non-zero rm while cleaning the temp file after mv failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { transport } = makeTransport([
        { match: c => c.includes('mv -f --'), result: { exitCode: 1, stderr: 'disk full' } },
        { match: c => c.includes('rm -f --') && c.includes('/.tmp-'), result: { exitCode: 255, stderr: 'Connection timed out during banner exchange' } },
      ]);
      await expect(
        transport.deliverToInbox(QA, QA_WT, 'diff-round-1.patch', 'x'),
      ).rejects.toThrow(expect.objectContaining({ reason: 'deliver-failed' }));
      expect(warn.mock.calls.some(c =>
        String(c[0]).includes('[fs] sweep') && String(c[0]).includes('outcome UNKNOWN') && String(c[0]).includes('exit 255'),
      )).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs a resolved non-zero rm while cleaning the spec temp after a failed replace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { transport } = makeTransport([
        { match: c => c.includes('mv -f --'), result: { exitCode: 1, stderr: 'disk full' } },
        { match: c => c.includes('rm -f --') && c.includes('/.tmp-'), result: { exitCode: 1, stderr: 'rm: permission denied' } },
      ]);
      await expect(
        transport.replaceSpecDocuments(QA, '/wt/qa', [{ relPath: '.baxian/spec.md', content: 'x' }], async () => {}),
      ).rejects.toThrow(expect.objectContaining({ reason: 'spec-seed-failed' }));
      expect(warn.mock.calls.some(c =>
        String(c[0]).includes('[fs] sweep') && String(c[0]).includes('rm: permission denied'),
      )).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('a staging-write failure surfaces as deliver-failed and sweeps the partially-written tmp', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    const failing = new ReviewTransport({
      createRunnerFor: () => ({
        exec: async (cmd: string) => { calls.push(cmd); return { stdout: '', stderr: '', exitCode: 0 }; },
        writeFile: async () => {},
        execWithStdin: async () => { throw new Error('ssh down'); },
      }),
      resolveWorkdir: () => '/wt/qa',
    });
    await expect(
      failing.deliverToInbox(QA, QA_WT, 'spec-round-1.md', 'x'),
    ).rejects.toThrow(expect.objectContaining({ reason: 'deliver-failed' }));
    expect(calls.some(c => c.includes('rm -f --') && /\/wt\/qa\/\.baxian\/review\/inbox\/\.tmp-[0-9a-f]{12}/.test(c))).toBe(true);
  });

  it('an exec-layer rejection on mv still sweeps the tmp and maps to deliver-failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    const rejecting = new ReviewTransport({
      createRunnerFor: () => ({
        exec: async (cmd: string) => {
          calls.push(cmd);
          if (cmd.includes('mv -f --')) throw new Error('socket hang up');
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        writeFile: async () => {},
        execWithStdin: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      }),
      resolveWorkdir: () => '/wt/qa',
    });
    await expect(
      rejecting.deliverToInbox(QA, QA_WT, 'diff-round-1.patch', 'x'),
    ).rejects.toThrow(expect.objectContaining({ reason: 'deliver-failed' }));
    const sweeps = calls.filter(c => c.includes('rm -f --'));
    expect(sweeps.some(c => /\/wt\/qa\/\.baxian\/review\/inbox\/\.tmp-[0-9a-f]{12}'/.test(c))).toBe(true);
    expect(sweeps.some(c => /\/wt\/qa\/\.baxian\/review\/inbox\/diff-round-1\.patch\/\.tmp-[0-9a-f]{12}'/.test(c))).toBe(true);
  });

  it.each([
    ['sub/dir.md', 'has a path separator'],
    ['../escape.md', 'traverses upward'],
    ['.secret.md', 'leads with a dot'],
    ['', 'is empty'],
  ])('rejects filename %s (%s)', async (filename) => {
    const { transport } = makeTransport([]);
    await expect(
      transport.deliverToInbox(QA, QA_WT, filename, 'x'),
    ).rejects.toThrow(expect.objectContaining({ reason: 'bad-filename' }));
  });
});

describe('deliverToInbox (e2e: real LocalRunner, real worktree dir)', () => {
  it('delivers a >10KB multibyte payload byte-identical to the final file, with a clean inbox dir', async () => {
    const worktree = await realpath(await mkdtemp(join(tmpdir(), 'review-inbox-e2e-')));
    try {
      const initialized = await new LocalRunner().exec(`git -C ${shellQuote(worktree)} init -q`);
      expect(initialized.exitCode).toBe(0);
      const transport = new ReviewTransport({
        createRunnerFor: () => new LocalRunner(),
        resolveWorkdir: () => worktree,
      });
      const content = `${'哈'.repeat(8000)}ascii-tail-${'x'.repeat(2000)}`;
      expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(10 * 1024);

      const ref = await transport.deliverToInbox(QA, worktree, 'findings-round-1.json', content);

      expect(ref).toEqual({
        path: '.baxian/review/inbox/findings-round-1.json',
        bytes: Buffer.byteLength(content, 'utf8'),
      });

      const onDisk = await readFile(join(worktree, ref.path));
      expect(onDisk.equals(Buffer.from(content, 'utf8'))).toBe(true);

      const inboxDir = join(worktree, '.baxian', 'review', 'inbox');
      const entries = await readdir(inboxDir);
      expect(entries).toEqual(['findings-round-1.json']);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it('fails closed on a directory-shaped inbox filename and leaves no nested tmp behind (real fs)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const worktree = await realpath(await mkdtemp(join(tmpdir(), 'review-inbox-dirfinal-')));
    try {
      const initialized = await new LocalRunner().exec(`git -C ${shellQuote(worktree)} init -q`);
      expect(initialized.exitCode).toBe(0);
      const transport = new ReviewTransport({
        createRunnerFor: () => new LocalRunner(),
        resolveWorkdir: () => worktree,
      });
      const trap = join(worktree, '.baxian', 'review', 'inbox', 'findings-round-1.json');
      await new LocalRunner().exec(`mkdir -p ${shellQuote(trap)}`);

      await expect(
        transport.deliverToInbox(QA, worktree, 'findings-round-1.json', 'payload'),
      ).rejects.toThrow(expect.objectContaining({ reason: 'deliver-failed' }));

      expect(await readdir(trap)).toEqual([]);
      const inbox = await readdir(join(worktree, '.baxian', 'review', 'inbox'));
      expect(inbox).toEqual(['findings-round-1.json']);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it('rejects a .baxian symlink before writing outside the Workdir', async () => {
    const worktree = await realpath(await mkdtemp(join(tmpdir(), 'review-inbox-symlink-')));
    const outside = await mkdtemp(join(tmpdir(), 'review-inbox-outside-'));
    try {
      const initialized = await new LocalRunner().exec(`git -C ${shellQuote(worktree)} init -q`);
      expect(initialized.exitCode).toBe(0);
      await symlink(outside, join(worktree, '.baxian'));
      const transport = new ReviewTransport({
        createRunnerFor: () => new LocalRunner(),
        resolveWorkdir: () => worktree,
      });

      await expect(
        transport.deliverToInbox(QA, worktree, 'findings-round-1.json', 'secret'),
      ).rejects.toMatchObject({ reason: 'unsafe-runtime-path' });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(worktree, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('resolveServerPayloads', () => {
  const QA_WT = '/wt/qa';
  const big = (seed: string) => seed.repeat(Math.ceil((MAX_INLINE_CONTENT_BYTES + 1) / seed.length));
  const atCap = 'a'.repeat(MAX_INLINE_CONTENT_BYTES);

  it('keeps content at exactly the split line inline, no delivery', async () => {
    const { transport, writes } = makeTransport([]);
    const out = await resolveServerPayloads(transport, QA, QA_WT, {
      phase: 'server-spec-review', specRound: 1, reviewRound: 0, serverContent: atCap,
    });
    expect(out).toEqual({ serverContent: atCap });
    expect(writes).toHaveLength(0);
  });

  it('delivers spec content one byte over the line as spec-round-<specRound>.md', async () => {
    const { transport, writes } = makeTransport([]);
    const content = atCap + 'b';
    const out = await resolveServerPayloads(transport, QA, QA_WT, {
      phase: 'server-spec-review', specRound: 3, reviewRound: 0, serverContent: content,
    });
    expect(out.serverContent).toBeUndefined();
    expect(out.serverContentFile).toEqual({
      path: '.baxian/review/inbox/spec-round-3.md',
      bytes: MAX_INLINE_CONTENT_BYTES + 1,
    });
    expect(writes[0].content).toBe(content);
  });

  it('splits by byte length, not char length (multibyte content)', async () => {
    const { transport } = makeTransport([]);
    const multibyte = '哈'.repeat(4 * 1024); // 4096 chars, 12KB utf8
    const out = await resolveServerPayloads(transport, QA, QA_WT, {
      phase: 'server-spec-review', specRound: 1, reviewRound: 0, serverContent: multibyte,
    });
    expect(out.serverContentFile?.bytes).toBe(Buffer.byteLength(multibyte, 'utf8'));
  });

  it('names oversized diff content by reviewRound', async () => {
    const { transport } = makeTransport([]);
    const out = await resolveServerPayloads(transport, QA, QA_WT, {
      phase: 'server-recheck', reviewRound: 2,
      serverContent: big('d'),
    });
    expect(out.serverContentFile?.path).toBe('.baxian/review/inbox/diff-round-2.patch');
  });

  it('names legacy batch diff content by reviewRound and batch index', async () => {
    const { transport } = makeTransport([]);
    const out = await resolveServerPayloads(transport, QA, QA_WT, {
      phase: 'server-recheck', reviewRound: 2, batch: { index: 1, total: 3 },
      serverContent: big('d'),
    });
    expect(out.serverContentFile?.path).toBe('.baxian/review/inbox/diff-round-2-batch-2.patch');
  });

  it('force-delivers small review diff content when the QA worktree already holds the head tree', async () => {
    const { transport, writes } = makeTransport([]);
    const out = await resolveServerPayloads(transport, QA, QA_WT, {
      phase: 'server-review', reviewRound: 1, serverContent: 'small diff', forceContentFile: true,
    });
    expect(out.serverContent).toBeUndefined();
    expect(out.serverContentFile).toEqual({
      path: '.baxian/review/inbox/diff-round-1.patch',
      bytes: 'small diff'.length,
    });
    expect(writes[0].content).toBe('small diff');
  });

  it('delivers oversized diffstat as diffstat-round-<reviewRound>.txt', async () => {
    const { transport, writes } = makeTransport([]);
    const out = await resolveServerPayloads(transport, QA, QA_WT, {
      phase: 'server-review', reviewRound: 3, serverContent: 'small diff', serverDiffstat: big('s'),
    });
    expect(out.serverContent).toBe('small diff');
    expect(out.serverDiffstat).toBeUndefined();
    expect(out.serverDiffstatFile).toEqual({
      path: '.baxian/review/inbox/diffstat-round-3.txt',
      bytes: MAX_INLINE_CONTENT_BYTES + 1,
    });
    expect(writes[0].content).toBe(big('s'));
  });

  it('review-side priors use prior-* names; each payload splits independently', async () => {
    const { transport, writes } = makeTransport([]);
    const out = await resolveServerPayloads(transport, QA, QA_WT, {
      phase: 'server-review', reviewRound: 4,
      serverContent: 'small diff',
      serverPriorFindings: big('f'),
      serverPriorResponse: 'small response',
    });
    expect(out.serverContent).toBe('small diff');
    expect(out.serverPriorFindingsFile?.path).toBe('.baxian/review/inbox/prior-findings-round-4.json');
    expect(out.serverPriorResponse).toBe('small response');
    expect(out.serverPriorResponseFile).toBeUndefined();
    expect(writes).toHaveLength(1);
  });

  it('server-feedback code findings go to findings-round-<reviewRound>.json', async () => {
    const { transport } = makeTransport([]);
    const out = await resolveServerPayloads(transport, DEV, '/wt/dev', {
      phase: 'server-feedback', taskPhase: 'code', specRound: 9, reviewRound: 5,
      serverPriorFindings: big('g'),
    });
    expect(out.serverPriorFindingsFile?.path).toBe('.baxian/review/inbox/findings-round-5.json');
  });

  it('server-feedback on a spec task rounds by specRound, not reviewRound', async () => {
    const { transport } = makeTransport([]);
    const out = await resolveServerPayloads(transport, DEV, '/wt/dev', {
      phase: 'server-feedback', taskPhase: 'spec', specRound: 7, reviewRound: 2,
      serverPriorFindings: big('h'),
    });
    expect(out.serverPriorFindingsFile?.path).toBe('.baxian/review/inbox/findings-round-7.json');
  });

  it('spec-side round falls back to 1 when specRound is absent', async () => {
    const { transport } = makeTransport([]);
    const out = await resolveServerPayloads(transport, QA, QA_WT, {
      phase: 'server-spec-review', reviewRound: 0, serverContent: big('s'),
    });
    expect(out.serverContentFile?.path).toBe('.baxian/review/inbox/spec-round-1.md');
  });

  it('non-spec round falls back to 1 when reviewRound is 0', async () => {
    const { transport } = makeTransport([]);
    const out = await resolveServerPayloads(transport, QA, QA_WT, {
      phase: 'server-review', reviewRound: 0, serverContent: big('d'),
    });
    expect(out.serverContentFile?.path).toBe('.baxian/review/inbox/diff-round-1.patch');
  });

  it('rejects serverContent under server-feedback (findings-only channel)', async () => {
    const { transport, writes } = makeTransport([]);
    await expect(resolveServerPayloads(transport, DEV, '/wt/dev', {
      phase: 'server-feedback', taskPhase: 'code', reviewRound: 1,
      serverContent: 'diff text',
      serverPriorFindings: '{}',
    })).rejects.toThrow(expect.objectContaining({ reason: 'unexpected-payload' }));
    expect(writes).toHaveLength(0);
  });

  it('returns empty opts when no payloads are present (server-after-done)', async () => {
    const { transport } = makeTransport([]);
    expect(await resolveServerPayloads(transport, DEV, '/wt/dev', {
      phase: 'server-after-done', reviewRound: 1,
    })).toEqual({});
  });

  it('propagates deliver failure', async () => {
    const { transport } = makeTransport([
      { match: c => c.includes('mv -f --'), result: { exitCode: 1, stderr: 'nope' } },
    ]);
    await expect(resolveServerPayloads(transport, QA, QA_WT, {
      phase: 'server-spec-review', specRound: 1, reviewRound: 0, serverContent: big('s'),
    })).rejects.toThrow(expect.objectContaining({ reason: 'deliver-failed' }));
  });

  it('keeps a small interdiff inline as serverInterdiff, alongside the full diff', async () => {
    const { transport, writes } = makeTransport([]);
    const out = await resolveServerPayloads(transport, QA, QA_WT, {
      phase: 'server-recheck', reviewRound: 3,
      serverContent: 'full diff', serverInterdiff: 'round delta',
    });
    expect(out.serverContent).toBe('full diff');
    expect(out.serverInterdiff).toBe('round delta');
    expect(out.serverInterdiffFile).toBeUndefined();
    expect(writes).toHaveLength(0);
  });

  it('delivers an oversized interdiff as interdiff-round-<reviewRound>.patch, splitting independently of the full diff', async () => {
    const { transport, writes } = makeTransport([]);
    const out = await resolveServerPayloads(transport, QA, QA_WT, {
      phase: 'server-recheck', reviewRound: 2,
      serverContent: 'small full diff', serverInterdiff: big('i'),
    });
    expect(out.serverContent).toBe('small full diff');
    expect(out.serverInterdiff).toBeUndefined();
    expect(out.serverInterdiffFile).toEqual({
      path: '.baxian/review/inbox/interdiff-round-2.patch',
      bytes: MAX_INLINE_CONTENT_BYTES + 1,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].content).toBe(big('i'));
  });
});
