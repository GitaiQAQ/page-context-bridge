/**
 * Extension-side builtin tool provider.
 *
 * Implements ExtensionToolProvider from shared-protocol.
 * Routes tool calls to the appropriate execution context
 * (content-script for DOM tools, service-worker for extension API tools).
 */

import type {
  ExtensionToolProvider,
  ToolDefinition,
  ContentScriptToolEnv,
  ServiceWorkerToolContext,
} from '@page-context/shared-protocol';

import { executeContentScriptTool } from './content-script-tools.js';
import { executeServiceWorkerTool } from './service-worker-tools.js';
import { builtinToolName, BUILTIN_CATEGORY } from './runtime-tool-names.js';

const TOOL_DEFINITIONS: ToolDefinition[] = [
  // --- tabs ---
  {
    name: builtinToolName(BUILTIN_CATEGORY.tabs, 'list_tabs'),
    description: 'List all open browser tabs',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    executionContext: 'service-worker',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.tabs, 'open_tab'),
    description: 'Open a new tab',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open' },
        active: { type: 'boolean', description: 'Whether to activate the new tab' },
      },
      required: ['url'],
    },
    executionContext: 'service-worker',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.tabs, 'close_tab'),
    description: 'Close a tab',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number', description: 'Target tab id (defaults to active)' } },
    },
    executionContext: 'service-worker',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.tabs, 'screenshot_tab'),
    description: 'Take a screenshot of the visible tab',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', description: 'png|jpeg (default: jpeg)' },
        quality: { type: 'number', description: 'JPEG quality (0-100, default: 70)' },
      },
    },
    annotations: { readOnlyHint: true },
    executionContext: 'service-worker',
  },
  // --- page ---
  {
    name: builtinToolName(BUILTIN_CATEGORY.page, 'get_page_info'),
    description: 'Get the current page URL, title, and basic metadata',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    executionContext: 'content-script',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.page, 'navigate'),
    description: 'Navigate the current tab to a URL',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab id (defaults to active)' },
        url: { type: 'string', description: 'URL to navigate to' },
        waitUntil: { type: 'string', description: 'load|none' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds' },
      },
      required: ['url'],
    },
    executionContext: 'service-worker',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.page, 'reload'),
    description: 'Reload the current tab',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab id (defaults to active)' },
        bypassCache: { type: 'boolean', description: 'Force reload from network' },
        waitUntil: { type: 'string', description: 'load|none' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds' },
      },
    },
    executionContext: 'service-worker',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.page, 'go_back'),
    description: 'Go back in history',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab id (defaults to active)' },
        waitUntil: { type: 'string', description: 'load|none' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds' },
      },
    },
    executionContext: 'service-worker',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.page, 'go_forward'),
    description: 'Go forward in history',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab id (defaults to active)' },
        waitUntil: { type: 'string', description: 'load|none' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds' },
      },
    },
    executionContext: 'service-worker',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.page, 'wait_for_navigation'),
    description: 'Wait for current tab navigation to complete',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab id (defaults to active)' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds' },
      },
    },
    executionContext: 'service-worker',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.page, 'screenshot_page'),
    description: 'Capture a page screenshot via CDP (supports fullPage)',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab id (defaults to active)' },
        format: { type: 'string', description: 'png|jpeg (default: jpeg)' },
        quality: { type: 'number', description: 'JPEG quality (0-100, default: 70)' },
        fullPage: { type: 'boolean', description: 'Capture beyond viewport' },
        maxPixels: {
          type: 'number',
          description: 'Max pixel budget for auto downscale (default: 4000000)',
        },
      },
    },
    annotations: { readOnlyHint: true },
    executionContext: 'service-worker',
  },
  // --- dom ---
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'get_selected_text'),
    description: 'Get the currently selected text on the page',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    executionContext: 'content-script',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'click_element'),
    description: 'Click an element on the page by CSS selector',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click' },
      },
      required: ['selector'],
    },
    executionContext: 'content-script',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'scroll_into_view'),
    description: 'Scroll an element into view by CSS selector',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        behavior: { type: 'string', description: 'Scroll behavior: auto|smooth' },
      },
      required: ['selector'],
    },
    executionContext: 'content-script',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'get_element_text'),
    description: 'Get the text content of an element by CSS selector',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector of the element' } },
      required: ['selector'],
    },
    annotations: { readOnlyHint: true },
    executionContext: 'content-script',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'get_element_html'),
    description: 'Get the outer HTML of an element by CSS selector',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector of the element' } },
      required: ['selector'],
    },
    annotations: { readOnlyHint: true },
    executionContext: 'content-script',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'query_elements'),
    description: 'Query multiple elements and return summary info',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        limit: { type: 'number', description: 'Max results' },
      },
      required: ['selector'],
    },
    annotations: { readOnlyHint: true },
    executionContext: 'content-script',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'fill_input'),
    description: 'Fill an input field with a value',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        value: { type: 'string', description: 'New value' },
      },
      required: ['selector', 'value'],
    },
    executionContext: 'content-script',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'execute_js'),
    description: 'Execute JavaScript in the page context',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'JavaScript expression' } },
      required: ['expression'],
    },
    executionContext: 'content-script',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.dom, 'wait_for_selector'),
    description: 'Wait for an element to appear (and optionally become visible)',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        state: { type: 'string', description: 'attached|visible' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds' },
      },
      required: ['selector'],
    },
    executionContext: 'content-script',
  },
  // --- console ---
  {
    name: builtinToolName(BUILTIN_CATEGORY.console, 'get_console_logs'),
    description: 'Get recent console log entries from the page',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries' },
        level: { type: 'string', description: 'Log level' },
      },
    },
    annotations: { readOnlyHint: true },
    executionContext: 'content-script',
  },
  // --- input ---
  {
    name: builtinToolName(BUILTIN_CATEGORY.input, 'press_key'),
    description: 'Press a keyboard key via CDP (focused element)',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab id (defaults to active)' },
        key: { type: 'string', description: 'Key name, e.g. Enter, Tab, ArrowDown, a' },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modifier keys: Alt|Control|Meta|Shift',
        },
      },
      required: ['key'],
    },
    executionContext: 'service-worker',
  },
  {
    name: builtinToolName(BUILTIN_CATEGORY.input, 'type_text'),
    description: 'Type text via CDP (focused element)',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab id (defaults to active)' },
        text: { type: 'string', description: 'Text to insert' },
      },
      required: ['text'],
    },
    executionContext: 'service-worker',
  },
];

export class BuiltinExtensionProvider implements ExtensionToolProvider {
  readonly id = 'builtin';

  getToolDefinitions(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  executeInContentScript(
    tool: string,
    args: Record<string, unknown>,
    env: ContentScriptToolEnv,
  ): unknown {
    return executeContentScriptTool(tool, args, env);
  }

  async executeInServiceWorker(
    tool: string,
    args: Record<string, unknown>,
    ctx: ServiceWorkerToolContext,
  ): Promise<unknown> {
    return await executeServiceWorkerTool(tool, args, ctx);
  }
}
