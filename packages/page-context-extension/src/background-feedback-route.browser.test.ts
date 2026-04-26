import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_METHODS, createRequest } from '@page-context/shared-protocol';

const requestBridgeMock = vi.fn();
const captureActiveTabFeedbackContextMock = vi.fn();
const enrichUiAnchorReactMetaInMainWorldMock = vi.fn();

let runtimeMessageListener:
  | ((
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ) => boolean)
  | null = null;

vi.mock('./bg-ws-connection', () => ({
  connectWebSocket: vi.fn(async () => undefined),
  forceReconnect: vi.fn(async () => undefined),
  getWsReady: vi.fn(() => false),
  getSessionId: vi.fn(() => 'session-test'),
  initDefaultWsUrl: vi.fn(async () => undefined),
  log: vi.fn(),
  queueNotification: vi.fn(),
  requestBridge: requestBridgeMock,
}));

vi.mock('./bg-feedback-context', () => ({
  captureActiveTabFeedbackContext: captureActiveTabFeedbackContextMock,
}));

vi.mock('@page-context/agentation', () => ({
  enrichUiAnchorReactMetaInMainWorld: enrichUiAnchorReactMetaInMainWorldMock,
  ensureAgentationMainOnSenderTab: vi.fn(async () => ({ ok: true })),
  ensureAgentationMainOnTab: vi.fn(async () => ({ ok: true })),
  ensureMainWorldBridgeHostOnTab: vi.fn(async () => ({ ok: true })),
  ensureMainWorldBridgeHostOnSenderTab: vi.fn(async () => ({ ok: true })),
  getMainWorldInjectionTarget: vi.fn((params: unknown) => params),
}));

vi.mock('./bg-page-context', () => ({
  discoverPageToolsInTab: vi.fn(async () => []),
  getRawPageContextManifest: vi.fn(async () => null),
  getPageContextSkill: vi.fn(async () => null),
  readPageContextResource: vi.fn(async () => ({
    id: 'r',
    mimeType: 'application/json',
    text: '{}',
  })),
  sleep: vi.fn(async () => undefined),
}));

vi.mock(
  './bg-tool-executor',
  () => ({
    executeToolCall: vi.fn(async () => ({ ok: true })),
    getBuiltinToolDefinitions: vi.fn(() => []),
  }),
  { virtual: true },
);

vi.mock(
  '@page-context/tool-executor',
  () => ({
    executeToolCall: vi.fn(async () => ({ ok: true })),
    getBuiltinToolDefinitions: vi.fn(() => []),
    getExtensionToolProviders: vi.fn(() => []),
    getServiceWorkerContext: vi.fn(() => ({})),
  }),
  { virtual: true },
);

vi.mock('./context-manifest-filter-debug', () => ({
  buildContextManifestFilterDebug: vi.fn(() => ({ filtered: true })),
}));

vi.mock('./page-tool-registry', () => ({
  flattenPageTools: vi.fn((entries?: unknown[]) => entries ?? []),
  mergePageToolEntry: vi.fn((entries: unknown[]) => entries),
  normalizePageToolEntries: vi.fn((entries: unknown[]) => entries ?? []),
}));

vi.mock('./page-tool-visibility', () => ({
  buildToolTree: vi.fn(async () => ({ tabs: [] })),
  getEnabledBuiltinTools: vi.fn((tools: unknown[]) => tools),
  getEnabledToolsForTab: vi.fn((entries?: unknown[]) => entries ?? []),
  isToolEnabled: vi.fn(() => true),
  setScopeEnabled: vi.fn((current: Record<string, unknown>) => current),
}));

