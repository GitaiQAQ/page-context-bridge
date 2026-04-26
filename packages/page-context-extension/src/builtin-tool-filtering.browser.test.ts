import { describe, expect, it } from 'vitest';

// Import directly from real package, not through re-export shim
import { filterBuiltinTools, setScopeEnabled } from '@page-context/tool-visibility';

describe('builtin tool filtering', () => {
  it('removes disabled built-in tools from injection set', () => {
    const tools = [
      { name: 'builtin.tabs.list_tabs', description: 'List tabs' },
      { name: 'builtin.page.navigate', description: 'Navigate' },
      { name: 'builtin.page.get_page_info', description: 'Page info' },
    ];

    let preferences = setScopeEnabled(
      {},
      { root: 'builtin', toolName: 'builtin.page.navigate' },
      false,
    );
    preferences = setScopeEnabled(
      preferences,
      { root: 'builtin', toolName: 'builtin.tabs.list_tabs' },
      false,
    );

    expect(filterBuiltinTools(tools, preferences).map((tool) => tool.name)).toEqual([
      'builtin.page.get_page_info',
    ]);
  });
});
