import {
  a as BRIDGE_METHODS,
  c as RpcProtocolError,
  l as createNotification,
  o as RPC_ERROR_CODES,
  s as RpcPeer,
} from './runtime-rpc.Bw2tfxVR.js';
import {
  i as storageLocalGet,
  o as storageLocalSet,
  r as runtimeSendMessage,
} from './extension-api.BMHS3pcA.js';
//#region src/bg-connection-registry.ts
/**
 * 统一连接注册表。
 *
 * 目标：
 * 1. background 内所有“对外链路”都在这里挂账
 * 2. sidepanel 只读 descriptor，不再自己拼状态字符串
 * 3. 动作统一经由 driver 路由，避免 UI 直接耦合具体实现
 */
var CONNECTIONS_CHANGED_METHOD = 'connections.changed';
function sortDescriptors(left, right) {
  return (
    left.kind.localeCompare(right.kind) ||
    left.label.localeCompare(right.label) ||
    left.id.localeCompare(right.id)
  );
}
function createConnectionRegistry(deps = {}) {
  const descriptors = /* @__PURE__ */ new Map();
  const drivers = /* @__PURE__ */ new Map();
  const broadcast = async (method, params) => {
    if (deps.broadcast) {
      await deps.broadcast(method, params);
      return;
    }
    try {
      await runtimeSendMessage(createNotification(method, params));
    } catch {}
  };
  const broadcastChanged = async () => {
    await broadcast(CONNECTIONS_CHANGED_METHOD, {
      changedAt: /* @__PURE__ */ new Date().toISOString(),
    });
  };
  const setDescriptor = async (next, mode) => {
    if (mode === 'remove') descriptors.delete(next.id);
    else descriptors.set(next.id, next);
    await broadcastChanged();
  };
  return {
    register(descriptor) {
      const next = {
        ...descriptor,
        updatedAt: /* @__PURE__ */ new Date().toISOString(),
      };
      descriptors.set(next.id, next);
      broadcastChanged();
      return next;
    },
    update(descriptorId, patch) {
      const current = descriptors.get(descriptorId);
      if (!current) return null;
      const next = {
        ...current,
        ...patch,
        updatedAt: /* @__PURE__ */ new Date().toISOString(),
      };
      descriptors.set(descriptorId, next);
      broadcastChanged();
      return next;
    },
    remove(descriptorId) {
      const current = descriptors.get(descriptorId);
      if (!current) return false;
      setDescriptor(current, 'remove');
      return true;
    },
    get(descriptorId) {
      return descriptors.get(descriptorId) ?? null;
    },
    list() {
      return Array.from(descriptors.values()).sort(sortDescriptors);
    },
    registerDriver(kind, driver) {
      drivers.set(kind, driver);
    },
    async sendRuntimeBroadcast(method, params) {
      await broadcast(method, params);
    },
    async handleList() {
      return { descriptors: this.list() };
    },
    async handleSubscribe() {
      return {
        descriptors: this.list(),
        notificationMethod: CONNECTIONS_CHANGED_METHOD,
      };
    },
    async handleAction(params) {
      const descriptor = descriptors.get(params.descriptorId);
      if (!descriptor) throw new Error(`Unknown connection descriptor: ${params.descriptorId}`);
      const driver = drivers.get(descriptor.kind);
      if (!driver?.action)
        throw new Error(`Connection kind "${descriptor.kind}" does not support actions`);
      return await driver.action(params.action, descriptor, this);
    },
    clear() {
      descriptors.clear();
      drivers.clear();
    },
  };
}
var singletonRegistry = createConnectionRegistry();
function getConnectionRegistry() {
  return singletonRegistry;
}
//#endregion
//#region src/bg-ws-connection.ts
/**
 * WebSocket connection management for the background service worker.
 * Handles connect/reconnect, heartbeat, and queued notifications.
 */
