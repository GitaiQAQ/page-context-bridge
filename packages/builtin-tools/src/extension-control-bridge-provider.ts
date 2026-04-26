/**
 * Bridge-side provider for extension control tools.
 *
 * These tools execute locally on the bridge side for managing tool tree enable/disable states
 * and actively refreshing page tools.
 * Names follow the `extension.*` namespace pattern.
 */

import { z } from 'zod';
import {
  builtinToolName,
  BUILTIN_CATEGORY,
  BUILTIN_RUNTIME_NAMESPACE,
} from './runtime-tool-names.js';

function createTextResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export interface PageToolEnableUpdate {
  root?: 'builtin' | 'page';
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
  debugToolCall(toolName: string, args: Record<string, unknown>, tabId?: number): Promise<unknown>;
  ensureMainWorldHost(tabId: number, frameId?: number): Promise<unknown>;
  ensureAgentationMain(tabId: number, frameId?: number): Promise<unknown>;
  normalizePageToolName?(tool: ExtensionControlTool): string;
}

export interface ExtensionControlBridgeProviderOptions {
  namespace?: string;
}

export const EXTENSION_CONTROL_TOOL_SUFFIXES = {
  getRuntimeStatus: 'get_runtime_status',
  reconnect: 'reconnect',
  getContextManifestDebug: 'get_context_manifest_debug',
  getToolTree: 'get_tool_tree',
  setToolsEnabled: 'set_tools_enabled',
  refreshPageTools: 'refresh_page_tools',
  prepareTabForDebug: 'prepare_tab_for_debug',
  toolDebugCall: 'tool_debug_call',
  ensureMainWorldHost: 'ensure_main_world_host',
  ensureAgentationMain: 'ensure_agentation_main',
} as const;

const pageToolEnableUpdateSchema = z.object({
  root: z.enum(['builtin', 'page']).optional(),
  tabId: z.number().int().positive().optional(),
  namespace: z.string().trim().min(1).optional(),
  instanceId: z.string().trim().min(1).optional(),
  toolName: z.string().trim().min(1).optional(),
  enabled: z.boolean(),
});

export class ExtensionControlBridgeProvider {
  readonly id = 'extension-control';
  private readonly namespace: string;

  constructor(options: ExtensionControlBridgeProviderOptions = {}) {
    this.namespace = options.namespace ?? 'extension';
  }

