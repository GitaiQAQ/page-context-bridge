/**
 * Extension WebSocket session management.
 * Handles incoming extension connections, RPC registration, and heartbeat watchdog.
 * Multi-tenant: each tenant ID gets its own isolated extension slot.
 */

import { WebSocket, WebSocketServer } from 'ws';
import {
  BRIDGE_METHODS,
  RPC_ERROR_CODES,
  type FeedbackAnnotationClaimParams,
  type FeedbackAnnotationCreateParams,
  type FeedbackAnnotationDismissParams,
  type FeedbackAnnotationReplyParams,
  type FeedbackAnnotationResolveParams,
  type FeedbackAnnotationUpdateParams,
  type FeedbackStateDeltaParams,
  type FeedbackStateSnapshotParams,
  type ContextResourcePayload,
  type ContextSkillPrompt,
  type PageContextManifest,
  RpcPeer,
  RpcProtocolError,
} from '@page-context/shared-protocol';

import {
  validateParams,
  sessionRegisterParamsSchema,
  bridgePageEventParamsSchema,
  bridgePageToolsRegisteredParamsSchema,
  bridgeBuiltinToolsUpdatedParamsSchema,
  bridgePageToolsUnregisteredParamsSchema,
  bridgeTabActivatedParamsSchema,
  bridgeTabUpdatedParamsSchema,
  feedbackStateSnapshotParamsSchema,
  feedbackStateDeltaParamsSchema,
  feedbackAnnotationCreateParamsSchema,
  feedbackAnnotationUpdateParamsSchema,
  feedbackAnnotationClaimParamsSchema,
  feedbackAnnotationReplyParamsSchema,
  feedbackAnnotationResolveParamsSchema,
  feedbackAnnotationDismissParamsSchema,
} from './rpc-params.js';
import type { McpRegistry, PageToolSpec } from './mcp-registry.js';
import { log } from './mcp-registry.js';
import { TenantManager } from './tenant-manager.js';
import type { ExtensionSlot } from './tenant-manager.js';

const TOOL_CALL_TIMEOUT_MS = 30_000;
const HEARTBEAT_GRACE_MS = 45_000;

let wsServerReady = false;

export interface PageToolEnableUpdate {
  root?: 'builtin' | 'page';
  tabId?: number;
  namespace?: string;
  instanceId?: string;
  toolName?: string;
  enabled: boolean;
}

export function isWsServerReady(): boolean {
  return wsServerReady;
}

// ── Per-tenant helpers ──

