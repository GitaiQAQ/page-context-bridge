import { BRIDGE_METHODS, type PageContextManifest } from '@page-context/shared-protocol';
import { collectBridgeControlToolSpecs } from '@page-context/builtin-tools';

import {
  ensureMainWorldBridgeHostOnTab,
  type MainWorldBridgeHostInstaller,
} from '@page-context/agentation';
import { discoverPageToolsInTab, sleep } from './bg-page-context';
import { log, queueNotification } from './bg-ws-connection';
import { getBuiltinToolDefinitions } from '@page-context/tool-executor';
import {
  flattenPageTools,
  normalizePageToolEntries,
  type PageToolEntry,
  type PageToolSpec,
} from '@page-context/tool-visibility';
import {
  buildToolTree,
  getEnabledBuiltinTools,
  getEnabledToolsForTab,
  isToolEnabled,
  setScopeEnabled,
  type PageToolPreferences,
} from '@page-context/tool-visibility';

const PAGE_TOOL_PREFERENCES_KEY = 'pageToolPreferences';

export interface PageToolState {
  pageToolPreferences: PageToolPreferences;
  pageToolPreferencesReady: Promise<void> | null;
  pageToolsByTab: Map<number, PageToolEntry[]>;
  discoveryInFlight: Map<number, Promise<PageToolEntry[]>>;
  tabReloadDiscoveryInFlight: Map<number, Promise<void>>;
}

export function createPageToolState(): PageToolState {
  return {
    pageToolPreferences: {},
    pageToolPreferencesReady: null,
    pageToolsByTab: new Map<number, PageToolEntry[]>(),
    discoveryInFlight: new Map<number, Promise<PageToolEntry[]>>(),
    tabReloadDiscoveryInFlight: new Map<number, Promise<void>>(),
  };
}

export function getBuiltinTools(): PageToolSpec[] {
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

  const deduped = new Map<string, PageToolSpec>();
  for (const tool of [...runtimeBuiltins, ...bridgeControlBuiltins]) {
    if (!deduped.has(tool.name)) {
      deduped.set(tool.name, tool);
    }
  }
  return Array.from(deduped.values());
}

export function getAllTools(state: PageToolState): PageToolSpec[] {
  const builtin = getEnabledBuiltinTools(getBuiltinTools(), state.pageToolPreferences);
  for (const [tabId, entries] of state.pageToolsByTab.entries()) {
    builtin.push(...getEnabledToolsForTab(entries, state.pageToolPreferences, tabId));
  }
  return builtin;
}

export function ensurePageToolPreferencesLoaded(state: PageToolState): Promise<void> {
  if (!state.pageToolPreferencesReady) {
    state.pageToolPreferencesReady = chrome.storage.local
      .get({ [PAGE_TOOL_PREFERENCES_KEY]: {} })
      .then((result) => {
        state.pageToolPreferences =
          (result[PAGE_TOOL_PREFERENCES_KEY] as PageToolPreferences | undefined) ?? {};
      });
  }

  return state.pageToolPreferencesReady;
}

export async function persistPageToolPreferences(state: PageToolState): Promise<void> {
  await chrome.storage.local.set({ [PAGE_TOOL_PREFERENCES_KEY]: state.pageToolPreferences });
}

export function publishBuiltinTools(state: PageToolState): void {
  void ensurePageToolPreferencesLoaded(state).then(() => {
    queueNotification(BRIDGE_METHODS.bridgeBuiltinToolsUpdated, {
      tools: getEnabledBuiltinTools(getBuiltinTools(), state.pageToolPreferences),
    });
  });
}

export function publishPageToolsForTab(state: PageToolState, tabId: number): void {
  void ensurePageToolPreferencesLoaded(state).then(() => {
    queueNotification(BRIDGE_METHODS.bridgePageToolsRegistered, {
      tabId,
      tools: getEnabledToolsForTab(
        state.pageToolsByTab.get(tabId),
        state.pageToolPreferences,
        tabId,
      ),
    });
  });
}

export async function buildPageToolsTreeResponse(state: PageToolState) {
  const tabs = await chrome.tabs.query({});
  return buildToolTree(tabs, state.pageToolsByTab, getBuiltinTools(), state.pageToolPreferences);
}

