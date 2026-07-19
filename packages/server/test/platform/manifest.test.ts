import { describe, it, expect } from 'vitest';
import { parseManifest, compareSemver } from '../../src/platform/manifest.js';

const VALID = JSON.stringify({
  name: 'glab', version: '1.0.0', kind: 'git-driver',
  tool: 'glab', minToolVersion: '1.92.0', driverSchema: 1,
});

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    const r = parseManifest(VALID, '/p/glab');
    expect('manifest' in r).toBe(true);
    expect(r.manifest.tool).toBe('glab');
  });

  it('rejects bad JSON with plugin path', () => {
    const r = parseManifest('{oops', '/p/glab');
    expect('errors' in r).toBe(true);
    expect(r.errors[0].pluginPath).toBe('/p/glab');
  });

  it('rejects unknown kind / wrong driverSchema', () => {
    for (const patch of [{ kind: 'runtime' }, { driverSchema: 2 }]) {
      const r = parseManifest(JSON.stringify({ ...JSON.parse(VALID), ...patch }), '/p/x');
      expect('errors' in r).toBe(true);
    }
  });

  it('keeps individually well-formed name/tool as best-effort identity on schema errors', () => {
    const badVersion = parseManifest(JSON.stringify({ ...JSON.parse(VALID), version: '' }), '/p/x');
    expect('errors' in badVersion).toBe(true);
    if ('errors' in badVersion) {
      expect(badVersion.name).toBe('glab');
      expect(badVersion.tool).toBe('glab');
    }

    const badTool = parseManifest(JSON.stringify({ ...JSON.parse(VALID), tool: 'Bad Tool', version: '' }), '/p/x');
    expect('errors' in badTool).toBe(true);
    if ('errors' in badTool) {
      expect(badTool.name).toBe('glab');
      expect(badTool.tool).toBeUndefined();
    }

    const unparseable = parseManifest('{oops', '/p/x');
    expect('errors' in unparseable).toBe(true);
    if ('errors' in unparseable) {
      expect(unparseable.name).toBeUndefined();
      expect(unparseable.tool).toBeUndefined();
    }
  });

  it('rejects illegal tool shapes', () => {
    for (const tool of ['Glab', 'my tool', 'a\nb', '', '9x']) {
      const r = parseManifest(JSON.stringify({ ...JSON.parse(VALID), tool }), '/p/x');
      expect('errors' in r).toBe(true);
    }
  });

  it('rejects invalid minToolVersion semver', () => {
    const r = parseManifest(JSON.stringify({ ...JSON.parse(VALID), minToolVersion: 'v1..2' }), '/p/x');
    expect('errors' in r).toBe(true);
  });

  it('version is free-form non-empty metadata (spec §5.2 states no format; only minToolVersion is semver-compared)', () => {
    for (const version of ['1.0.0', '1.0', '1.0.0-rc1', '2024.1', 'v3']) {
      const r = parseManifest(JSON.stringify({ ...JSON.parse(VALID), version }), '/p/x');
      expect('manifest' in r, version).toBe(true);
    }
  });

  it('rejects empty / whitespace-only / non-string version', () => {
    for (const version of ['', '   ', 42, null]) {
      const r = parseManifest(JSON.stringify({ ...JSON.parse(VALID), version }), '/p/x');
      expect('errors' in r, JSON.stringify(version)).toBe(true);
    }
  });

  it('rejects semver components beyond 10 digits (Number precision bound)', () => {
    const r = parseManifest(
      JSON.stringify({ ...JSON.parse(VALID), minToolVersion: '99999999999999999999.0.0' }), '/p/x',
    );
    expect('errors' in r).toBe(true);
  });

  it('rejects non-object top-level JSON (null)', () => {
    const r = parseManifest('null', '/p/x');
    expect('errors' in r).toBe(true);
    expect(r.errors[0].message).toContain('must be a JSON object');
  });

  it('rejects non-object top-level JSON (array)', () => {
    const r = parseManifest('[]', '/p/x');
    expect('errors' in r).toBe(true);
    expect(r.errors[0].message).toContain('must be a JSON object');
  });
});

describe('compareSemver', () => {
  it('orders versions', () => {
    expect(compareSemver('1.92.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.92.0', '1.92.0')).toBe(0);
    expect(compareSemver('1.91.9', '1.92.0')).toBe(-1);
  });
});
