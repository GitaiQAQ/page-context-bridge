import type {
  ContextNamespaceDescriptor,
  ContextResourceDescriptor,
  ContextResourcePayload,
  ContextSkillDescriptor,
  ContextSkillPrompt,
  PageContextManifest,
} from "@page-context/shared-protocol";

import type {
  PageContextBridgeHost,
  PageContextBridgeHostSource,
  PageContextBridgeLike,
  PageToolNamespace,
} from "./types";
import { safeRoute, toJsonResource } from "./utils";

const HOST_KEY = "__pageContextBridgeHost__";
const HOST_VERSION = "page-context-bridge-host/1.0.0";
const HOST_BRIDGE_MARKER = "__pageContextBridgeHostBridge__";
// The host will adopt existing bridges before taking over window to avoid losing capabilities due to unstable loading order.
const HOST_ADOPTED_SOURCE_ID = "adopted-window-bridge";
const HOST_DEFAULT_SCENE = "page-context-host-idle";

export const PAGE_CONTEXT_BRIDGE_HOST_READY_EVENT = "page-context-bridge-host:ready";

interface HostState {
  sourcesById: Map<string, SourceEntry>;
  diagnostics: string[];
  registerOrderCursor: number;
}

interface SourceEntry {
  sourceId: string;
  bridge: PageContextBridgeLike;
  priority: number;
  tags: string[];
  registeredAt: string;
  registerOrder: number;
}

interface PageContextBridgeHostWindow extends Window {
  __pageContextBridgeHost__?: PageContextBridgeHost;
  __pageContextBridge__?: PageContextBridgeLike;
  __pageContextTools__?: PageContextBridgeLike;
}

export function getOrCreatePageContextBridgeHost(win: Window, doc: Document): PageContextBridgeHost {
  const hostWindow = win as PageContextBridgeHostWindow;
  const existing = hostWindow[HOST_KEY];
  if (existing) {
    return existing;
  }

  const state: HostState = {
    sourcesById: new Map(),
    diagnostics: [],
    registerOrderCursor: 0,
  };
  const bridge = createHostBridge(win, doc, state);
  const host: PageContextBridgeHost = {
    version: HOST_VERSION,
    bridge,
    registerSource: (input) => registerSource(state, input.sourceId, input.bridge, input.priority, input.tags),
    unregisterSource: (sourceId) => {
      state.sourcesById.delete(sourceId);
    },
    listSources: () => getOrderedSources(state).map((entry) => toPublicSource(entry)),
    listDiagnostics: () => [...state.diagnostics],
  };

  // Adopt the old bridge first, then attach the host bridge to window to ensure protocol readability remains continuous during the transition.
  adoptExistingPageBridge(state, hostWindow);
  hostWindow[HOST_KEY] = host;
  attachHostBridge(hostWindow, bridge);
  dispatchHostReadyEvent(win, host);
  return host;
}

function createHostBridge(win: Window, _doc: Document, state: HostState): PageContextBridgeLike {
  const bridge: PageContextBridgeLike = {
    version: HOST_VERSION,
    listNamespaces: () => listNamespacesFromSources(state),
    getNamespace: (namespace) => getNamespaceFromSources(state, namespace),
    getScene: () => getSceneFromSources(state),
    listResources: () => listResourcesFromSources(state),
    readResource: (id) => readResourceFromSources(state, id),
    listSkills: () => listSkillsFromSources(state),
    getSkill: (id, input) => getSkillFromSources(state, id, input ?? {}),
    getManifest: () => buildHostManifest(win, state),
  };
  Object.defineProperty(bridge, HOST_BRIDGE_MARKER, { value: true, enumerable: false, configurable: false });
  return bridge;
}

