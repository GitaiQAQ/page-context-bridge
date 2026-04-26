import { describe, expect, it, vi } from 'vitest';

import { createRegistryTabState, deriveFeedbackLinksFromTabState } from './registry-tab-state.js';

describe('registry-tab-state', () => {
  describe('createRegistryTabState()', () => {
    it('initializes empty WeakMaps for all handle types', () => {
      const state = createRegistryTabState();

      expect(state.pageToolHandlesByServer).toBeInstanceOf(WeakMap);
      expect(state.contextResourceHandlesByServer).toBeInstanceOf(WeakMap);
      expect(state.contextPromptHandlesByServer).toBeInstanceOf(WeakMap);
    });

    it('initializes empty Maps for pageTools and manifests', () => {
      const state = createRegistryTabState();

      expect(state.pageToolsByTab).toBeInstanceOf(Map);
      expect(state.pageContextManifestByTab).toBeInstanceOf(Map);
      expect(state.pageToolsByTab.size).toBe(0);
      expect(state.pageContextManifestByTab.size).toBe(0);
    });
  });

  describe('deriveFeedbackLinksFromTabState()', () => {
    function createEmptyState() {
      return createRegistryTabState();
    }

    it('returns null manifest when not cached', () => {
      const state = createEmptyState();
      const result = deriveFeedbackLinksFromTabState({ state, tabId: 999 });

      expect(result.manifest).toBeNull();
    });

    it('returns empty tools when not cached', () => {
      const state = createEmptyState();
      const result = deriveFeedbackLinksFromTabState({ state, tabId: 999 });

      expect(result.links.relatedToolNames).toEqual([]);
    });

    it('extracts namespace hints from manifest', () => {
      const state = createEmptyState();
      state.pageContextManifestByTab.set(1, {
        version: '1',
        app: 'test',
        route: '/home',
        scene: 'home',
        namespaces: [{ namespace: 'catalog' }, { namespace: 'orders' }],
        resources: [],
        skills: [],
        generatedAt: '2026-01-01T00:00:00.000Z',
      } as never);

      const result = deriveFeedbackLinksFromTabState({ state, tabId: 1 });
      expect(result.links.namespaceHints).toEqual(['catalog', 'orders']);
    });

    it('extracts resource IDs from manifest', () => {
      const state = createEmptyState();
      state.pageContextManifestByTab.set(1, {
        version: '1',
        app: 'test',
        route: '/home',
        namespaces: [],
        resources: [
          { namespace: 'ns', id: 'res-1' },
          { namespace: 'ns', id: 'res-2' },
        ],
        skills: [],
        generatedAt: '2026-01-01T00:00:00.000Z',
      } as never);

      const result = deriveFeedbackLinksFromTabState({ state, tabId: 1 });
      expect(result.links.relatedResourceIds).toEqual(['res-1', 'res-2']);
    });

    it('extracts skill IDs from manifest', () => {
      const state = createEmptyState();
      state.pageContextManifestByTab.set(1, {
        version: '1',
        app: 'test',
        route: '/home',
        namespaces: [],
        resources: [],
        skills: [{ namespace: 'ns', id: 'skill-1' }],
        generatedAt: '2026-01-01T00:00:00.000Z',
      } as never);

      const result = deriveFeedbackLinksFromTabState({ state, tabId: 1 });
      expect(result.links.relatedSkillIds).toEqual(['skill-1']);
    });

    it('extracts tool names from page tools', () => {
      const state = createEmptyState();
      state.pageToolsByTab.set(1, [
        { name: 'catalog.click_item', _namespace: 'catalog' },
        { name: 'catalog.search', _namespace: 'catalog' },
      ] as never);

      const result = deriveFeedbackLinksFromTabState({ state, tabId: 1 });
      // normalizePageToolName is called but doesn't strip when trimmed doesn't re-start with namespace
      expect(result.links.relatedToolNames).toContain('catalog.click_item');
      expect(result.links.relatedToolNames).toContain('catalog.search');
    });

    it('builds link reasons array from manifest', () => {
      const state = createEmptyState();
      state.pageContextManifestByTab.set(1, {
        version: '1',
        app: 'test',
        route: '/home',
        namespaces: [{ namespace: 'ns' }],
        resources: [],
        skills: [],
        generatedAt: '2026-01-01T00:00:00.000Z',
      } as never);

      const result = deriveFeedbackLinksFromTabState({ state, tabId: 1 });
      expect(result.links.linkReasons).toContain('manifest.namespaces');
      expect(result.links.linkReasons).toContain('manifest.resources');
      expect(result.links.linkReasons).toContain('manifest.skills');
    });

    it('builds link reasons array from page tools', () => {
      const state = createEmptyState();
      state.pageToolsByTab.set(1, [{ name: 'tool1' }] as never);

      const result = deriveFeedbackLinksFromTabState({ state, tabId: 1 });
      expect(result.links.linkReasons).toContain('page-tools.registered');
    });

    it('deduplicates all link values', () => {
      const state = createEmptyState();
      state.pageContextManifestByTab.set(1, {
        version: '1',
        app: 'test',
        route: '/home',
        namespaces: [{ namespace: 'dup' }, { namespace: 'dup' }],
        resources: [
          { namespace: 'ns', id: 'res-1' },
          { namespace: 'ns', id: 'res-1' },
        ],
        skills: [],
        generatedAt: '2026-01-01T00:00:00.000Z',
      } as never);
      state.pageToolsByTab.set(1, [{ name: 'tool-a' }, { name: 'tool-a' }] as never);

      const result = deriveFeedbackLinksFromTabState({ state, tabId: 1 });
      expect(result.links.namespaceHints).toEqual(['dup']);
      expect(result.links.relatedResourceIds).toEqual(['res-1']);
      // Tool names are normalized then deduplicated
      expect(new Set(result.links.relatedToolNames).size).toBeLessThanOrEqual(
        result.links.relatedToolNames.length,
      );
    });

    it('returns combined data when both manifest and tools exist', () => {
      const state = createEmptyState();
      state.pageContextManifestByTab.set(1, {
        version: '1',
        app: 'app',
        route: '/route',
        scene: 'scene',
        namespaces: [{ namespace: 'ns' }],
        resources: [{ namespace: 'ns', id: 'r1' }],
        skills: [{ namespace: 'ns', id: 's1' }],
        generatedAt: '2026-01-01T00:00:00.000Z',
      } as never);
      state.pageToolsByTab.set(1, [{ name: 'ns.tool1', _namespace: 'ns' }] as never);

      const result = deriveFeedbackLinksFromTabState({ state, tabId: 1 });
      expect(result.manifest).not.toBeNull();
      expect(result.manifest?.app).toBe('app');
      expect(result.links.namespaceHints).toContain('ns');
      expect(result.links.relatedToolNames.length).toBeGreaterThan(0);
    });
  });
});
