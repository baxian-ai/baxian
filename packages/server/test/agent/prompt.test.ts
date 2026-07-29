import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPromptInline,
  buildGreetingPrompt,
  MAX_PROMPT_BYTES,
  PromptSizeError,
  RequiredSkillsMissingError,
} from '../../src/agent/prompt.js';
import { buildPhaseSignal, scanPhaseSignals } from '../../src/agent/phase-signal.js';
import { SkillRegistry } from '../../src/skill/registry.js';
import type { AgentConfig, TaskState } from '../../src/shared/index.js';

const TASK: TaskState = {
  id: 'task-001',
  projectId: 'kongkong',
  title: 'Fix login redirect',
  description: 'Reproduce on Safari and adjust router guard.',
  preferredAgentId: 'dev-1',
  agentId: 'dev-1',
  devAgentId: 'dev-1',
  phase: 'code',
  reviewRound: 0,
  status: 'pending',
  createdAt: '2026-04-28T10:00:00Z',
  updatedAt: '2026-04-28T10:00:00Z',
};
const REVIEW_PAIR = { passToken: 'abc123abc123', failToken: 'def456def456' } as const;

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

  async function seedAllPhaseSkills(): Promise<void> {
    await makeSkill('baxian-task-check', 'task-check stub');
    await makeSkill('baxian-pr-feedback', 'pr-feedback stub');
    await makeSkill('baxian-pr-review', 'pr-review stub');
    await makeSkill('baxian-pr-recheck', 'pr-recheck stub');
    await makeSkill('baxian-signals', 'signals stub');
  }

  async function seedAndScan(): Promise<void> {
    await seedAllPhaseSkills();
    await registry.scan();
  }

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
      workdir: '/tmp/repo',
      skillRegistry: registry,
      ...extra,
    });
  }

  function expectNoCompletionKindFields(prompt: string): void {
    expect(prompt).not.toMatch(/^(?:spec-)?signal:/m);
  }

  const QA_AGENT: AgentConfig = { id: 'qa-1', runtime: 'claude-code', role: 'qa', mode: 'local', workdir: '/tmp/repo' };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'baxian-prompt-skills-'));
    registry = new SkillRegistry(tempDir);
  });

  it('dev develop force-loads the primary skill via /command, then structured key:value dispatch fields', async () => {
    await seedAndScan();
    const prompt = build({ workdir: '/tmp/repo/.baxian-worktrees/task-001_abc' });
    expect(prompt.startsWith('/baxian-task-check\nphase: develop\n')).toBe(true);
    expect(prompt).not.toContain('[baxian]');
    expect(prompt).toContain('phase: develop');
    expect(prompt).not.toContain('role:');
    expect(prompt).not.toContain('task: task-001');
    expect(prompt).not.toContain('exchange:');
    expect(prompt).toContain('workdir: /tmp/repo/.baxian-worktrees/task-001_abc');
    expect(prompt).toContain('title: Fix login redirect');
    expect(prompt).not.toContain('cd into the worktree');
    expect(prompt).not.toContain('baxian conventions:');
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
      task: { ...TASK, status: 'review', prNumber: 42, ...REVIEW_PAIR },
      phase: 'review',
      agent: QA_CODEX,
      signalToken: 'review-token-N',
    });
    expect(reviewPrompt.startsWith('$baxian-pr-review\n')).toBe(true);
  });

  it('opencode and qodercli runtimes use the / sigil like claude-code', async () => {
    await seedAndScan();
    const oc = build({ agent: { ...DEV_AGENT, runtime: 'opencode' } });
    expect(oc.startsWith('/baxian-task-check\n')).toBe(true);
    const qo = build({ agent: { ...DEV_AGENT, runtime: 'qodercli' } });
    expect(qo.startsWith('/baxian-task-check\n')).toBe(true);
  });

  it('imagePaths → appends a structured images: list of every absolute path', async () => {
    await seedAndScan();
    const prompt = build({
      workdir: '/tmp/repo/.baxian-worktrees/task-001_abc',
      imagePaths: ['/tmp/baxian/upload/task-001/a.png', '/tmp/baxian/upload/task-001/b.webp'],
    });
    expect(prompt).toContain('images:');
    expect(prompt).toContain('/tmp/baxian/upload/task-001/a.png');
    expect(prompt).toContain('/tmp/baxian/upload/task-001/b.webp');
  });

  it('no imagePaths → no images: block', async () => {
    await seedAndScan();
    expect(build()).not.toContain('images:');
  });

  it('fix phase descriptor carries pr/branch/token without a completion kind, never round', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'fixing', prNumber: 42, reviewRound: 2 },
      phase: 'fix',
      signalToken: 'fix-token-42',
    });
    expect(prompt.startsWith('/baxian-pr-feedback\n')).toBe(true);
    expect(prompt).toContain('phase: fix');
    expect(prompt).toContain('pr: 42');
    expect(prompt).toContain('\nbranch: ');
    expect(prompt).not.toContain('round:');
    expect(prompt).toContain('token: fix-token-42');
    expectNoCompletionKindFields(prompt);
  });

  it('fix phase prompt requires a signalToken', async () => {
    await seedAndScan();
    expect(() => build({
      task: { ...TASK, status: 'fixing', prNumber: 42, reviewRound: 2 },
      phase: 'fix',
    })).toThrow(/fix prompt requires signalToken/);
  });

  it('represents completion dispatch as a token only, never a kind field or fireable literal', async () => {
    await seedAndScan();
    const withSignal = build({
      task: { ...TASK, status: 'fixing', prNumber: 42, reviewRound: 2 },
      phase: 'fix',
      signalToken: 'fix-token-42',
    });
    expect(withSignal).toContain('token: fix-token-42');
    expectNoCompletionKindFields(withSignal);
    expect(scanPhaseSignals(withSignal)).toEqual([]);
    expect(withSignal).not.toContain('[bx:pr-fixed:');
    const noSignal = build();
    expectNoCompletionKindFields(noSignal);
    expect(noSignal).not.toContain('token:');
  });

  it('post-approve descriptor carries pr + token without a completion kind', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'approved', prNumber: 42 },
      phase: 'post-approve',
      signalToken: 'post-token-42',
    });

    expect(prompt.startsWith('/baxian-pr-feedback\n')).toBe(true);
    expect(prompt).toContain('phase: post-approve');
    expect(prompt).toContain('pr: 42');
    expect(prompt).toContain('token: post-token-42');
    expectNoCompletionKindFields(prompt);
    expect(prompt).not.toContain('T_self');
    expect(prompt).not.toContain('redispatch:');
    expect(prompt).not.toContain(buildPhaseSignal('pr-merge-ready', 'post-token-42'));
    expect(scanPhaseSignals(prompt)).toEqual([]);
  });

  it('post-approve descriptor never carries a redispatch field (each prompt is the full rerun)', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'approved', prNumber: 42 },
      phase: 'post-approve',
      signalToken: 'post-token-42',
    });
    expectNoCompletionKindFields(prompt);
    expect(prompt).not.toContain('redispatch:');
  });

  it('every phase force-loads its /command — code reuses baxian-task-check yet still emits it', async () => {
    await seedAndScan();
    const codePrompt = build({ phase: 'code', signalToken: 'code-token-1' });
    expect(codePrompt.startsWith('/baxian-task-check\nphase: code\n')).toBe(true);
    expect(codePrompt).toContain('token: code-token-1');
    expectNoCompletionKindFields(codePrompt);
    const codexCode = build({ phase: 'code', signalToken: 'code-token-1', agent: { ...DEV_AGENT, runtime: 'codex' } });
    expect(codexCode.startsWith('$baxian-task-check\n')).toBe(true);
  });

  it('buildPromptInline throws RequiredSkillsMissingError when the phase skill is absent from the registry', async () => {
    await registry.scan();
    expect(() => build()).toThrow(RequiredSkillsMissingError);
  });

  it('requires baxian-signals only when a signalToken is present (rules moved into that skill)', async () => {
    await makeSkill('baxian-task-check', 'task-check stub');
    await makeSkill('baxian-pr-feedback', 'pr-feedback stub');
    await registry.scan();
    expect(() => build({
      task: { ...TASK, status: 'fixing', prNumber: 42, reviewRound: 2 },
      phase: 'fix',
      signalToken: 'fix-token-42',
    })).toThrow(RequiredSkillsMissingError);
    try {
      build({ phase: 'fix', signalToken: 'fix-token-42', task: { ...TASK, status: 'fixing', prNumber: 42, reviewRound: 2 } });
    } catch (err) {
      expect((err as RequiredSkillsMissingError).missing).toContain('baxian-signals');
    }
    expect(() => build({ phase: 'develop' })).not.toThrow();
  });

  it('throws PromptSizeError when prompt > 80KB', async () => {
    const huge = { ...TASK, description: 'x'.repeat(MAX_PROMPT_BYTES + 1) };
    await seedAndScan();
    expect(() => build({ task: huge })).toThrow(PromptSizeError);
  });

  it('error message lists the missing phase-declared skill', async () => {
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

  it('empty description → prompt ends at the title line, no dangling body', async () => {
    await seedAndScan();
    const prompt = build({ task: { ...TASK, description: '' } });
    expect(prompt).toContain(`title: ${TASK.title}`);
    expect(prompt.endsWith(`title: ${TASK.title}\n`)).toBe(true);
  });

  it('develop descriptor carries the token while completion routes live in the skill', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'in_progress' },
      signalToken: 'spec-token-1',
    });
    expect(prompt).toContain('token: spec-token-1');
    expectNoCompletionKindFields(prompt);
    expect(prompt).not.toContain('Specification-Driven Development');
    expect(prompt).not.toContain('gh pr ready');
    expect(prompt).not.toContain(buildPhaseSignal('spec-done', 'spec-token-1', 42, 'Nzc'));
    expect(scanPhaseSignals(prompt)).toEqual([]);
  });

  it('develop without signalToken carries neither token nor completion kind fields', async () => {
    await seedAndScan();
    const prompt = build({ task: { ...TASK, status: 'in_progress' } });
    expectNoCompletionKindFields(prompt);
    expect(prompt).not.toContain('token:');
  });

  it('review descriptor carries pr + token; verdict procedure lives in the skill', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'review', prNumber: 42, ...REVIEW_PAIR },
      phase: 'review',
      agent: QA_AGENT,
      signalToken: 'review-token-N',
    });
    expect(prompt.startsWith('/baxian-pr-review\n')).toBe(true);
    expect(prompt).toContain('phase: review');
    expect(prompt).toContain('pr: 42');
    expect(prompt).toContain('token: review-token-N');
    expect(prompt).not.toContain('signal:');
    expect(prompt).not.toContain('gh pr review');
    expect(scanPhaseSignals(prompt)).toEqual([]);
  });

  it.each<[string, string | undefined, string[], string[]]>([
    ['anchor SHA present', 'abc123def456', ['anchor-sha: abc123def456'], []],
    ['anchor SHA unavailable', undefined, [], ['anchor-sha:']],
  ])('review descriptor carries anchor-sha only when present (%s)', async (_label, reviewHeadAnchorSha, contains, notContains) => {
    await seedRealSkillsAndScan(['baxian-pr-review']);
    const prompt = build({
      task: { ...TASK, status: 'review', prNumber: 42, reviewHeadAnchorSha, ...REVIEW_PAIR },
      phase: 'review',
      agent: QA_AGENT,
      signalToken: 'review-token-N',
    });
    expect(prompt.startsWith('/baxian-pr-review\n')).toBe(true);
    for (const f of contains) expect(prompt).toContain(f);
    for (const f of notContains) expect(prompt).not.toContain(f);
  });

  it('recheck descriptor carries pr + anchor-sha; verdict procedure lives in the skill', async () => {
    await seedRealSkillsAndScan(['baxian-pr-recheck']);
    const prompt = build({
      task: {
        ...TASK, status: 'review', prNumber: 42, reviewRound: 2,
        reviewHeadAnchorSha: 'sha-recheck-789', ...REVIEW_PAIR,
      },
      phase: 'recheck',
      agent: QA_AGENT,
      signalToken: 'recheck-token-N',
    });
    expect(prompt.startsWith('/baxian-pr-recheck\n')).toBe(true);
    expect(prompt).toContain('phase: recheck');
    expect(prompt).toContain('pr: 42');
    expect(prompt).toContain('anchor-sha: sha-recheck-789');
    expect(prompt).toContain('token: recheck-token-N');
  });

  it('code descriptor carries the token without a completion kind field', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'in_progress', phase: 'code' },
      phase: 'code',
      signalToken: 'code-token-1',
    });
    expect(prompt).toContain('phase: code');
    expect(prompt).not.toContain('exchange:');
    expect(prompt).toContain('token: code-token-1');
    expectNoCompletionKindFields(prompt);
    expect(prompt).not.toContain('gh pr create');
    expect(prompt).not.toContain('docs/spec/');
  });

  it('signal emit block keeps the template + token on separate lines so the prompt itself never matches scanPhaseSignals', () => {
    expect(scanPhaseSignals('[bx:spec-done:<token>]')).toEqual([]);
    expect(scanPhaseSignals(buildPhaseSignal('spec-done', 'abc123def456', 42, 'Nzc'))).toEqual([
      { kind: 'spec-done', prNumber: 42, actorB64: 'Nzc', token: 'abc123def456' },
    ]);
  });

  describe('PR review descriptor', () => {
    const CLI = { tool: 'gh', host: 'github.com', repo: 'user/repo', repoEncoded: 'user%2Frepo' };
    const GIT_TASK: TaskState = {
      ...TASK,
      branch: 'bx/task-001',
      baseBranch: 'main',
    };

    it('develop carries the cli family and branch/base snapshot', async () => {
      await seedAndScan();
      const prompt = build({
        task: GIT_TASK,
        signalToken: 'dev-token-1',
        platformCli: { ...CLI, notes: 'instance runs behind :8443' },
      });
      expect(prompt).not.toContain('exchange:');
      expect(prompt).toContain('cli: gh');
      expect(prompt).toContain('cli-host: github.com');
      expect(prompt).toContain('cli-repo: user/repo');
      expect(prompt).toContain('cli-repo-encoded: user%2Frepo');
      expect(prompt).toContain('cli-notes: instance runs behind :8443');
      expect(prompt).toContain('branch: bx/task-001');
      expect(prompt).toContain('base: main');
      expectNoCompletionKindFields(prompt);
      expect(prompt).not.toContain('cli-binary');
      expect(prompt).not.toContain('cli-env');
    });

    it('code renders the same platform family as develop', async () => {
      await seedAndScan();
      const prompt = build({
        task: { ...GIT_TASK, status: 'in_progress', phase: 'code', prNumber: 42 },
        phase: 'code',
        signalToken: 'code-token-1',
        platformCli: CLI,
      });
      expect(prompt).not.toContain('exchange:');
      expect(prompt).toContain('cli: gh');
      expect(prompt).toContain('branch: bx/task-001');
      expect(prompt).toContain('base: main');
      expect(prompt).toContain('pr: 42');
      expect(prompt).not.toContain('cli-notes:');
    });

    it('omits base: when the task carries no snapshot', async () => {
      await seedAndScan();
      const { baseBranch: _unused, ...noBase } = GIT_TASK;
      const prompt = build({ task: noBase, signalToken: 'dev-token-2', platformCli: CLI });
      expect(prompt).toContain('branch: bx/task-001');
      expect(prompt).not.toMatch(/^base: /m);
    });

    it('review and recheck carry the minted token pair alongside the signal token', async () => {
      await seedAndScan();
      for (const phase of ['review', 'recheck'] as const) {
        const prompt = build({
          task: {
            ...GIT_TASK,
            status: 'review',
            prNumber: 42,
            reviewHeadAnchorSha: 'sha-review-1',
            passToken: 'a1b2c3d4e5f6',
            failToken: 'f6e5d4c3b2a1',
          },
          phase,
          agent: QA_AGENT,
          signalToken: 'qa-token-1',
          platformCli: CLI,
        });
        expect(prompt).toContain('cli: gh');
        expect(prompt).toContain('pass-token: a1b2c3d4e5f6');
        expect(prompt).toContain('fail-token: f6e5d4c3b2a1');
        expect(prompt).toContain('pr: 42');
        expect(prompt).toContain('token: qa-token-1');
        expect(prompt).not.toMatch(/^branch: /m);
      }
    });

    it('adds stage: spec only to spec review, recheck, and fix descriptors', async () => {
      await seedAndScan();
      for (const phase of ['review', 'recheck'] as const) {
        const specPrompt = build({
          task: {
            ...GIT_TASK,
            status: 'review',
            phase: 'spec',
            prNumber: 42,
            reviewHeadAnchorSha: 'sha-review-spec',
            passToken: 'a1b2c3d4e5f6',
            failToken: 'f6e5d4c3b2a1',
          },
          phase,
          agent: QA_AGENT,
          signalToken: 'qa-token-spec',
          platformCli: CLI,
        });
        expect(specPrompt).toContain('stage: spec');
      }
      const specFix = build({
        task: { ...GIT_TASK, status: 'fixing', phase: 'spec', prNumber: 42, specReviewRound: 2 },
        phase: 'fix',
        signalToken: 'fix-token-spec',
        platformCli: CLI,
      });
      expect(specFix).toContain('stage: spec');

      const codeReview = build({
        task: {
          ...GIT_TASK,
          status: 'review',
          phase: 'code',
          prNumber: 42,
          reviewHeadAnchorSha: 'sha-review-code',
          passToken: 'a1b2c3d4e5f6',
          failToken: 'f6e5d4c3b2a1',
        },
        phase: 'review',
        agent: QA_AGENT,
        signalToken: 'qa-token-code',
        platformCli: CLI,
      });
      expect(codeReview).not.toContain('stage: spec');
    });

    it('review for a git task without a minted pair fails loud', async () => {
      await seedAndScan();
      expect(() => build({
        task: { ...GIT_TASK, status: 'review', prNumber: 42, reviewHeadAnchorSha: 'sha-review-2' },
        phase: 'review',
        agent: QA_AGENT,
        signalToken: 'qa-token-2',
        platformCli: CLI,
      })).toThrow(/pass\/fail token pair/);
    });

    it('fix and post-approve carry the cli family without duplicating identity fields', async () => {
      await seedAndScan();
      const fixPrompt = build({
        task: { ...GIT_TASK, status: 'fixing', prNumber: 42, reviewRound: 1 },
        phase: 'fix',
        signalToken: 'fix-token-1',
        platformCli: CLI,
      });
      expect(fixPrompt).toContain('cli: gh');
      expect(fixPrompt.match(/^branch: /gm)).toHaveLength(1);
      const paPrompt = build({
        task: { ...GIT_TASK, status: 'approved', prNumber: 42 },
        phase: 'post-approve',
        signalToken: 'pa-token-1',
        platformCli: CLI,
      });
      expect(paPrompt).toContain('cli: gh');
      expectNoCompletionKindFields(paPrompt);
      expect(paPrompt).not.toMatch(/^branch: /m);
    });

    it('truncates cli-notes at 512 bytes on a code-point boundary', async () => {
      await seedAndScan();
      const prompt = build({
        task: GIT_TASK,
        signalToken: 'dev-token-3',
        platformCli: { ...CLI, notes: '汉'.repeat(200) },
      });
      const rendered = prompt.match(/^cli-notes: (.*)$/m)?.[1];
      expect(rendered).toBe('汉'.repeat(170));
      expect(Buffer.byteLength(rendered ?? '', 'utf8')).toBeLessThanOrEqual(512);
    });

    it('a task without a resolved platform cli omits cli fields', async () => {
      await seedAndScan();
      const prompt = build({ task: TASK, signalToken: 'dev-token-4' });
      expect(prompt).not.toContain('exchange:');
      expect(prompt).not.toContain('cli: gh');
      expect(prompt).not.toContain('cli-host:');
      expect(prompt).not.toMatch(/^base: /m);
    });
  });

  describe('signal leak self-check scans both the raw body and its visible rendering', () => {
    const ESC = '\x1b';
    const BEL = '\x07';
    const TOKEN = 'leak-token-1';

    function taskWith(field: 'title' | 'description', literal: string): TaskState {
      return { ...TASK, [field]: `see ${literal} here` };
    }

    it.each([
      ['plain', (m: string) => m],
      ['torn by a 7-bit SGR', (m: string) => m.replace('spec-', `spec-${ESC}[31m`)],
      ['torn by an 8-bit CSI', (m: string) => m.replace('spec-', 'spec-\x9b31m')],
      ['buried in an OSC', (m: string) => `${ESC}]0;${m}${BEL}`],
      ['buried in an APC', (m: string) => `${ESC}_${m}${ESC}\\`],
    ])('rejects a filled phase literal %s in the title', async (_name, wrap) => {
      await seedAndScan();
      const literal = wrap(buildPhaseSignal('spec-done', TOKEN, 42, 'Nzc'));
      expect(() => build({ task: taskWith('title', literal), signalToken: TOKEN }))
        .toThrow(/must not contain a filled/);
    });

    it.each([
      ['torn by a 7-bit SGR', (m: string) => m.replace('spec-', `spec-${ESC}[31m`)],
      ['buried in an OSC', (m: string) => `${ESC}]0;${m}${BEL}`],
    ])('rejects a filled phase literal %s in the description', async (_name, wrap) => {
      await seedAndScan();
      const literal = wrap(buildPhaseSignal('spec-done', TOKEN, 42, 'Nzc'));
      expect(() => build({ task: taskWith('description', literal), signalToken: TOKEN }))
        .toThrow(/must not contain a filled/);
    });

    it.each([
      ['plain', (m: string) => m],
      ['torn by a 7-bit SGR', (m: string) => m.replace('need-', `need-${ESC}[31m`)],
      ['buried in an OSC', (m: string) => `${ESC}]0;${m}${BEL}`],
    ])('rejects a filled need-input literal %s', async (_name, wrap) => {
      await seedAndScan();
      expect(() => build({
        task: taskWith('description', wrap(`[bx:need-input:${TOKEN}:1]`)),
        signalToken: TOKEN,
      })).toThrow(/must not contain a filled need-input signal literal/);
    });

    it('accepts a literal carrying some OTHER token — only this dispatch is a leak', async () => {
      await seedAndScan();
      const stale = buildPhaseSignal('spec-done', 'some-other-token', 42, 'Nzc');
      expect(() => build({ task: taskWith('description', stale), signalToken: TOKEN })).not.toThrow();
      expect(() => build({
        task: taskWith('description', `${ESC}]0;${stale}${BEL}`),
        signalToken: TOKEN,
      })).not.toThrow();
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
});

describe('buildGreetingPrompt', () => {
  it('force-loads the baxian-greeting skill and carries the token (no fireable signal)', () => {
    const cc = buildGreetingPrompt('greettok12345', 'claude-code');
    expect(cc.startsWith('/baxian-greeting\n')).toBe(true);
    expect(cc).toContain('token: greettok12345');
    expect(scanPhaseSignals(cc)).toEqual([]);
    expect(buildGreetingPrompt('greettok12345', 'codex').startsWith('$baxian-greeting\n')).toBe(true);
  });
});
