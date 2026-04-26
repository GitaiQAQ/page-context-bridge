import { describe, expect, it } from 'vitest';

import {
  cloneValue,
  normalizeText,
  normalizeUiAnchor,
  normalizeUiRect,
  normalizeUiTextRange,
  uniqueStrings,
} from './feedback-normalizers';

describe('feedback-normalizers', () => {
  // ─── normalizeText ──────────────────────────────────────────────

  describe('normalizeText', () => {
    it('returns trimmed text', () => {
      expect(normalizeText('  hello  ')).toBe('hello');
    });

    it('returns undefined for empty string', () => {
      expect(normalizeText('')).toBeUndefined();
    });

    it('returns undefined for whitespace-only string', () => {
      expect(normalizeText('   ')).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
      expect(normalizeText(undefined)).toBeUndefined();
    });

    it('returns text as-is when no trimming needed', () => {
      expect(normalizeText('hello')).toBe('hello');
    });
  });

  // ─── normalizeUiRect ────────────────────────────────────────────

  describe('normalizeUiRect', () => {
    it('keeps valid rect values as-is', () => {
      const rect = { x: 10, y: 20, width: 100, height: 200 };
      expect(normalizeUiRect(rect)).toEqual({ x: 10, y: 20, width: 100, height: 200 });
    });

    it('returns undefined for undefined input', () => {
      expect(normalizeUiRect(undefined)).toBeUndefined();
    });

    it('returns undefined for NaN coordinates', () => {
      expect(normalizeUiRect({ x: NaN, y: 0, width: 1, height: 1 })).toBeUndefined();
    });

    it('returns undefined for negative width or height', () => {
      expect(normalizeUiRect({ x: 0, y: 0, width: -1, height: 10 })).toBeUndefined();
      expect(normalizeUiRect({ x: 0, y: 0, width: 10, height: -1 })).toBeUndefined();
    });

    it('zero size is valid (point / line)', () => {
      expect(normalizeUiRect({ x: 0, y: 0, width: 0, height: 0 })).toEqual({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
    });
  });

  // ─── normalizeUiTextRange ───────────────────────────────────────

  describe('normalizeUiTextRange', () => {
    it('returns valid range as-is', () => {
      expect(normalizeUiTextRange({ start: 0, end: 5 })).toEqual({ start: 0, end: 5 });
    });

    it('returns undefined for undefined input', () => {
      expect(normalizeUiTextRange(undefined)).toBeUndefined();
    });

    it('rejects non-integer values', () => {
      expect(normalizeUiTextRange({ start: 0.5, end: 5 })).toBeUndefined();
    });

    it('rejects negative start position', () => {
      expect(normalizeUiTextRange({ start: -1, end: 5 })).toBeUndefined();
    });

    it('rejects when end < start', () => {
      expect(normalizeUiTextRange({ start: 5, end: 3 })).toBeUndefined();
    });

    it('start === end is valid (empty selection)', () => {
      expect(normalizeUiTextRange({ start: 3, end: 3 })).toEqual({ start: 3, end: 3 });
    });
  });

  // ─── normalizeUiAnchor ──────────────────────────────────────────

  describe('normalizeUiAnchor', () => {
    it('keeps all valid fields for a complete anchor', () => {
      const anchor = {
        elementId: 'el-1',
        cssSelector: '#btn',
        xpath: "//div[@id='btn']",
        textQuote: 'click me',
        framePath: [0, 1],
        rect: { x: 10, y: 20, width: 100, height: 50 },
        textRange: { start: 0, end: 8 },
        meta: { tag: 'button' },
      };
      const result = normalizeUiAnchor(anchor);
      expect(result).toEqual(anchor);
    });

    it('returns undefined for undefined input', () => {
      expect(normalizeUiAnchor(undefined)).toBeUndefined();
    });

    it('returns undefined when all fields are invalid', () => {
      expect(
        normalizeUiAnchor({
          elementId: '   ',
          cssSelector: '',
          xpath: undefined,
          textQuote: '\t',
          framePath: [],
          rect: undefined,
          textRange: undefined,
          meta: {},
        }),
      ).toBeUndefined();
    });

    it('filters out non-positive-integer framePath entries', () => {
      const result = normalizeUiAnchor({
        cssSelector: '#ok',
        framePath: [0, -1, 3.5, 'a' as unknown as number, 2],
      } as Parameters<typeof normalizeUiAnchor>[0]);
      expect(result?.framePath).toEqual([0, 2]);
    });

    it('drops empty meta object', () => {
      const result = normalizeUiAnchor({
        cssSelector: '#x',
        meta: {},
      });
      expect(result?.meta).toBeUndefined();
    });

    it('deep clones non-empty meta', () => {
      const meta = { key: 'val' };
      const result = normalizeUiAnchor({ cssSelector: '#x', meta });
      expect(result?.meta).toEqual({ key: 'val' });
      // Verify deep clone: mutating original does not affect result
      (meta as Record<string, unknown>).key = 'changed';
      expect((result?.meta as Record<string, unknown>)?.key).toBe('val');
    });
  });

  // ─── uniqueStrings ──────────────────────────────────────────────

  describe('uniqueStrings', () => {
    it('deduplicates while preserving order', () => {
      expect(uniqueStrings(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
    });

    it('returns empty array for empty input', () => {
      expect(uniqueStrings([])).toEqual([]);
    });

    it('returns array as-is when no duplicates', () => {
      expect(uniqueStrings(['x', 'y', 'z'])).toEqual(['x', 'y', 'z']);
    });
  });

  // ─── cloneValue ─────────────────────────────────────────────────

  describe('cloneValue', () => {
    it('deep clones plain objects', () => {
      const original = { a: 1, b: { c: 2 } };
      const cloned = cloneValue(original);
      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect((cloned as Record<string, unknown>).b).not.toBe(
        (original as Record<string, unknown>).b,
      );
    });

    it('deep clones arrays', () => {
      const original = [
        [1, 2],
        [3, 4],
      ];
      const cloned = cloneValue(original);
      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
    });

    it('returns primitives as-is', () => {
      expect(cloneValue(42)).toBe(42);
      expect(cloneValue('str')).toBe('str');
      expect(cloneValue(null)).toBe(null);
    });
  });
});