var DEFAULT_MCP_WS_URL = 'ws://127.0.0.1:22335/default';
var RECONNECT_BASE_MS$1 = 1e3;
var RECONNECT_MAX_MS$1 = 3e4;
var HEARTBEAT_INTERVAL_MS$1 = 15e3;
var MCP_WS_URL_KEY = 'mcpWsUrl';
var DEFAULT_BRIDGE_DESCRIPTOR_ID = 'bridge-default-ws';
var WS_FORWARD_EXTENSION_METHODS$1 = [
  BRIDGE_METHODS.extensionStatusGet,
  BRIDGE_METHODS.extensionReconnect,
  BRIDGE_METHODS.extensionPageToolsGet,
  BRIDGE_METHODS.extensionPageToolsTreeGet,
  BRIDGE_METHODS.extensionPageToolsDiscover,
  BRIDGE_METHODS.extensionPageToolsRefresh,
  BRIDGE_METHODS.extensionPageToolsSetEnabled,
  BRIDGE_METHODS.extensionToolDebugCall,
  BRIDGE_METHODS.extensionMainWorldHostEnsure,
  BRIDGE_METHODS.extensionAgentationMainEnsure,
  BRIDGE_METHODS.extensionContextManifestGet,
  BRIDGE_METHODS.extensionContextResourceRead,
  BRIDGE_METHODS.extensionContextSkillGet,
];
var ws = null;
var rpcPeer = null;
var wsReady = false;
var sessionId = null;
var connectPromise = null;
var reconnectAttempts = 0;
var reconnectTimer = null;
var wsEpoch = 0;
var heartbeatTimer = null;
var reconnectHandlers = null;
var manualDisconnect = false;
var queuedNotifications = [];
function registerDefaultBridgeDescriptor(status, patch = {}) {
  const registry = getConnectionRegistry();
  const current = registry.get(DEFAULT_BRIDGE_DESCRIPTOR_ID);
  const next = {
    id: DEFAULT_BRIDGE_DESCRIPTOR_ID,
    kind: 'bridge-default-ws',
    label: 'Bridge Default WS',
    endpoint: patch.endpoint ?? current?.endpoint ?? null,
    status,
    statusReason: patch.statusReason ?? current?.statusReason ?? null,
    capabilities: {
      reconnect: true,
      disconnect: true,
    },
    meta: {},
  };
  if (current) {
    registry.update(DEFAULT_BRIDGE_DESCRIPTOR_ID, {
      endpoint: next.endpoint,
      status: next.status,
      statusReason: next.statusReason,
      capabilities: next.capabilities,
      meta: next.meta,
    });
    return;
  }
  registry.register(next);
}
function getWsReady() {
  return wsReady;
}
function getSessionId() {
  return sessionId;
}
async function defaultOnExtensionRequest(method) {
  throw new RpcProtocolError(
    RPC_ERROR_CODES.methodNotFound,
    `Unhandled WS extension method: ${method}`,
  );
}
async function requestBridge(method, params, options) {
  if (!wsReady || !rpcPeer) throw new Error('Bridge is not connected');
  return await rpcPeer.request(method, params, options);
}
function queueNotification(method, params) {
  if (wsReady && rpcPeer) {
    rpcPeer.notify(method, params).catch((error) => log(`Failed to notify ${method}`, error));
    return;
  }
  queuedNotifications.push({
    method,
    params,
  });
}
function clearReconnectTimer$1() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}
function clearHeartbeatTimer$1() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}
function ensureHeartbeatTimer$1() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (!wsReady || !rpcPeer || !sessionId) return;
    rpcPeer.notify(BRIDGE_METHODS.sessionHeartbeat, { sentAt: Date.now() }).catch((error) => {
      log('Heartbeat failed', error);
    });
  }, HEARTBEAT_INTERVAL_MS$1);
}
async function flushQueuedNotifications() {
  if (!wsReady || !rpcPeer) return;
  while (queuedNotifications.length > 0) {
    const next = queuedNotifications.shift();
    if (!next) continue;
    await rpcPeer.notify(next.method, next.params);
  }
}
async function getWsUrl() {
  return (await storageLocalGet({ [MCP_WS_URL_KEY]: DEFAULT_MCP_WS_URL }))[MCP_WS_URL_KEY];
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS$1 * 2 ** reconnectAttempts, RECONNECT_MAX_MS$1);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!reconnectHandlers) return;
    connectWebSocket(
      reconnectHandlers.onToolCall,
      reconnectHandlers.onToolsList,
      reconnectHandlers.onTabsList,
      reconnectHandlers.onExtensionRequest,
    );
  }, delay);
  log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
}
function registerForwardedExtensionMethods$1(peer, onExtensionRequest) {
  for (const method of WS_FORWARD_EXTENSION_METHODS$1)
    peer.register(method, async (params) => await onExtensionRequest(method, params));
}
async function connectWebSocket(
  onToolCall,
  onToolsList,
  onTabsList,
  onExtensionRequest = defaultOnExtensionRequest,
) {
  reconnectHandlers = {
    onToolCall,
    onToolsList,
    onTabsList,
    onExtensionRequest,
  };
  manualDisconnect = false;
  if (connectPromise) return await connectPromise;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connectPromise = (async () => {
    const url = await getWsUrl();
    log('Connecting to WebSocket:', url);
    registerDefaultBridgeDescriptor('connecting', {
      endpoint: url,
      statusReason: 'connecting',
    });
    const socket = new WebSocket(url);
    const epoch = ++wsEpoch;
    ws = socket;
    wsReady = false;
    sessionId = null;
    rpcPeer = new RpcPeer({
      send: (message) => socket.send(message),
      defaultTimeoutMs: 3e4,
      getMeta: () => ({
        sessionId: sessionId ?? void 0,
        source: 'extension',
        target: 'bridge',
      }),
    });
    rpcPeer.register(BRIDGE_METHODS.bridgeToolCall, async (params, request) => {
      return await onToolCall(params, request.id);
    });
    rpcPeer.register(BRIDGE_METHODS.bridgeToolsList, async () => onToolsList());
    rpcPeer.register(BRIDGE_METHODS.bridgeTabsList, async () => onTabsList());
    registerForwardedExtensionMethods$1(rpcPeer, onExtensionRequest);
    await new Promise((resolve, reject) => {
      let settled = false;
      let opened = false;
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      socket.onopen = () => {
        opened = true;
        resolveOnce();
      };
      socket.onmessage = (event) => {
        if (ws !== socket || epoch !== wsEpoch || !rpcPeer) return;
        rpcPeer
          .receive(String(event.data))
          .catch((error) => log('Failed to process bridge message', error));
      };
      socket.onerror = (error) => {
        if (ws !== socket || epoch !== wsEpoch) return;
        log('WebSocket error', error, 'readyState=', socket.readyState, 'url=', socket.url);
        if (!opened) {
          rejectOnce(
            /* @__PURE__ */ new Error(
              `WebSocket errored before open (readyState=${socket.readyState})`,
            ),
          );
          socket.close();
        }
      };
      socket.onclose = (event) => {
        if (ws !== socket || epoch !== wsEpoch) return;
        log('WebSocket closed');
        if (!opened)
          rejectOnce(
            /* @__PURE__ */ new Error(`WebSocket closed before open (code=${event.code})`),
          );
        wsReady = false;
        sessionId = null;
        clearHeartbeatTimer$1();
        rpcPeer?.failAllPending('Bridge transport closed');
        ws = null;
        registerDefaultBridgeDescriptor(manualDisconnect ? 'closed' : 'error', {
          endpoint: url,
          statusReason: manualDisconnect
            ? 'disconnected-by-user'
            : `closed-before-reconnect:${event.code}`,
        });
        if (!manualDisconnect) scheduleReconnect();
      };
    });
    try {
      sessionId = (
        await rpcPeer.request(
          BRIDGE_METHODS.sessionRegister,
          {
            extensionId: chrome.runtime.id,
            version: chrome.runtime.getManifest().version,
          },
          { timeoutMs: 5e3 },
        )
      ).sessionId;
      wsReady = true;
      reconnectAttempts = 0;
      clearReconnectTimer$1();
      ensureHeartbeatTimer$1();
      await flushQueuedNotifications();
      registerDefaultBridgeDescriptor('connected', {
        endpoint: url,
        statusReason: 'ready',
      });
      log('Bridge session ready', sessionId);
    } catch (error) {
      log('Bridge session register failed', error);
      registerDefaultBridgeDescriptor('error', {
        endpoint: url,
        statusReason: error instanceof Error ? error.message : String(error),
      });
      socket.close();
    }
  })();
  try {
    await connectPromise;
  } finally {
    connectPromise = null;
  }
}
function forceReconnect(
  onToolCall,
  onToolsList,
  onTabsList,
  onExtensionRequest = defaultOnExtensionRequest,
) {
  clearReconnectTimer$1();
  clearHeartbeatTimer$1();
  reconnectAttempts = 0;
  wsReady = false;
  connectPromise = null;
  manualDisconnect = false;
  ws?.close();
  return connectWebSocket(onToolCall, onToolsList, onTabsList, onExtensionRequest);
}
/**
 * 手动断开默认 bridge。
 *
 * 这里要显式压住自动重连；否则 UI 点了 Disconnect，后台马上又自己连回去。
 */