function registerSource(
  state: HostState,
  sourceId: string,
  bridge: PageContextBridgeLike,
  priority = 100,
  tags: string[] = [],
): () => void {
  const previous = state.sourcesById.get(sourceId);
  if (previous && previous.bridge !== bridge) {
    state.diagnostics.push(`Source "${sourceId}" bridge replaced.`);
  }

  state.sourcesById.set(sourceId, {
    sourceId,
    bridge,
    priority,
    tags: uniqueStrings(tags),
    registeredAt: new Date().toISOString(),
    registerOrder: ++state.registerOrderCursor,
  });

  // If the registered business source is the same object as the one adopted by the host as a fallback, remove the fallback source to avoid duplicate exposure.
  if (sourceId !== HOST_ADOPTED_SOURCE_ID) {
    const adopted = state.sourcesById.get(HOST_ADOPTED_SOURCE_ID);
    if (adopted?.bridge === bridge) {
      state.sourcesById.delete(HOST_ADOPTED_SOURCE_ID);
      state.diagnostics.push(`Source "${sourceId}" replaced adopted bridge source.`);
    }
  }

  return () => {
    const current = state.sourcesById.get(sourceId);
    if (current?.bridge === bridge) {
      state.sourcesById.delete(sourceId);
    }
  };
}

function adoptExistingPageBridge(state: HostState, win: PageContextBridgeHostWindow): void {
  const existingBridge = win.__pageContextBridge__ ?? win.__pageContextTools__;
  if (!isPageContextBridgeLike(existingBridge) || isHostBridge(existingBridge)) {
    return;
  }

  registerSource(state, HOST_ADOPTED_SOURCE_ID, existingBridge, 10, ["adopted"]);
  state.diagnostics.push("Adopted existing page bridge before host attachment.");
}

function attachHostBridge(win: PageContextBridgeHostWindow, bridge: PageContextBridgeLike): void {
  win.__pageContextBridge__ = bridge;
  win.__pageContextTools__ = bridge;
}

function dispatchHostReadyEvent(win: Window, host: PageContextBridgeHost): void {
  try {
    win.dispatchEvent(
      new CustomEvent(PAGE_CONTEXT_BRIDGE_HOST_READY_EVENT, {
        detail: host,
      }),
    );
  } catch {
    // ignore
  }
}

function getOrderedSources(state: HostState): SourceEntry[] {
  // priority determines conflict resolution; registerOrder is used only for stable sorting to avoid result jitter.
  return Array.from(state.sourcesById.values()).sort((left, right) => {
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    return left.registerOrder - right.registerOrder;
  });
}

function toPublicSource(entry: SourceEntry): PageContextBridgeHostSource {
  return {
    sourceId: entry.sourceId,
    bridge: entry.bridge,
    priority: entry.priority,
    tags: [...entry.tags],
    registeredAt: entry.registeredAt,
  };
}

function listNamespacesFromSources(state: HostState): string[] {
  const deduped = new Set<string>();
  for (const source of getOrderedSources(state)) {
    for (const namespace of safeListNamespaces(source.bridge)) {
      if (!deduped.has(namespace)) {
        deduped.add(namespace);
      }
    }
  }
  return [...deduped];
}

function getNamespaceFromSources(state: HostState, namespace: string): PageToolNamespace | undefined {
  for (const source of getOrderedSources(state)) {
    const namespaceObject = safeGetNamespace(source.bridge, namespace);
    if (namespaceObject) {
      return namespaceObject;
    }
  }
  return undefined;
}

function getSceneFromSources(state: HostState): string {
  const scenes = uniqueStrings(getOrderedSources(state).map((source) => safeGetScene(source.bridge)).filter(Boolean));
  if (scenes.length === 0) {
    return HOST_DEFAULT_SCENE;
  }
  if (scenes.length === 1) {
    return scenes[0]!;
  }
  return `page-context-host-mixed:${scenes.join("+")}`;
}

function listResourcesFromSources(state: HostState): ContextResourceDescriptor[] {
  const deduped = new Map<string, ContextResourceDescriptor>();
  for (const source of getOrderedSources(state)) {
    for (const resource of safeListResources(source.bridge)) {
      if (!deduped.has(resource.id)) {
        deduped.set(resource.id, resource);
      }
    }
  }
  return [...deduped.values()];
}

function readResourceFromSources(state: HostState, id: string): ContextResourcePayload {
  for (const source of getOrderedSources(state)) {
    const hasResource = safeListResources(source.bridge).some((resource) => resource.id === id);
    if (hasResource) {
      return safeReadResource(source.bridge, id);
    }
  }
  return toJsonResource(id, { error: `Unknown resource id: ${id}` });
}

