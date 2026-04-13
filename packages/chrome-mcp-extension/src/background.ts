import {
  BRIDGE_METHODS,
  type ContextResourcePayload,
  type ContextSkillPrompt,
  type PageContextManifest,
  RpcPeer,
  RpcProtocolError,
  RPC_ERROR_CODES,
} from "@page-context/shared-protocol";

import { buildContextManifestFilterDebug } from "./context-manifest-filter-debug.js";
import { flattenPageTools, mergePageToolEntry, normalizePageToolEntries, type PageToolEntry, type PageToolSpec } from "./page-tool-registry.js";
import { buildToolTree, getEnabledBuiltinTools, getEnabledToolsForTab, isToolEnabled, setScopeEnabled, type PageToolPreferences } from "./page-tool-visibility.js";
import { createRuntimeListener, sendTabRequest } from "./runtime-rpc.js";

const MCP_WS_URL_KEY = "mcpWsUrl";
const PAGE_TOOL_PREFERENCES_KEY = "pageToolPreferences";
const DEFAULT_MCP_WS_URL = "ws://127.0.0.1:9001";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

type JsonRecord = Record<string, unknown>;

interface SessionRegisterResult {
  sessionId: string;
  heartbeatIntervalMs?: number;
}

interface TabSummary {
  id?: number;
  url?: string;
  title?: string;
  active?: boolean;
}

interface BuiltinToolResult {
  [key: string]: unknown;
}

let ws: WebSocket | null = null;
let rpcPeer: RpcPeer | null = null;
let wsReady = false;
let sessionId: string | null = null;
let connectPromise: Promise<void> | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsEpoch = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pageToolPreferences: PageToolPreferences = {};
let pageToolPreferencesReady: Promise<void> | null = null;

const queuedNotifications: Array<{ method: string; params?: unknown }> = [];
const inFlightToolCalls = new Map<string, string>();
const pageToolsByTab = new Map<number, PageToolEntry[]>();
const discoveryInFlight = new Map<number, Promise<PageToolEntry[]>>();

function log(...args: unknown[]): void {
  console.log("[PAGE-CONTEXT-BG]", ...args);
}