function disconnectWebSocket() {
  manualDisconnect = true;
  clearReconnectTimer$1();
  clearHeartbeatTimer$1();
  reconnectAttempts = 0;
  wsReady = false;
  connectPromise = null;
  sessionId = null;
  rpcPeer?.failAllPending('Bridge transport closed by user');
  registerDefaultBridgeDescriptor('closed', {
    endpoint: ws?.url ?? null,
    statusReason: 'disconnected-by-user',
  });
  ws?.close();
  ws = null;
  rpcPeer = null;
}
function initDefaultWsUrl() {
  return storageLocalGet(MCP_WS_URL_KEY).then((data) => {
    registerDefaultBridgeDescriptor('closed', {
      endpoint:
        typeof data[MCP_WS_URL_KEY] === 'string' && data[MCP_WS_URL_KEY]
          ? String(data[MCP_WS_URL_KEY])
          : DEFAULT_MCP_WS_URL,
      statusReason: 'idle',
    });
    if (!data[MCP_WS_URL_KEY]) return storageLocalSet({ [MCP_WS_URL_KEY]: DEFAULT_MCP_WS_URL });
  });
}
function log(...args) {
  console.log('[PAGE-CONTEXT-BG]', ...args);
}
//#endregion
//#region src/bg-connection-descriptors.ts
function upsertTabScopedDescriptor(input) {
  const registry = getConnectionRegistry();
  const current = registry.get(input.id);
  const endpoint = input.endpoint ?? `tab:${input.tabId}`;
  if (current) {
    registry.update(input.id, {
      endpoint,
      status: input.status,
      statusReason: input.statusReason ?? null,
      capabilities: input.capabilities ?? current.capabilities,
      meta: {
        ...(current.meta ?? {}),
        tabId: input.tabId,
        ...(input.frameId != null ? { frameId: input.frameId } : {}),
      },
    });
    return;
  }
  registry.register({
    id: input.id,
    kind: input.kind,
    label: input.label,
    endpoint,
    status: input.status,
    statusReason: input.statusReason ?? null,
    capabilities: input.capabilities ?? {},
    meta: {
      tabId: input.tabId,
      ...(input.frameId != null ? { frameId: input.frameId } : {}),
    },
  });
}
function getPageToolsDescriptorId(tabId) {
  return `page-tools:${tabId}`;
}
function updatePageToolsDescriptor(tabId, status, statusReason) {
  upsertTabScopedDescriptor({
    id: getPageToolsDescriptorId(tabId),
    kind: 'page-tools',
    label: `Page Tools · tab ${tabId}`,
    tabId,
    status,
    statusReason,
    capabilities: {
      reconnect: true,
      disconnect: false,
    },
  });
}
function getMainWorldHostDescriptorId(tabId, frameId) {
  return frameId != null ? `main-world-host:${tabId}:${frameId}` : `main-world-host:${tabId}`;
}
function updateMainWorldHostDescriptor(tabId, frameId, status, statusReason) {
  upsertTabScopedDescriptor({
    id: getMainWorldHostDescriptorId(tabId, frameId),
    kind: 'main-world-host',
    label:
      frameId != null
        ? `Main World Host · tab ${tabId} · frame ${frameId}`
        : `Main World Host · tab ${tabId}`,
    tabId,
    frameId,
    status,
    statusReason,
    capabilities: {
      reconnect: true,
      disconnect: false,
    },
  });
}
function getAgentationDescriptorId(tabId, frameId) {
  return frameId != null
    ? `agentation-main-world-host:${tabId}:${frameId}`
    : `agentation-main-world-host:${tabId}`;
}
function updateAgentationDescriptor(tabId, frameId, status, statusReason) {
  upsertTabScopedDescriptor({
    id: getAgentationDescriptorId(tabId, frameId),
    kind: 'agentation-main-world-host',
    label:
      frameId != null
        ? `Agentation Main World · tab ${tabId} · frame ${frameId}`
        : `Agentation Main World · tab ${tabId}`,
    tabId,
    frameId,
    status,
    statusReason,
    capabilities: {
      reconnect: true,
      disconnect: false,
    },
  });
}
//#endregion
//#region src/bg-scoped-ws-connection.ts
/**
 * OpenCode 多 session WebSocket 管理器。
 *
 * 设计目标：
 * 1. 不动现有 default tenant 单连接实现，避免把旧链路一起改坏。
 * 2. tenantId === opencode sessionId，一条 session 对应一条独立 ws。
 * 3. 只管理“按 session 建连/断连/查询状态”这一件事，不掺入业务路由。
 *
 * 这符合 Linux 哲学：把“连接管理”和“业务处理”拆开，各自只做一件事。
 */
