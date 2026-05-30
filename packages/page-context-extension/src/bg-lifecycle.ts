/**
 * Lifecycle listener registrar.
 * Centralizes chrome event binding so that background.ts retains only assembly responsibility.
 */
import { BRIDGE_METHODS } from '@page-context/shared-protocol';

import {
  clearPageTools,
  discoverPageToolsAfterTabReload,
  discoverPageToolsForTab,
  ensurePageToolPreferencesLoaded,
  publishBuiltinTools,
  publishPageToolsForTab,
  type PageToolState,
} from './bg-page-tools';
import type { MainWorldBridgeHostInstaller } from '@page-context/agentation';
import { tabsQuery } from './extension-api';
import { createRuntimeListener } from './runtime-rpc';
import type { WsHandlers } from './bg-ws-handlers';

interface RegisterLifecycleListenersDeps {
  pageToolState: PageToolState;
  installPageContextBridgeHostInMainWorld: MainWorldBridgeHostInstaller;
  runtimeMessageHandler: (
    message: { method: string; params?: unknown },
    sender: chrome.runtime.MessageSender,
  ) => Promise<unknown>;
  wsHandlers: Pick<
    WsHandlers,
    'onToolCall' | 'onToolsList' | 'onTabsList' | 'onBridgeWsExtensionRequest'
  >;
  queueNotification(method: string, params?: unknown): void;
  connectWebSocket(
    onToolCall: (params: unknown, requestId: string) => Promise<unknown>,
    onToolsList: () => Promise<unknown>,
    onTabsList: () => Promise<unknown>,
    onExtensionRequest: (method: string, params: unknown) => Promise<unknown>,
  ): Promise<void>;
  initDefaultWsUrl(): Promise<void>;
  log(...args: unknown[]): void;
}

export function registerLifecycleListeners(deps: RegisterLifecycleListenersDeps): void {
  const connectBridgeAndRepublishState = async (): Promise<void> => {
    await deps.connectWebSocket(
      deps.wsHandlers.onToolCall,
      deps.wsHandlers.onToolsList,
      deps.wsHandlers.onTabsList,
      deps.wsHandlers.onBridgeWsExtensionRequest,
    );

    // After WS connects, resend from current memory state so Firefox page tools registered
    // before the connection do not remain extension-local and invisible to bridge/MCP.
    await ensurePageToolPreferencesLoaded(deps.pageToolState);
    publishBuiltinTools(deps.pageToolState);
    for (const tabId of deps.pageToolState.pageToolsByTab.keys()) {
      publishPageToolsForTab(deps.pageToolState, tabId);
    }

    // In real Firefox flows, content script registration races with bridge connection setup.
    // Rediscover the active tab after connect so page tools can realign with bridge/MCP.
    const activeTabs = await tabsQuery({ active: true });
    await Promise.allSettled(
      activeTabs
        .map((tab) => tab.id)
        .filter((tabId): tabId is number => typeof tabId === 'number' && Number.isInteger(tabId))
        .map((tabId) =>
          discoverPageToolsForTab(
            deps.pageToolState,
            tabId,
            deps.installPageContextBridgeHostInMainWorld,
            true,
            false,
          ),
        ),
    );
  };

  // Runtime listener wraps JSON-RPC adaptation uniformly; business handlers only care about method/params.
  chrome.runtime.onMessage.addListener(createRuntimeListener(deps.runtimeMessageHandler));

  chrome.tabs.onActivated.addListener((activeInfo) => {
    deps.queueNotification(BRIDGE_METHODS.bridgeTabActivated, {
      tabId: activeInfo.tabId,
      windowId: activeInfo.windowId,
    });
    void discoverPageToolsForTab(
      deps.pageToolState,
      activeInfo.tabId,
      deps.installPageContextBridgeHostInMainWorld,
    ).catch((error) => deps.log('Discovery on tab activation failed', error));
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
      // Clear stale cache as soon as loading fires to guarantee a "re-discover -> re-publish" flow.
      deps.pageToolState.tabReloadDiscoveryInFlight.delete(tabId);
      clearPageTools(deps.pageToolState, tabId);
    }

    if (changeInfo.status === 'complete' || changeInfo.url) {
      deps.queueNotification(BRIDGE_METHODS.bridgeTabUpdated, {
        tabId,
        url: changeInfo.url,
        status: changeInfo.status,
      });
    }

    if (changeInfo.status === 'complete') {
      void discoverPageToolsAfterTabReload(
        deps.pageToolState,
        tabId,
        deps.installPageContextBridgeHostInMainWorld,
      ).catch((error) => deps.log('Discovery on tab update failed', error));
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    deps.pageToolState.tabReloadDiscoveryInFlight.delete(tabId);
    clearPageTools(deps.pageToolState, tabId);
  });

  chrome.runtime.onInstalled.addListener(() => {
    void deps.initDefaultWsUrl();
    // onInstalled and first startup share the same connection entry to avoid duplicate connection logic.
    void connectBridgeAndRepublishState();
  });

  chrome.runtime.onStartup.addListener(() => {
    void connectBridgeAndRepublishState();
  });

  void connectBridgeAndRepublishState();
  void ensurePageToolPreferencesLoaded(deps.pageToolState).then(() => {
    publishBuiltinTools(deps.pageToolState);
    for (const tabId of deps.pageToolState.pageToolsByTab.keys()) {
      publishPageToolsForTab(deps.pageToolState, tabId);
    }
  });
  void tabsQuery({ active: true })
    .then((tabs) =>
      Promise.allSettled(
        tabs
          .map((tab) => tab.id)
          .filter((tabId): tabId is number => typeof tabId === 'number' && Number.isInteger(tabId))
          .map((tabId) =>
            discoverPageToolsForTab(
              deps.pageToolState,
              tabId,
              deps.installPageContextBridgeHostInMainWorld,
            ),
          ),
      ),
    )
    .catch((error) => deps.log('Initial active-tab discovery failed', error));

  setInterval(() => {
    chrome.runtime.getPlatformInfo(() => undefined);
  }, 25_000);
}
