import { describe, expect, it } from 'vitest';

import { getMainWorldInjectionTarget } from './injection';

describe('getMainWorldInjectionTarget', () => {
  it('extracts tabId from valid params', () => {
    const result = getMainWorldInjectionTarget({ tabId: 42 });
    expect(result).toEqual({ tabId: 42 });
  });

  it('also extracts frameId (optional)', () => {
    const result = getMainWorldInjectionTarget({ tabId: 10, frameId: 3 });
    expect(result).toEqual({ tabId: 10, frameId: 3 });
  });

  it('omits frameId when missing', () => {
    const result = getMainWorldInjectionTarget({ tabId: 1 });
    expect(result).toEqual({ tabId: 1 });
    expect('frameId' in result).toBe(false);
  });

  // ─── Error paths ────────────────────────────────────────────────

  it('throws when tabId is 0', () => {
    expect(() => getMainWorldInjectionTarget({ tabId: 0 })).toThrow(
      'tabId must be a positive integer',
    );
  });

  it('throws when tabId is negative', () => {
    expect(() => getMainWorldInjectionTarget({ tabId: -5 })).toThrow(
      'tabId must be a positive integer',
    );
  });

  it('throws when tabId is NaN (Number(NaN) => NaN, fails isInteger)', () => {
    expect(() => getMainWorldInjectionTarget({ tabId: NaN })).toThrow();
  });

  it('throws when frameId is negative', () => {
    expect(() => getMainWorldInjectionTarget({ tabId: 1, frameId: -1 })).toThrow(
      'frameId must be a non-negative integer',
    );
  });

  // ─── Edge cases ────────────────────────────────────────────────

  it('throws on null / undefined input (no tabId)', () => {
    expect(() => getMainWorldInjectionTarget(null)).toThrow();
    expect(() => getMainWorldInjectionTarget(undefined)).toThrow();
  });

  it('throws on empty object (treated as tabId=0)', () => {
    expect(() => getMainWorldInjectionTarget({})).toThrow();
  });

  it('frameId=0 is valid (main frame)', () => {
    const result = getMainWorldInjectionTarget({ tabId: 1, frameId: 0 });
    expect(result).toEqual({ tabId: 1, frameId: 0 });
  });
});
