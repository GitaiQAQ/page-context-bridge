/**
 * WebSocket connection management for the background service worker.
 * Handles connect/reconnect, heartbeat, and queued notifications.
 */

import {
  BRIDGE_METHODS,
  RPC_ERROR_CODES,
  RpcPeer,
  RpcProtocolError,
} from "@page-context/shared-protocol";

const DEFAULT_MCP_WS_URL = "ws://127.0.0.1:22335/default";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MCP_WS_URL_KEY = "mcpWsUrl";

export interface SessionRegisterResult {
  sessionId: string;
  heartbeatIntervalMs?: number;
}

interface BridgeWsHandlers {
  onToolCall: (params: unknown, requestId: string) => Promise<unknown>;
  onToolsList: () => Promise<unknown>;
  onTabsList: () => Promise<unknown>;
  onExtensionRequest: (method: string, params: unknown) => Promise<unknown>;
}

// 这些方法由 bridge 主动 request 到 extension，用于 MCP 控制工具与上下文读取。
// 必须显式注册到 WS RpcPeer，否则 bridge 侧会收到 method not found（假接口风险）。
const WS_FORWARD_EXTENSION_METHODS = [
  BRIDGE_METHODS.extensionStatusGet,
  BRIDGE_METHODS.extensionReconnect,
  BRIDGE_METHODS.extensionPageToolsGet,
  BRIDGE_METHODS.extensionPageToolsTreeGet,
  BRIDGE_METHODS.extensionPageToolsDiscover,
  BRIDGE_METHODS.extensionPageToolsRefresh,
  BRIDGE_METHODS.extensionPageToolsSetEnabled,
  BRIDGE_METHODS.extensionMainWorldHostEnsure,
  BRIDGE_METHODS.extensionAgentationMainEnsure,
  BRIDGE_METHODS.extensionContextManifestGet,
  BRIDGE_METHODS.extensionContextResourceRead,
  BRIDGE_METHODS.extensionContextSkillGet,
] as const;

let ws: WebSocket | null = null;
let rpcPeer: RpcPeer | null = null;
let wsReady = false;
let sessionId: string | null = null;
let connectPromise: Promise<void> | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsEpoch = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectHandlers: BridgeWsHandlers | null = null;

const queuedNotifications: Array<{ method: string; params?: unknown }> = [];

export function getWsState() {
  return { ws, rpcPeer, wsReady, sessionId, connectPromise };
}

export function getWsReady(): boolean {
  return wsReady;
}

export function getSessionId(): string | null {
  return sessionId;
}

export function setSessionId(id: string | null): void {
  sessionId = id;
}

export function setWsReady(ready: boolean): void {
  wsReady = ready;
}

export function getRpcPeer(): RpcPeer | null {
  return rpcPeer;
}

async function defaultOnExtensionRequest(method: string): Promise<never> {
  throw new RpcProtocolError(RPC_ERROR_CODES.methodNotFound, `Unhandled WS extension method: ${method}`);
}

// 统一桥接请求入口：background 其它模块不需要直接操作 RpcPeer。
export async function requestBridge<TResult = unknown>(
  method: string,
  params?: unknown,
  options?: { timeoutMs?: number },
): Promise<TResult> {
  if (!wsReady || !rpcPeer) {
    throw new Error("Bridge is not connected");
  }
  return await rpcPeer.request<TResult>(method, params, options);
}

export function resetConnectPromise(): void {
  connectPromise = null;
}

export function queueNotification(method: string, params?: unknown): void {
  if (wsReady && rpcPeer) {
    rpcPeer.notify(method, params).catch((error: unknown) => log(`Failed to notify ${method}`, error));
    return;
  }

  queuedNotifications.push({ method, params });
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function ensureHeartbeatTimer(): void {
  if (heartbeatTimer) {
    return;
  }

  heartbeatTimer = setInterval(() => {
    if (!wsReady || !rpcPeer || !sessionId) {
      return;
    }
    rpcPeer.notify(BRIDGE_METHODS.sessionHeartbeat, { sentAt: Date.now() }).catch((error: unknown) => {
      log("Heartbeat failed", error);
    });
  }, HEARTBEAT_INTERVAL_MS);
}

async function flushQueuedNotifications(): Promise<void> {
  if (!wsReady || !rpcPeer) {
    return;
  }

  while (queuedNotifications.length > 0) {
    const next = queuedNotifications.shift();
    if (!next) {
      continue;
    }
    await rpcPeer.notify(next.method, next.params);
  }
}

async function getWsUrl(): Promise<string> {
  const result = await chrome.storage.local.get({
    [MCP_WS_URL_KEY]: DEFAULT_MCP_WS_URL,
  });
  return result[MCP_WS_URL_KEY] as string;
}

function scheduleReconnect(): void {
  if (reconnectTimer) {
    return;
  }

  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!reconnectHandlers) {
      return;
    }
    void connectWebSocket(
      reconnectHandlers.onToolCall,
      reconnectHandlers.onToolsList,
      reconnectHandlers.onTabsList,
      reconnectHandlers.onExtensionRequest,
    );
  }, delay);
  log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
}