describe('background feedback runtime route', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    runtimeMessageListener = null;
    installChromeMock();

    // Avoid background top-level persistent interval affecting test lifecycle.
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(
      1 as unknown as ReturnType<typeof setInterval>,
    );

    captureActiveTabFeedbackContextMock.mockResolvedValue({
      tabId: 12,
      url: 'https://sender.example/path',
      title: 'sender-tab',
      selectedText: 'from context selection',
    });
    enrichUiAnchorReactMetaInMainWorldMock.mockImplementation(
      async (_tabId: number, anchor: Record<string, unknown>) => ({
        ...anchor,
        cssSelector: ' .cta-enriched ',
        meta: {
          from: 'react-meta',
        },
      }),
    );
    requestBridgeMock.mockResolvedValue({ annotation: { id: 'anno-1' } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreChromeGlobal(originalChrome);
  });

  it('maps extension create request to bridge create call with sender tab context', async () => {
    const listener = await importBackgroundAndGetRuntimeMessageListener();
    const sendResponse = vi.fn();

    const keepChannel = listener(
      createRequest(
        BRIDGE_METHODS.extensionFeedbackAnnotationCreate,
        {
          body: '  Need to fix button click state  ',
          priority: 'high',
          selectedText: '  User selection  ',
          uiAnchor: {
            cssSelector: ' .cta ',
            meta: {},
          },
        },
        'req-feedback-1',
      ),
      {
        tab: {
          id: 12,
        },
      } as chrome.runtime.MessageSender,
      sendResponse,
    );

    expect(keepChannel).toBe(true);
    await flushMicrotasks();

    expect(captureActiveTabFeedbackContextMock).toHaveBeenCalledTimes(1);
    expect(enrichUiAnchorReactMetaInMainWorldMock).toHaveBeenCalledWith(12, {
      cssSelector: ' .cta ',
      meta: {},
    });
    expect(requestBridgeMock).toHaveBeenCalledWith(
      BRIDGE_METHODS.feedbackAnnotationCreate,
      expect.objectContaining({
        body: 'Need to fix button click state',
        priority: 'high',
        tabId: 12,
        url: 'https://sender.example/path',
        title: 'sender-tab',
        selectedText: 'User selection',
        uiAnchor: expect.objectContaining({
          cssSelector: '.cta-enriched',
          meta: {
            from: 'react-meta',
          },
        }),
      }),
      { timeoutMs: 20_000 },
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledTimes(1);
    });
    const response = sendResponse.mock.calls[0]?.[0] as
      | { id?: string; result?: unknown }
      | undefined;
    expect(response?.id).toBe('req-feedback-1');
    expect(response?.result).toEqual({ annotation: { id: 'anno-1' } });
  });

  it('passes snapshot push-agent observability fields through to sidepanel callers', async () => {
    const listener = await importBackgroundAndGetRuntimeMessageListener();
    const sendResponse = vi.fn();
    requestBridgeMock.mockResolvedValueOnce({
      sessions: [],
      annotations: [],
      snapshotVersion: 3,
      lastSeq: 19,
      pushAgent: {
        enabled: true,
        readiness: 'ready',
        mode: 'local-opencode',
        lastLaunch: {
          annotationId: 'annotation_77',
          sessionId: 'session_9',
          attemptedAt: '2026-04-23T01:23:45.000Z',
          result: 'failed',
          failureReason: 'ENOENT: opencode not found',
        },
      },
    });

    listener(
      createRequest(BRIDGE_METHODS.extensionFeedbackStateSnapshot, {}, 'req-feedback-snapshot-1'),
      {
        tab: {
          id: 12,
        },
      } as chrome.runtime.MessageSender,
      sendResponse,
    );
    await flushMicrotasks();

    expect(requestBridgeMock).toHaveBeenCalledWith(
      BRIDGE_METHODS.feedbackStateSnapshot,
      { tabId: 12 },
      { timeoutMs: 20_000 },
    );
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledTimes(1);
    });
    const response = sendResponse.mock.calls[0]?.[0] as
      | { id?: string; result?: { pushAgent?: { lastLaunch?: { failureReason?: string } } } }
      | undefined;
    expect(response?.id).toBe('req-feedback-snapshot-1');
    expect(response?.result?.pushAgent?.lastLaunch?.failureReason).toContain('ENOENT');
  });

  it('uses context selectedText and alias anchor when UI selectedText is empty', async () => {
    const listener = await importBackgroundAndGetRuntimeMessageListener();
    const sendResponse = vi.fn();

    listener(
      createRequest(
        BRIDGE_METHODS.extensionFeedbackAnnotationCreate,
        {
          body: 'Add fallback selection',
          priority: 'normal',
          selectedText: '   ',
          anchor: {
            xpath: ' //button[1] ',
            framePath: [0, -1, 2.5, 1],
            meta: {},
          },
        },
        'req-feedback-2',
      ),
      {
        tab: {
          id: 12,
        },
      } as chrome.runtime.MessageSender,
      sendResponse,
    );
    await flushMicrotasks();

    // Compatible field anchor does not go through enrich, directly enters unified normalization path.
    expect(enrichUiAnchorReactMetaInMainWorldMock).not.toHaveBeenCalled();
    expect(requestBridgeMock).toHaveBeenCalledWith(
      BRIDGE_METHODS.feedbackAnnotationCreate,
      expect.objectContaining({
        body: 'Add fallback selection',
        selectedText: 'from context selection',
        uiAnchor: expect.objectContaining({
          xpath: '//button[1]',
          framePath: [0, 1],
        }),
      }),
      { timeoutMs: 20_000 },
    );
  });

  it('returns rpc error response when body is empty', async () => {
    const listener = await importBackgroundAndGetRuntimeMessageListener();
    const sendResponse = vi.fn();

    listener(
      createRequest(
        BRIDGE_METHODS.extensionFeedbackAnnotationCreate,
        {
          body: '   ',
          priority: 'normal',
        },
        'req-feedback-3',
      ),
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );
    await flushMicrotasks();

    expect(captureActiveTabFeedbackContextMock).not.toHaveBeenCalled();
    expect(requestBridgeMock).not.toHaveBeenCalled();

    const response = sendResponse.mock.calls[0]?.[0] as
      | { id?: string; error?: { message?: string } }
      | undefined;
    expect(response?.id).toBe('req-feedback-3');
    expect(response?.error?.message).toContain('Feedback body is required');
  });

  it('maps extension update request to bridge update call with normalized payload', async () => {
    const listener = await importBackgroundAndGetRuntimeMessageListener();
    const sendResponse = vi.fn();

    listener(
      createRequest(
        BRIDGE_METHODS.extensionFeedbackAnnotationUpdate,
        {
          annotationId: '  anno-2  ',
          body: '  update body  ',
          priority: 'critical',
        },
        'req-feedback-4',
      ),
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );
    await flushMicrotasks();

    expect(requestBridgeMock).toHaveBeenCalledWith(
      BRIDGE_METHODS.feedbackAnnotationUpdate,
      {
        annotationId: 'anno-2',
        body: 'update body',
        priority: 'critical',
      },
      { timeoutMs: 20_000 },
    );
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledTimes(1);
    });
    const response = sendResponse.mock.calls[0]?.[0] as
      | { id?: string; result?: unknown }
      | undefined;
    expect(response?.id).toBe('req-feedback-4');
    expect(response?.result).toEqual({ annotation: { id: 'anno-1' } });
  });

  it('maps extension dismiss request to bridge dismiss call with normalized payload', async () => {
    const listener = await importBackgroundAndGetRuntimeMessageListener();
    const sendResponse = vi.fn();

    listener(
      createRequest(
        BRIDGE_METHODS.extensionFeedbackAnnotationDismiss,
        {
          annotationId: '  anno-3  ',
          dismissReason: '  duplicated  ',
        },
        'req-feedback-5',
      ),
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );
    await flushMicrotasks();

    expect(requestBridgeMock).toHaveBeenCalledWith(
      BRIDGE_METHODS.feedbackAnnotationDismiss,
      {
        annotationId: 'anno-3',
        dismissReason: 'duplicated',
      },
      { timeoutMs: 20_000 },
    );
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledTimes(1);
    });
    const response = sendResponse.mock.calls[0]?.[0] as
      | { id?: string; result?: unknown }
      | undefined;
    expect(response?.id).toBe('req-feedback-5');
    expect(response?.result).toEqual({ annotation: { id: 'anno-1' } });
  });

  it('returns rpc error response when dismiss annotationId is empty', async () => {
    const listener = await importBackgroundAndGetRuntimeMessageListener();
    const sendResponse = vi.fn();

    listener(
      createRequest(
        BRIDGE_METHODS.extensionFeedbackAnnotationDismiss,
        {
          annotationId: '   ',
          dismissReason: 'invalid',
        },
        'req-feedback-6',
      ),
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );
    await flushMicrotasks();

    // When input validation fails, it should not enter bridge request.
    expect(requestBridgeMock).not.toHaveBeenCalled();
    const response = sendResponse.mock.calls[0]?.[0] as
      | { id?: string; error?: { message?: string } }
      | undefined;
    expect(response?.id).toBe('req-feedback-6');
    expect(response?.error?.message).toContain('Feedback annotationId is required');
  });
});

