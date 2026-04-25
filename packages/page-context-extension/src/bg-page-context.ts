/**
 * Page context bridge interaction.
 * Uses the scripting API to read manifests, resources, skills,
 * and discover tools from the page context.
 */

import {
  type ContextResourcePayload,
  type ContextSkillPrompt,
  type PageContextManifest,
} from "@page-context/shared-protocol";

import type { PageToolEntry, PageToolSpec } from "@page-context/tool-visibility";
import { normalizePageToolEntries } from "@page-context/tool-visibility";

type JsonRecord = Record<string, unknown>;

export interface BuiltinToolResult {
  [key: string]: unknown;
}

export interface PageToolExecutionResult {
  ok: boolean;
  result?: BuiltinToolResult;
  error?: string;
}

export async function getRawPageContextManifest(tabId: number): Promise<PageContextManifest | null> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const contextWindow = window as Window & { __pageContextBridge__?: any; __pageContextTools__?: any };
      const pageTools = contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
      if (!pageTools || typeof pageTools.getManifest !== "function") {
        return null;
      }
      return pageTools.getManifest();
    },
  });

  return (results[0]?.result ?? null) as PageContextManifest | null;
}

export async function readPageContextResource(tabId: number, resourceId: string): Promise<ContextResourcePayload> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (id) => {
      const contextWindow = window as Window & { __pageContextBridge__?: any; __pageContextTools__?: any };
      const pageTools = contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
      if (!pageTools || typeof pageTools.readResource !== "function") {
        throw new Error("Page Context Bridge does not expose readResource()");
      }
      return pageTools.readResource(id);
    },
    args: [resourceId],
  });

  return results[0]?.result as ContextResourcePayload;
}

export async function getPageContextSkill(tabId: number, skillId: string, input?: JsonRecord): Promise<ContextSkillPrompt | null> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (id, args) => {
      const contextWindow = window as Window & { __pageContextBridge__?: any; __pageContextTools__?: any };
      const pageTools = contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
      if (!pageTools || typeof pageTools.getSkill !== "function") {
        return null;
      }
      return pageTools.getSkill(id, args);
    },
    args: [skillId, input ?? {}],
  });

  return (results[0]?.result ?? null) as ContextSkillPrompt | null;
}

export async function discoverPageToolsInTab(tabId: number): Promise<Array<{ namespace: string; instanceId: string; tools: PageToolSpec[] }>> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const contextWindow = window as Window & { __pageContextBridge__?: any; __pageContextTools__?: any };
      const pageTools = contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
      if (!pageTools || typeof pageTools !== "object") {
        return [];
      }

      const entries: Array<{ namespace: string; instanceId: string; tools: Array<Record<string, unknown>> }> = [];

      if (typeof pageTools.listNamespaces === "function" && typeof pageTools.version === "string") {
        for (const namespace of pageTools.listNamespaces()) {
          const namespaceObject = pageTools.getNamespace(namespace);
          if (!namespaceObject) {
            continue;
          }
          const instanceIds = namespaceObject.listInstances?.() ?? [];
          for (const instanceId of instanceIds) {
            const instance = namespaceObject.getInstance(instanceId);
            const tools = instance?.listTools?.() ?? [];
            if (Array.isArray(tools) && tools.length > 0) {
              entries.push({ namespace, instanceId, tools });
            }
          }
          if (instanceIds.length === 0 && typeof namespaceObject.listTools === "function") {
            const tools = namespaceObject.listTools();
            if (Array.isArray(tools) && tools.length > 0) {
              entries.push({ namespace, instanceId: "default", tools });
            }
          }
        }
        return entries;
      }

      if (typeof pageTools.listTools === "function") {
        const tools = pageTools.listTools();
        if (Array.isArray(tools) && tools.length > 0) {
          entries.push({
            namespace: pageTools.namespace || "page",
            instanceId: pageTools.instanceId || "default",
            tools,
          });
        }
      }

      return entries;
    },
  });

  return (results[0]?.result ?? []) as Array<{ namespace: string; instanceId: string; tools: PageToolSpec[] }>;
}

export async function executePageToolInTab(tabId: number, pageToolName: string, args: JsonRecord, namespace: string, instanceId?: string): Promise<PageToolExecutionResult> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (name, input, ns, instId) => {
      const contextWindow = window as Window & { __pageContextBridge__?: any; __pageContextTools__?: any };
      const pageTools = contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
      if (!pageTools || typeof pageTools !== "object") {
        return { ok: false, error: "No Page Context Bridge object available on this page" };
      }

      if (typeof pageTools.listNamespaces === "function" && typeof pageTools.version === "string") {
        const namespaceObject = pageTools.getNamespace(ns);
        if (!namespaceObject) {
          return { ok: false, error: `Namespace not found: ${ns}` };
        }

        const actualInstance = instId
          ? namespaceObject.getInstance(instId)
          : namespaceObject.getInstance(namespaceObject.listInstances()[0]);

        if (!actualInstance || typeof actualInstance.callTool !== "function") {
          return { ok: false, error: `Instance not found: ${instId ?? "default"}` };
        }

        try {
          const result = await Promise.resolve(actualInstance.callTool(name, input));
          return { ok: true, result };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }

      if (typeof pageTools.callTool !== "function") {
        return { ok: false, error: "Page Context Bridge has no callable API" };
      }

      try {
        const result = await Promise.resolve(pageTools.callTool(name, input));
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    args: [pageToolName, args, namespace, instanceId],
  });

  return results[0]?.result as PageToolExecutionResult ?? { ok: false, error: "No result returned" };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
