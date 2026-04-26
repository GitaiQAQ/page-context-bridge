import { describe, expect, it } from 'vitest';

// Import directly from real package, not through re-export shim
import {
  flattenPageTools,
  mergePageToolEntry,
  normalizePageToolEntries,
} from '@page-context/tool-visibility';

describe('page tool registry', () => {
  it('normalizes multiple namespaces in one tab without double prefixing', () => {
    const entries = normalizePageToolEntries([
      { namespace: 'alpha', instanceId: 'default', tools: [{ name: 'getInfo' }] },
      { namespace: 'beta', instanceId: 'instanceA', tools: [{ name: 'beta.instanceA.inspect' }] },
    ]);

    expect(entries[0]?.tools[0]?.name).toBe('alpha.getInfo');
    expect(entries[1]?.tools[0]?.name).toBe('beta.instanceA.inspect');
  });

  it('merges registrations by namespace and instance instead of overwriting the whole tab', () => {
    const alpha = normalizePageToolEntries([
      { namespace: 'alpha', instanceId: 'default', tools: [{ name: 'read' }] },
    ])[0]!;
    const beta = normalizePageToolEntries([
      { namespace: 'beta', instanceId: 'default', tools: [{ name: 'write' }] },
    ])[0]!;

    const merged = mergePageToolEntry(mergePageToolEntry([], alpha), beta);
    const tools = flattenPageTools(merged).map((tool) => tool.name);

    expect(tools).toEqual(['alpha.read', 'beta.write']);
  });
});
