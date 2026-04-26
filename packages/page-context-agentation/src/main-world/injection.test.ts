import { describe, expect, it } from 'vitest';

import { getMainWorldInjectionTarget } from './injection';

describe('getMainWorldInjectionTarget', () => {
  it('从合法 params 中提取 tabId', () => {
    const result = getMainWorldInjectionTarget({ tabId: 42 });
    expect(result).toEqual({ tabId: 42 });
  });

  it('同时提取 frameId（可选）', () => {
    const result = getMainWorldInjectionTarget({ tabId: 10, frameId: 3 });
    expect(result).toEqual({ tabId: 10, frameId: 3 });
  });

  it('缺少 frameId 时结果不含该字段', () => {
    const result = getMainWorldInjectionTarget({ tabId: 1 });
    expect(result).toEqual({ tabId: 1 });
    expect('frameId' in result).toBe(false);
  });

  // ─── 异常路径 ────────────────────────────────────────────────

  it('tabId 为 0 时抛出异常', () => {
    expect(() => getMainWorldInjectionTarget({ tabId: 0 })).toThrow(
      'tabId must be a positive integer',
    );
  });

  it('tabId 为负数时抛出异常', () => {
    expect(() => getMainWorldInjectionTarget({ tabId: -5 })).toThrow(
      'tabId must be a positive integer',
    );
  });

  it('tabId 为 NaN 时抛出异常（Number(NaN) => NaN，不满足 isInteger）', () => {
    expect(() => getMainWorldInjectionTarget({ tabId: NaN })).toThrow();
  });

  it('frameId 为负数时抛出异常', () => {
    expect(() => getMainWorldInjectionTarget({ tabId: 1, frameId: -1 })).toThrow(
      'frameId must be a non-negative integer',
    );
  });

  // ─── 边界输入 ────────────────────────────────────────────────

  it('null / undefined 输入视为无 tabId，抛出异常', () => {
    expect(() => getMainWorldInjectionTarget(null)).toThrow();
    expect(() => getMainWorldInjectionTarget(undefined)).toThrow();
  });

  it('空对象视为 tabId=0，抛出异常', () => {
    expect(() => getMainWorldInjectionTarget({})).toThrow();
  });

  it('frameId 为 0 是合法的（主帧）', () => {
    const result = getMainWorldInjectionTarget({ tabId: 1, frameId: 0 });
    expect(result).toEqual({ tabId: 1, frameId: 0 });
  });
});
