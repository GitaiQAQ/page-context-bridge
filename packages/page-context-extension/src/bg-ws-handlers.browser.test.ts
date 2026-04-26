import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BRIDGE_METHODS, RpcProtocolError, RPC_ERROR_CODES } from '@page-context/shared-protocol';

function makePageToolState(overrides?: Record<string, unknown>) {
  return {
    pageToolsByTab: new Map(),
    pageToolPreferences: {},
    builtinToolPreferences: {},
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
    return createWsHandlers(deps as Parameters<typeof createWsHandlers>[0]);
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
      // Access inFlightToolCalls through closure
      const state = handlers as unknown as {
        buildExtensionStatusResponse(): { pendingToolCalls: number };
      };
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
  });

  describe('handleExtensionContextManifestGet()', () => {
    it('throws when no tabId provided', async () => {
      const handlers = await createHandlers();
      await expect(handlers.handleExtensionContextManifestGet({})).rejects.toThrow(
        'No tabId provided',
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
  });

  describe('handleExtensionToolDebugCall()', () => {
    it('throws when no toolName provided', async () => {
      const handlers = await createHandlers();
      await expect(handlers.handleExtensionToolDebugCall({})).rejects.toThrow();
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
      // With valid tabId, validation passes but discovery fails due to incomplete chrome mock
      await expect(
        handlers.onBridgeWsExtensionRequest(BRIDGE_METHODS.extensionPageToolsDiscover, {
          tabId: 1,
        }),
      ).rejects.toThrow();
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
