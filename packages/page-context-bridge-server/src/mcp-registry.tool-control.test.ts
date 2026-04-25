import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EXTENSION_CONTROL_TOOL_SUFFIXES } from "@page-context/builtin-tools";

import { McpRegistry, type PageToolEnableUpdate } from "./mcp-registry.js";

class FakeMcpServer {
  public readonly tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();

  registerTool(
    name: string,
    _schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): { remove: () => void } {
    this.tools.set(name, handler);
    return {
      remove: () => this.tools.delete(name),
    };
  }

  registerResource(): { remove: () => void } {
    return { remove: () => undefined };
  }

  registerPrompt(): { remove: () => void } {
    return { remove: () => undefined };
  }
}

function parseTextResponse(payload: unknown) {
  const text = (payload as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

const TOOL_NAMES = {
  getRuntimeStatus: `extension.${EXTENSION_CONTROL_TOOL_SUFFIXES.getRuntimeStatus}`,
  reconnect: `extension.${EXTENSION_CONTROL_TOOL_SUFFIXES.reconnect}`,
  getContextManifestDebug: `extension.${EXTENSION_CONTROL_TOOL_SUFFIXES.getContextManifestDebug}`,
  getToolTree: `extension.${EXTENSION_CONTROL_TOOL_SUFFIXES.getToolTree}`,
  setToolsEnabled: `extension.${EXTENSION_CONTROL_TOOL_SUFFIXES.setToolsEnabled}`,
  refreshPageTools: `extension.${EXTENSION_CONTROL_TOOL_SUFFIXES.refreshPageTools}`,
  prepareTabForDebug: `extension.${EXTENSION_CONTROL_TOOL_SUFFIXES.prepareTabForDebug}`,
  toolDebugCall: `extension.${EXTENSION_CONTROL_TOOL_SUFFIXES.toolDebugCall}`,
  ensureMainWorldHost: `extension.${EXTENSION_CONTROL_TOOL_SUFFIXES.ensureMainWorldHost}`,
  ensureAgentationMain: `extension.${EXTENSION_CONTROL_TOOL_SUFFIXES.ensureAgentationMain}`,
} as const;

function createRegistry() {
  const getRuntimeStatus = vi.fn(async () => ({
    connected: true,
    sessionId: "session-1",
    pendingToolCalls: 0,
  }));
  const reconnectExtension = vi.fn(async () => ({ ok: true }));
  const ensureMainWorldHost = vi.fn(async (_tabId: number, _frameId?: number) => ({ ok: true }));
  const ensureAgentationMain = vi.fn(async (_tabId: number, _frameId?: number) => ({ ok: true }));
  const getContextManifestDebug = vi.fn(async (tabId: number) => ({
    tabId,
    manifest: {
      version: "1",
      app: "crm",
      route: "/lead/1",
      scene: "lead_detail",
      namespaces: [],
      resources: [],
      skills: [],
      generatedAt: "2026-04-23T00:00:00.000Z",
    },
    rawManifest: {
      version: "1",
      app: "crm",
      route: "/lead/1",
      scene: "lead_detail",
      namespaces: [{ namespace: "lead", title: "Lead" }],
      resources: [],
      skills: [],
      generatedAt: "2026-04-23T00:00:00.000Z",
    },
    debug: {
      droppedNamespaces: ["lead"],
    },
  }));
  const getPageToolsTree = vi.fn(async () => ({
    builtins: {
      kind: "builtins",
      totalTools: 3,
      enabledTools: 2,
      namespaces: [
        {
          kind: "builtin-namespace",
          namespace: "builtin",
          totalTools: 3,
          enabledTools: 2,
          instances: [
            {
              kind: "builtin-instance",
              namespace: "builtin",
              instanceId: "default",
              totalTools: 3,
              enabledTools: 2,
              tools: [
                { kind: "builtin-tool", namespace: "builtin", instanceId: "default", toolName: "builtin.list_tabs", enabled: true, readOnly: true },
                { kind: "builtin-tool", namespace: "builtin", instanceId: "default", toolName: "builtin.execute_js", enabled: true, readOnly: false },
                { kind: "builtin-tool", namespace: "builtin", instanceId: "default", toolName: "builtin.get_console_logs", enabled: false, readOnly: true },
              ],
            },
          ],
        },
      ],
    },
    tabs: [],
    totalTools: 3,
    enabledTools: 2,
  }));
  const debugToolCall = vi.fn(async (toolName: string, args: Record<string, unknown>, tabId?: number) => ({
    ok: true,
    toolName,
    args,
    tabId: tabId ?? null,
  }));
  const getContextManifest = vi.fn(async () => null);
  const refreshPageTools = vi.fn(async () => ([
    { name: "crm.inspect", description: "Inspect CRM entity" },
  ]));
  const setPageToolsEnabledBatch = vi.fn(async (updates: PageToolEnableUpdate[]) => ({
    totalTools: 3,
    enabledTools: updates.some((item) => item.enabled) ? 3 : 1,
  }));

  const registry = new McpRegistry({
    sendToolCall: async () => ({}),
    getRuntimeStatus,
    reconnectExtension,
    debugToolCall,
    ensureMainWorldHost,
    ensureAgentationMain,
    getContextManifest,
    getContextManifestDebug,
    refreshPageTools,
    readContextResource: async () => ({ id: "r", text: "{}" }),
    getContextSkillPrompt: async () => null,
    getPageToolsTree,
    setPageToolsEnabledBatch,
  }, "tenant-tool-control");

  return {
    registry,
    getRuntimeStatus,
    reconnectExtension,
    debugToolCall,
    ensureMainWorldHost,
    ensureAgentationMain,
    getContextManifestDebug,
    getContextManifest,
    refreshPageTools,
    getPageToolsTree,
    setPageToolsEnabledBatch,
  };
}

describe("mcp-registry extension tool control tools", () => {
  it("registers namespaced tools", () => {
    const { registry } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    expect(fakeServer.tools.has(TOOL_NAMES.getRuntimeStatus)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.reconnect)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.getContextManifestDebug)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.getToolTree)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.setToolsEnabled)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.refreshPageTools)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.prepareTabForDebug)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.toolDebugCall)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.ensureMainWorldHost)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.ensureAgentationMain)).toBe(true);
  });

  it("reads extension runtime status through namespaced get_runtime_status", async () => {
    const { registry, getRuntimeStatus } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.getRuntimeStatus);
    const payload = await handler?.({});
    const parsed = parseTextResponse(payload);

    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(parsed.connected).toBe(true);
    expect(parsed.sessionId).toBe("session-1");
  });

  it("triggers extension reconnect through namespaced reconnect", async () => {
    const { registry, reconnectExtension } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.reconnect);
    const payload = await handler?.({});
    const parsed = parseTextResponse(payload);

    expect(reconnectExtension).toHaveBeenCalledTimes(1);
    expect(parsed.ok).toBe(true);
    expect((parsed.result as { ok: boolean }).ok).toBe(true);
  });

  it("reads manifest debug payload through namespaced get_context_manifest_debug", async () => {
    const { registry, getContextManifestDebug } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.getContextManifestDebug);
    const payload = await handler?.({ tabId: 42 });
    const parsed = parseTextResponse(payload);

    // Debug tools should pass tabId as-is to avoid confusion caused by bridge-side guessing of the current tab.
    expect(getContextManifestDebug).toHaveBeenCalledTimes(1);
    expect(getContextManifestDebug).toHaveBeenCalledWith(42);
    expect(parsed.tabId).toBe(42);
    expect((parsed.debug as { droppedNamespaces: string[] }).droppedNamespaces).toEqual(["lead"]);
  });

  it("returns explicit validation error when context manifest debug misses tabId", async () => {
    const { registry, getContextManifestDebug } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.getContextManifestDebug);
    const payload = await handler?.({});
    const parsed = parseTextResponse(payload);

    expect(getContextManifestDebug).not.toHaveBeenCalled();
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("tabId must be a positive integer");
  });

  it("reads tree through namespaced get_tool_tree", async () => {
    const { registry, getPageToolsTree } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.getToolTree);
    const payload = await handler?.({});
    const parsed = parseTextResponse(payload);

    expect(getPageToolsTree).toHaveBeenCalledTimes(1);
    expect(parsed.totalTools).toBe(3);
    expect(parsed.enabledTools).toBe(2);
  });

  it("allows namespaced tool_debug_call for enabled read-only tools", async () => {
    const { registry, debugToolCall, getPageToolsTree } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.toolDebugCall);
    const payload = await handler?.({
      toolName: "builtin.list_tabs",
      args: { limit: 5 },
    });
    const parsed = parseTextResponse(payload);

    expect(getPageToolsTree).toHaveBeenCalledTimes(1);
    expect(debugToolCall).toHaveBeenCalledTimes(1);
    expect(debugToolCall).toHaveBeenCalledWith("builtin.list_tabs", { limit: 5 }, undefined);
    expect(parsed.ok).toBe(true);
    expect(parsed.toolName).toBe("builtin.list_tabs");
  });

  it("blocks non-readonly tools in namespaced tool_debug_call", async () => {
    const { registry, debugToolCall } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.toolDebugCall);
    const payload = await handler?.({
      toolName: "builtin.execute_js",
      args: { expression: "window.location.href" },
    });
    const parsed = parseTextResponse(payload);

    expect(debugToolCall).not.toHaveBeenCalled();
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("not read-only");
  });

  it("blocks disabled tools in namespaced tool_debug_call", async () => {
    const { registry, debugToolCall } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.toolDebugCall);
    const payload = await handler?.({
      toolName: "builtin.get_console_logs",
    });
    const parsed = parseTextResponse(payload);

    expect(debugToolCall).not.toHaveBeenCalled();
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("disabled");
  });

  it("applies batch updates through namespaced set_tools_enabled", async () => {
    const { registry, setPageToolsEnabledBatch } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.setToolsEnabled);
    const payload = await handler?.({
      updates: [
        { root: "builtin", toolName: "builtin.list_tabs", enabled: false },
        { root: "page", tabId: 88, namespace: "crm", toolName: "crm.inspect", enabled: true },
      ],
    });
    const parsed = parseTextResponse(payload);

    // Batch switching should only issue one batch call to avoid agent side writing manual loops.
    expect(setPageToolsEnabledBatch).toHaveBeenCalledTimes(1);
    expect(setPageToolsEnabledBatch).toHaveBeenCalledWith([
      { root: "builtin", toolName: "builtin.list_tabs", enabled: false },
      { root: "page", tabId: 88, namespace: "crm", toolName: "crm.inspect", enabled: true },
    ]);
    expect(parsed.applied).toBe(2);
    expect((parsed.tree as { enabledTools: number }).enabledTools).toBe(3);
  });

  it("rejects page updates without tabId to avoid silent no-op", async () => {
    const { registry } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.setToolsEnabled);
    await expect(() =>
      handler?.({
        updates: [{ root: "page", namespace: "crm", enabled: false }],
      })
    ).rejects.toThrow(/requires tabId/);
  });

  it("refreshes one tab page tools and syncs registry immediately through namespaced tool", async () => {
    const { registry, refreshPageTools, getContextManifest } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.refreshPageTools);
    const payload = await handler?.({ tabId: 88 });
    const parsed = parseTextResponse(payload);

    // After agent actively refreshes, it should immediately write the latest tools back to the current registry to avoid waiting for async notifications.
    expect(refreshPageTools).toHaveBeenCalledTimes(1);
    expect(refreshPageTools).toHaveBeenCalledWith(88);
    expect(getContextManifest).toHaveBeenCalledTimes(1);
    expect(getContextManifest).toHaveBeenCalledWith(88);
    expect(parsed.ok).toBe(true);
    expect(parsed.refreshedToolCount).toBe(1);
    expect(parsed.toolNames).toEqual(["crm.inspect"]);
    expect(registry.getPageToolsByTab().get(88)).toEqual([
      { name: "crm.inspect", description: "Inspect CRM entity" },
    ]);
  });

  it("prepares one tab for debug by chaining ensure/refresh/tree/set operations", async () => {
    const {
      registry,
      getRuntimeStatus,
      ensureMainWorldHost,
      ensureAgentationMain,
      refreshPageTools,
      getContextManifest,
      getPageToolsTree,
      setPageToolsEnabledBatch,
    } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);
    getPageToolsTree.mockResolvedValueOnce({
      builtins: {
        kind: "builtins",
        totalTools: 3,
        enabledTools: 2,
        namespaces: [
          {
            kind: "builtin-namespace",
            namespace: "builtin",
            totalTools: 3,
            enabledTools: 2,
            instances: [
              {
                kind: "builtin-instance",
                namespace: "builtin",
                instanceId: "default",
                totalTools: 3,
                enabledTools: 2,
                tools: [
                  { kind: "builtin-tool", namespace: "builtin", instanceId: "default", toolName: "builtin.list_tabs", enabled: true, readOnly: true },
                  { kind: "builtin-tool", namespace: "builtin", instanceId: "default", toolName: "builtin.execute_js", enabled: true, readOnly: false },
                  { kind: "builtin-tool", namespace: "builtin", instanceId: "default", toolName: "builtin.get_console_logs", enabled: false, readOnly: true },
                ],
              },
            ],
          },
        ],
      },
      tabs: [
        {
          kind: "tab",
          tabId: 88,
          namespaces: [
            {
              kind: "namespace",
              namespace: "crm",
              instances: [
                {
                  kind: "instance",
                  instanceId: "default",
                  tools: [
                    { kind: "tool", toolName: "crm.inspect", enabled: false, readOnly: true },
                    { kind: "tool", toolName: "crm.update", enabled: false, readOnly: false },
                  ],
                },
              ],
            },
          ],
        },
      ],
      totalTools: 5,
      enabledTools: 2,
    });

    const handler = fakeServer.tools.get(TOOL_NAMES.prepareTabForDebug);
    const payload = await handler?.({
      tabId: 88,
      frameId: 2,
      enableReadOnlyBuiltins: true,
    });
    const parsed = parseTextResponse(payload);

    // Combined entry must reuse existing atomic actions and execute each step only once for easy failure stage identification.
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(ensureMainWorldHost).toHaveBeenCalledTimes(1);
    expect(ensureMainWorldHost).toHaveBeenCalledWith(88, 2);
    expect(ensureAgentationMain).toHaveBeenCalledTimes(1);
    expect(ensureAgentationMain).toHaveBeenCalledWith(88, 2);
    expect(refreshPageTools).toHaveBeenCalledTimes(1);
    expect(refreshPageTools).toHaveBeenCalledWith(88);
    expect(getContextManifest).toHaveBeenCalledTimes(1);
    expect(getContextManifest).toHaveBeenCalledWith(88);
    expect(getPageToolsTree).toHaveBeenCalledTimes(1);
    expect(setPageToolsEnabledBatch).toHaveBeenCalledTimes(1);
    expect(setPageToolsEnabledBatch).toHaveBeenCalledWith([
      { root: "builtin", toolName: "builtin.get_console_logs", enabled: true },
      { root: "page", tabId: 88, namespace: "crm", instanceId: "default", toolName: "crm.inspect", enabled: true },
    ]);
    expect(parsed.ok).toBe(true);
    expect(parsed.tabId).toBe(88);
    expect((parsed.refreshed as { toolCount: number }).toolCount).toBe(1);
    expect((parsed.readOnlyEnable as { applied: number }).applied).toBe(2);
  });

  it("skips set_tools_enabled when prepare_tab_for_debug finds no read-only candidate", async () => {
    const { registry, setPageToolsEnabledBatch } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.prepareTabForDebug);
    const payload = await handler?.({ tabId: 88 });
    const parsed = parseTextResponse(payload);

    expect(setPageToolsEnabledBatch).not.toHaveBeenCalled();
    expect(parsed.ok).toBe(true);
    expect((parsed.readOnlyEnable as { applied: number }).applied).toBe(0);
  });

  it("returns explicit validation error when prepare_tab_for_debug misses tabId", async () => {
    const { registry, ensureMainWorldHost } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.prepareTabForDebug);
    const payload = await handler?.({});
    const parsed = parseTextResponse(payload);

    expect(ensureMainWorldHost).not.toHaveBeenCalled();
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("tabId must be a positive integer");
  });

  it("ensures main world host through namespaced ensure_main_world_host", async () => {
    const { registry, ensureMainWorldHost } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.ensureMainWorldHost);
    const payload = await handler?.({ tabId: 88, frameId: 2 });
    const parsed = parseTextResponse(payload);

    expect(ensureMainWorldHost).toHaveBeenCalledTimes(1);
    expect(ensureMainWorldHost).toHaveBeenCalledWith(88, 2);
    expect(parsed.ok).toBe(true);
    expect(parsed.tabId).toBe(88);
    expect(parsed.frameId).toBe(2);
  });

  it("returns explicit validation error when ensure_main_world_host misses tabId", async () => {
    const { registry, ensureMainWorldHost } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.ensureMainWorldHost);
    const payload = await handler?.({});
    const parsed = parseTextResponse(payload);

    expect(ensureMainWorldHost).not.toHaveBeenCalled();
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("tabId must be a positive integer");
  });

  it("ensures agentation main through namespaced ensure_agentation_main", async () => {
    const { registry, ensureAgentationMain } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.ensureAgentationMain);
    const payload = await handler?.({ tabId: 99 });
    const parsed = parseTextResponse(payload);

    expect(ensureAgentationMain).toHaveBeenCalledTimes(1);
    expect(ensureAgentationMain).toHaveBeenCalledWith(99, undefined);
    expect(parsed.ok).toBe(true);
    expect(parsed.tabId).toBe(99);
    expect(parsed.frameId).toBeNull();
  });

});
