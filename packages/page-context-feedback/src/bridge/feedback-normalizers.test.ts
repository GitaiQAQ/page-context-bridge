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
    it('返回去除首尾空白的文本', () => {
      expect(normalizeText('  hello  ')).toBe('hello');
    });

    it('空字符串返回 undefined', () => {
      expect(normalizeText('')).toBeUndefined();
    });

    it('纯空白字符串返回 undefined', () => {
      expect(normalizeText('   ')).toBeUndefined();
    });

    it('undefined 输入返回 undefined', () => {
      expect(normalizeText(undefined)).toBeUndefined();
    });

    it('无需修剪的文本原样返回', () => {
      expect(normalizeText('hello')).toBe('hello');
    });
  });

  // ─── normalizeUiRect ────────────────────────────────────────────

  describe('normalizeUiRect', () => {
    it('有效矩形原样保留数值', () => {
      const rect = { x: 10, y: 20, width: 100, height: 200 };
      expect(normalizeUiRect(rect)).toEqual({ x: 10, y: 20, width: 100, height: 200 });
    });

    it('undefined 返回 undefined', () => {
      expect(normalizeUiRect(undefined)).toBeUndefined();
    });

    it('NaN 坐标导致返回 undefined', () => {
      expect(normalizeUiRect({ x: NaN, y: 0, width: 1, height: 1 })).toBeUndefined();
    });

    it('负宽或负高导致返回 undefined', () => {
      expect(normalizeUiRect({ x: 0, y: 0, width: -1, height: 10 })).toBeUndefined();
      expect(normalizeUiRect({ x: 0, y: 0, width: 10, height: -1 })).toBeUndefined();
    });

    it('零尺寸是合法的（点/线）', () => {
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
    it('有效范围正常返回', () => {
      expect(normalizeUiTextRange({ start: 0, end: 5 })).toEqual({ start: 0, end: 5 });
    });

    it('undefined 返回 undefined', () => {
      expect(normalizeUiTextRange(undefined)).toBeUndefined();
    });

    it('非整数被拒绝', () => {
      expect(normalizeUiTextRange({ start: 0.5, end: 5 })).toBeUndefined();
    });

    it('负起始位置被拒绝', () => {
      expect(normalizeUiTextRange({ start: -1, end: 5 })).toBeUndefined();
    });

    it('end < start 被拒绝', () => {
      expect(normalizeUiTextRange({ start: 5, end: 3 })).toBeUndefined();
    });

    it('start === end 是合法的（空选区）', () => {
      expect(normalizeUiTextRange({ start: 3, end: 3 })).toEqual({ start: 3, end: 3 });
    });
  });

  // ─── normalizeUiAnchor ──────────────────────────────────────────

  describe('normalizeUiAnchor', () => {
    it('完整锚点保留所有有效字段', () => {
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

    it('undefined 返回 undefined', () => {
      expect(normalizeUiAnchor(undefined)).toBeUndefined();
    });

    it('所有字段无效时返回 undefined', () => {
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

    it('过滤掉非正整数的 framePath 条目', () => {
      const result = normalizeUiAnchor({
        cssSelector: '#ok',
        framePath: [0, -1, 3.5, 'a' as unknown as number, 2],
      } as Parameters<typeof normalizeUiAnchor>[0]);
      expect(result?.framePath).toEqual([0, 2]);
    });

    it('空 meta 对象被丢弃', () => {
      const result = normalizeUiAnchor({
        cssSelector: '#x',
        meta: {},
      });
      expect(result?.meta).toBeUndefined();
    });

    it('有内容的 meta 被深拷贝', () => {
      const meta = { key: 'val' };
      const result = normalizeUiAnchor({ cssSelector: '#x', meta });
      expect(result?.meta).toEqual({ key: 'val' });
      // 确认深拷贝：修改原始对象不影响结果
      (meta as Record<string, unknown>).key = 'changed';
      expect((result?.meta as Record<string, unknown>)?.key).toBe('val');
    });
  });

  // ─── uniqueStrings ──────────────────────────────────────────────

  describe('uniqueStrings', () => {
    it('去重并保持顺序', () => {
      expect(uniqueStrings(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
    });

    it('空数组返回空数组', () => {
      expect(uniqueStrings([])).toEqual([]);
    });

    it('无重复项原样返回', () => {
      expect(uniqueStrings(['x', 'y', 'z'])).toEqual(['x', 'y', 'z']);
    });
  });

  // ─── cloneValue ─────────────────────────────────────────────────

  describe('cloneValue', () => {
    it('深拷贝普通对象', () => {
      const original = { a: 1, b: { c: 2 } };
      const cloned = cloneValue(original);
      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect((cloned as Record<string, unknown>).b).not.toBe(
        (original as Record<string, unknown>).b,
      );
    });

    it('深拷贝数组', () => {
      const original = [
        [1, 2],
        [3, 4],
      ];
      const cloned = cloneValue(original);
      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
    });

    it('基本类型直接返回', () => {
      expect(cloneValue(42)).toBe(42);
      expect(cloneValue('str')).toBe('str');
      expect(cloneValue(null)).toBe(null);
    });
  });
});