async function importBackgroundAndGetRuntimeMessageListener() {
  await import('./background');
  if (!runtimeMessageListener) {
    throw new Error('Missing background runtime listener');
  }
  return runtimeMessageListener;
}

function installChromeMock(): void {
  const chromeMock = {
    runtime: {
      onMessage: {
        addListener: vi.fn((listener: typeof runtimeMessageListener) => {
          runtimeMessageListener = listener;
        }),
      },
      onInstalled: {
        addListener: vi.fn(),
      },
      onStartup: {
        addListener: vi.fn(),
      },
      getPlatformInfo: vi.fn((callback?: () => void) => callback?.()),
    },
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: 12, url: 'https://sender.example/path', title: 'sender-tab' })),
      sendMessage: vi.fn(async () => ({})),
      onActivated: {
        addListener: vi.fn(),
      },
      onUpdated: {
        addListener: vi.fn(),
      },
      onRemoved: {
        addListener: vi.fn(),
      },
    },
    scripting: {
      executeScript: vi.fn(async () => []),
    },
    storage: {
      local: {
        get: vi.fn(async (defaults: Record<string, unknown>) => defaults),
        set: vi.fn(async () => undefined),
      },
    },
  } as unknown as typeof chrome;

  Object.defineProperty(globalThis, 'chrome', {
    value: chromeMock,
    configurable: true,
    writable: true,
  });
}

function restoreChromeGlobal(originalChrome: typeof chrome | undefined): void {
  if (originalChrome) {
    Object.defineProperty(globalThis, 'chrome', {
      value: originalChrome,
      configurable: true,
      writable: true,
    });
    return;
  }
  Reflect.deleteProperty(globalThis, 'chrome');
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
