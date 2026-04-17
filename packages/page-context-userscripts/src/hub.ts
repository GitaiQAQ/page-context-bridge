import type {
  ContextNamespaceDescriptor,
  ContextResourceDescriptor,
  ContextResourcePayload,
  ContextSkillDescriptor,
  ContextSkillPrompt,
  PageContextManifest,
} from "@page-context/shared-protocol";

import type {
  PageContextBridgeLike,
  PageToolInstance,
  PageToolNamespace,
  ToolInput,
  UserscriptBridgeAdapter,
  UserscriptBridgeAdapterFactory,
} from "./types";
import { safeRoute, toJsonResource } from "./utils";

const HUB_VERSION = "userscript-hub/1.0.0";
const HUB_SCENE = "userscript-adapter-hub";
const HUB_KEY = "__pageContextUserscriptHub__";
const HUB_BRIDGE_MARKER = "__pageContextUserscriptHubBridge__";

export interface BrowserHost {
  window: Window;
  document: Document;
}

interface HubState {
  adaptersByNamespace: Map<string, UserscriptBridgeAdapter>;
  adapterOrder: string[];
  diagnostics: string[];
}

export interface UserscriptBridgeHub {
  bridge: PageContextBridgeLike;
  registerAdapter(adapter: UserscriptBridgeAdapter): void;
  listAdapterIds(): string[];
  listDiagnostics(): string[];
}

export function getOrCreateUserscriptBridgeHub(win: Window, doc: Document): UserscriptBridgeHub {
  const existing = (win as WindowWithUserscriptHub)[HUB_KEY];
  if (existing) {
    return existing;
  }

  const state: HubState = {
    adaptersByNamespace: new Map(),
    adapterOrder: [],
    diagnostics: [],
  };
  const bridge = createHubBridge(win, doc, state);
  const hub: UserscriptBridgeHub = {
    bridge,
    registerAdapter: (adapter) => registerAdapterOnHub(win, adapter, bridge, state),
    listAdapterIds: () => [...state.adapterOrder],
    listDiagnostics: () => [...state.diagnostics],
  };

  (win as WindowWithUserscriptHub)[HUB_KEY] = hub;
  return hub;
}

export function autoRegisterUserscriptAdapter(
  createAdapter: UserscriptBridgeAdapterFactory,
  host: unknown = globalThis,
): UserscriptBridgeHub | undefined {
  if (!isBrowserHost(host)) {
    return undefined;
  }
  const hub = getOrCreateUserscriptBridgeHub(host.window, host.document);
  hub.registerAdapter(createAdapter(host.window, host.document));
  return hub;
}

function registerAdapterOnHub(win: Window, adapter: UserscriptBridgeAdapter, bridge: PageContextBridgeLike, state: HubState): void {
  const namespace = adapter.namespace.namespace;
  const existing = state.adaptersByNamespace.get(namespace);
  if (existing && existing.adapterId !== adapter.adapterId) {
    state.diagnostics.push(`Namespace "${namespace}" already registered by "${existing.adapterId}", replaced by "${adapter.adapterId}".`);
  }

  state.adaptersByNamespace.set(namespace, adapter);
  if (!state.adapterOrder.includes(adapter.adapterId)) {
    state.adapterOrder.push(adapter.adapterId);
  }
  attachHubBridgeIfAllowed(win, bridge, state.diagnostics);
}

function attachHubBridgeIfAllowed(win: Window, bridge: PageContextBridgeLike, diagnostics: string[]): void {
  const target = win as WindowWithBridge;
  const existingBridge = target.__pageContextBridge__;

  if (!existingBridge || isHubBridge(existingBridge)) {
    target.__pageContextBridge__ = bridge;
    target.__pageContextTools__ = bridge;
    return;
  }

  // 页面已有自定义 bridge 时不强行覆盖，避免破坏原站逻辑。
  diagnostics.push("Detected existing window.__pageContextBridge__; userscript hub keeps page bridge untouched.");
}

