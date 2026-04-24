import { afterEach, describe, expect, it, vi } from "vitest";

import { captureActiveTabFeedbackContext } from "./bg-feedback-context";

describe("captureActiveTabFeedbackContext", () => {
  const originalChrome = globalThis.chrome;

  afterEach(() => {
    vi.restoreAllMocks();
    restoreChromeGlobal(originalChrome);
  });

  it("prefers sender tab to avoid crossing to active tab", async () => {
    const tabsQuery = vi.fn().mockResolvedValue([{ id: 999, url: "https://active.example", title: "active" }]);
    const tabsGet = vi.fn();
    const executeScript = vi.fn().mockResolvedValue([{ result: "  sender selected text  " }]);
    installChromeMock({ tabsQuery, tabsGet, executeScript });

    const context = await captureActiveTabFeedbackContext({
      tab: {
        id: 42,
        url: "https://sender.example/path",
        title: "sender tab",
      },
    } as chrome.runtime.MessageSender);

    expect(context).toEqual({
      tabId: 42,
      url: "https://sender.example/path",
      title: "sender tab",
      selectedText: "sender selected text",
    });
    expect(tabsQuery).not.toHaveBeenCalled();
    expect(tabsGet).not.toHaveBeenCalled();
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 42 },
        world: "MAIN",
      }),
    );
  });

  it("falls back to active tab when sender tab is missing (legacy sidepanel path)", async () => {
    const tabsQuery = vi.fn().mockResolvedValue([{ id: 7, url: "https://active.example", title: "active tab" }]);
    const tabsGet = vi.fn();
    const executeScript = vi.fn().mockResolvedValue([{ result: "" }]);
    installChromeMock({ tabsQuery, tabsGet, executeScript });

    const context = await captureActiveTabFeedbackContext();

    expect(context).toEqual({
      tabId: 7,
      url: "https://active.example",
      title: "active tab",
      selectedText: undefined,
    });
    expect(tabsQuery).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(tabsGet).not.toHaveBeenCalled();
  });

  it("loads full tab info via tabs.get when sender only provides tabId", async () => {
    const tabsQuery = vi.fn();
    const tabsGet = vi.fn().mockResolvedValue({ id: 8, url: "https://fetched.example", title: "fetched tab" });
    const executeScript = vi.fn().mockResolvedValue([{ result: "from fetched tab" }]);
    installChromeMock({ tabsQuery, tabsGet, executeScript });

    const context = await captureActiveTabFeedbackContext({
      tab: {
        id: 8,
      },
    } as chrome.runtime.MessageSender);

    expect(context).toEqual({
      tabId: 8,
      url: "https://fetched.example",
      title: "fetched tab",
      selectedText: "from fetched tab",
    });
    expect(tabsGet).toHaveBeenCalledWith(8);
    expect(tabsQuery).not.toHaveBeenCalled();
  });
});

function installChromeMock({
  tabsQuery,
  tabsGet,
  executeScript,
}: {
  tabsQuery?: ReturnType<typeof vi.fn>;
  tabsGet?: ReturnType<typeof vi.fn>;
  executeScript?: ReturnType<typeof vi.fn>;
}): void {
  const chromeMock = {
    tabs: {
      query: tabsQuery ?? vi.fn(),
      get: tabsGet ?? vi.fn(),
    },
    scripting: {
      executeScript: executeScript ?? vi.fn(),
    },
  } as unknown as typeof chrome;

  Object.defineProperty(globalThis, "chrome", {
    value: chromeMock,
    configurable: true,
    writable: true,
  });
}

function restoreChromeGlobal(originalChrome: typeof chrome | undefined): void {
  if (originalChrome) {
    Object.defineProperty(globalThis, "chrome", {
      value: originalChrome,
      configurable: true,
      writable: true,
    });
    return;
  }

    // Test runtime usually doesn't have native browser chrome object; clean up our injected mock here.
  Reflect.deleteProperty(globalThis, "chrome");
}
