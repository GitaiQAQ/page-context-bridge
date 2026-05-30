/**
 * Installs the page context bridge host into the main world (window).
 *
 * Self-contained — only uses `window` global and standard JS APIs.
 * No external dependencies; safe to move to its own module.
 */

export type MainWorldBridgeHostInstaller = () => void;

/** Shape of a page-context bridge that the host delegates to. */
interface PageContextBridge {
  version: string;
  listNamespaces(): string[];
  getNamespace(namespace: string): unknown;
  getScene(): string;
  listResources(): ResourceDescriptor[];
  readResource(id: string): ResourcePayload;
  listSkills(): SkillDescriptor[];
  getSkill(id: string, input?: Record<string, unknown>): unknown;
  getManifest(): ManifestDescriptor | null;
}

interface ResourceDescriptor {
  id: string;
  [key: string]: unknown;
}

interface ResourcePayload {
  id: string;
  mimeType: string;
  text: string;
}

interface SkillDescriptor {
  id: string;
  [key: string]: unknown;
}

interface ManifestDescriptor {
  namespaces: NamespaceDescriptor[];
  [key: string]: unknown;
}

interface NamespaceDescriptor {
  namespace: string;
  [key: string]: unknown;
}

interface LegacyPageContextBridge {
  version?: unknown;
  namespace?: unknown;
  instanceId?: unknown;
  getManifest?: () => ManifestDescriptor | null;
  listTools?: () => unknown[];
  callTool?: (name: string, args?: Record<string, unknown>) => unknown;
  readResource?: (id: string) => ResourcePayload;
  getSkill?: (id: string, input?: Record<string, unknown>) => unknown;
}

