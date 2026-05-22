import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runtimeGetUrl,
  runtimeSendMessage,
  storageLocalGet,
  storageLocalRemove,
  storageLocalSet,
  tabsCreate,
  tabsQuery,
  windowsGetCurrent,
} from './extension-api';

describe('extension-api', () => {
  const originalBrowser = (globalThis as typeof globalThis & { browser?: unknown }).browser;
  const originalChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;

  beforeEach(() => {
    Reflect.deleteProperty(globalThis, 'browser');
    Reflect.deleteProperty(globalThis, 'chrome');
  });

  afterEach(() => {
    restoreGlobal('browser', originalBrowser);
    restoreGlobal('chrome', originalChrome);
  });

  it('prefers browser.* promise APIs when available', async () => {
    const browserMock = {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ ok: true }),
        getURL: vi.fn((path: string) => `moz-extension://id/${path}`),
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ sidePanelUrl: 'http://127.0.0.1:22336/' }),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 42 }]),
        create: vi.fn().mockResolvedValue({ id: 43 }),
      },
      windows: {
        getCurrent: vi.fn().mockResolvedValue({ id: 9 }),
      },
    };
    (globalThis as typeof globalThis & { browser?: unknown }).browser = browserMock;
    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
      runtime: {
        sendMessage: vi.fn(() => {
          throw new Error('chrome fallback should not be used');
        }),
      },
    };

    await expect(runtimeSendMessage({ method: 'ping' })).resolves.toEqual({ ok: true });
    await expect(storageLocalGet('sidePanelUrl')).resolves.toEqual({
      sidePanelUrl: 'http://127.0.0.1:22336/',
    });
    await expect(storageLocalSet({ value: true })).resolves.toBeUndefined();
    await expect(storageLocalRemove('sidePanelUrl')).resolves.toBeUndefined();
    await expect(tabsQuery({ active: true, currentWindow: true })).resolves.toEqual([{ id: 42 }]);
    await expect(tabsCreate({ url: 'https://example.com' })).resolves.toEqual({ id: 43 });
    await expect(windowsGetCurrent()).resolves.toEqual({ id: 9 });
    expect(runtimeGetUrl('loader.html')).toBe('moz-extension://id/loader.html');
  });

  it('wraps chrome.* callback APIs when no browser namespace exists', async () => {
    const chromeMock = {
      runtime: {
        lastError: undefined as { message?: string } | undefined,
        sendMessage: vi.fn((_message: unknown, callback: (response: unknown) => void) => {
          callback({ ok: true });
        }),
        getURL: vi.fn((path: string) => `chrome-extension://id/${path}`),
      },
      storage: {
        local: {
          get: vi.fn((_keys: unknown, callback: (response: unknown) => void) => {
            callback({ mcpWsUrl: 'ws://127.0.0.1:22335/default' });
          }),
          set: vi.fn((_items: unknown, callback: () => void) => callback()),
          remove: vi.fn((_keys: unknown, callback: () => void) => callback()),
        },
      },
      tabs: {
        query: vi.fn((_query: unknown, callback: (tabs: unknown[]) => void) =>
          callback([{ id: 7 }]),
        ),
        create: vi.fn((_props: unknown, callback: (tab: unknown) => void) => callback({ id: 8 })),
      },
      windows: {
        getCurrent: vi.fn((callback: (win: unknown) => void) => callback({ id: 5 })),
      },
    };
    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = chromeMock;

    await expect(runtimeSendMessage({ method: 'ping' })).resolves.toEqual({ ok: true });
    await expect(storageLocalGet({ mcpWsUrl: 'default' })).resolves.toEqual({
      mcpWsUrl: 'ws://127.0.0.1:22335/default',
    });
    await expect(storageLocalSet({ value: true })).resolves.toBeUndefined();
    await expect(storageLocalRemove('sidePanelUrl')).resolves.toBeUndefined();
    await expect(tabsQuery({ active: true, currentWindow: true })).resolves.toEqual([{ id: 7 }]);
    await expect(tabsCreate({ url: 'https://example.com' })).resolves.toEqual({ id: 8 });
    await expect(windowsGetCurrent()).resolves.toEqual({ id: 5 });
    expect(runtimeGetUrl('loader.html')).toBe('chrome-extension://id/loader.html');
  });
});

function restoreGlobal(key: 'browser' | 'chrome', value: unknown): void {
  if (value == null) {
    Reflect.deleteProperty(globalThis, key);
    return;
  }
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
  });
}
