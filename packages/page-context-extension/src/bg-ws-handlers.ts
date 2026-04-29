/**
 * WS entry point and extension control method aggregator.
 * Handles only routing and orchestration; holds no implicit global state outside this module.
 */
import { BRIDGE_METHODS, RpcProtocolError, RPC_ERROR_CODES } from '@page-context/shared-protocol';

import {
  ensureAgentationMainOnTab,
  ensureMainWorldBridgeHostOnTab,
  getMainWorldInjectionTarget,
  type MainWorldBridgeHostInstaller,
} from '@page-context/agentation';
import {
  buildPageToolsTreeResponse,
  discoverPageToolsForTab,
  ensurePageToolPreferencesLoaded,
  filterManifestByPreferences,
  getAllTools,
  getBuiltinTools,
  getFlattenedPageToolsForTab,
  persistPageToolPreferences,
  publishBuiltinTools,
  publishPageToolsForTab,
  type PageToolState,
} from './bg-page-tools';
import {
  executePageToolInTab,
  getRawPageContextManifest,
  getPageContextSkill,
  readPageContextResource,
} from './bg-page-context';
import { executeToolCall } from '@page-context/tool-executor';
import { buildContextManifestFilterDebug } from './context-manifest-filter-debug';
import type { PageToolSpec } from '@page-context/tool-visibility';
import {
  getEnabledBuiltinTools,
  getEnabledToolsForTab,
  setScopeEnabled,
} from '@page-context/tool-visibility';
import { sendTabRequest } from './runtime-rpc';

type JsonRecord = Record<string, unknown>;

type WsOnToolCallHandler = (params: unknown, requestId: string) => Promise<unknown>;
type WsOnToolsListHandler = () => Promise<unknown>;
type WsOnTabsListHandler = () => Promise<unknown>;
type WsOnExtensionRequestHandler = (method: string, params: unknown) => Promise<unknown>;

interface WsBridgeConnectionDeps {
  getWsReady(): boolean;
  getSessionId(): string | null;
  forceReconnect(
    onToolCall: WsOnToolCallHandler,
    onToolsList: WsOnToolsListHandler,
    onTabsList: WsOnTabsListHandler,
    onExtensionRequest: WsOnExtensionRequestHandler,
  ): Promise<void>;
}

