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
  type FeedbackAnnotationUpdateParams,
  type FeedbackStateDeltaParams,
  type FeedbackStateSnapshotParams,
  type PageContextManifest,
  RpcProtocolError,
  RPC_ERROR_CODES,
} from "@page-context/shared-protocol";
import { collectBridgeControlToolSpecs, listBuiltinRuntimeToolPreferenceKeys } from "@page-context/builtin-tools";

import { connectWebSocket, forceReconnect, getWsReady, getSessionId, initDefaultWsUrl, log, queueNotification, requestBridge } from "./bg-ws-connection";
import { captureActiveTabFeedbackContext, type ActiveTabFeedbackContext } from "./bg-feedback-context";
import { enrichUiAnchorReactMetaInMainWorld } from "./bg-react-meta";
import { discoverPageToolsInTab, getRawPageContextManifest, getPageContextSkill, readPageContextResource, sleep } from "./bg-page-context";
import { executeToolCall, getBuiltinToolDefinitions } from "./bg-tool-executor";
import { buildContextManifestFilterDebug } from "./context-manifest-filter-debug";
import { flattenPageTools, mergePageToolEntry, normalizePageToolEntries, type PageToolEntry, type PageToolSpec } from "./page-tool-registry";
import { buildToolTree, getEnabledBuiltinTools, getEnabledToolsForTab, isToolEnabled, setScopeEnabled, type PageToolPreferences } from "./page-tool-visibility";
import { createRuntimeListener } from "./runtime-rpc";

const PAGE_TOOL_PREFERENCES_KEY = "pageToolPreferences";

type JsonRecord = Record<string, unknown>;
type FeedbackCreatePayloadFromUi = Pick<FeedbackAnnotationCreateParams, "body" | "priority" | "selectedText" | "uiAnchor"> & {
  /**
   * 给 UI 壳最小 fork 的字段别名做兼容，避免前后端联调卡在命名差异上。
   * 后续若统一字段，可直接删掉这个别名映射。
   */
  anchor?: FeedbackAnnotationCreateParams["uiAnchor"];
};
type FeedbackUpdatePayloadFromUi = Pick<FeedbackAnnotationUpdateParams, "annotationId" | "body" | "priority">;

let pageToolPreferences: PageToolPreferences = {};
let pageToolPreferencesReady: Promise<void> | null = null;

const inFlightToolCalls = new Map<string, string>();
const pageToolsByTab = new Map<number, PageToolEntry[]>();
const discoveryInFlight = new Map<number, Promise<PageToolEntry[]>>();
const tabReloadDiscoveryInFlight = new Map<number, Promise<void>>();

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
  const runtimeBuiltins = getBuiltinToolDefinitions().map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    annotations: def.annotations,
  }));
  const bridgeControlBuiltins = collectBridgeControlToolSpecs().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    _bridgeControlTool: true,
  }));

  // runtime + control 工具统一进入 builtin 模型；同名去重时优先保留 runtime 定义。
  const deduped = new Map<string, PageToolSpec>();
  for (const tool of [...runtimeBuiltins, ...bridgeControlBuiltins]) {
    if (!deduped.has(tool.name)) {
      deduped.set(tool.name, tool);
    }
  }
  return Array.from(deduped.values());
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
  const enabledBuiltinToolNames = new Set(
    getEnabledBuiltinTools(getBuiltinTools(), pageToolPreferences)
      .flatMap((tool) => listBuiltinRuntimeToolPreferenceKeys(tool.name)),
  );
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
  // Cleanup action remains idempotent: even if local cache is missing, actively notify bridge to delete tab tools.
  // This avoids the issue where service worker restart causes local state loss but bridge retains old tools.
  pageToolsByTab.delete(tabId);
  queueNotification(BRIDGE_METHODS.bridgePageToolsUnregistered, { tabId });
}