  getToolNames(): {
    getRuntimeStatus: string;
    reconnect: string;
    getContextManifestDebug: string;
    getToolTree: string;
    setToolsEnabled: string;
    refreshPageTools: string;
    prepareTabForDebug: string;
    toolDebugCall: string;
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
      prepareTabForDebug: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.prepareTabForDebug}`,
      toolDebugCall: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.toolDebugCall}`,
      ensureMainWorldHost: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.ensureMainWorldHost}`,
      ensureAgentationMain: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.ensureAgentationMain}`,
    };
  }

  registerOnBridge(
    registerTool: (
      name: string,
      schema: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
      handler: (
        args: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
    ) => { remove: () => void },
    rpc: ExtensionControlBridgeRpc,
  ): Map<string, { remove: () => void }> {
    const handles = new Map<string, { remove: () => void }>();
    const names = this.getToolNames();

    const register = (
      name: string,
      config: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
      handler: (
        args: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
    ) => {
      handles.set(name, registerTool(name, config, handler));
    };

    const getToolTreeConfig = {
      description: 'Read extension tool tree (builtin + page tools) with enabled counters.',
      inputSchema: {},
    };
    const getRuntimeStatusConfig = {
      description: 'Read extension runtime status (ws/session/in-flight diagnostics).',
      inputSchema: {},
    };
    const reconnectConfig = {
      description: 'Ask extension service worker to force reconnect its bridge websocket session.',
      inputSchema: {},
    };
    const getContextManifestDebugConfig = {
      description: 'Read one tab context manifest with raw/debug filter details from extension.',
      inputSchema: {
        tabId: z.number().int().positive(),
      },
    };
    const setToolsEnabledConfig = {
      description:
        'Batch set enable state for builtin/page tool scopes and return updated tool tree.',
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
    const prepareTabForDebugConfig = {
      description:
        'Prepare one tab for debug flow: ensure injections, refresh tools, and optionally re-enable read-only tools.',
      inputSchema: {
        tabId: z.number().int().positive(),
        frameId: z.number().int().nonnegative().optional(),
        enableReadOnlyPageTools: z.boolean().optional(),
        enableReadOnlyBuiltins: z.boolean().optional(),
      },
    };
    const ensureMainWorldHostConfig = {
      description: 'Ensure MAIN world bridge host script is injected on the target tab/frame.',
      inputSchema: {
        tabId: z.number().int().positive(),
        frameId: z.number().int().nonnegative().optional(),
      },
    };
    const toolDebugCallConfig = {
      description:
        'Safely call extension.tool.debug.call for enabled read-only tools only (blocks mutation/high-risk tools).',
      inputSchema: {
        toolName: z.string().trim().min(1),
        args: z.record(z.string(), z.unknown()).optional(),
        tabId: z.number().int().positive().optional(),
      },
    };
    const ensureAgentationMainConfig = {
      description: 'Ensure agentation-main.js is injected into MAIN world on the target tab/frame.',
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
        // Status queries remain transparent to avoid debugging drift from bridge-side field assembly.
        const status = await rpc.getRuntimeStatus();
        return createTextResponse(JSON.stringify(status, null, 2));
      } catch (error) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
            null,
            2,
          ),
        );
      }
    };

    const reconnectHandler = async () => {
      try {
        // Reconnection behavior is still determined by extension, bridge only triggers and returns results.
        const result = await rpc.reconnectExtension();
        return createTextResponse(
          JSON.stringify(
            {
              ok: true,
              result,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
            null,
            2,
          ),
        );
      }
    };

    const getContextManifestDebugHandler = async (args: Record<string, unknown>) => {
      const tabId = typeof args.tabId === 'number' ? args.tabId : NaN;
      if (!Number.isInteger(tabId) || tabId <= 0) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: 'tabId must be a positive integer',
            },
            null,
            2,
          ),
        );
      }
      try {
        // Manifest debug directly reuses extension's existing structure to avoid redundant assembly.
        const payload = await rpc.getContextManifestDebug(tabId);
        return createTextResponse(JSON.stringify(payload, null, 2));
      } catch (error) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              tabId,
              error: error instanceof Error ? error.message : String(error),
            },
            null,
            2,
          ),
        );
      }
    };

    const setToolsEnabledHandler = async (args: Record<string, unknown>) => {
      const updates = Array.isArray(args.updates) ? (args.updates as PageToolEnableUpdate[]) : [];
      // Explicitly reject page scope inputs missing tabId to avoid silent no-op in extension.
      for (let index = 0; index < updates.length; index += 1) {
        assertValidPageToolEnableUpdate(updates[index]!, index);
      }
      const tree = await rpc.setPageToolsEnabledBatch(updates);
      return createTextResponse(
        JSON.stringify(
          {
            applied: updates.length,
            tree,
          },
          null,
          2,
        ),
      );
    };

    const refreshPageToolsHandler = async (args: Record<string, unknown>) => {
      const tabId = typeof args.tabId === 'number' ? args.tabId : NaN;
      if (!Number.isInteger(tabId) || tabId <= 0) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: 'tabId must be a positive integer',
            },
            null,
            2,
          ),
        );
      }

      try {
        const refreshed = await rpc.refreshPageToolsForTab(tabId);
        return createTextResponse(
          JSON.stringify(
            {
              ok: true,
              tabId,
              refreshedToolCount: refreshed.tools.length,
              toolNames: refreshed.tools.map(
                (tool) => rpc.normalizePageToolName?.(tool) ?? tool.name,
              ),
              manifestSynced: refreshed.manifest != null,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              tabId,
              error: error instanceof Error ? error.message : String(error),
            },
            null,
            2,
          ),
        );
      }
    };

    const prepareTabForDebugHandler = async (args: Record<string, unknown>) => {
      const tabId = typeof args.tabId === 'number' ? args.tabId : NaN;
      const frameId = parseOptionalFrameId(args.frameId);
      const enableReadOnlyPageTools = parseOptionalBoolean(args.enableReadOnlyPageTools);
      const enableReadOnlyBuiltins = parseOptionalBoolean(args.enableReadOnlyBuiltins);
      if (!Number.isInteger(tabId) || tabId <= 0) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: 'tabId must be a positive integer',
            },
            null,
            2,
          ),
        );
      }
      if (args.frameId != null && frameId == null) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: 'frameId must be a non-negative integer',
            },
            null,
            2,
          ),
        );
      }
      if (args.enableReadOnlyPageTools != null && enableReadOnlyPageTools == null) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: 'enableReadOnlyPageTools must be a boolean',
            },
            null,
            2,
          ),
        );
      }
      if (args.enableReadOnlyBuiltins != null && enableReadOnlyBuiltins == null) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: 'enableReadOnlyBuiltins must be a boolean',
            },
            null,
            2,
          ),
        );
      }

      const failAtStep = (step: string, error: unknown) =>
        createTextResponse(
          JSON.stringify(
            {
              ok: false,
              tabId,
              frameId: frameId ?? null,
              step,
              error: error instanceof Error ? error.message : String(error),
            },
            null,
            2,
          ),
        );

      // Runtime status is for diagnostics only, failure to fetch doesn't block preparation flow.
      const runtimeStatus = await rpc.getRuntimeStatus().catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));

      let mainWorldHostResult: unknown;
      try {
        mainWorldHostResult = await rpc.ensureMainWorldHost(tabId, frameId);
      } catch (error) {
        return failAtStep('ensure_main_world_host', error);
      }

      let agentationMainResult: unknown;
      try {
        agentationMainResult = await rpc.ensureAgentationMain(tabId, frameId);
      } catch (error) {
        return failAtStep('ensure_agentation_main', error);
      }

      let refreshed: ExtensionControlRefreshResult;
      try {
        refreshed = await rpc.refreshPageToolsForTab(tabId);
      } catch (error) {
        return failAtStep('refresh_page_tools', error);
      }

      let tree: unknown;
      try {
        tree = await rpc.getPageToolsTree();
      } catch (error) {
        return failAtStep('get_tool_tree', error);
      }

      const pageToolsEnabled = enableReadOnlyPageTools ?? true;
      const builtinToolsEnabled = enableReadOnlyBuiltins ?? false;
      // Only collect "read-only + disabled" candidates to avoid accidentally enabling high-risk mutation tools.
      const updates = collectReadOnlyEnableUpdatesForPrepare(tree, {
        tabId,
        enableReadOnlyPageTools: pageToolsEnabled,
        enableReadOnlyBuiltins: builtinToolsEnabled,
      });

      let setToolsEnabledResult: unknown = null;
      if (updates.length > 0) {
        try {
          setToolsEnabledResult = await rpc.setPageToolsEnabledBatch(updates);
        } catch (error) {
          return failAtStep('set_tools_enabled', error);
        }
      }

      return createTextResponse(
        JSON.stringify(
          {
            ok: true,
            tabId,
            frameId: frameId ?? null,
            runtimeStatus,
            ensured: {
              mainWorldHost: mainWorldHostResult,
              agentationMain: agentationMainResult,
            },
            refreshed: {
              toolCount: refreshed.tools.length,
              toolNames: refreshed.tools.map(
                (tool) => rpc.normalizePageToolName?.(tool) ?? tool.name,
              ),
              manifestSynced: refreshed.manifest != null,
            },
            readOnlyEnable: {
              enableReadOnlyPageTools: pageToolsEnabled,
              enableReadOnlyBuiltins: builtinToolsEnabled,
              applied: updates.length,
              updates,
              tree: setToolsEnabledResult,
            },
          },
          null,
          2,
        ),
      );
    };

    const toolDebugCallHandler = async (args: Record<string, unknown>) => {
      const toolName = typeof args.toolName === 'string' ? args.toolName.trim() : '';
      const tabId = parseOptionalTabId(args.tabId);
      if (!toolName) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: 'toolName is required',
            },
            null,
            2,
          ),
        );
      }
      if (args.tabId != null && tabId == null) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: 'tabId must be a positive integer',
            },
            null,
            2,
          ),
        );
      }
      if (args.args != null && !isRecord(args.args)) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: 'args must be an object when provided',
            },
            null,
            2,
          ),
        );
      }

      try {
        // Security entry must first check tool tree, only allowing "enabled + read-only" tools into extension.tool.debug.call.
        const tree = await rpc.getPageToolsTree();
        const target = pickDebugTargetFromToolTree(tree, toolName, tabId);
        if (!target) {
          return createTextResponse(
            JSON.stringify(
              {
                ok: false,
                error: `Tool '${toolName}' is not found in current extension tool tree`,
              },
              null,
              2,
            ),
          );
        }
        if (!target.enabled) {
          return createTextResponse(
            JSON.stringify(
              {
                ok: false,
                error: `Tool '${toolName}' is disabled and cannot be called via debug entry`,
              },
              null,
              2,
            ),
          );
        }
        if (!target.readOnly) {
          return createTextResponse(
            JSON.stringify(
              {
                ok: false,
                error: `Tool '${toolName}' is not read-only; extension.tool_debug_call only allows low-risk read-only tools`,
              },
              null,
              2,
            ),
          );
        }

        const callResult = await rpc.debugToolCall(
          toolName,
          (args.args as Record<string, unknown> | undefined) ?? {},
          target.root === 'page' ? target.tabId : tabId,
        );
        return createTextResponse(JSON.stringify(callResult, null, 2));
      } catch (error) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
            null,
            2,
          ),
        );
      }
    };

    const ensureMainWorldHostHandler = async (args: Record<string, unknown>) => {
      const tabId = typeof args.tabId === 'number' ? args.tabId : NaN;
      const frameId = parseOptionalFrameId(args.frameId);
      if (!Number.isInteger(tabId) || tabId <= 0) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: 'tabId must be a positive integer',
            },
            null,
            2,
          ),
        );
      }
      if (args.frameId != null && frameId == null) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: 'frameId must be a non-negative integer',
            },
            null,
            2,
          ),
        );
      }
      try {
        const result = await rpc.ensureMainWorldHost(tabId, frameId);
        return createTextResponse(
          JSON.stringify(
            {
              ok: true,
              tabId,
              frameId: frameId ?? null,
              result,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              tabId,
              frameId: frameId ?? null,
              error: error instanceof Error ? error.message : String(error),
            },
            null,
            2,
          ),
        );
      }
    };

    const ensureAgentationMainHandler = async (args: Record<string, unknown>) => {
      const tabId = typeof args.tabId === 'number' ? args.tabId : NaN;
      const frameId = parseOptionalFrameId(args.frameId);
      if (!Number.isInteger(tabId) || tabId <= 0) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: 'tabId must be a positive integer',
            },
            null,
            2,
          ),
        );
      }
      if (args.frameId != null && frameId == null) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              error: 'frameId must be a non-negative integer',
            },
            null,
            2,
          ),
        );
      }
      try {
        const result = await rpc.ensureAgentationMain(tabId, frameId);
        return createTextResponse(
          JSON.stringify(
            {
              ok: true,
              tabId,
              frameId: frameId ?? null,
              result,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        return createTextResponse(
          JSON.stringify(
            {
              ok: false,
              tabId,
              frameId: frameId ?? null,
              error: error instanceof Error ? error.message : String(error),
            },
            null,
            2,
          ),
        );
      }
    };

    register(names.getToolTree, getToolTreeConfig, getToolTreeHandler);

    register(names.getRuntimeStatus, getRuntimeStatusConfig, getRuntimeStatusHandler);

    register(names.reconnect, reconnectConfig, reconnectHandler);

    register(
      names.getContextManifestDebug,
      getContextManifestDebugConfig,
      getContextManifestDebugHandler,
    );

    register(names.setToolsEnabled, setToolsEnabledConfig, setToolsEnabledHandler);

    register(names.refreshPageTools, refreshPageToolsConfig, refreshPageToolsHandler);

    register(names.prepareTabForDebug, prepareTabForDebugConfig, prepareTabForDebugHandler);

    register(names.toolDebugCall, toolDebugCallConfig, toolDebugCallHandler);

    register(names.ensureMainWorldHost, ensureMainWorldHostConfig, ensureMainWorldHostHandler);

    register(names.ensureAgentationMain, ensureAgentationMainConfig, ensureAgentationMainHandler);

    return handles;
  }
}

