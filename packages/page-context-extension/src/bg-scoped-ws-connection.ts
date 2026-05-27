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

import {
  BRIDGE_METHODS,
  RpcPeer,
  type RpcProtocolError,
  RPC_ERROR_CODES,
} from '@page-context/shared-protocol';

interface SessionRegisterResult {
  sessionId: string;
  heartbeatIntervalMs?: number;
}

interface ScopedBridgeWsHandlers {
  onToolCall: (params: unknown, requestId: string) => Promise<unknown>;
  onToolsList: () => Promise<unknown>;
  onTabsList: () => Promise<unknown>;
  onExtensionRequest: (method: string, params: unknown) => Promise<unknown>;
}

interface ScopedBridgeConnection {
  tenantId: string;
  wsUrl: string;
  ws: WebSocket | null;
  rpcPeer: RpcPeer | null;
  ready: boolean;
  bridgeSessionId: string | null;
  connectPromise: Promise<void> | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  handlers: ScopedBridgeWsHandlers | null;
}

export interface ScopedBridgeStatus {
  tenantId: string;
  wsUrl: string | null;
  connected: boolean;
  bridgeSessionId: string | null;
}

// 这些方法必须和 default ws 链路保持一致；
// 否则 bridge 走 tenant 专属 ws 时，会出现“默认链路可用、opencode 链路 method not found”的假接口问题。
const WS_FORWARD_EXTENSION_METHODS = [
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
] as const;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

function registerForwardedExtensionMethods(
  peer: RpcPeer,
  onExtensionRequest: (method: string, params: unknown) => Promise<unknown>,
): void {
  for (const method of WS_FORWARD_EXTENSION_METHODS) {
    peer.register(method, async (params: unknown) => await onExtensionRequest(method, params));
  }
}

function isOpenOrConnecting(ws: WebSocket | null): boolean {
  return ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING;
}

function clearReconnectTimer(connection: ScopedBridgeConnection): void {
  if (!connection.reconnectTimer) {
    return;
  }
  clearTimeout(connection.reconnectTimer);
  connection.reconnectTimer = null;
}

function clearHeartbeatTimer(connection: ScopedBridgeConnection): void {
  if (!connection.heartbeatTimer) {
    return;
  }
  clearInterval(connection.heartbeatTimer);
  connection.heartbeatTimer = null;
}

function ensureHeartbeatTimer(connection: ScopedBridgeConnection): void {
  if (connection.heartbeatTimer) {
    return;
  }

  // scoped ws 和 default ws 一样，都要周期性上报 heartbeat；
  // 否则 bridge 只知道“连接曾经建立过”，不知道 extension 还活着。
  connection.heartbeatTimer = setInterval(() => {
    if (!connection.ready || !connection.rpcPeer || !connection.bridgeSessionId) {
      return;
    }
    connection.rpcPeer
      .notify(BRIDGE_METHODS.sessionHeartbeat, { sentAt: Date.now() })
      .catch((error: unknown) => {
        console.warn(
          '[PAGE-CONTEXT-BG]',
          `[${connection.tenantId}] scoped heartbeat failed`,
          error,
        );
      });
  }, HEARTBEAT_INTERVAL_MS);
}

function closeScopedConnection(connection: ScopedBridgeConnection, reason: string): void {
  connection.ready = false;
  connection.bridgeSessionId = null;
  clearReconnectTimer(connection);
  clearHeartbeatTimer(connection);
  connection.rpcPeer?.failAllPending(reason);
  connection.handlers = null;
  connection.connectPromise = null;
  if (connection.ws && connection.ws.readyState < WebSocket.CLOSING) {
    connection.ws.close();
  }
  connection.ws = null;
  connection.rpcPeer = null;
}

