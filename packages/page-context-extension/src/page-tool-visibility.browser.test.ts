import { describe, expect, it } from 'vitest';

// Import directly from real package, not through re-export shim
import type { PageToolEntry } from '@page-context/tool-visibility';
import {
  buildToolTree,
  getEnabledBuiltinTools,
  getEnabledToolsForTab,
  setScopeEnabled,
} from '@page-context/tool-visibility';

const builtinTools = [
  { name: 'builtin.page.get_page_info', description: 'Get page info' },
  { name: 'builtin.page.navigate', description: 'Navigate tab' },
];

const sampleEntries = new Map<number, PageToolEntry[]>([
  [
    11,
    [
      {
        namespace: 'alpha',
        instanceId: 'default',
        tools: [{ name: 'alpha.inspect' }, { name: 'alpha.read' }],
      },
      {
        namespace: 'beta',
        instanceId: 'instA',
        tools: [{ name: 'beta.instA.run' }],
      },
      {
        namespace: 'beta',
        instanceId: 'instB',
        tools: [{ name: 'beta.instB.inspect' }],
      },
    ],
  ],
]);

describe('page tool visibility', () => {
  it('filters enabled tools by tab / namespace / instance / tool scope', () => {
    let preferences = setScopeEnabled(
      {},
      { tabId: 11, namespace: 'alpha', instanceId: 'default', toolName: 'alpha.read' },
      false,
    );
    preferences = setScopeEnabled(preferences, { tabId: 11, namespace: 'beta' }, false);

    const enabled = getEnabledToolsForTab(sampleEntries.get(11), preferences, 11).map(
      (tool) => tool.name,
    );
    expect(enabled).toEqual(['alpha.inspect']);
  });

  it('builds tree counts with enabled totals', () => {
    const preferences = setScopeEnabled({}, { tabId: 11, namespace: 'beta' }, false, {
      pageEntries: sampleEntries.get(11)?.filter((entry) => entry.namespace === 'beta'),
    });
    const tree = buildToolTree(
      [{ id: 11, title: 'Demo', url: 'https://example.com', active: true }],
      sampleEntries,
      builtinTools,
      preferences,
    );

    expect(tree.totalTools).toBe(6);
    // Default policy: only read-only builtin runtime tools are enabled by default.
    // So builtin.navigate is disabled unless explicitly enabled.
    expect(tree.enabledTools).toBe(3);
    expect(tree.builtins.totalTools).toBe(2);
    expect(tree.builtins.enabledTools).toBe(1);
    expect(tree.builtins.namespaces.map((namespace) => namespace.namespace)).toEqual(['page']);
    expect(tree.builtins.namespaces[0]?.instances[0]?.tools.map((tool) => tool.toolName)).toEqual([
      'builtin.page.get_page_info',
      'builtin.page.navigate',
    ]);
    expect(tree.tabs[0]?.namespaces[1]?.enabledTools).toBe(0);
    expect(tree.tabs[0]?.namespaces[1]?.instances).toHaveLength(2);
  });

  it('filters built-in tools independently from page tools', () => {
    let preferences = setScopeEnabled(
      {},
      { root: 'builtin', toolName: 'builtin.page.navigate' },
      false,
    );
    preferences = setScopeEnabled(preferences, { root: 'builtin' }, true);

    const enabledBuiltins = getEnabledBuiltinTools(builtinTools, preferences).map(
      (tool) => tool.name,
    );
    // Default policy only enables read-only builtin runtime tools.
    // Enabling the builtin root does not automatically enable non-read tools.
    expect(enabledBuiltins).toEqual(['builtin.page.get_page_info']);
  });

  it('marks extension/feedback control tools as bridge-control builtins for sidepanel display hints', () => {
    const tree = buildToolTree(
      [],
      new Map(),
      [
        {
          name: 'extension.get_tool_tree',
          description: 'bridge control',
          _bridgeControlTool: true,
        },
        { name: 'feedback.get_snapshot', description: 'bridge control' },
        { name: 'builtin.page.get_page_info', description: 'builtin runtime tool' },
      ],
      {},
    );

    expect(
      tree.builtins.tools.find((tool) => tool.toolName === 'extension.get_tool_tree')
        ?.bridgeControl,
    ).toBe(true);
    expect(
      tree.builtins.tools.find((tool) => tool.toolName === 'feedback.get_snapshot')?.bridgeControl,
    ).toBe(true);
    expect(
      tree.builtins.tools.find((tool) => tool.toolName === 'builtin.page.get_page_info')
        ?.bridgeControl,
    ).toBe(false);
    expect(tree.builtins.namespaces.map((namespace) => namespace.namespace)).toEqual([
      'extension',
      'feedback',
      'page',
    ]);
  });

  it('keeps bridge control builtins enabled even when builtin root is disabled', () => {
    const preferences = setScopeEnabled({}, { root: 'builtin' }, false, {
      builtinTools: [
        { name: 'builtin.page.get_page_info' },
        { name: 'extension.get_tool_tree', _bridgeControlTool: true },
      ],
    });

    const enabledBuiltins = getEnabledBuiltinTools(
      [
        { name: 'builtin.page.get_page_info' },
        { name: 'extension.get_tool_tree', _bridgeControlTool: true },
      ],
      preferences,
    ).map((tool) => tool.name);

    expect(enabledBuiltins).toEqual(['extension.get_tool_tree']);
  });

  it('preserves original tool names in builtin tree without normalization', () => {
    const tree = buildToolTree(
      [],
      new Map(),
      [
        { name: 'builtin.page.navigate', description: 'canonical builtin' },
        { name: 'builtin.page.get_page_info', description: 'builtin runtime tool' },
        { name: 'extension.get_tool_tree', description: 'bridge control' },
      ],
      {},
    );

    const toolNames = tree.builtins.tools.map((tool) => tool.toolName);
    expect(toolNames.sort()).toEqual([
      'builtin.page.get_page_info',
      'builtin.page.navigate',
      'extension.get_tool_tree',
    ]);
  });

  it('re-enables all descendants when a page parent scope is toggled back on', () => {
    let preferences = setScopeEnabled(
      {},
      { tabId: 11, namespace: 'alpha', instanceId: 'default', toolName: 'alpha.read' },
      false,
    );
    preferences = setScopeEnabled(preferences, { tabId: 11, namespace: 'beta' }, false, {
      pageEntries: sampleEntries.get(11)?.filter((entry) => entry.namespace === 'beta'),
    });
    preferences = setScopeEnabled(preferences, { tabId: 11 }, true, {
      pageEntries: sampleEntries.get(11),
    });

    const enabled = getEnabledToolsForTab(sampleEntries.get(11), preferences, 11).map(
      (tool) => tool.name,
    );
    expect(enabled).toEqual([
      'alpha.inspect',
      'alpha.read',
      'beta.instA.run',
      'beta.instB.inspect',
    ]);
  });

  it('clears nested disabled overrides when toggling namespace scope', () => {
    let preferences = setScopeEnabled(
      {},
      { tabId: 11, namespace: 'beta', instanceId: 'instA', toolName: 'beta.instA.run' },
      false,
    );
    const betaEntries = sampleEntries.get(11)?.filter((entry) => entry.namespace === 'beta');
    preferences = setScopeEnabled(preferences, { tabId: 11, namespace: 'beta' }, false, {
      pageEntries: betaEntries,
    });
    preferences = setScopeEnabled(preferences, { tabId: 11, namespace: 'beta' }, true, {
      pageEntries: betaEntries,
    });

    const enabled = getEnabledToolsForTab(sampleEntries.get(11), preferences, 11).map(
      (tool) => tool.name,
    );
    expect(enabled).toEqual([
      'alpha.inspect',
      'alpha.read',
      'beta.instA.run',
      'beta.instB.inspect',
    ]);
  });

  it('writes descendant overrides when disabling a namespace with multiple instances', () => {
    const betaEntries = sampleEntries.get(11)?.filter((entry) => entry.namespace === 'beta');
    const preferences = setScopeEnabled({}, { tabId: 11, namespace: 'beta' }, false, {
      pageEntries: betaEntries,
    });

    expect(preferences.tabs?.['11']?.namespaces?.beta).toEqual({
      enabled: false,
      instances: {
        instA: {
          enabled: false,
          tools: {
            'beta.instA.run': false,
          },
        },
        instB: {
          enabled: false,
          tools: {
            'beta.instB.inspect': false,
          },
        },
      },
    });
  });
});