function assertValidPageToolEnableUpdate(update: PageToolEnableUpdate, index: number): void {
  const root = update.root ?? 'page';
  // Extension side will be no-op when root=page and tabId is missing, intercept here to avoid misjudging as successful toggle.
  if (root === 'page' && update.tabId == null) {
    throw new Error(`updates[${index}] requires tabId when root is "page"`);
  }
}

function parseOptionalFrameId(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseOptionalTabId(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value == null) {
    return undefined;
  }
  return typeof value === 'boolean' ? value : undefined;
}

interface PrepareTabForDebugEnableOptions {
  tabId: number;
  enableReadOnlyPageTools: boolean;
  enableReadOnlyBuiltins: boolean;
}

function collectReadOnlyEnableUpdatesForPrepare(
  tree: unknown,
  options: PrepareTabForDebugEnableOptions,
): PageToolEnableUpdate[] {
  if (!isRecord(tree)) {
    return [];
  }
  const updates: PageToolEnableUpdate[] = [];
  const seen = new Set<string>();

  const pushUniqueUpdate = (update: PageToolEnableUpdate, key: string) => {
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    updates.push(update);
  };

  if (options.enableReadOnlyBuiltins) {
    const builtinTools = collectBuiltinToolsFromTree(tree);
    for (const tool of builtinTools) {
      if (!isRecord(tool) || typeof tool.toolName !== 'string') {
        continue;
      }
      if (!tool.readOnly || tool.enabled) {
        continue;
      }
      pushUniqueUpdate(
        { root: 'builtin', toolName: tool.toolName, enabled: true },
        `builtin:${tool.toolName}`,
      );
    }
  }

  if (options.enableReadOnlyPageTools && Array.isArray(tree.tabs)) {
    for (const tab of tree.tabs) {
      if (!isRecord(tab) || tab.tabId !== options.tabId) {
        continue;
      }
      const namespaces = Array.isArray(tab.namespaces) ? tab.namespaces : [];
      for (const namespace of namespaces) {
        if (!isRecord(namespace) || typeof namespace.namespace !== 'string') {
          continue;
        }
        const instances = Array.isArray(namespace.instances) ? namespace.instances : [];
        for (const instance of instances) {
          if (!isRecord(instance) || typeof instance.instanceId !== 'string') {
            continue;
          }
          const tools = Array.isArray(instance.tools) ? instance.tools : [];
          for (const tool of tools) {
            if (!isRecord(tool) || typeof tool.toolName !== 'string') {
              continue;
            }
            if (!tool.readOnly || tool.enabled) {
              continue;
            }
            pushUniqueUpdate(
              {
                root: 'page',
                tabId: options.tabId,
                namespace: namespace.namespace,
                instanceId: instance.instanceId,
                toolName: tool.toolName,
                enabled: true,
              },
              `page:${options.tabId}:${namespace.namespace}:${instance.instanceId}:${tool.toolName}`,
            );
          }
        }
      }
    }
  }

  return updates;
}

