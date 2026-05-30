import {
  a as BRIDGE_METHODS,
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
  createScopedBridgeWsManager as a,
  saveConnectionEndpoints as i,
  loadConnectionEndpoints as n,
  getScopedBridgeDescriptorId as o,
  migrateLegacyConnectionEndpoints as r,
  getConnectionRegistry as s,
  LEGACY_OPENCODE_CONFIG_STORAGE_KEY as t,
};
