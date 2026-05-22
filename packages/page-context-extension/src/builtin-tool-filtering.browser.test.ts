import { afterEach, describe, expect, it } from 'vitest';

// Import directly from real package, not through re-export shim
import {
  CDP_DEBUGGER_BUILTIN_TOOL_NAMES,
  detectBuiltinRuntimeCapabilities,
  filterBuiltinToolsByRuntimeCapabilities,
} from '@page-context/builtin-tools';
import { filterBuiltinTools, setScopeEnabled } from '@page-context/tool-visibility';
import { getBuiltinTools } from './bg-page-tools';

const originalChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
const originalBrowser = (globalThis as typeof globalThis & { browser?: unknown }).browser;

function setRuntimeProbe(params: {
  manifest?: Record<string, unknown>;
  hasChromeDebugger?: boolean;
  hasBrowserRuntimeGetBrowserInfo?: boolean;
}) {
  (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
    runtime: {
      getManifest: () => params.manifest ?? {},
    },
    debugger: params.hasChromeDebugger
      ? {
          attach: () => undefined,
          detach: () => undefined,
          sendCommand: () => undefined,
        }
      : undefined,
    storage: {
      local: {
        get: () => Promise.resolve({}),
      },
    },
  };
  (globalThis as typeof globalThis & { browser?: unknown }).browser =
    params.hasBrowserRuntimeGetBrowserInfo
      ? {
          runtime: {
            getBrowserInfo: () => Promise.resolve({ name: 'Firefox' }),
          },
        }
      : undefined;
}

describe('builtin tool filtering', () => {
  afterEach(() => {
    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = originalChrome;
    (globalThis as typeof globalThis & { browser?: unknown }).browser = originalBrowser;
  });

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

  it('removes CDP/debugger builtins when Firefox runtime is detected', () => {
    setRuntimeProbe({
      manifest: { browser_specific_settings: { gecko: { id: 'page-context-bridge@example.com' } } },
      hasChromeDebugger: true,
    });

    const toolNames = getBuiltinTools().map((tool) => tool.name);

    for (const cdpToolName of CDP_DEBUGGER_BUILTIN_TOOL_NAMES) {
      expect(toolNames).not.toContain(cdpToolName);
    }
    expect(toolNames).toContain('builtin.tabs.screenshot_tab');
    expect(detectBuiltinRuntimeCapabilities().target).toBe('firefox');
  });

  it('keeps CDP/debugger builtins when Chromium debugger capability is available', () => {
    setRuntimeProbe({ manifest: {}, hasChromeDebugger: true });

    const toolNames = getBuiltinTools().map((tool) => tool.name);

    for (const cdpToolName of CDP_DEBUGGER_BUILTIN_TOOL_NAMES) {
      expect(toolNames).toContain(cdpToolName);
    }
    expect(detectBuiltinRuntimeCapabilities()).toEqual({
      target: 'chromium',
      supportsChromeDebuggerCdp: true,
    });
  });

  it('conservatively removes CDP/debugger builtins when debugger capability is absent', () => {
    const filtered = filterBuiltinToolsByRuntimeCapabilities(
      [
        { name: 'builtin.tabs.list_tabs' },
        { name: 'builtin.page.screenshot_page' },
        { name: 'builtin.input.press_key' },
        { name: 'builtin.input.type_text' },
      ],
      { target: 'unknown', supportsChromeDebuggerCdp: false },
    );

    expect(filtered.map((tool) => tool.name)).toEqual(['builtin.tabs.list_tabs']);
  });
});
