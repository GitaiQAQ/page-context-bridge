/**
 * Bridge-side builtin tool provider.
 *
 * Registers the 12 builtin browser tools as MCP tools on the bridge server.
 * Tool calls are forwarded to the page-context extension via `sendToExtension`.
 */

import type { BridgeToolProvider, BridgeToolCallFn, ToolSpec } from "@page-context/shared-protocol";
import { z } from "zod";

function createTextResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
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

interface ConsoleLogsResult {
  entries: Array<{ timestamp: number; level: string; args: string }>;
}

/**
 * All builtin tool specs for discovery by the extension side.
 */
const TOOL_SPECS: ToolSpec[] = [
  { name: "list_tabs", description: "List all open browser tabs", inputSchema: {}, annotations: { readOnlyHint: true } },
  { name: "get_page_info", description: "Get the current page URL, title, and metadata", inputSchema: { tabId: z.number().optional() }, annotations: { readOnlyHint: true } },
  { name: "get_selected_text", description: "Get the currently selected text on the page", inputSchema: { tabId: z.number().optional() }, annotations: { readOnlyHint: true } },
  { name: "click_element", description: "Click an element on the page by CSS selector", inputSchema: { selector: z.string(), tabId: z.number().optional() } },
  { name: "get_element_text", description: "Get text content of an element", inputSchema: { selector: z.string(), tabId: z.number().optional() }, annotations: { readOnlyHint: true } },
  { name: "get_element_html", description: "Get outer HTML of an element", inputSchema: { selector: z.string(), tabId: z.number().optional() }, annotations: { readOnlyHint: true } },
  { name: "query_elements", description: "Query elements by CSS selector", inputSchema: { selector: z.string(), limit: z.number().optional(), tabId: z.number().optional() }, annotations: { readOnlyHint: true } },
  { name: "fill_input", description: "Fill an input field with a value", inputSchema: { selector: z.string(), value: z.string(), tabId: z.number().optional() } },
  { name: "execute_js", description: "Execute JavaScript expression in page context", inputSchema: { expression: z.string(), tabId: z.number().optional() } },
  { name: "screenshot_tab", description: "Take a screenshot of the current tab", inputSchema: { format: z.enum(["png", "jpeg"]).optional(), tabId: z.number().optional() }, annotations: { readOnlyHint: true } },
  { name: "get_console_logs", description: "Get recent console log entries from the page", inputSchema: { limit: z.number().optional(), level: z.enum(["all", "log", "warn", "error", "info"]).optional(), tabId: z.number().optional() }, annotations: { readOnlyHint: true } },
  { name: "navigate", description: "Navigate the current tab to a URL", inputSchema: { url: z.string(), tabId: z.number().optional() } },
];

export class BuiltinBridgeProvider implements BridgeToolProvider {
  readonly id = "builtin";

  getToolSpecs(): ToolSpec[] {
    return TOOL_SPECS;
  }

