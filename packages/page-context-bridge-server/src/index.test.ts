import { describe, it, expect } from 'vitest';

/**
 * Tests for bridge-server pure utility functions.
 *
 * Note: The main index.ts does not export its internal functions,
 * so we re-implement the pure logic here to test the algorithm
 * correctness. If these functions are later exported or extracted
 * into a separate module, these tests should import from there instead.
 */

function normalizePageToolName(tool: { name: string; _namespace?: string }): string {
  const namespace = tool._namespace;
  let toolName = tool.name;
  if (namespace && toolName.startsWith(`${namespace}.`)) {
    const trimmed = toolName.slice(namespace.length + 1);
    if (trimmed.startsWith(`${namespace}_`) || trimmed.startsWith(`${namespace}.`)) {
      toolName = trimmed;
    }
  }
  return toolName;
}

function buildContextResourceName(
  tabId: number,
  resource: { namespace: string; id: string },
): string {
  return `tab.${tabId}.resource.${resource.namespace}.${resource.id.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
}

function buildContextResourceUri(
  tabId: number,
  resource: { namespace: string; id: string },
): string {
  return `context://tab/${tabId}/resource/${resource.namespace}/${encodeURIComponent(resource.id)}`;
}

function buildContextPromptName(tabId: number, skill: { namespace: string; id: string }): string {
  return `tab.${tabId}.skill.${skill.namespace}.${skill.id.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
}

function createTextResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

describe('bridge-server: normalizePageToolName', () => {
  it('returns the tool name as-is when no namespace prefix', () => {
    expect(normalizePageToolName({ name: 'getItems' })).toBe('getItems');
  });

  it('does not strip namespace when _namespace is undefined', () => {
    expect(normalizePageToolName({ name: 'catalog.getItems' })).toBe('catalog.getItems');
  });

  it('only strips namespace prefix when trimmed name re-starts with namespace (double-namespace case)', () => {
    // The algorithm only strips if after stripping, the trimmed part still
    // starts with the namespace — i.e., it's a "double-namespace" like "catalog.catalog.getItems"
    // Simple case: "catalog.getItems" with namespace "catalog"
    // trimmed = "getItems", does NOT start with "catalog_" or "catalog." -> condition false
    // toolName stays "catalog.getItems"
    expect(normalizePageToolName({ name: 'catalog.getItems', _namespace: 'catalog' })).toBe(
      'catalog.getItems',
    );
  });

  it('strips namespace prefix in double-namespace case (catalog.catalog.getItems)', () => {
    // name = "catalog.catalog.getItems", namespace = "catalog"
    // trimmed = "catalog.getItems"
    // "catalog.getItems" starts with "catalog." -> condition TRUE -> toolName = "catalog.getItems"
    expect(normalizePageToolName({ name: 'catalog.catalog.getItems', _namespace: 'catalog' })).toBe(
      'catalog.getItems',
    );
  });

  it('handles underscore double-namespace (catalog_catalog.getItems)', () => {
    // name = "catalog_catalog.getItems", namespace = "catalog"
    // trimmed = "catalog.getItems"
    // Wait, that's wrong. Let me recalculate:
    // "catalog_catalog.getItems".startsWith("catalog.") -> NO (it starts with "catalog_catalog")
    // Actually "catalog_catalog.getItems" does NOT start with "catalog." (starts with "catalog_catalog")
    // So the outer if is false, toolName stays as-is
    expect(normalizePageToolName({ name: 'catalog_catalog.getItems', _namespace: 'catalog' })).toBe(
      'catalog_catalog.getItems',
    );
  });

  it('handles namespace_ prefix in trimmed name', () => {
    // name = "catalog.catalog_getItems", namespace = "catalog"
    // trimmed = "catalog_getItems"
    // "catalog_getItems" starts with "catalog_" -> condition TRUE -> toolName = "catalog_getItems"
    expect(normalizePageToolName({ name: 'catalog.catalog_getItems', _namespace: 'catalog' })).toBe(
      'catalog_getItems',
    );
  });

  it('returns name as-is when namespace is set but name does not start with it', () => {
    expect(normalizePageToolName({ name: 'getItems', _namespace: 'catalog' })).toBe('getItems');
  });

  it('returns name as-is when no namespace is set', () => {
    expect(normalizePageToolName({ name: 'getItems' })).toBe('getItems');
  });
});

describe('bridge-server: buildContextResourceName', () => {
  it('builds a resource name with tab, namespace, and id', () => {
    expect(buildContextResourceName(42, { namespace: 'catalog', id: 'items' })).toBe(
      'tab.42.resource.catalog.items',
    );
  });

  it('sanitizes special characters in resource id', () => {
    expect(buildContextResourceName(1, { namespace: 'qa', id: 'test/suite' })).toBe(
      'tab.1.resource.qa.test-suite',
    );
  });

  it('preserves dots, dashes, and underscores in resource id', () => {
    expect(buildContextResourceName(5, { namespace: 'app', id: 'my_resource.v2-beta' })).toBe(
      'tab.5.resource.app.my_resource.v2-beta',
    );
  });

  it('handles simple numeric ids', () => {
    expect(buildContextResourceName(0, { namespace: 'page', id: 'summary' })).toBe(
      'tab.0.resource.page.summary',
    );
  });
});

describe('bridge-server: buildContextResourceUri', () => {
  it('builds a context URI with tab, namespace, and encoded id', () => {
    expect(buildContextResourceUri(42, { namespace: 'catalog', id: 'items' })).toBe(
      'context://tab/42/resource/catalog/items',
    );
  });

  it('encodes spaces in the id', () => {
    expect(buildContextResourceUri(1, { namespace: 'qa', id: 'test suite' })).toBe(
      'context://tab/1/resource/qa/test%20suite',
    );
  });

  it('encodes special characters', () => {
    expect(buildContextResourceUri(3, { namespace: 'app', id: 'a&b' })).toBe(
      'context://tab/3/resource/app/a%26b',
    );
  });
});

describe('bridge-server: buildContextPromptName', () => {
  it('builds a prompt name with tab, namespace, and id', () => {
    expect(buildContextPromptName(42, { namespace: 'catalog', id: 'manage-items' })).toBe(
      'tab.42.skill.catalog.manage-items',
    );
  });

  it('sanitizes special characters in skill id', () => {
    expect(buildContextPromptName(1, { namespace: 'qa', id: 'run/test' })).toBe(
      'tab.1.skill.qa.run-test',
    );
  });

  it('preserves dots, dashes, and underscores', () => {
    expect(buildContextPromptName(10, { namespace: 'form', id: 'update_profile.v2' })).toBe(
      'tab.10.skill.form.update_profile.v2',
    );
  });
});

describe('bridge-server: createTextResponse', () => {
  it('returns a text content response', () => {
    const result = createTextResponse('hello');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'hello' }],
    });
  });

  it('wraps error messages in text content', () => {
    const result = createTextResponse('Error: something failed');
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Error:');
  });

  it('handles empty strings', () => {
    const result = createTextResponse('');
    expect(result.content[0].text).toBe('');
  });
});
