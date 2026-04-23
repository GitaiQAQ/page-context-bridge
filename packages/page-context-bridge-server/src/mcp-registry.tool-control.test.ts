import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  EXTENSION_CONTROL_LEGACY_TOOL_NAMES,
  EXTENSION_CONTROL_TOOL_SUFFIXES,
} from "@page-context/builtin-tools";

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
    totalTools: 3,
    enabledTools: 2,
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
  it("registers namespaced tools and keeps legacy aliases for backward compatibility", () => {
    const { registry } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    expect(fakeServer.tools.has(TOOL_NAMES.getRuntimeStatus)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.reconnect)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.getContextManifestDebug)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.getToolTree)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.setToolsEnabled)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.refreshPageTools)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.ensureMainWorldHost)).toBe(true);
    expect(fakeServer.tools.has(TOOL_NAMES.ensureAgentationMain)).toBe(true);
    expect(fakeServer.tools.has(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.getRuntimeStatus)).toBe(true);
    expect(fakeServer.tools.has(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.reconnect)).toBe(true);
    expect(fakeServer.tools.has(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.getContextManifestDebug)).toBe(true);
    expect(fakeServer.tools.has(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.getToolTree)).toBe(true);
    expect(fakeServer.tools.has(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.setToolsEnabled)).toBe(true);
    expect(fakeServer.tools.has(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.refreshPageTools)).toBe(true);
    expect(fakeServer.tools.has(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.ensureMainWorldHost)).toBe(true);
    expect(fakeServer.tools.has(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.ensureAgentationMain)).toBe(true);
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

    // debug 工具应把 tabId 原样下发，避免 bridge 侧猜测当前 tab 造成混淆。
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

  it("applies batch updates through namespaced set_tools_enabled", async () => {
    const { registry, setPageToolsEnabledBatch } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(TOOL_NAMES.setToolsEnabled);
    const payload = await handler?.({
      updates: [
        { root: "builtin", toolName: "list_tabs", enabled: false },
        { root: "page", tabId: 88, namespace: "crm", toolName: "crm.inspect", enabled: true },
      ],
    });
    const parsed = parseTextResponse(payload);

    // 批量切换应只下发一次批处理调用，避免 agent 端手写循环。
    expect(setPageToolsEnabledBatch).toHaveBeenCalledTimes(1);
    expect(setPageToolsEnabledBatch).toHaveBeenCalledWith([
      { root: "builtin", toolName: "list_tabs", enabled: false },
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

    // agent 主动刷新后，应立即把最新工具写回当前 registry，避免等待异步通知。
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

  it("keeps legacy alias callable with same behavior", async () => {
    const { registry, getPageToolsTree } = createRegistry();
    const fakeServer = new FakeMcpServer();
    registry.addServer(fakeServer as unknown as McpServer);

    const handler = fakeServer.tools.get(EXTENSION_CONTROL_LEGACY_TOOL_NAMES.getToolTree);
    const payload = await handler?.({});
    const parsed = parseTextResponse(payload);

    expect(getPageToolsTree).toHaveBeenCalledTimes(1);
    expect(parsed.totalTools).toBe(3);
    expect(parsed.enabledTools).toBe(2);
  });
});
