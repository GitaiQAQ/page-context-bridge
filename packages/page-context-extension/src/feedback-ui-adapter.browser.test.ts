import { beforeEach, describe, expect, it, vi } from "vitest";

import { BRIDGE_METHODS } from "@page-context/shared-protocol";
import type { AgentationShellBridgeAdapter } from "@page-context/agentation-shell";
import { createFeedbackUiAdapter, installAgentationReactRoot, installFeedbackUiWithFallback } from "./feedback-ui-adapter";

const REACT_ROOT_ENTRY_KEYS = [
  "agentation-react-root",
  "__PAGE_CONTEXT_AGENTATION_REACT_ROOT__",
  "__page_context_agentation_react_root__",
] as const;

describe("createFeedbackUiAdapter", () => {
  it("maps create payload and keeps afterSeq cursor between snapshot and delta", async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === BRIDGE_METHODS.extensionFeedbackAnnotationCreate) {
        return { annotation: { id: "anno-1" } };
      }
      if (method === BRIDGE_METHODS.extensionFeedbackStateSnapshot) {
        return { sessions: [], annotations: [], snapshotVersion: 2, lastSeq: 7 };
      }
      if (method === BRIDGE_METHODS.extensionFeedbackStateDelta) {
        return { events: [], lastSeq: 11 };
      }
      return { ok: true };
    });

    const adapter = createFeedbackUiAdapter({
      // 测试里注入假的 runtime request，避免依赖 chrome API。
      sendRequest: sendRequest as <TResult>(method: string, params?: unknown) => Promise<TResult>,
    });

    const createResult = await adapter.createAnnotation({
      body: "marker body",
      priority: "high",
      selectedText: "selected text",
      target: {
        elementName: "button",
        elementPath: "#target",
        rect: new DOMRectReadOnly(10, 20, 80, 24),
      },
    });
    expect(createResult).toEqual({
      id: "anno-1",
      raw: { annotation: { id: "anno-1" } },
    });
    expect(sendRequest).toHaveBeenNthCalledWith(1, BRIDGE_METHODS.extensionFeedbackAnnotationCreate, {
      body: "marker body",
      priority: "high",
      selectedText: "selected text",
      uiAnchor: undefined,
    });

    await adapter.getFeedbackSnapshot?.();
    await adapter.getFeedbackStateDelta?.();
    await adapter.getFeedbackStateDelta?.();
    expect(sendRequest).toHaveBeenNthCalledWith(3, BRIDGE_METHODS.extensionFeedbackStateDelta, {
      afterSeq: 7,
    });
    expect(sendRequest).toHaveBeenNthCalledWith(4, BRIDGE_METHODS.extensionFeedbackStateDelta, {
      afterSeq: 11,
    });
  });

  it("keeps fallback seq when snapshot and delta return invalid lastSeq", async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [], annotations: [], snapshotVersion: 2, lastSeq: -1 })
      .mockResolvedValueOnce({ events: [], lastSeq: "bad-seq" })
      .mockResolvedValueOnce({ events: [], lastSeq: "still-bad" });
    const adapter = createFeedbackUiAdapter({
      sendRequest: sendRequest as <TResult>(method: string, params?: unknown) => Promise<TResult>,
    });

    await adapter.getFeedbackSnapshot?.();
    await adapter.getFeedbackStateDelta?.();
    await adapter.getFeedbackStateDelta?.();

    expect(sendRequest).toHaveBeenNthCalledWith(2, BRIDGE_METHODS.extensionFeedbackStateDelta, {
      afterSeq: 0,
    });
    expect(sendRequest).toHaveBeenNthCalledWith(3, BRIDGE_METHODS.extensionFeedbackStateDelta, {
      afterSeq: 0,
    });
  });
});

describe("installFeedbackUiWithFallback", () => {
  it("uses react root first and skips lower-priority fallbacks when mounted", () => {
    const installReactRoot = vi.fn().mockReturnValue(true);
    const installAgentationShell = vi.fn();
    const installLegacyOverlay = vi.fn();

    installFeedbackUiWithFallback({
      installReactRoot,
      installAgentationShell,
      installLegacyOverlay,
      log: vi.fn(),
    });

    expect(installReactRoot).toHaveBeenCalledTimes(1);
    expect(installAgentationShell).not.toHaveBeenCalled();
    expect(installLegacyOverlay).not.toHaveBeenCalled();
  });

  it("falls back to shell and then legacy overlay when previous step fails", () => {
    const installReactRoot = vi.fn().mockImplementation(() => {
      throw new Error("react root failed");
    });
    const installAgentationShell = vi.fn().mockReturnValue(false);
    const installLegacyOverlay = vi.fn();

    installFeedbackUiWithFallback({
      installReactRoot,
      installAgentationShell,
      installLegacyOverlay,
      log: vi.fn(),
    });

    expect(installReactRoot).toHaveBeenCalledTimes(1);
    expect(installAgentationShell).toHaveBeenCalledTimes(1);
    expect(installLegacyOverlay).toHaveBeenCalledTimes(1);
  });
});

describe("installAgentationReactRoot", () => {
  beforeEach(() => {
    for (const key of REACT_ROOT_ENTRY_KEYS) {
      delete (window as Window & Record<string, unknown>)[key];
    }
  });

  it("returns false when no react root entry is available", () => {
    const mounted = installAgentationReactRoot({
      adapter: createAdapterMock(),
      doc: document,
      win: window,
    });
    expect(mounted).toBe(false);
  });

  it("calls stable entry key and treats no-return legacy API as mounted", () => {
    const mountEntry = vi.fn().mockReturnValue(undefined);
    (window as Window & Record<string, unknown>)["agentation-react-root"] = mountEntry;

    const mounted = installAgentationReactRoot({
      adapter: createAdapterMock(),
      doc: document,
      win: window,
    });

    expect(mounted).toBe(true);
    expect(mountEntry).toHaveBeenCalledTimes(1);
  });

  it("supports compatibility object entry with install() return shape", () => {
    const installEntry = vi.fn().mockReturnValue({ installed: false });
    (window as Window & Record<string, unknown>).__PAGE_CONTEXT_AGENTATION_REACT_ROOT__ = {
      install: installEntry,
    };

    const mounted = installAgentationReactRoot({
      adapter: createAdapterMock(),
      doc: document,
      win: window,
    });

    expect(mounted).toBe(false);
    expect(installEntry).toHaveBeenCalledTimes(1);
  });
});

function createAdapterMock(): AgentationShellBridgeAdapter {
  return {
    createAnnotation: vi.fn().mockResolvedValue({ id: "mock-id" }),
  };
}
