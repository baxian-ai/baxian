import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPromptInline,
  buildPostMergeCleanupPrompt,
  MAX_PROMPT_BYTES,
  MAX_INLINE_FINDINGS_BYTES,
  PromptSizeError,
  RequiredSkillsMissingError,
} from '../../src/agent/prompt.js';
import {
  buildPhaseSignal,
  buildPhaseSignalTemplate,
  scanPhaseSignals,
} from '../../src/agent/phase-signal.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import type { AgentConfig, TaskState } from '../../src/shared/index.js';

const TASK: TaskState = {
  id: 'task-001',
  projectId: 'kongkong',
  title: 'Fix login redirect',
  description: 'Reproduce on Safari and adjust router guard.',
  preferredAgentId: 'dev-1',
  agentId: 'dev-1',
  reviewRound: 0,
  status: 'pending',
  createdAt: '2026-04-28T10:00:00Z',
  updatedAt: '2026-04-28T10:00:00Z',
};

// Server phases force-load no skill (AGENT_PHASES declares skills: [] for them), so these
// blocks just need an empty registry with the shared per-test temp-dir lifecycle.
function useServerPhaseRegistry(prefix: string): () => SkillRegistry {
  let tempDir: string;
  let registry: SkillRegistry;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), prefix));
    registry = new SkillRegistry(tempDir);
    await registry.scan();
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  return () => registry;
}

