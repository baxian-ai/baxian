import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ReviewExchangeError,
  ReviewTransport,
  resolveServerPayloads,
  shellQuote,
  validateReviewFindings,
  validateReviewResponse,
} from '../../src/agent/review-transport.js';
import { MAX_INLINE_CONTENT_BYTES } from '../../src/shared/index.js';
import { LocalRunner } from '../../src/agent/runner.js';
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
  const writes: Array<{ path: string; content: string }> = [];
  const runner = {
    exec: async (cmd: string): Promise<ExecResult> => {
      calls.push(cmd);
      const rule = rules.find(r => r.match(cmd));
      return { stdout: '', stderr: '', exitCode: 0, ...(rule?.result ?? {}) };
    },
    writeFile: async (path: string, content: string | Buffer) => {
      writes.push({ path, content: content.toString() });
    },
    execWithStdin: async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
  };
  const transport = new ReviewTransport({
    createRunnerFor: () => runner,
    resolveWorktree: () => worktree,
  });
  return { transport, calls, writes };
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
    const mv = calls.find(c => c.startsWith('mv -f'));
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
      { match: c => c.startsWith('mv -f'), result: { exitCode: 1, stderr: 'disk full' } },
    ]);
    await expect(
      transport.deliverToInbox(QA, QA_WT, 'diff-round-1.patch', 'x'),
    ).rejects.toThrow(expect.objectContaining({ reason: 'deliver-failed' }));
    expect(calls.some(c => c.startsWith('rm -f') && c.includes('.tmp-'))).toBe(true);
  });

  it('writeFile failure surfaces as deliver-failed', async () => {
    const failing = new ReviewTransport({
      createRunnerFor: () => ({
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        writeFile: async () => { throw new Error('ssh down'); },
        execWithStdin: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      }),
      resolveWorktree: () => '/wt/qa',
    });
    await expect(
      failing.deliverToInbox(QA, QA_WT, 'spec-round-1.md', 'x'),
    ).rejects.toThrow(expect.objectContaining({ reason: 'deliver-failed' }));
  });

  it.each([
    ['sub/dir.md', 'has a path separator'],
    ['../escape.md', 'traverses upward'],
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
    const worktree = await mkdtemp(join(tmpdir(), 'review-inbox-e2e-'));
    try {
      const transport = new ReviewTransport({
        createRunnerFor: () => new LocalRunner(),
        resolveWorktree: () => worktree,
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

  it('names oversized diff content by reviewRound and batch', async () => {
    const { transport } = makeTransport([]);
    const out = await resolveServerPayloads(transport, QA, QA_WT, {
      phase: 'server-recheck', reviewRound: 2, batch: { index: 1, total: 3 },
      serverContent: big('d'),
    });
    expect(out.serverContentFile?.path).toBe('.baxian/review/inbox/diff-round-2-batch-2.patch');
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

  it('returns empty opts when no payloads are present (server-after-done)', async () => {
    const { transport } = makeTransport([]);
    expect(await resolveServerPayloads(transport, DEV, '/wt/dev', {
      phase: 'server-after-done', reviewRound: 1,
    })).toEqual({});
  });

  it('propagates deliver failure', async () => {
    const { transport } = makeTransport([
      { match: c => c.startsWith('mv -f'), result: { exitCode: 1, stderr: 'nope' } },
    ]);
    await expect(resolveServerPayloads(transport, QA, QA_WT, {
      phase: 'server-spec-review', specRound: 1, reviewRound: 0, serverContent: big('s'),
    })).rejects.toThrow(expect.objectContaining({ reason: 'deliver-failed' }));
  });
});
