/**
 * Bridge-side provider for extension control tools.
 *
 * 这些工具在 bridge 侧本地执行，用于管理“工具树可见性/启用状态”和主动刷新页面工具。
 * 命名统一走 namespace 形式：`extension.*`。
 */

import { z } from "zod";

function createTextResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export interface PageToolEnableUpdate {
  root?: "builtin" | "page";
  tabId?: number;
  namespace?: string;
  instanceId?: string;
  toolName?: string;
  enabled: boolean;
}

export interface ExtensionControlTool {
  name: string;
  _namespace?: string;
}

export interface ExtensionControlRefreshResult {
  tools: ExtensionControlTool[];
  manifest: unknown | null;
}

export interface ExtensionControlBridgeRpc {
  getRuntimeStatus(): Promise<unknown>;
  reconnectExtension(): Promise<unknown>;
  getContextManifestDebug(tabId: number): Promise<unknown>;
  getPageToolsTree(): Promise<unknown>;
  setPageToolsEnabledBatch(updates: PageToolEnableUpdate[]): Promise<unknown>;
  refreshPageToolsForTab(tabId: number): Promise<ExtensionControlRefreshResult>;
  ensureMainWorldHost(tabId: number, frameId?: number): Promise<unknown>;
  ensureAgentationMain(tabId: number, frameId?: number): Promise<unknown>;
  normalizePageToolName?(tool: ExtensionControlTool): string;
}

export interface ExtensionControlBridgeProviderOptions {
  namespace?: string;
  includeLegacyAliases?: boolean;
}

export const EXTENSION_CONTROL_TOOL_SUFFIXES = {
  getRuntimeStatus: "get_runtime_status",
  reconnect: "reconnect",
  getContextManifestDebug: "get_context_manifest_debug",
  getToolTree: "get_tool_tree",
  setToolsEnabled: "set_tools_enabled",
  refreshPageTools: "refresh_page_tools",
  ensureMainWorldHost: "ensure_main_world_host",
  ensureAgentationMain: "ensure_agentation_main",
} as const;

export const EXTENSION_CONTROL_LEGACY_TOOL_NAMES = {
  getRuntimeStatus: "extension_get_runtime_status",
  reconnect: "extension_reconnect",
  getContextManifestDebug: "extension_get_context_manifest_debug",
  getToolTree: "extension_get_tool_tree",
  setToolsEnabled: "extension_set_tools_enabled",
  refreshPageTools: "extension_refresh_page_tools",
  ensureMainWorldHost: "extension_ensure_main_world_host",
  ensureAgentationMain: "extension_ensure_agentation_main",
} as const;

const pageToolEnableUpdateSchema = z.object({
  root: z.enum(["builtin", "page"]).optional(),
  tabId: z.number().int().positive().optional(),
  namespace: z.string().trim().min(1).optional(),
  instanceId: z.string().trim().min(1).optional(),
  toolName: z.string().trim().min(1).optional(),
  enabled: z.boolean(),
});

export class ExtensionControlBridgeProvider {
  readonly id = "extension-control";
  private readonly namespace: string;
  private readonly includeLegacyAliases: boolean;

  constructor(options: ExtensionControlBridgeProviderOptions = {}) {
    this.namespace = options.namespace ?? "extension";
    this.includeLegacyAliases = options.includeLegacyAliases ?? true;
  }

