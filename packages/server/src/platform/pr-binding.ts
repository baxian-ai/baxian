import type { NormalizedRow } from './row-schema.js';

type BindingMismatch = 'branch' | 'fork' | 'target';
export type BindingCheck = { kind: 'mismatch'; mismatch: BindingMismatch } | { kind: 'unverifiable' };

export interface BindingExpectation {
  branch: string | undefined;
  expectedBase: string | undefined;
  defaultBranch?: string;
}

export function checkPrBinding(prRow: NormalizedRow, expect: BindingExpectation): BindingCheck | undefined {
  if (expect.branch === undefined || String(prRow.branch) !== expect.branch) {
    return { kind: 'mismatch', mismatch: 'branch' };
  }
  if (prRow.sourceProjectId === null || prRow.sourceProjectId === undefined
    || prRow.sourceProjectId !== prRow.targetProjectId) {
    return { kind: 'mismatch', mismatch: 'fork' };
  }
  const expected = expect.expectedBase ?? expect.defaultBranch;
  if (expected === undefined) return { kind: 'unverifiable' };
  if (String(prRow.targetBranch) !== expected) return { kind: 'mismatch', mismatch: 'target' };
  return undefined;
}

export type PrRejection = 'state' | 'draft' | BindingMismatch | 'unverifiable';

export function checkOpenPrBinding(
  prRow: NormalizedRow,
  expect: BindingExpectation,
): { ok: true } | { ok: false; reason: PrRejection } {
  if (prRow.state !== 'open') return { ok: false, reason: 'state' };
  if (prRow.draft !== false) return { ok: false, reason: 'draft' };
  const binding = checkPrBinding(prRow, expect);
  if (binding === undefined) return { ok: true };
  return { ok: false, reason: binding.kind === 'unverifiable' ? 'unverifiable' : binding.mismatch };
}
