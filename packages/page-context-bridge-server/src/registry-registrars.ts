import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  FeedbackAnnotationClaimParams,
  FeedbackAnnotationCreateParams,
  FeedbackAnnotationDismissParams,
  FeedbackAnnotationReplyParams,
  FeedbackAnnotationResolveParams,
  FeedbackAnnotationUpdateParams,
  FeedbackStateDeltaParams,
  FeedbackStateSnapshotParams,
  BridgeToolProvider,
  ToolSpec,
  PageContextManifest,
} from '@page-context/shared-protocol';
import {
  ExtensionControlBridgeProvider,
  FeedbackControlBridgeProvider,
} from '@page-context/builtin-tools';
import { z } from 'zod';

import type {
  ExtensionRpcCaller,
  PageToolSpec,
  RemovableHandle,
  ServerHandleStore,
} from './registry-types.js';
import {
  createTextResponse,
  expandBuiltinToolNameAliases,
  getOrCreateServerHandleMap,
} from './registry-utils.js';

/**
 * Handle state for builtin / feedback / extension-control registrars.
 * After separating from tab-state, mcp-registry can compose by responsibility
 * without one domain touching another's state.
 */
export interface RegistryRegistrarState {
  builtinToolHandlesByServer: ServerHandleStore<RemovableHandle>;
  feedbackToolHandlesByServer: ServerHandleStore<RemovableHandle>;
  extensionToolControlHandlesByServer: ServerHandleStore<RemovableHandle>;
  enabledBuiltinToolNames: Set<string>;
}

export interface FeedbackRegistrarRpc {
  getFeedbackSnapshot(params: FeedbackStateSnapshotParams): unknown;
  getFeedbackDelta(params: FeedbackStateDeltaParams): unknown;
  createFeedbackAnnotation(params: FeedbackAnnotationCreateParams): unknown;
  updateFeedbackAnnotation(params: FeedbackAnnotationUpdateParams): unknown;
  claimFeedbackAnnotation(params: FeedbackAnnotationClaimParams): unknown;
  replyFeedbackAnnotation(params: FeedbackAnnotationReplyParams): unknown;
  resolveFeedbackAnnotation(params: FeedbackAnnotationResolveParams): unknown;
  dismissFeedbackAnnotation(params: FeedbackAnnotationDismissParams): unknown;
  listFeedbackSessions(tabId?: number): unknown;
  getFeedbackSession(sessionId: string): unknown | null;
  listFeedbackAnnotations(input: { tabId?: number; sessionId?: string }): unknown;
  getFeedbackAnnotation(annotationId: string): unknown | null;
}

export interface ExtensionControlRegistrarInput {
  state: RegistryRegistrarState;
  mcpServer: McpServer;
  extensionToolControlProvider: ExtensionControlBridgeProvider;
  rpcCaller: Pick<
    ExtensionRpcCaller,
    | 'getRuntimeStatus'
    | 'reconnectExtension'
    | 'debugToolCall'
    | 'ensureMainWorldHost'
    | 'ensureAgentationMain'
    | 'getContextManifestDebug'
    | 'getPageToolsTree'
    | 'setPageToolsEnabledBatch'
  >;
  refreshPageToolsForTab: (
    tabId: number,
  ) => Promise<{ tools: PageToolSpec[]; manifest: PageContextManifest | null }>;
  normalizePageToolName: (tool: { name: string; _namespace?: string }) => string;
}

export function createRegistryRegistrarState(input: {
  enabledBuiltinToolNames: Set<string>;
}): RegistryRegistrarState {
  return {
    builtinToolHandlesByServer: new WeakMap(),
    feedbackToolHandlesByServer: new WeakMap(),
    extensionToolControlHandlesByServer: new WeakMap(),
    enabledBuiltinToolNames: new Set(input.enabledBuiltinToolNames),
  };
}