function registerForwardedExtensionMethods(
  peer: RpcPeer,
  onExtensionRequest: (method: string, params: unknown) => Promise<unknown>,
): void {
  for (const method of WS_FORWARD_EXTENSION_METHODS) {
    peer.register(method, async (params: unknown) => await onExtensionRequest(method, params));
  }
}

export async function connectWebSocket(
  onToolCall: (params: unknown, requestId: string) => Promise<unknown>,
  onToolsList: () => Promise<unknown>,
  onTabsList: () => Promise<unknown>,
  onExtensionRequest: (method: string, params: unknown) => Promise<unknown> = defaultOnExtensionRequest,
): Promise<void> {
  reconnectHandlers = { onToolCall, onToolsList, onTabsList, onExtensionRequest };

  if (connectPromise) {
    return await connectPromise;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  connectPromise = (async () => {
    const url = await getWsUrl();
    const socket = new WebSocket(url);
    const epoch = ++wsEpoch;
    ws = socket;
    wsReady = false;
    sessionId = null;

    rpcPeer = new RpcPeer({
      send: (message: string) => socket.send(message),
      defaultTimeoutMs: 30_000,
      getMeta: () => ({
        sessionId: sessionId ?? undefined,
        source: "extension",
        target: "bridge",
      }),
    });

    rpcPeer.register(BRIDGE_METHODS.bridgeToolCall, async (params: unknown, request) => {
      return await onToolCall(params, request.id);
    });

    rpcPeer.register(BRIDGE_METHODS.bridgeToolsList, async () => onToolsList());
    rpcPeer.register(BRIDGE_METHODS.bridgeTabsList, async () => onTabsList());
    registerForwardedExtensionMethods(rpcPeer, onExtensionRequest);

    await new Promise<void>((resolve, reject) => {
      // 连接握手必须“只结算一次”：成功走 resolve，失败走 reject。
      // 否则 CONNECTING 阶段先报错/关闭会让 connectPromise 永远悬挂。
      let settled = false;
      let opened = false;
      const resolveOnce = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      const rejectOnce = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      socket.onopen = () => {
        opened = true;
        resolveOnce();
      };

      socket.onmessage = (event) => {
        if (ws !== socket || epoch !== wsEpoch || !rpcPeer) {
          return;
        }
        void rpcPeer.receive(String(event.data)).catch((error: unknown) => log("Failed to process bridge message", error));
      };

      socket.onerror = (error: Event) => {
        if (ws !== socket || epoch !== wsEpoch) {
          return;
        }
        log("WebSocket error", error);
        // 握手尚未完成时，主动结束本次握手，避免 connectPromise 卡死。
        if (!opened) {
          rejectOnce(new Error("WebSocket errored before open"));
          // 统一复用 onclose 的清理和重连逻辑，避免分叉处理。
          socket.close();
        }
      };

      socket.onclose = (event) => {
        if (ws !== socket || epoch !== wsEpoch) {
          return;
        }
        log("WebSocket closed");
        if (!opened) {
          rejectOnce(new Error(`WebSocket closed before open (code=${event.code})`));
        }
        wsReady = false;
        sessionId = null;
        rpcPeer?.failAllPending("Bridge transport closed");
        ws = null;
        scheduleReconnect();
      };
    });

    try {
      const result = await rpcPeer.request<SessionRegisterResult>(BRIDGE_METHODS.sessionRegister, {
        extensionId: chrome.runtime.id,
        version: chrome.runtime.getManifest().version,
      }, { timeoutMs: 5_000 });
      sessionId = result.sessionId;
      wsReady = true;
      reconnectAttempts = 0;
      clearReconnectTimer();
      ensureHeartbeatTimer();
      await flushQueuedNotifications();
      log("Bridge session ready", sessionId);
    } catch (error: unknown) {
      log("Bridge session register failed", error);
      socket.close();
    }
  })();

  try {
    await connectPromise;
  } finally {
    connectPromise = null;
  }
}

export function forceReconnect(
  onToolCall: (params: unknown, requestId: string) => Promise<unknown>,
  onToolsList: () => Promise<unknown>,
  onTabsList: () => Promise<unknown>,
  onExtensionRequest: (method: string, params: unknown) => Promise<unknown> = defaultOnExtensionRequest,
): Promise<void> {
  clearReconnectTimer();
  reconnectAttempts = 0;
  wsReady = false;
  connectPromise = null;
  ws?.close();
  return connectWebSocket(onToolCall, onToolsList, onTabsList, onExtensionRequest);
}

export function initDefaultWsUrl(): Promise<void> {
  return chrome.storage.local.get(MCP_WS_URL_KEY).then((data) => {
    if (!data[MCP_WS_URL_KEY]) {
      return chrome.storage.local.set({ [MCP_WS_URL_KEY]: DEFAULT_MCP_WS_URL });
    }
    return undefined;
  });
}

export function log(...args: unknown[]): void {
  console.log("[PAGE-CONTEXT-BG]", ...args);
}
