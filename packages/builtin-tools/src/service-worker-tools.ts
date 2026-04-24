/**
 * Service-worker tool implementations.
 *
 * These tools execute in the page-context extension service worker (background)
 * where they have access to extension APIs (tabs, etc.) but not the DOM.
 */

import type { ServiceWorkerToolContext } from "@page-context/shared-protocol";
import { toCanonicalBuiltinRuntimeToolName } from "./runtime-tool-names.js";

/**
 * Execute a builtin tool in the service worker context.
 * Only handles tools with executionContext === "service-worker".
 */
export async function executeServiceWorkerTool(
  tool: string,
  args: Record<string, unknown>,
  ctx: ServiceWorkerToolContext,
): Promise<unknown> {
  const normalizedTool = toCanonicalBuiltinRuntimeToolName(tool);

  switch (normalizedTool) {
    case "builtin.list_tabs": {
      const tabs = await ctx.listTabs();
      return { tabs };
    }
    case "builtin.screenshot_tab": {
      const format = (args.format as "png" | "jpeg" | undefined) ?? "png";
      const quality = Number(args.quality ?? 80);
      const dataUrl = await ctx.captureVisibleTab(format, format === "jpeg" ? Math.round(quality) : undefined);
      return {
        format,
        dataUrl,
        sizeHint: dataUrl.length,
      };
    }
    case "builtin.navigate": {
      const targetTabId = Number(args.tabId ?? 0) || (await ctx.getActiveTabId());
      if (!targetTabId) {
        throw new Error("No active tab available");
      }
      const url = String(args.url ?? "");
      await ctx.navigateTab(targetTabId, url);
      return { navigating: true, tabId: targetTabId, url };
    }
    default:
      throw new Error(`Unknown service-worker tool: ${tool}`);
  }
}
