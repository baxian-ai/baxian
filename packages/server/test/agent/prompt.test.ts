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

function useServerPhaseRegistry(prefix: string): () => SkillRegistry {
  let tempDir: string;
  let registry: SkillRegistry;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), prefix));
    for (const name of ['baxian-signals', 'baxian-server-review', 'baxian-server-feedback']) {
      await mkdir(join(tempDir, name), { recursive: true });
      await writeFile(join(tempDir, name, 'SKILL.md'), `${name} stub`);
    }
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

  async function seedAllPhaseSkills(): Promise<void> {
    await makeSkill('baxian-task-check', 'task-check stub');
    await makeSkill('baxian-research', 'research stub');
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

  const QA_AGENT: AgentConfig = { id: 'qa-1', runtime: 'claude-code', role: 'qa', mode: 'local', workdir: '/tmp/repo' };
  const RESEARCH_AGENT: AgentConfig = {
    id: 'research-1', runtime: 'claude-code', role: 'research', mode: 'local', workdir: '/tmp/research-repo',
  };

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
    expect(prompt).toContain('exchange: github-pr');
    expect(prompt).toContain('workdir: /tmp/repo/.baxian-worktrees/task-001_abc');
    expect(prompt).toContain('title: Fix login redirect');
    expect(prompt).not.toContain('cd into the worktree');
    expect(prompt).not.toContain('baxian conventions:');
    expect(prompt).not.toContain('<skills>');
    expect(prompt).not.toContain('<task>');
    expect(prompt).not.toContain('<![CDATA[');
  });

  it('research dispatch loads only the Research workflow and exposes only spec completion', async () => {
    await seedAndScan();
    const prompt = build({
      task: {
        ...TASK,
        preferredAgentId: 'research-1',
        agentId: 'research-1',
        researchAgentId: 'research-1',
        phase: 'research',
        status: 'in_progress',
      },
      phase: 'research',
      agent: RESEARCH_AGENT,
      workdir: '/tmp/research-repo',
      signalToken: 'research-token-1',
    });

    expect(prompt.startsWith('/baxian-research\nphase: research\n')).toBe(true);
    expect(prompt).toContain('signal: spec-done');
    expect(prompt).toContain('token: research-token-1');
    expect(prompt).not.toContain('signal: pr-created');
    expect(prompt).not.toContain('signal: code-done');
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

  it('fix phase descriptor carries pr/branch/round and the pr-fixed signal field', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'fixing', prNumber: 42, reviewRound: 2 },
      phase: 'fix',
      signalToken: 'fix-token-42',
    });
    expect(prompt.startsWith('/baxian-pr-feedback\n')).toBe(true);
    expect(prompt).toContain('phase: fix');
    expect(prompt).toContain('pr: 42');
    expect(prompt).toContain('round: 2');
    expect(prompt).toContain('signal: pr-fixed');
    expect(prompt).toContain('token: fix-token-42');
  });

  it('fix phase prompt requires a signalToken', async () => {
    await seedAndScan();
    expect(() => build({
      task: { ...TASK, status: 'fixing', prNumber: 42, reviewRound: 2 },
      phase: 'fix',
    })).toThrow(/fix prompt requires signalToken/);
  });

  it('represents the signal as structured signal/token fields, never a fireable literal', async () => {
    await seedAndScan();
    const withSignal = build({
      task: { ...TASK, status: 'fixing', prNumber: 42, reviewRound: 2 },
      phase: 'fix',
      signalToken: 'fix-token-42',
    });
    expect(withSignal).toContain('signal: pr-fixed');
    expect(withSignal).toContain('token: fix-token-42');
    expect(scanPhaseSignals(withSignal)).toEqual([]);
    expect(withSignal).not.toContain('[bx:pr-fixed:');
    const noSignal = build();
    expect(noSignal).not.toContain('signal:');
    expect(noSignal).not.toContain('token:');
  });

  it('post-approve descriptor carries pr + the pr-merge-ready signal field', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'approved', prNumber: 42 },
      phase: 'post-approve',
      signalToken: 'post-token-42',
    });

    expect(prompt.startsWith('/baxian-pr-feedback\n')).toBe(true);
    expect(prompt).toContain('phase: post-approve');
    expect(prompt).toContain('pr: 42');
    expect(prompt).toContain('signal: pr-merge-ready');
    expect(prompt).toContain('token: post-token-42');
    expect(prompt).not.toContain('T_self');
    expect(prompt).not.toContain('redispatch:');
    expect(prompt).not.toContain(buildPhaseSignal('pr-merge-ready', 'post-token-42'));
    expect(scanPhaseSignals(prompt)).toEqual([]);
  });

  it.each<[string, number, string[], string[]]>([
    ['redispatch #3 sets the redispatch field', 3,
      ['redispatch: 3', 'signal: pr-merge-ready', 'token: post-token-42'],
      []],
    ['redispatchCount=0 omits the redispatch field', 0,
      ['signal: pr-merge-ready'],
      ['redispatch:']],
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

  it('every phase force-loads its /command — code reuses baxian-task-check yet still emits it', async () => {
    await seedAndScan();
    const codePrompt = build({ phase: 'code', signalToken: 'code-token-1' });
    expect(codePrompt.startsWith('/baxian-task-check\nphase: code\n')).toBe(true);
    expect(codePrompt).toContain('signal: pr-created');
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

  it('develop descriptor carries both spec and code completion signals when the task has QA', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'in_progress' },
      signalToken: 'spec-token-1',
    });
    expect(prompt).toContain('spec-signal: spec-done');
    expect(prompt).toContain('signal: pr-created');
    expect(prompt).toContain('token: spec-token-1');
    expect(prompt).not.toContain('Specification-Driven Development');
    expect(prompt).not.toContain('gh pr ready');
    expect(prompt).not.toContain(buildPhaseSignal('spec-done', 'spec-token-1'));
    expect(scanPhaseSignals(prompt)).toEqual([]);
  });

  it('develop without signalToken carries no signal fields', async () => {
    await seedAndScan();
    const prompt = build({ task: { ...TASK, status: 'in_progress' } });
    expect(prompt).not.toContain('spec-signal:');
    expect(prompt).not.toContain('signal:');
  });

  it('server develop descriptor uses server-files exchange and the code-done signal', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'in_progress', reviewMode: 'server' },
      signalToken: 'spec-token-srv',
    });
    expect(prompt).toContain('exchange: server-files');
    expect(prompt).toContain('spec-signal: spec-done');
    expect(prompt).toContain('signal: code-done');
    expect(prompt).not.toContain('gh pr ready');
    expect(scanPhaseSignals(prompt)).toEqual([]);
  });

  it.each([
    ['github chain', undefined, 'pr-created' as const],
    ['server chain', 'server' as const, 'code-done' as const],
  ])('develop drops the spec route when the task has no QA partner (%s)', async (_label, reviewMode, replacementSignal) => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'in_progress', reviewMode },
      signalToken: 'spec-token-1',
      hasQaPartner: false,
    });
    expect(prompt).not.toContain('spec-signal:');
    expect(prompt).toContain(`signal: ${replacementSignal}`);
    expect(prompt).toContain('token: spec-token-1');
  });

  it('develop keeps the spec route when hasQaPartner is true or omitted', async () => {
    await seedAndScan();
    for (const extra of [{ hasQaPartner: true }, {}]) {
      const prompt = build({
        task: { ...TASK, status: 'in_progress' },
        signalToken: 'spec-token-1',
        ...extra,
      });
      expect(prompt).toContain('spec-signal: spec-done');
      expect(prompt).toContain('signal: pr-created');
    }
  });

  it('review descriptor carries pr + token; verdict procedure lives in the skill', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'review', prNumber: 42 },
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
      task: { ...TASK, status: 'review', prNumber: 42, reviewHeadAnchorSha },
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
      task: { ...TASK, status: 'review', prNumber: 42, reviewRound: 2, reviewHeadAnchorSha: 'sha-recheck-789' },
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

  it('code descriptor carries the pr-created signal field', async () => {
    await seedAndScan();
    const prompt = build({
      task: { ...TASK, status: 'in_progress', phase: 'code' },
      phase: 'code',
      signalToken: 'code-token-1',
    });
    expect(prompt).toContain('phase: code');
    expect(prompt).toContain('exchange: github-pr');
    expect(prompt).toContain('signal: pr-created');
    expect(prompt).toContain('token: code-token-1');
    expect(prompt).not.toContain('gh pr create');
    expect(prompt).not.toContain('docs/spec/');
  });


  it('signal emit block keeps the template + token on separate lines so the prompt itself never matches scanPhaseSignals', () => {
    expect(scanPhaseSignals('[bx:spec-done:<token>]')).toEqual([]);
    expect(scanPhaseSignals(buildPhaseSignal('spec-done', 'abc123def456'))).toEqual([
      { kind: 'spec-done', token: 'abc123def456' },
    ]);
  });

  describe('git review mode descriptor', () => {
    const CLI = { tool: 'gh', host: 'github.com', repo: 'user/repo', repoEncoded: 'user%2Frepo' };
    const GIT_TASK: TaskState = {
      ...TASK,
      reviewMode: 'git',
      branch: 'bx/task-001',
      baseBranch: 'main',
    };

    it('develop carries the cli family, branch/base snapshot and the git-pr exchange', async () => {
      await seedAndScan();
      const prompt = build({
        task: GIT_TASK,
        signalToken: 'dev-token-1',
        platformCli: { ...CLI, notes: 'instance runs behind :8443' },
      });
      expect(prompt).toContain('exchange: git-pr');
      expect(prompt).toContain('cli: gh');
      expect(prompt).toContain('cli-host: github.com');
      expect(prompt).toContain('cli-repo: user/repo');
      expect(prompt).toContain('cli-repo-encoded: user%2Frepo');
      expect(prompt).toContain('cli-notes: instance runs behind :8443');
      expect(prompt).toContain('branch: bx/task-001');
      expect(prompt).toContain('base: main');
      expect(prompt).toContain('signal: pr-created');
      expect(prompt).not.toContain('cli-binary');
      expect(prompt).not.toContain('cli-env');
    });

    it('code renders the same platform family as develop', async () => {
      await seedAndScan();
      const prompt = build({
        task: { ...GIT_TASK, status: 'in_progress', phase: 'code' },
        phase: 'code',
        signalToken: 'code-token-1',
        platformCli: CLI,
      });
      expect(prompt).toContain('exchange: git-pr');
      expect(prompt).toContain('cli: gh');
      expect(prompt).toContain('branch: bx/task-001');
      expect(prompt).toContain('base: main');
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
      expect(paPrompt).toContain('signal: pr-merge-ready');
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

    it('legacy tasks render no cli family even when platformCli is passed', async () => {
      await seedAndScan();
      const prompt = build({ task: TASK, signalToken: 'dev-token-4', platformCli: CLI });
      expect(prompt).toContain('exchange: github-pr');
      expect(prompt).not.toContain('cli: gh');
      expect(prompt).not.toContain('cli-host:');
      expect(prompt).not.toMatch(/^base: /m);
    });
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
      workdir: '/wt/x',
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

  it('every server phase force-loads its role skill (server-after-done now reads baxian-server-feedback §Publish)', () => {
    const codexReview = build('server-review', QA_AGENT, { serverContent: 'diff x' });
    expect(codexReview.startsWith('$baxian-server-review\n')).toBe(true);
    const QA_CC: AgentConfig = { id: 'qa-cc', runtime: 'claude-code', role: 'qa', mode: 'local' };
    const ccReview = build('server-review', QA_CC, { serverContent: 'diff x' });
    expect(ccReview.startsWith('/baxian-server-review\n')).toBe(true);
    const feedback = build('server-feedback', DEV_AGENT, { serverPriorFindings: CODE_FINDINGS });
    expect(feedback.startsWith('/baxian-server-feedback\n')).toBe(true);
    const afterDone = build('server-after-done', DEV_AGENT, { serverAfterDone: { kind: 'branch', branch: 'bx/task-001' } });
    expect(afterDone.startsWith('/baxian-server-feedback\n')).toBe(true);
  });

  it.each<[string, string, AgentConfig, Record<string, unknown>, Expect]>([
    ['server-review injects diff + diffstat blocks, carries round + signal fields', 'server-review', QA_AGENT,
      { serverContent: 'diff --git a/a.ts b/a.ts\n+new line', serverDiffstat: ' a.ts | 1 +\n' },
      { contains: ['phase: server-review', 'round: 1', 'signal: code-reviewed', 'srvtok123456', 'diffstat:', ' a.ts | 1 +', 'diff:', 'diff --git a/a.ts'] }],
    ['server-review labels legacy batches with a batch field', 'server-review', QA_AGENT,
      { serverContent: 'diff x', serverBatch: { index: 1, total: 3 } },
      { contains: ['batch: 2/3'] }],
    ['server-recheck carries prior-findings + prior-response blocks', 'server-recheck', QA_AGENT,
      { serverContent: 'diff y', serverPriorFindings: CODE_FINDINGS, serverPriorResponse: '{"round":1,"responses":[]}' },
      { contains: ['phase: server-recheck', 'prior-findings:', 'request-changes', 'prior-response:', 'responses', 'signal: code-reviewed'] }],
    ['server-spec-review injects the spec block + spec-reviewed signal', 'server-spec-review', QA_AGENT,
      { serverContent: '# Spec doc' },
      { contains: ['spec:', '# Spec doc', 'round: 1', 'signal: spec-reviewed'] }],
    ['server-feedback spec variant: feedback=spec + spec-fixed signal, no commit wording inline', 'server-feedback', DEV_AGENT,
      { ...SPEC_TASK, serverPriorFindings: CODE_FINDINGS },
      { contains: ['feedback: spec', 'signal: spec-fixed'], notContains: ['commit'] }],
    ['server-feedback code variant: feedback=code + code-fixed signal', 'server-feedback', DEV_AGENT,
      { serverPriorFindings: CODE_FINDINGS },
      { contains: ['feedback: code', 'signal: code-fixed'] }],
    ['server-after-done pr variant: publish=pr + code-ready', 'server-after-done', DEV_AGENT,
      { serverAfterDone: { kind: 'pr', branch: 'bx/task-001' } },
      { contains: ['publish: pr', 'branch: bx/task-001', 'signal: code-ready'], notContains: ['gh pr create', 'exchange:'] }],
    ['server-after-done branch variant: publish=branch', 'server-after-done', DEV_AGENT,
      { serverAfterDone: { kind: 'branch', branch: 'bx/task-001' } },
      { contains: ['publish: branch', 'signal: code-ready'], notContains: ['publish: pr', 'exchange:'] }],
  ])('%s', (_label, phase, agent, extra, expectations) => {
    assertFragments(build(phase, agent, extra), expectations);
  });

  it('server-feedback picks the signal + feedback fields by task phase', () => {
    const codePrompt = build('server-feedback', DEV_AGENT, { serverPriorFindings: CODE_FINDINGS });
    expect(codePrompt).toContain('signal: code-fixed');
    expect(codePrompt).toContain('feedback: code');

    const specPrompt = build('server-feedback', DEV_AGENT, { ...SPEC_TASK, serverPriorFindings: '{}' });
    expect(specPrompt).toContain('signal: spec-fixed');
    expect(specPrompt).toContain('feedback: spec');
  });

  it('phases outside develop/code omit the exchange field', () => {
    const review = build('server-review', QA_AGENT, { serverContent: 'diff x' });
    expect(review).not.toContain('exchange:');
    const sddSpec = buildPromptInline({
      task: TASK,
      phase: 'server-spec-review',
      agent: QA_AGENT,
      workdir: '/wt/x',
      skillRegistry: getRegistry(),
      signalToken: 'srvtok123456',
      serverContent: '# spec',
    } as Parameters<typeof buildPromptInline>[0]);
    expect(sddSpec).not.toContain('exchange:');
    const merge = buildPromptInline({
      task: TASK,
      phase: 'merge',
      agent: DEV_AGENT,
      workdir: '/wt/x',
      skillRegistry: getRegistry(),
    } as Parameters<typeof buildPromptInline>[0]);
    expect(merge).not.toContain('exchange:');
  });

  // machine-readable invocation policy (frontmatter + openai.yaml), not SKILL.md prose — no other test covers it
  it('every baxian skill disables implicit model-invocation (Claude frontmatter + Codex policy) so only baxian explicitly invokes the per-phase skill', async () => {
    const skillsRoot = fileURLToPath(new URL('../../../../skills', import.meta.url));
    for (const name of ['baxian-task-check', 'baxian-pr-feedback', 'baxian-pr-review', 'baxian-pr-recheck', 'baxian-server-review', 'baxian-server-feedback']) {
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
      workdir: '/wt/x',
      skillRegistry: getRegistry(),
      serverContent: 'diff',
    } as Parameters<typeof buildPromptInline>[0])).toThrow(/requires signalToken/);
  });

  it('server-spec-review renders a file reference field instead of the spec block', async () => {
    const registry = getRegistry();
    const prompt = buildPromptInline({
      task: { ...TASK, reviewMode: 'server', phase: 'spec', specReviewRound: 2 },
      phase: 'server-spec-review',
      agent: QA_AGENT,
      workdir: '/wt/qa',
      skillRegistry: registry,
      signalToken: 'tok',
      currentSpecRound: 2,
      serverContentFile: { path: '.baxian/review/inbox/spec-round-2.md', bytes: 35 * 1024 },
    });
    expect(prompt).toContain('spec-file: .baxian/review/inbox/spec-round-2.md (35KB)');
    expect(prompt).not.toContain('\nspec:\n');
  });

  it('server-review renders diff-file and prior-* file fields', async () => {
    const registry = getRegistry();
    const prompt = buildPromptInline({
      task: { ...TASK, reviewMode: 'server', reviewRound: 4 },
      phase: 'server-review',
      agent: QA_AGENT,
      workdir: '/wt/qa',
      skillRegistry: registry,
      signalToken: 'tok',
      serverReviewCheckout: 'head',
      serverBaseSha: 'base123',
      serverHeadSha: 'head123',
      serverHeadTree: 'tree123',
      serverDiffstatFile: { path: '.baxian/review/inbox/diffstat-round-4.txt', bytes: 18 * 1024 },
      serverContentFile: { path: '.baxian/review/inbox/diff-round-4.patch', bytes: 120 * 1024 },
      serverPriorFindingsFile: { path: '.baxian/review/inbox/prior-findings-round-4.json', bytes: 11 * 1024 },
      serverPriorResponse: '{"round":3,"responses":[]}',
    });
    expect(prompt).toContain('review-checkout: head');
    expect(prompt).toContain('base-sha: base123');
    expect(prompt).toContain('head-sha: head123');
    expect(prompt).toContain('head-tree: tree123');
    expect(prompt).toContain('diff-file: .baxian/review/inbox/diff-round-4.patch (120KB)');
    expect(prompt).toContain('diffstat-file: .baxian/review/inbox/diffstat-round-4.txt (18KB)');
    expect(prompt).toContain('prior-findings-file: .baxian/review/inbox/prior-findings-round-4.json (11KB)');
    expect(prompt).toContain('prior-response:');
    expect(prompt).not.toContain('\ndiffstat:\n');
    expect(prompt).not.toContain('\ndiff:\n');
  });

  it('server-feedback renders findings-file instead of the findings block', async () => {
    const registry = getRegistry();
    const prompt = buildPromptInline({
      task: { ...TASK, reviewMode: 'server', reviewRound: 5, phase: 'code' },
      phase: 'server-feedback',
      agent: DEV_AGENT,
      workdir: '/wt/dev',
      skillRegistry: registry,
      signalToken: 'tok',
      serverPriorFindingsFile: { path: '.baxian/review/inbox/findings-round-5.json', bytes: 20 * 1024 },
    });
    expect(prompt).toContain('findings-file: .baxian/review/inbox/findings-round-5.json (20KB)');
    expect(prompt).not.toContain('\nfindings:\n');
  });

  it('inline server payloads render exactly as before (no truncation markers anywhere)', async () => {
    const registry = getRegistry();
    const prompt = buildPromptInline({
      task: { ...TASK, reviewMode: 'server', reviewRound: 1 },
      phase: 'server-review',
      agent: QA_AGENT,
      workdir: '/wt/qa',
      skillRegistry: registry,
      signalToken: 'tok',
      serverContent: 'diff --git a/a b/a\n+1',
    });
    expect(prompt).toContain('diff:\ndiff --git a/a b/a\n+1');
    expect(prompt).not.toContain('truncated');
    expect(prompt).not.toContain('-file:');
  });

  it('rejects a payload passed in both inline and file form', async () => {
    const registry = getRegistry();
    expect(() => buildPromptInline({
      task: { ...TASK, reviewMode: 'server', reviewRound: 1 },
      phase: 'server-review',
      agent: QA_AGENT,
      workdir: '/wt/qa',
      skillRegistry: registry,
      signalToken: 'tok',
      serverContent: 'x',
      serverContentFile: { path: '.baxian/review/inbox/diff-round-1.patch', bytes: 1 },
    })).toThrow(/mutually exclusive/);
  });

  it('rejects prior-response passed in both inline and file form', async () => {
    const registry = getRegistry();
    expect(() => buildPromptInline({
      task: { ...TASK, reviewMode: 'server', reviewRound: 2 },
      phase: 'server-recheck',
      agent: QA_AGENT,
      workdir: '/wt/qa',
      skillRegistry: registry,
      signalToken: 'tok',
      serverContent: 'diff',
      serverPriorResponse: '{"round":1,"responses":[]}',
      serverPriorResponseFile: { path: '.baxian/review/inbox/prior-response-round-1.json', bytes: 1 },
    })).toThrow(/mutually exclusive/);
  });

  it('rejects diffstat passed in both inline and file form', async () => {
    const registry = getRegistry();
    expect(() => buildPromptInline({
      task: { ...TASK, reviewMode: 'server', reviewRound: 2 },
      phase: 'server-review',
      agent: QA_AGENT,
      workdir: '/wt/qa',
      skillRegistry: registry,
      signalToken: 'tok',
      serverContent: 'diff',
      serverDiffstat: 'stat',
      serverDiffstatFile: { path: '.baxian/review/inbox/diffstat-round-2.txt', bytes: 1 },
    })).toThrow(/mutually exclusive/);
  });

  it('server-recheck renders prior-response-file instead of the prior-response block', async () => {
    const registry = getRegistry();
    const prompt = buildPromptInline({
      task: { ...TASK, reviewMode: 'server', reviewRound: 2 },
      phase: 'server-recheck',
      agent: QA_AGENT,
      workdir: '/wt/qa',
      skillRegistry: registry,
      signalToken: 'tok',
      serverContent: 'diff',
      serverPriorResponseFile: { path: '.baxian/review/inbox/prior-response-round-1.json', bytes: 12 * 1024 },
    });
    expect(prompt).toContain('prior-response-file: .baxian/review/inbox/prior-response-round-1.json (12KB)');
    expect(prompt).not.toContain('prior-response:\n');
  });

  it('server-recheck renders the interdiff block before the full diff, with prioritize-increment wording', async () => {
    const prompt = build('server-recheck', QA_AGENT, {
      serverContent: 'FULLDIFFMARKER',
      serverInterdiff: 'INTERDIFFMARKER',
      serverPriorFindings: CODE_FINDINGS,
    });
    expect(prompt).toContain('INTERDIFFMARKER');
    expect(prompt).toContain('diff:\nFULLDIFFMARKER');
    expect(prompt).toContain('优先核对');
    expect(prompt).toContain('交叉确认');
    // increment precedes the full diff so QA reads the delta first
    expect(prompt.indexOf('INTERDIFFMARKER')).toBeLessThan(prompt.indexOf('FULLDIFFMARKER'));
  });

  it('server-recheck renders an interdiff-file field when the interdiff was delivered to the inbox', async () => {
    const registry = getRegistry();
    const prompt = buildPromptInline({
      task: { ...TASK, reviewMode: 'server', reviewRound: 2 },
      phase: 'server-recheck',
      agent: QA_AGENT,
      workdir: '/wt/qa',
      skillRegistry: registry,
      signalToken: 'tok',
      serverContent: 'diff',
      serverInterdiffFile: { path: '.baxian/review/inbox/interdiff-round-2.patch', bytes: 30 * 1024 },
    });
    expect(prompt).toContain('interdiff-file: .baxian/review/inbox/interdiff-round-2.patch (30KB)');
    expect(prompt).not.toContain('interdiff (');
  });

  it('rejects an interdiff passed in both inline and file form', async () => {
    const registry = getRegistry();
    expect(() => buildPromptInline({
      task: { ...TASK, reviewMode: 'server', reviewRound: 2 },
      phase: 'server-recheck',
      agent: QA_AGENT,
      workdir: '/wt/qa',
      skillRegistry: registry,
      signalToken: 'tok',
      serverContent: 'diff',
      serverInterdiff: 'x',
      serverInterdiffFile: { path: '.baxian/review/inbox/interdiff-round-2.patch', bytes: 1 },
    })).toThrow(/mutually exclusive/);
  });

  it('server-feedback floors the rendered round at 1, matching the delivery filename floor', async () => {
    const registry = getRegistry();
    const prompt = buildPromptInline({
      task: { ...TASK, reviewMode: 'server', reviewRound: 0, phase: 'code' },
      phase: 'server-feedback',
      agent: DEV_AGENT,
      workdir: '/wt/dev',
      skillRegistry: registry,
      signalToken: 'tok',
      serverPriorFindings: '{"round":1,"verdict":"request-changes","findings":[]}',
    });
    expect(prompt).toContain('round: 1');
    expect(prompt).not.toContain('round: 0');
  });

  it('sub-KB file refs round up to 1KB', async () => {
    const registry = getRegistry();
    const prompt = buildPromptInline({
      task: { ...TASK, reviewMode: 'server', phase: 'spec', specReviewRound: 1 },
      phase: 'server-spec-review',
      agent: QA_AGENT,
      workdir: '/wt/qa',
      skillRegistry: registry,
      signalToken: 'tok',
      currentSpecRound: 1,
      serverContentFile: { path: '.baxian/review/inbox/spec-round-1.md', bytes: 100 },
    });
    expect(prompt).toContain('spec-file: .baxian/review/inbox/spec-round-1.md (1KB)');
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
