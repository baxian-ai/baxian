import { describe, expect, it } from 'vitest';
import {
  ReviewExchangeError,
  ReviewTransport,
  shellQuote,
  validateReviewFindings,
  validateReviewResponse,
} from '../../src/agent/review-transport.js';
import type { ExecResult } from '../../src/agent/runner.js';
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
    reviewRound: 0,
    status: 'review',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    ...overrides,
  };
}

type Rule = { match: (cmd: string) => boolean; result: Partial<ExecResult> };

function makeTransport(rules: Rule[], worktree = '/wt/dev') {
  const calls: string[] = [];
  const runner = {
    exec: async (cmd: string): Promise<ExecResult> => {
      calls.push(cmd);
      const rule = rules.find(r => r.match(cmd));
      return { stdout: '', stderr: '', exitCode: 0, ...(rule?.result ?? {}) };
    },
    writeFile: async () => undefined,
    execWithStdin: async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
  };
  const transport = new ReviewTransport({
    createRunnerFor: () => runner,
    resolveWorktree: () => worktree,
  });
  return { transport, calls };
}

const FINDINGS_JSON = JSON.stringify({
  round: 1,
  verdict: 'request-changes',
  findings: [{ id: 'f-1', severity: 'major', message: 'broken', file: 'a.ts', line: 3 }],
});

const RESPONSE_JSON = JSON.stringify({
  round: 1,
  responses: [{ findingId: 'f-1', action: 'fix', rationale: 'fixed', commitSha: 'abc123' }],
});

describe('shellQuote', () => {
  it('wraps in single quotes and escapes embedded quotes', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe('readContent (code)', () => {
  it('fetches, detects default branch, captures merge-base and three-dot diff', async () => {
    const { transport, calls } = makeTransport([
      { match: c => c.includes('symbolic-ref'), result: { stdout: 'origin/main\n' } },
      { match: c => c.includes('merge-base'), result: { stdout: 'basesha123\n' } },
      { match: c => c.includes('--stat'), result: { stdout: ' a.ts | 2 +-\n' } },
      { match: c => / diff\b/.test(c) && !c.includes('--stat'), result: { stdout: 'diff --git a/a.ts b/a.ts\n+x' } },
    ]);
    const result = await transport.readContent(task(), DEV, 'code');
    expect(result.content).toContain('diff --git');
    expect(result.baseSha).toBe('basesha123');
    expect(result.defaultBranch).toBe('main');
    expect(result.diffstat).toContain('a.ts');
    expect(calls.some(c => c.includes('git fetch origin'))).toBe(true);
    expect(calls.some(c => c.includes("'origin/main...HEAD'"))).toBe(true);
  });

  it('runs diff and diffstat with core.quotepath=false so non-ascii paths stay verbatim', async () => {
    const { transport, calls } = makeTransport([
      { match: c => c.includes('symbolic-ref'), result: { stdout: 'origin/main\n' } },
      { match: c => c.includes('merge-base'), result: { stdout: 'basesha123\n' } },
      { match: c => c.includes('--stat'), result: { stdout: ' x | 1 +\n' } },
      { match: c => / diff\b/.test(c) && !c.includes('--stat'), result: { stdout: 'diff --git a/x b/x' } },
    ]);
    await transport.readContent(task(), DEV, 'code');
    const diffCalls = calls.filter(c => / diff\b/.test(c));
    expect(diffCalls).toHaveLength(2);
    for (const c of diffCalls) expect(c).toContain('-c core.quotepath=false');
  });

  it('throws ReviewExchangeError when diff fails', async () => {
    const { transport } = makeTransport([
      { match: c => c.includes('symbolic-ref'), result: { stdout: 'origin/main\n' } },
      { match: c => / diff\b/.test(c) && !c.includes('--stat'), result: { exitCode: 128, stderr: 'fatal' } },
    ]);
    await expect(transport.readContent(task(), DEV, 'code')).rejects.toThrow(ReviewExchangeError);
  });

  it.each([
    ['git fetch', 'fetch-failed'],
    ['symbolic-ref', 'default-branch-failed'],
    ['merge-base', 'merge-base-failed'],
    ['--stat', 'diffstat-failed'],
  ])('fails loud when %s step fails (%s)', async (step, reason) => {
    const { transport } = makeTransport([
      { match: c => c.includes('symbolic-ref') && step !== 'symbolic-ref', result: { stdout: 'origin/main\n' } },
      { match: c => c.includes(step), result: { exitCode: 1, stderr: 'boom' } },
    ]);
    await expect(transport.readContent(task(), DEV, 'code')).rejects.toThrow(
      expect.objectContaining({ reason }),
    );
  });
});

describe('readContent (spec)', () => {
  it('cats the spec doc from the worktree', async () => {
    const { transport, calls } = makeTransport([
      { match: c => c.startsWith('cat '), result: { stdout: '# Spec\nbody' } },
    ]);
    const result = await transport.readContent(task(), DEV, 'spec');
    expect(result.content).toBe('# Spec\nbody');
    expect(calls[0]).toContain('.baxian/spec.md');
  });

  it('throws when the spec doc is missing', async () => {
    const { transport } = makeTransport([
      { match: c => c.startsWith('cat '), result: { exitCode: 1, stderr: 'No such file' } },
    ]);
    await expect(transport.readContent(task(), DEV, 'spec')).rejects.toThrow(ReviewExchangeError);
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

  it('parses response.json and delete issues rm -f', async () => {
    const { transport, calls } = makeTransport([
      { match: c => c.includes('response.json') && c.startsWith('cat'), result: { stdout: RESPONSE_JSON } },
    ]);
    const response = await transport.readResponse(task(), DEV);
    expect(response?.responses[0].action).toBe('fix');
    await transport.deleteResponse(DEV);
    expect(calls.some(c => c.startsWith('rm -f') && c.includes('response.json'))).toBe(true);
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
      round: 1, responses: [{ findingId: 'f-1', action: 'ignore', rationale: 'x' }],
    })).toThrow(ReviewExchangeError);
    expect(() => validateReviewResponse({
      round: 1, responses: [{ findingId: 'f-1', action: 'reject', rationale: '' }],
    })).toThrow(ReviewExchangeError);
  });
});

describe('response validators', () => {
  it('rejects duplicate response findingIds', () => {
    expect(() => validateReviewResponse({
      round: 1,
      responses: [
        { findingId: 'f-1', action: 'fix', rationale: 'a' },
        { findingId: 'f-1', action: 'reject', rationale: 'b' },
      ],
    })).toThrow(expect.objectContaining({ reason: 'schema' }));
  });
});
