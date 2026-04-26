import { describe, expect, it } from 'vitest';

import {
  BUILTIN_RUNTIME_NAMESPACE,
  BUILTIN_CATEGORY,
  builtinToolName,
  builtinRuntimeToolName,
} from './runtime-tool-names.js';

describe('BUILTIN_RUNTIME_NAMESPACE', () => {
  it('is "builtin"', () => {
    expect(BUILTIN_RUNTIME_NAMESPACE).toBe('builtin');
  });
});

describe('BUILTIN_CATEGORY', () => {
  it('has expected categories', () => {
    expect(BUILTIN_CATEGORY.tabs).toBe('tabs');
    expect(BUILTIN_CATEGORY.page).toBe('page');
    expect(BUILTIN_CATEGORY.dom).toBe('dom');
    expect(BUILTIN_CATEGORY.console).toBe('console');
    expect(BUILTIN_CATEGORY.input).toBe('input');
  });
});

describe('builtinToolName (semantic category)', () => {
  it('produces namespaced tool names with category', () => {
    expect(builtinToolName(BUILTIN_CATEGORY.tabs, 'list_tabs')).toBe('builtin.tabs.list_tabs');
    expect(builtinToolName(BUILTIN_CATEGORY.page, 'navigate')).toBe('builtin.page.navigate');
    expect(builtinToolName(BUILTIN_CATEGORY.dom, 'click_element')).toBe(
      'builtin.dom.click_element',
    );
    expect(builtinToolName(BUILTIN_CATEGORY.input, 'press_key')).toBe('builtin.input.press_key');
    expect(builtinToolName(BUILTIN_CATEGORY.console, 'get_console_logs')).toBe(
      'builtin.console.get_console_logs',
    );
  });

  it('covers all expected tool categories', () => {
    const pageTools = [
      'navigate',
      'wait_for_navigation',
      'reload',
      'go_back',
      'go_forward',
      'screenshot_page',
    ];
    const tabTools = ['list_tabs', 'open_tab', 'close_tab', 'screenshot_tab'];
    const domTools = [
      'get_page_info',
      'get_selected_text',
      'click_element',
      'scroll_into_view',
      'get_element_text',
      'get_element_html',
      'query_elements',
      'fill_input',
      'execute_js',
      'wait_for_selector',
    ];
    const inputTools = ['press_key', 'type_text'];
    const consoleTools = ['get_console_logs'];

    for (const tool of pageTools) {
      expect(builtinToolName(BUILTIN_CATEGORY.page, tool)).toBe(`builtin.page.${tool}`);
    }
    for (const tool of tabTools) {
      expect(builtinToolName(BUILTIN_CATEGORY.tabs, tool)).toBe(`builtin.tabs.${tool}`);
    }
    for (const tool of domTools) {
      expect(builtinToolName(BUILTIN_CATEGORY.dom, tool)).toBe(`builtin.dom.${tool}`);
    }
    for (const tool of inputTools) {
      expect(builtinToolName(BUILTIN_CATEGORY.input, tool)).toBe(`builtin.input.${tool}`);
    }
    for (const tool of consoleTools) {
      expect(builtinToolName(BUILTIN_CATEGORY.console, tool)).toBe(`builtin.console.${tool}`);
    }
  });
});

describe('builtinRuntimeToolName (legacy)', () => {
  it('produces flat namespaced tool names for backward compatibility', () => {
    expect(builtinRuntimeToolName('list_tabs')).toBe('builtin.list_tabs');
    expect(builtinRuntimeToolName('navigate')).toBe('builtin.navigate');
    expect(builtinRuntimeToolName('screenshot_tab')).toBe('builtin.screenshot_tab');
    expect(builtinRuntimeToolName('press_key')).toBe('builtin.press_key');
  });

  it('prefixes all names with builtin.', () => {
    expect(builtinRuntimeToolName('custom')).toBe('builtin.custom');
    expect(builtinRuntimeToolName('')).toBe('builtin.');
    expect(builtinRuntimeToolName('tool.name')).toBe('builtin.tool.name');
  });
});
