import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EXTENSION_CONTROL_TOOL_SUFFIXES } from '@page-context/builtin-tools';
import { BRIDGE_METHODS, RpcPeer, type PageContextManifest } from '@page-context/shared-protocol';
import { WebSocket } from 'ws';

import {
  createExtensionState,
  getPageToolsTreeFromExtension,
  getRuntimeStatusFromExtension,
  sendToolCallToExtension,
} from './extension-session.js';
import { McpRegistry } from './mcp-registry.js';
import type { TenantManager } from './tenant-manager.js';

class FakeMcpServer {
  public readonly tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  public readonly resources = new Map<string, unknown>();
  public readonly prompts = new Map<string, unknown>();

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

  registerResource(
    name: string,
    _uri: unknown,
    _meta: unknown,
    handler: unknown,
  ): { remove: () => void } {
    this.resources.set(name, handler);
    return { remove: () => this.resources.delete(name) };
  }

  registerPrompt(name: string, _meta: unknown, handler: unknown): { remove: () => void } {
    this.prompts.set(name, handler);
    return { remove: () => this.prompts.delete(name) };
  }
}

function parseTextResponse(payload: unknown) {
  const text = (payload as { content: Array<{ text: string }> }).content[0]?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('extension-session MCP chain', () => {
  it('bridges MCP tool calls to the connected extension through the real session RPC path', async () => {
    const tenantId = 'tenant-chain';
    const fakeServer = new FakeMcpServer();
    const tenant = { extension: null as unknown, registry: null as unknown };
    const manager = {
      get: vi.fn((id: string) => (id === tenantId ? tenant : undefined)),
      touch: vi.fn(),
    } as unknown as TenantManager;

    const registry = new McpRegistry(
      {
        sendToolCall: (tool, args, tabId) =>
          sendToolCallToExtension(tenantId, manager, tool, args, tabId),
        getRuntimeStatus: () => getRuntimeStatusFromExtension(tenantId, manager),
        reconnectExtension: async () => ({ ok: true }),
        debugToolCall: async () => ({ ok: true }),
        ensureMainWorldHost: async () => ({ ok: true }),
        ensureAgentationMain: async () => ({ ok: true }),
        getContextManifest: async () => null,
        getContextManifestDebug: async () => ({ manifest: null, rawManifest: null, debug: null }),
        refreshPageTools: async () => [],
        readContextResource: async () => ({ id: 'resource', text: '{}' }),
        getContextSkillPrompt: async () => null,
        getPageToolsTree: () => getPageToolsTreeFromExtension(tenantId, manager),
        setPageToolsEnabledBatch: async () => ({ ok: true }),
      },
      tenantId,
    );
    tenant.registry = registry;
    registry.addServer(fakeServer as unknown as McpServer);

    let extensionPeer: RpcPeer;
    const ws = {
      readyState: WebSocket.OPEN,
      send: (message: string) => extensionPeer.receive(message),
      close: vi.fn(),
    } as unknown as WebSocket;

    const slot = createExtensionState(ws, registry, tenantId, manager);
    tenant.extension = slot;

    extensionPeer = new RpcPeer({
      send: (message: string) => slot.peer.receive(message),
      defaultTimeoutMs: 1_000,
    });

    const manifest: PageContextManifest = {
      version: '1.0.0',
      app: 'crm',
      route: '/lead/88',
      scene: 'lead_detail',
      generatedAt: '2026-05-21T00:00:00.000Z',
      namespaces: [{ namespace: 'crm', title: 'CRM' }],
      resources: [],
      skills: [],
    };

    const pageToolCall = vi.fn(async (params?: unknown) => ({
      ok: true,
      echoed: params,
    }));

    extensionPeer.register(BRIDGE_METHODS.extensionStatusGet, async () => ({
      connected: true,
      sessionId: 'extension-session-1',
      pendingToolCalls: 0,
    }));
    extensionPeer.register(BRIDGE_METHODS.extensionContextManifestGet, async () => ({
      manifest,
      rawManifest: manifest,
      debug: null,
    }));
    extensionPeer.register(BRIDGE_METHODS.extensionPageToolsTreeGet, async () => ({
      builtins: {
        kind: 'builtins',
        totalTools: 0,
        enabledTools: 0,
        namespaces: [],
        tools: [],
      },
      tabs: [
        {
          kind: 'tab',
          tabId: 88,
          title: 'CRM',
          url: 'https://example.com/crm/88',
          active: true,
          totalTools: 1,
          enabledTools: 1,
          namespaces: [
            {
              kind: 'namespace',
              tabId: 88,
              namespace: 'crm',
              totalTools: 1,
              enabledTools: 1,
              instances: [
                {
                  kind: 'instance',
                  tabId: 88,
                  namespace: 'crm',
                  instanceId: 'default',
                  totalTools: 1,
                  enabledTools: 1,
                  tools: [
                    {
                      kind: 'tool',
                      tabId: 88,
                      namespace: 'crm',
                      instanceId: 'default',
                      toolName: 'crm.inspect',
                      label: 'inspect',
                      enabled: true,
                      readOnly: true,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      totalTools: 1,
      enabledTools: 1,
    }));
    extensionPeer.register(BRIDGE_METHODS.bridgeToolCall, pageToolCall);

    const registerResult = await extensionPeer.request<{ sessionId: string }>(
      BRIDGE_METHODS.sessionRegister,
      {
        extensionId: 'firefox-extension',
        version: '0.0.1',
      },
    );
    expect(registerResult.sessionId).toBeTruthy();

    await extensionPeer.request(BRIDGE_METHODS.bridgeBuiltinToolsUpdated, {
      tools: [
        {
          name: 'builtin.tabs.list_tabs',
          description: 'List browser tabs',
          inputSchema: {},
          annotations: { readOnlyHint: true },
        },
      ],
    });

    await extensionPeer.request(BRIDGE_METHODS.bridgePageToolsRegistered, {
      tabId: 88,
      tools: [{ name: 'crm.inspect', description: 'Inspect CRM entity', _namespace: 'crm' }],
    });

    const getToolTree = fakeServer.tools.get(
      `extension.${EXTENSION_CONTROL_TOOL_SUFFIXES.getToolTree}`,
    );
    expect(getToolTree).toBeDefined();
    const treePayload = await getToolTree?.({});
    const parsedTree = parseTextResponse(treePayload);
    expect(parsedTree.totalTools).toBe(1);
    expect(parsedTree.enabledTools).toBe(1);

    const pageToolHandler = fakeServer.tools.get('tab.88.crm.inspect');
    expect(pageToolHandler).toBeDefined();
    const toolPayload = await pageToolHandler?.({ entityId: 88, includeHistory: true });
    const parsedToolResult = parseTextResponse(toolPayload);

    expect(pageToolCall).toHaveBeenCalledTimes(1);
    expect(pageToolCall).toHaveBeenCalledWith(
      {
        tool: 'crm.inspect',
        args: { entityId: 88, includeHistory: true },
        tabId: 88,
      },
      expect.objectContaining({ method: BRIDGE_METHODS.bridgeToolCall }),
    );
    expect(parsedToolResult.ok).toBe(true);
    expect(parsedToolResult.echoed).toEqual({
      tool: 'crm.inspect',
      args: { entityId: 88, includeHistory: true },
      tabId: 88,
    });
    expect(registry.getPageToolsByTab().get(88)).toEqual([
      { name: 'crm.inspect', description: 'Inspect CRM entity', _namespace: 'crm' },
    ]);
  });

  it('replays current extension page tools immediately after session register', async () => {
    const tenantId = 'tenant-register-replay';
    const fakeServer = new FakeMcpServer();
    const tenant = { extension: null as unknown, registry: null as unknown };
    const manager = {
      get: vi.fn((id: string) => (id === tenantId ? tenant : undefined)),
      touch: vi.fn(),
    } as unknown as TenantManager;

    const registry = new McpRegistry(
      {
        sendToolCall: (tool, args, tabId) =>
          sendToolCallToExtension(tenantId, manager, tool, args, tabId),
        getRuntimeStatus: () => getRuntimeStatusFromExtension(tenantId, manager),
        reconnectExtension: async () => ({ ok: true }),
        debugToolCall: async () => ({ ok: true }),
        ensureMainWorldHost: async () => ({ ok: true }),
        ensureAgentationMain: async () => ({ ok: true }),
        getContextManifest: async () => null,
        getContextManifestDebug: async () => ({ manifest: null, rawManifest: null, debug: null }),
        refreshPageTools: async () => [],
        readContextResource: async () => ({ id: 'resource', text: '{}' }),
        getContextSkillPrompt: async () => null,
        getPageToolsTree: () => getPageToolsTreeFromExtension(tenantId, manager),
        setPageToolsEnabledBatch: async () => ({ ok: true }),
      },
      tenantId,
    );
    tenant.registry = registry;
    registry.addServer(fakeServer as unknown as McpServer);

    let extensionPeer: RpcPeer;
    const ws = {
      readyState: WebSocket.OPEN,
      send: (message: string) => extensionPeer.receive(message),
      close: vi.fn(),
    } as unknown as WebSocket;

    const slot = createExtensionState(ws, registry, tenantId, manager);
    tenant.extension = slot;

    extensionPeer = new RpcPeer({
      send: (message: string) => slot.peer.receive(message),
      defaultTimeoutMs: 1_000,
    });

    const manifest: PageContextManifest = {
      version: '1.0.0',
      app: 'crm',
      route: '/lead/88',
      scene: 'lead_detail',
      generatedAt: '2026-05-21T00:00:00.000Z',
      namespaces: [{ namespace: 'crm', title: 'CRM' }],
      resources: [
        {
          id: 'crm.lead-summary',
          namespace: 'crm',
          title: 'Lead Summary',
          description: 'Lead summary resource',
          mimeType: 'application/json',
        },
      ],
      skills: [
        {
          id: 'crm.inspect-skill',
          namespace: 'crm',
          title: 'Inspect Lead',
          description: 'Inspect the current lead',
        },
      ],
    };

    extensionPeer.register(BRIDGE_METHODS.extensionStatusGet, async () => ({
      connected: true,
      sessionId: 'extension-session-2',
      pendingToolCalls: 0,
    }));
    extensionPeer.register(BRIDGE_METHODS.extensionContextManifestGet, async () => ({
      manifest,
      rawManifest: manifest,
      debug: null,
    }));
    extensionPeer.register(BRIDGE_METHODS.extensionPageToolsTreeGet, async () => ({
      builtins: { kind: 'builtins', totalTools: 0, enabledTools: 0, namespaces: [], tools: [] },
      tabs: [
        {
          kind: 'tab',
          tabId: 88,
          title: 'CRM',
          url: 'https://example.com/crm/88',
          active: true,
          totalTools: 1,
          enabledTools: 1,
          namespaces: [],
        },
      ],
      totalTools: 1,
      enabledTools: 1,
    }));
    extensionPeer.register(BRIDGE_METHODS.extensionPageToolsGet, async () => ({
      tools: [{ name: 'crm.inspect', description: 'Inspect CRM entity', _namespace: 'crm' }],
    }));

    const registerResult = await extensionPeer.request<{ sessionId: string }>(
      BRIDGE_METHODS.sessionRegister,
      {
        extensionId: 'firefox-extension',
        version: '0.0.1',
      },
    );
    expect(registerResult.sessionId).toBeTruthy();

    await vi.waitFor(() => {
      expect(fakeServer.tools.has('tab.88.crm.inspect')).toBe(true);
    });
    expect(fakeServer.resources.has('tab.88.resource.crm.crm.lead-summary')).toBe(true);
    expect(fakeServer.prompts.has('tab.88.skill.crm.crm.inspect-skill')).toBe(true);

    expect(registry.getPageToolsByTab().get(88)).toEqual([
      { name: 'crm.inspect', description: 'Inspect CRM entity', _namespace: 'crm' },
    ]);
  });

  it('does not let stale register replay overwrite newer page tool events for the same tab', async () => {
    const tenantId = 'tenant-register-race';
    const fakeServer = new FakeMcpServer();
    const tenant = { extension: null as unknown, registry: null as unknown };
    const manager = {
      get: vi.fn((id: string) => (id === tenantId ? tenant : undefined)),
      touch: vi.fn(),
    } as unknown as TenantManager;

    const registry = new McpRegistry(
      {
        sendToolCall: (tool, args, tabId) =>
          sendToolCallToExtension(tenantId, manager, tool, args, tabId),
        getRuntimeStatus: () => getRuntimeStatusFromExtension(tenantId, manager),
        reconnectExtension: async () => ({ ok: true }),
        debugToolCall: async () => ({ ok: true }),
        ensureMainWorldHost: async () => ({ ok: true }),
        ensureAgentationMain: async () => ({ ok: true }),
        getContextManifest: async () => null,
        getContextManifestDebug: async () => ({ manifest: null, rawManifest: null, debug: null }),
        refreshPageTools: async () => [],
        readContextResource: async () => ({ id: 'resource', text: '{}' }),
        getContextSkillPrompt: async () => null,
        getPageToolsTree: () => getPageToolsTreeFromExtension(tenantId, manager),
        setPageToolsEnabledBatch: async () => ({ ok: true }),
      },
      tenantId,
    );
    tenant.registry = registry;
    registry.addServer(fakeServer as unknown as McpServer);

    let extensionPeer: RpcPeer;
    const ws = {
      readyState: WebSocket.OPEN,
      send: (message: string) => extensionPeer.receive(message),
      close: vi.fn(),
    } as unknown as WebSocket;

    const slot = createExtensionState(ws, registry, tenantId, manager);
    tenant.extension = slot;

    extensionPeer = new RpcPeer({
      send: (message: string) => slot.peer.receive(message),
      defaultTimeoutMs: 1_000,
    });

    const replayToolsDeferred =
      createDeferred<Array<{ name: string; description: string; _namespace: string }>>();
    const extensionPageToolsGet = vi.fn(async () => ({
      tools: await replayToolsDeferred.promise,
    }));

    extensionPeer.register(BRIDGE_METHODS.extensionStatusGet, async () => ({
      connected: true,
      sessionId: 'extension-session-race',
      pendingToolCalls: 0,
    }));
    extensionPeer.register(BRIDGE_METHODS.extensionContextManifestGet, async () => ({
      manifest: null,
      rawManifest: null,
      debug: null,
    }));
    extensionPeer.register(BRIDGE_METHODS.extensionPageToolsTreeGet, async () => ({
      builtins: { kind: 'builtins', totalTools: 0, enabledTools: 0, namespaces: [], tools: [] },
      tabs: [
        {
          kind: 'tab',
          tabId: 88,
          title: 'CRM',
          url: 'https://example.com/crm/88',
          active: true,
          totalTools: 1,
          enabledTools: 1,
          namespaces: [],
        },
      ],
      totalTools: 1,
      enabledTools: 1,
    }));
    extensionPeer.register(BRIDGE_METHODS.extensionPageToolsGet, extensionPageToolsGet);

    const registerPromise = extensionPeer.request<{ sessionId: string }>(
      BRIDGE_METHODS.sessionRegister,
      {
        extensionId: 'firefox-extension',
        version: '0.0.1',
      },
    );

    await vi.waitFor(() => {
      expect(extensionPageToolsGet).toHaveBeenCalledTimes(1);
    });

    const freshTools = [
      {
        name: 'crm.fresh',
        description: 'Fresh tool from live event',
        _namespace: 'crm',
      },
    ];
    const eventPromise = extensionPeer.request(BRIDGE_METHODS.bridgePageToolsRegistered, {
      tabId: 88,
      tools: freshTools,
    });

    replayToolsDeferred.resolve([
      {
        name: 'crm.stale',
        description: 'Stale tool from register replay',
        _namespace: 'crm',
      },
    ]);

    const registerResult = await registerPromise;
    expect(registerResult.sessionId).toBeTruthy();
    await eventPromise;

    expect(registry.getPageToolsByTab().get(88)).toEqual(freshTools);
    expect(fakeServer.tools.has('tab.88.crm.fresh')).toBe(true);
    expect(fakeServer.tools.has('tab.88.crm.stale')).toBe(false);
  });
});