function assertExtensionReady(tenantId: string, manager: TenantManager): ExtensionSlot {
  const tenant = manager.get(tenantId);
  if (!tenant?.extension) {
    throw new Error(
      `No extension connected for session "${tenantId}". Load the extension and ensure its service worker is running.`,
    );
  }
  if (tenant.extension.ws.readyState !== WebSocket.OPEN) {
    throw new Error(`Extension for session "${tenantId}" is not open.`);
  }
  if (!tenant.extension.ready) {
    throw new Error(
      `Extension for session "${tenantId}" transport is connected but not ready yet; waiting for session.register.`,
    );
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
  return await current.peer.request<TResult>(
    BRIDGE_METHODS.bridgeToolCall,
    { tool, args, tabId },
    { timeoutMs: TOOL_CALL_TIMEOUT_MS },
  );
}

export async function getContextManifestFromExtension(
  tenantId: string,
  manager: TenantManager,
  tabId: number,
): Promise<PageContextManifest | null> {
  const payload = await getContextManifestDebugFromExtension(tenantId, manager, tabId);
  return payload.manifest;
}

export interface ContextManifestDebugPayload {
  manifest: PageContextManifest | null;
  rawManifest: PageContextManifest | null;
  debug: unknown | null;
}

export async function getContextManifestDebugFromExtension(
  tenantId: string,
  manager: TenantManager,
  tabId: number,
): Promise<ContextManifestDebugPayload> {
  const current = assertExtensionReady(tenantId, manager);
  const result = await current.peer.request<unknown>(
    BRIDGE_METHODS.extensionContextManifestGet,
    { tabId },
    { timeoutMs: TOOL_CALL_TIMEOUT_MS },
  );
  return normalizeContextManifestDebugPayload(result);
}

export async function getRuntimeStatusFromExtension(
  tenantId: string,
  manager: TenantManager,
): Promise<unknown> {
  const current = assertExtensionReady(tenantId, manager);
  return await current.peer.request<unknown>(
    BRIDGE_METHODS.extensionStatusGet,
    {},
    { timeoutMs: TOOL_CALL_TIMEOUT_MS },
  );
}

export async function reconnectExtensionFromBridge(
  tenantId: string,
  manager: TenantManager,
): Promise<unknown> {
  const current = assertExtensionReady(tenantId, manager);
  // Bridge only forwards reconnect command; retry backoff and session reconstruction remain the responsibility of extension's existing logic.
  return await current.peer.request<unknown>(
    BRIDGE_METHODS.extensionReconnect,
    {},
    { timeoutMs: TOOL_CALL_TIMEOUT_MS },
  );
}

export async function debugToolCallOnExtension(
  tenantId: string,
  manager: TenantManager,
  toolName: string,
  args: Record<string, unknown>,
  tabId?: number,
): Promise<unknown> {
  const current = assertExtensionReady(tenantId, manager);
  // Keep transparent: security validation is done at provider layer, here only ensures stable routing to extension's existing debug entry.
  return await current.peer.request<unknown>(
    BRIDGE_METHODS.extensionToolDebugCall,
    { toolName, args, tabId },
    { timeoutMs: TOOL_CALL_TIMEOUT_MS },
  );
}

export async function ensureMainWorldHostFromBridge(
  tenantId: string,
  manager: TenantManager,
  tabId: number,
  frameId?: number,
): Promise<unknown> {
  const current = assertExtensionReady(tenantId, manager);
  // No parameter fallback repair here; let extension side perform unified validation and return clear errors to avoid bridge/extension divergence.
  const params: { tabId: number; frameId?: number } = { tabId };
  if (typeof frameId === 'number') {
    params.frameId = frameId;
  }
  return await current.peer.request<unknown>(BRIDGE_METHODS.extensionMainWorldHostEnsure, params, {
    timeoutMs: TOOL_CALL_TIMEOUT_MS,
  });
}

export async function ensureAgentationMainFromBridge(
  tenantId: string,
  manager: TenantManager,
  tabId: number,
  frameId?: number,
): Promise<unknown> {
  const current = assertExtensionReady(tenantId, manager);
  const params: { tabId: number; frameId?: number } = { tabId };
  if (typeof frameId === 'number') {
    params.frameId = frameId;
  }
  return await current.peer.request<unknown>(BRIDGE_METHODS.extensionAgentationMainEnsure, params, {
    timeoutMs: TOOL_CALL_TIMEOUT_MS,
  });
}

export async function readContextResourceFromExtension(
  tenantId: string,
  manager: TenantManager,
  tabId: number,
  resourceId: string,
): Promise<ContextResourcePayload> {
  const current = assertExtensionReady(tenantId, manager);
  return await current.peer.request<ContextResourcePayload>(
    BRIDGE_METHODS.extensionContextResourceRead,
    { tabId, resourceId },
    { timeoutMs: TOOL_CALL_TIMEOUT_MS },
  );
}

export async function getContextSkillPromptFromExtension(
  tenantId: string,
  manager: TenantManager,
  tabId: number,
  skillId: string,
  input?: Record<string, unknown>,
): Promise<ContextSkillPrompt | null> {
  const current = assertExtensionReady(tenantId, manager);
  const result = await current.peer.request<{ prompt: ContextSkillPrompt | null }>(
    BRIDGE_METHODS.extensionContextSkillGet,
    { tabId, skillId, input },
    { timeoutMs: TOOL_CALL_TIMEOUT_MS },
  );
  return result.prompt;
}

export async function refreshPageToolsFromExtension(
  tenantId: string,
  manager: TenantManager,
  tabId: number,
): Promise<PageToolSpec[]> {
  const current = assertExtensionReady(tenantId, manager);
  const params = { tabId };

  try {
    const result = await current.peer.request<{ tools?: PageToolSpec[] }>(
      BRIDGE_METHODS.extensionPageToolsRefresh,
      params,
      { timeoutMs: TOOL_CALL_TIMEOUT_MS },
    );
    return result.tools ?? [];
  } catch (error) {
    // Backward compatibility for old extensions: fallback to discover when refresh is not implemented.
    if (!isRpcMethodNotFound(error)) {
      throw error;
    }
    const legacyResult = await current.peer.request<{ tools?: PageToolSpec[] }>(
      BRIDGE_METHODS.extensionPageToolsDiscover,
      params,
      { timeoutMs: TOOL_CALL_TIMEOUT_MS },
    );
    return legacyResult.tools ?? [];
  }
}

async function getPageToolsForTabFromExtension(
  tenantId: string,
  manager: TenantManager,
  tabId: number,
): Promise<PageToolSpec[]> {
  const current = assertExtensionReady(tenantId, manager);
  try {
    const result = await current.peer.request<{ tools?: PageToolSpec[] }>(
      BRIDGE_METHODS.extensionPageToolsGet,
      { tabId },
      { timeoutMs: TOOL_CALL_TIMEOUT_MS },
    );
    return result.tools ?? [];
  } catch (error) {
    if (!isRpcMethodNotFound(error)) {
      throw error;
    }
    return [];
  }
}

export async function getPageToolsTreeFromExtension(
  tenantId: string,
  manager: TenantManager,
): Promise<unknown> {
  const current = assertExtensionReady(tenantId, manager);
  return await current.peer.request<unknown>(
    BRIDGE_METHODS.extensionPageToolsTreeGet,
    {},
    { timeoutMs: TOOL_CALL_TIMEOUT_MS },
  );
}

export async function setPageToolsEnabledBatchOnExtension(
  tenantId: string,
  manager: TenantManager,
  updates: PageToolEnableUpdate[],
): Promise<unknown> {
  const current = assertExtensionReady(tenantId, manager);
  // In batch scenarios, reuse extension's existing setEnabled logic sequentially to ensure preference storage and publishing behavior remain consistent.
  if (updates.length === 0) {
    return await current.peer.request<unknown>(
      BRIDGE_METHODS.extensionPageToolsTreeGet,
      {},
      { timeoutMs: TOOL_CALL_TIMEOUT_MS },
    );
  }

  let latestTree: unknown = null;
  for (const update of updates) {
    latestTree = await current.peer.request<unknown>(
      BRIDGE_METHODS.extensionPageToolsSetEnabled,
      update,
      { timeoutMs: TOOL_CALL_TIMEOUT_MS },
    );
  }
  return latestTree;
}

function extractTabIdsWithRegisteredTools(payload: unknown): number[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const tabs = (payload as { tabs?: unknown }).tabs;
  if (!Array.isArray(tabs)) {
    return [];
  }
  return tabs
    .map((tab) => {
      if (!tab || typeof tab !== 'object') {
        return null;
      }
      const record = tab as { tabId?: unknown; totalTools?: unknown };
      const tabId = Number(record.tabId ?? 0);
      const totalTools = Number(record.totalTools ?? 0);
      if (!Number.isInteger(tabId) || tabId <= 0 || totalTools <= 0) {
        return null;
      }
      return tabId;
    })
    .filter((tabId): tabId is number => tabId != null);
}

async function syncRegistryStateFromConnectedExtension(
  tenantId: string,
  manager: TenantManager,
  registry: McpRegistry,
): Promise<void> {
  const currentTree = await getPageToolsTreeFromExtension(tenantId, manager).catch((error) => {
    throw new Error(
      `Failed to read extension tool tree after register: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const activeTabIds = new Set(extractTabIdsWithRegisteredTools(currentTree));
  const cachedTabIds = Array.from(registry.getPageToolsByTab().keys());

  for (const tabId of cachedTabIds) {
    if (activeTabIds.has(tabId)) {
      continue;
    }
    registry.deletePageTools(tabId);
    registry.unregisterPageToolsFromAllServers(tabId);
    registry.syncContextManifestOnAllServers(tabId, null);
  }

  for (const tabId of activeTabIds) {
    const tools = await getPageToolsForTabFromExtension(tenantId, manager, tabId);
    registry.unregisterPageToolsFromAllServers(tabId);
    registry.setPageTools(tabId, tools);
    registry.registerPageToolsOnAllServers(tabId, tools);
    const manifest = await getContextManifestFromExtension(tenantId, manager, tabId).catch(
      () => null,
    );
    registry.syncContextManifestOnAllServers(tabId, manifest);
  }
}

function isRpcMethodNotFound(error: unknown): boolean {
  return error instanceof RpcProtocolError && error.code === RPC_ERROR_CODES.methodNotFound;
}

function normalizeContextManifestDebugPayload(payload: unknown): ContextManifestDebugPayload {
  if (
    isRecord(payload) &&
    ('manifest' in payload || 'rawManifest' in payload || 'debug' in payload)
  ) {
    const manifest = normalizeManifestValue(payload.manifest);
    const rawManifest = normalizeManifestValue(payload.rawManifest) ?? manifest;
    return {
      manifest,
      rawManifest,
      debug: payload.debug ?? null,
    };
  }

  // Backward compatibility for old extensions: when only manifest object is returned, bridge layer fills in raw/debug fields.
  const legacyManifest = normalizeManifestValue(payload);
  return {
    manifest: legacyManifest,
    rawManifest: legacyManifest,
    debug: null,
  };
}

function normalizeManifestValue(value: unknown): PageContextManifest | null {
  if (value == null) {
    return null;
  }
  return isLikelyPageContextManifest(value) ? value : null;
}

function isLikelyPageContextManifest(value: unknown): value is PageContextManifest {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.version === 'string' &&
    typeof value.app === 'string' &&
    typeof value.route === 'string' &&
    typeof value.scene === 'string' &&
    Array.isArray(value.namespaces) &&
    Array.isArray(value.resources) &&
    Array.isArray(value.skills) &&
    typeof value.generatedAt === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ── Per-tenant extension state creation ──

export function createExtensionState(
  ws: WebSocket,
  registry: McpRegistry,
  tenantId: string,
  manager: TenantManager,
): ExtensionSlot {
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
      source: 'bridge',
      target: 'extension',
    }),
  });

  const peer = slot.peer;

  peer.register(BRIDGE_METHODS.sessionRegister, async (params: unknown) => {
    const payload = validateParams(
      sessionRegisterParamsSchema,
      params,
      BRIDGE_METHODS.sessionRegister,
    );
    slot.ready = true;
    sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    slot.sessionId = sessionId;
    slot.lastHeartbeatAt = Date.now();
    log(
      `[${tenantId}] Extension registered: ${payload.extensionId ?? 'unknown'} v${payload.version ?? 'unknown'} → session ${sessionId}`,
    );

    await syncRegistryStateFromConnectedExtension(tenantId, manager, registry).catch((error) => {
      log(
        `[${tenantId}] Failed to replay extension tools after register: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    return { sessionId, heartbeatIntervalMs: 15_000 };
  });

  peer.register(BRIDGE_METHODS.sessionHeartbeat, async () => {
    slot.lastHeartbeatAt = Date.now();
    return { receivedAt: Date.now() };
  });

  peer.register(BRIDGE_METHODS.bridgePageEvent, async (params: unknown) => {
    const payload = validateParams(
      bridgePageEventParamsSchema,
      params,
      BRIDGE_METHODS.bridgePageEvent,
    );
    log(
      `[${tenantId}] PAGE_EVENT from tab`,
      payload.tabId ?? 'unknown',
      JSON.stringify(payload.payload).slice(0, 200),
    );
    return { ok: true };
  });

  peer.register(BRIDGE_METHODS.bridgePageToolsRegistered, async (params: unknown) => {
    const payload = validateParams(
      bridgePageToolsRegisteredParamsSchema,
      params,
      BRIDGE_METHODS.bridgePageToolsRegistered,
    );
    if (payload.tabId != null) {
      registry.unregisterPageToolsFromAllServers(payload.tabId);
      registry.setPageTools(payload.tabId, payload.tools ?? []);
      registry.registerPageToolsOnAllServers(payload.tabId, payload.tools ?? []);
      const manifest = await getContextManifestFromExtension(
        tenantId,
        manager,
        payload.tabId,
      ).catch(() => null);
      registry.syncContextManifestOnAllServers(payload.tabId, manifest);
    }
    return { ok: true };
  });

  peer.register(BRIDGE_METHODS.bridgeBuiltinToolsUpdated, async (params: unknown) => {
    const payload = validateParams(
      bridgeBuiltinToolsUpdatedParamsSchema,
      params,
      BRIDGE_METHODS.bridgeBuiltinToolsUpdated,
    );
    registry.syncBuiltinToolsOnAllServers(payload.tools ?? []);
    return { ok: true };
  });

  peer.register(BRIDGE_METHODS.bridgePageToolsUnregistered, async (params: unknown) => {
    const payload = validateParams(
      bridgePageToolsUnregisteredParamsSchema,
      params,
      BRIDGE_METHODS.bridgePageToolsUnregistered,
    );
    if (payload.tabId != null) {
      registry.deletePageTools(payload.tabId);
      registry.unregisterPageToolsFromAllServers(payload.tabId);
      registry.syncContextManifestOnAllServers(payload.tabId, null);
    }
    return { ok: true };
  });

  peer.register(BRIDGE_METHODS.bridgeTabActivated, async (params: unknown) => {
    const payload = validateParams(
      bridgeTabActivatedParamsSchema,
      params,
      BRIDGE_METHODS.bridgeTabActivated,
    );
    if (payload.tabId != null) {
      const manifest = await getContextManifestFromExtension(
        tenantId,
        manager,
        payload.tabId,
      ).catch(() => null);
      registry.syncContextManifestOnAllServers(payload.tabId, manifest);
    }
    return { ok: true };
  });
  peer.register(BRIDGE_METHODS.bridgeTabUpdated, async (params: unknown) => {
    const payload = validateParams(
      bridgeTabUpdatedParamsSchema,
      params,
      BRIDGE_METHODS.bridgeTabUpdated,
    );
    if (payload.tabId != null) {
      const manifest = await getContextManifestFromExtension(
        tenantId,
        manager,
        payload.tabId,
      ).catch(() => null);
      registry.syncContextManifestOnAllServers(payload.tabId, manifest);
    }
    return { ok: true };
  });

  // All feedback-related RPCs are handled by registry to ensure extension and MCP see the same state.
  peer.register(BRIDGE_METHODS.feedbackStateSnapshot, async (params: unknown) => {
    const payload = validateParams(
      feedbackStateSnapshotParamsSchema,
      params ?? {},
      BRIDGE_METHODS.feedbackStateSnapshot,
    );
    return registry.getFeedbackSnapshot(payload as FeedbackStateSnapshotParams);
  });

  peer.register(BRIDGE_METHODS.feedbackStateDelta, async (params: unknown) => {
    const payload = validateParams(
      feedbackStateDeltaParamsSchema,
      params ?? {},
      BRIDGE_METHODS.feedbackStateDelta,
    );
    return registry.getFeedbackDelta(payload as FeedbackStateDeltaParams);
  });

  peer.register(BRIDGE_METHODS.feedbackAnnotationCreate, async (params: unknown) => {
    const payload = validateParams(
      feedbackAnnotationCreateParamsSchema,
      params,
      BRIDGE_METHODS.feedbackAnnotationCreate,
    );
    return registry.createFeedbackAnnotation(payload as FeedbackAnnotationCreateParams);
  });

  peer.register(BRIDGE_METHODS.feedbackAnnotationUpdate, async (params: unknown) => {
    const payload = validateParams(
      feedbackAnnotationUpdateParamsSchema,
      params,
      BRIDGE_METHODS.feedbackAnnotationUpdate,
    );
    return registry.updateFeedbackAnnotation(payload as FeedbackAnnotationUpdateParams);
  });

  peer.register(BRIDGE_METHODS.feedbackAnnotationClaim, async (params: unknown) => {
    const payload = validateParams(
      feedbackAnnotationClaimParamsSchema,
      params,
      BRIDGE_METHODS.feedbackAnnotationClaim,
    );
    return registry.claimFeedbackAnnotation(payload as FeedbackAnnotationClaimParams);
  });

  peer.register(BRIDGE_METHODS.feedbackAnnotationReply, async (params: unknown) => {
    const payload = validateParams(
      feedbackAnnotationReplyParamsSchema,
      params,
      BRIDGE_METHODS.feedbackAnnotationReply,
    );
    return registry.replyFeedbackAnnotation(payload as FeedbackAnnotationReplyParams);
  });

  peer.register(BRIDGE_METHODS.feedbackAnnotationResolve, async (params: unknown) => {
    const payload = validateParams(
      feedbackAnnotationResolveParamsSchema,
      params,
      BRIDGE_METHODS.feedbackAnnotationResolve,
    );
    return registry.resolveFeedbackAnnotation(payload as FeedbackAnnotationResolveParams);
  });

  peer.register(BRIDGE_METHODS.feedbackAnnotationDismiss, async (params: unknown) => {
    const payload = validateParams(
      feedbackAnnotationDismissParamsSchema,
      params,
      BRIDGE_METHODS.feedbackAnnotationDismiss,
    );
    return registry.dismissFeedbackAnnotation(payload as FeedbackAnnotationDismissParams);
  });

  return slot;
}

// ── WebSocket server ──

export function startWebSocketServer(extWsPort: number, manager: TenantManager): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const wss = new WebSocketServer({ port: extWsPort, noServer: false });

      wss.on('error', (error: Error) => {
        wsServerReady = false;
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          log(`ERROR: Port ${extWsPort} is already in use.`);
        } else {
          log(
            'ERROR: WebSocket server failed:',
            error instanceof Error ? error.message : String(error),
          );
        }
        resolve(false);
      });

      wss.on('connection', (ws: WebSocket, req) => {
        const rawUrl = req.url ?? '/';
        const tenantId = TenantManager.extractTenantId(rawUrl);
        const tenant = manager.getOrCreate(tenantId);

        log(`[${tenantId}] Extension connecting from ${rawUrl}`);

        // Evict previous extension for THIS tenant only
        if (tenant.extension && tenant.extension.ws.readyState === WebSocket.OPEN) {
          tenant.extension.peer.failAllPending('Superseded by a newer extension connection');
          tenant.extension.ws.close(1012, 'Superseded by a newer extension connection');
        }

        const slot = createExtensionState(ws, tenant.registry, tenantId, manager);
        tenant.extension = slot;

        ws.on('message', (data: WebSocket.RawData) => {
          void slot.peer.receive(data.toString()).catch((error: unknown) => {
            log(
              `[${tenantId}] Failed to process message`,
              error instanceof Error ? error.message : String(error),
            );
          });
        });

        ws.on('close', () => {
          if (tenant.extension?.ws === ws) {
            slot.peer.failAllPending('Extension disconnected while request was in flight');
            tenant.extension = null;
            manager.touch(tenantId);
          }
          log(`[${tenantId}] Extension disconnected`);
        });
      });

      wss.on('listening', () => {
        wsServerReady = true;
        log(`Extension WebSocket server listening on ws://0.0.0.0:${extWsPort}`);
        resolve(true);
      });
    } catch (error) {
      log(
        'ERROR: Failed to create WebSocket server:',
        error instanceof Error ? error.message : String(error),
      );
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
        slot.peer.failAllPending('Extension heartbeat timed out');
        slot.ws.close(1011, 'Heartbeat timed out');
        tenant.extension = null;
      }
    }
  }, 10_000);
}