export interface ExtensionControlHandlers {
  buildExtensionStatusResponse(): {
    connected: boolean;
    wsUrl: null;
    pendingToolCalls: number;
    sessionId: string | null;
  };
  handleExtensionReconnect(): Promise<{ ok: true }>;
  handleExtensionPageToolsGet(params: unknown): { tools: PageToolSpec[] };
  handleExtensionPageToolsTreeGet(): Promise<unknown>;
  handleExtensionPageToolsRefresh(params: unknown): Promise<{ tools: PageToolSpec[] }>;
  handleExtensionContextManifestGet(params: unknown): Promise<unknown>;
  handleExtensionContextResourceRead(params: unknown): Promise<unknown>;
  handleExtensionContextSkillGet(params: unknown): Promise<unknown>;
  handleExtensionPageToolsSetEnabled(params: unknown): Promise<unknown>;
  handleExtensionToolDebugCall(
    params: unknown,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

export interface WsHandlers extends ExtensionControlHandlers {
  onToolCall: WsOnToolCallHandler;
  onToolsList: WsOnToolsListHandler;
  onTabsList: WsOnTabsListHandler;
  onBridgeWsExtensionRequest: WsOnExtensionRequestHandler;
}

interface CreateWsHandlersDeps {
  pageToolState: PageToolState;
  inFlightToolCalls: Map<string, string>;
  listTabs: () => Promise<
    Array<{ id: number | undefined; url?: string; title?: string; active?: boolean }>
  >;
  installPageContextBridgeHostInMainWorld: MainWorldBridgeHostInstaller;
  bridgeConnection: WsBridgeConnectionDeps;
}

export function createWsHandlers(deps: CreateWsHandlersDeps): WsHandlers {
  const executePageToolInTabForExecutor = async (
    tabId: number,
    name: string,
    args: Record<string, unknown>,
    namespace?: string,
    instanceId?: string,
  ) => {
    return await executePageToolInTab(tabId, name, args, namespace ?? 'page', instanceId);
  };

  async function onToolCall(params: unknown, requestId: string): Promise<unknown> {
    const call = params as { tool: string; args?: JsonRecord; tabId?: number };
    deps.inFlightToolCalls.set(requestId, call.tool);
    try {
      return await executeToolCall(call.tool, call.args ?? {}, call.tabId, {
        executePageToolInTab: executePageToolInTabForExecutor,
        sendTabRequest,
      });
    } finally {
      deps.inFlightToolCalls.delete(requestId);
    }
  }

  async function onToolsList(): Promise<unknown> {
    return getAllTools(deps.pageToolState);
  }

  async function onTabsList(): Promise<unknown> {
    return await deps.listTabs();
  }

  function buildExtensionStatusResponse() {
    return {
      connected: deps.bridgeConnection.getWsReady(),
      wsUrl: null,
      pendingToolCalls: deps.inFlightToolCalls.size,
      sessionId: deps.bridgeConnection.getSessionId(),
    };
  }

  async function handleExtensionReconnect(): Promise<{ ok: true }> {
    // Must pass the same set of callbacks back to the connection layer so reconnection behaves identically to the first connection.
    await deps.bridgeConnection.forceReconnect(
      onToolCall,
      onToolsList,
      onTabsList,
      onBridgeWsExtensionRequest,
    );
    return { ok: true };
  }

  function handleExtensionPageToolsGet(params: unknown): { tools: PageToolSpec[] } {
    const tabId = Number((params as { tabId?: number })?.tabId ?? 0);
    return { tools: getFlattenedPageToolsForTab(deps.pageToolState, tabId) };
  }

  async function handleExtensionPageToolsTreeGet(): Promise<unknown> {
    return await buildPageToolsTreeResponse(deps.pageToolState);
  }

  async function handleExtensionPageToolsRefresh(
    params: unknown,
  ): Promise<{ tools: PageToolSpec[] }> {
    const tabId = Number((params as { tabId?: number })?.tabId ?? 0);
    if (!tabId) {
      throw new Error('No tabId provided');
    }
    // Refresh and discovery share the same pipeline to prevent two implementations from drifting apart over time.
    await discoverPageToolsForTab(
      deps.pageToolState,
      tabId,
      deps.installPageContextBridgeHostInMainWorld,
      true,
    );
    return { tools: getFlattenedPageToolsForTab(deps.pageToolState, tabId) };
  }

  async function handleExtensionContextManifestGet(params: unknown): Promise<unknown> {
    const tabId = Number((params as { tabId?: number })?.tabId ?? 0);
    if (!tabId) {
      throw new Error('No tabId provided');
    }
    const rawManifest = await getRawPageContextManifest(tabId);
    const manifest = rawManifest
      ? filterManifestByPreferences(deps.pageToolState, tabId, rawManifest)
      : null;
    const enabledPageToolNames = new Set(
      getEnabledToolsForTab(
        deps.pageToolState.pageToolsByTab.get(tabId),
        deps.pageToolState.pageToolPreferences,
        tabId,
      ).map((tool) => tool.name),
    );
    const enabledBuiltinToolNames = new Set(
      getEnabledBuiltinTools(getBuiltinTools(), deps.pageToolState.pageToolPreferences).map(
        (tool) => tool.name,
      ),
    );
    return {
      manifest,
      rawManifest,
      debug: buildContextManifestFilterDebug(
        rawManifest,
        manifest,
        enabledPageToolNames,
        enabledBuiltinToolNames,
      ),
    };
  }

  async function handleExtensionContextResourceRead(params: unknown): Promise<unknown> {
    const payload = params as { tabId?: number; resourceId?: string };
    const tabId = Number(payload.tabId ?? 0);
    if (!tabId || !payload.resourceId) {
      throw new Error('tabId and resourceId are required');
    }
    return await readPageContextResource(tabId, payload.resourceId);
  }

  async function handleExtensionContextSkillGet(params: unknown): Promise<unknown> {
    const payload = params as { tabId?: number; skillId?: string; input?: JsonRecord };
    const tabId = Number(payload.tabId ?? 0);
    if (!tabId || !payload.skillId) {
      throw new Error('tabId and skillId are required');
    }
    return { prompt: await getPageContextSkill(tabId, payload.skillId, payload.input) };
  }

  async function handleExtensionPageToolsSetEnabled(params: unknown): Promise<unknown> {
    const payload = params as {
      root?: 'builtin' | 'page';
      tabId?: number;
      namespace?: string;
      instanceId?: string;
      toolName?: string;
      enabled: boolean;
    };
    const pageEntries =
      payload.root === 'builtin' || payload.tabId == null
        ? undefined
        : (deps.pageToolState.pageToolsByTab.get(payload.tabId) ?? []).filter((entry) => {
            if (payload.namespace && entry.namespace !== payload.namespace) {
              return false;
            }
            if (payload.instanceId && entry.instanceId !== payload.instanceId) {
              return false;
            }
            return true;
          });
    deps.pageToolState.pageToolPreferences = setScopeEnabled(
      deps.pageToolState.pageToolPreferences,
      payload,
      payload.enabled,
      {
        builtinTools: payload.root === 'builtin' ? getBuiltinTools() : undefined,
        pageEntries,
      },
    );
    await persistPageToolPreferences(deps.pageToolState);
    if (payload.root === 'builtin') {
      publishBuiltinTools(deps.pageToolState);
    } else if (payload.tabId != null) {
      publishPageToolsForTab(deps.pageToolState, payload.tabId);
    }
    return await buildPageToolsTreeResponse(deps.pageToolState);
  }

  async function handleExtensionToolDebugCall(
    params: unknown,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const payload = params as { toolName?: string; args?: JsonRecord; tabId?: number };
    if (!payload.toolName) {
      throw new Error('No toolName provided');
    }

    try {
      // Preserve original debug capability; permission scoping is still controlled by the bridge-side policy.
      const result = await executeToolCall(payload.toolName, payload.args ?? {}, payload.tabId, {
        executePageToolInTab: executePageToolInTabForExecutor,
        sendTabRequest,
      });
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function onBridgeWsExtensionRequest(method: string, params: unknown): Promise<unknown> {
    // WS and runtime share the same handler set so the same protocol method never has two different semantics.
    await ensurePageToolPreferencesLoaded(deps.pageToolState);

    switch (method) {
      case BRIDGE_METHODS.extensionStatusGet:
        return buildExtensionStatusResponse();
      case BRIDGE_METHODS.extensionReconnect:
        return await handleExtensionReconnect();
      case BRIDGE_METHODS.extensionPageToolsGet:
        return handleExtensionPageToolsGet(params);
      case BRIDGE_METHODS.extensionPageToolsTreeGet:
        return await handleExtensionPageToolsTreeGet();
      case BRIDGE_METHODS.extensionPageToolsDiscover:
      case BRIDGE_METHODS.extensionPageToolsRefresh:
        return await handleExtensionPageToolsRefresh(params);
      case BRIDGE_METHODS.extensionPageToolsSetEnabled:
        return await handleExtensionPageToolsSetEnabled(params);
      case BRIDGE_METHODS.extensionMainWorldHostEnsure: {
        const target = getMainWorldInjectionTarget(params);
        return await ensureMainWorldBridgeHostOnTab(
          target.tabId,
          deps.installPageContextBridgeHostInMainWorld,
          target.frameId,
        );
      }
      case BRIDGE_METHODS.extensionAgentationMainEnsure: {
        const target = getMainWorldInjectionTarget(params);
        return await ensureAgentationMainOnTab(target.tabId, target.frameId);
      }
      case BRIDGE_METHODS.extensionContextManifestGet:
        return await handleExtensionContextManifestGet(params);
      case BRIDGE_METHODS.extensionContextResourceRead:
        return await handleExtensionContextResourceRead(params);
      case BRIDGE_METHODS.extensionContextSkillGet:
        return await handleExtensionContextSkillGet(params);
      case BRIDGE_METHODS.extensionToolDebugCall:
        return await handleExtensionToolDebugCall(params);
      default:
        throw new RpcProtocolError(
          RPC_ERROR_CODES.methodNotFound,
          `Unhandled WS method: ${method}`,
        );
    }
  }

  return {
    onToolCall,
    onToolsList,
    onTabsList,
    onBridgeWsExtensionRequest,
    buildExtensionStatusResponse,
    handleExtensionReconnect,
    handleExtensionPageToolsGet,
    handleExtensionPageToolsTreeGet,
    handleExtensionPageToolsRefresh,
    handleExtensionContextManifestGet,
    handleExtensionContextResourceRead,
    handleExtensionContextSkillGet,
    handleExtensionPageToolsSetEnabled,
    handleExtensionToolDebugCall,
  };
}
