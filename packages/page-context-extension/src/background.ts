/**
 * Background service worker coordinator.
 * Wires together WS connection, page context, tool execution, and extension event listeners.
 */

import {
  BRIDGE_METHODS,
  type PageContextManifest,
  RpcProtocolError,
  RPC_ERROR_CODES,
} from "@page-context/shared-protocol";

import { connectWebSocket, forceReconnect, getWsReady, getSessionId, initDefaultWsUrl, log, queueNotification } from "./bg-ws-connection";
import { discoverPageToolsInTab, getRawPageContextManifest, getPageContextSkill, readPageContextResource, sleep } from "./bg-page-context";
import { executeToolCall, getBuiltinToolDefinitions } from "./bg-tool-executor";
import { buildContextManifestFilterDebug } from "./context-manifest-filter-debug";
import { flattenPageTools, mergePageToolEntry, normalizePageToolEntries, type PageToolEntry, type PageToolSpec } from "./page-tool-registry";
import { buildToolTree, getEnabledBuiltinTools, getEnabledToolsForTab, isToolEnabled, setScopeEnabled, type PageToolPreferences } from "./page-tool-visibility";
import { createRuntimeListener } from "./runtime-rpc";

const PAGE_TOOL_PREFERENCES_KEY = "pageToolPreferences";

type JsonRecord = Record<string, unknown>;

let pageToolPreferences: PageToolPreferences = {};
let pageToolPreferencesReady: Promise<void> | null = null;

const inFlightToolCalls = new Map<string, string>();
const pageToolsByTab = new Map<number, PageToolEntry[]>();
const discoveryInFlight = new Map<number, Promise<PageToolEntry[]>>();

// ── Preferences ──

function ensurePageToolPreferencesLoaded(): Promise<void> {
  if (!pageToolPreferencesReady) {
    pageToolPreferencesReady = chrome.storage.local
      .get({ [PAGE_TOOL_PREFERENCES_KEY]: {} })
      .then((result) => {
        pageToolPreferences = (result[PAGE_TOOL_PREFERENCES_KEY] as PageToolPreferences | undefined) ?? {};
      });
  }

  return pageToolPreferencesReady;
}

async function persistPageToolPreferences(): Promise<void> {
  await chrome.storage.local.set({ [PAGE_TOOL_PREFERENCES_KEY]: pageToolPreferences });
}

// ── Tool publishing ──

function getBuiltinTools(): PageToolSpec[] {
  return getBuiltinToolDefinitions().map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    annotations: def.annotations,
  }));
}

function getAllTools(): PageToolSpec[] {
  const builtin = getEnabledBuiltinTools(getBuiltinTools(), pageToolPreferences);
  for (const [tabId, entries] of pageToolsByTab.entries()) {
    builtin.push(...getEnabledToolsForTab(entries, pageToolPreferences, tabId));
  }
  return builtin;
}

function publishBuiltinTools(): void {
  void ensurePageToolPreferencesLoaded().then(() => {
    queueNotification(BRIDGE_METHODS.bridgeBuiltinToolsUpdated, {
      tools: getEnabledBuiltinTools(getBuiltinTools(), pageToolPreferences),
    });
  });
}

function publishPageToolsForTab(tabId: number): void {
  void ensurePageToolPreferencesLoaded().then(() => {
    queueNotification(BRIDGE_METHODS.bridgePageToolsRegistered, {
      tabId,
      tools: getEnabledToolsForTab(pageToolsByTab.get(tabId), pageToolPreferences, tabId),
    });
  });
}

async function buildPageToolsTreeResponse() {
  const tabs = await chrome.tabs.query({});
  return buildToolTree(tabs, pageToolsByTab, getBuiltinTools(), pageToolPreferences);
}

// ── Manifest filtering ──

function filterManifestByPreferences(tabId: number, manifest: PageContextManifest): PageContextManifest {
  const enabledPageToolNames = new Set(getEnabledToolsForTab(pageToolsByTab.get(tabId), pageToolPreferences, tabId).map((tool) => tool.name));
  const enabledBuiltinToolNames = new Set(getEnabledBuiltinTools(getBuiltinTools(), pageToolPreferences).map((tool) => tool.name));
  const enabledNamespaces = new Set(
    manifest.namespaces
      .filter((entry: PageContextManifest["namespaces"][number]) => isToolEnabled(pageToolPreferences, { root: "page", tabId, namespace: entry.namespace }))
      .map((entry: PageContextManifest["namespaces"][number]) => entry.namespace),
  );

  return {
    ...manifest,
    namespaces: manifest.namespaces.filter((entry: PageContextManifest["namespaces"][number]) => enabledNamespaces.has(entry.namespace)),
    resources: manifest.resources.filter((entry: PageContextManifest["resources"][number]) => enabledNamespaces.has(entry.namespace)),
    skills: manifest.skills
      .filter((entry: PageContextManifest["skills"][number]) => enabledNamespaces.has(entry.namespace))
      .map((entry: PageContextManifest["skills"][number]) => ({
        ...entry,
        resourceIds: (entry.resourceIds ?? []).filter((resourceId: string) => manifest.resources.some((resource: PageContextManifest["resources"][number]) => resource.id === resourceId && enabledNamespaces.has(resource.namespace))),
        toolNames: (entry.toolNames ?? []).filter((toolName: string) => enabledPageToolNames.has(toolName) || enabledBuiltinToolNames.has(toolName)),
      })),
  };
}