export function syncBuiltinToolsOnServer(input: {
  state: RegistryRegistrarState;
  mcpServer: McpServer;
  toolProviders: BridgeToolProvider[];
  rpcCaller: Pick<ExtensionRpcCaller, 'sendToolCall'>;
}): void {
  const { state, mcpServer, toolProviders, rpcCaller } = input;
  const handles = getOrCreateServerHandleMap(state.builtinToolHandlesByServer, mcpServer);

  for (const [toolName, handle] of handles.entries()) {
    if (!state.enabledBuiltinToolNames.has(toolName)) {
      handle.remove();
      handles.delete(toolName);
    }
  }

  for (const provider of toolProviders) {
    const providerHandles = provider.registerOnBridge(
      (name, schema, handler) =>
        mcpServer.registerTool(
          name,
          schema as Parameters<typeof mcpServer.registerTool>[1],
          handler as Parameters<typeof mcpServer.registerTool>[2],
        ),
      (tool, args, tabId) => rpcCaller.sendToolCall(tool, args, tabId),
    );

    for (const [toolName, handle] of providerHandles.entries()) {
      if (!state.enabledBuiltinToolNames.has(toolName)) {
        // Legacy compat: immediately remove temp handles not in the enabled set to avoid a "register then invoke" window.
        handle.remove();
        continue;
      }
      if (handles.has(toolName)) {
        // Dedup: when a same-name handle already exists, discard the new one to keep the original stable until explicitly changed.
        handle.remove();
        continue;
      }
      handles.set(toolName, handle);
    }
  }
}

export function syncBuiltinToolsOnAllServers(input: {
  state: RegistryRegistrarState;
  mcpServers: Iterable<McpServer>;
  toolProviders: BridgeToolProvider[];
  rpcCaller: Pick<ExtensionRpcCaller, 'sendToolCall'>;
  toolSpecs: ToolSpec[];
}): void {
  const { state, mcpServers, toolProviders, rpcCaller, toolSpecs } = input;
  state.enabledBuiltinToolNames = expandBuiltinToolNameAliases(toolSpecs.map((tool) => tool.name));
  for (const server of mcpServers) {
    syncBuiltinToolsOnServer({ state, mcpServer: server, toolProviders, rpcCaller });
  }
}

