import { describe, it, expect } from 'vitest';
import * as real from '../../src/api.ts';
import { createApiMock } from './api-mock.ts';

function leafPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.keys(obj)
    .sort()
    .flatMap((key) => {
      const value = obj[key];
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'object' && value !== null) {
        return leafPaths(value as Record<string, unknown>, path);
      }
      return [`${path}:${typeof value}`];
    });
}

describe('createApiMock 与真实模块表面一致（防 as/any 绕过编译期守护）', () => {
  it('顶层值导出的键集合与类型双向一致', () => {
    const mock = createApiMock() as unknown as Record<string, unknown>;
    const realModule = { ...real } as unknown as Record<string, unknown>;
    expect(
      Object.keys(mock)
        .sort()
        .map((k) => `${k}:${typeof mock[k]}`),
    ).toEqual(
      Object.keys(realModule)
        .sort()
        .map((k) => `${k}:${typeof realModule[k]}`),
    );
  });

  it('api 对象各 namespace 的方法键递归双向一致', () => {
    const mock = createApiMock();
    expect(leafPaths(mock.api)).toEqual(leafPaths(real.api));
  });

  it('ApiError mock 实例结构与真实一致', () => {
    const mock = createApiMock();
    const err = new mock.ApiError(422, 'invalid', [{ path: 'title', message: 'required' }]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
    expect(err.status).toBe(422);
    expect(err.message).toBe('invalid');
    expect(err.details).toEqual([{ path: 'title', message: 'required' }]);
  });
});
