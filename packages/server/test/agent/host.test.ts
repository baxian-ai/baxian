import { describe, it, expect } from 'vitest';
import type { HostConfig } from '../../src/shared/index.js';
import {
  resolveAgentHost,
  hostGroupKey,
  sshTarget,
  buildSshOptions,
  sshEnv,
} from '../../src/agent/runner.js';

const KEY_HOST: HostConfig = { id: 'box', hostname: 'box.example.com', port: 2222, user: 'agent' };
const PW_HOST: HostConfig = { id: 'pw', hostname: 'pw.example.com', user: 'root', password: 'hunter2' };

describe('resolveAgentHost', () => {
  it('resolves a string id against the registry', () => {
    expect(resolveAgentHost([KEY_HOST], 'box')).toEqual(KEY_HOST);
  });

  it('returns undefined for an unknown id (validator catches dangling refs)', () => {
    expect(resolveAgentHost([KEY_HOST], 'missing')).toBeUndefined();
  });

  it('passes a legacy inline host object through unchanged', () => {
    const inline = { hostname: 'legacy', user: 'old' };
    expect(resolveAgentHost([KEY_HOST], inline)).toBe(inline);
  });

  it('returns undefined for an undefined ref (local agent)', () => {
    expect(resolveAgentHost([KEY_HOST], undefined)).toBeUndefined();
  });
});

describe('hostGroupKey', () => {
  it('is "local" for local mode', () => {
    expect(hostGroupKey('local', undefined)).toBe('local');
  });

  it('keys remote by user@hostname:port so the same machine de-dups', () => {
    expect(hostGroupKey('remote', KEY_HOST)).toBe('remote:agent@box.example.com:2222');
    const other: HostConfig = { id: 'box-alias', hostname: 'box.example.com', port: 2222, user: 'agent' };
    expect(hostGroupKey('remote', other)).toBe(hostGroupKey('remote', KEY_HOST));
  });

  it('keys a no-explicit-port host as :default (distinct from explicit :22, which honors ~/.ssh/config)', () => {
    expect(hostGroupKey('remote', { hostname: 'h', user: 'u' })).toBe('remote:u@h:default');
    expect(hostGroupKey('remote', { hostname: 'h', user: 'u', port: 22 })).toBe('remote:u@h:22');
  });
});

describe('sshTarget', () => {
  it('builds user@hostname or bare hostname', () => {
    expect(sshTarget(KEY_HOST)).toBe('agent@box.example.com');
    expect(sshTarget({ hostname: 'bare' })).toBe('bare');
  });
});

describe('buildSshOptions', () => {
  it('key host: BatchMode=yes + explicit -p port, no password flags', () => {
    const opts = buildSshOptions(KEY_HOST);
    expect(opts).toContain('-o BatchMode=yes');
    expect(opts).toContain('-p 2222');
    expect(opts).not.toContain('PreferredAuthentications=password,keyboard-interactive');
  });

  it('password host: drops BatchMode, allows password auth + accept-new host key', () => {
    const opts = buildSshOptions(PW_HOST);
    expect(opts).not.toContain('BatchMode=yes');
    expect(opts).toContain('PreferredAuthentications=password,keyboard-interactive');
    expect(opts).toContain('StrictHostKeyChecking=accept-new');
  });

  it('never leaks the password into the ssh option string (env-only, not argv)', () => {
    expect(buildSshOptions(PW_HOST)).not.toContain('hunter2');
  });

  it('noMux forces a fresh authenticated connection (ControlPath=none, ControlMaster=no, no cm-%C)', () => {
    const opts = buildSshOptions(KEY_HOST, { noMux: true });
    expect(opts).toContain('-o ControlMaster=no');
    expect(opts).toContain('-o ControlPath=none');
    expect(opts).not.toContain('cm-%C');
  });

  it('default (mux) path keeps the ControlMaster socket', () => {
    expect(buildSshOptions(KEY_HOST)).toContain('cm-%C');
    expect(buildSshOptions(KEY_HOST)).toContain('-o ControlMaster=auto');
  });

  it('emits -p when the host supplies a port', () => {
    expect(buildSshOptions({ hostname: 'h', port: 22 })).toContain('-p 22');
  });

  it('omits -p for a host without a port, so ~/.ssh/config Port is honored', () => {
    expect(buildSshOptions({ hostname: 'h' })).not.toContain('-p ');
  });
});

describe('sshEnv', () => {
  it('returns {} for a key host', async () => {
    expect(await sshEnv(KEY_HOST)).toEqual({});
  });

  it('returns SSH_ASKPASS (force) + the password via env for a password host', async () => {
    const env = await sshEnv(PW_HOST);
    expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(env.BAXIAN_SSH_PASSWORD).toBe('hunter2');
    expect(typeof env.SSH_ASKPASS).toBe('string');
    expect(env.SSH_ASKPASS.length).toBeGreaterThan(0);
    expect(env.DISPLAY).toBe('');
  });
});