export function filterManifestByPreferences(
  state: PageToolState,
  tabId: number,
  manifest: PageContextManifest,
): PageContextManifest {
  const enabledPageToolNames = new Set(
    getEnabledToolsForTab(state.pageToolsByTab.get(tabId), state.pageToolPreferences, tabId).map(
      (tool) => tool.name,
    ),
  );
  const enabledBuiltinToolNames = new Set(
    getEnabledBuiltinTools(getBuiltinTools(), state.pageToolPreferences).map((tool) => tool.name),
  );
  const enabledNamespaces = new Set(
    manifest.namespaces
      .filter((entry: PageContextManifest['namespaces'][number]) =>
        isToolEnabled(state.pageToolPreferences, {
          root: 'page',
          tabId,
          namespace: entry.namespace,
        }),
      )
      .map((entry: PageContextManifest['namespaces'][number]) => entry.namespace),
  );

  return {
    ...manifest,
    namespaces: manifest.namespaces.filter((entry: PageContextManifest['namespaces'][number]) =>
      enabledNamespaces.has(entry.namespace),
    ),
    resources: manifest.resources.filter((entry: PageContextManifest['resources'][number]) =>
      enabledNamespaces.has(entry.namespace),
    ),
    skills: manifest.skills
      .filter((entry: PageContextManifest['skills'][number]) =>
        enabledNamespaces.has(entry.namespace),
      )
      .map((entry: PageContextManifest['skills'][number]) => ({
        ...entry,
        resourceIds: (entry.resourceIds ?? []).filter((resourceId: string) =>
          manifest.resources.some(
            (resource: PageContextManifest['resources'][number]) =>
              resource.id === resourceId && enabledNamespaces.has(resource.namespace),
          ),
        ),
        toolNames: (entry.toolNames ?? []).filter(
          (toolName: string) =>
            enabledPageToolNames.has(toolName) || enabledBuiltinToolNames.has(toolName),
        ),
      })),
  };
}

export async function discoverPageToolsForTab(
  state: PageToolState,
  tabId: number,
  installPageContextBridgeHostInMainWorld: MainWorldBridgeHostInstaller,
  force = false,
): Promise<PageToolEntry[]> {
  if (!force) {
    const existing = state.discoveryInFlight.get(tabId);
    if (existing) {
      return await existing;
    }
  }

  const discoveryPromise = (async () => {
    await ensureMainWorldBridgeHostOnTab(tabId, installPageContextBridgeHostInMainWorld).catch(
      (error: unknown) => {
        log('Ensure MAIN world host failed before discovery', tabId, error);
      },
    );

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
        state.pageToolsByTab.set(tabId, normalized);
        publishPageToolsForTab(state, tabId);
        return normalized;
      } catch (error) {
        log('Page tool discovery failed', tabId, error);
        break;
      }
    }

    state.pageToolsByTab.delete(tabId);
    return [];
  })();

  state.discoveryInFlight.set(tabId, discoveryPromise);
  try {
    return await discoveryPromise;
  } finally {
    state.discoveryInFlight.delete(tabId);
  }
}

export function clearPageTools(state: PageToolState, tabId: number): void {
  state.pageToolsByTab.delete(tabId);
  queueNotification(BRIDGE_METHODS.bridgePageToolsUnregistered, { tabId });
}

export async function discoverPageToolsAfterTabReload(
  state: PageToolState,
  tabId: number,
  installPageContextBridgeHostInMainWorld: MainWorldBridgeHostInstaller,
): Promise<void> {
  const existing = state.tabReloadDiscoveryInFlight.get(tabId);
  if (existing) {
    return await existing;
  }

  const discoveryTask = (async () => {
    const reloadDelays = [0, 2_000];
    for (const delay of reloadDelays) {
      if (delay > 0) {
        await sleep(delay);
      }
      const entries = await discoverPageToolsForTab(
        state,
        tabId,
        installPageContextBridgeHostInMainWorld,
        true,
      );
      if (entries.length > 0) {
        return;
      }
    }
  })();

  state.tabReloadDiscoveryInFlight.set(tabId, discoveryTask);
  try {
    await discoveryTask;
  } finally {
    state.tabReloadDiscoveryInFlight.delete(tabId);
  }
}

export function getFlattenedPageToolsForTab(state: PageToolState, tabId: number): PageToolSpec[] {
  return flattenPageTools(state.pageToolsByTab.get(tabId));
}
