import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { BRIDGE_METHODS, RpcPeer, type PageContextManifest } from '@page-context/shared-protocol';
import { WebSocket } from 'ws';

import {
  createExtensionState,
  getContextManifestDebugFromExtension,
  getContextManifestFromExtension,
  getContextSkillPromptFromExtension,
  getPageToolsTreeFromExtension,
  getRuntimeStatusFromExtension,
  readContextResourceFromExtension,
  refreshPageToolsFromExtension,
  sendToolCallToExtension,
  setPageToolsEnabledBatchOnExtension,
} from './extension-session.js';
import { startSseServerWithHandle } from './http-servers.js';
import { McpRegistry } from './mcp-registry.js';
import { TenantManager } from './tenant-manager.js';

describe('extension-session SSE client chain', () => {
  const cleanupTasks: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanupTasks.length > 0) {
      const task = cleanupTasks.pop();
      await task?.();
    }
  });

  it('lets a real MCP client list and call page tools through SSE bridge transport', async () => {
    const tenantId = 'tenant-sse-chain';
    const manager = new TenantManager({
      createRegistry: (id: string) =>
        new McpRegistry(
          {
            sendToolCall: (tool, args, tabId) =>
              sendToolCallToExtension(id, manager, tool, args, tabId),
            getRuntimeStatus: () => getRuntimeStatusFromExtension(id, manager),
            reconnectExtension: async () => ({ ok: true }),
            debugToolCall: async () => ({ ok: true }),
            ensureMainWorldHost: async () => ({ ok: true }),
            ensureAgentationMain: async () => ({ ok: true }),
            getContextManifest: (tabId) => getContextManifestFromExtension(id, manager, tabId),
            getContextManifestDebug: (tabId) =>
              getContextManifestDebugFromExtension(id, manager, tabId),
            refreshPageTools: (tabId) => refreshPageToolsFromExtension(id, manager, tabId),
            readContextResource: (tabId, resourceId) =>
              readContextResourceFromExtension(id, manager, tabId, resourceId),
            getContextSkillPrompt: (tabId, skillId, input) =>
              getContextSkillPromptFromExtension(id, manager, tabId, skillId, input),
            getPageToolsTree: () => getPageToolsTreeFromExtension(id, manager),
            setPageToolsEnabledBatch: (updates) =>
              setPageToolsEnabledBatchOnExtension(id, manager, updates),
          },
          id,
        ),
    });

    const tenant = manager.getOrCreate(tenantId);
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

    let extensionPeer: RpcPeer;
    const ws = {
      readyState: WebSocket.OPEN,
      send: (message: string) => extensionPeer.receive(message),
      close: vi.fn(),
    } as unknown as WebSocket;

    const slot = createExtensionState(ws, tenant.registry, tenantId, manager);
    tenant.extension = slot;

    extensionPeer = new RpcPeer({
      send: (message: string) => slot.peer.receive(message),
      defaultTimeoutMs: 2_000,
    });

    const pageToolCall = vi.fn(async (params?: unknown) => ({
      ok: true,
      echoed: params,
      data: { title: 'Lead 88' },
    }));

    extensionPeer.register(BRIDGE_METHODS.extensionStatusGet, async () => ({
      connected: true,
      sessionId: 'extension-session-sse',
      pendingToolCalls: 0,
    }));
    extensionPeer.register(BRIDGE_METHODS.extensionContextManifestGet, async () => ({
      manifest,
      rawManifest: manifest,
      debug: null,
    }));
    extensionPeer.register(BRIDGE_METHODS.extensionContextResourceRead, async () => ({
      id: 'lead.resource',
      text: '{"ok":true}',
    }));
    extensionPeer.register(BRIDGE_METHODS.extensionContextSkillGet, async () => ({ prompt: null }));
    extensionPeer.register(BRIDGE_METHODS.extensionPageToolsRefresh, async () => ({
      tools: [{ name: 'crm.inspect', description: 'Inspect CRM entity', _namespace: 'crm' }],
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
    extensionPeer.register(BRIDGE_METHODS.extensionPageToolsSetEnabled, async () => ({ ok: true }));
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
        {
          name: 'builtin.page.navigate',
          description: 'Navigate current tab',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string' },
            },
          },
        },
      ],
    });

    await extensionPeer.request(BRIDGE_METHODS.bridgePageToolsRegistered, {
      tabId: 88,
      tools: [
        {
          name: 'crm.inspect',
          description: 'Inspect CRM entity',
          _namespace: 'crm',
          inputSchema: {
            type: 'object',
            properties: {
              entityId: { type: 'number' },
              includeHistory: { type: 'boolean' },
            },
          },
        },
      ],
    });

    const started = await startSseServerWithHandle(0, manager);
    expect(started.ok).toBe(true);
    cleanupTasks.push(async () => {
      await started.close();
    });

    const transport = new SSEClientTransport(
      new URL(`http://127.0.0.1:${started.port}/${tenantId}/sse`),
    );
    cleanupTasks.push(async () => {
      await transport.close().catch(() => undefined);
    });

    const client = new Client({ name: 'mcp-test-client', version: '1.0.0' });
    await client.connect(transport);

    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((tool) => tool.name);
    expect(toolNames).toContain('builtin.tabs.list_tabs');
    expect(toolNames).toContain('builtin.page.navigate');
    expect(toolNames).toContain('tab.88.crm.inspect');
    expect(toolNames).toContain('extension.get_tool_tree');

    const callResult = await client.callTool({
      name: 'tab.88.crm.inspect',
      arguments: { entityId: 88, includeHistory: true },
    });

    expect(pageToolCall).toHaveBeenCalledTimes(1);
    expect(pageToolCall).toHaveBeenCalledWith(
      {
        tool: 'crm.inspect',
        args: { entityId: 88, includeHistory: true },
        tabId: 88,
      },
      expect.objectContaining({ method: BRIDGE_METHODS.bridgeToolCall }),
    );
    expect(callResult.isError).not.toBe(true);
    const callText = callResult.content
      .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    expect(callText).toContain('Lead 88');
    expect(callText).toContain('crm.inspect');
  });

  it('preserves page tool arguments when the tool has no declared input schema', async () => {
    const tenantId = 'tenant-sse-chain-no-schema';
    const manager = new TenantManager({
      createRegistry: (id: string) =>
        new McpRegistry(
          {
            sendToolCall: (tool, args, tabId) =>
              sendToolCallToExtension(id, manager, tool, args, tabId),
            getRuntimeStatus: () => getRuntimeStatusFromExtension(id, manager),
            reconnectExtension: async () => ({ ok: true }),
            debugToolCall: async () => ({ ok: true }),
            ensureMainWorldHost: async () => ({ ok: true }),
            ensureAgentationMain: async () => ({ ok: true }),
            getContextManifest: async () => null,
            getContextManifestDebug: async () => ({
              manifest: null,
              rawManifest: null,
              debug: null,
            }),
            refreshPageTools: async () => [],
            readContextResource: async () => ({ id: 'resource', text: '{}' }),
            getContextSkillPrompt: async () => null,
            getPageToolsTree: () => getPageToolsTreeFromExtension(id, manager),
            setPageToolsEnabledBatch: async () => ({ ok: true }),
          },
          id,
        ),
    });

    const tenant = manager.getOrCreate(tenantId);
    let extensionPeer: RpcPeer;
    const ws = {
      readyState: WebSocket.OPEN,
      send: (message: string) => extensionPeer.receive(message),
      close: vi.fn(),
    } as unknown as WebSocket;

    const slot = createExtensionState(ws, tenant.registry, tenantId, manager);
    tenant.extension = slot;

    extensionPeer = new RpcPeer({
      send: (message: string) => slot.peer.receive(message),
      defaultTimeoutMs: 2_000,
    });

    const pageToolCall = vi.fn(async (params?: unknown) => ({
      ok: true,
      echoed: params,
    }));

    extensionPeer.register(BRIDGE_METHODS.extensionStatusGet, async () => ({
      connected: true,
      sessionId: 'extension-session-sse-no-schema',
      pendingToolCalls: 0,
    }));
    extensionPeer.register(BRIDGE_METHODS.extensionContextManifestGet, async () => ({
      manifest: null,
      rawManifest: null,
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
          tabId: 1,
          title: 'Demo',
          url: 'https://example.com/demo',
          active: true,
          totalTools: 1,
          enabledTools: 1,
          namespaces: [
            {
              kind: 'namespace',
              tabId: 1,
              namespace: 'e2e',
              totalTools: 1,
              enabledTools: 1,
              instances: [
                {
                  kind: 'instance',
                  tabId: 1,
                  namespace: 'e2e',
                  instanceId: 'test',
                  totalTools: 1,
                  enabledTools: 1,
                  tools: [
                    {
                      kind: 'tool',
                      tabId: 1,
                      namespace: 'e2e',
                      instanceId: 'test',
                      toolName: 'e2e.test.e2e-tool-1',
                      label: 'e2e-tool-1',
                      enabled: true,
                      readOnly: false,
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
    extensionPeer.register(BRIDGE_METHODS.extensionPageToolsSetEnabled, async () => ({ ok: true }));
    extensionPeer.register(BRIDGE_METHODS.bridgeToolCall, pageToolCall);

    const registerResult = await extensionPeer.request<{ sessionId: string }>(
      BRIDGE_METHODS.sessionRegister,
      {
        extensionId: 'firefox-extension',
        version: '0.0.1',
      },
    );
    expect(registerResult.sessionId).toBeTruthy();

    await extensionPeer.request(BRIDGE_METHODS.bridgePageToolsRegistered, {
      tabId: 1,
      tools: [
        {
          name: 'e2e.test.e2e-tool-1',
          description: 'E2E tool without schema',
          _namespace: 'e2e',
        },
      ],
    });

    const started = await startSseServerWithHandle(0, manager);
    expect(started.ok).toBe(true);
    cleanupTasks.push(async () => {
      await started.close();
    });

    const transport = new SSEClientTransport(
      new URL(`http://127.0.0.1:${started.port}/${tenantId}/sse`),
    );
    cleanupTasks.push(async () => {
      await transport.close().catch(() => undefined);
    });

    const client = new Client({ name: 'mcp-test-client', version: '1.0.0' });
    await client.connect(transport);

    const callResult = await client.callTool({
      name: 'tab.1.e2e.test.e2e-tool-1',
      arguments: { probe: 'firefox-mcp-e2e' },
    });

    expect(pageToolCall).toHaveBeenCalledWith(
      {
        tool: 'e2e.test.e2e-tool-1',
        args: { probe: 'firefox-mcp-e2e' },
        tabId: 1,
      },
      expect.objectContaining({ method: BRIDGE_METHODS.bridgeToolCall }),
    );
    const callText = callResult.content
      .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    expect(callText).toContain('firefox-mcp-e2e');
  });
});
