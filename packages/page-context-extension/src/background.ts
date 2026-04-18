/**
 * Background service worker coordinator.
 * Wires together WS connection, page context, tool execution, and extension event listeners.
 */

import {
  BRIDGE_METHODS,
  type FeedbackAnnotationClaimParams,
  type FeedbackAnnotationCreateParams,
  type FeedbackAnnotationDismissParams,
  type FeedbackAnnotationReplyParams,
  type FeedbackAnnotationResolveParams,
  type FeedbackStateSnapshotParams,
  type PageContextManifest,
  RpcProtocolError,
  RPC_ERROR_CODES,
} from "@page-context/shared-protocol";

import { connectWebSocket, forceReconnect, getWsReady, getSessionId, initDefaultWsUrl, log, queueNotification, requestBridge } from "./bg-ws-connection";
import { captureActiveTabFeedbackContext } from "./bg-feedback-context";
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
    // 支持 sidepanel 手动刷新自愈：discover 前先确保 MAIN world host 已注入。
    await ensureMainWorldBridgeHostOnTab(tabId).catch((error) => {
      log("Ensure MAIN world host failed before discovery", tabId, error);
    });

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

// background 统一通过 WS helper 访问 bridge，减少业务层重复判空与超时配置。
async function requestBridgeMethod<TResult>(method: string, params?: unknown): Promise<TResult> {
  return await requestBridge<TResult>(method, params, { timeoutMs: 20_000 });
}

async function ensureMainWorldBridgeHostOnTab(tabId: number, frameId?: number): Promise<{ ok: true }> {
  await chrome.scripting.executeScript({
    target: typeof frameId === "number" ? { tabId, frameIds: [frameId] } : { tabId },
    world: "MAIN",
    func: installPageContextBridgeHostInMainWorld,
  });
  return { ok: true };
}

async function ensureMainWorldBridgeHostOnSenderTab(sender: chrome.runtime.MessageSender): Promise<{ ok: true }> {
  const tabId = sender.tab?.id;
  if (!tabId) {
    throw new Error("No sender tab available for MAIN world host injection.");
  }

  const frameId = typeof sender.frameId === "number" ? sender.frameId : 0;
  return await ensureMainWorldBridgeHostOnTab(tabId, frameId);
}

