/**
 * Tool execution logic: dispatches tool calls to extension providers or page context.
 */

import {
  type ExtensionToolProvider,
  type ServiceWorkerToolContext,
  RpcProtocolError,
  RPC_ERROR_CODES,
} from "@page-context/shared-protocol";
import { BuiltinExtensionProvider, toCanonicalBuiltinRuntimeToolName } from "@page-context/builtin-tools";

import type { BuiltinToolResult } from "./bg-page-context";
import { executePageToolInTab } from "./bg-page-context";
import { sendTabRequest } from "./runtime-rpc";
import { BRIDGE_METHODS } from "@page-context/shared-protocol";

type JsonRecord = Record<string, unknown>;

/** Extension-side tool providers. */
const extensionToolProviders: ExtensionToolProvider[] = [new BuiltinExtensionProvider()];

/** Build a ServiceWorkerToolContext backed by extension APIs. */
const serviceWorkerContext: ServiceWorkerToolContext = {
  async getActiveTabId() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? null;
  },
  async listTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      active: tab.active,
    }));
  },
  async captureVisibleTab(format: string, quality?: number) {
    return await chrome.tabs.captureVisibleTab({ format: format as "png" | "jpeg", quality });
  },
  async navigateTab(tabId: number, url: string) {
    await chrome.tabs.update(tabId, { url });
  },
};

export function getExtensionToolProviders(): ExtensionToolProvider[] {
  return extensionToolProviders;
}

export function getServiceWorkerContext(): ServiceWorkerToolContext {
  return serviceWorkerContext;
}

export function getBuiltinToolDefinitions(): Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }> {
  return extensionToolProviders.flatMap((provider) =>
    provider.getToolDefinitions().map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations,
    })),
  );
}

export async function executeToolCall(tool: string, args: JsonRecord, tabId?: number): Promise<BuiltinToolResult> {
  const normalizedTool = toCanonicalBuiltinRuntimeToolName(tool);

  // Check extension tool providers first
  for (const provider of extensionToolProviders) {
    const definitions = provider.getToolDefinitions();
    const def = definitions.find((d) => d.name === normalizedTool);
    if (!def) {
      continue;
    }

    if (def.executionContext === "service-worker" && provider.executeInServiceWorker) {
      return await provider.executeInServiceWorker(normalizedTool, args, serviceWorkerContext) as BuiltinToolResult;
    }

    if (def.executionContext === "content-script") {
      const targetTabId = tabId ?? (await getActiveTabId());
      if (!targetTabId) {
        throw new RpcProtocolError(RPC_ERROR_CODES.invalidRequest, "No active tab available");
      }
      return await sendTabRequest<BuiltinToolResult>(targetTabId, BRIDGE_METHODS.extensionToolExecute, {
        tool: normalizedTool,
        args,
        _providerId: provider.id,
      });
    }
  }

  // Page context tools (namespaced)
  if (normalizedTool.startsWith("page.") || normalizedTool.includes(".")) {
    return await executePageTool(normalizedTool, args, tabId);
  }

  throw new RpcProtocolError(RPC_ERROR_CODES.methodNotFound, `Unknown tool: ${tool}`);
}

async function executePageTool(tool: string, args: JsonRecord, tabId?: number): Promise<BuiltinToolResult> {
  const targetTabId = tabId ?? (await getActiveTabId());
  if (!targetTabId) {
    throw new Error("No active tab available");
  }

  const parts = tool.split(".");
  const pageToolName = parts.at(-1) ?? tool;
  const namespace = parts.length >= 2 ? parts[0] : "page";
  const instanceId = parts.length >= 3 ? parts[1] : undefined;

  const outcome = await executePageToolInTab(targetTabId, pageToolName, args, namespace, instanceId);
  if (!outcome.ok) {
    throw new Error(outcome.error ?? "Unknown page tool execution failure");
  }
  return outcome.result ?? {};
}

async function getActiveTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}