describe('buildPromptInline', () => {
  let tempDir: string;
  let registry: SkillRegistry;

  const DEV_AGENT: AgentConfig = {
    id: 'dev-1',
    runtime: 'claude-code',
    role: 'dev',
    mode: 'local',
    workdir: '/tmp/repo',
    yolo: true,
  };

  async function makeSkill(name: string, content: string, helpers: Record<string, string> = {}): Promise<void> {
    const dir = join(tempDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), content);
    for (const [path, body] of Object.entries(helpers)) {
      const full = join(dir, path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, body);
    }
  }

  // Every phase referenced by these tests declares some subset of the standard
  // skills; seed all of them by default so buildPromptInline's fail-fast does
  // not reject. Individual tests can overwrite a specific skill with custom
  // content (writeFile is destructive) before scanning.
  async function seedAllPhaseSkills(): Promise<void> {
    await makeSkill('baxian-task-check', 'task-check stub');
    await makeSkill('baxian-pr-feedback', 'pr-feedback stub');
    await makeSkill('baxian-pr-review', 'pr-review stub');
    await makeSkill('baxian-pr-recheck', 'pr-recheck stub');
  }

  // The dominant shape: seed every phase skill, scan, then build with DEV_AGENT defaults.
  async function seedAndScan(): Promise<void> {
    await seedAllPhaseSkills();
    await registry.scan();
  }

  // A few tests need the real SKILL.md bodies (verdict-verification phase blocks live there);
  // seed stubs first, then overwrite the named skills with their shipped content, then scan.
  async function seedRealSkillsAndScan(names: string[]): Promise<void> {
    await seedAllPhaseSkills();
    for (const name of names) {
      const body = await readFile(
        fileURLToPath(new URL(`../../../../skills/${name}/SKILL.md`, import.meta.url)),
        'utf-8',
      );
      await makeSkill(name, body);
    }
    await registry.scan();
  }

  function build(extra: Partial<Parameters<typeof buildPromptInline>[0]> = {}): string {
    return buildPromptInline({
      task: TASK,
      phase: 'develop',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
      ...extra,
    });
  }

  const QA_AGENT: AgentConfig = { id: 'qa-1', runtime: 'claude-code', role: 'qa', mode: 'local', workdir: '/tmp/repo' };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'baxian-prompt-skills-'));
    registry = new SkillRegistry(tempDir);
  });

  it('dev develop force-loads the primary skill via /command, then the task body (claude-code sigil)', async () => {
    await seedAndScan();
    const prompt = build({ worktreePath: '/tmp/repo/.baxian-worktrees/task-001_abc' });
    expect(prompt.startsWith('/baxian-task-check\n')).toBe(true);
    expect(prompt).toContain('Phase: develop');
    expect(prompt).toContain('Role: dev');
    expect(prompt).toContain('Task ID: task-001');
    expect(prompt).toContain('/tmp/repo/.baxian-worktrees/task-001_abc');
    expect(prompt).toContain('cd into the worktree before any file operations.');
    expect(prompt).toContain('baxian conventions: cross-agent communication is via the GitHub PR');
    expect(prompt).toContain('<!-- baxian:managed -->');
    expect(prompt).toContain('Title: Fix login redirect');
    // The XML skill-injection format is gone entirely.
    expect(prompt).not.toContain('<skills>');
    expect(prompt).not.toContain('<task>');
    expect(prompt).not.toContain('<![CDATA[');
  });

  it('codex runtime uses the $ sigil to force-load the primary skill', async () => {
    await seedAndScan();
    const prompt = build({ agent: { ...DEV_AGENT, runtime: 'codex' } });
    expect(prompt.startsWith('$baxian-task-check\n')).toBe(true);
    const QA_CODEX: AgentConfig = { ...QA_AGENT, runtime: 'codex' };
    const reviewPrompt = build({
      task: { ...TASK, status: 'review', prNumber: 42 },
      phase: 'review',
      agent: QA_CODEX,
      signalToken: 'review-token-N',
    });
    expect(reviewPrompt.startsWith('$baxian-pr-review\n')).toBe(true);
  });

  it('imagePaths → appends a 附图 block listing every absolute path', async () => {
    await seedAndScan();
    const prompt = build({
      worktreePath: '/tmp/repo/.baxian-worktrees/task-001_abc',
      imagePaths: ['/tmp/baxian/upload/task-001/a.png', '/tmp/baxian/upload/task-001/b.webp'],
    });
    expect(prompt).toContain('附图');
    expect(prompt).toContain('请读取并结合任务分析');
    expect(prompt).toContain('/tmp/baxian/upload/task-001/a.png');
    expect(prompt).toContain('/tmp/baxian/upload/task-001/b.webp');
  });

  it('no imagePaths → no 附图 block', async () => {
    await seedAndScan();
    expect(build()).not.toContain('附图');
  });

  it('fix phase prompt tells dev to address every finding and emit pr-fixed', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'fixing', prNumber: 42, reviewRound: 2 },
      phase: 'fix',
      signalToken: 'fix-token-42',
    });
    expect(prompt.startsWith('/baxian-pr-feedback\n')).toBe(true);
    expect(prompt).toContain('Fix phase');
    expect(prompt).toContain('baxian-pr-feedback');
    expect(prompt).toContain('[bx:pr-fixed:<token>]');
    expect(prompt).toContain('fix-token-42');
  });

  it('fix phase prompt requires a signalToken', async () => {
    await seedAndScan();
    expect(() => build({
      task: { ...TASK, status: 'fixing', prNumber: 42, reviewRound: 2 },
      phase: 'fix',
    })).toThrow(/fix prompt requires signalToken/);
  });

  it('inlines the phase-signal substitution rule for signal-emitting phases only', async () => {
    await seedAndScan();
    // The "substitute the placeholders, never echo them" invariant must ride inline in the header —
    // else the agent emits a literal [bx:KIND:<token>] the watcher's strict scanner can't match and
    // the task hangs waiting on a signal.
    const withSignal = build({
      task: { ...TASK, status: 'fixing', prNumber: 42, reviewRound: 2 },
      phase: 'fix',
      signalToken: 'fix-token-42',
    });
    expect(withSignal).toContain('Phase signals:');
    expect(withSignal).toContain('substitute');
    expect(withSignal).toContain('never echo the `<…>` placeholder');
    // A phase with no pending signal (develop without a token) carries no signal rule.
    expect(build()).not.toContain('Phase signals:');
  });

  it('post-approve prompt tells dev to re-read PR feedback before merge', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'approved', prNumber: 42 },
      phase: 'post-approve',
      signalToken: 'post-token-42',
    });

    expect(prompt.startsWith('/baxian-pr-feedback\n')).toBe(true);
    expect(prompt).toContain('Post-approve PR feedback check');
    expect(prompt).toContain('baxian-pr-feedback');
    expect(prompt).not.toContain('post-approve-reply');
    expect(prompt).toContain('T_self');
    expect(prompt).toContain('EVERY non-self comment with created_at > T_self');
    expect(prompt).toContain('Idempotency');
    expect(prompt).toContain('re-fetch all sources before signaling');
    expect(prompt).toContain('server suppresses redispatches while you run');
    expect(prompt).toContain('do not emit pr-merge-ready when you pushed code');
    expect(prompt).toContain(buildPhaseSignalTemplate('pr-merge-ready'));
    expect(prompt).toContain('token: post-token-42');
    expect(prompt).not.toContain(buildPhaseSignal('pr-merge-ready', 'post-token-42'));
    expect(scanPhaseSignals(prompt)).toEqual([]);
    expect(prompt).toContain('Do not merge the PR yourself from this phase');
  });

  // redispatchCount>0 swaps the long preamble for an incremental nudge; count=0 keeps the full preamble.
  it.each<[string, number, string[], string[]]>([
    ['redispatch #3 uses the incremental nudge instead of the long preamble', 3,
      ['Post-approve recheck (redispatch #3)', 'New PR feedback arrived while you were running', 're-fetch one more time', buildPhaseSignalTemplate('pr-merge-ready'), 'token: post-token-42'],
      ['Post-approve PR feedback check:', 'idempotency rule that prevents', 'Do not merge the PR yourself from this phase']],
    ['redispatchCount=0 still emits the full preamble (first pass)', 0,
      ['Post-approve PR feedback check:'],
      ['Post-approve recheck (redispatch']],
  ])('post-approve %s', async (_label, postApproveRedispatchCount, contains, notContains) => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'approved', prNumber: 42 },
      phase: 'post-approve',
      signalToken: 'post-token-42',
      postApproveRedispatchCount,
    });
    for (const f of contains) expect(prompt).toContain(f);
    for (const f of notContains) expect(prompt).not.toContain(f);
  });

  // Excluding the primary (already-resident) skill drops its leading /command but leaves the body;
  // excluding any other skill keeps the leading command intact.
  it.each<[string, string[], string, string[], string[]]>([
    ['containing the primary drops the leading command, body unchanged', ['baxian-task-check'], 'Phase: develop', ['Title: Fix login redirect'], ['/baxian-task-check']],
    ['not naming the primary keeps the leading command', ['baxian-pr-review'], '/baxian-task-check\n', [], []],
  ])('excludeSkills %s', async (_label, excludeSkills, prefix, contains, notContains) => {
    await seedAndScan();
    const prompt = build({ worktreePath: '/tmp/repo/.baxian-worktrees/task-001_abc', excludeSkills });
    expect(prompt.startsWith(prefix)).toBe(true);
    for (const f of contains) expect(prompt).toContain(f);
    for (const f of notContains) expect(prompt).not.toContain(f);
  });

  // Each row leaves the phase-declared skill (baxian-task-check) out of the registry, then asserts
  // the required-skill check rejects. excludeSkills must NOT bypass it — the check is registry-wide,
  // not emit-wide.
  it.each<[string, string[], string[]]>([
    ['excludeSkills naming the required skill does not bypass the check', [], ['baxian-task-check']],
    ['the registry is empty', [], []],
  ])('buildPromptInline throws RequiredSkillsMissingError when %s', async (_label, seed, excludeSkills) => {
    for (const name of seed) await makeSkill(name, name);
    await registry.scan();
    expect(() => build({ excludeSkills })).toThrow(RequiredSkillsMissingError);
  });

  it('throws PromptSizeError when prompt > 80KB', async () => {
    const huge = { ...TASK, description: 'x'.repeat(MAX_PROMPT_BYTES + 1) };
    await seedAndScan();
    expect(() => build({ task: huge })).toThrow(PromptSizeError);
  });

  it('error message lists the missing phase-declared skill', async () => {
    // 'baxian-task-check' is declared by AGENT_PHASES.dev.develop but intentionally not seeded.
    await registry.scan();
    try {
      build();
      throw new Error('expected RequiredSkillsMissingError');
    } catch (err) {
      expect(err).toBeInstanceOf(RequiredSkillsMissingError);
      expect((err as RequiredSkillsMissingError).missing).toEqual(['baxian-task-check']);
      expect((err as Error).message).toContain('baxian-task-check');
    }
  });

  it('boundary: accepts a prompt at exactly the cap', async () => {
    await seedAndScan();
    const base = build({ task: { ...TASK, description: 'x' } });
    const overhead = Buffer.byteLength(base, 'utf8');
    const pad = 'x'.repeat(MAX_PROMPT_BYTES - overhead + 1);
    const prompt = build({ task: { ...TASK, description: pad } });
    expect(Buffer.byteLength(prompt, 'utf8')).toBe(MAX_PROMPT_BYTES);
  });

  it('empty description → prompt ends at the title, no dangling body', async () => {
    await seedAndScan();
    const prompt = build({ task: { ...TASK, description: '' } });
    expect(prompt).toContain(`Title: ${TASK.title}`);
    expect(prompt.endsWith(`Title: ${TASK.title}`)).toBe(true);
  });

  it('develop phase with signalToken references the SDD skill section and keeps the variable spec-done signal', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'in_progress' },
      signalToken: 'spec-token-1',
    });
    expect(prompt).toContain('Specification-Driven Development (SDD)');
    // SDD mechanics moved into the force-loaded baxian-task-check skill; the prompt only points at it.
    expect(prompt).toContain('follow baxian-task-check §Specification-Driven Development');
    // Both options render as a parallel bullet list (SDD vs Otherwise).
    expect(prompt).toContain('- Specification-Driven Development (SDD)');
    expect(prompt).toMatch(/- Otherwise proceed straight to implementing/);
    expect(prompt).not.toContain('(do NOT commit or push it)');
    expect(prompt).toContain(buildPhaseSignalTemplate('spec-done'));
    expect(prompt).toContain('token: spec-token-1');
    expect(prompt).toMatch(/proceed straight to implementing/);
    expect(prompt).toContain('ready for review (not Draft)');
    expect(prompt).toContain('gh pr ready');
    expect(prompt).toContain('do NOT use `--draft`');
    expect(prompt).not.toContain(buildPhaseSignal('spec-done', 'spec-token-1'));
    expect(scanPhaseSignals(prompt)).toEqual([]);
  });

  it('develop phase without signalToken excludes the spec signal block', async () => {
    await seedAndScan();
    const prompt = build({ task: { ...TASK, status: 'in_progress' } });
    expect(prompt).not.toContain('Specification-Driven Development (SDD)');
    expect(prompt).not.toContain('[bx:spec-done:');
  });

  it('server develop prompt points at the SDD skill section and never inlines the spec-commit copy', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'in_progress', reviewMode: 'server' },
      signalToken: 'spec-token-srv',
    });
    expect(prompt).toContain(buildPhaseSignalTemplate('spec-done'));
    expect(prompt).toContain('follow baxian-task-check §Specification-Driven Development');
    expect(prompt).not.toMatch(/commit locally, then signal/);
    expect(prompt).not.toContain('gh pr ready');
    expect(prompt).not.toContain('ready for review (not Draft)');
    expect(prompt).not.toContain('(do NOT commit or push it)');
    expect(scanPhaseSignals(prompt)).toEqual([]);
  });

  it('baxian-task-check skill carries the migrated SDD mechanics (write .baxian/spec.md, do NOT commit)', async () => {
    const body = await readFile(
      fileURLToPath(new URL('../../../../skills/baxian-task-check/SKILL.md', import.meta.url)),
      'utf-8',
    );
    expect(body).toContain('## Specification-Driven Development (SDD)');
    expect(body).toContain('.baxian/spec.md');
    expect(body).toContain('Do NOT commit or push it');
  });

  it.each([
    ['github chain', undefined, 'pr-created' as const],
    ['server chain', 'server' as const, 'code-done' as const],
  ])('develop prompt drops the spec route when hasQaPartner is false (%s)', async (_label, reviewMode, replacementSignal) => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'in_progress', reviewMode },
      signalToken: 'spec-token-1',
      hasQaPartner: false,
    });
    expect(prompt).not.toContain('Specification-Driven Development (SDD)');
    expect(prompt).not.toContain('[bx:spec-done:');
    expect(prompt).toContain(buildPhaseSignalTemplate(replacementSignal));
    expect(prompt).toContain('token: spec-token-1');
  });

  it('develop prompt keeps the spec route when hasQaPartner is true or omitted', async () => {
    await seedAndScan();
    for (const extra of [{ hasQaPartner: true }, {}]) {
      const prompt = build({
        task: { ...TASK, status: 'in_progress' },
        signalToken: 'spec-token-1',
        ...extra,
      });
      expect(prompt).toContain('Specification-Driven Development (SDD)');
      expect(prompt).toContain(buildPhaseSignalTemplate('spec-done'));
    }
  });

  it('review prompt uses `gh pr review <N>` with explicit PR number (detached HEAD worktree)', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'review', prNumber: 42 },
      phase: 'review',
      agent: QA_AGENT,
      signalToken: 'review-token-N',
    });
    expect(prompt.startsWith('/baxian-pr-review\n')).toBe(true);
    expect(prompt).toContain('Code review phase');
    expect(prompt).toContain('baxian-pr-review');
    expect(prompt).toContain('PR number: 42');
    expect(prompt).toContain('gh pr review 42');
    expect(prompt).toContain(`N=42`);
    expect(prompt).toContain(`TOKEN=review-token-N`);
    expect(prompt).toContain(buildPhaseSignalTemplate('pr-approved'));
    expect(prompt).toContain(buildPhaseSignalTemplate('pr-changes-requested'));
    // Stamps no longer inlined — agent builds them from the phase template + token.
    expect(prompt).not.toContain('<!-- baxian:pr-approved:review-token-N -->');
    expect(prompt).not.toContain('Output exactly one filled signal');
  });

  // Skill body is force-loaded via /command (no inlined "emit a signal" mandate); the prompt
  // carries the phase-builder verdict block. Anchor SHA present → pin the commit_id; absent → skip it.
  it.each<[string, string | undefined, string[], string[]]>([
    ['anchor SHA present', 'abc123def456',
      ['Verdict Verification', 'Review head SHA for §Verdict Verification: abc123def456', '422 fallback'],
      ['Output exactly one filled signal', 'skip the commit_id check']],
    ['anchor SHA unavailable', undefined,
      ['skip the commit_id check'],
      ['Review head SHA for §Verdict Verification']],
  ])('review prompt force-loads baxian-pr-review and handles verdict verification (%s)', async (_label, reviewHeadAnchorSha, contains, notContains) => {
    await seedRealSkillsAndScan(['baxian-pr-review']);
    const prompt = build({
      task: { ...TASK, status: 'review', prNumber: 42, reviewHeadAnchorSha },
      phase: 'review',
      agent: QA_AGENT,
      signalToken: 'review-token-N',
    });
    expect(prompt.startsWith('/baxian-pr-review\n')).toBe(true);
    for (const f of contains) expect(prompt).toContain(f);
    for (const f of notContains) expect(prompt).not.toContain(f);
  });

  it('recheck phase carries verdict verification section', async () => {
    await seedRealSkillsAndScan(['baxian-pr-recheck']);
    const prompt = build({
      task: { ...TASK, status: 'review', prNumber: 42, reviewRound: 2, reviewHeadAnchorSha: 'sha-recheck-789' },
      phase: 'recheck',
      agent: QA_AGENT,
      signalToken: 'recheck-token-N',
    });
    expect(prompt.startsWith('/baxian-pr-recheck\n')).toBe(true);
    expect(prompt).toContain('Verdict Verification');
    expect(prompt).toContain('Review head SHA for §Verdict Verification: sha-recheck-789');
  });

  it('code prompt asks dev to open the PR and emit pr-created signal', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'in_progress', phase: 'code' },
      phase: 'code',
      signalToken: 'code-token-1',
    });
    expect(prompt).toContain('Code phase');
    expect(prompt).toContain('Spec is approved');
    expect(prompt).toContain('gh pr create');
    expect(prompt).toContain('ready for review (not Draft)');
    expect(prompt).toContain('gh pr ready');
    expect(prompt).toContain(buildPhaseSignalTemplate('pr-created'));
    expect(prompt).toContain('token: code-token-1');
    // Spec now lives at the server-chain path, not docs/spec/<task-id>.md.
    expect(prompt).toContain('.baxian/spec.md');
    expect(prompt).not.toContain('docs/spec/');
  });


  it('signal emit block keeps the template + token on separate lines so the prompt itself never matches scanPhaseSignals', () => {
    expect(buildPhaseSignalTemplate('spec-done')).toBe('[bx:spec-done:<token>]');
    expect(scanPhaseSignals('[bx:spec-done:<token>]')).toEqual([]);
    expect(scanPhaseSignals(buildPhaseSignal('spec-done', 'abc123def456'))).toEqual([
      { kind: 'spec-done', token: 'abc123def456' },
    ]);
  });

  const CLEANUP_META = { prNumber: 42, taskId: 'task-007', branch: 'bx/task-007' } as const;

  type CleanupResult = Parameters<typeof buildPostMergeCleanupPrompt>[1];
  it.each<[string, CleanupResult, string[], string[]]>([
    [
      'deleted: declares the deletion + /clear handoff',
      { outcome: 'deleted', detail: '' },
      ['PR #42', 'task task-007', 'branch bx/task-007', 'baxian deleted the merged local feature branch `bx/task-007`', '`/clear`'],
      ['WARNING'],
    ],
    [
      'failed: WARNING + /compact handoff to preserve warning',
      { outcome: 'failed', detail: "error: Cannot delete branch 'bx/task-007' checked out at '/tmp/wt'" },
      ['WARNING: baxian failed to delete the local feature branch `bx/task-007`', "checked out at '/tmp/wt'", 'clean it up manually', '`/compact`'],
      ['`/clear`', 'baxian deleted the merged local feature branch'],
    ],
    [
      'absent: states it without claiming deletion + /clear handoff',
      { outcome: 'absent', detail: 'branch not found' },
      ['Local feature branch `bx/task-007` was already absent', '`/clear`'],
      ['baxian deleted the merged', 'WARNING'],
    ],
    [
      'skipped: uses /compact to preserve context',
      { outcome: 'skipped', detail: 'no repo path available' },
      ['`/compact`'],
      ['`/clear`'],
    ],
  ])('buildPostMergeCleanupPrompt %s', (_label, result, contains, notContains) => {
    const prompt = buildPostMergeCleanupPrompt(CLEANUP_META, result);
    for (const fragment of contains) expect(prompt).toContain(fragment);
    for (const fragment of notContains) expect(prompt).not.toContain(fragment);
  });

  it('buildPostMergeCleanupPrompt: never leaks agent-side git commands regardless of outcome', () => {
    const prompts = (['deleted', 'absent', 'failed', 'skipped'] as const).map(outcome =>
      buildPostMergeCleanupPrompt(
        { prNumber: 1, taskId: 't', branch: 'b' },
        { outcome, detail: 'x' },
      ),
    );
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/git fetch --prune origin/);
      expect(prompt).not.toMatch(/git symbolic-ref/);
      expect(prompt).not.toMatch(/git checkout/);
    }
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
});

