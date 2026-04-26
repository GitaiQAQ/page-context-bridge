/**
 * Installs the page context bridge host into the main world (window).
 *
 * Self-contained — only uses `window` global and standard JS APIs.
 * No external dependencies; safe to move to its own module.
 */

export type MainWorldBridgeHostInstaller = () => void;

export const installPageContextBridgeHostInMainWorld: MainWorldBridgeHostInstaller = (): void => {
  const HOST_KEY = '__pageContextBridgeHost__';
  const BRIDGE_KEY = '__pageContextBridge__';
  const TOOLS_KEY = '__pageContextTools__';
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
        bridge: any;
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
      typeof candidate.version === 'string' &&
      typeof candidate.listNamespaces === 'function' &&
      typeof candidate.getNamespace === 'function' &&
      typeof candidate.getScene === 'function' &&
      typeof candidate.listResources === 'function' &&
      typeof candidate.readResource === 'function' &&
      typeof candidate.listSkills === 'function' &&
      typeof candidate.getSkill === 'function' &&
      typeof candidate.getManifest === 'function',
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
    registerSource(sourceId, candidate, 70, ['legacy-assignment', key]);
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
        const hasResource = resources.some((resource: any) => resource?.id === id);
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
    registerSource(HOST_ADOPTED_SOURCE_ID, existingBridge, 10, ['adopted']);
  }

  const host = {
    version: 'page-context-bridge-host/1.0.0',
    bridge: hostBridge,
    registerSource: (input: {
      sourceId: string;
      bridge: any;
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
