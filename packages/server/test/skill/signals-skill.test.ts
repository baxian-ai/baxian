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
    expect(body).toContain('own line');
    expect(body.toLowerCase()).toContain('stdout');
    expect(body).not.toContain('disable-model-invocation: true');
    expect(body).toContain('PR you just created');
  });

  it('baxian-greeting disables implicit model invocation (explicitly force-loaded)', async () => {
    const body = await skillBody('baxian-greeting');
    expect(body).toContain('disable-model-invocation: true');
    const policy = await skillFile('baxian-greeting/agents/openai.yaml');
    expect(policy).toMatch(/allow_implicit_invocation:\s*false/);
  });

  it('keeps the skill implicitly loadable for Codex', async () => {
    const policy = await skillFile('baxian-signals/agents/openai.yaml');
    expect(policy).toMatch(/allow_implicit_invocation:\s*true/);
    expect(policy).not.toMatch(/allow_implicit_invocation:\s*false/);
  });

  it.each([
    'baxian-task-check',
    'baxian-pr-review',
    'baxian-pr-recheck',
    'baxian-pr-feedback',
    'baxian-greeting',
    'baxian-server-review',
    'baxian-server-feedback',
  ])('%s points at baxian-signals', async (name) => {
    const body = await skillBody(name);
    expect(body).toContain('baxian-signals');
  });
});
