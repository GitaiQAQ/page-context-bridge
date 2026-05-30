import { BRIDGE_METHODS, type PageContextManifest } from '@page-context/shared-protocol';
import { collectBridgeControlToolSpecs } from '@page-context/builtin-tools';

import {
  ensureMainWorldBridgeHostOnTab,
  type MainWorldBridgeHostInstaller,
} from '@page-context/agentation';
import { discoverPageToolsInTab, pageAccessBackendKind, sleep } from './bg-page-context';
import { isPageAccessBackendError } from './bg-page-access-backend';
import { log, queueNotification } from './bg-ws-connection';
import { storageLocalGet, storageLocalSet, tabsQuery } from './extension-api';
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
import {
  updateMainWorldHostDescriptor,
  updatePageToolsDescriptor,
} from './bg-connection-descriptors';

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

export function getAllBuiltinTools(): PageToolSpec[] {
  return getBuiltinTools();
}

export function getAllTools(state: PageToolState): PageToolSpec[] {
  const builtin = getAllBuiltinTools();
  for (const [tabId, entries] of state.pageToolsByTab.entries()) {
    builtin.push(...flattenPageTools(entries));
  }
  return builtin;
}

export function ensurePageToolPreferencesLoaded(state: PageToolState): Promise<void> {
  if (!state.pageToolPreferencesReady) {
    state.pageToolPreferencesReady = storageLocalGet({ [PAGE_TOOL_PREFERENCES_KEY]: {} }).then(
      (result) => {
        state.pageToolPreferences =
          (result[PAGE_TOOL_PREFERENCES_KEY] as PageToolPreferences | undefined) ?? {};
      },
    );
  }

  return state.pageToolPreferencesReady;
}

export async function persistPageToolPreferences(state: PageToolState): Promise<void> {
  await storageLocalSet({ [PAGE_TOOL_PREFERENCES_KEY]: state.pageToolPreferences });
}

export function publishBuiltinTools(state: PageToolState): void {
  void ensurePageToolPreferencesLoaded(state).then(() => {
    queueNotification(BRIDGE_METHODS.bridgeBuiltinToolsUpdated, {
      tools: getAllBuiltinTools(),
    });
  });
}

export function publishPageToolsForTab(state: PageToolState, tabId: number): void {
  void ensurePageToolPreferencesLoaded(state).then(() => {
    queueNotification(BRIDGE_METHODS.bridgePageToolsRegistered, {
      tabId,
      tools: getFlattenedPageToolsForTab(state, tabId),
    });
  });
}

export async function buildPageToolsTreeResponse(state: PageToolState) {
  const tabs = await tabsQuery({});
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
  failOnBackendError = false,
): Promise<PageToolEntry[]> {
  if (!force) {
    const existing = state.discoveryInFlight.get(tabId);
    if (existing) {
      return await existing;
    }
  }

  const discoveryPromise = (async () => {
    const existingEntries = state.pageToolsByTab.get(tabId) ?? [];

    updateMainWorldHostDescriptor(tabId, undefined, 'connecting', 'ensuring-host');
    await ensureMainWorldBridgeHostOnTab(tabId, installPageContextBridgeHostInMainWorld)
      .then(() => {
        updateMainWorldHostDescriptor(tabId, undefined, 'connected', 'host-ready');
      })
      .catch((error: unknown) => {
        updateMainWorldHostDescriptor(
          tabId,
          undefined,
          'error',
          error instanceof Error ? error.message : String(error),
        );
        log('Ensure MAIN world host failed before discovery', tabId, error);
      });

    const delays = [0, 500, 1_500, 3_000];
    for (const delay of delays) {
      if (delay > 0) {
        await sleep(delay);
      }

      try {
        const rawEntries = await discoverPageToolsInTab(tabId);
        if (rawEntries.length === 0) {
          updatePageToolsDescriptor(tabId, 'closed', 'no-tools-discovered');
          continue;
        }

        const normalized = normalizePageToolEntries(rawEntries);
        state.pageToolsByTab.set(tabId, normalized);
        updatePageToolsDescriptor(
          tabId,
          'connected',
          `tools=${flattenPageTools(normalized).length}`,
        );
        publishPageToolsForTab(state, tabId);
        return normalized;
      } catch (error) {
        updatePageToolsDescriptor(
          tabId,
          'error',
          error instanceof Error ? error.message : String(error),
        );
        // 主动刷新需要把 backend 不可用抛给上层；生命周期自动探测则只记录，
        // 避免测试/受限运行时因 unsupported backend 产生未处理 rejection。
        if (failOnBackendError && isPageAccessBackendError(error)) {
          throw error;
        }
        log('Page tool discovery failed', tabId, error);
        break;
      }
    }

    const latestEntries = state.pageToolsByTab.get(tabId) ?? [];
    if (
      pageAccessBackendKind === 'firefox-probe' &&
      latestEntries.some((entry) => Array.isArray(entry.tools) && entry.tools.length > 0)
    ) {
      // Firefox 只读注册可能晚于这轮后台轮询开始时间。
      // 这里必须看“当前状态”而不是函数开头的快照，否则会把轮询过程中刚注册好的工具错误清掉。
      log('Preserving current Firefox page tools after empty rediscovery', tabId);
      return latestEntries;
    }

    state.pageToolsByTab.delete(tabId);
    updatePageToolsDescriptor(tabId, 'closed', 'cleared-after-empty-discovery');
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
  updatePageToolsDescriptor(tabId, 'closed', 'tab-cleared');
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

  const rawDiscoveryTask = (async () => {
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
        false,
      );
      if (entries.length > 0) {
        return;
      }
    }
  })();
  const discoveryTask = rawDiscoveryTask.catch((error: unknown) => {
    throw error;
  });

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