  getToolNames(): {
    getRuntimeStatus: string;
    reconnect: string;
    getContextManifestDebug: string;
    getToolTree: string;
    setToolsEnabled: string;
    refreshPageTools: string;
    ensureMainWorldHost: string;
    ensureAgentationMain: string;
  } {
    return {
      getRuntimeStatus: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.getRuntimeStatus}`,
      reconnect: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.reconnect}`,
      getContextManifestDebug: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.getContextManifestDebug}`,
      getToolTree: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.getToolTree}`,
      setToolsEnabled: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.setToolsEnabled}`,
      refreshPageTools: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.refreshPageTools}`,
      ensureMainWorldHost: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.ensureMainWorldHost}`,
      ensureAgentationMain: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.ensureAgentationMain}`,
    };
  }

  registerOnBridge(
    registerTool: (
      name: string,
      schema: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
      handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
    ) => { remove: () => void },
    rpc: ExtensionControlBridgeRpc,
  ): Map<string, { remove: () => void }> {
    const handles = new Map<string, { remove: () => void }>();
    const names = this.getToolNames();

    const register = (
      name: string,
      config: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
      handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
    ) => {
      handles.set(name, registerTool(name, config, handler));
    };

    const registerAlias = (
      alias: string,
      primaryName: string,
      config: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
      handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
    ) => {
      if (!this.includeLegacyAliases) {
        return;
      }
      register(
        alias,
        {
          ...config,
          // 旧名只做兼容，不再作为首选入口。
          description: `${config.description} (Deprecated alias. Use '${primaryName}' instead.)`,
        },
        handler,
      );
    };

    const getToolTreeConfig = {
      description: "Read extension tool tree (builtin + page tools) with enabled counters.",
      inputSchema: {},
    };
    const getRuntimeStatusConfig = {
      description: "Read extension runtime status (ws/session/in-flight diagnostics).",
      inputSchema: {},
    };
    const reconnectConfig = {
      description: "Ask extension service worker to force reconnect its bridge websocket session.",
      inputSchema: {},
    };
    const getContextManifestDebugConfig = {
      description: "Read one tab context manifest with raw/debug filter details from extension.",
      inputSchema: {
        tabId: z.number().int().positive(),
      },
    };
    const setToolsEnabledConfig = {
      description: "Batch set enable state for builtin/page tool scopes and return updated tool tree.",
      inputSchema: {
        updates: z.array(pageToolEnableUpdateSchema).min(1),
      },
    };
    const refreshPageToolsConfig = {
      description: "Force extension to rediscover one tab's page tools and sync bridge registry.",
      inputSchema: {
        tabId: z.number().int().positive(),
      },
    };
    const ensureMainWorldHostConfig = {
      description: "Ensure MAIN world bridge host script is injected on the target tab/frame.",
      inputSchema: {
        tabId: z.number().int().positive(),
        frameId: z.number().int().nonnegative().optional(),
      },
    };
    const ensureAgentationMainConfig = {
      description: "Ensure agentation-main.js is injected into MAIN world on the target tab/frame.",
      inputSchema: {
        tabId: z.number().int().positive(),
        frameId: z.number().int().nonnegative().optional(),
      },
    };

    const getToolTreeHandler = async () => {
      const tree = await rpc.getPageToolsTree();
      return createTextResponse(JSON.stringify(tree, null, 2));
    };

    const getRuntimeStatusHandler = async () => {
      try {
        // 状态查询保持“纯透传”，避免 bridge 侧自造字段导致调试口径漂移。
        const status = await rpc.getRuntimeStatus();
        return createTextResponse(JSON.stringify(status, null, 2));
      } catch (error) {
        return createTextResponse(JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, null, 2));
      }
    };

    const reconnectHandler = async () => {
      try {
        // 重连行为仍由 extension 控制，bridge 只触发并返回执行结果。
        const result = await rpc.reconnectExtension();
        return createTextResponse(JSON.stringify({
          ok: true,
          result,
        }, null, 2));
      } catch (error) {
        return createTextResponse(JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, null, 2));
      }
    };

    const getContextManifestDebugHandler = async (args: Record<string, unknown>) => {
      const tabId = typeof args.tabId === "number" ? args.tabId : NaN;
      if (!Number.isInteger(tabId) || tabId <= 0) {
        return createTextResponse(JSON.stringify({
          ok: false,
          error: "tabId must be a positive integer",
        }, null, 2));
      }
      try {
        // manifest debug 直接复用 extension 现有返回结构，避免重复拼装调试信息。
        const payload = await rpc.getContextManifestDebug(tabId);
        return createTextResponse(JSON.stringify(payload, null, 2));
      } catch (error) {
        return createTextResponse(JSON.stringify({
          ok: false,
          tabId,
          error: error instanceof Error ? error.message : String(error),
        }, null, 2));
      }
    };

    const setToolsEnabledHandler = async (args: Record<string, unknown>) => {
      const updates = Array.isArray(args.updates)
        ? (args.updates as PageToolEnableUpdate[])
        : [];
      // 明确拒绝“page scope 缺 tabId”的输入，避免进入 extension 后变成静默 no-op。
      for (let index = 0; index < updates.length; index += 1) {
        assertValidPageToolEnableUpdate(updates[index]!, index);
      }
      const tree = await rpc.setPageToolsEnabledBatch(updates);
      return createTextResponse(JSON.stringify({
        applied: updates.length,
        tree,
      }, null, 2));
    };

    const refreshPageToolsHandler = async (args: Record<string, unknown>) => {
      const tabId = typeof args.tabId === "number" ? args.tabId : NaN;
      if (!Number.isInteger(tabId) || tabId <= 0) {
        return createTextResponse(JSON.stringify({
          ok: false,
          error: "tabId must be a positive integer",
        }, null, 2));
      }

      try {
        const refreshed = await rpc.refreshPageToolsForTab(tabId);
        return createTextResponse(JSON.stringify({
          ok: true,
          tabId,
          refreshedToolCount: refreshed.tools.length,
          toolNames: refreshed.tools.map((tool) => rpc.normalizePageToolName?.(tool) ?? tool.name),
          manifestSynced: refreshed.manifest != null,
        }, null, 2));
      } catch (error) {
        return createTextResponse(JSON.stringify({
          ok: false,
          tabId,
          error: error instanceof Error ? error.message : String(error),
        }, null, 2));
      }
    };

    const ensureMainWorldHostHandler = async (args: Record<string, unknown>) => {
      const tabId = typeof args.tabId === "number" ? args.tabId : NaN;
      const frameId = parseOptionalFrameId(args.frameId);
      if (!Number.isInteger(tabId) || tabId <= 0) {
        return createTextResponse(JSON.stringify({
          ok: false,
          error: "tabId must be a positive integer",
        }, null, 2));
      }
      if (args.frameId != null && frameId == null) {
        return createTextResponse(JSON.stringify({
          ok: false,
          error: "frameId must be a non-negative integer",
        }, null, 2));
      }
      try {
        const result = await rpc.ensureMainWorldHost(tabId, frameId);
        return createTextResponse(JSON.stringify({
          ok: true,
          tabId,
          frameId: frameId ?? null,
          result,
        }, null, 2));
      } catch (error) {
        return createTextResponse(JSON.stringify({
          ok: false,
          tabId,
          frameId: frameId ?? null,
          error: error instanceof Error ? error.message : String(error),
        }, null, 2));
      }
    };

    const ensureAgentationMainHandler = async (args: Record<string, unknown>) => {
      const tabId = typeof args.tabId === "number" ? args.tabId : NaN;
      const frameId = parseOptionalFrameId(args.frameId);
      if (!Number.isInteger(tabId) || tabId <= 0) {
        return createTextResponse(JSON.stringify({
          ok: false,
          error: "tabId must be a positive integer",
        }, null, 2));
      }
      if (args.frameId != null && frameId == null) {
        return createTextResponse(JSON.stringify({
          ok: false,
          error: "frameId must be a non-negative integer",
        }, null, 2));
      }
      try {
        const result = await rpc.ensureAgentationMain(tabId, frameId);
        return createTextResponse(JSON.stringify({
          ok: true,
          tabId,
          frameId: frameId ?? null,
          result,
        }, null, 2));
      } catch (error) {
        return createTextResponse(JSON.stringify({
          ok: false,
          tabId,
          frameId: frameId ?? null,
          error: error instanceof Error ? error.message : String(error),
        }, null, 2));
      }
    };

    register(names.getToolTree, getToolTreeConfig, getToolTreeHandler);
    registerAlias(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.getToolTree, names.getToolTree, getToolTreeConfig, getToolTreeHandler);

    register(names.getRuntimeStatus, getRuntimeStatusConfig, getRuntimeStatusHandler);
    registerAlias(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.getRuntimeStatus, names.getRuntimeStatus, getRuntimeStatusConfig, getRuntimeStatusHandler);

    register(names.reconnect, reconnectConfig, reconnectHandler);
    registerAlias(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.reconnect, names.reconnect, reconnectConfig, reconnectHandler);

    register(names.getContextManifestDebug, getContextManifestDebugConfig, getContextManifestDebugHandler);
    registerAlias(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.getContextManifestDebug, names.getContextManifestDebug, getContextManifestDebugConfig, getContextManifestDebugHandler);

    register(names.setToolsEnabled, setToolsEnabledConfig, setToolsEnabledHandler);
    registerAlias(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.setToolsEnabled, names.setToolsEnabled, setToolsEnabledConfig, setToolsEnabledHandler);

    register(names.refreshPageTools, refreshPageToolsConfig, refreshPageToolsHandler);
    registerAlias(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.refreshPageTools, names.refreshPageTools, refreshPageToolsConfig, refreshPageToolsHandler);

    register(names.ensureMainWorldHost, ensureMainWorldHostConfig, ensureMainWorldHostHandler);
    registerAlias(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.ensureMainWorldHost, names.ensureMainWorldHost, ensureMainWorldHostConfig, ensureMainWorldHostHandler);

    register(names.ensureAgentationMain, ensureAgentationMainConfig, ensureAgentationMainHandler);
    registerAlias(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.ensureAgentationMain, names.ensureAgentationMain, ensureAgentationMainConfig, ensureAgentationMainHandler);

    return handles;
  }
}

function assertValidPageToolEnableUpdate(update: PageToolEnableUpdate, index: number): void {
  const root = update.root ?? "page";
  // extension 侧 root=page 且缺 tabId 时会直接 no-op，这里提前拦截，避免 agent 误以为切换成功。
  if (root === "page" && update.tabId == null) {
    throw new Error(`updates[${index}] requires tabId when root is "page"`);
  }
}

function parseOptionalFrameId(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
