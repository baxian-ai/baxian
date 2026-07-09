import { describe, it, expect } from 'vitest';
import { extractReviewPassToken, isManagedPr, reviewVerdict } from '../../src/github/mapper.js';

describe('reviewVerdict', () => {
  it('maps review states case-insensitively and rejects everything else', () => {
    expect(reviewVerdict({ state: 'approved' })).toEqual({ action: 'APPROVE' });
    expect(reviewVerdict({ state: 'CHANGES_REQUESTED' })).toEqual({ action: 'REQUEST_CHANGES' });
    expect(reviewVerdict({ state: 'commented' })).toBeUndefined();
    expect(reviewVerdict({ state: '' })).toBeUndefined();
  });
});

describe('extractReviewPassToken', () => {
  it('extracts the token from the hidden marker and tolerates null/absent bodies', () => {
    expect(extractReviewPassToken('LGTM\n<!-- baxian:pr-approved:tok123abc -->')).toBe('tok123abc');
    expect(extractReviewPassToken('<!-- baxian:pr-changes-requested:tok456def -->')).toBe('tok456def');
    expect(extractReviewPassToken('<!-- baxian:pr-approved:x -->')).toBeUndefined();
    expect(extractReviewPassToken(null)).toBeUndefined();
    expect(extractReviewPassToken(undefined)).toBeUndefined();
    expect(extractReviewPassToken('no marker at all')).toBeUndefined();
  });
});

describe('isManagedPr', () => {
  it('bx/ prefix → true (unique namespace, PR number irrelevant)', () => {
    expect(isManagedPr('bx/task-001')).toBe(true);
  });

  it('custom branch whose PR number is tracked by a task → true', () => {
    expect(isManagedPr('feat/my-feature', 20, new Set([20]))).toBe(true);
  });

  it('custom branch whose PR number is NOT tracked → false (reused branch name)', () => {
    expect(isManagedPr('feat/my-feature', 20, new Set([99]))).toBe(false);
  });

  it('custom branch with no PR number or no tracked set → false', () => {
    expect(isManagedPr('feat/my-feature')).toBe(false);
    expect(isManagedPr('feat/my-feature', 20)).toBe(false);
  });
});
