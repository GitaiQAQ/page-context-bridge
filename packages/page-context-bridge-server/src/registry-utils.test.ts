import { describe, expect, it } from 'vitest';

import {
  buildContextPromptName,
  buildContextResourceName,
  buildContextResourceUri,
  createFeedbackActor,
  createTextResponse,
  expandBuiltinToolNameAliases,
  getOrCreateServerHandleMap,
  isFeedbackAgentPushStatusReader,
  log,
  normalizePageToolName,
  uniqueStrings,
} from './registry-utils.js';

describe('registry-utils', () => {
  describe('getOrCreateServerHandleMap()', () => {
    it('creates new Map for unknown server', () => {
      const store = new WeakMap<object, Map<string, string>>();
      const server = {};
      const map = getOrCreateServerHandleMap(store, server as unknown as object);

      expect(map).toBeInstanceOf(Map);
      expect(map.size).toBe(0);
    });

    it('returns existing Map for known server', () => {
      const store = new WeakMap<object, Map<string, string>>();
      const server = {};
      const map1 = getOrCreateServerHandleMap(store, server as unknown as object);
      map1.set('key', 'value');
      const map2 = getOrCreateServerHandleMap(store, server as unknown as object);

      expect(map1).toBe(map2);
      expect(map2.get('key')).toBe('value');
    });
  });

  describe('normalizePageToolName()', () => {
    it('returns tool name as-is when no namespace prefix', () => {
      const result = normalizePageToolName({ name: 'click_element' });
      expect(result).toBe('click_element');
    });

    it('removes namespace prefix when matches exactly', () => {
      // After stripping "catalog.", result must start with "catalog_" or "catalog."
      const result = normalizePageToolName({
        name: 'catalog.catalog.click_element',
        _namespace: 'catalog',
      });
      expect(result).toBe('catalog.click_element');
    });

    it('does not strip when trimmed name does not re-start with namespace', () => {
      const result = normalizePageToolName({
        name: 'catalog.click_element',
        _namespace: 'catalog',
      });
      // After stripping "catalog.", we get "click_element" which doesn't start with "catalog_"
      expect(result).toBe('catalog.click_element');
    });

    it('handles nested namespace prefixes (double prefix)', () => {
      const result = normalizePageToolName({
        name: 'catalog.catalog.click_element',
        _namespace: 'catalog',
      });
      expect(result).toBe('catalog.click_element');
    });

    it('does not strip when trimmed name does not re-start with namespace', () => {
      const result = normalizePageToolName({
        name: 'catalog_other.click_element',
        _namespace: 'catalog',
      });
      expect(result).toBe('catalog_other.click_element');
    });

    it('handles tools without _namespace', () => {
      const result = normalizePageToolName({ name: 'some.tool' });
      expect(result).toBe('some.tool');
    });
  });

  describe('buildContextResourceName()', () => {
    it('generates name with tabId, namespace, resource id', () => {
      const result = buildContextResourceName(5, { namespace: 'ns', id: 'resource-1' });
      expect(result).toBe('tab.5.resource.ns.resource-1');
    });

    it('sanitizes special characters in resource id', () => {
      // Regex: /[^a-zA-Z0-9._-]/g — hyphens are preserved
      const result = buildContextResourceName(3, { namespace: 'ns', id: 'res/with:special.chars' });
      expect(result).toBe('tab.3.resource.ns.res-with-special.chars');
    });
  });

  describe('buildContextResourceUri()', () => {
    it('generates URI with tabId, namespace, encoded resource id', () => {
      const result = buildContextResourceUri(7, { namespace: 'ns', id: 'resource/with spaces' });
      expect(result).toBe('context://tab/7/resource/ns/resource%2Fwith%20spaces');
    });
  });

  describe('buildContextPromptName()', () => {
    it('generates name with tabId, namespace, skill id', () => {
      const result = buildContextPromptName(10, { namespace: 'ns', id: 'skill-1' });
      expect(result).toBe('tab.10.skill.ns.skill-1');
    });

    it('sanitizes special characters in skill id', () => {
      const result = buildContextPromptName(3, { namespace: 'ns', id: 'skill/with.dots' });
      expect(result).toBe('tab.3.skill.ns.skill-with.dots');
    });
  });

  describe('uniqueStrings()', () => {
    it('removes duplicates', () => {
      expect(uniqueStrings(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
    });

    it('preserves order of first occurrence', () => {
      expect(uniqueStrings(['z', 'a', 'y', 'a', 'z'])).toEqual(['z', 'a', 'y']);
    });

    it('handles empty array', () => {
      expect(uniqueStrings([])).toEqual([]);
    });

    it('handles all-duplicates array', () => {
      expect(uniqueStrings(['x', 'x', 'x'])).toEqual(['x']);
    });
  });

  describe('createFeedbackActor()', () => {
    it('copies all fields', () => {
      const input = { source: 'agent' as const, id: 'bot-1', displayName: 'Bot One' };
      const result = createFeedbackActor(input);

      expect(result.source).toBe('agent');
      expect(result.id).toBe('bot-1');
      expect(result.displayName).toBe('Bot One');
    });

    it('creates new object (not reference)', () => {
      const input = { source: 'extension' as const, id: 'ext', displayName: 'Ext' };
      const result = createFeedbackActor(input);

      expect(result).not.toBe(input);
    });
  });

  describe('createTextResponse()', () => {
    it('wraps text in content array', () => {
      const result = createTextResponse('hello world');

      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({ type: 'text', text: 'hello world' });
    });

    it('uses correct MIME type structure', () => {
      const result = createTextResponse('test');

      expect(result.content[0]?.type).toBe('text');
    });
  });

  describe('expandBuiltinToolNameAliases()', () => {
    it('expands canonical name', () => {
      const result = expandBuiltinToolNameAliases(['builtin.tabs.list_tabs']);

      expect(result).toBeInstanceOf(Set);
      expect(result.has('builtin.tabs.list_tabs')).toBe(true);
      expect(result.has('builtin.list_tabs')).toBe(true);
      expect(result.has('list_tabs')).toBe(true);
    });

    it('keeps non-canonical name unchanged', () => {
      const result = expandBuiltinToolNameAliases(['take_screenshot']);

      expect(result).toBeInstanceOf(Set);
      expect(result.has('take_screenshot')).toBe(true);
      expect(result.size).toBe(1);
    });

    it('handles empty array', () => {
      const result = expandBuiltinToolNameAliases([]);

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });

    it('handles multiple names', () => {
      const result = expandBuiltinToolNameAliases([
        'builtin.page.navigate',
        'builtin.dom.execute_js',
      ]);

      expect(result).toBeInstanceOf(Set);
      expect(result.has('builtin.page.navigate')).toBe(true);
      expect(result.has('builtin.navigate')).toBe(true);
      expect(result.has('navigate')).toBe(true);
      expect(result.has('builtin.dom.execute_js')).toBe(true);
      expect(result.has('builtin.execute_js')).toBe(true);
      expect(result.has('execute_js')).toBe(true);
    });
  });

  describe('isFeedbackAgentPushStatusReader()', () => {
    it('returns true when getPushAgentStatus exists', () => {
      const adapter = { getPushAgentStatus: () => ({ enabled: true }) };
      expect(isFeedbackAgentPushStatusReader(adapter as never)).toBe(true);
    });

    it('returns false when adapter is null', () => {
      expect(isFeedbackAgentPushStatusReader(null)).toBe(false);
    });

    it('returns false when method missing', () => {
      const adapter = {};
      expect(isFeedbackAgentPushStatusReader(adapter as never)).toBe(false);
    });
  });

  describe('log()', () => {
    it('writes to stderr with prefix', () => {
      // Just verify it doesn't throw
      expect(() => log('test message', 123)).not.toThrow();
    });
  });
});