export function registerFeedbackToolsOnServer(input: {
  state: RegistryRegistrarState;
  mcpServer: McpServer;
  feedbackControlProvider: FeedbackControlBridgeProvider;
  feedbackRpc: FeedbackRegistrarRpc;
}): void {
  const { state, mcpServer, feedbackControlProvider, feedbackRpc } = input;
  const handles = getOrCreateServerHandleMap(state.feedbackToolHandlesByServer, mcpServer);

  // Feedback tools use a "register once per server" model; repeated calls return immediately to guarantee idempotency.
  if (handles.size > 0) {
    return;
  }

  const register = (
    name: string,
    config: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
    handler: (
      args: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
  ) => {
    const handle = mcpServer.registerTool(
      name,
      config as unknown as Parameters<typeof mcpServer.registerTool>[1],
      handler as unknown as Parameters<typeof mcpServer.registerTool>[2],
    ) as RemovableHandle;
    handles.set(name, handle);
  };

  const feedbackControlHandles = feedbackControlProvider.registerOnBridge(
    (name, schema, handler) =>
      mcpServer.registerTool(
        name,
        schema as unknown as Parameters<typeof mcpServer.registerTool>[1],
        handler as unknown as Parameters<typeof mcpServer.registerTool>[2],
      ),
    {
      getFeedbackSnapshot: (params) => feedbackRpc.getFeedbackSnapshot(params),
      getFeedbackDelta: (params) => feedbackRpc.getFeedbackDelta(params),
      createFeedbackAnnotation: (params) => feedbackRpc.createFeedbackAnnotation(params),
      updateFeedbackAnnotation: (params) => feedbackRpc.updateFeedbackAnnotation(params),
      claimFeedbackAnnotation: (params) => feedbackRpc.claimFeedbackAnnotation(params),
      replyFeedbackAnnotation: (params) => feedbackRpc.replyFeedbackAnnotation(params),
      resolveFeedbackAnnotation: (params) => feedbackRpc.resolveFeedbackAnnotation(params),
      dismissFeedbackAnnotation: (params) => feedbackRpc.dismissFeedbackAnnotation(params),
    },
  );
  for (const [toolName, handle] of feedbackControlHandles.entries()) {
    handles.set(toolName, handle);
  }

  // The four below are legacy namespace query tools, retained for compatibility with existing prompt/tool call paths.
  register(
    'feedback_list_sessions',
    {
      description: 'List feedback sessions for current tenant.',
      inputSchema: {
        tabId: z.number().optional(),
      },
    },
    async (args) => {
      const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
      const sessions = feedbackRpc.listFeedbackSessions(tabId);
      return createTextResponse(JSON.stringify({ sessions }, null, 2));
    },
  );

  register(
    'feedback_get_session',
    {
      description: 'Get one feedback session with all annotations.',
      inputSchema: {
        sessionId: z.string().min(1),
      },
    },
    async (args) => {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
      const payload = feedbackRpc.getFeedbackSession(sessionId);
      if (!payload) {
        return createTextResponse(
          JSON.stringify({ error: `Session not found: ${sessionId}` }, null, 2),
        );
      }
      return createTextResponse(JSON.stringify(payload, null, 2));
    },
  );

  register(
    'feedback_list_annotations',
    {
      description: 'List feedback annotations by session or tab.',
      inputSchema: {
        sessionId: z.string().optional(),
        tabId: z.number().optional(),
      },
    },
    async (args) => {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
      const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
      const annotations = feedbackRpc.listFeedbackAnnotations({ sessionId, tabId });
      return createTextResponse(JSON.stringify({ annotations }, null, 2));
    },
  );

  register(
    'feedback_get_annotation',
    {
      description: 'Get one annotation with thread and linked capabilities.',
      inputSchema: {
        annotationId: z.string().min(1),
      },
    },
    async (args) => {
      const annotationId = typeof args.annotationId === 'string' ? args.annotationId : '';
      const annotation = feedbackRpc.getFeedbackAnnotation(annotationId);
      if (!annotation) {
        return createTextResponse(
          JSON.stringify({ error: `Annotation not found: ${annotationId}` }, null, 2),
        );
      }
      return createTextResponse(JSON.stringify({ annotation }, null, 2));
    },
  );
}

export function registerExtensionToolControlToolsOnServer(
  input: ExtensionControlRegistrarInput,
): void {
  const {
    state,
    mcpServer,
    extensionToolControlProvider,
    rpcCaller,
    refreshPageToolsForTab,
    normalizePageToolName,
  } = input;
  const handles = getOrCreateServerHandleMap(state.extensionToolControlHandlesByServer, mcpServer);

  if (handles.size > 0) {
    return;
  }

  const providerHandles = extensionToolControlProvider.registerOnBridge(
    (name, schema, handler) =>
      mcpServer.registerTool(
        name,
        schema as unknown as Parameters<typeof mcpServer.registerTool>[1],
        handler as unknown as Parameters<typeof mcpServer.registerTool>[2],
      ),
    {
      getRuntimeStatus: () => rpcCaller.getRuntimeStatus(),
      reconnectExtension: () => rpcCaller.reconnectExtension(),
      debugToolCall: (toolName, args, tabId) => rpcCaller.debugToolCall(toolName, args, tabId),
      ensureMainWorldHost: (tabId, frameId) => rpcCaller.ensureMainWorldHost(tabId, frameId),
      ensureAgentationMain: (tabId, frameId) => rpcCaller.ensureAgentationMain(tabId, frameId),
      getContextManifestDebug: (tabId) => rpcCaller.getContextManifestDebug(tabId),
      getPageToolsTree: () => rpcCaller.getPageToolsTree(),
      setPageToolsEnabledBatch: (updates) => rpcCaller.setPageToolsEnabledBatch(updates),
      refreshPageToolsForTab: (tabId) => refreshPageToolsForTab(tabId),
      normalizePageToolName: (tool) => normalizePageToolName(tool),
    },
  );
  for (const [toolName, handle] of providerHandles.entries()) {
    handles.set(toolName, handle);
  }
}
