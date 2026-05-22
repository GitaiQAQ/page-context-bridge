import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BRIDGE_METHODS } from '@page-context/shared-protocol';

const executeToolCallMock = vi.fn(async () => ({ ok: true }));
const executePageToolInTabMock = vi.fn(async () => ({ ok: true, result: {} }));
const sendTabRequestMock = vi.fn(async () => ({ ok: true }));
const discoverPageToolsInTabMock = vi.fn(async () => []);
const getRawPageContextManifestMock = vi.fn(async () => null);
const getPageContextSkillMock = vi.fn(async () => null);
const readPageContextResourceMock = vi.fn(async () => ({
  id: 'r',
  mimeType: 'application/json',
  text: '{}',
}));
const sleepMock = vi.fn(async () => undefined);

vi.mock('@page-context/tool-executor', () => ({
  executeToolCall: executeToolCallMock,
  getBuiltinToolDefinitions: () => [
    {
      name: 'builtin.tabs.list_tabs',
      description: 'List tabs',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
  ],
}));

vi.mock('./bg-page-context', () => ({
  discoverPageToolsInTab: discoverPageToolsInTabMock,
  executePageToolInTab: executePageToolInTabMock,
  getRawPageContextManifest: getRawPageContextManifestMock,
  getPageContextSkill: getPageContextSkillMock,
  pageAccessBackendKind: 'chromium-native-main-world',
  readPageContextResource: readPageContextResourceMock,
  sleep: sleepMock,
}));

vi.mock('./runtime-rpc', () => ({
  sendTabRequest: sendTabRequestMock,
}));

function makePageToolState(overrides?: Record<string, unknown>) {
  return {
    pageToolsByTab: new Map(),
    pageToolPreferences: {},
    builtinToolPreferences: {},
    discoveryInFlight: new Map(),
    tabReloadDiscoveryInFlight: new Map(),
    ...overrides,
  };
}

function installChromeMock(): void {
  (globalThis as Record<string, unknown>).chrome = {
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      debugger: { detach: vi.fn(), attach: vi.fn() },
    },
    debugger: {
      onDetach: { addListener: vi.fn() },
      attach: vi.fn(),
      detach: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
    runtime: {
      id: 'test-ext',
      getManifest: () => ({ version: '0.0.0' }),
      sendMessage: vi.fn(),
    },
  };
}

describe('createWsHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    discoverPageToolsInTabMock.mockResolvedValue([]);
    getRawPageContextManifestMock.mockResolvedValue(null);
    getPageContextSkillMock.mockResolvedValue(null);
    readPageContextResourceMock.mockResolvedValue({
      id: 'r',
      mimeType: 'application/json',
      text: '{}',
    });
    sleepMock.mockResolvedValue(undefined);
    installChromeMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createHandlers(overrides?: Record<string, unknown>) {
    const inFlightToolCalls = new Map<string, string>();
    const deps = {
      pageToolState: makePageToolState(),
      inFlightToolCalls,
      listTabs: vi
        .fn()
        .mockResolvedValue([{ id: 1, url: 'https://example.com', title: 'Example', active: true }]),
      installPageContextBridgeHostInMainWorld: vi.fn(),
      bridgeConnection: {
        getWsReady: vi.fn().mockReturnValue(true),
        getSessionId: vi.fn().mockReturnValue('session-1'),
        forceReconnect: vi.fn().mockResolvedValue(undefined),
      },
      ...overrides,
    };
    const { createWsHandlers } = await import('./bg-ws-handlers.js');
    return createWsHandlers(deps as unknown as Parameters<typeof createWsHandlers>[0]);
  }

  describe('buildExtensionStatusResponse()', () => {
    it('returns connected status from bridgeConnection', async () => {
      const handlers = await createHandlers({
        bridgeConnection: {
          getWsReady: vi.fn().mockReturnValue(true),
          getSessionId: vi.fn().mockReturnValue('session-abc'),
          forceReconnect: vi.fn(),
        },
      });
      const status = handlers.buildExtensionStatusResponse();

      expect(status.connected).toBe(true);
      expect(status.wsUrl).toBeNull();
      expect(status.sessionId).toBe('session-abc');
    });

    it('reports pending tool calls count', async () => {
      const deps = {
        bridgeConnection: {
          getWsReady: vi.fn().mockReturnValue(true),
          getSessionId: vi.fn().mockReturnValue(null),
          forceReconnect: vi.fn(),
        },
      };
      const handlers = await createHandlers(deps);
      // We can't directly access inFlightToolCalls from outside, test via status shape
      const status1 = handlers.buildExtensionStatusResponse();
      expect(status1.pendingToolCalls).toBe(0);
    });

    it('reports disconnected when WS not ready', async () => {
      const handlers = await createHandlers({
        bridgeConnection: {
          getWsReady: vi.fn().mockReturnValue(false),
          getSessionId: vi.fn().mockReturnValue(null),
          forceReconnect: vi.fn(),
        },
      });
      const status = handlers.buildExtensionStatusResponse();

      expect(status.connected).toBe(false);
      expect(status.sessionId).toBeNull();
    });
  });

  describe('handleExtensionReconnect()', () => {
    it('calls forceReconnect and returns ok', async () => {
      const forceReconnect = vi.fn().mockResolvedValue(undefined);
      const handlers = await createHandlers({
        bridgeConnection: { forceReconnect, getWsReady: vi.fn(), getSessionId: vi.fn() } as never,
      });
      const result = await handlers.handleExtensionReconnect();

      expect(result).toEqual({ ok: true });
      expect(forceReconnect).toHaveBeenCalled();
    });
  });

  describe('handleExtensionPageToolsGet()', () => {
    it('returns tools for given tabId', async () => {
      const handlers = await createHandlers();
      const result = handlers.handleExtensionPageToolsGet({ tabId: 42 });

      expect(result).toHaveProperty('tools');
      expect(Array.isArray(result.tools)).toBe(true);
    });

    it('defaults to tabId 0 when not provided', async () => {
      const handlers = await createHandlers();
      const result = handlers.handleExtensionPageToolsGet({});

      expect(result).toHaveProperty('tools');
    });
  });

  describe('handleExtensionPageToolsRefresh()', () => {
    it('throws when no tabId provided', async () => {
      const handlers = await createHandlers();
      await expect(handlers.handleExtensionPageToolsRefresh({})).rejects.toThrow(
        'No tabId provided',
      );
    });

    it('throws when tabId is 0', async () => {
      const handlers = await createHandlers();
      await expect(handlers.handleExtensionPageToolsRefresh({ tabId: 0 })).rejects.toThrow(
        'No tabId provided',
      );
    });

    it('rethrows structured backend failure when discover path is unsupported', async () => {
      const { PageAccessBackendError } = await import('./bg-page-access-backend.js');
      discoverPageToolsInTabMock.mockRejectedValueOnce(
        new PageAccessBackendError({
          backendKind: 'firefox-probe',
          operation: 'discoverTools',
          reason: 'Firefox page access backend is not implemented yet',
        }),
      );

      const handlers = await createHandlers();
      await expect(handlers.handleExtensionPageToolsRefresh({ tabId: 1 })).rejects.toThrow(
        '[page-access-backend:firefox-probe] discoverTools',
      );
    });
  });

  describe('handleExtensionContextManifestGet()', () => {
    it('throws when no tabId provided', async () => {
      const handlers = await createHandlers();
      await expect(handlers.handleExtensionContextManifestGet({})).rejects.toThrow(
        'No tabId provided',
      );
    });

    it('surfaces backend failure from getRawManifest()', async () => {
      const { PageAccessBackendError } = await import('./bg-page-access-backend.js');
      getRawPageContextManifestMock.mockRejectedValueOnce(
        new PageAccessBackendError({
          backendKind: 'firefox-probe',
          operation: 'getRawManifest',
          reason: 'Firefox page access backend is not implemented yet',
        }),
      );

      const handlers = await createHandlers();
      await expect(handlers.handleExtensionContextManifestGet({ tabId: 1 })).rejects.toThrow(
        '[page-access-backend:firefox-probe] getRawManifest',
      );
    });
  });

  describe('handleExtensionContextResourceRead()', () => {
    it('throws when tabId missing', async () => {
      const handlers = await createHandlers();
      await expect(
        handlers.handleExtensionContextResourceRead({ resourceId: 'res-1' }),
      ).rejects.toThrow('tabId and resourceId are required');
    });

    it('throws when resourceId missing', async () => {
      const handlers = await createHandlers();
      await expect(handlers.handleExtensionContextResourceRead({ tabId: 1 })).rejects.toThrow(
        'tabId and resourceId are required',
      );
    });

    it('surfaces backend failure from readResource()', async () => {
      const { PageAccessBackendError } = await import('./bg-page-access-backend.js');
      readPageContextResourceMock.mockRejectedValueOnce(
        new PageAccessBackendError({
          backendKind: 'firefox-probe',
          operation: 'readResource',
          reason: 'Firefox page access backend is not implemented yet',
        }),
      );

      const handlers = await createHandlers();
      await expect(
        handlers.handleExtensionContextResourceRead({ tabId: 1, resourceId: 'res-1' }),
      ).rejects.toThrow('[page-access-backend:firefox-probe] readResource');
    });
  });

  describe('handleExtensionContextSkillGet()', () => {
    it('throws when tabId missing', async () => {
      const handlers = await createHandlers();
      await expect(handlers.handleExtensionContextSkillGet({ skillId: 'skill-1' })).rejects.toThrow(
        'tabId and skillId are required',
      );
    });

    it('throws when skillId missing', async () => {
      const handlers = await createHandlers();
      await expect(handlers.handleExtensionContextSkillGet({ tabId: 1 })).rejects.toThrow(
        'tabId and skillId are required',
      );
    });

    it('surfaces backend failure from getSkill()', async () => {
      const { PageAccessBackendError } = await import('./bg-page-access-backend.js');
      getPageContextSkillMock.mockRejectedValueOnce(
        new PageAccessBackendError({
          backendKind: 'firefox-probe',
          operation: 'getSkill',
          reason: 'Firefox page access backend is not implemented yet',
        }),
      );

      const handlers = await createHandlers();
      await expect(
        handlers.handleExtensionContextSkillGet({ tabId: 1, skillId: 'skill-1', input: {} }),
      ).rejects.toThrow('[page-access-backend:firefox-probe] getSkill');
    });
  });

  describe('handleExtensionToolDebugCall()', () => {
    it('throws when no toolName provided', async () => {
      const handlers = await createHandlers();
      await expect(handlers.handleExtensionToolDebugCall({})).rejects.toThrow();
    });

    it('rejects unavailable CDP/debugger builtin tools before execution', async () => {
      const handlers = await createHandlers();

      const result = await handlers.handleExtensionToolDebugCall({
        toolName: 'builtin.page.screenshot_page',
        args: {},
        tabId: 7,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Builtin tool is unavailable in this browser runtime');
      expect(executeToolCallMock).not.toHaveBeenCalled();
    });

    it('passes page-tool execution deps into executeToolCall', async () => {
      const handlers = await createHandlers({
        pageToolState: makePageToolState({
          pageToolsByTab: new Map([
            [
              7,
              [
                {
                  namespace: 'workspace',
                  instanceId: 'page',
                  tools: [
                    {
                      name: 'workspace.page.summarizeWorkspace',
                      description: 'Summarize workspace',
                    },
                  ],
                },
              ],
            ],
          ]),
        }),
      });

      await handlers.handleExtensionToolDebugCall({
        toolName: 'workspace.page.summarizeWorkspace',
        args: { sample: true },
        tabId: 7,
      });

      expect(executeToolCallMock).toHaveBeenCalledWith(
        'workspace.page.summarizeWorkspace',
        { sample: true },
        7,
        expect.objectContaining({
          executePageToolInTab: expect.any(Function),
          sendTabRequest: sendTabRequestMock,
        }),
      );

      const lastCall = executeToolCallMock.mock.calls[
        executeToolCallMock.mock.calls.length - 1
      ] as unknown as unknown[] | undefined;
      const executeDeps = lastCall?.[3] as unknown as {
        executePageToolInTab: (
          tabId: number,
          name: string,
          args: Record<string, unknown>,
          namespace?: string,
          instanceId?: string,
        ) => Promise<unknown>;
      };
      expect(executeDeps).toBeDefined();
      await executeDeps.executePageToolInTab(7, 'summarizeWorkspace', { sample: true });
      expect(executePageToolInTabMock).toHaveBeenCalledWith(
        7,
        'summarizeWorkspace',
        { sample: true },
        'page',
        undefined,
      );
    });

    it('returns a disabled-by-preferences error for debug calls to disabled builtins', async () => {
      vi.doMock('@page-context/tool-executor', () => ({
        executeToolCall: executeToolCallMock,
        getBuiltinToolDefinitions: () => [
          {
            name: 'builtin.page.navigate',
            description: 'Navigate',
            inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
          },
        ],
      }));

      const handlers = await createHandlers({
        pageToolState: makePageToolState({
          pageToolPreferences: {
            builtins: {
              tools: {
                'builtin.page.navigate': false,
              },
            },
          },
        }),
      });

      const result = await handlers.handleExtensionToolDebugCall({
        toolName: 'builtin.page.navigate',
        args: { url: 'https://example.com' },
        tabId: 7,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Tool is disabled by preferences: builtin.page.navigate');
      expect(executeToolCallMock).not.toHaveBeenCalled();
    });
  });

  describe('onToolCall()', () => {
    it('lazy-discovers missing page tools before execution when runtime state is temporarily empty', async () => {
      discoverPageToolsInTabMock.mockResolvedValueOnce([
        {
          namespace: 'crm',
          instanceId: 'default',
          tools: [{ name: 'inspect', description: 'Inspect lead' }],
        },
      ]);

      const handlers = await createHandlers();

      await handlers.onToolCall(
        {
          tool: 'crm.inspect',
          args: { entityId: 88 },
          tabId: 9,
        },
        'req-lazy-discover',
      );

      expect(discoverPageToolsInTabMock).toHaveBeenCalledWith(9);
      expect(executeToolCallMock).toHaveBeenCalledWith(
        'crm.inspect',
        { entityId: 88 },
        9,
        expect.objectContaining({
          executePageToolInTab: expect.any(Function),
          sendTabRequest: sendTabRequestMock,
        }),
      );
    });

    it('passes page-tool execution deps into executeToolCall', async () => {
      const handlers = await createHandlers({
        pageToolState: makePageToolState({
          pageToolsByTab: new Map([
            [
              9,
              [
                {
                  namespace: 'workspace',
                  instanceId: 'page',
                  tools: [
                    {
                      name: 'workspace.page.summarizeWorkspace',
                      description: 'Summarize workspace',
                    },
                  ],
                },
              ],
            ],
          ]),
        }),
      });

      await handlers.onToolCall(
        {
          tool: 'workspace.page.summarizeWorkspace',
          args: { sample: true },
          tabId: 9,
        },
        'req-1',
      );

      expect(executeToolCallMock).toHaveBeenCalledWith(
        'workspace.page.summarizeWorkspace',
        { sample: true },
        9,
        expect.objectContaining({
          executePageToolInTab: expect.any(Function),
          sendTabRequest: sendTabRequestMock,
        }),
      );

      const lastCall = executeToolCallMock.mock.calls[
        executeToolCallMock.mock.calls.length - 1
      ] as unknown as unknown[] | undefined;
      const executeDeps = lastCall?.[3] as unknown as {
        executePageToolInTab: (
          tabId: number,
          name: string,
          args: Record<string, unknown>,
          namespace?: string,
          instanceId?: string,
        ) => Promise<unknown>;
      };
      expect(executeDeps).toBeDefined();
      await executeDeps.executePageToolInTab(9, 'summarizeWorkspace', { sample: true });
      expect(executePageToolInTabMock).toHaveBeenCalledWith(
        9,
        'summarizeWorkspace',
        { sample: true },
        'page',
        undefined,
      );
    });

    it('rejects disabled builtin tools before execution even when they are listed', async () => {
      vi.doMock('@page-context/tool-executor', () => ({
        executeToolCall: executeToolCallMock,
        getBuiltinToolDefinitions: () => [
          {
            name: 'builtin.tabs.list_tabs',
            description: 'List tabs',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'builtin.page.navigate',
            description: 'Navigate',
            inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
          },
        ],
      }));

      const handlers = await createHandlers({
        pageToolState: makePageToolState({
          pageToolPreferences: {
            builtins: {
              tools: {
                'builtin.page.navigate': false,
              },
            },
          },
        }),
      });

      await expect(
        handlers.onToolCall(
          {
            tool: 'builtin.page.navigate',
            args: { url: 'https://example.com' },
            tabId: 9,
          },
          'req-disabled-builtin',
        ),
      ).rejects.toThrow('Tool is disabled by preferences: builtin.page.navigate');
      expect(executeToolCallMock).not.toHaveBeenCalled();
    });

    it('rejects disabled page tools before execution even when they are registered', async () => {
      const handlers = await createHandlers({
        pageToolState: makePageToolState({
          pageToolsByTab: new Map([
            [
              9,
              [
                {
                  namespace: 'crm',
                  instanceId: 'default',
                  tools: [{ name: 'crm.inspect', description: 'Inspect lead' }],
                },
              ],
            ],
          ]),
          pageToolPreferences: {
            tabs: {
              '9': {
                namespaces: {
                  crm: {
                    instances: {
                      default: {
                        tools: {
                          'crm.inspect': false,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      });

      await expect(
        handlers.onToolCall(
          {
            tool: 'crm.inspect',
            args: { entityId: 88 },
            tabId: 9,
          },
          'req-disabled-page',
        ),
      ).rejects.toThrow('Tool is disabled by preferences: crm.inspect');
      expect(executeToolCallMock).not.toHaveBeenCalled();
    });
  });

  describe('onBridgeWsExtensionRequest() - routing', () => {
    it('routes extensionStatusGet correctly', async () => {
      const handlers = await createHandlers();
      const result = await handlers.onBridgeWsExtensionRequest(
        BRIDGE_METHODS.extensionStatusGet,
        {},
      );
      expect(result).toHaveProperty('connected');
    });

    it('routes extensionReconnect correctly', async () => {
      const handlers = await createHandlers();
      const result = await handlers.onBridgeWsExtensionRequest(
        BRIDGE_METHODS.extensionReconnect,
        {},
      );
      expect(result).toEqual({ ok: true });
    });

    it('routes extensionPageToolsGet correctly', async () => {
      const handlers = await createHandlers();
      const result = await handlers.onBridgeWsExtensionRequest(
        BRIDGE_METHODS.extensionPageToolsGet,
        { tabId: 1 },
      );
      expect(result).toHaveProperty('tools');
    });

    it('routes extensionPageToolsDiscover/Refresh correctly', async () => {
      const handlers = await createHandlers();
      const result = await handlers.onBridgeWsExtensionRequest(
        BRIDGE_METHODS.extensionPageToolsDiscover,
        { tabId: 1 },
      );
      expect(result).toEqual({ tools: [] });
    });

    it('routes extensionContextManifestGet correctly', async () => {
      const handlers = await createHandlers();
      await expect(
        handlers.onBridgeWsExtensionRequest(BRIDGE_METHODS.extensionContextManifestGet, {}),
      ).rejects.toThrow('No tabId provided');
    });

    it('routes extensionContextResourceRead correctly', async () => {
      const handlers = await createHandlers();
      await expect(
        handlers.onBridgeWsExtensionRequest(BRIDGE_METHODS.extensionContextResourceRead, {}),
      ).rejects.toThrow('tabId and resourceId are required');
    });

    it('routes extensionContextSkillGet correctly', async () => {
      const handlers = await createHandlers();
      await expect(
        handlers.onBridgeWsExtensionRequest(BRIDGE_METHODS.extensionContextSkillGet, {}),
      ).rejects.toThrow('tabId and skillId are required');
    });

    it('routes extensionToolDebugCall correctly', async () => {
      const handlers = await createHandlers();
      await expect(
        handlers.onBridgeWsExtensionRequest(BRIDGE_METHODS.extensionToolDebugCall, {}),
      ).rejects.toThrow('No toolName provided');
    });

    it('throws error for unknown methods', async () => {
      const handlers = await createHandlers();
      await expect(handlers.onBridgeWsExtensionRequest('unknown.method', {})).rejects.toThrow();
    });
  });
});
