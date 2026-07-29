import { describe, it, expect } from 'vitest';
import { mapResponse, FieldMappingError } from '../../src/platform/field-mapper.js';
import type { DriverOp } from '../../src/platform/types.js';

describe('field-mapper', () => {
  it('null value is legal (opened MR has merged_at: null)', () => {
    const op: DriverOp = { argv: ['x'], map: { prNumber: 'iid', mergedAt: 'merged_at' } };
    const rows = mapResponse('listPrs', op, [{ iid: 7, merged_at: null }]);
    expect(rows[0].prNumber).toBe(7);
    expect(rows[0].mergedAt).toBe(null);
  });

  it('missing required key throws FieldMappingError', () => {
    const op: DriverOp = { argv: ['x'], map: { headSha: 'sha' } };
    expect(() => mapResponse('prView', op, { not_sha: 'x' })).toThrow(FieldMappingError);
  });

  it('sources alias chain picks first existing key', () => {
    const op: DriverOp = { argv: ['x'], map: { draft: { sources: ['draft', 'work_in_progress'] } } };
    expect(mapResponse('prView', op, { draft: true })[0].draft).toBe(true);
    expect(mapResponse('prView', op, { work_in_progress: false })[0].draft).toBe(false);
    expect(() => mapResponse('prView', op, {})).toThrow(FieldMappingError);
  });

  it('optional field absent maps to undefined without failing the op', () => {
    const op: DriverOp = { argv: ['x'], map: { detailedMergeStatus: { sources: ['detailed_merge_status'], optional: true } } };
    const rows = mapResponse('prView', op, {});
    expect(rows[0].detailedMergeStatus).toBe(undefined);
  });

  it('dot path and flatten with _discussion parent ref', () => {
    const op: DriverOp = {
      argv: ['x'], flatten: 'notes',
      map: { id: 'id', discussionId: '_discussion.id', author: 'author.username' },
    };
    const payload = [{ id: 'D1', notes: [{ id: 11, author: { username: 'alice' } }, { id: 12, author: { username: 'bob' } }] }];
    const rows = mapResponse('listComments', op, payload);
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.discussionId)).toEqual(['D1', 'D1']);
    expect(rows[1].author).toBe('bob');
  });

  it('single-level [] flatten inside a path', () => {
    const op: DriverOp = { argv: ['x'], flatten: 'approved_by', map: { username: 'user.username' } };
    const rows = mapResponse('listApprovals', op, { approved_by: [{ user: { username: 'qa1' } }] });
    expect(rows[0].username).toBe('qa1');
  });

  it('payload null or scalar treated as empty array (no crash)', () => {
    const op: DriverOp = { argv: ['x'], map: { name: 'name' } };
    expect(mapResponse('test', op, null)).toEqual([]);
    expect(mapResponse('test', op, 'scalar')).toEqual([]);
    expect(mapResponse('test', op, 123)).toEqual([]);
  });
});

