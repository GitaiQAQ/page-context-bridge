/**
 * Extension-side builtin tool provider.
 *
 * Implements ExtensionToolProvider from shared-protocol.
 * Routes tool calls to the appropriate execution context
 * (content-script for DOM tools, service-worker for extension API tools).
 */

import type { ExtensionToolProvider, ToolDefinition, ContentScriptToolEnv, ServiceWorkerToolContext } from "@page-context/shared-protocol";

import { executeContentScriptTool } from "./content-script-tools.js";
import { executeServiceWorkerTool } from "./service-worker-tools.js";

const TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: "list_tabs", description: "List all open browser tabs", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, executionContext: "service-worker" },
  { name: "get_page_info", description: "Get the current page URL, title, and basic metadata", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, executionContext: "content-script" },
  { name: "get_selected_text", description: "Get the currently selected text on the page", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, executionContext: "content-script" },
  { name: "click_element", description: "Click an element on the page by CSS selector", inputSchema: { type: "object", properties: { selector: { type: "string", description: "CSS selector of the element to click" } }, required: ["selector"] }, executionContext: "content-script" },
  { name: "get_element_text", description: "Get the text content of an element by CSS selector", inputSchema: { type: "object", properties: { selector: { type: "string", description: "CSS selector of the element" } }, required: ["selector"] }, annotations: { readOnlyHint: true }, executionContext: "content-script" },
  { name: "get_element_html", description: "Get the outer HTML of an element by CSS selector", inputSchema: { type: "object", properties: { selector: { type: "string", description: "CSS selector of the element" } }, required: ["selector"] }, annotations: { readOnlyHint: true }, executionContext: "content-script" },
  { name: "query_elements", description: "Query multiple elements and return summary info", inputSchema: { type: "object", properties: { selector: { type: "string", description: "CSS selector" }, limit: { type: "number", description: "Max results" } }, required: ["selector"] }, annotations: { readOnlyHint: true }, executionContext: "content-script" },
  { name: "fill_input", description: "Fill an input field with a value", inputSchema: { type: "object", properties: { selector: { type: "string", description: "CSS selector" }, value: { type: "string", description: "New value" } }, required: ["selector", "value"] }, executionContext: "content-script" },
  { name: "execute_js", description: "Execute JavaScript in the page context", inputSchema: { type: "object", properties: { expression: { type: "string", description: "JavaScript expression" } }, required: ["expression"] }, executionContext: "content-script" },
  { name: "get_console_logs", description: "Get recent console log entries from the page", inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max entries" }, level: { type: "string", description: "Log level" } } }, annotations: { readOnlyHint: true }, executionContext: "content-script" },
  { name: "screenshot_tab", description: "Take a screenshot of the visible tab", inputSchema: { type: "object", properties: { format: { type: "string", description: "Image format" } } }, annotations: { readOnlyHint: true }, executionContext: "service-worker" },
  { name: "navigate", description: "Navigate the current tab to a URL", inputSchema: { type: "object", properties: { url: { type: "string", description: "URL to navigate to" } }, required: ["url"] }, executionContext: "service-worker" },
];

export class BuiltinExtensionProvider implements ExtensionToolProvider {
  readonly id = "builtin";

  getToolDefinitions(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  executeInContentScript(tool: string, args: Record<string, unknown>, env: ContentScriptToolEnv): unknown {
    return executeContentScriptTool(tool, args, env);
  }

  async executeInServiceWorker(tool: string, args: Record<string, unknown>, ctx: ServiceWorkerToolContext): Promise<unknown> {
    return await executeServiceWorkerTool(tool, args, ctx);
  }
}