function getPageContextBridgeHandle(win: Window & typeof globalThis): any {
  const contextWindow = win as Window & {
    __pageContextBridge__?: any;
    __pageContextTools__?: any;
  };

  return contextWindow.__pageContextBridge__
    ?? contextWindow.__pageContextTools__
    ?? null;
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function ensureHeartbeatTimer(): void {
  if (heartbeatTimer) {
    return;
  }

  heartbeatTimer = setInterval(() => {
    if (!wsReady || !rpcPeer || !sessionId) {
      return;
    }
    rpcPeer.notify(BRIDGE_METHODS.sessionHeartbeat, { sentAt: Date.now() }).catch((error: unknown) => {
      log("Heartbeat failed", error);
    });
  }, HEARTBEAT_INTERVAL_MS);
}

function queueNotification(method: string, params?: unknown): void {
  if (wsReady && rpcPeer) {
    rpcPeer.notify(method, params).catch((error: unknown) => log(`Failed to notify ${method}`, error));
    return;
  }

  queuedNotifications.push({ method, params });
}

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

async function getPageContextManifest(tabId: number): Promise<PageContextManifest | null> {
  const rawManifest = await getRawPageContextManifest(tabId);
  return rawManifest ? filterManifestByPreferences(tabId, rawManifest) : null;
}

async function getRawPageContextManifest(tabId: number): Promise<PageContextManifest | null> {
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

async function readPageContextResource(tabId: number, resourceId: string): Promise<ContextResourcePayload> {
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

async function getPageContextSkill(tabId: number, skillId: string, input?: JsonRecord): Promise<ContextSkillPrompt | null> {
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

async function flushQueuedNotifications(): Promise<void> {
  if (!wsReady || !rpcPeer) {
    return;
  }

  while (queuedNotifications.length > 0) {
    const next = queuedNotifications.shift();
    if (!next) {
      continue;
    }
    await rpcPeer.notify(next.method, next.params);
  }
}

async function getWsUrl(): Promise<string> {
  const result = await chrome.storage.local.get({
    [MCP_WS_URL_KEY]: DEFAULT_MCP_WS_URL,
  });
  return result[MCP_WS_URL_KEY] as string;
}

function scheduleReconnect(): void {
  if (reconnectTimer) {
    return;
  }

  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectWebSocket();
  }, delay);
  log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
}

async function connectWebSocket(): Promise<void> {
  if (connectPromise) {
    return await connectPromise;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  connectPromise = (async () => {
    const url = await getWsUrl();
    const socket = new WebSocket(url);
    const epoch = ++wsEpoch;
    ws = socket;
    wsReady = false;
    sessionId = null;

    rpcPeer = new RpcPeer({
      send: (message: string) => socket.send(message),
      defaultTimeoutMs: 30_000,
      getMeta: () => ({
        sessionId: sessionId ?? undefined,
        source: "extension",
        target: "bridge",
      }),
    });

    rpcPeer.register(BRIDGE_METHODS.bridgeToolCall, async (params: unknown, request) => {
      const call = params as { tool: string; args?: JsonRecord; tabId?: number };
      inFlightToolCalls.set(request.id, call.tool);
      try {
        return await executeToolCall(call.tool, call.args ?? {}, call.tabId);
      } finally {
        inFlightToolCalls.delete(request.id);
      }
    });

    rpcPeer.register(BRIDGE_METHODS.bridgeToolsList, async () => getAllTools());
    rpcPeer.register(BRIDGE_METHODS.bridgeTabsList, async () => await listTabs());

    await new Promise<void>((resolve) => {
      socket.onopen = () => {
        resolve();
      };

      socket.onmessage = (event) => {
        if (ws !== socket || epoch !== wsEpoch || !rpcPeer) {
          return;
        }
        void rpcPeer.receive(String(event.data)).catch((error: unknown) => log("Failed to process bridge message", error));
      };

      socket.onerror = (error: Event) => {
        if (ws !== socket || epoch !== wsEpoch) {
          return;
        }
        log("WebSocket error", error);
      };

      socket.onclose = () => {
        if (ws !== socket || epoch !== wsEpoch) {
          return;
        }
        log("WebSocket closed");
        wsReady = false;
        sessionId = null;
        rpcPeer?.failAllPending("Bridge transport closed");
        ws = null;
        scheduleReconnect();
      };
    });

    try {
      const result = await rpcPeer.request<SessionRegisterResult>(BRIDGE_METHODS.sessionRegister, {
        extensionId: chrome.runtime.id,
        version: chrome.runtime.getManifest().version,
      }, { timeoutMs: 5_000 });
      sessionId = result.sessionId;
      wsReady = true;
      reconnectAttempts = 0;
      clearReconnectTimer();
      ensureHeartbeatTimer();
      await flushQueuedNotifications();
      log("Bridge session ready", sessionId);
    } catch (error: unknown) {
      log("Bridge session register failed", error);
      socket.close();
    }
  })();

  try {
    await connectPromise;
  } finally {
    connectPromise = null;
  }
}

async function listTabs(): Promise<TabSummary[]> {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => ({
    id: tab.id,
    url: tab.url,
    title: tab.title,
    active: tab.active,
  }));
}

async function executeToolCall(tool: string, args: JsonRecord, tabId?: number): Promise<BuiltinToolResult> {
  if (tool === "list_tabs") {
    return { tabs: await listTabs() };
  }

  if (tool === "screenshot_tab" || tool === "navigate") {
    return await executeServiceWorkerTool(tool, args, tabId);
  }

  if (tool.startsWith("page.") || tool.includes(".")) {
    return await executePageTool(tool, args, tabId);
  }

  const targetTabId = tabId ?? (await getActiveTabId());
  if (!targetTabId) {
    throw new RpcProtocolError(RPC_ERROR_CODES.invalidRequest, "No active tab available");
  }

  return await sendTabRequest<BuiltinToolResult>(targetTabId, BRIDGE_METHODS.extensionToolExecute, {
    tool,
    args,
  });
}

async function executeServiceWorkerTool(tool: string, args: JsonRecord, tabId?: number): Promise<BuiltinToolResult> {
  const targetTabId = tabId ?? (await getActiveTabId());
  if (!targetTabId) {
    throw new Error("No active tab available");
  }

  switch (tool) {
    case "screenshot_tab": {
      const format = (args.format as "png" | "jpeg" | undefined) ?? "png";
      const quality = Number(args.quality ?? 80);
      const dataUrl = await chrome.tabs.captureVisibleTab({
        format,
        quality: format === "jpeg" ? Math.round(quality) : undefined,
      });
      return {
        format,
        dataUrl,
        sizeHint: dataUrl.length,
      };
    }
    case "navigate": {
      const url = String(args.url ?? "");
      await chrome.tabs.update(targetTabId, { url });
      return { navigating: true, tabId: targetTabId, url };
    }
    default:
      throw new Error(`Unknown service worker tool: ${tool}`);
  }
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

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
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

  const outcome = results[0]?.result as { ok: boolean; result?: BuiltinToolResult; error?: string } | undefined;
  if (!outcome) {
    throw new Error("No result returned from page tool execution");
  }
  if (!outcome.ok) {
    throw new Error(outcome.error ?? "Unknown page tool execution failure");
  }
  return outcome.result ?? {};
}

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

        const rawEntries = (results[0]?.result ?? []) as Array<{ namespace: string; instanceId: string; tools: PageToolSpec[] }>;
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

function getBuiltinTools(): PageToolSpec[] {
  return [
    { name: "list_tabs", description: "List all open browser tabs", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
    { name: "get_page_info", description: "Get the current page URL, title, and basic metadata", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
    { name: "get_selected_text", description: "Get the currently selected text on the page", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
    { name: "click_element", description: "Click an element on the page by CSS selector", inputSchema: { type: "object", properties: { selector: { type: "string", description: "CSS selector of the element to click" } }, required: ["selector"] } },
    { name: "get_element_text", description: "Get the text content of an element by CSS selector", inputSchema: { type: "object", properties: { selector: { type: "string", description: "CSS selector of the element" } }, required: ["selector"] }, annotations: { readOnlyHint: true } },
    { name: "get_element_html", description: "Get the outer HTML of an element by CSS selector", inputSchema: { type: "object", properties: { selector: { type: "string", description: "CSS selector of the element" } }, required: ["selector"] }, annotations: { readOnlyHint: true } },
    { name: "query_elements", description: "Query multiple elements and return summary info", inputSchema: { type: "object", properties: { selector: { type: "string", description: "CSS selector" }, limit: { type: "number", description: "Max results" } }, required: ["selector"] }, annotations: { readOnlyHint: true } },
    { name: "fill_input", description: "Fill an input field with a value", inputSchema: { type: "object", properties: { selector: { type: "string", description: "CSS selector" }, value: { type: "string", description: "New value" } }, required: ["selector", "value"] } },
    { name: "execute_js", description: "Execute JavaScript in the page context", inputSchema: { type: "object", properties: { expression: { type: "string", description: "JavaScript expression" } }, required: ["expression"] } },
    { name: "get_console_logs", description: "Get recent console log entries from the page", inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max entries" }, level: { type: "string", description: "Log level" } } }, annotations: { readOnlyHint: true } },
    { name: "screenshot_tab", description: "Take a screenshot of the visible tab", inputSchema: { type: "object", properties: { format: { type: "string", description: "Image format" } } }, annotations: { readOnlyHint: true } },
    { name: "navigate", description: "Navigate the current tab to a URL", inputSchema: { type: "object", properties: { url: { type: "string", description: "URL to navigate to" } }, required: ["url"] } },
  ];
}

function getAllTools(): PageToolSpec[] {
  const builtin = getEnabledBuiltinTools(getBuiltinTools(), pageToolPreferences);
  for (const [tabId, entries] of pageToolsByTab.entries()) {
    builtin.push(...getEnabledToolsForTab(entries, pageToolPreferences, tabId));
  }
  return builtin;
}

async function getActiveTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

function clearPageTools(tabId: number): void {
  if (!pageToolsByTab.has(tabId)) {
    return;
  }
  pageToolsByTab.delete(tabId);
  queueNotification(BRIDGE_METHODS.bridgePageToolsUnregistered, { tabId });
}

chrome.runtime.onMessage.addListener(
  createRuntimeListener(async (message, sender) => {
    await ensurePageToolPreferencesLoaded();

    switch (message.method) {
      case BRIDGE_METHODS.extensionStatusGet:
        return {
          connected: wsReady,
          wsUrl: ws?.url ?? null,
          pendingToolCalls: inFlightToolCalls.size,
          sessionId,
        };
      case BRIDGE_METHODS.extensionReconnect:
        clearReconnectTimer();
        reconnectAttempts = 0;
        wsReady = false;
        ws?.close();
        await connectWebSocket();
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
  void chrome.storage.local.get(MCP_WS_URL_KEY).then((data) => {
    if (!data[MCP_WS_URL_KEY]) {
      return chrome.storage.local.set({ [MCP_WS_URL_KEY]: DEFAULT_MCP_WS_URL });
    }
    return undefined;
  });
  void connectWebSocket();
});

chrome.runtime.onStartup.addListener(() => {
  void connectWebSocket();
});

void connectWebSocket();
void ensurePageToolPreferencesLoaded().then(() => {
  publishBuiltinTools();
  for (const tabId of pageToolsByTab.keys()) {
    publishPageToolsForTab(tabId);
  }
});

setInterval(() => {
  chrome.runtime.getPlatformInfo(() => undefined);
}, 25_000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