  registerOnBridge(
    registerTool: (name: string, schema: { description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }, handler: (args: Record<string, unknown>) => Promise<unknown>) => { remove: () => void },
    sendToExtension: BridgeToolCallFn,
  ): Map<string, { remove: () => void }> {
    const handles = new Map<string, { remove: () => void }>();

    // list_tabs
    handles.set("list_tabs", registerTool("list_tabs", { description: "List all open browser tabs", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => {
      try {
        const result = (await sendToExtension("list_tabs", {})) as ListTabsResult;
        const tabs = result.tabs;
        const output = tabs.map((tab) => `[${tab.id}] ${tab.active ? "★ " : "  "}${tab.title || "Untitled"} — ${tab.url}`).join("\n");
        return createTextResponse(output || "No tabs found");
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));

    // get_page_info
    handles.set("get_page_info", registerTool("get_page_info", { description: "Get the current page URL, title, and metadata", inputSchema: { tabId: z.number().optional() } }, async ({ tabId }) => {
      try {
        const result = await sendToExtension("get_page_info", {}, tabId as number | undefined);
        return createTextResponse(JSON.stringify(result, null, 2));
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));

    // get_selected_text
    handles.set("get_selected_text", registerTool("get_selected_text", { description: "Get the currently selected text on the page", inputSchema: { tabId: z.number().optional() } }, async ({ tabId }) => {
      try {
        const result = (await sendToExtension("get_selected_text", {}, tabId as number | undefined)) as SelectedTextResult;
        return createTextResponse(result.text || "(no text selected)");
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));

    // click_element
    handles.set("click_element", registerTool("click_element", { description: "Click an element on the page by CSS selector", inputSchema: { selector: z.string(), tabId: z.number().optional() } }, async ({ selector, tabId }) => {
      try {
        await sendToExtension("click_element", { selector: selector as string }, tabId as number | undefined);
        return createTextResponse(`Clicked: ${selector}`);
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));

    // get_element_text
    handles.set("get_element_text", registerTool("get_element_text", { description: "Get text content of an element", inputSchema: { selector: z.string(), tabId: z.number().optional() } }, async ({ selector, tabId }) => {
      try {
        const result = (await sendToExtension("get_element_text", { selector: selector as string }, tabId as number | undefined)) as ElementTextResult;
        return createTextResponse(result.text || "(empty)");
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));

    // get_element_html
    handles.set("get_element_html", registerTool("get_element_html", { description: "Get outer HTML of an element", inputSchema: { selector: z.string(), tabId: z.number().optional() } }, async ({ selector, tabId }) => {
      try {
        const result = (await sendToExtension("get_element_html", { selector: selector as string }, tabId as number | undefined)) as ElementHtmlResult;
        return createTextResponse(result.html || "(empty)");
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));

    // query_elements
    handles.set("query_elements", registerTool("query_elements", { description: "Query elements by CSS selector", inputSchema: { selector: z.string(), limit: z.number().optional(), tabId: z.number().optional() } }, async ({ selector, limit, tabId }) => {
      try {
        const result = (await sendToExtension("query_elements", { selector: selector as string, limit }, tabId as number | undefined)) as QueryElementsResult;
        const lines = result.results.map((element, index) => `${index + 1}. <${element.tag}${element.id ? `#${element.id}` : ""}${element.className ? `.${element.className.split(" ").join(".")}` : ""}> ${element.text}`);
        return createTextResponse(`Found ${result.count} elements:\n${lines.join("\n")}`);
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));

    // fill_input
    handles.set("fill_input", registerTool("fill_input", { description: "Fill an input field with a value", inputSchema: { selector: z.string(), value: z.string(), tabId: z.number().optional() } }, async ({ selector, value, tabId }) => {
      try {
        await sendToExtension("fill_input", { selector: selector as string, value: value as string }, tabId as number | undefined);
        return createTextResponse(`Filled '${selector}' with: ${value}`);
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));

    // execute_js
    handles.set("execute_js", registerTool("execute_js", { description: "Execute JavaScript expression in page context", inputSchema: { expression: z.string(), tabId: z.number().optional() } }, async ({ expression, tabId }) => {
      try {
        const result = (await sendToExtension("execute_js", { expression: expression as string }, tabId as number | undefined)) as ExecuteJsResult;
        return createTextResponse(result.ok ? `Result (${result.type}): ${result.result}` : `Execution error: ${result.error}`);
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));

    // screenshot_tab
    handles.set("screenshot_tab", registerTool("screenshot_tab", { description: "Take a screenshot of the current tab", inputSchema: { format: z.enum(["png", "jpeg"]).optional(), tabId: z.number().optional() }, annotations: { readOnlyHint: true } }, async ({ format, tabId }) => {
      try {
        const result = (await sendToExtension("screenshot_tab", { format: format || "png" }, tabId as number | undefined)) as ScreenshotResult;
        if (!result.dataUrl) {
          return createTextResponse("Screenshot captured but no data returned");
        }
        const base64 = result.dataUrl.split(",")[1];
        return {
          content: [{ type: "image", data: base64, mimeType: result.format === "jpeg" ? "image/jpeg" : "image/png" }],
        };
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));

    // get_console_logs
    handles.set("get_console_logs", registerTool("get_console_logs", { description: "Get recent console log entries from the page", inputSchema: { limit: z.number().optional(), level: z.enum(["all", "log", "warn", "error", "info"]).optional(), tabId: z.number().optional() }, annotations: { readOnlyHint: true } }, async ({ limit, level, tabId }) => {
      try {
        const result = (await sendToExtension("get_console_logs", { limit, level }, tabId as number | undefined)) as ConsoleLogsResult;
        const text = result.entries.map((entry) => `[${new Date(entry.timestamp).toLocaleTimeString()}] [${entry.level.toUpperCase()}] ${entry.args}`).join("\n");
        return createTextResponse(text || "(no logs)");
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));

    // navigate
    handles.set("navigate", registerTool("navigate", { description: "Navigate the current tab to a URL", inputSchema: { url: z.string(), tabId: z.number().optional() } }, async ({ url, tabId }) => {
      try {
        await sendToExtension("navigate", { url: url as string }, tabId as number | undefined);
        return createTextResponse(`Navigating to: ${url}`);
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));

    return handles;
  }
}
