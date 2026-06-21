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
    await makeSkill('baxian-rules', 'rules stub');
    await makeSkill('baxian-task-check', 'task-check stub');
    await makeSkill('baxian-pr-feedback', 'pr-feedback stub');
    await makeSkill('baxian-pr-review', 'pr-review stub');
    await makeSkill('baxian-pr-recheck', 'pr-recheck stub');
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'baxian-prompt-skills-'));
    registry = new SkillRegistry(tempDir);
  });

  it('dev develop force-loads the primary skill via /command, then the task body (claude-code sigil)', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    const prompt = buildPromptInline({
      task: TASK,
      phase: 'develop',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo/.baxian-worktrees/task-001_abc',
      skillRegistry: registry,
    });
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
    await seedAllPhaseSkills();
    await registry.scan();
    const CODEX_DEV: AgentConfig = { ...DEV_AGENT, runtime: 'codex' };
    const prompt = buildPromptInline({
      task: TASK,
      phase: 'develop',
      agent: CODEX_DEV,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
    });
    expect(prompt.startsWith('$baxian-task-check\n')).toBe(true);
    const QA_CODEX: AgentConfig = { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local', workdir: '/tmp/repo' };
    const reviewPrompt = buildPromptInline({
      task: { ...TASK, status: 'review', prNumber: 42 },
      phase: 'review',
      agent: QA_CODEX,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
      signalToken: 'review-token-N',
    });
    expect(reviewPrompt.startsWith('$baxian-pr-review\n')).toBe(true);
  });

  it('imagePaths → appends a 附图 block listing every absolute path', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    const prompt = buildPromptInline({
      task: TASK,
      phase: 'develop',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo/.baxian-worktrees/task-001_abc',
      skillRegistry: registry,
      imagePaths: ['/tmp/baxian/upload/task-001/a.png', '/tmp/baxian/upload/task-001/b.webp'],
    });
    expect(prompt).toContain('附图');
    expect(prompt).toContain('请读取并结合任务分析');
    expect(prompt).toContain('/tmp/baxian/upload/task-001/a.png');
    expect(prompt).toContain('/tmp/baxian/upload/task-001/b.webp');
  });

  it('no imagePaths → no 附图 block', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    const prompt = buildPromptInline({
      task: TASK,
      phase: 'develop',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
    });
    expect(prompt).not.toContain('附图');
  });

  it('fix phase prompt tells dev to address every finding and emit pr-fixed', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    const prompt = buildPromptInline({
      task: { ...TASK, status: 'fixing', prNumber: 42, reviewRound: 2 },
      phase: 'fix',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
      signalToken: 'fix-token-42',
    });
    expect(prompt.startsWith('/baxian-pr-feedback\n')).toBe(true);
    expect(prompt).toContain('Fix phase');
    expect(prompt).toContain('baxian-pr-feedback');
    expect(prompt).toContain('[bx:pr-fixed:<token>]');
    expect(prompt).toContain('fix-token-42');
  });

  it('fix phase prompt requires a signalToken', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    expect(() => buildPromptInline({
      task: { ...TASK, status: 'fixing', prNumber: 42, reviewRound: 2 },
      phase: 'fix',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
    })).toThrow(/fix prompt requires signalToken/);
  });

  it('inlines the baxian-rules phase-signal substitution rule for signal-emitting phases only', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    // baxian-rules is materialized but never force-loaded (single command slot + implicit
    // invocation disabled), so its §Phase Signals "substitute the placeholders, never echo them"
    // invariant must ride inline in the header — else the agent emits a literal [bx:KIND:<token>]
    // the watcher's strict scanner can't match and the task hangs waiting on a signal.
    const withSignal = buildPromptInline({
      task: { ...TASK, status: 'fixing', prNumber: 42, reviewRound: 2 },
      phase: 'fix',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
      signalToken: 'fix-token-42',
    });
    expect(withSignal).toContain('Phase signals:');
    expect(withSignal).toContain('substitute');
    expect(withSignal).toContain('never echo the `<…>` placeholder');
    // A phase with no pending signal (develop without a token) carries no signal rule.
    const noSignal = buildPromptInline({
      task: TASK,
      phase: 'develop',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
    });
    expect(noSignal).not.toContain('Phase signals:');
  });

  it('post-approve prompt tells dev to re-read PR feedback before merge', async () => {
    await seedAllPhaseSkills();
    await makeSkill('baxian-pr-feedback', 'feedback');
    await registry.scan();
    const prompt = buildPromptInline({
      task: { ...TASK, status: 'approved', prNumber: 42 },
      phase: 'post-approve',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
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

  it('post-approve redispatch uses incremental nudge instead of the long preamble', async () => {
    await seedAllPhaseSkills();
    await makeSkill('baxian-pr-feedback', 'feedback');
    await registry.scan();
    const prompt = buildPromptInline({
      task: { ...TASK, status: 'approved', prNumber: 42 },
      phase: 'post-approve',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
      signalToken: 'post-token-42',
      postApproveRedispatchCount: 3,
    });

    expect(prompt).toContain('Post-approve recheck (redispatch #3)');
    expect(prompt).toContain('New PR feedback arrived while you were running');
    expect(prompt).toContain('re-fetch one more time');
    // 完整长段被替换；agent context 里已有第一遍的规则。
    expect(prompt).not.toContain('Post-approve PR feedback check:');
    expect(prompt).not.toContain('idempotency rule that prevents');
    expect(prompt).not.toContain('Do not merge the PR yourself from this phase');
    expect(prompt).toContain(buildPhaseSignalTemplate('pr-merge-ready'));
    expect(prompt).toContain('token: post-token-42');
  });

  it('post-approve redispatchCount=0 still emits the full preamble (first pass)', async () => {
    await seedAllPhaseSkills();
    await makeSkill('baxian-pr-feedback', 'feedback');
    await registry.scan();
    const prompt = buildPromptInline({
      task: { ...TASK, status: 'approved', prNumber: 42 },
      phase: 'post-approve',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
      signalToken: 'post-token-42',
      postApproveRedispatchCount: 0,
    });

    expect(prompt).toContain('Post-approve PR feedback check:');
    expect(prompt).not.toContain('Post-approve recheck (redispatch');
  });

  it('excludeSkills containing the primary drops the leading command (skill already resident), body unchanged', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    const prompt = buildPromptInline({
      task: TASK,
      phase: 'develop',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo/.baxian-worktrees/task-001_abc',
      skillRegistry: registry,
      excludeSkills: ['baxian-task-check'],
    });
    expect(prompt.startsWith('Phase: develop')).toBe(true);
    expect(prompt).not.toContain('/baxian-task-check');
    expect(prompt).toContain('Title: Fix login redirect');
  });

  it('excludeSkills that does not name the primary keeps the leading command', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    const prompt = buildPromptInline({
      task: TASK,
      phase: 'develop',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo/.baxian-worktrees/task-001_abc',
      skillRegistry: registry,
      excludeSkills: ['baxian-rules'],
    });
    expect(prompt.startsWith('/baxian-task-check\n')).toBe(true);
  });

  it('buildPromptInline still throws RequiredSkillsMissingError when excludeSkills names a skill missing from registry', async () => {
    // Registry has baxian-rules but NOT baxian-task-check; excluding baxian-task-check should not
    // bypass the registry-required check. The check is registry-wide, not emit-wide.
    await makeSkill('baxian-rules', 'rules');
    await registry.scan();
    expect(() =>
      buildPromptInline({
        task: TASK,
        phase: 'develop',
        agent: DEV_AGENT,
        worktreePath: '/tmp/repo',
        skillRegistry: registry,
        excludeSkills: ['baxian-task-check'],
      }),
    ).toThrow(RequiredSkillsMissingError);
  });

  it('throws PromptSizeError when prompt > 80KB', async () => {
    const huge = { ...TASK, description: 'x'.repeat(MAX_PROMPT_BYTES + 1) };
    await seedAllPhaseSkills();
    await registry.scan();
    expect(() =>
      buildPromptInline({
        task: huge,
        phase: 'develop',
        agent: DEV_AGENT,
        worktreePath: '/tmp/repo',
        skillRegistry: registry,
      }),
    ).toThrow(PromptSizeError);
  });

  it('throws RequiredSkillsMissingError when baxian-rules is absent from registry', async () => {
    await makeSkill('baxian-task-check', 'check');
    // No baxian-rules created.
    await registry.scan();
    expect(() =>
      buildPromptInline({
        task: TASK,
        phase: 'develop',
        agent: DEV_AGENT,
        worktreePath: '/tmp/repo',
        skillRegistry: registry,
      }),
    ).toThrow(RequiredSkillsMissingError);
  });

  it('error message lists every missing required skill (global + phase-declared)', async () => {
    // baxian-rules (global required) AND baxian-task-check (phase-declared by dev.develop) both absent.
    await registry.scan();
    try {
      buildPromptInline({
        task: TASK,
        phase: 'develop',
        agent: DEV_AGENT,
        worktreePath: '/tmp/repo',
        skillRegistry: registry,
      });
      throw new Error('expected RequiredSkillsMissingError');
    } catch (err) {
      expect(err).toBeInstanceOf(RequiredSkillsMissingError);
      const missing = (err as RequiredSkillsMissingError).missing;
      expect(missing).toContain('baxian-rules');
      expect(missing).toContain('baxian-task-check');
      expect((err as Error).message).toContain('baxian-rules');
      expect((err as Error).message).toContain('baxian-task-check');
    }
  });

  it('throws when a phase-declared skill is missing even if baxian-rules is present', async () => {
    await makeSkill('baxian-rules', 'rules');
    // 'baxian-task-check' is declared by AGENT_PHASES.dev.develop but intentionally not seeded.
    await registry.scan();
    try {
      buildPromptInline({
        task: TASK,
        phase: 'develop',
        agent: DEV_AGENT,
        worktreePath: '/tmp/repo',
        skillRegistry: registry,
      });
      throw new Error('expected RequiredSkillsMissingError');
    } catch (err) {
      expect(err).toBeInstanceOf(RequiredSkillsMissingError);
      expect((err as RequiredSkillsMissingError).missing).toEqual(['baxian-task-check']);
    }
  });

  it('fail-fast even on phases that do not list baxian-rules — required check is registry-wide', async () => {
    // If for some reason a custom config drops baxian-rules entirely, every
    // buildPromptInline call should reject regardless of phase.
    await registry.scan(); // empty registry
    expect(() =>
      buildPromptInline({
        task: TASK,
        phase: 'develop',
        agent: DEV_AGENT,
        worktreePath: '/tmp/repo',
        skillRegistry: registry,
      }),
    ).toThrow(RequiredSkillsMissingError);
  });

  it('boundary: accepts a prompt at exactly the cap', async () => {
    await seedAllPhaseSkills();
    await makeSkill('baxian-task-check', 'tiny');
    await registry.scan();
    const empty = buildPromptInline({
      task: { ...TASK, description: '' },
      phase: 'develop',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
    });
    const overhead = Buffer.byteLength(empty, 'utf8');
    const pad = 'x'.repeat(MAX_PROMPT_BYTES - overhead);
    const prompt = buildPromptInline({
      task: { ...TASK, description: pad },
      phase: 'develop',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
    });
    expect(Buffer.byteLength(prompt, 'utf8')).toBe(MAX_PROMPT_BYTES);
  });

  it('develop phase with signalToken includes spec-done signal and opt-in copy (server chain)', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    const prompt = buildPromptInline({
      task: { ...TASK, status: 'in_progress' },
      phase: 'develop',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
      signalToken: 'spec-token-1',
    });
    expect(prompt).toContain('Specification-Driven Development (SDD)');
    expect(prompt).toContain(buildPhaseSignalTemplate('spec-done'));
    expect(prompt).toContain('token: spec-token-1');
    expect(prompt).toMatch(/proceed straight to implementing/);
    expect(prompt).toContain('(do NOT commit or push it)');
    expect(prompt).not.toContain(buildPhaseSignal('spec-done', 'spec-token-1'));
    expect(scanPhaseSignals(prompt)).toEqual([]);
  });

  it('develop phase without signalToken excludes the spec signal block', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    const prompt = buildPromptInline({
      task: { ...TASK, status: 'in_progress' },
      phase: 'develop',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
    });
    expect(prompt).not.toContain('Specification-Driven Development (SDD)');
    expect(prompt).not.toContain('[bx:spec-done:');
  });

  it('server develop prompt spec line does not ask to commit the spec', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    const prompt = buildPromptInline({
      task: { ...TASK, status: 'in_progress', reviewMode: 'server' },
      phase: 'develop',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
      signalToken: 'spec-token-srv',
    });
    expect(prompt).toContain(buildPhaseSignalTemplate('spec-done'));
    expect(prompt).not.toMatch(/commit locally, then signal/);
    expect(prompt).toContain('(do NOT commit or push it)');
    expect(scanPhaseSignals(prompt)).toEqual([]);
  });

  it('develop prompt drops the spec route when hasQaPartner is false (github chain)', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    const prompt = buildPromptInline({
      task: { ...TASK, status: 'in_progress' },
      phase: 'develop',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
      signalToken: 'spec-token-1',
      hasQaPartner: false,
    });
    expect(prompt).not.toContain('Specification-Driven Development (SDD)');
    expect(prompt).not.toContain('[bx:spec-done:');
    expect(prompt).toContain(buildPhaseSignalTemplate('pr-created'));
    expect(prompt).toContain('token: spec-token-1');
  });

  it('develop prompt drops the spec route when hasQaPartner is false (server chain)', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    const prompt = buildPromptInline({
      task: { ...TASK, status: 'in_progress', reviewMode: 'server' },
      phase: 'develop',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
      signalToken: 'spec-token-srv',
      hasQaPartner: false,
    });
    expect(prompt).not.toContain('Specification-Driven Development (SDD)');
    expect(prompt).not.toContain('[bx:spec-done:');
    expect(prompt).toContain(buildPhaseSignalTemplate('code-done'));
  });

  it('develop prompt keeps the spec route when hasQaPartner is true or omitted', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    for (const extra of [{ hasQaPartner: true }, {}]) {
      const prompt = buildPromptInline({
        task: { ...TASK, status: 'in_progress' },
        phase: 'develop',
        agent: DEV_AGENT,
        worktreePath: '/tmp/repo',
        skillRegistry: registry,
        signalToken: 'spec-token-1',
        ...extra,
      });
      expect(prompt).toContain('Specification-Driven Development (SDD)');
      expect(prompt).toContain(buildPhaseSignalTemplate('spec-done'));
    }
  });

  it('review prompt uses `gh pr review <N>` with explicit PR number (detached HEAD worktree)', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    const QA_AGENT: AgentConfig = {
      id: 'qa-1', runtime: 'claude-code', role: 'qa', mode: 'local', workdir: '/tmp/repo',
    };
    const prompt = buildPromptInline({
      task: { ...TASK, status: 'review', prNumber: 42 },
      phase: 'review',
      agent: QA_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
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
    // Stamps no longer inlined — agent builds them from baxian-rules template + token.
    expect(prompt).not.toContain('<!-- baxian:pr-approved:review-token-N -->');
    expect(prompt).not.toContain('Output exactly one filled signal');
  });

  it('review prompt force-loads baxian-pr-review and carries the verdict-verification phase block (anchor SHA present)', async () => {
    const realBaxianRules = await readFile(
      fileURLToPath(new URL('../../../../skills/baxian-rules/SKILL.md', import.meta.url)),
      'utf-8',
    );
    const realPrReview = await readFile(
      fileURLToPath(new URL('../../../../skills/baxian-pr-review/SKILL.md', import.meta.url)),
      'utf-8',
    );
    await seedAllPhaseSkills();
    await makeSkill('baxian-rules', realBaxianRules);
    await makeSkill('baxian-pr-review', realPrReview);
    await registry.scan();
    const QA_AGENT: AgentConfig = {
      id: 'qa-1', runtime: 'claude-code', role: 'qa', mode: 'local', workdir: '/tmp/repo',
    };
    const prompt = buildPromptInline({
      task: { ...TASK, status: 'review', prNumber: 42, reviewHeadAnchorSha: 'abc123def456' },
      phase: 'review',
      agent: QA_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
      signalToken: 'review-token-N',
    });
    // Skill body is force-loaded via /command, no longer inlined — the prompt carries no
    // unconditional "emit a signal" mandate and only the phase-builder verdict block.
    expect(prompt.startsWith('/baxian-pr-review\n')).toBe(true);
    expect(prompt).not.toContain('Output exactly one filled signal');
    expect(prompt).toContain('422 fallback');
    expect(prompt).toContain('Verdict Verification');
    expect(prompt).toContain('Review head SHA for §Verdict Verification: abc123def456');
    expect(prompt).not.toContain('skip the commit_id check');
  });

  it('review prompt tells QA to skip commit_id check when anchor SHA is unavailable', async () => {
    const realBaxianRules = await readFile(
      fileURLToPath(new URL('../../../../skills/baxian-rules/SKILL.md', import.meta.url)),
      'utf-8',
    );
    const realPrReview = await readFile(
      fileURLToPath(new URL('../../../../skills/baxian-pr-review/SKILL.md', import.meta.url)),
      'utf-8',
    );
    await seedAllPhaseSkills();
    await makeSkill('baxian-rules', realBaxianRules);
    await makeSkill('baxian-pr-review', realPrReview);
    await registry.scan();
    const QA_AGENT: AgentConfig = {
      id: 'qa-1', runtime: 'claude-code', role: 'qa', mode: 'local', workdir: '/tmp/repo',
    };
    const prompt = buildPromptInline({
      task: { ...TASK, status: 'review', prNumber: 42 },
      phase: 'review',
      agent: QA_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
      signalToken: 'review-token-N',
    });
    expect(prompt).toContain('skip the commit_id check');
    expect(prompt).not.toContain('Review head SHA for §Verdict Verification');
  });

  it('recheck phase carries verdict verification section', async () => {
    const realBaxianRules = await readFile(
      fileURLToPath(new URL('../../../../skills/baxian-rules/SKILL.md', import.meta.url)),
      'utf-8',
    );
    const realPrRecheck = await readFile(
      fileURLToPath(new URL('../../../../skills/baxian-pr-recheck/SKILL.md', import.meta.url)),
      'utf-8',
    );
    await seedAllPhaseSkills();
    await makeSkill('baxian-rules', realBaxianRules);
    await makeSkill('baxian-pr-recheck', realPrRecheck);
    await registry.scan();
    const QA_AGENT: AgentConfig = {
      id: 'qa-1', runtime: 'claude-code', role: 'qa', mode: 'local', workdir: '/tmp/repo',
    };
    const prompt = buildPromptInline({
      task: { ...TASK, status: 'review', prNumber: 42, reviewRound: 2, reviewHeadAnchorSha: 'sha-recheck-789' },
      phase: 'recheck',
      agent: QA_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
      signalToken: 'recheck-token-N',
    });
    expect(prompt.startsWith('/baxian-pr-recheck\n')).toBe(true);
    expect(prompt).toContain('Verdict Verification');
    expect(prompt).toContain('Review head SHA for §Verdict Verification: sha-recheck-789');
  });

  it('code prompt asks dev to open the PR and emit pr-created signal', async () => {
    await seedAllPhaseSkills();
    await registry.scan();
    const prompt = buildPromptInline({
      task: { ...TASK, status: 'in_progress', phase: 'code' },
      phase: 'code',
      agent: DEV_AGENT,
      worktreePath: '/tmp/repo',
      skillRegistry: registry,
      signalToken: 'code-token-1',
    });
    expect(prompt).toContain('Code phase');
    expect(prompt).toContain('Spec is approved');
    expect(prompt).toContain('gh pr create');
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

  it('buildPostMergeCleanupPrompt: deleted outcome declares the deletion + /clear handoff', () => {
    const prompt = buildPostMergeCleanupPrompt(
      { prNumber: 42, taskId: 'task-007', branch: 'bx/task-007' },
      { outcome: 'deleted', detail: '' },
    );
    expect(prompt).toContain('PR #42');
    expect(prompt).toContain('task task-007');
    expect(prompt).toContain('branch bx/task-007');
    expect(prompt).toContain('baxian deleted the merged local feature branch `bx/task-007`');
    expect(prompt).toContain('`/clear`');
    expect(prompt).not.toContain('WARNING');
  });

  it('buildPostMergeCleanupPrompt: failed outcome carries WARNING + /compact handoff to preserve warning', () => {
    const prompt = buildPostMergeCleanupPrompt(
      { prNumber: 42, taskId: 'task-007', branch: 'bx/task-007' },
      { outcome: 'failed', detail: "error: Cannot delete branch 'bx/task-007' checked out at '/tmp/wt'" },
    );
    expect(prompt).toContain('WARNING: baxian failed to delete the local feature branch `bx/task-007`');
    expect(prompt).toContain("checked out at '/tmp/wt'");
    expect(prompt).toContain('clean it up manually');
    expect(prompt).toContain('`/compact`');
    expect(prompt).not.toContain('`/clear`');
    expect(prompt).not.toContain('baxian deleted the merged local feature branch');
  });

  it('buildPostMergeCleanupPrompt: absent outcome states it without claiming deletion + /clear handoff', () => {
    const prompt = buildPostMergeCleanupPrompt(
      { prNumber: 42, taskId: 'task-007', branch: 'bx/task-007' },
      { outcome: 'absent', detail: 'branch not found' },
    );
    expect(prompt).toContain('Local feature branch `bx/task-007` was already absent');
    expect(prompt).toContain('`/clear`');
    expect(prompt).not.toContain('baxian deleted the merged');
    expect(prompt).not.toContain('WARNING');
  });

  it('buildPostMergeCleanupPrompt: skipped outcome uses /compact to preserve context', () => {
    const prompt = buildPostMergeCleanupPrompt(
      { prNumber: 42, taskId: 'task-007', branch: 'bx/task-007' },
      { outcome: 'skipped', detail: 'no repo path available' },
    );
    expect(prompt).toContain('`/compact`');
    expect(prompt).not.toContain('`/clear`');
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
  let tempDir: string;
  let registry: SkillRegistry;

  const QA_AGENT: AgentConfig = { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local' };
  const DEV_AGENT: AgentConfig = { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' };

  async function makeSkill(name: string, content: string): Promise<void> {
    const dir = join(tempDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), content);
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'baxian-server-prompt-'));
    registry = new SkillRegistry(tempDir);
    for (const name of ['baxian-rules']) {
      await makeSkill(name, `${name} stub`);
    }
    await registry.scan();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function build(phase: string, agent: AgentConfig, extra: Record<string, unknown> = {}): string {
    return buildPromptInline({
      task: { ...TASK, reviewMode: 'server' },
      phase,
      agent,
      worktreePath: '/wt/x',
      skillRegistry: registry,
      signalToken: 'srvtok123456',
      ...extra,
    } as Parameters<typeof buildPromptInline>[0]);
  }

  it('server-review injects diff, diffstat, exchange path, signal template', () => {
    const prompt = build('server-review', QA_AGENT, {
      serverContent: 'diff --git a/a.ts b/a.ts\n+new line',
      serverDiffstat: ' a.ts | 1 +\n',
    });
    expect(prompt).toContain('diff --git a/a.ts');
    expect(prompt).toContain('a.ts | 1 +');
    expect(prompt).toContain('.baxian/review/findings.json');
    expect(prompt).toContain('[bx:code-reviewed:<token>]');
    expect(prompt).toContain('srvtok123456');
    expect(prompt).toContain('read-file');
    expect(prompt).toContain('mv');
  });

  it('server-review labels batches', () => {
    const prompt = build('server-review', QA_AGENT, {
      serverContent: 'diff x',
      serverBatch: { index: 1, total: 3 },
    });
    expect(prompt).toContain('Batch 2/3');
  });

  it('server-recheck includes prior findings and response blocks', () => {
    const prompt = build('server-recheck', QA_AGENT, {
      serverContent: 'diff y',
      serverPriorFindings: '{"round":1,"verdict":"request-changes","findings":[]}',
      serverPriorResponse: '{"round":1,"responses":[]}',
    });
    expect(prompt).toContain('request-changes');
    expect(prompt).toContain('responses');
    expect(prompt).toContain('[bx:code-reviewed:<token>]');
  });

  it('server-spec-review injects spec content and spec-reviewed signal', () => {
    const prompt = build('server-spec-review', QA_AGENT, {
      serverContent: '# Spec doc',
    });
    expect(prompt).toContain('# Spec doc');
    expect(prompt).toContain('[bx:spec-reviewed:<token>]');
    expect(prompt).toContain('location');
  });

  it('server-feedback picks signal by task phase', () => {
    const codePrompt = build('server-feedback', DEV_AGENT, {
      serverPriorFindings: '{"round":1,"verdict":"request-changes","findings":[]}',
    });
    expect(codePrompt).toContain('[bx:code-fixed:<token>]');
    expect(codePrompt).toContain('.baxian/review/response.json');

    const specPrompt = buildPromptInline({
      task: { ...TASK, reviewMode: 'server', phase: 'spec' },
      phase: 'server-feedback',
      agent: DEV_AGENT,
      worktreePath: '/wt/x',
      skillRegistry: registry,
      signalToken: 'srvtok123456',
      serverPriorFindings: '{}',
    } as Parameters<typeof buildPromptInline>[0]);
    expect(specPrompt).toContain('[bx:spec-fixed:<token>]');
  });

  it('server-feedback spec variant never asks to commit (spec doc is git-excluded)', () => {
    const specPrompt = buildPromptInline({
      task: { ...TASK, reviewMode: 'server', phase: 'spec' },
      phase: 'server-feedback',
      agent: DEV_AGENT,
      worktreePath: '/wt/x',
      skillRegistry: registry,
      signalToken: 'srvtok123456',
      serverPriorFindings: '{"round":1,"verdict":"request-changes","findings":[]}',
    } as Parameters<typeof buildPromptInline>[0]);
    // No commit MANDATE and no commitSha field — the only 'commit' allowed is the
    // negative "do NOT commit" guard, matching the develop-prompt spec line.
    expect(specPrompt).not.toMatch(/commit;/);
    expect(specPrompt).not.toMatch(/, commit\b/);
    expect(specPrompt).not.toContain('commitSha');
    expect(specPrompt).toContain('(do NOT commit or push it)');
    expect(specPrompt).toContain('.baxian/spec.md');
    expect(specPrompt).toContain('[bx:spec-fixed:<token>]');
  });

  it('server-feedback code variant keeps the commit + commitSha wording', () => {
    const codePrompt = build('server-feedback', DEV_AGENT, {
      serverPriorFindings: '{"round":1,"verdict":"request-changes","findings":[]}',
    });
    expect(codePrompt).toContain('commit');
    expect(codePrompt).toContain('commitSha');
    expect(codePrompt).toContain('[bx:code-fixed:<token>]');
  });

  it('server-feedback keeps the server-mode "do NOT push / no PR" constraint (publishing deferred to server-after-done)', () => {
    const codePrompt = build('server-feedback', DEV_AGENT, {
      serverPriorFindings: '{"round":1,"verdict":"request-changes","findings":[]}',
    });
    expect(codePrompt).toContain('Do NOT push to any remote and do NOT open a PR in this phase');
    expect(codePrompt).toContain('publishing is deferred to the server-after-done phase');
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
      skillRegistry: registry,
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
      skillRegistry: registry,
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
    for (const name of ['baxian-rules', 'baxian-task-check', 'baxian-pr-feedback', 'baxian-pr-review', 'baxian-pr-recheck']) {
      const md = await readFile(join(skillsRoot, name, 'SKILL.md'), 'utf-8');
      expect(md).toContain('disable-model-invocation: true');
      const policy = await readFile(join(skillsRoot, name, 'agents', 'openai.yaml'), 'utf-8');
      expect(policy).toContain('allow_implicit_invocation: false');
    }
  });

  it('server-recheck enforces the closure gate (approve only when all closed + clean; reappear with original id; judge rejections; untested-behavior scan)', () => {
    const recheck = build('server-recheck', QA_AGENT, {
      serverContent: 'diff y',
      serverPriorFindings: '{"round":1,"verdict":"request-changes","findings":[]}',
      serverPriorResponse: '{"round":1,"responses":[]}',
    });
    expect(recheck).toContain('Verdict approve ONLY when every prior finding is closed AND the new diff is clean');
    expect(recheck).toContain('reappears in findings.json with its ORIGINAL id');
    expect(recheck).toContain('re-raise it with concrete counter-evidence');
    expect(recheck).toContain('behavior the fixes introduced that lacks test coverage');
  });

  it('server-review keeps the local-worktree-read + finding-id invariants', () => {
    const review = build('server-review', QA_AGENT, { serverContent: 'diff x' });
    expect(review).toContain('read them directly from your own base-branch worktree');
    expect(review).toContain('sequential and unique within findings.json');
  });

  it('server-spec-review offers read-file unconditionally (not only when content is truncated)', () => {
    const spec = build('server-spec-review', QA_AGENT, { serverContent: '# spec' });
    expect(spec).toContain('Need a referenced file or codebase section to judge feasibility');
  });

  it('server-feedback keeps judge-independently + no-lazy-reject guards', () => {
    const fb = build('server-feedback', DEV_AGENT, {
      serverPriorFindings: '{"round":1,"verdict":"request-changes","findings":[]}',
    });
    expect(fb).toContain('Judge each independently');
    expect(fb).toContain('QA can be wrong');
    expect(fb).toContain('Never reject just to save effort');
  });

  it('server-after-done pr variant demands PR number in signal', () => {
    const prompt = build('server-after-done', DEV_AGENT, {
      serverAfterDone: { kind: 'pr', branch: 'bx/task-001' },
    });
    expect(prompt).toContain('gh pr create');
    expect(prompt).toContain('[bx:code-ready:<pr_number>:<token>]');
    expect(prompt).toContain('git push');
  });

  it('server-after-done branch variant uses plain code-ready', () => {
    const prompt = build('server-after-done', DEV_AGENT, {
      serverAfterDone: { kind: 'branch', branch: 'bx/task-001' },
    });
    expect(prompt).not.toContain('gh pr create');
    expect(prompt).toContain('[bx:code-ready:<token>]');
  });

  it('server phases without signalToken throw', () => {
    expect(() => buildPromptInline({
      task: { ...TASK, reviewMode: 'server' },
      phase: 'server-review',
      agent: QA_AGENT,
      worktreePath: '/wt/x',
      skillRegistry: registry,
      serverContent: 'diff',
    } as Parameters<typeof buildPromptInline>[0])).toThrow(/requires signalToken/);
  });

  it('contentTruncated adds the truncation note', () => {
    const prompt = build('server-review', QA_AGENT, {
      serverContent: 'partial diff',
      contentTruncated: true,
    });
    expect(prompt).toContain('truncated');
  });
});

describe('server-phase prompt builders (managed-PR marker, findings compaction)', () => {
  let tempDir: string;
  let registry: SkillRegistry;
  const DEV_AGENT: AgentConfig = { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'baxian-r8-'));
    registry = new SkillRegistry(tempDir);
    for (const name of ['baxian-rules']) {
      const dir = join(tempDir, name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), `${name} stub`);
    }
    await registry.scan();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('server-after-done pr prompt demands the managed-PR marker', async () => {
    const prompt = buildPromptInline({
      task: { ...TASK, reviewMode: 'server' },
      phase: 'server-after-done',
      agent: DEV_AGENT,
      worktreePath: '/wt/x',
      skillRegistry: registry,
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
      skillRegistry: registry,
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
  let tempDir: string;
  let registry: SkillRegistry;
  const DEV_AGENT: AgentConfig = { id: 'dev-1', runtime: 'claude-code', role: 'dev', mode: 'local' };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'baxian-r9-'));
    registry = new SkillRegistry(tempDir);
    for (const name of ['baxian-rules']) {
      const dir = join(tempDir, name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), `${name} stub`);
    }
    await registry.scan();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

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
      skillRegistry: registry,
      signalToken: 'srvtok123456',
      serverPriorFindings: JSON.stringify(findings),
    } as Parameters<typeof buildPromptInline>[0]);
    expect(prompt).toContain('"id":"f-1"');
    expect(prompt).toContain('"id":"f-300"');
    expect(prompt).toContain('messages omitted');
  });
});

describe('response compaction', () => {
  let tempDir: string;
  let registry: SkillRegistry;
  const QA_AGENT: AgentConfig = { id: 'qa-1', runtime: 'codex', role: 'qa', mode: 'local' };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'baxian-r14-'));
    registry = new SkillRegistry(tempDir);
    for (const name of ['baxian-rules']) {
      const dir = join(tempDir, name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), `${name} stub`);
    }
    await registry.scan();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

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
      skillRegistry: registry,
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
