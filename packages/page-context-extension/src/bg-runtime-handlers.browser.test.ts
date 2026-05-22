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

function makeSender(overrides?: Record<string, unknown>): chrome.runtime.MessageSender {
  return {
    id: 'extension-id',
    tab: { id: 1, url: 'https://example.com' },
    ...overrides,
  } as chrome.runtime.MessageSender;
}

function installChromeMock(): void {
  (globalThis as Record<string, unknown>).chrome = {
    tabs: {
      query: vi
        .fn()
        .mockResolvedValue([{ id: 5, url: 'https://active.example', title: 'active tab' }]),
      get: vi
        .fn()
        .mockImplementation(async (tabId: number) => ({
          id: tabId,
          url: `https://tab-${tabId}.example`,
        })),
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      debugger: { detach: vi.fn(), attach: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([{ result: '' }]),
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

describe('createRuntimeMessageHandler', () => {
  const sender = makeSender();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    installChromeMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createHandler(overrides?: Record<string, unknown>) {
    const deps = {
      pageToolState: makePageToolState(),
      installPageContextBridgeHostInMainWorld: vi.fn(),
      extensionControlHandlers: {
        buildExtensionStatusResponse: vi
          .fn()
          .mockReturnValue({ connected: true, wsUrl: null, pendingToolCalls: 0, sessionId: 's1' }),
        handleExtensionReconnect: vi.fn().mockResolvedValue({ ok: true }),
        handleExtensionPageToolsGet: vi.fn().mockReturnValue({ tools: [] }),
        handleExtensionPageToolsTreeGet: vi.fn().mockResolvedValue({ tree: {} }),
        handleExtensionPageToolsRefresh: vi.fn().mockResolvedValue({ tools: [] }),
        handleExtensionContextManifestGet: vi.fn().mockResolvedValue({ manifest: null }),
        handleExtensionContextResourceRead: vi.fn().mockResolvedValue({ content: '' }),
        handleExtensionContextSkillGet: vi.fn().mockResolvedValue({ prompt: '' }),
        handleExtensionPageToolsSetEnabled: vi.fn().mockResolvedValue({ tree: {} }),
        handleExtensionToolDebugCall: vi.fn().mockResolvedValue({ ok: true, result: null }),
      },
      requestBridgeMethod: vi.fn().mockResolvedValue({}),
      queueNotification: vi.fn(),
      ...overrides,
    };
    const { createRuntimeMessageHandler } = await import('./bg-runtime-handlers.js');
    return createRuntimeMessageHandler(deps as Parameters<typeof createRuntimeMessageHandler>[0]);
  }

  describe('delegation to extensionControlHandlers', () => {
    it('routes extensionStatusGet', async () => {
      const buildStatus = vi.fn().mockReturnValue({ connected: true });
      const h = await createHandler({
        extensionControlHandlers: {
          buildExtensionStatusResponse: buildStatus,
          handleExtensionReconnect: vi.fn(),
          handleExtensionPageToolsGet: vi.fn(),
          handleExtensionPageToolsTreeGet: vi.fn(),
          handleExtensionPageToolsRefresh: vi.fn(),
          handleExtensionContextManifestGet: vi.fn(),
          handleExtensionContextResourceRead: vi.fn(),
          handleExtensionContextSkillGet: vi.fn(),
          handleExtensionPageToolsSetEnabled: vi.fn(),
          handleExtensionToolDebugCall: vi.fn(),
        } as never,
      });
      await h({ method: BRIDGE_METHODS.extensionStatusGet }, sender);
      expect(buildStatus).toHaveBeenCalled();
    });

    it('routes extensionReconnect', async () => {
      const reconnect = vi.fn().mockResolvedValue({ ok: true });
      const h = await createHandler({
        extensionControlHandlers: {
          buildExtensionStatusResponse: vi.fn(),
          handleExtensionReconnect: reconnect,
          handleExtensionPageToolsGet: vi.fn(),
          handleExtensionPageToolsTreeGet: vi.fn(),
          handleExtensionPageToolsRefresh: vi.fn(),
          handleExtensionContextManifestGet: vi.fn(),
          handleExtensionContextResourceRead: vi.fn(),
          handleExtensionContextSkillGet: vi.fn(),
          handleExtensionPageToolsSetEnabled: vi.fn(),
          handleExtensionToolDebugCall: vi.fn(),
        } as never,
      });
      await h({ method: BRIDGE_METHODS.extensionReconnect }, sender);
      expect(reconnect).toHaveBeenCalled();
    });

    it('routes extensionPageToolsGet', async () => {
      const getPageTools = vi.fn().mockReturnValue({ tools: [] });
      const h = await createHandler({
        extensionControlHandlers: {
          buildExtensionStatusResponse: vi.fn(),
          handleExtensionReconnect: vi.fn(),
          handleExtensionPageToolsGet: getPageTools,
          handleExtensionPageToolsTreeGet: vi.fn(),
          handleExtensionPageToolsRefresh: vi.fn(),
          handleExtensionContextManifestGet: vi.fn(),
          handleExtensionContextResourceRead: vi.fn(),
          handleExtensionContextSkillGet: vi.fn(),
          handleExtensionPageToolsSetEnabled: vi.fn(),
          handleExtensionToolDebugCall: vi.fn(),
        } as never,
      });
      await h({ method: BRIDGE_METHODS.extensionPageToolsGet, params: { tabId: 1 } }, sender);
      expect(getPageTools).toHaveBeenCalledWith({ tabId: 1 });
    });

    it('routes extensionPageToolsTreeGet', async () => {
      const getTree = vi.fn().mockResolvedValue({});
      const h = await createHandler({
        extensionControlHandlers: {
          buildExtensionStatusResponse: vi.fn(),
          handleExtensionReconnect: vi.fn(),
          handleExtensionPageToolsGet: vi.fn(),
          handleExtensionPageToolsTreeGet: getTree,
          handleExtensionPageToolsRefresh: vi.fn(),
          handleExtensionContextManifestGet: vi.fn(),
          handleExtensionContextResourceRead: vi.fn(),
          handleExtensionContextSkillGet: vi.fn(),
          handleExtensionPageToolsSetEnabled: vi.fn(),
          handleExtensionToolDebugCall: vi.fn(),
        } as never,
      });
      await h({ method: BRIDGE_METHODS.extensionPageToolsTreeGet }, sender);
      expect(getTree).toHaveBeenCalled();
    });

    it('routes extensionPageToolsDiscover/Refresh', async () => {
      const refresh = vi.fn().mockResolvedValue({ tools: [] });
      const h = await createHandler({
        extensionControlHandlers: {
          buildExtensionStatusResponse: vi.fn(),
          handleExtensionReconnect: vi.fn(),
          handleExtensionPageToolsGet: vi.fn(),
          handleExtensionPageToolsTreeGet: vi.fn(),
          handleExtensionPageToolsRefresh: refresh,
          handleExtensionContextManifestGet: vi.fn(),
          handleExtensionContextResourceRead: vi.fn(),
          handleExtensionContextSkillGet: vi.fn(),
          handleExtensionPageToolsSetEnabled: vi.fn(),
          handleExtensionToolDebugCall: vi.fn(),
        } as never,
      });
      await h({ method: BRIDGE_METHODS.extensionPageToolsDiscover, params: { tabId: 1 } }, sender);
      expect(refresh).toHaveBeenCalledWith({ tabId: 1 });
    });

    it('routes extensionContextManifestGet', async () => {
      const getManifest = vi.fn().mockResolvedValue({});
      const h = await createHandler({
        extensionControlHandlers: {
          buildExtensionStatusResponse: vi.fn(),
          handleExtensionReconnect: vi.fn(),
          handleExtensionPageToolsGet: vi.fn(),
          handleExtensionPageToolsTreeGet: vi.fn(),
          handleExtensionPageToolsRefresh: vi.fn(),
          handleExtensionContextManifestGet: getManifest,
          handleExtensionContextResourceRead: vi.fn(),
          handleExtensionContextSkillGet: vi.fn(),
          handleExtensionPageToolsSetEnabled: vi.fn(),
          handleExtensionToolDebugCall: vi.fn(),
        } as never,
      });
      await h({ method: BRIDGE_METHODS.extensionContextManifestGet, params: { tabId: 1 } }, sender);
      expect(getManifest).toHaveBeenCalledWith({ tabId: 1 });
    });

    it('routes extensionContextResourceRead', async () => {
      const readRes = vi.fn().mockResolvedValue({});
      const h = await createHandler({
        extensionControlHandlers: {
          buildExtensionStatusResponse: vi.fn(),
          handleExtensionReconnect: vi.fn(),
          handleExtensionPageToolsGet: vi.fn(),
          handleExtensionPageToolsTreeGet: vi.fn(),
          handleExtensionPageToolsRefresh: vi.fn(),
          handleExtensionContextManifestGet: vi.fn(),
          handleExtensionContextResourceRead: readRes,
          handleExtensionContextSkillGet: vi.fn(),
          handleExtensionPageToolsSetEnabled: vi.fn(),
          handleExtensionToolDebugCall: vi.fn(),
        } as never,
      });
      await h(
        {
          method: BRIDGE_METHODS.extensionContextResourceRead,
          params: { tabId: 1, resourceId: 'r1' },
        },
        sender,
      );
      expect(readRes).toHaveBeenCalledWith({ tabId: 1, resourceId: 'r1' });
    });

    it('routes extensionContextSkillGet', async () => {
      const getSkill = vi.fn().mockResolvedValue({});
      const h = await createHandler({
        extensionControlHandlers: {
          buildExtensionStatusResponse: vi.fn(),
          handleExtensionReconnect: vi.fn(),
          handleExtensionPageToolsGet: vi.fn(),
          handleExtensionPageToolsTreeGet: vi.fn(),
          handleExtensionPageToolsRefresh: vi.fn(),
          handleExtensionContextManifestGet: vi.fn(),
          handleExtensionContextResourceRead: vi.fn(),
          handleExtensionContextSkillGet: getSkill,
          handleExtensionPageToolsSetEnabled: vi.fn(),
          handleExtensionToolDebugCall: vi.fn(),
        } as never,
      });
      await h(
        { method: BRIDGE_METHODS.extensionContextSkillGet, params: { tabId: 1, skillId: 's1' } },
        sender,
      );
      expect(getSkill).toHaveBeenCalledWith({ tabId: 1, skillId: 's1' });
    });
  });

  describe('feedback state snapshot routing', () => {
    it('forwards to requestBridgeMethod with params', async () => {
      const requestBridge = vi.fn().mockResolvedValue({});
      const h = await createHandler({ requestBridgeMethod: requestBridge });
      await h(
        {
          method: BRIDGE_METHODS.extensionFeedbackStateSnapshot,
          params: { tabId: 5 },
        },
        sender,
      );

      expect(requestBridge).toHaveBeenCalledWith(
        BRIDGE_METHODS.feedbackStateSnapshot,
        expect.objectContaining({ tabId: 5 }),
      );
    });

    it('uses explicit tabId first when sender tab is missing', async () => {
      const requestBridge = vi.fn().mockResolvedValue({});
      const tabsQuery = chrome.tabs.query as unknown as ReturnType<typeof vi.fn>;
      const h = await createHandler({ requestBridgeMethod: requestBridge });

      await h(
        {
          method: BRIDGE_METHODS.extensionFeedbackStateSnapshot,
          params: { tabId: 33, windowId: 9 },
        },
        makeSender({ tab: undefined }),
      );

      expect(tabsQuery).not.toHaveBeenCalled();
      expect(requestBridge).toHaveBeenCalledWith(
        BRIDGE_METHODS.feedbackStateSnapshot,
        expect.objectContaining({ tabId: 33 }),
      );
    });

    it('resolves fallback snapshot tab from explicit windowId when sender tab is missing', async () => {
      const requestBridge = vi.fn().mockResolvedValue({});
      const tabsQuery = chrome.tabs.query as unknown as ReturnType<typeof vi.fn>;
      tabsQuery.mockResolvedValue([{ id: 17, url: 'https://window.example', title: 'window tab' }]);
      const h = await createHandler({ requestBridgeMethod: requestBridge });

      await h(
        {
          method: BRIDGE_METHODS.extensionFeedbackStateSnapshot,
          params: { windowId: 9 },
        },
        makeSender({ tab: undefined }),
      );

      expect(tabsQuery).toHaveBeenCalledWith({ active: true, windowId: 9 }, expect.any(Function));
      expect(requestBridge).toHaveBeenCalledWith(
        BRIDGE_METHODS.feedbackStateSnapshot,
        expect.objectContaining({ tabId: 17 }),
      );
    });
  });

  describe('feedback delta validation', () => {
    it('rejects non-finite afterSeq', async () => {
      const h = await createHandler();
      await expect(
        h(
          { method: BRIDGE_METHODS.extensionFeedbackStateDelta, params: { afterSeq: NaN } },
          sender,
        ),
      ).rejects.toThrow('non-negative number');
    });

    it('rejects negative afterSeq', async () => {
      const h = await createHandler();
      await expect(
        h({ method: BRIDGE_METHODS.extensionFeedbackStateDelta, params: { afterSeq: -1 } }, sender),
      ).rejects.toThrow('non-negative number');
    });

    it('accepts afterSeq=0', async () => {
      const requestBridge = vi.fn().mockResolvedValue({});
      const h = await createHandler({ requestBridgeMethod: requestBridge });
      await h(
        { method: BRIDGE_METHODS.extensionFeedbackStateDelta, params: { afterSeq: 0 } },
        sender,
      );
      expect(requestBridge).toHaveBeenCalled();
    });
  });

  describe('feedback annotation create validation', () => {
    it('rejects empty body', async () => {
      const h = await createHandler();
      await expect(
        h(
          { method: BRIDGE_METHODS.extensionFeedbackAnnotationCreate, params: { body: '   ' } },
          sender,
        ),
      ).rejects.toThrow('body is required');
    });

    it('rejects missing priority', async () => {
      const h = await createHandler();
      await expect(
        h(
          { method: BRIDGE_METHODS.extensionFeedbackAnnotationCreate, params: { body: 'test' } },
          sender,
        ),
      ).rejects.toThrow('priority is required');
    });

    it('uses explicit tabId for sidepanel create requests without sender tab', async () => {
      const requestBridge = vi.fn().mockResolvedValue({});
      const tabsGet = chrome.tabs.get as unknown as ReturnType<typeof vi.fn>;
      const tabsQuery = chrome.tabs.query as unknown as ReturnType<typeof vi.fn>;
      tabsGet.mockResolvedValue({ id: 23, url: 'https://bound.example', title: 'bound tab' });
      const h = await createHandler({ requestBridgeMethod: requestBridge });

      await h(
        {
          method: BRIDGE_METHODS.extensionFeedbackAnnotationCreate,
          params: { body: 'test', priority: 'normal', tabId: 23 },
        },
        makeSender({ tab: undefined }),
      );

      expect(tabsGet).toHaveBeenCalledWith(23, expect.any(Function));
      expect(tabsQuery).not.toHaveBeenCalled();
      expect(requestBridge).toHaveBeenCalledWith(
        BRIDGE_METHODS.feedbackAnnotationCreate,
        expect.objectContaining({ tabId: 23, url: 'https://bound.example' }),
      );
    });
  });

  describe('feedback annotation update validation', () => {
    it('rejects missing annotationId', async () => {
      const h = await createHandler();
      await expect(
        h(
          {
            method: BRIDGE_METHODS.extensionFeedbackAnnotationUpdate,
            params: { body: 'test', priority: 'medium' },
          },
          sender,
        ),
      ).rejects.toThrow('annotationId is required');
    });

    it('rejects empty body', async () => {
      const h = await createHandler();
      await expect(
        h(
          {
            method: BRIDGE_METHODS.extensionFeedbackAnnotationUpdate,
            params: { annotationId: 'a1', body: '  ', priority: 'medium' },
          },
          sender,
        ),
      ).rejects.toThrow('body is required');
    });
  });

  describe('feedback annotation dismiss validation', () => {
    it('trims annotationId and dismissReason', async () => {
      const requestBridge = vi.fn().mockResolvedValue({});
      const h = await createHandler({ requestBridgeMethod: requestBridge });
      await h(
        {
          method: BRIDGE_METHODS.extensionFeedbackAnnotationDismiss,
          params: { annotationId: '  a1  ', dismissReason: '  dup  ' },
        },
        sender,
      );

      const callArgs = requestBridge.mock.calls[0];
      if (callArgs) {
        const payload = callArgs[1] as { annotationId: string; dismissReason?: string };
        expect(payload.annotationId).toBe('a1');
        expect(payload.dismissReason).toBe('dup');
      }
    });

    it('rejects empty annotationId after trim', async () => {
      const h = await createHandler();
      await expect(
        h(
          {
            method: BRIDGE_METHODS.extensionFeedbackAnnotationDismiss,
            params: { annotationId: '   ' },
          },
          sender,
        ),
      ).rejects.toThrow('annotationId is required');
    });
  });

  describe('page event notification', () => {
    it('queues notification with sender tab info', async () => {
      const queueNotif = vi.fn();
      const h = await createHandler({ queueNotification: queueNotif });
      const result = await h(
        {
          method: BRIDGE_METHODS.extensionPageEvent,
          params: { payload: { type: 'click' } },
        },
        sender,
      );

      expect(result).toEqual({ ok: true });
      expect(queueNotif).toHaveBeenCalledWith(
        BRIDGE_METHODS.bridgePageEvent,
        expect.objectContaining({ tabId: 1 }),
      );
    });
  });

  describe('page tools register', () => {
    it('throws when no sender tab', async () => {
      const h = await createHandler();
      const noTabSender = makeSender({ tab: undefined });
      await expect(
        h(
          {
            method: BRIDGE_METHODS.extensionPageToolsRegister,
            params: { namespace: 'ns1', tools: [{ name: 't1' }] },
          },
          noTabSender,
        ),
      ).rejects.toThrow('No sender tab available');
    });
  });

  describe('set enabled delegation', () => {
    it('delegates to extensionControlHandlers', async () => {
      const setEnabled = vi.fn().mockResolvedValue({});
      const h = await createHandler({
        extensionControlHandlers: {
          buildExtensionStatusResponse: vi.fn(),
          handleExtensionReconnect: vi.fn(),
          handleExtensionPageToolsGet: vi.fn(),
          handleExtensionPageToolsTreeGet: vi.fn(),
          handleExtensionPageToolsRefresh: vi.fn(),
          handleExtensionContextManifestGet: vi.fn(),
          handleExtensionContextResourceRead: vi.fn(),
          handleExtensionContextSkillGet: vi.fn(),
          handleExtensionPageToolsSetEnabled: setEnabled,
          handleExtensionToolDebugCall: vi.fn(),
        } as never,
      });
      await h(
        {
          method: BRIDGE_METHODS.extensionPageToolsSetEnabled,
          params: { root: 'builtin', enabled: false },
        },
        sender,
      );
      expect(setEnabled).toHaveBeenCalled();
    });
  });

  describe('debug call delegation', () => {
    it('delegates to extensionControlHandlers', async () => {
      const debugCall = vi.fn().mockResolvedValue({ ok: true });
      const h = await createHandler({
        extensionControlHandlers: {
          buildExtensionStatusResponse: vi.fn(),
          handleExtensionReconnect: vi.fn(),
          handleExtensionPageToolsGet: vi.fn(),
          handleExtensionPageToolsTreeGet: vi.fn(),
          handleExtensionPageToolsRefresh: vi.fn(),
          handleExtensionContextManifestGet: vi.fn(),
          handleExtensionContextResourceRead: vi.fn(),
          handleExtensionContextSkillGet: vi.fn(),
          handleExtensionPageToolsSetEnabled: vi.fn(),
          handleExtensionToolDebugCall: debugCall,
        } as never,
      });
      await h(
        {
          method: BRIDGE_METHODS.extensionToolDebugCall,
          params: { toolName: 'test-tool' },
        },
        sender,
      );
      expect(debugCall).toHaveBeenCalledWith({ toolName: 'test-tool' });
    });
  });

  describe('unknown method handling', () => {
    it('throws error for unknown methods', async () => {
      const h = await createHandler();
      await expect(h({ method: 'unknown.method' }, sender)).rejects.toThrow();
    });
  });
});
