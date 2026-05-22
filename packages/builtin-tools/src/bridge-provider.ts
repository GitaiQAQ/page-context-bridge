/**
 * Bridge-side builtin tool provider.
 *
 * Registers builtin browser tools as MCP tools on the bridge server.
 * Tool calls are forwarded to the page-context extension via `sendToExtension`.
 */

import type { BridgeToolProvider, BridgeToolCallFn, ToolSpec } from '@page-context/shared-protocol';
import { z } from 'zod';
import {
  builtinToolName,
  BUILTIN_CATEGORY,
  getBuiltinToolNameAliases,
  parseBuiltinToolName,
} from './runtime-tool-names.js';

const MAX_TEXT_CHARS = 50_000;

function truncateText(
  text: string,
  maxChars = MAX_TEXT_CHARS,
): { text: string; truncated: boolean; totalChars: number } {
  if (text.length <= maxChars) {
    return { text, truncated: false, totalChars: text.length };
  }
  const head = text.slice(0, maxChars);
  return {
    text: `${head}\n\n... (truncated, totalChars=${text.length}, maxChars=${maxChars})`,
    truncated: true,
    totalChars: text.length,
  };
}

function createTextResponse(text: string) {
  const t = truncateText(text);
  return { content: [{ type: 'text' as const, text: t.text }] };
}

interface ListTabsResult {
  tabs: Array<{ id?: number; title?: string; url?: string; active?: boolean }>;
}

interface SelectedTextResult {
  text?: string;
}

interface ElementTextResult {
  text?: string;
}

interface ElementHtmlResult {
  html?: string;
}

interface QueryElementsResult {
  count: number;
  results: Array<{ tag: string; id?: string; className?: string; text: string }>;
}

interface ExecuteJsResult {
  ok: boolean;
  result?: string;
  type?: string;
  error?: string;
}

interface ScreenshotResult {
  dataUrl?: string;
  format?: string;
}

interface CdpScreenshotResult {
  tabId?: number;
  format?: string;
  dataBase64?: string;
}

interface ConsoleLogsResult {
  entries: Array<{ timestamp: number; level: string; args: string }>;
}

/**
 * All builtin tool specs for discovery by the extension side.
 */