// ── Tool discovery ──

async function discoverPageToolsForTab(tabId: number, force = false): Promise<PageToolEntry[]> {
  if (!force) {
    const existing = discoveryInFlight.get(tabId);
    if (existing) {
      return await existing;
    }
  }

  const discoveryPromise = (async () => {
    const delays = [0, 500, 1_500, 3_000];
    for (const delay of delays) {
      if (delay > 0) {
        await sleep(delay);
      }

      try {
        const rawEntries = await discoverPageToolsInTab(tabId);
        if (rawEntries.length === 0) {
          continue;
        }

        const normalized = normalizePageToolEntries(rawEntries);
        pageToolsByTab.set(tabId, normalized);
        publishPageToolsForTab(tabId);
        return normalized;
      } catch (error) {
        log("Page tool discovery failed", tabId, error);
        break;
      }
    }

    pageToolsByTab.delete(tabId);
    return [];
  })();

  discoveryInFlight.set(tabId, discoveryPromise);
  try {
    return await discoveryPromise;
  } finally {
    discoveryInFlight.delete(tabId);
  }
}

function clearPageTools(tabId: number): void {
  if (!pageToolsByTab.has(tabId)) {
    return;
  }
  pageToolsByTab.delete(tabId);
  queueNotification(BRIDGE_METHODS.bridgePageToolsUnregistered, { tabId });
}

// ── Tab helpers ──

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => ({
    id: tab.id,
    url: tab.url,
    title: tab.title,
    active: tab.active,
  }));
}

// ── WS connection callbacks ──

async function onToolCall(params: unknown, requestId: string): Promise<unknown> {
  const call = params as { tool: string; args?: JsonRecord; tabId?: number };
  inFlightToolCalls.set(requestId, call.tool);
  try {
    return await executeToolCall(call.tool, call.args ?? {}, call.tabId);
  } finally {
    inFlightToolCalls.delete(requestId);
  }
}

async function onToolsList(): Promise<unknown> {
  return getAllTools();
}

async function onTabsList(): Promise<unknown> {
  return await listTabs();
}

// ── Extension event listeners ──