describe('field-mapper: single-level [] source-path flatten (map value getter, spec §5.3)', () => {
  it('flattens `name[].rest` into an array value on a single row', () => {
    const op: DriverOp = { argv: ['x'], map: { usernames: 'approved_by[].user.username' } };
    const rows = mapResponse('listApprovals', op, {
      approved_by: [{ user: { username: 'qa1' } }, { user: { username: 'qa2' } }],
    });
    expect(rows.length).toBe(1);
    expect(rows[0].usernames).toEqual(['qa1', 'qa2']);
  });

  it('skips array elements missing the remaining path key (lenient aggregation)', () => {
    const op: DriverOp = { argv: ['x'], map: { usernames: 'approved_by[].user.username' } };
    const rows = mapResponse('listApprovals', op, {
      approved_by: [{ user: { username: 'qa1' } }, { user: {} }, { other: 1 }],
    });
    expect(rows[0].usernames).toEqual(['qa1']);
  });

  it('empty array at the bracketed key is a legal empty result, not MISSING', () => {
    const op: DriverOp = { argv: ['x'], map: { usernames: 'approved_by[].user.username' } };
    expect(mapResponse('listApprovals', op, { approved_by: [] })[0].usernames).toEqual([]);
  });

  it('the array key itself missing goes through ordinary required/optional semantics', () => {
    const required: DriverOp = { argv: ['x'], map: { usernames: 'approved_by[].user.username' } };
    expect(() => mapResponse('listApprovals', required, {})).toThrow(FieldMappingError);

    const optional: DriverOp = {
      argv: ['x'], map: { usernames: { sources: ['approved_by[].user.username'], optional: true } },
    };
    expect(mapResponse('listApprovals', optional, {})[0].usernames).toBe(undefined);
  });

  it('a non-array value at the bracketed key is a shape error, not a silent skip', () => {
    const op: DriverOp = { argv: ['x'], map: { usernames: 'approved_by[].user.username' } };
    expect(() => mapResponse('listApprovals', op, { approved_by: 'not-an-array' })).toThrow(FieldMappingError);
  });

  it('rejects a second [] level in the same source path', () => {
    const op: DriverOp = { argv: ['x'], map: { bad: 'a[].b[].c' } };
    expect(() => mapResponse('listApprovals', op, { a: [{ b: [{ c: 1 }] }] })).toThrow(FieldMappingError);
  });

  it('a null array key is a present empty collection (spec null-as-present), never the missing path', () => {
    const required: DriverOp = { argv: ['x'], map: { usernames: 'reviewers[].login' } };
    expect(mapResponse('prView', required, { reviewers: null })[0].usernames).toEqual([]);
    expect(mapResponse('prView', required, { reviewers: [] })[0].usernames).toEqual([]);

    const optional: DriverOp = { argv: ['x'], map: { usernames: { sources: ['reviewers[].login'], optional: true } } };
    expect(mapResponse('prView', optional, { reviewers: null })[0].usernames).toEqual([]);
    expect(() => mapResponse('prView', required, {})).toThrow(/missing/);
    expect(() => mapResponse('prView', optional, { reviewers: 'oops' })).toThrow(/expects an array/);
  });

  it('prototype-chain keys are not data: source "constructor" is missing, not the Object function', () => {
    const op: DriverOp = { argv: ['x'], map: { headSha: 'constructor' } };
    expect(() => mapResponse('prView', op, { sha: 'x' })).toThrow(FieldMappingError);

    const optional: DriverOp = { argv: ['x'], map: { headSha: { sources: ['__proto__'], optional: true } } };
    expect(mapResponse('prView', optional, { sha: 'x' })[0].headSha).toBe(undefined);
  });

  it('flatten "constructor" fails closed instead of walking the prototype', () => {
    const op: DriverOp = { argv: ['x'], flatten: 'constructor', map: { id: { sources: ['id'], optional: true } } };
    expect(() => mapResponse('listComments', op, { notes: [{ id: 1 }] })).toThrow(/flatten path 'constructor' missing/);
  });

  it('op-level flatten fails closed on missing paths and non-array values, and treats null/[] as empty', () => {
    const op: DriverOp = { argv: ['x'], flatten: 'notes', map: { id: { sources: ['id'], optional: true } } };
    expect(() => mapResponse('listComments', op, [{ discussion: 'd1' }])).toThrow(/flatten path 'notes' missing/);
    expect(() => mapResponse('listComments', op, [{ notes: 'oops' }])).toThrow(/expects an array/);
    expect(() => mapResponse('listComments', op, [{ notes: [{ id: 1 }] }, { notes: 42 }])).toThrow(/expects an array/);
    expect(mapResponse('listComments', op, [{ notes: null }, { notes: [] }])).toEqual([]);
    expect(mapResponse('listComments', op, [{ notes: [{ id: 1 }] }])).toEqual([{ id: 1 }]);
  });
});

describe('field-mapper: values translation', () => {
  const op: DriverOp = {
    argv: ['x'],
    map: { state: { sources: ['state'], values: { opened: 'open', merged: 'closed' } } },
  };

  it('translates a matched string value', () => {
    expect(mapResponse('prView', op, { state: 'opened' })[0].state).toBe('open');
  });

  it('passes unmatched strings through untouched', () => {
    expect(mapResponse('prView', op, { state: 'closed' })[0].state).toBe('closed');
  });

  it('leaves null and non-string hits untranslated', () => {
    expect(mapResponse('prView', op, { state: null })[0].state).toBe(null);
    const numOp: DriverOp = { argv: ['x'], map: { line: { sources: ['line'], values: { '5': 'five' } } } };
    expect(mapResponse('listComments', numOp, { line: 5 })[0].line).toBe(5);
  });
});
