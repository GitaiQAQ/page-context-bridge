/**
 * MCP tool/resource/prompt registry management.
 * Handles registering and unregistering tools, resources, and prompts on McpServer instances.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type ContextResourceDescriptor,
  type ContextResourcePayload,
  type ContextSkillDescriptor,
  type ContextSkillPrompt,
  type FeedbackActor,
  type FeedbackAnnotationClaimParams,
  type FeedbackAnnotationCreateParams,
  type FeedbackAnnotationDismissParams,
  type FeedbackAnnotationReplyParams,
  type FeedbackAnnotationResolveParams,
  type FeedbackAnnotationUpdateParams,
  type FeedbackCapabilityLinks,
  type FeedbackPushAgentStatus,
  type FeedbackStateDeltaParams,
  type FeedbackStateSnapshotParams,
  type PageContextManifest,
  type BridgeToolProvider,
  type ToolSpec,
} from "@page-context/shared-protocol";
import {
  BuiltinBridgeProvider,
  ExtensionControlBridgeProvider,
  FeedbackControlBridgeProvider,
  type PageToolEnableUpdate,
} from "@page-context/builtin-tools";
import { z } from "zod";

import { buildRegisteredPageToolName } from "./page-tool-routing.js";
import { buildZodSchema, type JsonSchemaLike } from "./schema.js";
import { FeedbackStore } from "./feedback-store.js";
import {
  createFeedbackAgentPushAdapterFromEnv,
  createFeedbackPushAgentStatus,
  createFeedbackPushAgentStatusFromEnv,
  type FeedbackAgentPushAdapter,
  type FeedbackAgentPushStatusReader,
} from "./feedback-agent-push.js";
import { getRuntimeEnv } from "./runtime-env.js";

export interface PageToolSpec {
  name: string;
  description?: string;
  inputSchema?: JsonSchemaLike;
  _pageTool?: boolean;
  _namespace?: string;
  _instanceId?: string;
}

export type { PageToolEnableUpdate } from "@page-context/builtin-tools";

interface RegisteredPageTool {
  registeredTool: { remove: () => void };
  tabId: number;
}

interface RegisteredContextResource {
  registeredResource: { remove: () => void };
  tabId: number;
}

interface RegisteredContextPrompt {
  registeredPrompt: { remove: () => void };
  tabId: number;
}

export interface ExtensionRpcCaller {
  sendToolCall<TResult = unknown>(tool: string, args: Record<string, unknown>, tabId?: number): Promise<TResult>;
  getRuntimeStatus(): Promise<unknown>;
  reconnectExtension(): Promise<unknown>;
  ensureMainWorldHost(tabId: number, frameId?: number): Promise<unknown>;
  ensureAgentationMain(tabId: number, frameId?: number): Promise<unknown>;
  getContextManifest(tabId: number): Promise<PageContextManifest | null>;
  getContextManifestDebug(tabId: number): Promise<unknown>;
  refreshPageTools(tabId: number): Promise<PageToolSpec[]>;
  readContextResource(tabId: number, resourceId: string): Promise<ContextResourcePayload>;
  getContextSkillPrompt(tabId: number, skillId: string, input?: Record<string, unknown>): Promise<ContextSkillPrompt | null>;
  getPageToolsTree(): Promise<unknown>;
  setPageToolsEnabledBatch(updates: PageToolEnableUpdate[]): Promise<unknown>;
}

export interface McpRegistryOptions {
  feedbackAgentPushAdapter?: FeedbackAgentPushAdapter | null;
  feedbackAgentPushStatus?: FeedbackPushAgentStatus;
  env?: NodeJS.ProcessEnv;
}

export class McpRegistry {
  private readonly mcpServers = new Set<McpServer>();
  private readonly pageToolHandlesByServer = new WeakMap<McpServer, Map<string, RegisteredPageTool>>();
  private readonly builtinToolHandlesByServer = new WeakMap<McpServer, Map<string, { remove: () => void }>>();
  private readonly feedbackToolHandlesByServer = new WeakMap<McpServer, Map<string, { remove: () => void }>>();
  private readonly extensionToolControlHandlesByServer = new WeakMap<McpServer, Map<string, { remove: () => void }>>();
  private readonly contextResourceHandlesByServer = new WeakMap<McpServer, Map<string, RegisteredContextResource>>();
  private readonly contextPromptHandlesByServer = new WeakMap<McpServer, Map<string, RegisteredContextPrompt>>();
  private readonly pageToolsByTab = new Map<number, PageToolSpec[]>();
  private readonly pageContextManifestByTab = new Map<number, PageContextManifest>();
  private readonly feedbackStore: FeedbackStore;
  private readonly feedbackAgentPushAdapter: FeedbackAgentPushAdapter | null;
  private readonly feedbackAgentPushStatusFallback: FeedbackPushAgentStatus;

  private enabledBuiltinToolNames: Set<string>;
  private readonly toolProviders: BridgeToolProvider[] = [new BuiltinBridgeProvider()];
  private readonly extensionToolControlProvider = new ExtensionControlBridgeProvider();
  private readonly feedbackControlProvider = new FeedbackControlBridgeProvider();

  constructor(private readonly rpcCaller: ExtensionRpcCaller, tenantId = "default", options: McpRegistryOptions = {}) {
    this.enabledBuiltinToolNames = new Set(this.toolProviders.flatMap((p) => p.getToolSpecs().map((t) => t.name)));
    this.feedbackStore = new FeedbackStore(tenantId);
    const runtimeEnv = options.env ?? getRuntimeEnv();
    // 允许测试注入 adapter；未注入时才按环境变量自动创建。
    this.feedbackAgentPushAdapter = options.feedbackAgentPushAdapter !== undefined
      ? options.feedbackAgentPushAdapter
      : createFeedbackAgentPushAdapterFromEnv(tenantId, runtimeEnv, (message) => log(message));
    this.feedbackAgentPushStatusFallback = options.feedbackAgentPushStatus
      ?? (options.feedbackAgentPushAdapter !== undefined
        ? createFeedbackPushAgentStatus({
            enabled: this.feedbackAgentPushAdapter != null,
            mode: this.feedbackAgentPushAdapter ? "custom" : "disabled",
          })
        : createFeedbackPushAgentStatusFromEnv(runtimeEnv));
  }

  addServer(server: McpServer): void {
    this.mcpServers.add(server);
    this.registerFeedbackToolsOnServer(server);
    this.registerExtensionToolControlToolsOnServer(server);
  }

  removeServer(server: McpServer): void {
    this.mcpServers.delete(server);
    this.pageToolHandlesByServer.delete(server);
    this.feedbackToolHandlesByServer.delete(server);
    this.extensionToolControlHandlesByServer.delete(server);
  }

  getServerCount(): number {
    return this.mcpServers.size;
  }

  getPageToolsByTab(): Map<number, PageToolSpec[]> {
    return this.pageToolsByTab;
  }

  getFeedbackSnapshot(params: FeedbackStateSnapshotParams = {}) {
    const snapshot = this.feedbackStore.readSnapshot(params);
    return {
      ...snapshot,
      pushAgent: this.readFeedbackAgentPushStatus(),
    };
  }

  getFeedbackDelta(params: FeedbackStateDeltaParams) {
    return this.feedbackStore.readDelta(params);
  }

  private readFeedbackAgentPushStatus(): FeedbackPushAgentStatus {
    // adapter 可能是测试注入或未来扩展实现，优先走能力探测，保证可插拔。
    if (isFeedbackAgentPushStatusReader(this.feedbackAgentPushAdapter)) {
      return this.feedbackAgentPushAdapter.getPushAgentStatus();
    }
    return {
      ...this.feedbackAgentPushStatusFallback,
      lastLaunch: this.feedbackAgentPushStatusFallback.lastLaunch
        ? { ...this.feedbackAgentPushStatusFallback.lastLaunch }
        : null,
    };
  }

  createFeedbackAnnotation(params: FeedbackAnnotationCreateParams) {
    const derived = this.deriveFeedbackLinks(params.tabId);
    const created = this.feedbackStore.createAnnotation({
      actor: params.actor ?? createFeedbackActor({ source: "extension", id: "extension.user", displayName: "Extension User" }),
      body: params.body,
      priority: params.priority,
      tabId: params.tabId,
      url: params.url,
      title: params.title,
      selectedText: params.selectedText,
      // 透传 uiAnchor，保持 bridge 只做编排，不重复实现锚点清洗逻辑。
      uiAnchor: params.uiAnchor,
      pageInfoExtra: {
        app: derived.manifest?.app,
        scene: derived.manifest?.scene,
        route: derived.manifest?.route,
      },
      manifestSummary: derived.manifest
        ? {
            namespaceCount: derived.manifest.namespaces.length,
            resourceCount: derived.manifest.resources.length,
            skillCount: derived.manifest.skills.length,
          }
        : undefined,
      linkedCapabilities: derived.links,
    });
    // bridge 状态先落库，随后 fire-and-forget 触发本地 agent，保证仓库仍是唯一权威来源。
    try {
      this.feedbackAgentPushAdapter?.pushNewAnnotation(created);
    } catch (error) {
      log(`[feedback-agent-push] unexpected trigger error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return created;
  }

  updateFeedbackAnnotation(params: FeedbackAnnotationUpdateParams) {
    return this.feedbackStore.updateAnnotation({
      annotationId: params.annotationId,
      body: params.body,
      priority: params.priority,
      actor: params.actor ?? createFeedbackActor({ source: "extension", id: "extension.user", displayName: "Extension User" }),
    });
  }

  claimFeedbackAnnotation(params: FeedbackAnnotationClaimParams) {
    return this.feedbackStore.claimAnnotation({
      annotationId: params.annotationId,
      actor: params.actor ?? createFeedbackActor({ source: "agent", id: "mcp.agent", displayName: "MCP Agent" }),
    });
  }

  replyFeedbackAnnotation(params: FeedbackAnnotationReplyParams) {
    return this.feedbackStore.replyAnnotation({
      annotationId: params.annotationId,
      actor: params.actor ?? createFeedbackActor({ source: "agent", id: "mcp.agent", displayName: "MCP Agent" }),
      body: params.body,
      kind: params.kind,
    });
  }

  resolveFeedbackAnnotation(params: FeedbackAnnotationResolveParams) {
    return this.feedbackStore.resolveAnnotation({
      annotationId: params.annotationId,
      actor: params.actor ?? createFeedbackActor({ source: "agent", id: "mcp.agent", displayName: "MCP Agent" }),
      resolution: params.resolution,
    });
  }

  dismissFeedbackAnnotation(params: FeedbackAnnotationDismissParams) {
    return this.feedbackStore.dismissAnnotation({
      annotationId: params.annotationId,
      actor: params.actor ?? createFeedbackActor({ source: "agent", id: "mcp.agent", displayName: "MCP Agent" }),
      dismissReason: params.dismissReason,
    });
  }

  getFeedbackSession(sessionId: string) {
    const session = this.feedbackStore.getSession(sessionId);
    if (!session) {
      return null;
    }
    return {
      session,
      annotations: this.feedbackStore.listAnnotationsBySession(sessionId),
    };
  }

  listFeedbackSessions(tabId?: number) {
    return this.feedbackStore.listSessions(tabId);
  }

  listFeedbackAnnotations(input: { tabId?: number; sessionId?: string }) {
    if (input.sessionId) {
      return this.feedbackStore.listAnnotationsBySession(input.sessionId);
    }
    const sessions = this.feedbackStore.listSessions(input.tabId);
    return sessions.flatMap((session) => this.feedbackStore.listAnnotationsBySession(session.id));
  }

  getFeedbackAnnotation(annotationId: string) {
    return this.feedbackStore.getAnnotation(annotationId);
  }

  // ── Builtin tools ──

  syncBuiltinToolsOnServer(mcpServer: McpServer): void {
    let handles = this.builtinToolHandlesByServer.get(mcpServer);
    if (!handles) {
      handles = new Map();
      this.builtinToolHandlesByServer.set(mcpServer, handles);
    }

    for (const [toolName, handle] of handles.entries()) {
      if (!this.enabledBuiltinToolNames.has(toolName)) {
        handle.remove();
        handles.delete(toolName);
      }
    }

    for (const provider of this.toolProviders) {
      const providerHandles = provider.registerOnBridge(
        (name, schema, handler) => mcpServer.registerTool(name, schema as Parameters<typeof mcpServer.registerTool>[1], handler as Parameters<typeof mcpServer.registerTool>[2]),
        (tool, args, tabId) => this.rpcCaller.sendToolCall(tool, args, tabId),
      );

      for (const [toolName, handle] of providerHandles.entries()) {
        if (!this.enabledBuiltinToolNames.has(toolName)) {
          handle.remove();
          continue;
        }
        if (handles!.has(toolName)) {
          handle.remove();
          continue;
        }
        handles!.set(toolName, handle);
      }
    }
  }

  syncBuiltinToolsOnAllServers(toolSpecs: ToolSpec[]): void {
    this.enabledBuiltinToolNames = new Set(toolSpecs.map((tool) => tool.name));
    for (const server of this.mcpServers) {
      this.syncBuiltinToolsOnServer(server);
    }
  }

  // 反馈 MCP 工具在每个 server 上统一注册一次，底层都走同一个租户内存仓库。
  registerFeedbackToolsOnServer(mcpServer: McpServer): void {
    let handles = this.feedbackToolHandlesByServer.get(mcpServer);
    if (!handles) {
      handles = new Map();
      this.feedbackToolHandlesByServer.set(mcpServer, handles);
    }

    if (handles.size > 0) {
      return;
    }

    const register = (
      name: string,
      config: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
      handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
    ) => {
      const handle = mcpServer.registerTool(
        name,
        config as unknown as Parameters<typeof mcpServer.registerTool>[1],
        handler as unknown as Parameters<typeof mcpServer.registerTool>[2],
      ) as { remove: () => void };
      handles!.set(name, handle);
    };

    // 反馈控制新入口收敛到 provider：统一 namespace 命名，并保留旧别名兼容。
    const feedbackControlHandles = this.feedbackControlProvider.registerOnBridge(
      (name, schema, handler) => mcpServer.registerTool(
        name,
        schema as unknown as Parameters<typeof mcpServer.registerTool>[1],
        handler as unknown as Parameters<typeof mcpServer.registerTool>[2],
      ),
      {
        getFeedbackSnapshot: (params) => this.getFeedbackSnapshot(params),
        getFeedbackDelta: (params) => this.getFeedbackDelta(params),
        createFeedbackAnnotation: (params) => this.createFeedbackAnnotation(params),
        updateFeedbackAnnotation: (params) => this.updateFeedbackAnnotation(params),
        claimFeedbackAnnotation: (params) => this.claimFeedbackAnnotation(params),
        replyFeedbackAnnotation: (params) => this.replyFeedbackAnnotation(params),
        resolveFeedbackAnnotation: (params) => this.resolveFeedbackAnnotation(params),
        dismissFeedbackAnnotation: (params) => this.dismissFeedbackAnnotation(params),
      },
    );
    for (const [toolName, handle] of feedbackControlHandles.entries()) {
      handles.set(toolName, handle);
    }

    register(
      "feedback_list_sessions",
      {
        description: "List feedback sessions for current tenant.",
        inputSchema: {
          tabId: z.number().optional(),
        },
      },
      async (args) => {
        const tabId = typeof args.tabId === "number" ? args.tabId : undefined;
        const sessions = this.listFeedbackSessions(tabId);
        return createTextResponse(JSON.stringify({ sessions }, null, 2));
      },
    );

    register(
      "feedback_get_session",
      {
        description: "Get one feedback session with all annotations.",
        inputSchema: {
          sessionId: z.string().min(1),
        },
      },
      async (args) => {
        const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
        const payload = this.getFeedbackSession(sessionId);
        if (!payload) {
          return createTextResponse(JSON.stringify({ error: `Session not found: ${sessionId}` }, null, 2));
        }
        return createTextResponse(JSON.stringify(payload, null, 2));
      },
    );

    register(
      "feedback_list_annotations",
      {
        description: "List feedback annotations by session or tab.",
        inputSchema: {
          sessionId: z.string().optional(),
          tabId: z.number().optional(),
        },
      },
      async (args) => {
        const sessionId = typeof args.sessionId === "string" ? args.sessionId : undefined;
        const tabId = typeof args.tabId === "number" ? args.tabId : undefined;
        const annotations = this.listFeedbackAnnotations({ sessionId, tabId });
        return createTextResponse(JSON.stringify({ annotations }, null, 2));
      },
    );

    register(
      "feedback_get_annotation",
      {
        description: "Get one annotation with thread and linked capabilities.",
        inputSchema: {
          annotationId: z.string().min(1),
        },
      },
      async (args) => {
        const annotationId = typeof args.annotationId === "string" ? args.annotationId : "";
        const annotation = this.getFeedbackAnnotation(annotationId);
        if (!annotation) {
          return createTextResponse(JSON.stringify({ error: `Annotation not found: ${annotationId}` }, null, 2));
        }
        return createTextResponse(JSON.stringify({ annotation }, null, 2));
      },
    );

  }

  registerExtensionToolControlToolsOnServer(mcpServer: McpServer): void {
    let handles = this.extensionToolControlHandlesByServer.get(mcpServer);
    if (!handles) {
      handles = new Map();
      this.extensionToolControlHandlesByServer.set(mcpServer, handles);
    }

    if (handles.size > 0) {
      return;
    }

    // extension 工具树控制类能力集中到 builtin provider，registry 只负责注入依赖和存储句柄。
    const providerHandles = this.extensionToolControlProvider.registerOnBridge(
      (name, schema, handler) => mcpServer.registerTool(
        name,
        schema as unknown as Parameters<typeof mcpServer.registerTool>[1],
        handler as unknown as Parameters<typeof mcpServer.registerTool>[2],
      ),
      {
        getRuntimeStatus: () => this.rpcCaller.getRuntimeStatus(),
        reconnectExtension: () => this.rpcCaller.reconnectExtension(),
        ensureMainWorldHost: (tabId, frameId) => this.rpcCaller.ensureMainWorldHost(tabId, frameId),
        ensureAgentationMain: (tabId, frameId) => this.rpcCaller.ensureAgentationMain(tabId, frameId),
        getContextManifestDebug: (tabId) => this.rpcCaller.getContextManifestDebug(tabId),
        getPageToolsTree: () => this.rpcCaller.getPageToolsTree(),
        setPageToolsEnabledBatch: (updates) => this.rpcCaller.setPageToolsEnabledBatch(updates),
        refreshPageToolsForTab: (tabId) => this.refreshPageToolsForTab(tabId),
        normalizePageToolName: (tool) => normalizePageToolName(tool),
      },
    );
    for (const [toolName, handle] of providerHandles.entries()) {
      handles.set(toolName, handle);
    }
  }

  // ── Page tools ──

  async refreshPageToolsForTab(tabId: number): Promise<{ tools: PageToolSpec[]; manifest: PageContextManifest | null }> {
    // 主动刷新走“discover + 本地 registry 覆盖”路径，保证 agent 当前会话立即看到新工具。
    const tools = await this.rpcCaller.refreshPageTools(tabId);
    this.unregisterPageToolsFromAllServers(tabId);
    this.setPageTools(tabId, tools);
    this.registerPageToolsOnAllServers(tabId, tools);

    // manifest 同步失败不影响 tools 刷新，降级为 null，避免整个刷新动作回滚。
    const manifest = await this.rpcCaller.getContextManifest(tabId).catch((error) => {
      log(`Refresh manifest failed for tab ${tabId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    this.syncContextManifestOnAllServers(tabId, manifest);
    return { tools, manifest };
  }

  registerPageToolsOnServer(mcpServer: McpServer, tabId: number, tools: PageToolSpec[]): void {
    let handles = this.pageToolHandlesByServer.get(mcpServer);
    if (!handles) {
      handles = new Map();
      this.pageToolHandlesByServer.set(mcpServer, handles);
    }

    for (const tool of tools) {
      const actualToolName = normalizePageToolName(tool);
      const registeredToolName = buildRegisteredPageToolName(tabId, actualToolName);
      if (handles.has(registeredToolName)) {
        continue;
      }

      try {
        const registeredTool = mcpServer.registerTool(
          registeredToolName,
          {
            description: tool.description || `Page tool from tab ${tabId}`,
            inputSchema: buildZodSchema(tool.inputSchema),
            annotations: {
              readOnlyHint: actualToolName.includes("get_") || actualToolName.includes("list_") || actualToolName.includes("inspect_") || actualToolName.includes("search_") || actualToolName.includes("trace"),
            },
          },
          async (args) => {
            try {
              const result = await this.rpcCaller.sendToolCall(actualToolName, (args ?? {}) as Record<string, unknown>, tabId);
              return createTextResponse(JSON.stringify(result, null, 2));
            } catch (error) {
              return createTextResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
            }
          },
        );

        handles.set(registeredToolName, { registeredTool, tabId });
      } catch (error) {
        log("Failed to register page tool", registeredToolName, error instanceof Error ? error.message : String(error));
      }
    }
  }

  unregisterPageToolsFromServer(mcpServer: McpServer, tabId: number): void {
    const handles = this.pageToolHandlesByServer.get(mcpServer);
    if (!handles) {
      return;
    }

    for (const [toolName, entry] of handles.entries()) {
      if (entry.tabId !== tabId) {
        continue;
      }
      entry.registeredTool.remove();
      handles.delete(toolName);
    }
  }

  registerPageToolsOnAllServers(tabId: number, tools: PageToolSpec[]): void {
    for (const mcpServer of this.mcpServers) {
      this.registerPageToolsOnServer(mcpServer, tabId, tools);
    }
  }

  unregisterPageToolsFromAllServers(tabId: number): void {
    for (const mcpServer of this.mcpServers) {
      this.unregisterPageToolsFromServer(mcpServer, tabId);
    }
  }

  setPageTools(tabId: number, tools: PageToolSpec[]): void {
    this.pageToolsByTab.set(tabId, tools);
  }

  deletePageTools(tabId: number): void {
    this.pageToolsByTab.delete(tabId);
  }

  // ── Context manifest ──

  registerContextManifestOnServer(mcpServer: McpServer, tabId: number, manifest: PageContextManifest): void {
    let resourceHandles = this.contextResourceHandlesByServer.get(mcpServer);
    if (!resourceHandles) {
      resourceHandles = new Map();
      this.contextResourceHandlesByServer.set(mcpServer, resourceHandles);
    }

    let promptHandles = this.contextPromptHandlesByServer.get(mcpServer);
    if (!promptHandles) {
      promptHandles = new Map();
      this.contextPromptHandlesByServer.set(mcpServer, promptHandles);
    }

    for (const resource of manifest.resources) {
      const name = buildContextResourceName(tabId, resource);
      if (!resourceHandles.has(name)) {
        const registeredResource = mcpServer.registerResource(
          name,
          buildContextResourceUri(tabId, resource),
          {
            title: resource.title,
            description: resource.description,
            mimeType: resource.mimeType ?? "application/json",
          },
          async (uri) => {
            const payload = await this.rpcCaller.readContextResource(tabId, resource.id);
            return {
              contents: [
                {
                  uri: uri.href,
                  mimeType: payload.mimeType ?? resource.mimeType ?? "application/json",
                  text: payload.text,
                },
              ],
            };
          },
        );
        resourceHandles.set(name, { registeredResource, tabId });
      }
    }

    for (const skill of manifest.skills) {
      const name = buildContextPromptName(tabId, skill);
      if (!promptHandles.has(name)) {
        const registeredPrompt = mcpServer.registerPrompt(
          name,
          {
            title: skill.title,
            description: skill.description,
            argsSchema: {
              goal: z.string().optional(),
            },
          },
          async ({ goal }) => {
            const prompt = await this.rpcCaller.getContextSkillPrompt(tabId, skill.id, { goal });
            const promptText = prompt?.text ?? `Skill '${skill.id}' is unavailable.`;
            return {
              description: skill.description,
              messages: [
                {
                  role: "user",
                  content: {
                    type: "text",
                    text: promptText,
                  },
                },
              ],
            };
          },
        );
        promptHandles.set(name, { registeredPrompt, tabId });
      }
    }
  }

  unregisterContextManifestFromServer(mcpServer: McpServer, tabId: number): void {
    const resourceHandles = this.contextResourceHandlesByServer.get(mcpServer);
    if (resourceHandles) {
      for (const [name, entry] of resourceHandles.entries()) {
        if (entry.tabId !== tabId) {
          continue;
        }
        entry.registeredResource.remove();
        resourceHandles.delete(name);
      }
    }

    const promptHandles = this.contextPromptHandlesByServer.get(mcpServer);
    if (promptHandles) {
      for (const [name, entry] of promptHandles.entries()) {
        if (entry.tabId !== tabId) {
          continue;
        }
        entry.registeredPrompt.remove();
        promptHandles.delete(name);
      }
    }
  }

  syncContextManifestOnAllServers(tabId: number, manifest: PageContextManifest | null): void {
    if (manifest) {
      this.pageContextManifestByTab.set(tabId, manifest);
    } else {
      this.pageContextManifestByTab.delete(tabId);
    }

    for (const server of this.mcpServers) {
      this.unregisterContextManifestFromServer(server, tabId);
      if (manifest) {
        this.registerContextManifestOnServer(server, tabId, manifest);
      }
    }
  }

  private deriveFeedbackLinks(tabId: number): {
    links: FeedbackCapabilityLinks;
    manifest: PageContextManifest | null;
  } {
    const manifest = this.pageContextManifestByTab.get(tabId) ?? null;
    const pageTools = this.pageToolsByTab.get(tabId) ?? [];

    const namespaceHints = manifest?.namespaces.map((item) => item.namespace) ?? [];
    const relatedResourceIds = manifest?.resources.map((item) => item.id) ?? [];
    const relatedSkillIds = manifest?.skills.map((item) => item.id) ?? [];
    const relatedToolNames = pageTools.map((tool) => normalizePageToolName(tool));

    const linkReasons: string[] = [];
    if (manifest) {
      linkReasons.push("manifest.namespaces", "manifest.resources", "manifest.skills");
    }
    if (relatedToolNames.length > 0) {
      linkReasons.push("page-tools.registered");
    }

    return {
      links: {
        namespaceHints: uniqueStrings(namespaceHints),
        relatedToolNames: uniqueStrings(relatedToolNames),
        relatedResourceIds: uniqueStrings(relatedResourceIds),
        relatedSkillIds: uniqueStrings(relatedSkillIds),
        linkReasons: uniqueStrings(linkReasons),
      },
      manifest,
    };
  }

  syncPageToolsToNewServer(mcpServer: McpServer): void {
    this.syncBuiltinToolsOnServer(mcpServer);
    this.registerFeedbackToolsOnServer(mcpServer);
    this.registerExtensionToolControlToolsOnServer(mcpServer);
    for (const [tabId, tools] of this.pageToolsByTab.entries()) {
      this.registerPageToolsOnServer(mcpServer, tabId, tools);
    }
    for (const [tabId, manifest] of this.pageContextManifestByTab.entries()) {
      this.registerContextManifestOnServer(mcpServer, tabId, manifest);
    }
  }
}

// ── Helpers ──

function normalizePageToolName(tool: PageToolSpec): string {
  const namespace = tool._namespace;
  let toolName = tool.name;
  if (namespace && toolName.startsWith(`${namespace}.`)) {
    const trimmed = toolName.slice(namespace.length + 1);
    if (trimmed.startsWith(`${namespace}_`) || trimmed.startsWith(`${namespace}.`)) {
      toolName = trimmed;
    }
  }
  return toolName;
}

function buildContextResourceName(tabId: number, resource: ContextResourceDescriptor): string {
  return `tab.${tabId}.resource.${resource.namespace}.${resource.id.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
}

function buildContextResourceUri(tabId: number, resource: ContextResourceDescriptor): string {
  return `context://tab/${tabId}/resource/${resource.namespace}/${encodeURIComponent(resource.id)}`;
}

function buildContextPromptName(tabId: number, skill: ContextSkillDescriptor): string {
  return `tab.${tabId}.skill.${skill.namespace}.${skill.id.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function createFeedbackActor(input: FeedbackActor): FeedbackActor {
  return {
    source: input.source,
    id: input.id,
    displayName: input.displayName,
  };
}

function createTextResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function isFeedbackAgentPushStatusReader(
  adapter: FeedbackAgentPushAdapter | null,
): adapter is FeedbackAgentPushAdapter & FeedbackAgentPushStatusReader {
  return !!adapter && typeof (adapter as unknown as FeedbackAgentPushStatusReader).getPushAgentStatus === "function";
}

export function log(...args: unknown[]): void {
  process.stderr.write(`[PAGE-CONTEXT-BRIDGE] ${args.map(String).join(" ")}\n`);
}
