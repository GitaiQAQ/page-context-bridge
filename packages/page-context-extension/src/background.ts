/**
 * Background service worker coordinator.
 * Wires together WS connection, page context, tool execution, and extension event listeners.
 */

import './browser-polyfill';

import {
  ensureAgentationMainOnTab,
  ensureMainWorldBridgeHostOnTab,
} from '@page-context/agentation';
import {
  connectWebSocket,
  disconnectWebSocket,
  forceReconnect,
  getWsReady,
  getSessionId,
  initDefaultWsUrl,
  log,
  queueNotification,
  requestBridge,
} from './bg-ws-connection';
import { createPageToolState } from './bg-page-tools';
import { discoverPageToolsForTab } from './bg-page-tools';
import { createWsHandlers } from './bg-ws-handlers';
import { createRuntimeMessageHandler } from './bg-runtime-handlers';
import { registerLifecycleListeners } from './bg-lifecycle';
import { installPageContextBridgeHostInMainWorld } from './bg-main-world-bridge-host';
import { tabsQuery } from './extension-api';
import { createScopedBridgeWsManager } from './bg-scoped-ws-connection';
import { getConnectionRegistry } from './bg-connection-registry';
import { createOpencodeHttpConnectionDriver } from './bg-opencode-http-connection';

const inFlightToolCalls = new Map<string, string>();
const pageToolState = createPageToolState();
const scopedBridgeWsManager = createScopedBridgeWsManager();
const connectionRegistry = getConnectionRegistry();
const opencodeHttpDriver = createOpencodeHttpConnectionDriver();

// ── Tab helpers ──

async function listTabs() {
  const tabs = await tabsQuery({});
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
  scopedBridgeConnection: scopedBridgeWsManager,
});

const runtimeMessageHandler = createRuntimeMessageHandler({
  pageToolState,
  installPageContextBridgeHostInMainWorld,
  extensionControlHandlers: wsHandlers,
  requestBridgeMethod,
  queueNotification,
});

connectionRegistry.registerDriver('bridge-default-ws', {
  async action(action) {
    if (action === 'disconnect') {
      disconnectWebSocket();
      return { ok: true };
    }

    await forceReconnect(
      wsHandlers.onToolCall,
      wsHandlers.onToolsList,
      wsHandlers.onTabsList,
      wsHandlers.onBridgeWsExtensionRequest,
    );
    return { ok: true };
  },
});

connectionRegistry.registerDriver('opencode-bridge-ws', {
  async action(action, descriptor) {
    const tenantId =
      typeof descriptor.meta?.tenantId === 'string' ? descriptor.meta.tenantId : undefined;
    if (!tenantId) {
      throw new Error(`Missing tenantId for descriptor "${descriptor.id}"`);
    }

    if (action === 'disconnect') {
      await scopedBridgeWsManager.disconnect(tenantId);
      return { ok: true };
    }

    if (!descriptor.endpoint) {
      throw new Error(`Missing endpoint for descriptor "${descriptor.id}"`);
    }

    await scopedBridgeWsManager.connect(tenantId, descriptor.endpoint, {
      onToolCall: wsHandlers.onToolCall,
      onToolsList: wsHandlers.onToolsList,
      onTabsList: wsHandlers.onTabsList,
      onExtensionRequest: wsHandlers.onBridgeWsExtensionRequest,
    });
    return { ok: true };
  },
});

connectionRegistry.registerDriver('opencode-http', {
  async action(action) {
    if (action === 'disconnect') {
      throw new Error('OpenCode HTTP health probe does not support disconnect');
    }
    await opencodeHttpDriver.probeNow();
    return { ok: true };
  },
});

connectionRegistry.registerDriver('page-tools', {});
connectionRegistry.registerDriver('page-tools', {
  async action(action, descriptor) {
    if (action === 'disconnect') {
      throw new Error('Page tools discovery does not support disconnect');
    }

    const tabId = Number(descriptor.meta?.tabId);
    if (!Number.isInteger(tabId)) {
      throw new Error(`Missing tabId for descriptor "${descriptor.id}"`);
    }

    await discoverPageToolsForTab(
      pageToolState,
      tabId,
      installPageContextBridgeHostInMainWorld,
      true,
    );
    return { ok: true };
  },
});

connectionRegistry.registerDriver('main-world-host', {
  async action(action, descriptor) {
    if (action === 'disconnect') {
      throw new Error('Main world host does not support disconnect');
    }

    const tabId = Number(descriptor.meta?.tabId);
    const frameId = descriptor.meta?.frameId;
    if (!Number.isInteger(tabId)) {
      throw new Error(`Missing tabId for descriptor "${descriptor.id}"`);
    }

    await ensureMainWorldBridgeHostOnTab(
      tabId,
      installPageContextBridgeHostInMainWorld,
      typeof frameId === 'number' ? frameId : undefined,
    );
    return { ok: true };
  },
});

connectionRegistry.registerDriver('agentation-main-world-host', {
  async action(action, descriptor) {
    if (action === 'disconnect') {
      throw new Error('Agentation main world host does not support disconnect');
    }

    const tabId = Number(descriptor.meta?.tabId);
    const frameId = descriptor.meta?.frameId;
    if (!Number.isInteger(tabId)) {
      throw new Error(`Missing tabId for descriptor "${descriptor.id}"`);
    }

    await ensureAgentationMainOnTab(tabId, typeof frameId === 'number' ? frameId : undefined);
    return { ok: true };
  },
});

void opencodeHttpDriver.start().catch(() => {
  // Some unit tests only validate module wiring and do not provide the full extension API.
  // The health driver can silently skip those environments without affecting background logic coverage.
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