function createHubBridge(win: Window, doc: Document, state: HubState): PageContextBridgeLike {
  const bridge: PageContextBridgeLike = {
    version: HUB_VERSION,
    listNamespaces: () => Array.from(state.adaptersByNamespace.keys()),
    getNamespace: (namespace) => getNamespaceProxy(state, namespace),
    getScene: () => getSceneFromAdapters(state),
    listResources: () => collectResourceDescriptors(state),
    readResource: (id) => readResourceById(state, id),
    listSkills: () => collectSkillDescriptors(state),
    getSkill: (id, input) => getSkillById(state, id, input ?? {}),
    getManifest: () => buildManifest(win, doc, state),
  };
  Object.defineProperty(bridge, HUB_BRIDGE_MARKER, { value: true, enumerable: false, configurable: false });
  return bridge;
}

function getNamespaceProxy(state: HubState, namespace: string): PageToolNamespace | undefined {
  const adapter = state.adaptersByNamespace.get(namespace);
  if (!adapter) {
    return undefined;
  }

  return {
    namespace,
    listInstances: () => adapter.listInstances().map((instance) => instance.instanceId),
    getInstance: (instanceId) => adapter.listInstances().find((instance) => instance.instanceId === instanceId),
  };
}

function getSceneFromAdapters(state: HubState): string {
  const hints = Array.from(state.adaptersByNamespace.values())
    .map((adapter) => adapter.getSceneHint?.())
    .filter((item): item is string => typeof item === "string" && item.length > 0);
  if (hints.length === 0) {
    return HUB_SCENE;
  }
  return `${HUB_SCENE}:${hints.join("+")}`;
}

function collectNamespaceDescriptors(state: HubState): ContextNamespaceDescriptor[] {
  return Array.from(state.adaptersByNamespace.values()).map((adapter) => adapter.namespace);
}

function collectResourceDescriptors(state: HubState): ContextResourceDescriptor[] {
  return Array.from(state.adaptersByNamespace.values()).flatMap((adapter) => adapter.listResources());
}

function readResourceById(state: HubState, id: string): ContextResourcePayload {
  const namespace = extractNamespaceFromId(id);
  const adapter = namespace ? state.adaptersByNamespace.get(namespace) : undefined;
  if (!adapter) {
    return toJsonResource(id, { error: `Unknown resource id: ${id}` });
  }
  return adapter.readResource(id);
}

function collectSkillDescriptors(state: HubState): ContextSkillDescriptor[] {
  return Array.from(state.adaptersByNamespace.values()).flatMap((adapter) => adapter.listSkills());
}

function getSkillById(state: HubState, id: string, input: ToolInput): ContextSkillPrompt | undefined {
  const namespace = extractNamespaceFromId(id);
  const adapter = namespace ? state.adaptersByNamespace.get(namespace) : undefined;
  if (!adapter) {
    return undefined;
  }
  return adapter.getSkill(id, input);
}

function buildManifest(win: Window, _doc: Document, state: HubState): PageContextManifest {
  return {
    version: HUB_VERSION,
    app: "userscript-adapter-hub",
    route: safeRoute(win),
    scene: getSceneFromAdapters(state),
    namespaces: collectNamespaceDescriptors(state),
    resources: collectResourceDescriptors(state),
    skills: collectSkillDescriptors(state),
    generatedAt: new Date().toISOString(),
  };
}

function extractNamespaceFromId(id: string): string | undefined {
  const dotIndex = id.indexOf(".");
  if (dotIndex < 0) {
    return undefined;
  }
  return id.slice(0, dotIndex);
}

function isHubBridge(value: unknown): boolean {
  return Boolean((value as Record<string, unknown> | undefined)?.[HUB_BRIDGE_MARKER]);
}

function isBrowserHost(value: unknown): value is BrowserHost {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const host = value as Partial<BrowserHost>;
  return typeof host.window !== "undefined" && typeof host.document !== "undefined";
}

interface WindowWithBridge extends Window {
  __pageContextBridge__?: PageContextBridgeLike;
  __pageContextTools__?: PageContextBridgeLike;
}

interface WindowWithUserscriptHub extends WindowWithBridge {
  __pageContextUserscriptHub__?: UserscriptBridgeHub;
}

declare global {
  interface Window {
    __pageContextBridge__?: PageContextBridgeLike;
    __pageContextTools__?: PageContextBridgeLike;
    __pageContextUserscriptHub__?: UserscriptBridgeHub;
  }
}
