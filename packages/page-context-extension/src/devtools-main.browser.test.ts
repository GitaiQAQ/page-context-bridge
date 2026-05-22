import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('devtools-main', () => {
  const originalBrowser = (globalThis as typeof globalThis & { browser?: unknown }).browser;
  const originalChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    Reflect.deleteProperty(globalThis, 'browser');
    Reflect.deleteProperty(globalThis, 'chrome');
  });

  afterEach(() => {
    restoreGlobal('browser', originalBrowser);
    restoreGlobal('chrome', originalChrome);
  });

  it('registers a DevTools panel bound to inspectedWindow.tabId', async () => {
    const createPanel = vi.fn();
    const storageSet = vi.fn().mockResolvedValue(undefined);
    (globalThis as typeof globalThis & { browser?: unknown }).browser = {
      devtools: {
        inspectedWindow: { tabId: 42 },
        panels: { create: createPanel },
      },
      storage: {
        local: { set: storageSet },
      },
    };

    await import('./devtools-main');

    expect(storageSet).toHaveBeenCalledWith({ 'sidePanelUrl:devtools': 'http://127.0.0.1:22336/' });
    expect(createPanel).toHaveBeenCalledWith(
      'Page Context Bridge',
      'icons/icon128.png',
      'sidepanel.html?boundTabId=42&surface=devtools',
      expect.any(Function),
    );
  });

  it('registers an unbound panel when inspected tab id is unavailable', async () => {
    const createPanel = vi.fn();
    (globalThis as typeof globalThis & { browser?: unknown }).browser = {
      devtools: {
        inspectedWindow: {},
        panels: { create: createPanel },
      },
    };

    await import('./devtools-main');

    expect(createPanel).toHaveBeenCalledWith(
      'Page Context Bridge',
      'icons/icon128.png',
      'sidepanel.html?surface=devtools',
      expect.any(Function),
    );
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
