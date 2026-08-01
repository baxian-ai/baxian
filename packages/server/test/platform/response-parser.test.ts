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

  it('rejects concatenated arrays because one gh page has one JSON array', () => {
    expect(() => parseJsonPagedPage('[{"id":1}]\n[{"id":2}]')).toThrow(ResponseParseError);
    expect(() => parseJsonPagedPage('[{"id":1}][{"id":2}]')).toThrow(ResponseParseError);
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

  it('keeps a single segment whose only element is a string containing "]["', () => {
    expect(parseJsonPagedPage('["a][b"]')).toEqual(['a][b']);
  });

  it('rejects an unterminated string with a ResponseParseError, not a raw SyntaxError', () => {
    expect(() => parseJsonPagedPage('["abc')).toThrow(ResponseParseError);
  });

  it('rejects unbalanced bracket depth with a ResponseParseError, not a raw SyntaxError', () => {
    expect(() => parseJsonPagedPage('[{"a":1}')).toThrow(ResponseParseError);
  });
});