function getScopedBridgeDescriptorId(tenantId) {
  return `opencode-bridge-ws:${tenantId}`;
}
function upsertScopedBridgeDescriptor(tenantId, patch) {
  const registry = getConnectionRegistry();
  const descriptorId = getScopedBridgeDescriptorId(tenantId);
  const current = registry.get(descriptorId);
  if (current) {
    registry.update(descriptorId, {
      endpoint: patch.endpoint,
      status: patch.status,
      statusReason: patch.statusReason ?? null,
      meta: {
        ...(current.meta ?? {}),
        tenantId,
        bridgeSessionId: patch.bridgeSessionId ?? null,
      },
      capabilities: {
        reconnect: true,
        disconnect: true,
      },
    });
    return;
  }
  registry.register({
    id: descriptorId,
    kind: 'opencode-bridge-ws',
    label: `OpenCode Bridge WS · ${tenantId}`,
    endpoint: patch.endpoint,
    status: patch.status,
    statusReason: patch.statusReason ?? null,
    capabilities: {
      reconnect: true,
      disconnect: true,
    },
    meta: {
      tenantId,
      bridgeSessionId: patch.bridgeSessionId ?? null,
    },
  });
}
var WS_FORWARD_EXTENSION_METHODS = [
  BRIDGE_METHODS.extensionStatusGet,
  BRIDGE_METHODS.extensionReconnect,
  BRIDGE_METHODS.extensionPageToolsGet,
  BRIDGE_METHODS.extensionPageToolsTreeGet,
  BRIDGE_METHODS.extensionPageToolsDiscover,
  BRIDGE_METHODS.extensionPageToolsRefresh,
  BRIDGE_METHODS.extensionPageToolsSetEnabled,
  BRIDGE_METHODS.extensionToolDebugCall,
  BRIDGE_METHODS.extensionMainWorldHostEnsure,
  BRIDGE_METHODS.extensionAgentationMainEnsure,
  BRIDGE_METHODS.extensionContextManifestGet,
  BRIDGE_METHODS.extensionContextResourceRead,
  BRIDGE_METHODS.extensionContextSkillGet,
];
var RECONNECT_BASE_MS = 1e3;
var RECONNECT_MAX_MS = 3e4;
var HEARTBEAT_INTERVAL_MS = 15e3;
function registerForwardedExtensionMethods(peer, onExtensionRequest) {
  for (const method of WS_FORWARD_EXTENSION_METHODS)
    peer.register(method, async (params) => await onExtensionRequest(method, params));
}
function isOpenOrConnecting(ws) {
  return ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING;
}
function clearReconnectTimer(connection) {
  if (!connection.reconnectTimer) return;
  clearTimeout(connection.reconnectTimer);
  connection.reconnectTimer = null;
}
function clearHeartbeatTimer(connection) {
  if (!connection.heartbeatTimer) return;
  clearInterval(connection.heartbeatTimer);
  connection.heartbeatTimer = null;
}
function ensureHeartbeatTimer(connection) {
  if (connection.heartbeatTimer) return;
  connection.heartbeatTimer = setInterval(() => {
    if (!connection.ready || !connection.rpcPeer || !connection.bridgeSessionId) return;
    connection.rpcPeer
      .notify(BRIDGE_METHODS.sessionHeartbeat, { sentAt: Date.now() })
      .catch((error) => {
        console.warn(
          '[PAGE-CONTEXT-BG]',
          `[${connection.tenantId}] scoped heartbeat failed`,
          error,
        );
      });
  }, HEARTBEAT_INTERVAL_MS);
}
function closeScopedConnection(connection, reason) {
  connection.ready = false;
  connection.bridgeSessionId = null;
  clearReconnectTimer(connection);
  clearHeartbeatTimer(connection);
  connection.rpcPeer?.failAllPending(reason);
  connection.handlers = null;
  connection.connectPromise = null;
  if (connection.ws && connection.ws.readyState < WebSocket.CLOSING) connection.ws.close();
  upsertScopedBridgeDescriptor(connection.tenantId, {
    endpoint: connection.wsUrl ?? null,
    status: 'closed',
    statusReason: reason,
    bridgeSessionId: null,
  });
  connection.ws = null;
  connection.rpcPeer = null;
}
function createScopedBridgeWsManager() {
  const connections = /* @__PURE__ */ new Map();
  function getOrCreateConnection(tenantId, wsUrl) {
    const current = connections.get(tenantId);
    if (current && current.wsUrl === wsUrl) return current;
    if (current) closeScopedConnection(current, 'Replacing scoped bridge connection');
    const created = {
      tenantId,
      wsUrl,
      ws: null,
      rpcPeer: null,
      ready: false,
      bridgeSessionId: null,
      connectPromise: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      heartbeatTimer: null,
      handlers: null,
    };
    connections.set(tenantId, created);
    return created;
  }
  function scheduleReconnect(connection) {
    if (connection.reconnectTimer || !connection.handlers) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** connection.reconnectAttempts, RECONNECT_MAX_MS);
    connection.reconnectAttempts += 1;
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = null;
      if (!connection.handlers) return;
      connect(connection.tenantId, connection.wsUrl, connection.handlers);
    }, delay);
    console.warn(
      '[PAGE-CONTEXT-BG]',
      `[${connection.tenantId}] reconnecting scoped bridge in ${delay}ms`,
    );
  }
  async function connect(tenantId, wsUrl, handlers) {
    const connection = getOrCreateConnection(tenantId, wsUrl);
    connection.handlers = handlers;
    upsertScopedBridgeDescriptor(tenantId, {
      endpoint: wsUrl,
      status: 'connecting',
      statusReason: 'connecting',
      bridgeSessionId: null,
    });
    if (connection.connectPromise) return await connection.connectPromise;
    if (isOpenOrConnecting(connection.ws)) return;
    connection.connectPromise = (async () => {
      const socket = new WebSocket(wsUrl);
      connection.ws = socket;
      connection.ready = false;
      connection.bridgeSessionId = null;
      const peer = new RpcPeer({
        send: (message) => socket.send(message),
        defaultTimeoutMs: 3e4,
        getMeta: () => ({
          sessionId: connection.bridgeSessionId ?? void 0,
          source: 'extension',
          target: 'bridge',
        }),
      });
      connection.rpcPeer = peer;
      peer.register(BRIDGE_METHODS.bridgeToolCall, async (params, request) => {
        return await handlers.onToolCall(params, request.id);
      });
      peer.register(BRIDGE_METHODS.bridgeToolsList, async () => await handlers.onToolsList());
      peer.register(BRIDGE_METHODS.bridgeTabsList, async () => await handlers.onTabsList());
      registerForwardedExtensionMethods(peer, handlers.onExtensionRequest);
      await new Promise((resolve, reject) => {
        let settled = false;
        let opened = false;
        const resolveOnce = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const rejectOnce = (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        };
        socket.onopen = () => {
          opened = true;
          resolveOnce();
        };
        socket.onmessage = (event) => {
          if (connection.ws !== socket || connection.rpcPeer !== peer) return;
          peer.receive(String(event.data)).catch((error) => {
            console.warn('[PAGE-CONTEXT-BG]', `[${tenantId}] scoped bridge message failed`, error);
          });
        };
        socket.onerror = () => {
          if (!opened) {
            rejectOnce(
              /* @__PURE__ */ new Error(
                `Scoped WebSocket errored before open for session "${tenantId}"`,
              ),
            );
            socket.close();
          }
        };
        socket.onclose = (event) => {
          if (connection.ws !== socket) return;
          connection.ready = false;
          connection.bridgeSessionId = null;
          clearHeartbeatTimer(connection);
          peer.failAllPending(`Scoped bridge transport closed for "${tenantId}"`);
          upsertScopedBridgeDescriptor(tenantId, {
            endpoint: connection.wsUrl ?? null,
            status: 'error',
            statusReason: `closed-before-reconnect:${event.code}`,
            bridgeSessionId: null,
          });
          connection.ws = null;
          connection.rpcPeer = null;
          connection.connectPromise = null;
          if (!opened)
            rejectOnce(
              /* @__PURE__ */ new Error(
                `Scoped WebSocket closed before open for session "${tenantId}" (code=${event.code})`,
              ),
            );
          scheduleReconnect(connection);
        };
      });
      try {
        const result = await peer.request(
          BRIDGE_METHODS.sessionRegister,
          {
            extensionId: chrome.runtime.id,
            version: chrome.runtime.getManifest().version,
          },
          { timeoutMs: 5e3 },
        );
        connection.bridgeSessionId = result.sessionId;
        connection.ready = true;
        connection.reconnectAttempts = 0;
        clearReconnectTimer(connection);
        ensureHeartbeatTimer(connection);
        upsertScopedBridgeDescriptor(tenantId, {
          endpoint: wsUrl,
          status: 'connected',
          statusReason: 'ready',
          bridgeSessionId: result.sessionId,
        });
      } catch (error) {
        upsertScopedBridgeDescriptor(tenantId, {
          endpoint: wsUrl,
          status: 'error',
          statusReason: error instanceof Error ? error.message : String(error),
          bridgeSessionId: null,
        });
        socket.close();
        throw error;
      }
    })();
    try {
      await connection.connectPromise;
    } finally {
      connection.connectPromise = null;
    }
  }
  async function disconnect(tenantId) {
    const connection = connections.get(tenantId);
    if (!connection) {
      upsertScopedBridgeDescriptor(tenantId, {
        endpoint: null,
        status: 'closed',
        statusReason: 'not-found',
        bridgeSessionId: null,
      });
      return;
    }
    closeScopedConnection(connection, `Scoped bridge session "${tenantId}" disconnected`);
    connections.delete(tenantId);
  }
  function getStatus(tenantId) {
    const connection = connections.get(tenantId);
    return {
      tenantId,
      wsUrl: connection?.wsUrl ?? null,
      connected: Boolean(connection?.ready && connection.ws?.readyState === WebSocket.OPEN),
      bridgeSessionId: connection?.bridgeSessionId ?? null,
    };
  }
  function listStatuses() {
    return Array.from(connections.keys()).map((tenantId) => getStatus(tenantId));
  }
  function getPeer(tenantId) {
    return connections.get(tenantId)?.rpcPeer ?? null;
  }
  function isMethodNotFound(error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === RPC_ERROR_CODES.methodNotFound
    );
  }
  return {
    connect,
    disconnect,
    getStatus,
    listStatuses,
    getPeer,
    isMethodNotFound,
  };
}
//#endregion
//#region src/connections-endpoints.ts
/**
 * Connections 面板的 endpoint 配置读写。
 *
 * 规则：
 * - 新真相源是 `connections.endpoints.v1`
 * - 旧 `opencode.config.v1` 里的 endpoint 只做一次迁移
 * - session 相关历史字段继续留在旧 key，避免把既有恢复逻辑一起打坏
 */
