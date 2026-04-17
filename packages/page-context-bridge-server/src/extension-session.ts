/**
 * Extension WebSocket session management.
 * Handles incoming extension connections, RPC registration, and heartbeat watchdog.
 * Multi-tenant: each tenant ID gets its own isolated extension slot.
 */

import { WebSocket, WebSocketServer } from "ws";
import {
  BRIDGE_METHODS,
  type ContextResourcePayload,
  type ContextSkillPrompt,
  type PageContextManifest,
  RpcPeer,
} from "@page-context/shared-protocol";

import {
  validateParams,
  sessionRegisterParamsSchema,
  bridgePageEventParamsSchema,
  bridgePageToolsRegisteredParamsSchema,
  bridgeBuiltinToolsUpdatedParamsSchema,
  bridgePageToolsUnregisteredParamsSchema,
  bridgeTabActivatedParamsSchema,
  bridgeTabUpdatedParamsSchema,
} from "./rpc-params.js";
import type { McpRegistry, PageToolSpec } from "./mcp-registry.js";
import { log } from "./mcp-registry.js";
import { TenantManager } from "./tenant-manager.js";
import type { ExtensionSlot } from "./tenant-manager.js";

const TOOL_CALL_TIMEOUT_MS = 30_000;
const HEARTBEAT_GRACE_MS = 45_000;

let wsServerReady = false;

export function isWsServerReady(): boolean {
  return wsServerReady;
}

// ── Per-tenant helpers ──

function assertExtensionReady(tenantId: string, manager: TenantManager): ExtensionSlot {
  const tenant = manager.get(tenantId);
  if (!tenant?.extension) {
    throw new Error(`No extension connected for session "${tenantId}". Load the extension and ensure its service worker is running.`);
  }
  if (tenant.extension.ws.readyState !== WebSocket.OPEN) {
    throw new Error(`Extension for session "${tenantId}" is not open.`);
  }
  if (!tenant.extension.ready) {
    throw new Error(`Extension for session "${tenantId}" transport is connected but not ready yet; waiting for session.register.`);
  }
  return tenant.extension;
}

export async function sendToolCallToExtension<TResult = unknown>(
  tenantId: string,
  manager: TenantManager,
  tool: string,
  args: Record<string, unknown>,
  tabId?: number,
): Promise<TResult> {
  const current = assertExtensionReady(tenantId, manager);
  return await current.peer.request<TResult>(BRIDGE_METHODS.bridgeToolCall, { tool, args, tabId }, { timeoutMs: TOOL_CALL_TIMEOUT_MS });
}

export async function getContextManifestFromExtension(
  tenantId: string,
  manager: TenantManager,
  tabId: number,
): Promise<PageContextManifest | null> {
  const current = assertExtensionReady(tenantId, manager);
  const result = await current.peer.request<{ manifest: PageContextManifest | null }>(BRIDGE_METHODS.extensionContextManifestGet, { tabId }, { timeoutMs: TOOL_CALL_TIMEOUT_MS });
  return result.manifest;
}

export async function readContextResourceFromExtension(
  tenantId: string,
  manager: TenantManager,
  tabId: number,
  resourceId: string,
): Promise<ContextResourcePayload> {
  const current = assertExtensionReady(tenantId, manager);
  return await current.peer.request<ContextResourcePayload>(BRIDGE_METHODS.extensionContextResourceRead, { tabId, resourceId }, { timeoutMs: TOOL_CALL_TIMEOUT_MS });
}

export async function getContextSkillPromptFromExtension(
  tenantId: string,
  manager: TenantManager,
  tabId: number,
  skillId: string,
  input?: Record<string, unknown>,
): Promise<ContextSkillPrompt | null> {
  const current = assertExtensionReady(tenantId, manager);
  const result = await current.peer.request<{ prompt: ContextSkillPrompt | null }>(BRIDGE_METHODS.extensionContextSkillGet, { tabId, skillId, input }, { timeoutMs: TOOL_CALL_TIMEOUT_MS });
  return result.prompt;
}

// ── Per-tenant extension state creation ──