describe('server review mode prompt builders', () => {
  const getRegistry = useServerPhaseRegistry('baxian-server-prompt-');

  const QA_AGENT: AgentConfig = { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local' };
  const DEV_AGENT: AgentConfig = { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' };

  function build(phase: string, agent: AgentConfig, extra: Record<string, unknown> = {}): string {
    return buildPromptInline({
      task: { ...TASK, reviewMode: 'server' },
      phase,
      agent,
      worktreePath: '/wt/x',
      skillRegistry: getRegistry(),
      signalToken: 'srvtok123456',
      ...extra,
    } as Parameters<typeof buildPromptInline>[0]);
  }

  const CODE_FINDINGS = '{"round":1,"verdict":"request-changes","findings":[]}';
  const SPEC_TASK = { task: { ...TASK, reviewMode: 'server', phase: 'spec' } };

  type Expect = { contains?: string[]; notContains?: string[]; matches?: RegExp[]; notMatches?: RegExp[] };
  function assertFragments(prompt: string, { contains = [], notContains = [], matches = [], notMatches = [] }: Expect): void {
    for (const f of contains) expect(prompt).toContain(f);
    for (const f of notContains) expect(prompt).not.toContain(f);
    for (const r of matches) expect(prompt).toMatch(r);
    for (const r of notMatches) expect(prompt).not.toMatch(r);
  }

  // Declarative harness: build one server-phase prompt, assert its fragments. Each row is
  // [label, phase, agent, buildExtra, expectations].
  it.each<[string, string, AgentConfig, Record<string, unknown>, Expect]>([
    ['server-review injects diff, diffstat, exchange path, signal template', 'server-review', QA_AGENT,
      { serverContent: 'diff --git a/a.ts b/a.ts\n+new line', serverDiffstat: ' a.ts | 1 +\n' },
      { contains: ['diff --git a/a.ts', 'a.ts | 1 +', '.baxian/review/findings.json', '[bx:code-reviewed:<token>]', 'srvtok123456', 'read-file', 'mv'] }],
    ['server-review labels batches', 'server-review', QA_AGENT,
      { serverContent: 'diff x', serverBatch: { index: 1, total: 3 } },
      { contains: ['Batch 2/3'] }],
    ['server-recheck includes prior findings and response blocks', 'server-recheck', QA_AGENT,
      { serverContent: 'diff y', serverPriorFindings: CODE_FINDINGS, serverPriorResponse: '{"round":1,"responses":[]}' },
      { contains: ['request-changes', 'responses', '[bx:code-reviewed:<token>]'] }],
    ['server-spec-review injects spec content and spec-reviewed signal', 'server-spec-review', QA_AGENT,
      { serverContent: '# Spec doc' },
      { contains: ['# Spec doc', '[bx:spec-reviewed:<token>]', 'location'] }],
    ['server-feedback spec variant never asks to commit (spec doc is git-excluded)', 'server-feedback', DEV_AGENT,
      { ...SPEC_TASK, serverPriorFindings: CODE_FINDINGS },
      { contains: ['(do NOT commit or push it)', '.baxian/spec.md', '[bx:spec-fixed:<token>]'], notContains: ['commitSha'], notMatches: [/commit;/, /, commit\b/] }],
    ['server-feedback code variant keeps the commit + commitSha wording', 'server-feedback', DEV_AGENT,
      { serverPriorFindings: CODE_FINDINGS },
      { contains: ['commit', 'commitSha', '[bx:code-fixed:<token>]'] }],
    ['server-feedback keeps the server-mode "do NOT push / no PR" constraint', 'server-feedback', DEV_AGENT,
      { serverPriorFindings: CODE_FINDINGS },
      { contains: ['Do NOT push to any remote and do NOT open a PR in this phase', 'publishing is deferred to the server-after-done phase'] }],
    ['server-recheck enforces the closure gate', 'server-recheck', QA_AGENT,
      { serverContent: 'diff y', serverPriorFindings: CODE_FINDINGS, serverPriorResponse: '{"round":1,"responses":[]}' },
      { contains: ['Verdict approve ONLY when every prior finding is closed AND the new diff is clean', 'reappears in findings.json with its ORIGINAL id', 're-raise it with concrete counter-evidence', 'behavior the fixes introduced that lacks test coverage'] }],
    ['server-review keeps the local-worktree-read + finding-id invariants', 'server-review', QA_AGENT,
      { serverContent: 'diff x' },
      { contains: ['read them directly from your own base-branch worktree', 'sequential and unique within findings.json'] }],
    ['server-spec-review offers read-file unconditionally', 'server-spec-review', QA_AGENT,
      { serverContent: '# spec' },
      { contains: ['Need a referenced file or codebase section to judge feasibility'] }],
    ['server-feedback keeps judge-independently + no-lazy-reject guards', 'server-feedback', DEV_AGENT,
      { serverPriorFindings: CODE_FINDINGS },
      { contains: ['Judge each independently', 'QA can be wrong', 'Never reject just to save effort'] }],
    ['server-after-done pr variant demands PR number in signal', 'server-after-done', DEV_AGENT,
      { serverAfterDone: { kind: 'pr', branch: 'bx/task-001' } },
      { contains: ['gh pr create', 'ready for review (not Draft)', 'gh pr ready', '[bx:code-ready:<pr_number>:<token>]', 'git push'] }],
    ['server-after-done branch variant uses plain code-ready', 'server-after-done', DEV_AGENT,
      { serverAfterDone: { kind: 'branch', branch: 'bx/task-001' } },
      { contains: ['[bx:code-ready:<token>]'], notContains: ['gh pr create', 'gh pr ready'] }],
    ['contentTruncated adds the truncation note', 'server-review', QA_AGENT,
      { serverContent: 'partial diff', contentTruncated: true },
      { contains: ['truncated'] }],
  ])('%s', (_label, phase, agent, extra, expectations) => {
    assertFragments(build(phase, agent, extra), expectations);
  });

  it('server-feedback picks signal by task phase', () => {
    const codePrompt = build('server-feedback', DEV_AGENT, { serverPriorFindings: CODE_FINDINGS });
    expect(codePrompt).toContain('[bx:code-fixed:<token>]');
    expect(codePrompt).toContain('.baxian/review/response.json');

    const specPrompt = build('server-feedback', DEV_AGENT, { ...SPEC_TASK, serverPriorFindings: '{}' });
    expect(specPrompt).toContain('[bx:spec-fixed:<token>]');
  });

  it('server review builders carry the judgment criteria (not just the I/O schema)', () => {
    const codeReview = build('server-review', QA_AGENT, { serverContent: 'diff x' });
    expect(codeReview).toContain('correctness, tests, edge cases, security, regressions');
    expect(codeReview).toContain('critical = broken/unsafe');
    const specReview = build('server-spec-review', QA_AGENT, { serverContent: '# spec' });
    expect(specReview).toContain('completeness');
    expect(specReview).toContain('ambiguity (any requirement readable two ways is a finding)');
  });

  it('conventions header is reviewMode-aware: server mode points at .baxian/review, not GitHub PR/Issue', () => {
    const serverPrompt = build('server-review', QA_AGENT, { serverContent: 'diff x' });
    expect(serverPrompt).toContain('server review mode');
    expect(serverPrompt).toContain('.baxian/review/*.json');
    expect(serverPrompt).not.toContain('cross-agent communication is via the GitHub PR');
    // GitHub mode (no reviewMode) keeps the PR/Issue conventions. `merge` needs only
    // baxian-rules, which this block seeds.
    const githubPrompt = buildPromptInline({
      task: TASK,
      phase: 'merge',
      agent: DEV_AGENT,
      worktreePath: '/wt/x',
      skillRegistry: getRegistry(),
    } as Parameters<typeof buildPromptInline>[0]);
    expect(githubPrompt).toContain('cross-agent communication is via the GitHub PR');
  });

  it('header keys on the phase, not reviewMode: SDD spec uses the server header on a GitHub-mode task; server-after-done keeps the GitHub header', () => {
    // GitHub-mode task (no reviewMode), but the SDD spec review runs the server-transit
    // phase → must use the .baxian/review header, not GitHub-PR.
    const sddSpec = buildPromptInline({
      task: TASK,
      phase: 'server-spec-review',
      agent: QA_AGENT,
      worktreePath: '/wt/x',
      skillRegistry: getRegistry(),
      signalToken: 'srvtok123456',
      serverContent: '# spec',
    } as Parameters<typeof buildPromptInline>[0]);
    expect(sddSpec).toContain('server review mode');
    expect(sddSpec).not.toContain('cross-agent communication is via the GitHub PR');
    // The publish phase's PR variant DOES open a PR → keeps the GitHub-PR header.
    const publish = build('server-after-done', DEV_AGENT, { serverAfterDone: { kind: 'pr', branch: 'bx/task-001' } });
    expect(publish).toContain('cross-agent communication is via the GitHub PR');
    // ...but the branch-only publish variant has no PR → server header (no managed marker).
    const branchPublish = build('server-after-done', DEV_AGENT, { serverAfterDone: { kind: 'branch', branch: 'bx/task-001' } });
    expect(branchPublish).toContain('server review mode');
    expect(branchPublish).not.toContain('cross-agent communication is via the GitHub PR');
  });

  it('every baxian skill disables implicit model-invocation (Claude frontmatter + Codex policy) so only baxian explicitly invokes the per-phase skill', async () => {
    const skillsRoot = fileURLToPath(new URL('../../../../skills', import.meta.url));
    for (const name of ['baxian-task-check', 'baxian-pr-feedback', 'baxian-pr-review', 'baxian-pr-recheck']) {
      const md = await readFile(join(skillsRoot, name, 'SKILL.md'), 'utf-8');
      expect(md).toContain('disable-model-invocation: true');
      const policy = await readFile(join(skillsRoot, name, 'agents', 'openai.yaml'), 'utf-8');
      expect(policy).toContain('allow_implicit_invocation: false');
    }
  });

  it('server phases without signalToken throw', () => {
    expect(() => buildPromptInline({
      task: { ...TASK, reviewMode: 'server' },
      phase: 'server-review',
      agent: QA_AGENT,
      worktreePath: '/wt/x',
      skillRegistry: getRegistry(),
      serverContent: 'diff',
    } as Parameters<typeof buildPromptInline>[0])).toThrow(/requires signalToken/);
  });
});

describe('server-phase prompt builders (managed-PR marker, findings compaction)', () => {
  const getRegistry = useServerPhaseRegistry('baxian-r8-');
  const DEV_AGENT: AgentConfig = { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' };

  it('server-after-done pr prompt demands the managed-PR marker', async () => {
    const prompt = buildPromptInline({
      task: { ...TASK, reviewMode: 'server' },
      phase: 'server-after-done',
      agent: DEV_AGENT,
      worktreePath: '/wt/x',
      skillRegistry: getRegistry(),
      signalToken: 'srvtok123456',
      serverAfterDone: { kind: 'pr', branch: 'bx/task-001' },
    } as Parameters<typeof buildPromptInline>[0]);
    expect(prompt).toContain('<!-- baxian:managed -->');
  });

  it('oversized findings injection keeps every finding id (messages compacted)', async () => {
    const findings = {
      round: 1,
      verdict: 'request-changes',
      findings: Array.from({ length: 30 }, (_, i) => ({
        id: `f-${i + 1}`,
        severity: 'major',
        message: 'x'.repeat(800),
        file: `src/file-${i}.ts`,
        line: i + 1,
      })),
    };
    const json = JSON.stringify(findings);
    expect(Buffer.byteLength(json, 'utf8')).toBeGreaterThan(MAX_INLINE_FINDINGS_BYTES);
    const prompt = buildPromptInline({
      task: { ...TASK, reviewMode: 'server', reviewRound: 1 },
      phase: 'server-feedback',
      agent: DEV_AGENT,
      worktreePath: '/wt/x',
      skillRegistry: getRegistry(),
      signalToken: 'srvtok123456',
      serverPriorFindings: json,
    } as Parameters<typeof buildPromptInline>[0]);
    for (let i = 1; i <= 30; i++) {
      expect(prompt).toContain(`"id":"f-${i}"`);
    }
    expect(prompt).not.toContain('x'.repeat(800));
  });
});

describe('compactFindings ids-only tier', () => {
  const getRegistry = useServerPhaseRegistry('baxian-r9-');
  const DEV_AGENT: AgentConfig = { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' };

  it('pathological finding counts keep the full id set via the ids-only tier', async () => {
    const findings = {
      round: 1,
      verdict: 'request-changes',
      findings: Array.from({ length: 300 }, (_, i) => ({
        id: `f-${i + 1}`,
        severity: 'major',
        message: 'm'.repeat(120),
        file: `packages/server/src/some/deep/path/module-${i}.ts`,
        line: i + 1,
      })),
    };
    const prompt = buildPromptInline({
      task: { ...TASK, reviewMode: 'server', reviewRound: 1 },
      phase: 'server-feedback',
      agent: DEV_AGENT,
      worktreePath: '/wt/x',
      skillRegistry: getRegistry(),
      signalToken: 'srvtok123456',
      serverPriorFindings: JSON.stringify(findings),
    } as Parameters<typeof buildPromptInline>[0]);
    expect(prompt).toContain('"id":"f-1"');
    expect(prompt).toContain('"id":"f-300"');
    expect(prompt).toContain('messages omitted');
  });
});

describe('response compaction', () => {
  const getRegistry = useServerPhaseRegistry('baxian-r14-');
  const QA_AGENT: AgentConfig = { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local' };

  it('oversized prior responses keep every findingId/action (rationales compacted)', async () => {
    const response = {
      round: 1,
      responses: Array.from({ length: 40 }, (_, i) => ({
        findingId: `f-${i + 1}`,
        action: 'fix',
        rationale: 'r'.repeat(600),
        commitSha: `sha${i}`,
      })),
    };
    const prompt = buildPromptInline({
      task: { ...TASK, reviewMode: 'server', reviewRound: 2 },
      phase: 'server-recheck',
      agent: QA_AGENT,
      worktreePath: '/wt/x',
      skillRegistry: getRegistry(),
      signalToken: 'srvtok123456',
      serverContent: 'diff x',
      serverPriorResponse: JSON.stringify(response),
    } as Parameters<typeof buildPromptInline>[0]);
    for (let i = 1; i <= 40; i++) {
      expect(prompt).toContain(`"findingId":"f-${i}"`);
    }
    expect(prompt).not.toContain('r'.repeat(600));
  });
});