var CONNECTION_ENDPOINTS_STORAGE_KEY = 'connections.endpoints.v1';
var LEGACY_OPENCODE_CONFIG_STORAGE_KEY = 'opencode.config.v1';
var DEFAULT_CONNECTION_ENDPOINTS = {
  opencodeBaseUrl: 'http://localhost:4096',
  bridgeBaseUrl: 'http://localhost:22334',
};
function normalizeEndpoint(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}
async function loadConnectionEndpoints() {
  const current = (
    await storageLocalGet({ [CONNECTION_ENDPOINTS_STORAGE_KEY]: DEFAULT_CONNECTION_ENDPOINTS })
  )[CONNECTION_ENDPOINTS_STORAGE_KEY];
  return {
    opencodeBaseUrl: normalizeEndpoint(
      current?.opencodeBaseUrl,
      DEFAULT_CONNECTION_ENDPOINTS.opencodeBaseUrl,
    ),
    bridgeBaseUrl: normalizeEndpoint(
      current?.bridgeBaseUrl,
      DEFAULT_CONNECTION_ENDPOINTS.bridgeBaseUrl,
    ),
  };
}
/**
 * 首次启动迁移旧 endpoint。
 *
 * 只复制 endpoint 字段；不动 lastSessionId/sessionId，避免改变旧恢复语义。
 */
