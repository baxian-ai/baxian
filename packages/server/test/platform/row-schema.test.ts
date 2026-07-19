import { describe, it, expect } from 'vitest';
import { validateRows, versionTimeOf, RowSchemaError } from '../../src/platform/row-schema.js';

const PR_ROW = {
  prNumber: 42, prUrl: 'https://example.com/pr/42', branch: 'bx/task-1',
  headSha: 'ABC123abc123abc123abc123abc123abc123abc1', state: 'open', draft: false,
  mergedAt: null, updatedAt: '2026-07-17T01:02:03Z',
  sourceProjectId: 7, targetProjectId: 7, targetBranch: 'main',
};

describe('row-schema: listPrs/prView', () => {
  it('normalizes ids to strings and shas to lowercase', () => {
    const [row] = validateRows('listPrs', [PR_ROW]);
    expect(row!.sourceProjectId).toBe('7');
    expect(row!.targetProjectId).toBe('7');
    expect(row!.headSha).toBe('abc123abc123abc123abc123abc123abc123abc1');
    expect(row!.prNumber).toBe(42);
  });

  it('rejects non-boolean draft', () => {
    expect(() => validateRows('listPrs', [{ ...PR_ROW, draft: 0 }])).toThrow(RowSchemaError);
    expect(() => validateRows('listPrs', [{ ...PR_ROW, draft: 'true' }])).toThrow(RowSchemaError);
  });

  it('rejects unparseable and loosely-parsed timestamps', () => {
    expect(() => validateRows('listPrs', [{ ...PR_ROW, updatedAt: 'not-a-date' }])).toThrow(RowSchemaError);
    expect(() => validateRows('listPrs', [{ ...PR_ROW, updatedAt: '1' }])).toThrow(RowSchemaError);
  });

  it('requires an explicit RFC3339 offset so the watermark cannot drift with the host timezone', () => {
    expect(() => validateRows('listPrs', [{ ...PR_ROW, updatedAt: '2026-07-17T12:00:00' }])).toThrow(RowSchemaError);
    expect(() => validateRows('listPrs', [{ ...PR_ROW, updatedAt: '2026-07-17 12:00:00Z' }])).toThrow(RowSchemaError);
    for (const good of ['2026-07-17T12:00:00Z', '2026-07-17t12:00:00z', '2026-07-17T12:00:00.250+08:00', '2026-07-17T12:00:00-05:00']) {
      expect(validateRows('listPrs', [{ ...PR_ROW, updatedAt: good }])).toHaveLength(1);
    }
  });

  it('rejects calendar-impossible dates that Date.parse would silently normalize', () => {
    expect(() => validateRows('listPrs', [{ ...PR_ROW, updatedAt: '2026-02-30T00:00:00Z' }])).toThrow(RowSchemaError);
    expect(() => validateRows('listPrs', [{ ...PR_ROW, updatedAt: '2026-13-01T00:00:00Z' }])).toThrow(RowSchemaError);
    expect(() => validateRows('listPrs', [{ ...PR_ROW, updatedAt: '2026-07-17T25:00:00Z' }])).toThrow(RowSchemaError);
    expect(validateRows('listPrs', [{ ...PR_ROW, updatedAt: '2028-02-29T00:00:00Z' }])).toHaveLength(1);
  });

  it('rejects out-of-range UTC offsets that Date.parse silently converts', () => {
    expect(() => validateRows('listPrs', [{ ...PR_ROW, updatedAt: '2026-07-17T12:00:00+99:99' }])).toThrow(RowSchemaError);
    expect(() => validateRows('listPrs', [{ ...PR_ROW, updatedAt: '2026-07-17T12:00:00-24:00' }])).toThrow(RowSchemaError);
    expect(validateRows('listPrs', [{ ...PR_ROW, updatedAt: '2026-07-17T12:00:00+23:59' }])).toHaveLength(1);
  });

  it('validates system as a strict boolean', () => {
    const ts = '2026-07-17T01:02:03Z';
    expect(validateRows('listComments', [{ id: 1, body: 'x', createdAt: ts, system: true }])[0]!.system).toBe(true);
    expect(() => validateRows('listComments', [{ id: 1, body: 'x', createdAt: ts, system: 'false' }]))
      .toThrow(RowSchemaError);
  });

  it('rejects out-of-domain state even after translation', () => {
    expect(() => validateRows('listPrs', [{ ...PR_ROW, state: 'opened' }])).toThrow(RowSchemaError);
  });

  it('rejects null for per-op required fields', () => {
    expect(() => validateRows('listPrs', [{ ...PR_ROW, targetBranch: null }])).toThrow(RowSchemaError);
    expect(() => validateRows('listPrs', [{ ...PR_ROW, prNumber: undefined }])).toThrow(RowSchemaError);
  });

  it('allows null for nullable fields', () => {
    const [row] = validateRows('listPrs', [{ ...PR_ROW, sourceProjectId: null, mergedAt: null }]);
    expect(row!.sourceProjectId).toBe(null);
  });

  it('prView does not require prNumber or updatedAt', () => {
    const { prNumber: _n, updatedAt: _u, ...rest } = PR_ROW;
    const rows = validateRows('prView', [rest]);
    expect(rows).toHaveLength(1);
  });

  it('rejects a malformed sha', () => {
    expect(() => validateRows('prView', [{ ...PR_ROW, headSha: 'not-a-sha!' }])).toThrow(RowSchemaError);
  });
});

