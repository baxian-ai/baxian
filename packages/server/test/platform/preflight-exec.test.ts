import { describe, it, expect } from 'vitest';
import { runDriverPreflightSteps, type DriverPreflightStep } from '../../src/platform/preflight-exec.js';
import type { RenderContext } from '../../src/platform/command-renderer.js';

const CTX: RenderContext & { minToolVersion: string } = {
  scheme: 'https', hostname: 'github.com', host: 'github.com', repoPath: 'owner/repo',
  binary: 'gh', minToolVersion: '2.40.0',
};

const STEPS: DriverPreflightStep[] = [
  { argv: ['{binary}', '--version'], versionCheck: true, fixMessage: '{binary} 需 ≥ {minToolVersion}' },
  { argv: ['{binary}', 'api', 'user'], env: { GH_HOST: '{host}' }, fixMessage: '运行 {binary} auth login --hostname {hostname}' },
];

function execOf(fails: Set<number>, seen: string[] = []) {
  let call = 0;
  return async (command: string) => {
    seen.push(command);
    call += 1;
    return { stdout: 'gh version 2.40.0', stderr: '', exitCode: fails.has(call) ? 1 : 0 };
  };
}

describe('runDriverPreflightSteps', () => {
  it('renders argv with env prefix and passes every step', async () => {
    const seen: string[] = [];
    const results = await runDriverPreflightSteps(execOf(new Set(), seen), STEPS, CTX);
    expect(results).toHaveLength(2);
    expect(results.every(r => r.ok)).toBe(true);
    expect(seen[0]).toBe("'gh' '--version'");
    expect(seen[1]).toBe("GH_HOST='github.com' 'gh' 'api' 'user'");
    expect(results.every(r => !r.message.includes('{'))).toBe(true);
  });

  it('renders the fixMessage with interpolated values on failure', async () => {
    const results = await runDriverPreflightSteps(execOf(new Set([1])), STEPS, CTX);
    expect(results[0]).toMatchObject({ step: 'driver-preflight-1', ok: false, message: 'gh 需 ≥ 2.40.0' });
  });

  it('stops at the first failing step so later steps cannot mislead', async () => {
    const seen: string[] = [];
    const results = await runDriverPreflightSteps(execOf(new Set([1]), seen), STEPS, CTX);
    expect(results).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it('treats a transport rejection as a step failure with the fixMessage', async () => {
    const exec = async () => { throw new Error('ssh timed out'); };
    const results = await runDriverPreflightSteps(exec, [STEPS[1]], CTX);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ step: 'driver-preflight-1', ok: false, message: '运行 gh auth login --hostname github.com' });
  });

  it('never returns raw command output, handing it to the classifier callback instead', async () => {
    const seen: Array<[string, string]> = [];
    const exec = async () => ({ stdout: 'token-like-diagnostic', stderr: 'HTTP 429', exitCode: 1 });
    const results = await runDriverPreflightSteps(exec, STEPS, CTX, (step, raw) => seen.push([step, raw]));
    expect(Object.keys(results[0]!).sort()).toEqual(['message', 'ok', 'step']);
    expect(JSON.stringify(results)).not.toContain('token-like-diagnostic');
    expect(seen).toHaveLength(1);
    expect(seen[0][1]).toContain('HTTP 429');
  });

  describe('minToolVersion comparison on the version step', () => {
    const versionExec = (stdout: string) => async () => ({ stdout, stderr: '', exitCode: 0 });

    it('fails a below-minimum version with the fixMessage and stops', async () => {
      const results = await runDriverPreflightSteps(versionExec('gh version 0.1.0 (2020-01-01)'), STEPS, CTX);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ step: 'driver-preflight-1', ok: false, message: 'gh 需 ≥ 2.40.0' });
    });

    it('passes versions at and above the minimum', async () => {
      for (const out of ['gh version 2.40.0', 'gh version 2.41.7 (2026-01-01)', 'gh version 10.0.1', 'tool version v2.41.0']) {
        const results = await runDriverPreflightSteps(versionExec(out), [STEPS[0]], CTX);
        expect(results[0]?.ok).toBe(true);
      }
    });

    it('compares numerically, not lexically', async () => {
      const results = await runDriverPreflightSteps(versionExec('gh version 2.100.0'), [STEPS[0]], CTX);
      expect(results[0]?.ok).toBe(true);
    });

    it('fails closed on unparsable, empty, or two-segment version output', async () => {
      for (const out of ['some banner without numbers', '', 'gh version 2.40 (short)']) {
        const results = await runDriverPreflightSteps(versionExec(out), [STEPS[0]], CTX);
        expect(results[0]).toMatchObject({ step: 'driver-preflight-1', ok: false, message: 'gh 需 ≥ 2.40.0' });
      }
    });

    it('treats a same-core prerelease as below the minimum (semver §9)', async () => {
      const results = await runDriverPreflightSteps(versionExec('gh version 2.40.0-rc.1'), [STEPS[0]], CTX);
      expect(results[0]).toMatchObject({ step: 'driver-preflight-1', ok: false, message: 'gh 需 ≥ 2.40.0' });
    });

    it('passes a prerelease of a higher core and ignores build metadata', async () => {
      for (const out of ['gh version 2.40.1-rc.1', 'gh version 2.40.0+build.7']) {
        const results = await runDriverPreflightSteps(versionExec(out), [STEPS[0]], CTX);
        expect(results[0]?.ok).toBe(true);
      }
    });

    it('fails a v-prefixed version below the minimum', async () => {
      const results = await runDriverPreflightSteps(versionExec('tool version v0.1.0'), [STEPS[0]], CTX);
      expect(results[0]?.ok).toBe(false);
    });

    it('accepts the real gh two-line output where the same version repeats in the release link', async () => {
      const ghOut = 'gh version 2.41.0 (2026-01-01)\nhttps://github.com/cli/cli/releases/tag/v2.41.0';
      const results = await runDriverPreflightSteps(versionExec(ghOut), [STEPS[0]], CTX);
      expect(results[0]?.ok).toBe(true);
    });

    it('rejects ambiguous or boundary-broken version output instead of taking the first triple', async () => {
      for (const out of [
        'built 2026.07.20\ngh version 0.1.0',
        'gh version 2.40.0.1',
        'gh version 2.40.0rc1',
      ]) {
        const results = await runDriverPreflightSteps(versionExec(out), [STEPS[0]], CTX);
        expect(results[0]?.ok, out).toBe(false);
      }
    });

    it('reads a version printed on stderr', async () => {
      const exec = async () => ({ stdout: '', stderr: 'gh version 2.41.0', exitCode: 0 });
      const results = await runDriverPreflightSteps(exec, [STEPS[0]], CTX);
      expect(results[0]?.ok).toBe(true);
    });

    it('never version-gates steps without the versionCheck declaration', async () => {
      const results = await runDriverPreflightSteps(versionExec('api user says 0.0.1'), [STEPS[1]], CTX);
      expect(results[0]?.ok).toBe(true);
    });
  });
});