function createExtensionState(ws: WebSocket, registry: McpRegistry, tenantId: string, manager: TenantManager): ExtensionSlot {
  let sessionId: string | null = null;

  const slot: ExtensionSlot = {
    ws,
    peer: null as unknown as RpcPeer, // set below
    ready: false,
    sessionId: null,
    lastHeartbeatAt: Date.now(),
  };

  slot.peer = new RpcPeer({
    send: (message: string) => ws.send(message),
    defaultTimeoutMs: TOOL_CALL_TIMEOUT_MS,
    getMeta: () => ({
      sessionId: sessionId ?? undefined,
      source: "bridge",
      target: "extension",
    }),
  });

  const peer = slot.peer;

  peer.register(BRIDGE_METHODS.sessionRegister, async (params: unknown) => {
    const payload = validateParams(sessionRegisterParamsSchema, params, BRIDGE_METHODS.sessionRegister);
    slot.ready = true;
    sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    slot.sessionId = sessionId;
    slot.lastHeartbeatAt = Date.now();
    log(`[${tenantId}] Extension registered: ${payload.extensionId ?? "unknown"} v${payload.version ?? "unknown"} → session ${sessionId}`);
    return { sessionId, heartbeatIntervalMs: 15_000 };
  });

  peer.register(BRIDGE_METHODS.sessionHeartbeat, async () => {
    slot.lastHeartbeatAt = Date.now();
    return { receivedAt: Date.now() };
  });

  peer.register(BRIDGE_METHODS.bridgePageEvent, async (params: unknown) => {
    const payload = validateParams(bridgePageEventParamsSchema, params, BRIDGE_METHODS.bridgePageEvent);
    log(`[${tenantId}] PAGE_EVENT from tab`, payload.tabId ?? "unknown", JSON.stringify(payload.payload).slice(0, 200));
    return { ok: true };
  });

  peer.register(BRIDGE_METHODS.bridgePageToolsRegistered, async (params: unknown) => {
    const payload = validateParams(bridgePageToolsRegisteredParamsSchema, params, BRIDGE_METHODS.bridgePageToolsRegistered);
    if (payload.tabId != null) {
      registry.unregisterPageToolsFromAllServers(payload.tabId);
      registry.setPageTools(payload.tabId, payload.tools ?? []);
      registry.registerPageToolsOnAllServers(payload.tabId, payload.tools ?? []);
      const manifest = await getContextManifestFromExtension(tenantId, manager, payload.tabId).catch(() => null);
      registry.syncContextManifestOnAllServers(payload.tabId, manifest);
    }
    return { ok: true };
  });

  peer.register(BRIDGE_METHODS.bridgeBuiltinToolsUpdated, async (params: unknown) => {
    const payload = validateParams(bridgeBuiltinToolsUpdatedParamsSchema, params, BRIDGE_METHODS.bridgeBuiltinToolsUpdated);
    registry.syncBuiltinToolsOnAllServers(payload.tools ?? []);
    return { ok: true };
  });

  peer.register(BRIDGE_METHODS.bridgePageToolsUnregistered, async (params: unknown) => {
    const payload = validateParams(bridgePageToolsUnregisteredParamsSchema, params, BRIDGE_METHODS.bridgePageToolsUnregistered);
    if (payload.tabId != null) {
      registry.deletePageTools(payload.tabId);
      registry.unregisterPageToolsFromAllServers(payload.tabId);
      registry.syncContextManifestOnAllServers(payload.tabId, null);
    }
    return { ok: true };
  });

  peer.register(BRIDGE_METHODS.bridgeTabActivated, async (params: unknown) => {
    const payload = validateParams(bridgeTabActivatedParamsSchema, params, BRIDGE_METHODS.bridgeTabActivated);
    if (payload.tabId != null) {
      const manifest = await getContextManifestFromExtension(tenantId, manager, payload.tabId).catch(() => null);
      registry.syncContextManifestOnAllServers(payload.tabId, manifest);
    }
    return { ok: true };
  });
  peer.register(BRIDGE_METHODS.bridgeTabUpdated, async (params: unknown) => {
    const payload = validateParams(bridgeTabUpdatedParamsSchema, params, BRIDGE_METHODS.bridgeTabUpdated);
    if (payload.tabId != null) {
      const manifest = await getContextManifestFromExtension(tenantId, manager, payload.tabId).catch(() => null);
      registry.syncContextManifestOnAllServers(payload.tabId, manifest);
    }
    return { ok: true };
  });

  return slot;
}

// ── WebSocket server ──

export function startWebSocketServer(extWsPort: number, manager: TenantManager): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const wss = new WebSocketServer({ port: extWsPort, noServer: false });

      wss.on("error", (error: Error) => {
        wsServerReady = false;
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          log(`ERROR: Port ${extWsPort} is already in use.`);
        } else {
          log("ERROR: WebSocket server failed:", error instanceof Error ? error.message : String(error));
        }
        resolve(false);
      });

      wss.on("connection", (ws: WebSocket, req) => {
        const rawUrl = req.url ?? "/";
        const tenantId = TenantManager.extractTenantId(rawUrl);
        const tenant = manager.getOrCreate(tenantId);

        log(`[${tenantId}] Extension connecting from ${rawUrl}`);

        // Evict previous extension for THIS tenant only
        if (tenant.extension && tenant.extension.ws.readyState === WebSocket.OPEN) {
          tenant.extension.peer.failAllPending("Superseded by a newer extension connection");
          tenant.extension.ws.close(1012, "Superseded by a newer extension connection");
        }

        const slot = createExtensionState(ws, tenant.registry, tenantId, manager);
        tenant.extension = slot;

        ws.on("message", (data: WebSocket.RawData) => {
          void slot.peer.receive(data.toString()).catch((error: unknown) => {
            log(`[${tenantId}] Failed to process message`, error instanceof Error ? error.message : String(error));
          });
        });

        ws.on("close", () => {
          if (tenant.extension?.ws === ws) {
            slot.peer.failAllPending("Extension disconnected while request was in flight");
            tenant.extension = null;
            manager.touch(tenantId);
          }
          log(`[${tenantId}] Extension disconnected`);
        });
      });

      wss.on("listening", () => {
        wsServerReady = true;
        log(`Extension WebSocket server listening on ws://0.0.0.0:${extWsPort}`);
        resolve(true);
      });
    } catch (error) {
      log("ERROR: Failed to create WebSocket server:", error instanceof Error ? error.message : String(error));
      wsServerReady = false;
      resolve(false);
    }
  });
}

// ── Heartbeat watchdog ──

export function startHeartbeatWatchdog(manager: TenantManager): void {
  setInterval(() => {
    for (const tenant of manager.list()) {
      const slot = tenant.extension;
      if (!slot || !slot.ready) continue;
      if (Date.now() - slot.lastHeartbeatAt > HEARTBEAT_GRACE_MS) {
        log(`[${tenant.id}] Heartbeat timed out; closing stale session`);
        slot.peer.failAllPending("Extension heartbeat timed out");
        slot.ws.close(1011, "Heartbeat timed out");
        tenant.extension = null;
      }
    }
  }, 10_000);
}
