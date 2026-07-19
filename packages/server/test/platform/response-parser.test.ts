import { describe, it, expect } from 'vitest';
import { parseJsonResponse, parseJsonPagedPage, ResponseParseError } from '../../src/platform/response-parser.js';

describe('parseJsonResponse', () => {
  it('parses a single object', () => {
    expect(parseJsonResponse('{"a":1}')).toEqual({ a: 1 });
  });

  it('rejects trailing garbage', () => {
    expect(() => parseJsonResponse('{"a":1}x')).toThrow(ResponseParseError);
  });
});

describe('parseJsonPagedPage', () => {
  it('accepts merged-array framing', () => {
    expect(parseJsonPagedPage('[{"iid":1},{"iid":2}]')).toEqual([{ iid: 1 }, { iid: 2 }]);
  });

  it('accepts concatenated-arrays framing with newline', () => {
    expect(parseJsonPagedPage('[{"iid":1}]\n[{"iid":2}]')).toEqual([{ iid: 1 }, { iid: 2 }]);
  });

  it('accepts concatenated-arrays framing without separator', () => {
    expect(parseJsonPagedPage('[{"iid":1}][{"iid":2}]')).toEqual([{ iid: 1 }, { iid: 2 }]);
  });

  it('empty page yields empty array', () => {
    expect(parseJsonPagedPage('[]')).toEqual([]);
  });

  it('rejects empty and whitespace-only stdout (a legal empty list is the literal [])', () => {
    expect(() => parseJsonPagedPage('')).toThrow(ResponseParseError);
    expect(() => parseJsonPagedPage('  \n')).toThrow(ResponseParseError);
    expect(parseJsonPagedPage('[]')).toEqual([]);
  });

  it('rejects non-array JSON', () => {
    expect(() => parseJsonPagedPage('{"a":1}')).toThrow(ResponseParseError);
  });

  it('splits on array boundary even when a string body contains literal "]["', () => {
    expect(parseJsonPagedPage('[{"id":1,"body":"a][b"}][{"id":2}]')).toEqual([
      { id: 1, body: 'a][b' },
      { id: 2 },
    ]);
  });

  it('keeps a single segment whose only element is a string containing "]["', () => {
    expect(parseJsonPagedPage('["a][b"]')).toEqual(['a][b']);
  });

  it('splits correctly when a string contains an escaped quote before a new segment', () => {
    expect(parseJsonPagedPage('["a\\"b"][1]')).toEqual(['a"b', 1]);
  });

  it('rejects an unterminated string with a ResponseParseError, not a raw SyntaxError', () => {
    expect(() => parseJsonPagedPage('["abc')).toThrow(ResponseParseError);
  });

  it('rejects unbalanced bracket depth with a ResponseParseError, not a raw SyntaxError', () => {
    expect(() => parseJsonPagedPage('[{"a":1}')).toThrow(ResponseParseError);
  });
});