export const installPageContextBridgeHostInMainWorld: MainWorldBridgeHostInstaller = (): void => {
  const HOST_KEY = '__pageContextBridgeHost__';
  const BRIDGE_KEY = '__pageContextBridge__';
  const TOOLS_KEY = '__pageContextTools__';
  const RAW_BRIDGE_KEY = '__pageContextBridgeRaw__';
  const HOST_READY_EVENT = 'page-context-bridge-host:ready';
  const HOST_DEFAULT_SCENE = 'page-context-host-idle';
  const HOST_ADOPTED_SOURCE_ID = 'adopted-window-bridge';
  const HOST_LEGACY_SOURCE_PREFIX = 'legacy-window-bridge';

  const win = window as unknown as Window & Record<string, unknown>;
  const existingHost = win[HOST_KEY] as { registerSource?: unknown } | undefined;
  if (existingHost && typeof existingHost.registerSource === 'function') {
    return;
  }

  const state = {
    sourcesById: new Map<
      string,
      {
        sourceId: string;
        bridge: PageContextBridge;
        priority: number;
        tags: string[];
        registeredAt: string;
        registerOrder: number;
      }
    >(),
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

  const registerSource = (
    sourceId: string,
    bridge: PageContextBridge,
    priority = 100,
    tags: string[] = [],
  ) => {
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

  const isBridgeLike = (candidate: unknown): candidate is PageContextBridge =>
    Boolean(
      candidate &&
      typeof (candidate as PageContextBridge).version === 'string' &&
      typeof (candidate as PageContextBridge).listNamespaces === 'function' &&
      typeof (candidate as PageContextBridge).getNamespace === 'function' &&
      typeof (candidate as PageContextBridge).getScene === 'function' &&
      typeof (candidate as PageContextBridge).listResources === 'function' &&
      typeof (candidate as PageContextBridge).readResource === 'function' &&
      typeof (candidate as PageContextBridge).listSkills === 'function' &&
      typeof (candidate as PageContextBridge).getSkill === 'function' &&
      typeof (candidate as PageContextBridge).getManifest === 'function',
    );

  const isLegacyBridgeLike = (candidate: unknown): candidate is LegacyPageContextBridge =>
    Boolean(
      candidate &&
      typeof candidate === 'object' &&
      typeof (candidate as LegacyPageContextBridge).getManifest === 'function' &&
      (typeof (candidate as LegacyPageContextBridge).listTools === 'function' ||
        typeof (candidate as LegacyPageContextBridge).callTool === 'function'),
    );

  const adaptLegacyBridge = (candidate: LegacyPageContextBridge): PageContextBridge => {
    const resolveNamespace = (): string => {
      if (typeof candidate.namespace === 'string' && candidate.namespace.trim()) {
        return candidate.namespace.trim();
      }
      const manifest = safe(() => candidate.getManifest?.(), null);
      const manifestNamespace = Array.isArray(manifest?.namespaces)
        ? manifest.namespaces.find((entry) => entry && typeof entry.namespace === 'string')
        : null;
      return typeof manifestNamespace?.namespace === 'string'
        ? manifestNamespace.namespace
        : 'page';
    };

    const resolveInstanceId = (): string => {
      if (typeof candidate.instanceId === 'string' && candidate.instanceId.trim()) {
        return candidate.instanceId.trim();
      }
      return 'default';
    };

    const listTools = () => {
      const tools = safe(() => candidate.listTools?.(), []);
      return Array.isArray(tools) ? tools : [];
    };

    const callTool = (name: string, args?: Record<string, unknown>) => {
      // Passing content-script objects directly to the legacy bridge from Firefox MAIN world
      // can trigger "Permission denied to access object". JSON-clone args into page-owned plain objects first.
      const clonedArgs = safe(
        () => JSON.parse(JSON.stringify(args ?? {})) as Record<string, unknown>,
        args ?? {},
      );
      return safe(() => candidate.callTool?.(name, clonedArgs), undefined);
    };

    const namespace = resolveNamespace();
    const instanceId = resolveInstanceId();

    return {
      version:
        typeof candidate.version === 'string' && candidate.version.trim()
          ? candidate.version
          : 'page-context-legacy-bridge/1.0.0',
      listNamespaces: () => [namespace],
      getNamespace: (requestedNamespace: string) => {
        if (requestedNamespace !== namespace) {
          return undefined;
        }

        if (instanceId === 'default') {
          return {
            listTools,
            callTool,
          };
        }

        return {
          listInstances: () => [instanceId],
          getInstance: (requestedInstanceId: string) => {
            if (requestedInstanceId !== instanceId) {
              return undefined;
            }
            return {
              listTools,
              callTool,
            };
          },
        };
      },
      getScene: () => {
        const manifest = safe(() => candidate.getManifest?.(), null);
        return typeof manifest?.scene === 'string' && manifest.scene ? manifest.scene : namespace;
      },
      listResources: () => {
        const manifest = safe(() => candidate.getManifest?.(), null);
        return Array.isArray(manifest?.resources) ? manifest.resources : [];
      },
      readResource: (id: string) =>
        safe(() => candidate.readResource?.(id), undefined) ?? {
          id,
          mimeType: 'application/json',
          text: JSON.stringify({ error: `Unknown resource id: ${id}` }, null, 2),
        },
      listSkills: () => {
        const manifest = safe(() => candidate.getManifest?.(), null);
        return Array.isArray(manifest?.skills) ? manifest.skills : [];
      },
      getSkill: (id: string, input?: Record<string, unknown>) =>
        safe(() => candidate.getSkill?.(id, input), undefined),
      getManifest: () => safe(() => candidate.getManifest?.(), null) ?? null,
    };
  };

  const normalizeBridgeCandidate = (candidate: unknown): PageContextBridge | null => {
    if (isBridgeLike(candidate)) {
      return candidate;
    }
    if (isLegacyBridgeLike(candidate)) {
      return adaptLegacyBridge(candidate);
    }
    return null;
  };

  const bridgeSourceIdByRef = new WeakMap<object, string>();
  let legacySourceCursor = 0;
  const adoptLegacyAssignedBridge = (candidate: unknown, key: string): void => {
    const normalizedBridge = normalizeBridgeCandidate(candidate);
    if (!normalizedBridge || candidate === hostBridge) {
      return;
    }
    // Firefox readonly broker should not read the host-merged bridge through a getter.
    // Keep an extra raw bridge reference for direct content-script reads,
    // avoiding Xray permission errors from wrappedJSObject plus getter access.
    win[RAW_BRIDGE_KEY] = candidate;
    const bridge = candidate as object;
    let sourceId = bridgeSourceIdByRef.get(bridge);
    if (!sourceId) {
      legacySourceCursor += 1;
      sourceId = `${HOST_LEGACY_SOURCE_PREFIX}:${legacySourceCursor}`;
      bridgeSourceIdByRef.set(bridge, sourceId);
    }
    registerSource(sourceId, normalizedBridge, 70, ['legacy-assignment', key]);
  };

  const hostBridge = {
    version: 'page-context-bridge-host/1.0.0',
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
            .map((source) => safe(() => source.bridge.getScene(), ''))
            .filter(Boolean),
        ),
      );
      if (scenes.length === 0) {
        return HOST_DEFAULT_SCENE;
      }
      if (scenes.length === 1) {
        return scenes[0]!;
      }
      return `page-context-host-mixed:${scenes.join('+')}`;
    },
    listResources: () => {
      const deduped = new Map<string, unknown>();
      for (const source of orderedSources()) {
        const resources = safe(() => source.bridge.listResources(), []);
        for (const resource of resources) {
          if (resource && typeof resource.id === 'string' && !deduped.has(resource.id)) {
            deduped.set(resource.id, resource);
          }
        }
      }
      return Array.from(deduped.values());
    },
    readResource: (id: string) => {
      for (const source of orderedSources()) {
        const resources = safe(() => source.bridge.listResources(), []);
        const hasResource = resources.some((resource: ResourceDescriptor) => resource?.id === id);
        if (hasResource) {
          return safe(() => source.bridge.readResource(id), {
            id,
            mimeType: 'application/json',
            text: JSON.stringify({ error: `Resource read failed: ${id}` }, null, 2),
          });
        }
      }
      return {
        id,
        mimeType: 'application/json',
        text: JSON.stringify({ error: `Unknown resource id: ${id}` }, null, 2),
      };
    },
    listSkills: () => {
      const deduped = new Map<string, unknown>();
      for (const source of orderedSources()) {
        const skills = safe(() => source.bridge.listSkills(), []);
        for (const skill of skills) {
          if (skill && typeof skill.id === 'string' && !deduped.has(skill.id)) {
            deduped.set(skill.id, skill);
          }
        }
      }
      return Array.from(deduped.values());
    },
    getSkill: (id: string, input?: Record<string, unknown>) => {
      for (const source of orderedSources()) {
        const skills = safe(() => source.bridge.listSkills(), []);
        const hasSkill = skills.some((skill: SkillDescriptor) => skill?.id === id);
        if (hasSkill) {
          return safe(() => source.bridge.getSkill(id, input), undefined);
        }
      }
      return undefined;
    },
    getManifest: () => {
      const namespaces = new Map<string, unknown>();
      for (const source of orderedSources()) {
        const manifest = safe(() => source.bridge.getManifest(), null);
        const descriptors = Array.isArray(manifest?.namespaces) ? manifest.namespaces : [];
        for (const descriptor of descriptors) {
          if (
            descriptor &&
            typeof descriptor.namespace === 'string' &&
            !namespaces.has(descriptor.namespace)
          ) {
            namespaces.set(descriptor.namespace, descriptor);
          }
        }
      }
      return {
        version: 'page-context-bridge-host/1.0.0',
        app: 'page-context-bridge-host',
        route: `${window.location.pathname}${window.location.search}`,
        scene: hostBridge.getScene(),
        namespaces: Array.from(namespaces.values()),
        resources: hostBridge.listResources(),
        skills: hostBridge.listSkills(),
        generatedAt: new Date().toISOString(),
      };
    },
  };

  const existingBridge = (win[BRIDGE_KEY] ?? win[TOOLS_KEY]) as unknown;
  const normalizedExistingBridge = normalizeBridgeCandidate(existingBridge);
  if (normalizedExistingBridge) {
    win[RAW_BRIDGE_KEY] = existingBridge;
    registerSource(HOST_ADOPTED_SOURCE_ID, normalizedExistingBridge, 10, ['adopted']);
  }

  const host = {
    version: 'page-context-bridge-host/1.0.0',
    bridge: hostBridge,
    registerSource: (input: {
      sourceId: string;
      bridge: PageContextBridge;
      priority?: number;
      tags?: string[];
    }) => registerSource(input.sourceId, input.bridge, input.priority, input.tags),
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
  // Maintain merge semantics via getter/setter: legacy plugins writing directly to window.__pageContextBridge__ will also be adopted as a source by the host.
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
};
