/**
 * MCP tool/resource/prompt registry facade.
 * Orchestrates only: delegates registration, tab state, and feedback domain logic to helper/service modules.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
  FeedbackPushAgentStatus,
  PageContextManifest,
} from "@page-context/shared-protocol";
import {
  BuiltinBridgeProvider,
  ExtensionControlBridgeProvider,
  FeedbackControlBridgeProvider,
  type PageToolEnableUpdate,
} from "@page-context/builtin-tools";

import {
  createFeedbackAgentPushAdapterFromEnv,
  createFeedbackPushAgentStatus,
  createFeedbackPushAgentStatusFromEnv,
  type FeedbackAgentPushAdapter,
} from "./feedback-agent-push.js";
import { createRegistryFeedbackService, type RegistryFeedbackService } from "./registry-feedback-service.js";
import {
  createRegistryRegistrarState,
  registerExtensionToolControlToolsOnServer,
  registerFeedbackToolsOnServer,
  syncBuiltinToolsOnAllServers,
  syncBuiltinToolsOnServer,
  type RegistryRegistrarState,
} from "./registry-registrars.js";
import {
  createRegistryTabState,
  deletePageTools,
  deriveFeedbackLinksFromTabState,
  refreshPageToolsForTab,
  registerContextManifestOnServer,
  registerPageToolsOnAllServers,
  registerPageToolsOnServer,
  setPageTools,
  syncContextManifestOnAllServers,
  syncTabStateToNewServer,
  unregisterContextManifestFromServer,
  unregisterPageToolsFromAllServers,
  unregisterPageToolsFromServer,
  type RegistryTabState,
} from "./registry-tab-state.js";
import type { ExtensionRpcCaller, PageToolSpec } from "./registry-types.js";
import { expandBuiltinToolNameAliases, log, normalizePageToolName } from "./registry-utils.js";
import { getRuntimeEnv } from "./runtime-env.js";

export type { PageToolSpec, ExtensionRpcCaller } from "./registry-types.js";
export type { PageToolEnableUpdate } from "@page-context/builtin-tools";
export { log } from "./registry-utils.js";

export interface McpRegistryOptions {
  feedbackAgentPushAdapter?: FeedbackAgentPushAdapter | null;
  feedbackAgentPushStatus?: FeedbackPushAgentStatus;
  env?: NodeJS.ProcessEnv;
}

export class McpRegistry {
  private readonly mcpServers = new Set<McpServer>();
  private readonly tabState: RegistryTabState = createRegistryTabState();
  private readonly toolProviders: BridgeToolProvider[] = [new BuiltinBridgeProvider()];
  private readonly extensionToolControlProvider = new ExtensionControlBridgeProvider();
  private readonly feedbackControlProvider = new FeedbackControlBridgeProvider();
  private readonly registrarState: RegistryRegistrarState;
  private readonly feedbackService: RegistryFeedbackService;

  constructor(
    private readonly rpcCaller: ExtensionRpcCaller,
    tenantId = "default",
    options: McpRegistryOptions = {},
  ) {
    const enabledBuiltinToolNames = expandBuiltinToolNameAliases(
      this.toolProviders.flatMap((provider) => provider.getToolSpecs().map((tool) => tool.name)),
    );
    this.registrarState = createRegistryRegistrarState({ enabledBuiltinToolNames });

    const runtimeEnv = options.env ?? getRuntimeEnv();
    // Compatibility: allow test injection; fall back to env-based auto-creation only when not injected.
    const feedbackAgentPushAdapter = options.feedbackAgentPushAdapter !== undefined
      ? options.feedbackAgentPushAdapter
      : createFeedbackAgentPushAdapterFromEnv(tenantId, runtimeEnv, (message) => log(message));
    const feedbackAgentPushStatusFallback = options.feedbackAgentPushStatus
      ?? (options.feedbackAgentPushAdapter !== undefined
        ? createFeedbackPushAgentStatus({
            enabled: feedbackAgentPushAdapter != null,
            mode: feedbackAgentPushAdapter ? "custom" : "disabled",
          })
        : createFeedbackPushAgentStatusFromEnv(runtimeEnv));

    this.feedbackService = createRegistryFeedbackService({
      tenantId,
      feedbackAgentPushAdapter,
      feedbackAgentPushStatusFallback,
      deriveFeedbackLinks: (tabId) => deriveFeedbackLinksFromTabState({ state: this.tabState, tabId }),
      logger: log,
    });
  }

  addServer(server: McpServer): void {
    this.mcpServers.add(server);
    this.registerFeedbackToolsOnServer(server);
    this.registerExtensionToolControlToolsOnServer(server);
  }

  removeServer(server: McpServer): void {
    this.mcpServers.delete(server);
    this.tabState.pageToolHandlesByServer.delete(server);
    this.registrarState.feedbackToolHandlesByServer.delete(server);
    this.registrarState.extensionToolControlHandlesByServer.delete(server);
  }

  getServerCount(): number {
    return this.mcpServers.size;
  }

  getPageToolsByTab(): Map<number, PageToolSpec[]> {
    // Compatibility: return internal Map reference to preserve caller's observation semantics on the same object.
    return this.tabState.pageToolsByTab;
  }

  getFeedbackSnapshot(params: FeedbackStateSnapshotParams = {}) {
    return this.feedbackService.getFeedbackSnapshot(params);
  }

  getFeedbackDelta(params: FeedbackStateDeltaParams) {
    return this.feedbackService.getFeedbackDelta(params);
  }

  createFeedbackAnnotation(params: FeedbackAnnotationCreateParams) {
    return this.feedbackService.createFeedbackAnnotation(params);
  }

  updateFeedbackAnnotation(params: FeedbackAnnotationUpdateParams) {
    return this.feedbackService.updateFeedbackAnnotation(params);
  }

  claimFeedbackAnnotation(params: FeedbackAnnotationClaimParams) {
    return this.feedbackService.claimFeedbackAnnotation(params);
  }

  replyFeedbackAnnotation(params: FeedbackAnnotationReplyParams) {
    return this.feedbackService.replyFeedbackAnnotation(params);
  }

  resolveFeedbackAnnotation(params: FeedbackAnnotationResolveParams) {
    return this.feedbackService.resolveFeedbackAnnotation(params);
  }

  dismissFeedbackAnnotation(params: FeedbackAnnotationDismissParams) {
    return this.feedbackService.dismissFeedbackAnnotation(params);
  }

  getFeedbackSession(sessionId: string) {
    return this.feedbackService.getFeedbackSession(sessionId);
  }

  listFeedbackSessions(tabId?: number) {
    return this.feedbackService.listFeedbackSessions(tabId);
  }

  listFeedbackAnnotations(input: { tabId?: number; sessionId?: string }) {
    return this.feedbackService.listFeedbackAnnotations(input);
  }

  getFeedbackAnnotation(annotationId: string) {
    return this.feedbackService.getFeedbackAnnotation(annotationId);
  }

  // ── Builtin tools ──

  syncBuiltinToolsOnServer(mcpServer: McpServer): void {
    syncBuiltinToolsOnServer({
      state: this.registrarState,
      mcpServer,
      toolProviders: this.toolProviders,
      rpcCaller: this.rpcCaller,
    });
  }

  syncBuiltinToolsOnAllServers(toolSpecs: ToolSpec[]): void {
    syncBuiltinToolsOnAllServers({
      state: this.registrarState,
      mcpServers: this.mcpServers,
      toolProviders: this.toolProviders,
      rpcCaller: this.rpcCaller,
      toolSpecs,
    });
  }

  registerFeedbackToolsOnServer(mcpServer: McpServer): void {
    registerFeedbackToolsOnServer({
      state: this.registrarState,
      mcpServer,
      feedbackControlProvider: this.feedbackControlProvider,
      feedbackRpc: {
        getFeedbackSnapshot: (params) => this.getFeedbackSnapshot(params),
        getFeedbackDelta: (params) => this.getFeedbackDelta(params),
        createFeedbackAnnotation: (params) => this.createFeedbackAnnotation(params),
        updateFeedbackAnnotation: (params) => this.updateFeedbackAnnotation(params),
        claimFeedbackAnnotation: (params) => this.claimFeedbackAnnotation(params),
        replyFeedbackAnnotation: (params) => this.replyFeedbackAnnotation(params),
        resolveFeedbackAnnotation: (params) => this.resolveFeedbackAnnotation(params),
        dismissFeedbackAnnotation: (params) => this.dismissFeedbackAnnotation(params),
        listFeedbackSessions: (tabId) => this.listFeedbackSessions(tabId),
        getFeedbackSession: (sessionId) => this.getFeedbackSession(sessionId),
        listFeedbackAnnotations: (input) => this.listFeedbackAnnotations(input),
        getFeedbackAnnotation: (annotationId) => this.getFeedbackAnnotation(annotationId),
      },
    });
  }

  registerExtensionToolControlToolsOnServer(mcpServer: McpServer): void {
    registerExtensionToolControlToolsOnServer({
      state: this.registrarState,
      mcpServer,
      extensionToolControlProvider: this.extensionToolControlProvider,
      rpcCaller: this.rpcCaller,
      refreshPageToolsForTab: (tabId) => this.refreshPageToolsForTab(tabId),
      normalizePageToolName: (tool) => normalizePageToolName(tool),
    });
  }

  // ── Page tools ──

  async refreshPageToolsForTab(tabId: number): Promise<{ tools: PageToolSpec[]; manifest: PageContextManifest | null }> {
    return refreshPageToolsForTab({
      state: this.tabState,
      mcpServers: this.mcpServers,
      tabId,
      rpcCaller: this.rpcCaller,
      logger: log,
    });
  }

  registerPageToolsOnServer(mcpServer: McpServer, tabId: number, tools: PageToolSpec[]): void {
    registerPageToolsOnServer({
      state: this.tabState,
      mcpServer,
      rpcCaller: this.rpcCaller,
      tabId,
      tools,
      logger: log,
    });
  }

  unregisterPageToolsFromServer(mcpServer: McpServer, tabId: number): void {
    unregisterPageToolsFromServer({
      state: this.tabState,
      mcpServer,
      tabId,
    });
  }

  registerPageToolsOnAllServers(tabId: number, tools: PageToolSpec[]): void {
    registerPageToolsOnAllServers({
      state: this.tabState,
      mcpServers: this.mcpServers,
      rpcCaller: this.rpcCaller,
      tabId,
      tools,
      logger: log,
    });
  }

  unregisterPageToolsFromAllServers(tabId: number): void {
    unregisterPageToolsFromAllServers({
      state: this.tabState,
      mcpServers: this.mcpServers,
      tabId,
    });
  }

  setPageTools(tabId: number, tools: PageToolSpec[]): void {
    setPageTools({
      state: this.tabState,
      tabId,
      tools,
    });
  }

  deletePageTools(tabId: number): void {
    deletePageTools({
      state: this.tabState,
      tabId,
    });
  }

  // ── Context manifest ──

  registerContextManifestOnServer(mcpServer: McpServer, tabId: number, manifest: PageContextManifest): void {
    registerContextManifestOnServer({
      state: this.tabState,
      mcpServer,
      rpcCaller: this.rpcCaller,
      tabId,
      manifest,
    });
  }

  unregisterContextManifestFromServer(mcpServer: McpServer, tabId: number): void {
    unregisterContextManifestFromServer({
      state: this.tabState,
      mcpServer,
      tabId,
    });
  }

  syncContextManifestOnAllServers(tabId: number, manifest: PageContextManifest | null): void {
    syncContextManifestOnAllServers({
      state: this.tabState,
      mcpServers: this.mcpServers,
      rpcCaller: this.rpcCaller,
      tabId,
      manifest,
    });
  }

  syncPageToolsToNewServer(mcpServer: McpServer): void {
    // Order compatibility: preserve legacy ordering to avoid brief capability inconsistency when connecting a new server.
    this.syncBuiltinToolsOnServer(mcpServer);
    this.registerFeedbackToolsOnServer(mcpServer);
    this.registerExtensionToolControlToolsOnServer(mcpServer);
    syncTabStateToNewServer({
      state: this.tabState,
      mcpServer,
      rpcCaller: this.rpcCaller,
      logger: log,
    });
  }
}