function installPageContextBridgeHostInMainWorld(): void {
  const HOST_KEY = "__pageContextBridgeHost__";
  const BRIDGE_KEY = "__pageContextBridge__";
  const TOOLS_KEY = "__pageContextTools__";
  const HOST_READY_EVENT = "page-context-bridge-host:ready";
  const HOST_DEFAULT_SCENE = "page-context-host-idle";
  const HOST_ADOPTED_SOURCE_ID = "adopted-window-bridge";
  const HOST_LEGACY_SOURCE_PREFIX = "legacy-window-bridge";

  const win = window as unknown as Window & Record<string, unknown>;
  const existingHost = win[HOST_KEY] as { registerSource?: unknown } | undefined;
  if (existingHost && typeof existingHost.registerSource === "function") {
    return;
  }

  const state = {
    sourcesById: new Map<string, {
      sourceId: string;
      bridge: any;
      priority: number;
      tags: string[];
      registeredAt: string;
      registerOrder: number;
    }>(),
    registerOrderCursor: 0,
    diagnostics: [] as string[],
  };

  const orderedSources = () =>
    Array.from(state.sourcesById.values()).sort((left, right) => {
      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }
      return left.registerOrder - right.registerOrder;
    });

  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  const registerSource = (sourceId: string, bridge: any, priority = 100, tags: string[] = []) => {
    state.sourcesById.set(sourceId, {
      sourceId,
      bridge,
      priority,
      tags: Array.from(new Set((Array.isArray(tags) ? tags : []).filter(Boolean))),
      registeredAt: new Date().toISOString(),
      registerOrder: ++state.registerOrderCursor,
    });

    if (sourceId !== HOST_ADOPTED_SOURCE_ID) {
      const adopted = state.sourcesById.get(HOST_ADOPTED_SOURCE_ID);
      if (adopted && adopted.bridge === bridge) {
        state.sourcesById.delete(HOST_ADOPTED_SOURCE_ID);
      }
    }

    return () => {
      const current = state.sourcesById.get(sourceId);
      if (current && current.bridge === bridge) {
        state.sourcesById.delete(sourceId);
      }
    };
  };

  const isBridgeLike = (candidate: any): boolean =>
    Boolean(
      candidate &&
        typeof candidate.version === "string" &&
        typeof candidate.listNamespaces === "function" &&
        typeof candidate.getNamespace === "function" &&
        typeof candidate.getScene === "function" &&
        typeof candidate.listResources === "function" &&
        typeof candidate.readResource === "function" &&
        typeof candidate.listSkills === "function" &&
        typeof candidate.getSkill === "function" &&
        typeof candidate.getManifest === "function",
    );

  const bridgeSourceIdByRef = new WeakMap<object, string>();
  let legacySourceCursor = 0;
  const adoptLegacyAssignedBridge = (candidate: unknown, key: string): void => {
    if (!isBridgeLike(candidate) || candidate === hostBridge) {
      return;
    }
    const bridge = candidate as object;
    let sourceId = bridgeSourceIdByRef.get(bridge);
    if (!sourceId) {
      legacySourceCursor += 1;
      sourceId = `${HOST_LEGACY_SOURCE_PREFIX}:${legacySourceCursor}`;
      bridgeSourceIdByRef.set(bridge, sourceId);
    }
    registerSource(sourceId, candidate, 70, ["legacy-assignment", key]);
  };

  const hostBridge = {
    version: "page-context-bridge-host/1.0.0",
    listNamespaces: () => {
      const deduped = new Set<string>();
      for (const source of orderedSources()) {
        const namespaces = safe(() => source.bridge.listNamespaces(), [] as string[]);
        for (const namespace of namespaces) {
          deduped.add(namespace);
        }
      }
      return Array.from(deduped);
    },
    getNamespace: (namespace: string) => {
      for (const source of orderedSources()) {
        const instance = safe(() => source.bridge.getNamespace(namespace), undefined);
        if (instance) {
          return instance;
        }
      }
      return undefined;
    },
    getScene: () => {
      const scenes = Array.from(
        new Set(
          orderedSources()
            .map((source) => safe(() => source.bridge.getScene(), ""))
            .filter(Boolean),
        ),
      );
      if (scenes.length === 0) {
        return HOST_DEFAULT_SCENE;
      }
      if (scenes.length === 1) {
        return scenes[0]!;
      }
      return `page-context-host-mixed:${scenes.join("+")}`;
    },
    listResources: () => {
      const deduped = new Map<string, unknown>();
      for (const source of orderedSources()) {
        const resources = safe(() => source.bridge.listResources(), []);
        for (const resource of resources) {
          if (resource && typeof resource.id === "string" && !deduped.has(resource.id)) {
            deduped.set(resource.id, resource);
          }
        }
      }
      return Array.from(deduped.values());
    },
    readResource: (id: string) => {
      for (const source of orderedSources()) {
        const resources = safe(() => source.bridge.listResources(), []);
        const hasResource = resources.some((resource: any) => resource?.id === id);
        if (hasResource) {
          return safe(() => source.bridge.readResource(id), {
            id,
            mimeType: "application/json",
            text: JSON.stringify({ error: `Resource read failed: ${id}` }, null, 2),
          });
        }
      }
      return {
        id,
        mimeType: "application/json",
        text: JSON.stringify({ error: `Unknown resource id: ${id}` }, null, 2),
      };
    },
    listSkills: () => {
      const deduped = new Map<string, unknown>();
      for (const source of orderedSources()) {
        const skills = safe(() => source.bridge.listSkills(), []);
        for (const skill of skills) {
          if (skill && typeof skill.id === "string" && !deduped.has(skill.id)) {
            deduped.set(skill.id, skill);
          }
        }
      }
      return Array.from(deduped.values());
    },
    getSkill: (id: string, input?: Record<string, unknown>) => {
      for (const source of orderedSources()) {
        const skills = safe(() => source.bridge.listSkills(), []);
        const hasSkill = skills.some((skill: any) => skill?.id === id);
        if (hasSkill) {
          return safe(() => source.bridge.getSkill(id, input), undefined);
        }
      }
      return undefined;
    },
    getManifest: () => {
      const namespaces = new Map<string, unknown>();
      for (const source of orderedSources()) {
        const manifest = safe(() => source.bridge.getManifest(), null as any);
        const descriptors = Array.isArray(manifest?.namespaces) ? manifest.namespaces : [];
        for (const descriptor of descriptors) {
          if (descriptor && typeof descriptor.namespace === "string" && !namespaces.has(descriptor.namespace)) {
            namespaces.set(descriptor.namespace, descriptor);
          }
        }
      }
      return {
        version: "page-context-bridge-host/1.0.0",
        app: "page-context-bridge-host",
        route: `${window.location.pathname}${window.location.search}`,
        scene: (hostBridge as any).getScene(),
        namespaces: Array.from(namespaces.values()),
        resources: (hostBridge as any).listResources(),
        skills: (hostBridge as any).listSkills(),
        generatedAt: new Date().toISOString(),
      };
    },
  };

  const existingBridge = (win[BRIDGE_KEY] ?? win[TOOLS_KEY]) as any;

  if (isBridgeLike(existingBridge)) {
    registerSource(HOST_ADOPTED_SOURCE_ID, existingBridge, 10, ["adopted"]);
  }

  const host = {
    version: "page-context-bridge-host/1.0.0",
    bridge: hostBridge,
    registerSource: (input: { sourceId: string; bridge: any; priority?: number; tags?: string[] }) =>
      registerSource(input.sourceId, input.bridge, input.priority, input.tags),
    unregisterSource: (sourceId: string) => {
      state.sourcesById.delete(String(sourceId));
    },
    listSources: () =>
      orderedSources().map((entry) => ({
        sourceId: entry.sourceId,
        bridge: entry.bridge,
        priority: entry.priority,
        tags: entry.tags.slice(),
        registeredAt: entry.registeredAt,
      })),
    listDiagnostics: () => state.diagnostics.slice(),
  };

  win[HOST_KEY] = host;
  // 通过 getter/setter 保持 merge 语义：旧插件直接写 window.__pageContextBridge__ 也会被 host 收养为 source。
  Object.defineProperty(win, BRIDGE_KEY, {
    configurable: true,
    enumerable: false,
    get: () => hostBridge,
    set: (value: unknown) => {
      adoptLegacyAssignedBridge(value, BRIDGE_KEY);
    },
  });
  Object.defineProperty(win, TOOLS_KEY, {
    configurable: true,
    enumerable: false,
    get: () => hostBridge,
    set: (value: unknown) => {
      adoptLegacyAssignedBridge(value, TOOLS_KEY);
    },
  });

  try {
    window.dispatchEvent(new CustomEvent(HOST_READY_EVENT, { detail: host }));
  } catch {
    // ignore
  }
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
      case BRIDGE_METHODS.extensionFeedbackStateSnapshot: {
        const payload = (message.params ?? {}) as FeedbackStateSnapshotParams;
        const params: FeedbackStateSnapshotParams = { ...payload };
        if (params.tabId == null && !params.sessionId) {
          const context = await captureActiveTabFeedbackContext().catch(() => null);
          params.tabId = context?.tabId;
        }
        return await requestBridgeMethod(BRIDGE_METHODS.feedbackStateSnapshot, params);
      }
      case BRIDGE_METHODS.extensionFeedbackAnnotationCreate: {
        const payload = (message.params ?? {}) as Pick<FeedbackAnnotationCreateParams, "body" | "priority" | "selectedText">;
        if (!payload.body?.trim()) {
          throw new Error("Feedback body is required");
        }
        const context = await captureActiveTabFeedbackContext();
        // 页面浮层会提前缓存选区；若未提供则回退到后台即时采集，兼容 sidepanel 老调用。
        const selectedText = payload.selectedText?.trim() || context.selectedText;
        return await requestBridgeMethod(BRIDGE_METHODS.feedbackAnnotationCreate, {
          body: payload.body.trim(),
          priority: payload.priority,
          tabId: context.tabId,
          url: context.url,
          title: context.title,
          selectedText,
        } satisfies FeedbackAnnotationCreateParams);
      }
      case BRIDGE_METHODS.extensionFeedbackAnnotationClaim: {
        const payload = (message.params ?? {}) as FeedbackAnnotationClaimParams;
        return await requestBridgeMethod(BRIDGE_METHODS.feedbackAnnotationClaim, payload);
      }
      case BRIDGE_METHODS.extensionFeedbackAnnotationReply: {
        const payload = (message.params ?? {}) as FeedbackAnnotationReplyParams;
        return await requestBridgeMethod(BRIDGE_METHODS.feedbackAnnotationReply, payload);
      }
      case BRIDGE_METHODS.extensionFeedbackAnnotationResolve: {
        const payload = (message.params ?? {}) as FeedbackAnnotationResolveParams;
        return await requestBridgeMethod(BRIDGE_METHODS.feedbackAnnotationResolve, payload);
      }
      case BRIDGE_METHODS.extensionFeedbackAnnotationDismiss: {
        const payload = (message.params ?? {}) as FeedbackAnnotationDismissParams;
        return await requestBridgeMethod(BRIDGE_METHODS.feedbackAnnotationDismiss, payload);
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
      case BRIDGE_METHODS.extensionMainWorldHostEnsure:
        return await ensureMainWorldBridgeHostOnSenderTab(sender);
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
