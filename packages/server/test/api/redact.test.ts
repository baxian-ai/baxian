import { describe, it, expect } from 'vitest';
import { redactConfig, redactHosts } from '../../src/api/config.js';
import type { BaxianConfig } from '../../src/shared/index.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/shared/index.js';

describe('password redaction (recursively masks host and server-token secrets)', () => {
  it('redactHosts replaces top-level registry passwords with ***', () => {
    const out = redactHosts([
      { id: 'a', hostname: 'h1', password: 'secret' },
      { id: 'b', hostname: 'h2' },
    ]);
    expect(out[0].password).toBe('***');
    expect(out[1].password).toBeUndefined();
  });

  it('redactConfig covers the registry and server token without mutating the input', () => {
    const config: BaxianConfig = {
      review: { rounds: 10 },
      server: { ...DEFAULT_SERVER_CONFIG, token: 'tok' },
      host: [{ id: 'box', hostname: 'h', password: 'regpw' }],
      project: [{
        id: 'p', repo: 'https://github.com/u/r.git', merge: null,
        agent: [[{ id: 'a', runtime: 'claude-code', role: 'dev', mode: 'remote', host: 'box' }]],
      }],
    };
    const out = redactConfig(config);
    expect(out.host[0].password).toBe('***');
    expect(out.project[0].agent[0][0].host).toBe('box');
    expect(out.server.token).toBe('***');
    expect(config.host[0].password).toBe('regpw');
  });
});
