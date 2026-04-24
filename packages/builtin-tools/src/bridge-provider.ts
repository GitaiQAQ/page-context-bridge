/**
 * Bridge-side builtin tool provider.
 *
 * Registers the 12 builtin browser tools as MCP tools on the bridge server.
 * Tool calls are forwarded to the page-context extension via `sendToExtension`.
 */

import type { BridgeToolProvider, BridgeToolCallFn, ToolSpec } from "@page-context/shared-protocol";
import { z } from "zod";
import { toCanonicalBuiltinRuntimeToolName } from "./runtime-tool-names.js";

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
  { name: toCanonicalBuiltinRuntimeToolName("list_tabs"), description: "List all open browser tabs", inputSchema: {}, annotations: { readOnlyHint: true } },
  { name: toCanonicalBuiltinRuntimeToolName("get_page_info"), description: "Get the current page URL, title, and metadata", inputSchema: { tabId: z.number().optional() }, annotations: { readOnlyHint: true } },
  { name: toCanonicalBuiltinRuntimeToolName("get_selected_text"), description: "Get the currently selected text on the page", inputSchema: { tabId: z.number().optional() }, annotations: { readOnlyHint: true } },
  { name: toCanonicalBuiltinRuntimeToolName("click_element"), description: "Click an element on the page by CSS selector", inputSchema: { selector: z.string(), tabId: z.number().optional() } },
  { name: toCanonicalBuiltinRuntimeToolName("get_element_text"), description: "Get text content of an element", inputSchema: { selector: z.string(), tabId: z.number().optional() }, annotations: { readOnlyHint: true } },
  { name: toCanonicalBuiltinRuntimeToolName("get_element_html"), description: "Get outer HTML of an element", inputSchema: { selector: z.string(), tabId: z.number().optional() }, annotations: { readOnlyHint: true } },
  { name: toCanonicalBuiltinRuntimeToolName("query_elements"), description: "Query elements by CSS selector", inputSchema: { selector: z.string(), limit: z.number().optional(), tabId: z.number().optional() }, annotations: { readOnlyHint: true } },
  { name: toCanonicalBuiltinRuntimeToolName("fill_input"), description: "Fill an input field with a value", inputSchema: { selector: z.string(), value: z.string(), tabId: z.number().optional() } },
  { name: toCanonicalBuiltinRuntimeToolName("execute_js"), description: "Execute JavaScript expression in page context", inputSchema: { expression: z.string(), tabId: z.number().optional() } },
  { name: toCanonicalBuiltinRuntimeToolName("screenshot_tab"), description: "Take a screenshot of the current tab", inputSchema: { format: z.enum(["png", "jpeg"]).optional(), tabId: z.number().optional() }, annotations: { readOnlyHint: true } },
  { name: toCanonicalBuiltinRuntimeToolName("get_console_logs"), description: "Get recent console log entries from the page", inputSchema: { limit: z.number().optional(), level: z.enum(["all", "log", "warn", "error", "info"]).optional(), tabId: z.number().optional() }, annotations: { readOnlyHint: true } },
  { name: toCanonicalBuiltinRuntimeToolName("navigate"), description: "Navigate the current tab to a URL", inputSchema: { url: z.string(), tabId: z.number().optional() } },
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
    const registerRuntimeTool = (
      legacyName: string,
      schema: { description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> },
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) => {
      const canonicalName = toCanonicalBuiltinRuntimeToolName(legacyName);
      handles.set(canonicalName, registerTool(canonicalName, schema, handler));
      handles.set(
        legacyName,
        registerTool(
          legacyName,
          {
            ...schema,
            // Backward compatibility for historical calls: keep old names but suggest migration to namespaced canonical names.
            description: `${schema.description} (Deprecated alias. Use '${canonicalName}' instead.)`,
          },
          handler,
        ),
      );
      return canonicalName;
    };

    // list_tabs
    const listTabsName = registerRuntimeTool("list_tabs", { description: "List all open browser tabs", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => {
      try {
        const result = (await sendToExtension(listTabsName, {})) as ListTabsResult;
        const tabs = result.tabs;
        const output = tabs.map((tab) => `[${tab.id}] ${tab.active ? "★ " : "  "}${tab.title || "Untitled"} — ${tab.url}`).join("\n");
        return createTextResponse(output || "No tabs found");
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    // get_page_info
    const getPageInfoName = registerRuntimeTool("get_page_info", { description: "Get the current page URL, title, and metadata", inputSchema: { tabId: z.number().optional() } }, async ({ tabId }) => {
      try {
        const result = await sendToExtension(getPageInfoName, {}, tabId as number | undefined);
        return createTextResponse(JSON.stringify(result, null, 2));
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    // get_selected_text
    const getSelectedTextName = registerRuntimeTool("get_selected_text", { description: "Get the currently selected text on the page", inputSchema: { tabId: z.number().optional() } }, async ({ tabId }) => {
      try {
        const result = (await sendToExtension(getSelectedTextName, {}, tabId as number | undefined)) as SelectedTextResult;
        return createTextResponse(result.text || "(no text selected)");
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    // click_element
    const clickElementName = registerRuntimeTool("click_element", { description: "Click an element on the page by CSS selector", inputSchema: { selector: z.string(), tabId: z.number().optional() } }, async ({ selector, tabId }) => {
      try {
        await sendToExtension(clickElementName, { selector: selector as string }, tabId as number | undefined);
        return createTextResponse(`Clicked: ${selector}`);
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    // get_element_text
    const getElementTextName = registerRuntimeTool("get_element_text", { description: "Get text content of an element", inputSchema: { selector: z.string(), tabId: z.number().optional() } }, async ({ selector, tabId }) => {
      try {
        const result = (await sendToExtension(getElementTextName, { selector: selector as string }, tabId as number | undefined)) as ElementTextResult;
        return createTextResponse(result.text || "(empty)");
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    // get_element_html
    const getElementHtmlName = registerRuntimeTool("get_element_html", { description: "Get outer HTML of an element", inputSchema: { selector: z.string(), tabId: z.number().optional() } }, async ({ selector, tabId }) => {
      try {
        const result = (await sendToExtension(getElementHtmlName, { selector: selector as string }, tabId as number | undefined)) as ElementHtmlResult;
        return createTextResponse(result.html || "(empty)");
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    // query_elements
    const queryElementsName = registerRuntimeTool("query_elements", { description: "Query elements by CSS selector", inputSchema: { selector: z.string(), limit: z.number().optional(), tabId: z.number().optional() } }, async ({ selector, limit, tabId }) => {
      try {
        const result = (await sendToExtension(queryElementsName, { selector: selector as string, limit }, tabId as number | undefined)) as QueryElementsResult;
        const lines = result.results.map((element, index) => `${index + 1}. <${element.tag}${element.id ? `#${element.id}` : ""}${element.className ? `.${element.className.split(" ").join(".")}` : ""}> ${element.text}`);
        return createTextResponse(`Found ${result.count} elements:\n${lines.join("\n")}`);
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    // fill_input
    const fillInputName = registerRuntimeTool("fill_input", { description: "Fill an input field with a value", inputSchema: { selector: z.string(), value: z.string(), tabId: z.number().optional() } }, async ({ selector, value, tabId }) => {
      try {
        await sendToExtension(fillInputName, { selector: selector as string, value: value as string }, tabId as number | undefined);
        return createTextResponse(`Filled '${selector}' with: ${value}`);
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    // execute_js
    const executeJsName = registerRuntimeTool("execute_js", { description: "Execute JavaScript expression in page context", inputSchema: { expression: z.string(), tabId: z.number().optional() } }, async ({ expression, tabId }) => {
      try {
        const result = (await sendToExtension(executeJsName, { expression: expression as string }, tabId as number | undefined)) as ExecuteJsResult;
        return createTextResponse(result.ok ? `Result (${result.type}): ${result.result}` : `Execution error: ${result.error}`);
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    // screenshot_tab
    const screenshotTabName = registerRuntimeTool("screenshot_tab", { description: "Take a screenshot of the current tab", inputSchema: { format: z.enum(["png", "jpeg"]).optional(), tabId: z.number().optional() }, annotations: { readOnlyHint: true } }, async ({ format, tabId }) => {
      try {
        const result = (await sendToExtension(screenshotTabName, { format: format || "png" }, tabId as number | undefined)) as ScreenshotResult;
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
    });

    // get_console_logs
    const getConsoleLogsName = registerRuntimeTool("get_console_logs", { description: "Get recent console log entries from the page", inputSchema: { limit: z.number().optional(), level: z.enum(["all", "log", "warn", "error", "info"]).optional(), tabId: z.number().optional() }, annotations: { readOnlyHint: true } }, async ({ limit, level, tabId }) => {
      try {
        const result = (await sendToExtension(getConsoleLogsName, { limit, level }, tabId as number | undefined)) as ConsoleLogsResult;
        const text = result.entries.map((entry) => `[${new Date(entry.timestamp).toLocaleTimeString()}] [${entry.level.toUpperCase()}] ${entry.args}`).join("\n");
        return createTextResponse(text || "(no logs)");
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    // navigate
    const navigateName = registerRuntimeTool("navigate", { description: "Navigate the current tab to a URL", inputSchema: { url: z.string(), tabId: z.number().optional() } }, async ({ url, tabId }) => {
      try {
        await sendToExtension(navigateName, { url: url as string }, tabId as number | undefined);
        return createTextResponse(`Navigating to: ${url}`);
      } catch (error) {
        return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    return handles;
  }
}