async function discoverPageToolsAfterTabReload(tabId: number): Promise<void> {
  const existing = tabReloadDiscoveryInFlight.get(tabId);
  if (existing) {
    return await existing;
  }

  const discoveryTask = (async () => {
    // 页面刷新后，页面脚本重建 bridge 可能晚于 tabs.onUpdated("complete")。
    // 这里做一次延迟补偿发现，减少“必须手动刷新 sidepanel 才能看到工具”的情况。
    const reloadDelays = [0, 2_000];
    for (const delay of reloadDelays) {
      if (delay > 0) {
        await sleep(delay);
      }
      const entries = await discoverPageToolsForTab(tabId, true);
      if (entries.length > 0) {
        return;
      }
    }
  })();

  tabReloadDiscoveryInFlight.set(tabId, discoveryTask);
  try {
    await discoveryTask;
  } finally {
    tabReloadDiscoveryInFlight.delete(tabId);
  }
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

function buildFeedbackAnnotationCreateParams(
  payload: FeedbackCreatePayloadFromUi,
  context: ActiveTabFeedbackContext,
): FeedbackAnnotationCreateParams {
  // 这里作为 background 的轻量 adapter 边界：
  // 1) 统一 body/选区清洗规则
  // 2) 接住 UI 壳新增字段（uiAnchor/anchor）并映射到 bridge 协议
  // 3) 后续动作链路要扩展字段时，只改这一处即可
  return {
    body: payload.body.trim(),
    priority: payload.priority,
    tabId: context.tabId,
    url: context.url,
    title: context.title,
    selectedText: payload.selectedText?.trim() || context.selectedText,
    uiAnchor: normalizeFeedbackUiAnchor(payload.uiAnchor ?? payload.anchor),
  };
}

function buildFeedbackAnnotationUpdateParams(payload: FeedbackUpdatePayloadFromUi): FeedbackAnnotationUpdateParams {
  return {
    annotationId: payload.annotationId.trim(),
    body: payload.body.trim(),
    priority: payload.priority,
  };
}

function normalizeFeedbackUiAnchor(anchor: FeedbackAnnotationCreateParams["uiAnchor"]): FeedbackAnnotationCreateParams["uiAnchor"] {
  if (!anchor) {
    return undefined;
  }

  const framePath = Array.isArray(anchor.framePath)
    ? anchor.framePath.filter((item) => Number.isInteger(item) && item >= 0)
    : undefined;
  const textQuote = anchor.textQuote?.trim();

  const normalized: FeedbackAnnotationCreateParams["uiAnchor"] = {
    elementId: anchor.elementId?.trim() || undefined,
    cssSelector: anchor.cssSelector?.trim() || undefined,
    xpath: anchor.xpath?.trim() || undefined,
    textQuote: textQuote || undefined,
    framePath: framePath?.length ? framePath : undefined,
    rect: anchor.rect,
    textRange: anchor.textRange,
    meta: anchor.meta && Object.keys(anchor.meta).length > 0 ? anchor.meta : undefined,
  };

  // 只要任意定位信号存在就保留；全部为空时回退为 undefined，避免污染存储。
  if (
    normalized.elementId ||
    normalized.cssSelector ||
    normalized.xpath ||
    normalized.textQuote ||
    normalized.framePath ||
    normalized.rect ||
    normalized.textRange ||
    normalized.meta
  ) {
    return normalized;
  }
  return undefined;
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

async function ensureAgentationMainOnTab(tabId: number, frameId?: number): Promise<{ ok: true }> {
  await chrome.scripting.executeScript({
    target: typeof frameId === "number" ? { tabId, frameIds: [frameId] } : { tabId },
    world: "MAIN",
    files: ["agentation-main.js"],
  });
  return { ok: true };
}

async function ensureAgentationMainOnSenderTab(sender: chrome.runtime.MessageSender): Promise<{ ok: true }> {
  const tabId = sender.tab?.id;
  if (!tabId) {
    throw new Error("No sender tab available for Agentation MAIN world injection.");
  }

  const frameId = typeof sender.frameId === "number" ? sender.frameId : 0;
  return await ensureAgentationMainOnTab(tabId, frameId);
}

function getMainWorldInjectionTarget(params: unknown): { tabId: number; frameId?: number } {
  const payload = params as { tabId?: number; frameId?: number } | null | undefined;
  const tabId = Number(payload?.tabId ?? 0);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new Error("tabId must be a positive integer");
  }

  if (payload?.frameId == null) {
    return { tabId };
  }
  if (!Number.isInteger(payload.frameId) || payload.frameId < 0) {
    throw new Error("frameId must be a non-negative integer");
  }
  // WS 入口允许不传 frameId，表示让 Chrome 在目标 tab 的可注入 frame 上执行默认注入。
  return { tabId, frameId: payload.frameId };
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

function buildExtensionStatusResponse() {
  return {
    connected: getWsReady(),
    wsUrl: null,
    pendingToolCalls: inFlightToolCalls.size,
    sessionId: getSessionId(),
  };
}

async function handleExtensionReconnect(): Promise<{ ok: true }> {
  await forceReconnect(onToolCall, onToolsList, onTabsList, onBridgeWsExtensionRequest);
  return { ok: true };
}

function handleExtensionPageToolsGet(params: unknown): { tools: PageToolSpec[] } {
  const tabId = Number((params as { tabId?: number })?.tabId ?? 0);
  return { tools: flattenPageTools(pageToolsByTab.get(tabId)) };
}

async function handleExtensionPageToolsRefresh(params: unknown): Promise<{ tools: PageToolSpec[] }> {
  const tabId = Number((params as { tabId?: number })?.tabId ?? 0);
  if (!tabId) {
    throw new Error("No tabId provided");
  }
  // refresh 与 discover 复用同一条发现链路，避免两套逻辑漂移。
  const entries = await discoverPageToolsForTab(tabId, true);
  return { tools: flattenPageTools(entries) };
}

async function handleExtensionContextManifestGet(params: unknown) {
  const tabId = Number((params as { tabId?: number })?.tabId ?? 0);
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

async function handleExtensionContextResourceRead(params: unknown) {
  const payload = params as { tabId?: number; resourceId?: string };
  const tabId = Number(payload.tabId ?? 0);
  if (!tabId || !payload.resourceId) {
    throw new Error("tabId and resourceId are required");
  }
  return await readPageContextResource(tabId, payload.resourceId);
}

async function handleExtensionContextSkillGet(params: unknown) {
  const payload = params as { tabId?: number; skillId?: string; input?: JsonRecord };
  const tabId = Number(payload.tabId ?? 0);
  if (!tabId || !payload.skillId) {
    throw new Error("tabId and skillId are required");
  }
  return { prompt: await getPageContextSkill(tabId, payload.skillId, payload.input) };
}

async function handleExtensionPageToolsSetEnabled(params: unknown) {
  const payload = params as { root?: "builtin" | "page"; tabId?: number; namespace?: string; instanceId?: string; toolName?: string; enabled: boolean };
  const pageEntries = payload.root === "builtin" || payload.tabId == null
    ? undefined
    : (pageToolsByTab.get(payload.tabId) ?? []).filter((entry) => {
        if (payload.namespace && entry.namespace !== payload.namespace) {
          return false;
        }
        if (payload.instanceId && entry.instanceId !== payload.instanceId) {
          return false;
        }
        return true;
      });
  pageToolPreferences = setScopeEnabled(pageToolPreferences, payload, payload.enabled, {
    builtinTools: payload.root === "builtin" ? getBuiltinTools() : undefined,
    pageEntries,
  });
  await persistPageToolPreferences();
  if (payload.root === "builtin") {
    publishBuiltinTools();
  } else if (payload.tabId != null) {
    publishPageToolsForTab(payload.tabId);
  }
  return await buildPageToolsTreeResponse();
}

async function handleExtensionToolDebugCall(params: unknown) {
  const payload = params as { toolName?: string; args?: JsonRecord; tabId?: number };
  if (!payload.toolName) {
    throw new Error("No toolName provided");
  }

  try {
    // 这里保留 raw debug 能力；是否允许调用由 bridge provider 侧做“只读/启用”门禁。
    const result = await executeToolCall(payload.toolName, payload.args ?? {}, payload.tabId);
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function onBridgeWsExtensionRequest(method: string, params: unknown): Promise<unknown> {
  // 这条入口只处理 bridge 通过 WS 主动 request 的 extension 控制方法。
  // 统一复用 runtime 分支里的同名 handler，确保 WS 与 runtime 行为一致。
  await ensurePageToolPreferencesLoaded();

  switch (method) {
    case BRIDGE_METHODS.extensionStatusGet:
      return buildExtensionStatusResponse();
    case BRIDGE_METHODS.extensionReconnect:
      return await handleExtensionReconnect();
    case BRIDGE_METHODS.extensionPageToolsGet:
      return handleExtensionPageToolsGet(params);
    case BRIDGE_METHODS.extensionPageToolsTreeGet:
      return await buildPageToolsTreeResponse();
    case BRIDGE_METHODS.extensionPageToolsDiscover:
    case BRIDGE_METHODS.extensionPageToolsRefresh:
      return await handleExtensionPageToolsRefresh(params);
    case BRIDGE_METHODS.extensionPageToolsSetEnabled:
      return await handleExtensionPageToolsSetEnabled(params);
    case BRIDGE_METHODS.extensionMainWorldHostEnsure: {
      const target = getMainWorldInjectionTarget(params);
      return await ensureMainWorldBridgeHostOnTab(target.tabId, target.frameId);
    }
    case BRIDGE_METHODS.extensionAgentationMainEnsure: {
      const target = getMainWorldInjectionTarget(params);
      return await ensureAgentationMainOnTab(target.tabId, target.frameId);
    }
    case BRIDGE_METHODS.extensionContextManifestGet:
      return await handleExtensionContextManifestGet(params);
    case BRIDGE_METHODS.extensionContextResourceRead:
      return await handleExtensionContextResourceRead(params);
    case BRIDGE_METHODS.extensionContextSkillGet:
      return await handleExtensionContextSkillGet(params);
    case BRIDGE_METHODS.extensionToolDebugCall:
      return await handleExtensionToolDebugCall(params);
    default:
      throw new RpcProtocolError(RPC_ERROR_CODES.methodNotFound, `Unhandled WS method: ${method}`);
  }
}

// ── Extension event listeners ──

chrome.runtime.onMessage.addListener(
  createRuntimeListener(async (message, sender) => {
    await ensurePageToolPreferencesLoaded();

    switch (message.method) {
      case BRIDGE_METHODS.extensionStatusGet:
        return buildExtensionStatusResponse();
      case BRIDGE_METHODS.extensionReconnect:
        return await handleExtensionReconnect();
      case BRIDGE_METHODS.extensionPageToolsGet:
        return handleExtensionPageToolsGet(message.params);
      case BRIDGE_METHODS.extensionPageToolsTreeGet:
        return await buildPageToolsTreeResponse();
      case BRIDGE_METHODS.extensionPageToolsDiscover:
      case BRIDGE_METHODS.extensionPageToolsRefresh:
        return await handleExtensionPageToolsRefresh(message.params);
      case BRIDGE_METHODS.extensionContextManifestGet:
        return await handleExtensionContextManifestGet(message.params);
      case BRIDGE_METHODS.extensionContextResourceRead:
        return await handleExtensionContextResourceRead(message.params);
      case BRIDGE_METHODS.extensionContextSkillGet:
        return await handleExtensionContextSkillGet(message.params);
      case BRIDGE_METHODS.extensionFeedbackStateSnapshot: {
        const payload = (message.params ?? {}) as FeedbackStateSnapshotParams;
        const params: FeedbackStateSnapshotParams = { ...payload };
        if (params.tabId == null && !params.sessionId) {
          // 优先使用 sender.tab；仅在 sidepanel 无 sender.tab 时回退 active tab。
          const context = await captureActiveTabFeedbackContext(sender).catch(() => null);
          params.tabId = context?.tabId;
        }
        return await requestBridgeMethod(BRIDGE_METHODS.feedbackStateSnapshot, params);
      }
      case BRIDGE_METHODS.extensionFeedbackStateDelta: {
        const payload = (message.params ?? {}) as FeedbackStateDeltaParams;
        const afterSeq = Number(payload.afterSeq ?? 0);
        if (!Number.isFinite(afterSeq) || afterSeq < 0) {
          throw new Error("Feedback delta afterSeq must be a non-negative number");
        }
        const params: FeedbackStateDeltaParams = {
          ...payload,
          afterSeq,
        };
        return await requestBridgeMethod(BRIDGE_METHODS.feedbackStateDelta, params);
      }
      case BRIDGE_METHODS.extensionFeedbackAnnotationCreate: {
        const payload = (message.params ?? {}) as FeedbackCreatePayloadFromUi;
        if (!payload.body?.trim()) {
          throw new Error("Feedback body is required");
        }
        // content-script 的 UI 标注必须绑定消息发送者 tab，避免串到当前活动 tab。
        const context = await captureActiveTabFeedbackContext(sender);
        // 只在 uiAnchor 路径做 MAIN world 补采集：补到就带上，失败就保持原样。
        if (payload.uiAnchor) {
          payload.uiAnchor = await enrichUiAnchorReactMetaInMainWorld(context.tabId, payload.uiAnchor);
        }
        return await requestBridgeMethod(BRIDGE_METHODS.feedbackAnnotationCreate, buildFeedbackAnnotationCreateParams(payload, context));
      }
      case BRIDGE_METHODS.extensionFeedbackAnnotationUpdate: {
        const payload = (message.params ?? {}) as FeedbackUpdatePayloadFromUi;
        if (!payload.annotationId?.trim()) {
          throw new Error("Feedback annotationId is required");
        }
        if (!payload.body?.trim()) {
          throw new Error("Feedback body is required");
        }
        return await requestBridgeMethod(BRIDGE_METHODS.feedbackAnnotationUpdate, buildFeedbackAnnotationUpdateParams(payload));
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
        // 与 create/update 对齐：在 extension 边界先拦截空 annotationId，避免无效 bridge 往返。
        if (!payload.annotationId?.trim()) {
          throw new Error("Feedback annotationId is required");
        }
        payload.annotationId = payload.annotationId.trim();
        if (payload.dismissReason) {
          payload.dismissReason = payload.dismissReason.trim() || undefined;
        }
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
      case BRIDGE_METHODS.extensionPageToolsSetEnabled:
        return await handleExtensionPageToolsSetEnabled(message.params);
      case BRIDGE_METHODS.extensionToolDebugCall:
        return await handleExtensionToolDebugCall(message.params);
      case BRIDGE_METHODS.extensionMainWorldHostEnsure:
        return await ensureMainWorldBridgeHostOnSenderTab(sender);
      case BRIDGE_METHODS.extensionAgentationMainEnsure:
        return await ensureAgentationMainOnSenderTab(sender);
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
  if (changeInfo.status === "loading") {
    // 同 URL 刷新也会触发 loading，但 changeInfo.url 可能为空。
    // 因此只要进入 loading 就清理，确保后续一定走“重新发现 -> 重新发布”。
    tabReloadDiscoveryInFlight.delete(tabId);
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
    void discoverPageToolsAfterTabReload(tabId).catch((error) => log("Discovery on tab update failed", error));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabReloadDiscoveryInFlight.delete(tabId);
  clearPageTools(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  void initDefaultWsUrl();
  void connectWebSocket(onToolCall, onToolsList, onTabsList, onBridgeWsExtensionRequest);
});

chrome.runtime.onStartup.addListener(() => {
  void connectWebSocket(onToolCall, onToolsList, onTabsList, onBridgeWsExtensionRequest);
});

void connectWebSocket(onToolCall, onToolsList, onTabsList, onBridgeWsExtensionRequest);
void ensurePageToolPreferencesLoaded().then(() => {
  publishBuiltinTools();
  for (const tabId of pageToolsByTab.keys()) {
    publishPageToolsForTab(tabId);
  }
});

setInterval(() => {
  chrome.runtime.getPlatformInfo(() => undefined);
}, 25_000);
