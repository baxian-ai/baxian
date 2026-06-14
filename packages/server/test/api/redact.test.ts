import { describe, it, expect } from 'vitest';
import { redactConfig, redactHosts, redactProjects } from '../../src/api/config.js';
import type { BaxianConfig } from '../../src/shared/index.js';

describe('password redaction (f-3 recursive contract)', () => {
  it('redactHosts replaces top-level registry passwords with ***', () => {
    const out = redactHosts([
      { id: 'a', hostname: 'h1', password: 'secret' },
      { id: 'b', hostname: 'h2' },
    ]);
    expect(out[0].password).toBe('***');
    expect(out[1].password).toBeUndefined();
  });

  it('redactProjects strips passwords from legacy inline agent.host objects, leaves id refs intact', () => {
    const out = redactProjects([{
      id: 'p', repo: 'u/r', merge: null,
      agent: [[
        { id: 'inline', runtime: 'claude-code', role: 'dev', mode: 'remote', host: { hostname: 'legacy', password: 'leak' } },
        { id: 'ref', runtime: 'codex', role: 'qa', mode: 'remote', host: 'box' },
      ]],
    }]);
    const inlineHost = out[0].agent[0][0].host as { password?: string };
    expect(inlineHost.password).toBe('***');
    expect(out[0].agent[0][1].host).toBe('box');
  });

  it('redactConfig covers both the registry and inline agent hosts in one pass', () => {
    const config: BaxianConfig = {
      review: { rounds: 10 },
      server: { port: 3000, token: 'tok' },
      host: [{ id: 'box', hostname: 'h', password: 'regpw' }],
      project: [{
        id: 'p', repo: 'u/r', merge: null,
        agent: [[{ id: 'a', runtime: 'claude-code', role: 'dev', mode: 'remote', host: { hostname: 'x', password: 'inlinepw' } }]],
      }],
    };
    const out = redactConfig(config);
    expect(out.host[0].password).toBe('***');
    expect((out.project[0].agent[0][0].host as { password?: string }).password).toBe('***');
    expect(out.server.token).toBe('***');
    // Original config object is not mutated.
    expect(config.host[0].password).toBe('regpw');
  });
});
