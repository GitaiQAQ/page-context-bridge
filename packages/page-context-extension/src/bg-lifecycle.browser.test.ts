import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BRIDGE_METHODS } from '@page-context/shared-protocol';

/** Captured chrome event listeners for inspection. */
interface CapturedListeners {
  runtimeOnMessage: Array<(message: unknown, sender: unknown) => unknown>;
  tabsOnActivated: Array<(info: { tabId: number; windowId: number }) => void>;
  tabsOnUpdated: Array<(tabId: number, info: { status?: string; url?: string }) => void>;
  tabsOnRemoved: Array<(tabId: number) => void>;
  runtimeOnInstalled: Array<() => void>;
  runtimeOnStartup: Array<() => void>;
}

const captured: CapturedListeners = {
  runtimeOnMessage: [],
  tabsOnActivated: [],
  tabsOnUpdated: [],
  tabsOnRemoved: [],
  runtimeOnInstalled: [],
  runtimeOnStartup: [],
};

function makePageToolState(overrides?: Record<string, unknown>) {
  return {
    pageToolsByTab: new Map(),
    pageToolPreferences: {},
    builtinToolPreferences: {},
    tabReloadDiscoveryInFlight: new Map(),
    ...overrides,
  };
}

function installChromeMock(): () => void {
  const chromeMock = {
    runtime: {
      onMessage: {
        addListener: vi.fn((fn: (msg: unknown, sender: unknown) => unknown) => {
          captured.runtimeOnMessage.push(fn);
        }),
      },
      onInstalled: {
        addListener: vi.fn((fn: () => void) => {
          captured.runtimeOnInstalled.push(fn);
        }),
      },
      onStartup: {
        addListener: vi.fn((fn: () => void) => {
          captured.runtimeOnStartup.push(fn);
        }),
      },
      getPlatformInfo: vi.fn((cb: () => void) => cb()),
      sendMessage: vi.fn(),
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      onActivated: {
        addListener: vi.fn((fn: (info: { tabId: number; windowId: number }) => void) => {
          captured.tabsOnActivated.push(fn);
        }),
      },
      onUpdated: {
        addListener: vi.fn(
          (fn: (tabId: number, info: { status?: string; url?: string }) => void) => {
            captured.tabsOnUpdated.push(fn);
          },
        ),
      },
      onRemoved: {
        addListener: vi.fn((fn: (tabId: number) => void) => {
          captured.tabsOnRemoved.push(fn);
        }),
      },
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
  };

  (globalThis as Record<string, unknown>).chrome = chromeMock;

  return () => {
    Object.keys(captured).forEach((key) => {
      (captured as Record<string, unknown[]>)[key] = [];
    });
  };
}

describe('registerLifecycleListeners', () => {
  let cleanup: () => void;
  const log = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    cleanup = installChromeMock();
  });

  afterEach(() => {
    cleanup();
    vi.doUnmock('./bg-page-tools');
    vi.useRealTimers();
  });

  function makeDeps(overrides?: Record<string, unknown>) {
    return {
      pageToolState: makePageToolState(),
      installPageContextBridgeHostInMainWorld: vi.fn(),
      runtimeMessageHandler: vi.fn(),
      wsHandlers: {
        onToolCall: vi.fn(),
        onToolsList: vi.fn(),
        onTabsList: vi.fn(),
        onBridgeWsExtensionRequest: vi.fn(),
      },
      queueNotification: vi.fn(),
      connectWebSocket: vi.fn().mockResolvedValue(undefined),
      initDefaultWsUrl: vi.fn().mockResolvedValue(undefined),
      log,
      ...overrides,
    };
  }

  async function registerWithDeps(deps: Record<string, unknown>) {
    const { registerLifecycleListeners } = await import('./bg-lifecycle.js');
    registerLifecycleListeners(deps as Parameters<typeof registerLifecycleListeners>[0]);
  }

  it('registers runtime.onMessage listener', async () => {
    await registerWithDeps(makeDeps());

    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalled();
    expect(captured.runtimeOnMessage).toHaveLength(1);
  });

  it('registers all expected tab event listeners', async () => {
    await registerWithDeps(makeDeps());

    expect(chrome.tabs.onActivated.addListener).toHaveBeenCalled();
    expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled();
    expect(chrome.tabs.onRemoved.addListener).toHaveBeenCalled();
    expect(captured.tabsOnActivated).toHaveLength(1);
    expect(captured.tabsOnUpdated).toHaveLength(1);
    expect(captured.tabsOnRemoved.length).toBeGreaterThanOrEqual(1);
  });

  it('registers lifecycle listeners (installed + startup)', async () => {
    await registerWithDeps(makeDeps());

    expect(chrome.runtime.onInstalled.addListener).toHaveBeenCalled();
    expect(chrome.runtime.onStartup.addListener).toHaveBeenCalled();
    expect(captured.runtimeOnInstalled).toHaveLength(1);
    expect(captured.runtimeOnStartup).toHaveLength(1);
  });

  describe('tabs.onActivated handler', () => {
    it('queues tab activated notification', async () => {
      const queueNotif = vi.fn();
      await registerWithDeps({ ...makeDeps(), queueNotification: queueNotif });

      const activateHandler = captured.tabsOnActivated[0];
      if (!activateHandler) throw new Error('No activation handler');
      activateHandler({ tabId: 42, windowId: 1 });

      expect(queueNotif).toHaveBeenCalledWith(BRIDGE_METHODS.bridgeTabActivated, {
        tabId: 42,
        windowId: 1,
      });
    });
  });

  describe('tabs.onUpdated handler', () => {
    it('clears tools and discovery in-flight on loading', async () => {
      const flightMap = new Map<number, boolean>();
      flightMap.set(5, true);
      const toolsMap = new Map<number, unknown[]>();
      toolsMap.set(5, [{ name: 'old-tool' }]);
      const state = makePageToolState({
        tabReloadDiscoveryInFlight: flightMap,
        pageToolsByTab: toolsMap,
      });
      await registerWithDeps({ ...makeDeps(), pageToolState: state });

      const updateHandler = captured.tabsOnUpdated[0];
      if (!updateHandler) throw new Error('No update handler');
      updateHandler(5, { status: 'loading' });

      expect(state.tabReloadDiscoveryInFlight.has(5)).toBe(false);
      expect(state.pageToolsByTab.has(5)).toBe(false);
    });

    it('queues notification on complete or url change', async () => {
      const queueNotif = vi.fn();
      await registerWithDeps({ ...makeDeps(), queueNotification: queueNotif });

      const updateHandler = captured.tabsOnUpdated[0];
      if (!updateHandler) throw new Error('No update handler');

      updateHandler(3, { status: 'complete' });
      expect(queueNotif).toHaveBeenCalledWith(BRIDGE_METHODS.bridgeTabUpdated, {
        tabId: 3,
        status: 'complete',
      });

      updateHandler(4, { url: 'https://new.com' });
      expect(queueNotif).toHaveBeenCalledWith(BRIDGE_METHODS.bridgeTabUpdated, {
        tabId: 4,
        url: 'https://new.com',
      });
    });
  });

  describe('tabs.onRemoved handler', () => {
    it('cleans up tab state', async () => {
      const flightMap2 = new Map<number, boolean>();
      flightMap2.set(7, true);
      const toolsMap2 = new Map<number, unknown[]>();
      toolsMap2.set(7, [{ name: 'removed-tool' }]);
      const state = makePageToolState({
        tabReloadDiscoveryInFlight: flightMap2,
        pageToolsByTab: toolsMap2,
      });
      await registerWithDeps({ ...makeDeps(), pageToolState: state });

      const removeHandler = captured.tabsOnRemoved.at(-1);
      if (!removeHandler) throw new Error('No remove handler');
      removeHandler(7);

      expect(state.tabReloadDiscoveryInFlight.has(7)).toBe(false);
      expect(state.pageToolsByTab.has(7)).toBe(false);
    });
  });

  describe('runtime.onInstalled handler', () => {
    it('initializes default WS URL and connects WebSocket', async () => {
      const connectWs = vi.fn().mockResolvedValue(undefined);
      const initUrl = vi.fn().mockResolvedValue(undefined);

      await registerWithDeps({
        ...makeDeps(),
        connectWebSocket: connectWs,
        initDefaultWsUrl: initUrl,
      });

      const installedHandler = captured.runtimeOnInstalled[0];
      if (!installedHandler) throw new Error('No installed handler');
      installedHandler();

      expect(initUrl).toHaveBeenCalled();
      expect(connectWs).toHaveBeenCalled();
    });
  });

  describe('runtime.onStartup handler', () => {
    it('connects WebSocket on startup', async () => {
      const connectWs = vi.fn().mockResolvedValue(undefined);

      await registerWithDeps({ ...makeDeps(), connectWebSocket: connectWs });

      const startupHandler = captured.runtimeOnStartup[0];
      if (!startupHandler) throw new Error('No startup handler');
      startupHandler();

      expect(connectWs).toHaveBeenCalled();
    });
  });

  describe('initial connection', () => {
    it('connects WebSocket immediately on registration', async () => {
      const connectWs = vi.fn().mockResolvedValue(undefined);

      await registerWithDeps({ ...makeDeps(), connectWebSocket: connectWs });

      // Should be called once for immediate connection
      expect(connectWs).toHaveBeenCalledTimes(1);
    });

    it('discovers tools for already active tabs immediately on registration', async () => {
      const discoverPageToolsForTab = vi.fn().mockResolvedValue([]);

      vi.doMock('./bg-page-tools', () => ({
        clearPageTools: vi.fn(
          (state: { pageToolsByTab: Map<number, unknown[]> }, tabId: number) => {
            state.pageToolsByTab.delete(tabId);
          },
        ),
        discoverPageToolsAfterTabReload: vi.fn().mockResolvedValue(undefined),
        discoverPageToolsForTab,
        ensurePageToolPreferencesLoaded: vi.fn().mockResolvedValue(undefined),
        publishBuiltinTools: vi.fn(),
        publishPageToolsForTab: vi.fn(),
      }));

      (chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 77, active: true }]);

      await registerWithDeps(makeDeps());
      await Promise.resolve();
      await Promise.resolve();

      expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true }, expect.any(Function));
      expect(discoverPageToolsForTab).toHaveBeenCalledWith(
        expect.objectContaining({ pageToolsByTab: expect.any(Map) }),
        77,
        expect.any(Function),
      );
    });
  });

  describe('keep-alive timer', () => {
    it('sets up keep-alive interval calling getPlatformInfo', async () => {
      await registerWithDeps(makeDeps());

      // Advance time to trigger keep-alive
      vi.advanceTimersByTime(25_000);
      expect(chrome.runtime.getPlatformInfo).toHaveBeenCalled();

      vi.advanceTimersByTime(25_000);
      expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(2);
    });
  });
});