async function migrateLegacyConnectionEndpoints() {
  const current = await storageLocalGet({
    [CONNECTION_ENDPOINTS_STORAGE_KEY]: void 0,
    [LEGACY_OPENCODE_CONFIG_STORAGE_KEY]: void 0,
  });
  if (current['connections.endpoints.v1']) return await loadConnectionEndpoints();
  const legacy = current[LEGACY_OPENCODE_CONFIG_STORAGE_KEY];
  const migrated = {
    opencodeBaseUrl: normalizeEndpoint(
      legacy?.opencodeBaseUrl,
      DEFAULT_CONNECTION_ENDPOINTS.opencodeBaseUrl,
    ),
    bridgeBaseUrl: normalizeEndpoint(
      legacy?.bridgeBaseUrl,
      DEFAULT_CONNECTION_ENDPOINTS.bridgeBaseUrl,
    ),
  };
  await storageLocalSet({ [CONNECTION_ENDPOINTS_STORAGE_KEY]: migrated });
  return migrated;
}
async function saveConnectionEndpoints(endpoints) {
  const normalized = {
    opencodeBaseUrl: normalizeEndpoint(
      endpoints.opencodeBaseUrl,
      DEFAULT_CONNECTION_ENDPOINTS.opencodeBaseUrl,
    ),
    bridgeBaseUrl: normalizeEndpoint(
      endpoints.bridgeBaseUrl,
      DEFAULT_CONNECTION_ENDPOINTS.bridgeBaseUrl,
    ),
  };
  await storageLocalSet({ [CONNECTION_ENDPOINTS_STORAGE_KEY]: normalized });
  return normalized;
}
//#endregion
export {
  initDefaultWsUrl as _,
  createScopedBridgeWsManager as a,
  requestBridge as b,
  updateAgentationDescriptor as c,
  DEFAULT_BRIDGE_DESCRIPTOR_ID as d,
  connectWebSocket as f,
  getWsReady as g,
  getSessionId as h,
  saveConnectionEndpoints as i,
  updateMainWorldHostDescriptor as l,
  forceReconnect as m,
  loadConnectionEndpoints as n,
  getScopedBridgeDescriptorId as o,
  disconnectWebSocket as p,
  migrateLegacyConnectionEndpoints as r,
  getAgentationDescriptorId as s,
  LEGACY_OPENCODE_CONFIG_STORAGE_KEY as t,
  updatePageToolsDescriptor as u,
  log as v,
  getConnectionRegistry as x,
  queueNotification as y,
};