function listSkillsFromSources(state: HostState): ContextSkillDescriptor[] {
  const deduped = new Map<string, ContextSkillDescriptor>();
  for (const source of getOrderedSources(state)) {
    for (const skill of safeListSkills(source.bridge)) {
      if (!deduped.has(skill.id)) {
        deduped.set(skill.id, skill);
      }
    }
  }
  return [...deduped.values()];
}

function getSkillFromSources(
  state: HostState,
  id: string,
  input: Record<string, unknown>,
): ContextSkillPrompt | undefined {
  for (const source of getOrderedSources(state)) {
    const hasSkill = safeListSkills(source.bridge).some((skill) => skill.id === id);
    if (hasSkill) {
      return safeGetSkill(source.bridge, id, input);
    }
  }
  return undefined;
}

function buildHostManifest(win: Window, state: HostState): PageContextManifest {
  const namespaces = new Map<string, ContextNamespaceDescriptor>();
  for (const source of getOrderedSources(state)) {
    for (const descriptor of safeGetManifest(source.bridge).namespaces ?? []) {
      if (!namespaces.has(descriptor.namespace)) {
        namespaces.set(descriptor.namespace, descriptor);
      }
    }
  }

  return {
    version: HOST_VERSION,
    app: "page-context-bridge-host",
    route: safeRoute(win),
    scene: getSceneFromSources(state),
    namespaces: [...namespaces.values()],
    resources: listResourcesFromSources(state),
    skills: listSkillsFromSources(state),
    generatedAt: new Date().toISOString(),
  };
}

function safeListNamespaces(bridge: PageContextBridgeLike): string[] {
  try {
    return bridge.listNamespaces();
  } catch {
    return [];
  }
}

function safeGetNamespace(bridge: PageContextBridgeLike, namespace: string): PageToolNamespace | undefined {
  try {
    return bridge.getNamespace(namespace);
  } catch {
    return undefined;
  }
}

function safeGetScene(bridge: PageContextBridgeLike): string {
  try {
    return bridge.getScene();
  } catch {
    return "";
  }
}

function safeListResources(bridge: PageContextBridgeLike): ContextResourceDescriptor[] {
  try {
    return bridge.listResources();
  } catch {
    return [];
  }
}

function safeReadResource(bridge: PageContextBridgeLike, id: string): ContextResourcePayload {
  try {
    return bridge.readResource(id);
  } catch (error) {
    return toJsonResource(id, { error: error instanceof Error ? error.message : String(error) });
  }
}

function safeListSkills(bridge: PageContextBridgeLike): ContextSkillDescriptor[] {
  try {
    return bridge.listSkills();
  } catch {
    return [];
  }
}

function safeGetSkill(
  bridge: PageContextBridgeLike,
  id: string,
  input: Record<string, unknown>,
): ContextSkillPrompt | undefined {
  try {
    return bridge.getSkill(id, input);
  } catch {
    return undefined;
  }
}

function safeGetManifest(bridge: PageContextBridgeLike): PageContextManifest {
  try {
    return bridge.getManifest();
  } catch {
    return {
      version: bridge.version,
      app: "unknown",
      route: "/",
      scene: HOST_DEFAULT_SCENE,
      namespaces: [],
      resources: [],
      skills: [],
      generatedAt: new Date().toISOString(),
    };
  }
}

function uniqueStrings(values: string[]): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    deduped.add(value);
  }
  return [...deduped];
}

function isHostBridge(value: unknown): boolean {
  return Boolean((value as Record<string, unknown> | undefined)?.[HOST_BRIDGE_MARKER]);
}

function isPageContextBridgeLike(value: unknown): value is PageContextBridgeLike {
  const record = value as Partial<PageContextBridgeLike> | undefined;
  return Boolean(
    record &&
      typeof record.version === "string" &&
      typeof record.listNamespaces === "function" &&
      typeof record.getNamespace === "function" &&
      typeof record.getScene === "function" &&
      typeof record.listResources === "function" &&
      typeof record.readResource === "function" &&
      typeof record.listSkills === "function" &&
      typeof record.getSkill === "function" &&
      typeof record.getManifest === "function",
  );
}

declare global {
  interface Window {
    __pageContextBridge__?: PageContextBridgeLike;
    __pageContextTools__?: PageContextBridgeLike;
    __pageContextBridgeHost__?: PageContextBridgeHost;
  }
}
