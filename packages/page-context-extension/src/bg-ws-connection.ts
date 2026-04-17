/**
 * WebSocket connection management for the background service worker.
 * Handles connect/reconnect, heartbeat, and queued notifications.
 */

import {
  BRIDGE_METHODS,
  RpcPeer,
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

let ws: WebSocket | null = null;
let rpcPeer: RpcPeer | null = null;
let wsReady = false;
let sessionId: string | null = null;
let connectPromise: Promise<void> | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsEpoch = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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
    void connectWebSocket();
  }, delay);
  log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
}

export async function connectWebSocket(
  onToolCall: (params: unknown, requestId: string) => Promise<unknown>,
  onToolsList: () => Promise<unknown>,
  onTabsList: () => Promise<unknown>,
): Promise<void> {
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

    await new Promise<void>((resolve) => {
      socket.onopen = () => {
        resolve();
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
      };

      socket.onclose = () => {
        if (ws !== socket || epoch !== wsEpoch) {
          return;
        }
        log("WebSocket closed");
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
): Promise<void> {
  clearReconnectTimer();
  reconnectAttempts = 0;
  wsReady = false;
  connectPromise = null;
  ws?.close();
  return connectWebSocket(onToolCall, onToolsList, onTabsList);
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