export function createScopedBridgeWsManager() {
  const connections = new Map<string, ScopedBridgeConnection>();

  function getOrCreateConnection(tenantId: string, wsUrl: string): ScopedBridgeConnection {
    const current = connections.get(tenantId);
    if (current && current.wsUrl === wsUrl) {
      return current;
    }

    if (current) {
      closeScopedConnection(current, 'Replacing scoped bridge connection');
    }

    const created: ScopedBridgeConnection = {
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

  function scheduleReconnect(connection: ScopedBridgeConnection): void {
    if (connection.reconnectTimer || !connection.handlers) {
      return;
    }

    const delay = Math.min(RECONNECT_BASE_MS * 2 ** connection.reconnectAttempts, RECONNECT_MAX_MS);
    connection.reconnectAttempts += 1;
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = null;
      if (!connection.handlers) {
        return;
      }
      void connect(connection.tenantId, connection.wsUrl, connection.handlers);
    }, delay);
    console.warn(
      '[PAGE-CONTEXT-BG]',
      `[${connection.tenantId}] reconnecting scoped bridge in ${delay}ms`,
    );
  }

  async function connect(
    tenantId: string,
    wsUrl: string,
    handlers: ScopedBridgeWsHandlers,
  ): Promise<void> {
    const connection = getOrCreateConnection(tenantId, wsUrl);
    connection.handlers = handlers;

    if (connection.connectPromise) {
      return await connection.connectPromise;
    }

    if (isOpenOrConnecting(connection.ws)) {
      return;
    }

    connection.connectPromise = (async () => {
      const socket = new WebSocket(wsUrl);
      connection.ws = socket;
      connection.ready = false;
      connection.bridgeSessionId = null;

      const peer = new RpcPeer({
        send: (message: string) => socket.send(message),
        defaultTimeoutMs: 30_000,
        getMeta: () => ({
          sessionId: connection.bridgeSessionId ?? undefined,
          source: 'extension',
          target: 'bridge',
        }),
      });
      connection.rpcPeer = peer;

      peer.register(BRIDGE_METHODS.bridgeToolCall, async (params: unknown, request) => {
        return await handlers.onToolCall(params, request.id);
      });
      peer.register(BRIDGE_METHODS.bridgeToolsList, async () => await handlers.onToolsList());
      peer.register(BRIDGE_METHODS.bridgeTabsList, async () => await handlers.onTabsList());
      registerForwardedExtensionMethods(peer, handlers.onExtensionRequest);

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let opened = false;
        const resolveOnce = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const rejectOnce = (error: Error) => {
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
          if (connection.ws !== socket || connection.rpcPeer !== peer) {
            return;
          }
          void peer.receive(String(event.data)).catch((error: unknown) => {
            console.warn('[PAGE-CONTEXT-BG]', `[${tenantId}] scoped bridge message failed`, error);
          });
        };

        socket.onerror = () => {
          if (!opened) {
            rejectOnce(new Error(`Scoped WebSocket errored before open for session "${tenantId}"`));
            socket.close();
          }
        };

        socket.onclose = (event) => {
          if (connection.ws !== socket) {
            return;
          }
          connection.ready = false;
          connection.bridgeSessionId = null;
          clearHeartbeatTimer(connection);
          peer.failAllPending(`Scoped bridge transport closed for "${tenantId}"`);
          connection.ws = null;
          connection.rpcPeer = null;
          connection.connectPromise = null;
          if (!opened) {
            rejectOnce(
              new Error(
                `Scoped WebSocket closed before open for session "${tenantId}" (code=${event.code})`,
              ),
            );
          }
          scheduleReconnect(connection);
        };
      });

      try {
        const result = await peer.request<SessionRegisterResult>(
          BRIDGE_METHODS.sessionRegister,
          {
            extensionId: chrome.runtime.id,
            version: chrome.runtime.getManifest().version,
          },
          { timeoutMs: 5_000 },
        );
        connection.bridgeSessionId = result.sessionId;
        connection.ready = true;
        connection.reconnectAttempts = 0;
        clearReconnectTimer(connection);
        ensureHeartbeatTimer(connection);
      } catch (error) {
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

  async function disconnect(tenantId: string): Promise<void> {
    const connection = connections.get(tenantId);
    if (!connection) {
      return;
    }
    closeScopedConnection(connection, `Scoped bridge session "${tenantId}" disconnected`);
    connections.delete(tenantId);
  }

  function getStatus(tenantId: string): ScopedBridgeStatus {
    const connection = connections.get(tenantId);
    return {
      tenantId,
      wsUrl: connection?.wsUrl ?? null,
      connected: Boolean(connection?.ready && connection.ws?.readyState === WebSocket.OPEN),
      bridgeSessionId: connection?.bridgeSessionId ?? null,
    };
  }

  function listStatuses(): ScopedBridgeStatus[] {
    return Array.from(connections.keys()).map((tenantId) => getStatus(tenantId));
  }

  function getPeer(tenantId: string): RpcPeer | null {
    return connections.get(tenantId)?.rpcPeer ?? null;
  }

  function isMethodNotFound(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as RpcProtocolError).code === RPC_ERROR_CODES.methodNotFound
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
