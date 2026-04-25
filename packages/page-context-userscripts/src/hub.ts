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
  PageContextBridgeHost,
  PageToolInstance,
  PageToolNamespace,
  ToolInput,
  UserscriptBridgeAdapter,
  UserscriptBridgeAdapterFactory,
} from "./types";
import { PAGE_CONTEXT_BRIDGE_HOST_READY_EVENT } from "./bridge-host";
import { safeRoute, toJsonResource } from "./utils";

const HUB_VERSION = "userscript-hub/1.0.0";
const HUB_SCENE = "userscript-adapter-hub";
const HUB_KEY = "__pageContextUserscriptHub__";
const HUB_SOURCE_ID = "userscript-adapter-hub";

export interface BrowserHost {
  window: Window;
  document: Document;
}

interface HubState {
  adaptersByNamespace: Map<string, UserscriptBridgeAdapter>;
  adapterOrder: string[];
  diagnostics: string[];
  bridgeHost?: PageContextBridgeHost;
  unregisterHubSource?: () => void;
}

export interface UserscriptBridgeHub {
  bridge: PageContextBridgeLike;
  registerAdapter(adapter: UserscriptBridgeAdapter): void;
  listAdapterIds(): string[];
  listDiagnostics(): string[];
  reportDiagnostic(message: string): void;
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
    // Userscripts are expected to rely on the extension injecting the host. Do not auto-install a host here.
    bridgeHost: getPageContextBridgeHost(win),
    unregisterHubSource: undefined,
  };
  const bridge = createHubBridge(win, doc, state);
  registerHubSourceOnHost(state, bridge);
  // If the host is installed by something else later (e.g. extension main-world injection), re-register on the new host.
  win.addEventListener(PAGE_CONTEXT_BRIDGE_HOST_READY_EVENT, (event) => {
    const host = (event as CustomEvent<unknown>).detail;
    if (!isPageContextBridgeHost(host)) {
      return;
    }
    state.bridgeHost = host;
    registerHubSourceOnHost(state, bridge);
  });
  const hub: UserscriptBridgeHub = {
    bridge,
    registerAdapter: (adapter) => {
      try {
        registerAdapterOnHub(adapter, bridge, state);
      } catch (error) {
        state.diagnostics.push(
          `Adapter "${adapter.adapterId}" registration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    listAdapterIds: () => [...state.adapterOrder],
    listDiagnostics: () => [...state.diagnostics, ...(state.bridgeHost?.listDiagnostics() ?? [])],
    reportDiagnostic: (message) => {
      if (message) {
        state.diagnostics.push(message);
      }
    },
  };

  (win as WindowWithUserscriptHub)[HUB_KEY] = hub;
  return hub;
}

export function autoRegisterUserscriptAdapter(
  createAdapter: UserscriptBridgeAdapterFactory,
  host: unknown = globalThis,
): UserscriptBridgeHub | undefined {
  const resolved = resolveBrowserHost(host);
  if (!resolved) {
    return undefined;
  }
  const hub = getOrCreateUserscriptBridgeHub(resolved.window, resolved.document);
  try {
    hub.registerAdapter(createAdapter(resolved.window, resolved.document));
  } catch (error) {
    hub.reportDiagnostic(
      `autoRegisterUserscriptAdapter failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return hub;
}

function registerAdapterOnHub(
  adapter: UserscriptBridgeAdapter,
  bridge: PageContextBridgeLike,
  state: HubState,
): void {
  const namespace = adapter.namespace.namespace;
  const existing = state.adaptersByNamespace.get(namespace);
  if (existing && existing.adapterId !== adapter.adapterId) {
    state.diagnostics.push(`Namespace "${namespace}" already registered by "${existing.adapterId}", replaced by "${adapter.adapterId}".`);
  }

  state.adaptersByNamespace.set(namespace, adapter);
  if (!state.adapterOrder.includes(adapter.adapterId)) {
    state.adapterOrder.push(adapter.adapterId);
  }
  registerHubSourceOnHost(state, bridge);
}

function registerHubSourceOnHost(state: HubState, bridge: PageContextBridgeLike): void {
  const bridgeHost = state.bridgeHost;
  if (!bridgeHost) {
    return;
  }
  state.unregisterHubSource?.();
  // The userscript hub always registers via the host and does not directly manipulate window.__pageContextBridge__ to avoid multi-source overwrites.
  state.unregisterHubSource = bridgeHost.registerSource({
    sourceId: HUB_SOURCE_ID,
    bridge,
    priority: 80,
    tags: ["userscript", "hub"],
  });
}

function createHubBridge(win: Window, doc: Document, state: HubState): PageContextBridgeLike {
  return {
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

function isBrowserHost(value: unknown): value is BrowserHost {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const host = value as Partial<BrowserHost>;
  return typeof host.window !== "undefined" && typeof host.document !== "undefined";
}

function resolveBrowserHost(host: unknown): BrowserHost | undefined {
  if (isBrowserHost(host)) {
    return host;
  }

  // Userscript managers (Tampermonkey/Violentmonkey) may expose the real page window via unsafeWindow.
  const unsafeWindowCandidate = (globalThis as unknown as Record<string, unknown>).unsafeWindow;
  if (unsafeWindowCandidate && typeof unsafeWindowCandidate === "object") {
    const win = unsafeWindowCandidate as Window;
    const doc = (win as unknown as { document?: unknown }).document;
    if (doc && typeof doc === "object") {
      return { window: win, document: doc as Document };
    }
  }

  return undefined;
}

interface WindowWithUserscriptHub extends Window {
  __pageContextUserscriptHub__?: UserscriptBridgeHub;
  __pageContextBridgeHost__?: PageContextBridgeHost;
}

declare global {
  interface Window {
    __pageContextUserscriptHub__?: UserscriptBridgeHub;
  }
}

function getPageContextBridgeHost(win: Window): PageContextBridgeHost | undefined {
  const host = (win as WindowWithUserscriptHub).__pageContextBridgeHost__;
  return isPageContextBridgeHost(host) ? host : undefined;
}

function isPageContextBridgeHost(value: unknown): value is PageContextBridgeHost {
  const record = value as Partial<PageContextBridgeHost> | undefined;
  return Boolean(record && typeof record.registerSource === "function");
}
