/**
 * Background service worker coordinator.
 * Wires together WS connection, page context, tool execution, and extension event listeners.
 */

import { connectWebSocket, forceReconnect, getWsReady, getSessionId, initDefaultWsUrl, log, queueNotification, requestBridge } from "./bg-ws-connection";
import { createPageToolState } from "./bg-page-tools";
import { createWsHandlers } from "./bg-ws-handlers";
import { createRuntimeMessageHandler } from "./bg-runtime-handlers";
import { registerLifecycleListeners } from "./bg-lifecycle";
import { installPageContextBridgeHostInMainWorld } from "./bg-main-world-bridge-host";

const inFlightToolCalls = new Map<string, string>();
const pageToolState = createPageToolState();

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

// All bridge requests go through this unified entry point; business layers never touch RpcPeer directly.
async function requestBridgeMethod<TResult>(method: string, params?: unknown): Promise<TResult> {
  return await requestBridge<TResult>(method, params, { timeoutMs: 20_000 });
}

const wsHandlers = createWsHandlers({
  pageToolState,
  inFlightToolCalls,
  listTabs,
  installPageContextBridgeHostInMainWorld,
  bridgeConnection: {
    getWsReady,
    getSessionId,
    forceReconnect,
  },
});

const runtimeMessageHandler = createRuntimeMessageHandler({
  pageToolState,
  installPageContextBridgeHostInMainWorld,
  extensionControlHandlers: wsHandlers,
  requestBridgeMethod,
  queueNotification,
});

// background.ts is the composition root: state is created here and explicitly injected into sub-modules.
registerLifecycleListeners({
  pageToolState,
  installPageContextBridgeHostInMainWorld,
  runtimeMessageHandler,
  wsHandlers,
  queueNotification,
  connectWebSocket,
  initDefaultWsUrl,
  log,
});
