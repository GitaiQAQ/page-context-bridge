import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_METHODS } from '@page-context/shared-protocol';

const discoverPageToolsInTabMock = vi.fn();
const queueNotificationMock = vi.fn();

let tabUpdatedListener:
  | ((tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void)
  | null = null;
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
  getWsReady: vi.fn(() => true),
  getSessionId: vi.fn(() => 'session-test'),
  initDefaultWsUrl: vi.fn(async () => undefined),
  log: vi.fn(),
  queueNotification: queueNotificationMock,
  requestBridge: vi.fn(async () => ({})),
}));

vi.mock('./bg-feedback-context', () => ({
  captureActiveTabFeedbackContext: vi.fn(async () => ({
    tabId: 1,
    url: 'https://example.com',
    title: 'example',
    selectedText: '',
  })),
}));

vi.mock(
  '@page-context/agentation',
  () => ({
    enrichUiAnchorReactMetaInMainWorld: vi.fn(async (_tabId: number, anchor: unknown) => anchor),
    ensureAgentationMainOnSenderTab: vi.fn(async () => ({ ok: true })),
    ensureAgentationMainOnTab: vi.fn(async () => ({ ok: true })),
    ensureMainWorldBridgeHostOnTab: vi.fn(async () => ({ ok: true })),
    ensureMainWorldBridgeHostOnSenderTab: vi.fn(async () => ({ ok: true })),
    getMainWorldInjectionTarget: vi.fn((params: unknown) => params),
  }),
  { virtual: true },
);

vi.mock('./bg-page-context', () => ({
  discoverPageToolsInTab: discoverPageToolsInTabMock,
  getRawPageContextManifest: vi.fn(async () => null),
  getPageContextSkill: vi.fn(async () => null),
  readPageContextResource: vi.fn(async () => ({
    id: 'r',
    mimeType: 'application/json',
    text: '{}',
  })),
  sleep: vi.fn(async () => undefined),
}));

// Mock real package directly, not through re-export shim

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

vi.mock(
  '@page-context/tool-visibility',
  () => ({
    buildToolTree: vi.fn(async () => ({ tabs: [] })),
    getEnabledBuiltinTools: vi.fn((tools: unknown[]) => tools),
    getEnabledToolsForTab: vi.fn((entries?: Array<{ tools?: unknown[] }>) =>
      (entries ?? []).flatMap((entry) => entry.tools ?? []),
    ),
    isToolEnabled: vi.fn(() => true),
    setScopeEnabled: vi.fn((current: Record<string, unknown>) => current),
    clearPageTools: vi.fn(),
    publishPageToolsForTab: vi.fn(),
    publishBuiltinTools: vi.fn(),
    flattenPageTools: vi.fn((entries?: Array<{ tools?: unknown[] }>) =>
      (entries ?? []).flatMap((entry) => entry.tools ?? []),
    ),
    mergePageToolEntry: vi.fn((entries: unknown[], entry: unknown) => [...entries, entry]),
    normalizePageToolEntries: vi.fn((entries: unknown[]) => entries ?? []),
  }),
  { virtual: true },
);

describe('background page tools refresh lifecycle', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tabUpdatedListener = null;
    runtimeMessageListener = null;
    installChromeMock();

    // Avoid background top-level persistent interval affecting test lifecycle.
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(
      1 as unknown as ReturnType<typeof setInterval>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreChromeGlobal(originalChrome);
  });

  it('clears and notifies unregistered on refresh loading even when url is unchanged', async () => {
    const listener = await importBackgroundAndGetTabUpdatedListener();
    const tool = { name: 'demo.inspect', description: 'inspect demo' };
    discoverPageToolsInTabMock.mockResolvedValueOnce([
      {
        namespace: 'page',
        instanceId: 'default',
        tools: [tool],
      },
    ]);

    listener(7, { status: 'complete' }, {
      id: 7,
      url: 'https://example.com',
      status: 'complete',
    } as chrome.tabs.Tab);
    await vi.waitFor(() => {
      const call = queueNotificationMock.mock.calls.find(
        ([method, payload]) =>
          method === BRIDGE_METHODS.bridgePageToolsRegistered &&
          (payload as { tabId?: number } | undefined)?.tabId === 7,
      );
      expect(call).toBeDefined();
      expect(call?.[1]).toMatchObject({
        tabId: 7,
        tools: [
          expect.objectContaining({
            name: 'demo.inspect',
            description: 'inspect demo',
          }),
        ],
      });
    });

    queueNotificationMock.mockClear();
    listener(7, { status: 'loading' }, {
      id: 7,
      url: 'https://example.com',
      status: 'loading',
    } as chrome.tabs.Tab);
    await flushMicrotasks();

    expect(queueNotificationMock).toHaveBeenCalledWith(BRIDGE_METHODS.bridgePageToolsUnregistered, {
      tabId: 7,
    });
  });

  it('auto rediscovers and publishes page tools after first discovery round is empty', async () => {
    const listener = await importBackgroundAndGetTabUpdatedListener();
    const tool = { name: 'demo.refreshed', description: 'after refresh' };

    // First round of discovery (4 polling attempts) cannot get tools, simulating page bridge delay.
    discoverPageToolsInTabMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      // Compensation round discovers tools again, should auto-publish without manual refresh.
      .mockResolvedValueOnce([
        {
          namespace: 'page',
          instanceId: 'default',
          tools: [tool],
        },
      ]);

    listener(11, { status: 'complete' }, {
      id: 11,
      url: 'https://example.com/next',
      status: 'complete',
    } as chrome.tabs.Tab);

    await vi.waitFor(() => {
      expect(discoverPageToolsInTabMock).toHaveBeenCalledTimes(5);
    });

    const call = queueNotificationMock.mock.calls.find(
      ([method, payload]) =>
        method === BRIDGE_METHODS.bridgePageToolsRegistered &&
        (payload as { tabId?: number } | undefined)?.tabId === 11,
    );
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      tabId: 11,
      tools: [
        expect.objectContaining({
          name: 'demo.refreshed',
          description: 'after refresh',
        }),
      ],
    });
  });
});

async function importBackgroundAndGetTabUpdatedListener() {
  await import('./background');
  if (!tabUpdatedListener) {
    throw new Error('Missing tabs.onUpdated listener');
  }
  return tabUpdatedListener;
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
      onActivated: {
        addListener: vi.fn(),
      },
      onUpdated: {
        addListener: vi.fn((listener: typeof tabUpdatedListener) => {
          tabUpdatedListener = listener;
        }),
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