interface DebugToolTreeCandidate {
  root: 'builtin' | 'page';
  tabId?: number;
  enabled: boolean;
  readOnly: boolean;
}

function pickDebugTargetFromToolTree(
  tree: unknown,
  toolName: string,
  preferredTabId?: number,
): DebugToolTreeCandidate | null {
  const canonicalToolName = toolName.startsWith(`${BUILTIN_RUNTIME_NAMESPACE}.`)
    ? toolName
    : builtinToolName(BUILTIN_CATEGORY.tabs, toolName);
  const builtinMatches = collectBuiltinToolMatches(tree, canonicalToolName);
  const pageMatches = collectPageToolMatches(tree, toolName, preferredTabId);

  if (preferredTabId != null) {
    if (pageMatches.length > 1) {
      throw new Error(
        `Tool '${toolName}' has multiple matches on tab ${preferredTabId}; please narrow by namespace/instance`,
      );
    }
    if (pageMatches.length === 1) {
      return pageMatches[0]!;
    }
    if (builtinMatches.length === 1) {
      return builtinMatches[0]!;
    }
    if (builtinMatches.length > 1) {
      throw new Error(`Tool '${toolName}' has duplicated builtin matches in tool tree`);
    }
    return null;
  }

  const allMatches = [...builtinMatches, ...pageMatches];
  if (allMatches.length === 0) {
    return null;
  }
  if (allMatches.length > 1) {
    throw new Error(`Tool '${toolName}' matches multiple targets; provide tabId to disambiguate`);
  }
  return allMatches[0]!;
}