chrome.runtime.onMessage.addListener(
  createRuntimeListener(async (message, sender) => {
    await ensurePageToolPreferencesLoaded();

    switch (message.method) {
      case BRIDGE_METHODS.extensionStatusGet:
        return {
          connected: getWsReady(),
          wsUrl: null,
          pendingToolCalls: inFlightToolCalls.size,
          sessionId: getSessionId(),
        };
      case BRIDGE_METHODS.extensionReconnect:
        await forceReconnect(onToolCall, onToolsList, onTabsList);
        return { ok: true };
      case BRIDGE_METHODS.extensionPageToolsGet: {
        const tabId = Number((message.params as { tabId?: number })?.tabId ?? 0);
        return { tools: flattenPageTools(pageToolsByTab.get(tabId)) };
      }
      case BRIDGE_METHODS.extensionPageToolsTreeGet:
        return await buildPageToolsTreeResponse();
      case BRIDGE_METHODS.extensionPageToolsDiscover: {
        const tabId = Number((message.params as { tabId?: number })?.tabId ?? 0);
        if (!tabId) {
          throw new Error("No tabId provided");
        }
        const entries = await discoverPageToolsForTab(tabId, true);
        return { tools: flattenPageTools(entries) };
      }
      case BRIDGE_METHODS.extensionContextManifestGet: {
        const tabId = Number((message.params as { tabId?: number })?.tabId ?? 0);
        if (!tabId) {
          throw new Error("No tabId provided");
        }
        const rawManifest = await getRawPageContextManifest(tabId);
        const manifest = rawManifest ? filterManifestByPreferences(tabId, rawManifest) : null;
        const enabledPageToolNames = new Set(getEnabledToolsForTab(pageToolsByTab.get(tabId), pageToolPreferences, tabId).map((tool) => tool.name));
        const enabledBuiltinToolNames = new Set(getEnabledBuiltinTools(getBuiltinTools(), pageToolPreferences).map((tool) => tool.name));
        return {
          manifest,
          rawManifest,
          debug: buildContextManifestFilterDebug(rawManifest, manifest, enabledPageToolNames, enabledBuiltinToolNames),
        };
      }
      case BRIDGE_METHODS.extensionContextResourceRead: {
        const payload = message.params as { tabId?: number; resourceId?: string };
        const tabId = Number(payload.tabId ?? 0);
        if (!tabId || !payload.resourceId) {
          throw new Error("tabId and resourceId are required");
        }
        return await readPageContextResource(tabId, payload.resourceId);
      }
      case BRIDGE_METHODS.extensionContextSkillGet: {
        const payload = message.params as { tabId?: number; skillId?: string; input?: JsonRecord };
        const tabId = Number(payload.tabId ?? 0);
        if (!tabId || !payload.skillId) {
          throw new Error("tabId and skillId are required");
        }
        return { prompt: await getPageContextSkill(tabId, payload.skillId, payload.input) };
      }
      case BRIDGE_METHODS.extensionPageEvent:
        queueNotification(BRIDGE_METHODS.bridgePageEvent, {
          tabId: sender.tab?.id ?? null,
          payload: (message.params as { payload?: unknown })?.payload,
        });
        return { ok: true };
      case BRIDGE_METHODS.extensionPageToolsRegister: {
        const payload = message.params as { namespace?: string; instanceId?: string; tools?: PageToolSpec[] };
        const tabId = sender.tab?.id;
        if (!tabId) {
          throw new Error("No sender tab available");
        }
        const entry = normalizePageToolEntries([
          {
            namespace: payload.namespace ?? "page",
            instanceId: payload.instanceId ?? "default",
            tools: payload.tools ?? [],
          },
        ])[0]!;
        const mergedEntries = mergePageToolEntry(pageToolsByTab.get(tabId) ?? [], entry);
        pageToolsByTab.set(tabId, mergedEntries);
        publishPageToolsForTab(tabId);
        return { ok: true };
      }
      case BRIDGE_METHODS.extensionPageToolsSetEnabled: {
        const payload = message.params as { root?: "builtin" | "page"; tabId?: number; namespace?: string; instanceId?: string; toolName?: string; enabled: boolean };
        pageToolPreferences = setScopeEnabled(pageToolPreferences, payload, payload.enabled);
        await persistPageToolPreferences();
        if (payload.root === "builtin") {
          publishBuiltinTools();
        } else if (payload.tabId != null) {
          publishPageToolsForTab(payload.tabId);
        }
        return await buildPageToolsTreeResponse();
      }
      case BRIDGE_METHODS.extensionToolDebugCall: {
        const payload = message.params as { toolName?: string; args?: JsonRecord; tabId?: number };
        if (!payload.toolName) {
          throw new Error("No toolName provided");
        }

        try {
          const result = await executeToolCall(payload.toolName, payload.args ?? {}, payload.tabId);
          return { ok: true, result };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      default:
        throw new RpcProtocolError(RPC_ERROR_CODES.methodNotFound, `Unhandled runtime method: ${message.method}`);
    }
  }),
);

chrome.tabs.onActivated.addListener((activeInfo) => {
  queueNotification(BRIDGE_METHODS.bridgeTabActivated, {
    tabId: activeInfo.tabId,
    windowId: activeInfo.windowId,
  });
  void discoverPageToolsForTab(activeInfo.tabId).catch((error) => log("Discovery on tab activation failed", error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    clearPageTools(tabId);
  }

  if (changeInfo.status === "complete" || changeInfo.url) {
    queueNotification(BRIDGE_METHODS.bridgeTabUpdated, {
      tabId,
      url: changeInfo.url,
      status: changeInfo.status,
    });
  }

  if (changeInfo.status === "complete") {
    void discoverPageToolsForTab(tabId, true).catch((error) => log("Discovery on tab update failed", error));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearPageTools(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  void initDefaultWsUrl();
  void connectWebSocket(onToolCall, onToolsList, onTabsList);
});

chrome.runtime.onStartup.addListener(() => {
  void connectWebSocket(onToolCall, onToolsList, onTabsList);
});

void connectWebSocket(onToolCall, onToolsList, onTabsList);
void ensurePageToolPreferencesLoaded().then(() => {
  publishBuiltinTools();
  for (const tabId of pageToolsByTab.keys()) {
    publishPageToolsForTab(tabId);
  }
});

setInterval(() => {
  chrome.runtime.getPlatformInfo(() => undefined);
}, 25_000);
