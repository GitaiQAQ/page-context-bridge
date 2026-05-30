import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendRuntimeRequestMock = vi.fn();

vi.mock('./runtime-rpc', () => ({
  sendRuntimeRequest: sendRuntimeRequestMock,
}));

interface PopupChromeMockOptions {
  activeTab?: Partial<chrome.tabs.Tab>;
  currentWindow?: Partial<chrome.windows.Window>;
  sidePanelOpen?: ReturnType<typeof vi.fn>;
}

describe('popup-main launchConsoleUi', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sendRuntimeRequestMock.mockResolvedValue({
      connected: true,
      wsUrl: 'ws://127.0.0.1:22335/default',
      pendingToolCalls: 0,
    });

    // popup-main registers polling at module scope; intercept it to avoid real timer side effects in tests.
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(
      1 as unknown as ReturnType<typeof setInterval>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    restoreChromeGlobal(originalChrome);
  });

  it('calls sidePanel.open({ windowId }) on button click when sidePanel API exists', async () => {
    const sidePanelOpen = vi.fn().mockResolvedValue(undefined);
    const { tabsCreate, storageSet } = await mountPopup({
      activeTab: { id: 11, windowId: 22 },
      currentWindow: { id: 99 },
      sidePanelOpen,
    });

    clickOpenSidePanelButton();

    await vi.waitFor(() => {
      expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 99 });
    });
    expect(storageSet.mock.calls[0]?.[0]).toEqual({ sidePanelUrl: 'http://127.0.0.1:22336/' });
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('falls back to fallback URL when sidePanel API exists but currentWindow.id is missing', async () => {
    const sidePanelOpen = vi.fn().mockResolvedValue(undefined);
    const { tabsCreate } = await mountPopup({
      activeTab: { id: 61, windowId: 16 },
      currentWindow: {},
      sidePanelOpen,
    });

    clickOpenSidePanelButton();

    const fallbackUrl = await waitForFallbackUrl(tabsCreate);
    expect(fallbackUrl.pathname).toBe('/sidepanel.html');
    expect(fallbackUrl.searchParams.get('boundTabId')).toBe('61');
    expect(fallbackUrl.searchParams.get('windowId')).toBe('16');
    expect(sidePanelOpen).not.toHaveBeenCalled();
    expectNoInvalidQuery(fallbackUrl);
  });

  it('falls back to tabs.create with boundTabId/windowId when sidePanel API is missing', async () => {
    const { tabsCreate } = await mountPopup({
      activeTab: { id: 42, windowId: 7 },
    });

    clickOpenSidePanelButton();

    const fallbackUrl = await waitForFallbackUrl(tabsCreate);
    expect(fallbackUrl.pathname).toBe('/sidepanel.html');
    expect(fallbackUrl.searchParams.get('boundTabId')).toBe('42');
    expect(fallbackUrl.searchParams.get('windowId')).toBe('7');
    expectNoInvalidQuery(fallbackUrl);
  });

  it('does not generate invalid boundTabId when active tab id is missing and still opens fallback URL', async () => {
    const { tabsCreate } = await mountPopup({
      activeTab: { windowId: 12 },
    });

    clickOpenSidePanelButton();

    const fallbackUrl = await waitForFallbackUrl(tabsCreate);
    expect(fallbackUrl.pathname).toBe('/sidepanel.html');
    expect(fallbackUrl.searchParams.get('boundTabId')).toBeNull();
    expect(fallbackUrl.searchParams.get('windowId')).toBe('12');
    expectNoInvalidQuery(fallbackUrl);
  });

  it('does not generate invalid windowId when active tab windowId is missing and still opens fallback URL', async () => {
    const { tabsCreate } = await mountPopup({
      activeTab: { id: 73 },
    });

    clickOpenSidePanelButton();

    const fallbackUrl = await waitForFallbackUrl(tabsCreate);
    expect(fallbackUrl.pathname).toBe('/sidepanel.html');
    expect(fallbackUrl.searchParams.get('boundTabId')).toBe('73');
    expect(fallbackUrl.searchParams.get('windowId')).toBeNull();
    expectNoInvalidQuery(fallbackUrl);
  });
});

function renderPopupDom(): void {
  // Keep only the minimal DOM needed by popup-main initialization so tests do not depend on template details.
  document.body.innerHTML = `
    <span id="statusDot"></span>
    <div id="statusText"></div>
    <input id="wsUrlInput" />
    <div id="pendingCalls"></div>
    <button id="saveBtn"></button>
    <button id="reconnectBtn"></button>
    <div id="toast"></div>
    <button id="openExampleBtn"></button>
    <button id="openSidePanelBtn"></button>
  `;
}

async function mountPopup(options: PopupChromeMockOptions): Promise<{
  tabsCreate: ReturnType<typeof vi.fn>;
  storageSet: ReturnType<typeof vi.fn>;
}> {
  renderPopupDom();
  const chromeMocks = installChromeMock(options);
  await import('./popup-main');
  return chromeMocks;
}

function installChromeMock(options: PopupChromeMockOptions): {
  tabsCreate: ReturnType<typeof vi.fn>;
  storageSet: ReturnType<typeof vi.fn>;
} {
  const activeTab = options.activeTab ?? { id: 1, windowId: 2 };
  const currentWindow = options.currentWindow ?? { id: 2 };
  const tabsCreate = vi.fn().mockResolvedValue(undefined);
  const storageSet = vi.fn().mockResolvedValue(undefined);
  const chromeMock = {
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({ mcpWsUrl: 'ws://127.0.0.1:22335/default' }),
        set: storageSet,
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([activeTab]),
      create: tabsCreate,
    },
    windows: {
      getCurrent: vi.fn().mockResolvedValue(currentWindow),
    },
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://test-extension/${path}`),
    },
    ...(options.sidePanelOpen
      ? {
          sidePanel: {
            open: options.sidePanelOpen,
          },
        }
      : {}),
  } as unknown as typeof chrome;

  Object.defineProperty(globalThis, 'chrome', {
    value: chromeMock,
    configurable: true,
    writable: true,
  });

  return { tabsCreate, storageSet };
}

function clickOpenSidePanelButton(): void {
  const openSidePanelBtn = document.getElementById('openSidePanelBtn') as HTMLButtonElement | null;
  expect(openSidePanelBtn).not.toBeNull();
  openSidePanelBtn?.click();
}

async function waitForFallbackUrl(tabsCreate: ReturnType<typeof vi.fn>): Promise<URL> {
  await vi.waitFor(() => {
    expect(tabsCreate).toHaveBeenCalledTimes(1);
  });

  const createArg = tabsCreate.mock.calls[0]?.[0] as { url?: string } | undefined;
  expect(createArg?.url).toBeTypeOf('string');
  return new URL(createArg?.url as string);
}

function expectNoInvalidQuery(url: URL): void {
  const serialized = url.toString();
  expect(serialized).not.toContain('undefined');
  expect(serialized).not.toContain('null');
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
