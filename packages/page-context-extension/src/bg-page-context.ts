/**
 * Page context bridge interaction.
 * Uses the scripting API to read manifests, resources, skills,
 * and discover tools from the page context.
 */

import {
  type ContextResourcePayload,
  type ContextSkillPrompt,
  type PageContextManifest,
} from '@page-context/shared-protocol';

import type { PageToolEntry, PageToolSpec } from '@page-context/tool-visibility';
import { normalizePageToolEntries } from '@page-context/tool-visibility';

type JsonRecord = Record<string, unknown>;

/** Minimal shape of the page context bridge object injected into MAIN world.
 *  All properties are accessed only after runtime typeof/guard checks,
 *  so we keep them loose here to avoid excessive casts in every call site. */
type PageContextBridgeLike = Record<string, unknown>;

export interface BuiltinToolResult {
  [key: string]: unknown;
}

export interface PageToolExecutionResult {
  ok: boolean;
  result?: BuiltinToolResult;
  error?: string;
}

export async function getRawPageContextManifest(
  tabId: number,
): Promise<PageContextManifest | null> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const contextWindow = window as Window & {
        __pageContextBridge__?: PageContextBridgeLike;
        __pageContextTools__?: PageContextBridgeLike;
      };
      const pageTools = contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
      if (!pageTools || typeof pageTools.getManifest !== 'function') {
        return null;
      }
      return pageTools.getManifest();
    },
  });

  return (results[0]?.result ?? null) as PageContextManifest | null;
}

export async function readPageContextResource(
  tabId: number,
  resourceId: string,
): Promise<ContextResourcePayload> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (id) => {
      const contextWindow = window as Window & {
        __pageContextBridge__?: PageContextBridgeLike;
        __pageContextTools__?: PageContextBridgeLike;
      };
      const pageTools = contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
      if (!pageTools || typeof pageTools.readResource !== 'function') {
        throw new Error('Page Context Bridge does not expose readResource()');
      }
      return pageTools.readResource(id);
    },
    args: [resourceId],
  });

  return results[0]?.result as ContextResourcePayload;
}

export async function getPageContextSkill(
  tabId: number,
  skillId: string,
  input?: JsonRecord,
): Promise<ContextSkillPrompt | null> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (id, args) => {
      const contextWindow = window as Window & {
        __pageContextBridge__?: PageContextBridgeLike;
        __pageContextTools__?: PageContextBridgeLike;
      };
      const pageTools = contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
      if (!pageTools || typeof pageTools.getSkill !== 'function') {
        return null;
      }
      return pageTools.getSkill(id, args);
    },
    args: [skillId, input ?? {}],
  });

  return (results[0]?.result ?? null) as ContextSkillPrompt | null;
}

export async function discoverPageToolsInTab(
  tabId: number,
): Promise<Array<{ namespace: string; instanceId: string; tools: PageToolSpec[] }>> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const contextWindow = window as Window & {
        __pageContextBridge__?: PageContextBridgeLike;
        __pageContextTools__?: PageContextBridgeLike;
      };
      const pageTools = contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
      if (!pageTools || typeof pageTools !== 'object') {
        return [];
      }

      const entries: Array<{
        namespace: string;
        instanceId: string;
        tools: Array<Record<string, unknown>>;
      }> = [];

      if (typeof pageTools.listNamespaces === 'function' && typeof pageTools.version === 'string') {
        for (const namespace of pageTools.listNamespaces()) {
          const namespaceObject =
            (
              pageTools.getNamespace as unknown as (
                ns: string,
              ) => Record<string, unknown> | undefined
            )(namespace) ?? {};
          if (!namespaceObject || typeof namespaceObject !== 'object') {
            continue;
          }
          const instanceIds =
            (namespaceObject.listInstances as (() => string[]) | undefined)?.() ?? [];
          for (const instanceId of instanceIds) {
            const instance = (
              namespaceObject.getInstance as (id: string) => Record<string, unknown> | undefined
            )?.(instanceId);
            const tools =
              (instance?.listTools as (() => Array<Record<string, unknown>>) | undefined)?.() ?? [];
            if (Array.isArray(tools) && tools.length > 0) {
              entries.push({ namespace, instanceId, tools });
            }
          }
          if (instanceIds.length === 0 && typeof namespaceObject.listTools === 'function') {
            const tools = (namespaceObject.listTools as () => Array<Record<string, unknown>>)();
            if (Array.isArray(tools) && tools.length > 0) {
              entries.push({ namespace, instanceId: 'default', tools });
            }
          }
        }
        return entries;
      }

      if (typeof pageTools.listTools === 'function') {
        const tools = pageTools.listTools();
        if (Array.isArray(tools) && tools.length > 0) {
          entries.push({
            namespace: String(pageTools.namespace || 'page'),
            instanceId: String(pageTools.instanceId || 'default'),
            tools,
          });
        }
      }

      return entries;
    },
  });

  return (results[0]?.result ?? []) as Array<{
    namespace: string;
    instanceId: string;
    tools: PageToolSpec[];
  }>;
}

export async function executePageToolInTab(
  tabId: number,
  pageToolName: string,
  args: JsonRecord,
  namespace: string,
  instanceId?: string,
): Promise<PageToolExecutionResult> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (name: string, input: JsonRecord, ns: string, instId: string | undefined) => {
      const contextWindow = window as Window & {
        __pageContextBridge__?: PageContextBridgeLike;
        __pageContextTools__?: PageContextBridgeLike;
      };
      const pageTools = contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
      if (!pageTools || typeof pageTools !== 'object') {
        return { ok: false, error: 'No Page Context Bridge object available on this page' };
      }

      if (typeof pageTools.listNamespaces === 'function' && typeof pageTools.version === 'string') {
        const namespaceObject =
          (
            pageTools.getNamespace as unknown as (ns: string) => Record<string, unknown> | undefined
          )(ns) ?? {};
        if (!namespaceObject || typeof namespaceObject !== 'object') {
          return { ok: false, error: `Namespace not found: ${ns}` };
        }

        const listInstances = namespaceObject.listInstances as unknown as
          | (() => string[])
          | undefined;
        const getInstance = namespaceObject.getInstance as unknown as
          | ((id: string) => Record<string, unknown> | undefined)
          | undefined;

        const actualInstance = instId
          ? getInstance?.(instId)
          : getInstance?.(String(listInstances?.()?.[0] ?? ''));

        if (!actualInstance || typeof actualInstance.callTool !== 'function') {
          return { ok: false, error: `Instance not found: ${instId ?? 'default'}` };
        }

        try {
          const callFn = actualInstance.callTool as unknown as (
            name: string,
            args: JsonRecord,
          ) => unknown;
          const result = await Promise.resolve(callFn(name, input));
          return { ok: true, result };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }

      if (typeof pageTools.callTool !== 'function') {
        return { ok: false, error: 'Page Context Bridge has no callable API' };
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

  return (
    (results[0]?.result as PageToolExecutionResult) ?? { ok: false, error: 'No result returned' }
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
