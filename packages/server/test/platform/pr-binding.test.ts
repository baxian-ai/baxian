import { describe, it, expect } from 'vitest';
import { checkPrBinding, checkOpenPrBinding } from '../../src/platform/pr-binding.js';
import type { NormalizedRow } from '../../src/platform/row-schema.js';

const row = (over: Partial<Record<string, unknown>> = {}): NormalizedRow => ({
  prNumber: 42, branch: 'bx/task-1', headSha: 'a'.repeat(40), state: 'open', draft: false,
  mergedAt: null, sourceProjectId: '7', targetProjectId: '7', targetBranch: 'main', ...over,
});

describe('checkPrBinding', () => {
  const expect1 = { branch: 'bx/task-1', expectedBase: 'main' };

  it('passes a matching binding', () => {
    expect(checkPrBinding(row(), expect1)).toBeUndefined();
  });

  it('flags branch mismatch and missing task branch alike', () => {
    expect(checkPrBinding(row({ branch: 'bx/task-2' }), expect1)).toEqual({ kind: 'mismatch', mismatch: 'branch' });
    expect(checkPrBinding(row(), { branch: undefined, expectedBase: 'main' }))
      .toEqual({ kind: 'mismatch', mismatch: 'branch' });
  });

  it('flags fork rows including deleted-fork null source', () => {
    expect(checkPrBinding(row({ sourceProjectId: '8' }), expect1)).toEqual({ kind: 'mismatch', mismatch: 'fork' });
    expect(checkPrBinding(row({ sourceProjectId: null }), expect1)).toEqual({ kind: 'mismatch', mismatch: 'fork' });
  });

  it('compares target against the snapshot first and the cycle default only without one', () => {
    expect(checkPrBinding(row({ targetBranch: 'develop' }), expect1)).toEqual({ kind: 'mismatch', mismatch: 'target' });
    expect(checkPrBinding(row(), { branch: 'bx/task-1', expectedBase: undefined, defaultBranch: 'main' }))
      .toBeUndefined();
    expect(checkPrBinding(row(), { branch: 'bx/task-1', expectedBase: undefined }))
      .toEqual({ kind: 'unverifiable' });
  });
});

describe('checkOpenPrBinding', () => {
  const expect1 = { branch: 'bx/task-1', expectedBase: 'main' };

  it('accepts an open non-draft bound row and reports its head', () => {
    expect(checkOpenPrBinding(row(), expect1)).toEqual({ ok: true });
  });

  it('rejects closed and draft rows before binding checks', () => {
    expect(checkOpenPrBinding(row({ state: 'closed' }), expect1)).toEqual({ ok: false, reason: 'state' });
    expect(checkOpenPrBinding(row({ draft: true }), expect1)).toEqual({ ok: false, reason: 'draft' });
  });

  it('maps binding failures onto the same reason vocabulary', () => {
    expect(checkOpenPrBinding(row({ branch: 'other' }), expect1)).toEqual({ ok: false, reason: 'branch' });
    expect(checkOpenPrBinding(row({ sourceProjectId: null }), expect1)).toEqual({ ok: false, reason: 'fork' });
    expect(checkOpenPrBinding(row({ targetBranch: 'dev' }), expect1)).toEqual({ ok: false, reason: 'target' });
    expect(checkOpenPrBinding(row(), { branch: 'bx/task-1', expectedBase: undefined }))
      .toEqual({ ok: false, reason: 'unverifiable' });
  });
});