describe('row-schema: listComments', () => {
  const COMMENT = { id: 100, body: 'hello', createdAt: '2026-07-17T01:02:03Z', updatedAt: '2026-07-17T01:02:03Z' };

  it('normalizes integer and line-safe string ids', () => {
    expect(validateRows('listComments', [COMMENT])[0]!.id).toBe('100');
    expect(validateRows('listComments', [{ ...COMMENT, id: 'note_1.2-x' }])[0]!.id).toBe('note_1.2-x');
  });

  it('rejects ids with colons, whitespace, or empty strings', () => {
    for (const id of ['a:b', 'a b', '', 'a\nb']) {
      expect(() => validateRows('listComments', [{ ...COMMENT, id }])).toThrow(RowSchemaError);
    }
  });

  it('requires id but tolerates missing timestamps row-wise', () => {
    expect(() => validateRows('listComments', [{ ...COMMENT, id: null }])).toThrow(RowSchemaError);
    const rows = validateRows('listComments', [{ id: 5, body: 'x', createdAt: undefined, updatedAt: undefined }]);
    expect(rows).toHaveLength(1);
  });

  it('validates integer line fields and string display fields', () => {
    expect(() => validateRows('listComments', [{ ...COMMENT, line: 'five' }])).toThrow(RowSchemaError);
    expect(() => validateRows('listComments', [{ ...COMMENT, reviewState: 42 }])).toThrow(RowSchemaError);
    const [row] = validateRows('listComments', [{ ...COMMENT, line: 5, reviewState: 'APPROVED', authorId: 9 }]);
    expect(row!.line).toBe(5);
    expect(row!.authorId).toBe('9');
  });

  it('reports the source key and row index in the error', () => {
    expect(() => validateRows('listComments', [COMMENT, { ...COMMENT, id: 'a:b' }], { sourceKey: 'reviews' }))
      .toThrow(/listComments\[reviews\].*row 1.*id/);
  });
});

describe('row-schema: projectView and booleans', () => {
  it('requires defaultBranch and validates pushPermitted as boolean', () => {
    expect(() => validateRows('projectView', [{ defaultBranch: null }])).toThrow(RowSchemaError);
    expect(() => validateRows('projectView', [{ defaultBranch: 'main', pushPermitted: 'yes' }])).toThrow(RowSchemaError);
    const [row] = validateRows('projectView', [{ defaultBranch: 'main', pushPermitted: true }]);
    expect(row!.pushPermitted).toBe(true);
  });
});

describe('versionTimeOf', () => {
  it('prefers updatedAt, falls back to createdAt, and returns undefined when both missing', () => {
    expect(versionTimeOf({ updatedAt: '2026-07-17T00:00:02Z', createdAt: '2026-07-17T00:00:01Z' }))
      .toBe(Date.parse('2026-07-17T00:00:02Z'));
    expect(versionTimeOf({ createdAt: '2026-07-17T00:00:01Z' })).toBe(Date.parse('2026-07-17T00:00:01Z'));
    expect(versionTimeOf({})).toBe(undefined);
    expect(versionTimeOf({ updatedAt: null, createdAt: null })).toBe(undefined);
  });
});

describe('row-schema: nullable review bodies', () => {
  it('tolerates null and missing bodies on listComments rows', () => {
    const rows = validateRows('listComments', [
      { id: 900, body: null, createdAt: '2026-07-17T01:02:03Z', updatedAt: '2026-07-17T01:02:03Z' },
      { id: 901, createdAt: '2026-07-17T01:02:03Z', updatedAt: '2026-07-17T01:02:03Z' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.body).toBe(null);
  });

  it('still rejects non-string body values', () => {
    expect(() => validateRows('listComments', [{ id: 1, body: 42, createdAt: '2026-07-17T01:02:03Z' }]))
      .toThrow(RowSchemaError);
  });
});