const TOOL_SPECS: ToolSpec[] = [
  // --- tabs ---
  {
    name: builtinToolName(BUILTIN_CATEGORY.tabs, 'list_tabs'),
    description: 'List all open browser tabs',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.tabs, 'open_tab'),
    description: 'Open a new tab',
    inputSchema: { url: z.string(), active: z.boolean().optional() },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.tabs, 'close_tab'),
    description: 'Close a tab',
    inputSchema: { tabId: z.number().optional() },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.tabs, 'screenshot_tab'),
    description: 'Take a screenshot of the current tab',
    inputSchema: {
      format: z.enum(['png', 'jpeg']).optional(),
      quality: z.number().optional(),
      tabId: z.number().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  // --- page ---
  {
    name: builtinToolName(BUILTIN_CATEGORY.page, 'get_page_info'),
    description: 'Get the current page URL, title, and metadata',
    inputSchema: { tabId: z.number().optional() },
    annotations: { readOnlyHint: true },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.page, 'navigate'),
    description: 'Navigate the current tab to a URL',
    inputSchema: {
      url: z.string(),
      waitUntil: z.enum(['load', 'none']).optional(),
      timeoutMs: z.number().optional(),
      tabId: z.number().optional(),
    },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.page, 'reload'),
    description: 'Reload the tab',
    inputSchema: {
      bypassCache: z.boolean().optional(),
      waitUntil: z.enum(['load', 'none']).optional(),
      timeoutMs: z.number().optional(),
      tabId: z.number().optional(),
    },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.page, 'go_back'),
    description: 'Go back in history',
    inputSchema: {
      waitUntil: z.enum(['load', 'none']).optional(),
      timeoutMs: z.number().optional(),
      tabId: z.number().optional(),
    },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.page, 'go_forward'),
    description: 'Go forward in history',
    inputSchema: {
      waitUntil: z.enum(['load', 'none']).optional(),
      timeoutMs: z.number().optional(),
      tabId: z.number().optional(),
    },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.page, 'wait_for_navigation'),
    description: 'Wait for the tab navigation to complete',
    inputSchema: { timeoutMs: z.number().optional(), tabId: z.number().optional() },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.page, 'screenshot_page'),
    description: 'Capture a screenshot via CDP (supports fullPage)',
    inputSchema: {
      format: z.enum(['png', 'jpeg']).optional(),
      quality: z.number().optional(),
      fullPage: z.boolean().optional(),
      maxPixels: z.number().optional(),
      tabId: z.number().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  // --- dom ---
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'get_selected_text'),
    description: 'Get the currently selected text on the page',
    inputSchema: { tabId: z.number().optional() },
    annotations: { readOnlyHint: true },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'click_element'),
    description: 'Click an element on the page by CSS selector',
    inputSchema: { selector: z.string(), tabId: z.number().optional() },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'scroll_into_view'),
    description: 'Scroll an element into view by CSS selector',
    inputSchema: {
      selector: z.string(),
      behavior: z.enum(['auto', 'smooth']).optional(),
      tabId: z.number().optional(),
    },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'get_element_text'),
    description: 'Get text content of an element',
    inputSchema: { selector: z.string(), tabId: z.number().optional() },
    annotations: { readOnlyHint: true },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'get_element_html'),
    description: 'Get outer HTML of an element',
    inputSchema: { selector: z.string(), tabId: z.number().optional() },
    annotations: { readOnlyHint: true },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'query_elements'),
    description: 'Query elements by CSS selector',
    inputSchema: {
      selector: z.string(),
      limit: z.number().optional(),
      tabId: z.number().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'fill_input'),
    description: 'Fill an input field with a value',
    inputSchema: { selector: z.string(), value: z.string(), tabId: z.number().optional() },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'execute_js'),
    description: 'Execute JavaScript expression in page context',
    inputSchema: { expression: z.string(), tabId: z.number().optional() },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'wait_for_selector'),
    description: 'Wait for an element to appear',
    inputSchema: {
      selector: z.string(),
      state: z.enum(['attached', 'visible']).optional(),
      timeoutMs: z.number().optional(),
      tabId: z.number().optional(),
    },
  },
  // --- console ---
  {
    name: builtinToolName(BUILTIN_CATEGORY.console, 'get_console_logs'),
    description: 'Get recent console log entries from the page',
    inputSchema: {
      limit: z.number().optional(),
      level: z.enum(['all', 'log', 'warn', 'error', 'info']).optional(),
      tabId: z.number().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  // --- input ---
  {
    name: builtinToolName(BUILTIN_CATEGORY.input, 'press_key'),
    description: 'Press a key via CDP',
    inputSchema: {
      key: z.string(),
      modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
      tabId: z.number().optional(),
    },
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.input, 'type_text'),
    description: 'Type text via CDP',
    inputSchema: { text: z.string(), tabId: z.number().optional() },
  },
];

const BUILTIN_SUFFIX_ALIAS_COUNTS = TOOL_SPECS.reduce<Map<string, number>>((counts, tool) => {
  const parsed = parseBuiltinToolName(tool.name);
  if (!parsed) {
    return counts;
  }
  counts.set(parsed.suffix, (counts.get(parsed.suffix) ?? 0) + 1);
  return counts;
}, new Map());

function getBridgeRegistrationNames(canonicalName: string): string[] {
  const parsed = parseBuiltinToolName(canonicalName);
  if (!parsed) {
    return [canonicalName];
  }
  return getBuiltinToolNameAliases(canonicalName).filter((name) => {
    if (name === parsed.suffix) {
      return (BUILTIN_SUFFIX_ALIAS_COUNTS.get(parsed.suffix) ?? 0) === 1;
    }
    return true;
  });
}

export class BuiltinBridgeProvider implements BridgeToolProvider {
  readonly id = 'builtin';

  getToolSpecs(): ToolSpec[] {
    return TOOL_SPECS;
  }