function collectBuiltinToolMatches(tree: unknown, toolName: string): DebugToolTreeCandidate[] {
  const tools = collectBuiltinToolsFromTree(tree);
  return tools
    .filter((item): item is Record<string, unknown> => isRecord(item) && item.toolName === toolName)
    .map((item) => ({
      root: 'builtin' as const,
      enabled: Boolean(item.enabled),
      readOnly: Boolean(item.readOnly),
    }));
}

function collectPageToolMatches(
  tree: unknown,
  toolName: string,
  preferredTabId?: number,
): DebugToolTreeCandidate[] {
  if (!isRecord(tree) || !Array.isArray(tree.tabs)) {
    return [];
  }
  const matches: DebugToolTreeCandidate[] = [];
  for (const tab of tree.tabs) {
    if (!isRecord(tab) || typeof tab.tabId !== 'number') {
      continue;
    }
    if (preferredTabId != null && tab.tabId !== preferredTabId) {
      continue;
    }
    const namespaces = Array.isArray(tab.namespaces) ? tab.namespaces : [];
    for (const namespace of namespaces) {
      if (!isRecord(namespace)) {
        continue;
      }
      const instances = Array.isArray(namespace.instances) ? namespace.instances : [];
      for (const instance of instances) {
        if (!isRecord(instance)) {
          continue;
        }
        const tools = Array.isArray(instance.tools) ? instance.tools : [];
        for (const tool of tools) {
          if (!isRecord(tool) || tool.toolName !== toolName) {
            continue;
          }
          matches.push({
            root: 'page',
            tabId: tab.tabId,
            enabled: Boolean(tool.enabled),
            readOnly: Boolean(tool.readOnly),
          });
        }
      }
    }
  }
  return matches;
}

function collectBuiltinToolsFromTree(tree: unknown): unknown[] {
  if (!isRecord(tree)) {
    return [];
  }
  const builtins = isRecord(tree.builtins) ? tree.builtins : null;
  if (!builtins) {
    return [];
  }

  // Prefer new tree structure: builtins.namespaces[].instances[].tools[].
  if (Array.isArray(builtins.namespaces)) {
    const tools: unknown[] = [];
    for (const namespace of builtins.namespaces) {
      if (!isRecord(namespace) || !Array.isArray(namespace.instances)) {
        continue;
      }
      for (const instance of namespace.instances) {
        if (!isRecord(instance) || !Array.isArray(instance.tools)) {
          continue;
        }
        tools.push(...instance.tools);
      }
    }
    return tools;
  }

  // Compatible with old flat structure to avoid breaking debug links across versions.
  return Array.isArray(builtins.tools) ? builtins.tools : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}
