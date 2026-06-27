import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SKILLS_ROOT = new URL('../../../../skills/', import.meta.url);

async function skillBody(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`${name}/SKILL.md`, SKILLS_ROOT)), 'utf-8');
}

async function skillFile(relPath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relPath, SKILLS_ROOT)), 'utf-8');
}

describe('baxian-signals skill', () => {
  it('documents the signal protocol essentials', async () => {
    const body = await skillBody('baxian-signals');
    expect(body).toContain('name: baxian-signals');
    expect(body).toContain('[bx:');
    expect(body).toContain('pr-created');
    expect(body).toContain('read-file');
    // The two load-bearing rules an agent must not violate.
    expect(body).toContain('own line');
    expect(body.toLowerCase()).toContain('stdout');
    // Reachable reference: prompts/skills point here, so the model must be allowed to load it.
    expect(body).not.toContain('disable-model-invocation: true');
    // pr_number has no companion line — it comes from the PR the agent just created/opened.
    expect(body).toContain('PR you just created');
  });

  // Both runtimes must keep the skill implicitly loadable, else the prompt/skill pointers
  // point at a skill no runtime ever loads (the unreachable-reference regression).
  it('keeps the skill implicitly loadable for Codex', async () => {
    const policy = await skillFile('baxian-signals/agents/openai.yaml');
    expect(policy).toMatch(/allow_implicit_invocation:\s*true/);
    expect(policy).not.toMatch(/allow_implicit_invocation:\s*false/);
  });

  // The task requires every place that uses signals to point at the canonical skill.
  it.each([
    'baxian-task-check',
    'baxian-pr-review',
    'baxian-pr-recheck',
    'baxian-pr-feedback',
  ])('%s points at baxian-signals', async (name) => {
    const body = await skillBody(name);
    expect(body).toContain('baxian-signals');
  });
});