  registerOnBridge(
    registerTool: (
      name: string,
      schema: {
        description: string;
        inputSchema: Record<string, unknown>;
        annotations?: Record<string, unknown>;
      },
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) => { remove: () => void },
    sendToExtension: BridgeToolCallFn,
  ): Map<string, { remove: () => void }> {
    const handles = new Map<string, { remove: () => void }>();
    const registerRuntimeTool = (
      canonicalName: string,
      schema: {
        description: string;
        inputSchema: Record<string, unknown>;
        annotations?: Record<string, unknown>;
      },
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) => {
      for (const name of getBridgeRegistrationNames(canonicalName)) {
        if (handles.has(name)) {
          continue;
        }
        handles.set(name, registerTool(name, schema, handler));
      }
      return canonicalName;
    };

    // list_tabs
    const listTabsName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.tabs, 'list_tabs'),
      {
        description: 'List all open browser tabs',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => {
        try {
          const result = (await sendToExtension(listTabsName, {})) as ListTabsResult;
          const tabs = result.tabs;
          const output = tabs
            .map(
              (tab) =>
                `[${tab.id}] ${tab.active ? '★ ' : '  '}${tab.title || 'Untitled'} — ${tab.url}`,
            )
            .join('\n');
          return createTextResponse(output || 'No tabs found');
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // get_page_info
    const getPageInfoName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.page, 'get_page_info'),
      {
        description: 'Get the current page URL, title, and metadata',
        inputSchema: { tabId: z.number().optional() },
      },
      async ({ tabId }) => {
        try {
          const result = await sendToExtension(getPageInfoName, {}, tabId as number | undefined);
          return createTextResponse(JSON.stringify(result, null, 2));
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // get_selected_text
    const getSelectedTextName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.dom, 'get_selected_text'),
      {
        description: 'Get the currently selected text on the page',
        inputSchema: { tabId: z.number().optional() },
      },
      async ({ tabId }) => {
        try {
          const result = (await sendToExtension(
            getSelectedTextName,
            {},
            tabId as number | undefined,
          )) as SelectedTextResult;
          return createTextResponse(result.text || '(no text selected)');
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // click_element
    const clickElementName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.dom, 'click_element'),
      {
        description: 'Click an element on the page by CSS selector',
        inputSchema: { selector: z.string(), tabId: z.number().optional() },
      },
      async ({ selector, tabId }) => {
        try {
          await sendToExtension(
            clickElementName,
            { selector: selector as string },
            tabId as number | undefined,
          );
          return createTextResponse(`Clicked: ${selector}`);
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // scroll_into_view
    const scrollIntoViewName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.dom, 'scroll_into_view'),
      {
        description: 'Scroll an element into view by CSS selector',
        inputSchema: {
          selector: z.string(),
          behavior: z.enum(['auto', 'smooth']).optional(),
          tabId: z.number().optional(),
        },
      },
      async ({ selector, behavior, tabId }) => {
        try {
          await sendToExtension(
            scrollIntoViewName,
            { selector: selector as string, behavior },
            tabId as number | undefined,
          );
          return createTextResponse(`Scrolled into view: ${selector}`);
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // get_element_text
    const getElementTextName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.dom, 'get_element_text'),
      {
        description: 'Get text content of an element',
        inputSchema: { selector: z.string(), tabId: z.number().optional() },
      },
      async ({ selector, tabId }) => {
        try {
          const result = (await sendToExtension(
            getElementTextName,
            { selector: selector as string },
            tabId as number | undefined,
          )) as ElementTextResult;
          return createTextResponse(result.text || '(empty)');
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // get_element_html
    const getElementHtmlName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.dom, 'get_element_html'),
      {
        description: 'Get outer HTML of an element',
        inputSchema: { selector: z.string(), tabId: z.number().optional() },
      },
      async ({ selector, tabId }) => {
        try {
          const result = (await sendToExtension(
            getElementHtmlName,
            { selector: selector as string },
            tabId as number | undefined,
          )) as ElementHtmlResult;
          return createTextResponse(result.html || '(empty)');
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // query_elements
    const queryElementsName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.dom, 'query_elements'),
      {
        description: 'Query elements by CSS selector',
        inputSchema: {
          selector: z.string(),
          limit: z.number().optional(),
          tabId: z.number().optional(),
        },
      },
      async ({ selector, limit, tabId }) => {
        try {
          const result = (await sendToExtension(
            queryElementsName,
            { selector: selector as string, limit },
            tabId as number | undefined,
          )) as QueryElementsResult;
          const lines = result.results.map(
            (element, index) =>
              `${index + 1}. <${element.tag}${element.id ? `#${element.id}` : ''}${element.className ? `.${element.className.split(' ').join('.')}` : ''}> ${element.text}`,
          );
          return createTextResponse(`Found ${result.count} elements:\n${lines.join('\n')}`);
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // fill_input
    const fillInputName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.dom, 'fill_input'),
      {
        description: 'Fill an input field with a value',
        inputSchema: { selector: z.string(), value: z.string(), tabId: z.number().optional() },
      },
      async ({ selector, value, tabId }) => {
        try {
          await sendToExtension(
            fillInputName,
            { selector: selector as string, value: value as string },
            tabId as number | undefined,
          );
          return createTextResponse(`Filled '${selector}' with: ${value}`);
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // execute_js
    const executeJsName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.dom, 'execute_js'),
      {
        description: 'Execute JavaScript expression in page context',
        inputSchema: { expression: z.string(), tabId: z.number().optional() },
      },
      async ({ expression, tabId }) => {
        try {
          const result = (await sendToExtension(
            executeJsName,
            { expression: expression as string },
            tabId as number | undefined,
          )) as ExecuteJsResult;
          return createTextResponse(
            result.ok
              ? `Result (${result.type}): ${result.result}`
              : `Execution error: ${result.error}`,
          );
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // screenshot_tab
    const screenshotTabName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.tabs, 'screenshot_tab'),
      {
        description: 'Take a screenshot of the current tab',
        inputSchema: {
          format: z.enum(['png', 'jpeg']).optional(),
          quality: z.number().optional(),
          tabId: z.number().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ format, quality, tabId }) => {
        try {
          const result = (await sendToExtension(
            screenshotTabName,
            { format: format || 'jpeg', quality },
            tabId as number | undefined,
          )) as ScreenshotResult;
          if (!result.dataUrl) {
            return createTextResponse('Screenshot captured but no data returned');
          }
          const base64 = result.dataUrl.split(',')[1];
          return {
            content: [
              {
                type: 'image',
                data: base64,
                mimeType: result.format === 'jpeg' ? 'image/jpeg' : 'image/png',
              },
            ],
          };
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // screenshot_page (CDP)
    const screenshotPageName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.page, 'screenshot_page'),
      {
        description: 'Capture a screenshot via CDP (supports fullPage)',
        inputSchema: {
          format: z.enum(['png', 'jpeg']).optional(),
          quality: z.number().optional(),
          fullPage: z.boolean().optional(),
          maxPixels: z.number().optional(),
          tabId: z.number().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ format, quality, fullPage, maxPixels, tabId }) => {
        try {
          const result = (await sendToExtension(
            screenshotPageName,
            { format: format || 'jpeg', quality, fullPage, maxPixels },
            tabId as number | undefined,
          )) as CdpScreenshotResult;
          if (!result.dataBase64) {
            return createTextResponse('Screenshot captured but no data returned');
          }
          return {
            content: [
              {
                type: 'image',
                data: result.dataBase64,
                mimeType: result.format === 'jpeg' ? 'image/jpeg' : 'image/png',
              },
            ],
          };
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // get_console_logs
    const getConsoleLogsName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.console, 'get_console_logs'),
      {
        description: 'Get recent console log entries from the page',
        inputSchema: {
          limit: z.number().optional(),
          level: z.enum(['all', 'log', 'warn', 'error', 'info']).optional(),
          tabId: z.number().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ limit, level, tabId }) => {
        try {
          const result = (await sendToExtension(
            getConsoleLogsName,
            { limit, level },
            tabId as number | undefined,
          )) as ConsoleLogsResult;
          const text = result.entries
            .map(
              (entry) =>
                `[${new Date(entry.timestamp).toLocaleTimeString()}] [${entry.level.toUpperCase()}] ${entry.args}`,
            )
            .join('\n');
          return createTextResponse(text || '(no logs)');
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // navigate
    const navigateName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.page, 'navigate'),
      {
        description: 'Navigate the current tab to a URL',
        inputSchema: {
          url: z.string(),
          waitUntil: z.enum(['load', 'none']).optional(),
          timeoutMs: z.number().optional(),
          tabId: z.number().optional(),
        },
      },
      async ({ url, waitUntil, timeoutMs, tabId }) => {
        try {
          await sendToExtension(
            navigateName,
            { url: url as string, waitUntil, timeoutMs },
            tabId as number | undefined,
          );
          return createTextResponse(`Navigating to: ${url}`);
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // wait_for_navigation
    const waitForNavigationName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.page, 'wait_for_navigation'),
      {
        description: 'Wait for the tab navigation to complete',
        inputSchema: { timeoutMs: z.number().optional(), tabId: z.number().optional() },
      },
      async ({ timeoutMs, tabId }) => {
        try {
          await sendToExtension(waitForNavigationName, { timeoutMs }, tabId as number | undefined);
          return createTextResponse('Navigation complete');
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // reload
    const reloadName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.page, 'reload'),
      {
        description: 'Reload the tab',
        inputSchema: {
          bypassCache: z.boolean().optional(),
          waitUntil: z.enum(['load', 'none']).optional(),
          timeoutMs: z.number().optional(),
          tabId: z.number().optional(),
        },
      },
      async ({ bypassCache, waitUntil, timeoutMs, tabId }) => {
        try {
          await sendToExtension(
            reloadName,
            { bypassCache, waitUntil, timeoutMs },
            tabId as number | undefined,
          );
          return createTextResponse('Reloaded');
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // go_back
    const goBackName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.page, 'go_back'),
      {
        description: 'Go back in history',
        inputSchema: {
          waitUntil: z.enum(['load', 'none']).optional(),
          timeoutMs: z.number().optional(),
          tabId: z.number().optional(),
        },
      },
      async ({ waitUntil, timeoutMs, tabId }) => {
        try {
          await sendToExtension(goBackName, { waitUntil, timeoutMs }, tabId as number | undefined);
          return createTextResponse('Went back');
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // go_forward
    const goForwardName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.page, 'go_forward'),
      {
        description: 'Go forward in history',
        inputSchema: {
          waitUntil: z.enum(['load', 'none']).optional(),
          timeoutMs: z.number().optional(),
          tabId: z.number().optional(),
        },
      },
      async ({ waitUntil, timeoutMs, tabId }) => {
        try {
          await sendToExtension(
            goForwardName,
            { waitUntil, timeoutMs },
            tabId as number | undefined,
          );
          return createTextResponse('Went forward');
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // open_tab
    const openTabName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.tabs, 'open_tab'),
      {
        description: 'Open a new tab',
        inputSchema: { url: z.string(), active: z.boolean().optional() },
      },
      async ({ url, active }) => {
        try {
          const result = await sendToExtension(openTabName, {
            url: url as string,
            active: active as boolean | undefined,
          });
          return createTextResponse(JSON.stringify(result, null, 2));
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // close_tab
    const closeTabName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.tabs, 'close_tab'),
      { description: 'Close a tab', inputSchema: { tabId: z.number().optional() } },
      async ({ tabId }) => {
        try {
          await sendToExtension(closeTabName, {}, tabId as number | undefined);
          return createTextResponse('Closed tab');
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // wait_for_selector
    const waitForSelectorName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.dom, 'wait_for_selector'),
      {
        description: 'Wait for an element to appear',
        inputSchema: {
          selector: z.string(),
          state: z.enum(['attached', 'visible']).optional(),
          timeoutMs: z.number().optional(),
          tabId: z.number().optional(),
        },
      },
      async ({ selector, state, timeoutMs, tabId }) => {
        try {
          await sendToExtension(
            waitForSelectorName,
            { selector: selector as string, state, timeoutMs },
            tabId as number | undefined,
          );
          return createTextResponse(`Selector ready: ${selector}`);
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // press_key
    const pressKeyName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.input, 'press_key'),
      {
        description: 'Press a key via CDP',
        inputSchema: {
          key: z.string(),
          modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
          tabId: z.number().optional(),
        },
      },
      async ({ key, modifiers, tabId }) => {
        try {
          await sendToExtension(
            pressKeyName,
            { key: key as string, modifiers },
            tabId as number | undefined,
          );
          return createTextResponse(`Pressed: ${key}`);
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // type_text
    const typeTextName = registerRuntimeTool(
      builtinToolName(BUILTIN_CATEGORY.input, 'type_text'),
      {
        description: 'Type text via CDP',
        inputSchema: { text: z.string(), tabId: z.number().optional() },
      },
      async ({ text, tabId }) => {
        try {
          await sendToExtension(
            typeTextName,
            { text: text as string },
            tabId as number | undefined,
          );
          return createTextResponse(`Typed ${String(text).length} chars`);
        } catch (error) {
          return createTextResponse(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    return handles;
  }
}
