import { beforeEach, describe, expect, it, vi } from "vitest";

import { BRIDGE_METHODS } from "@page-context/shared-protocol";
import type { AgentationShellBridgeAdapter } from "@page-context/agentation-shell";
import { createFeedbackUiAdapter, installAgentationReactRoot, installFeedbackUiWithFallback } from "./feedback-ui-adapter";
import {
  FEEDBACK_UI_MODE_ATTR,
  FEEDBACK_UI_REASON_ATTR,
  FEEDBACK_UI_SELF_CHECK_RESULT_ATTR,
  FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR,
  FEEDBACK_UI_SELF_CHECK_STATUS_ATTR,
} from "./feedback-ui-diagnostics";

const REACT_ROOT_ENTRY_KEYS = [
  "agentation-react-root",
  "__PAGE_CONTEXT_AGENTATION_REACT_ROOT__",
  "__page_context_agentation_react_root__",
] as const;
const AGENTATION_REACT_HOST_ID = "__page_context_agentation_react_host__";
const FEEDBACK_OVERLAY_HOST_ID = "__page_context_feedback_overlay_host__";

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
  beforeEach(() => {
    document.body.innerHTML = "";
    cleanupUiHosts();
    clearFeedbackUiDiagnostics();
  });

  it("uses react root first, writes diagnostics, and skips lower-priority fallbacks when mounted", () => {
    const installReactRoot = vi.fn().mockImplementation(() => {
      appendHost(AGENTATION_REACT_HOST_ID);
      return true;
    });
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
    expect(document.documentElement.getAttribute(FEEDBACK_UI_MODE_ATTR)).toBe("react-root");
    expect(document.documentElement.hasAttribute(FEEDBACK_UI_REASON_ATTR)).toBe(false);
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR)).toBe("ok");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR)).toBe("present");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR)).toBe(
      `#${AGENTATION_REACT_HOST_ID}`,
    );
  });

  it("marks self-check mismatch when react root says mounted but host is missing", () => {
    installFeedbackUiWithFallback({
      installReactRoot: () => true,
      installAgentationShell: vi.fn(),
      installLegacyOverlay: vi.fn(),
      log: vi.fn(),
    });

    expect(document.documentElement.getAttribute(FEEDBACK_UI_MODE_ATTR)).toBe("react-root");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR)).toBe("mismatch");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR)).toBe("absent");
  });

  it("falls back to legacy overlay and records legacy diagnostics after shell skip", () => {
    const installReactRoot = vi.fn().mockImplementation(() => {
      throw new Error("react root failed");
    });
    const installAgentationShell = vi.fn().mockReturnValue(false);
    const installLegacyOverlay = vi.fn().mockImplementation(() => {
      appendHost(FEEDBACK_OVERLAY_HOST_ID);
    });

    installFeedbackUiWithFallback({
      installReactRoot,
      installAgentationShell,
      installLegacyOverlay,
      log: vi.fn(),
    });

    expect(installReactRoot).toHaveBeenCalledTimes(1);
    expect(installAgentationShell).toHaveBeenCalledTimes(1);
    expect(installLegacyOverlay).toHaveBeenCalledTimes(1);
    expect(document.documentElement.getAttribute(FEEDBACK_UI_MODE_ATTR)).toBe("legacy-overlay");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_REASON_ATTR)).toBe("agentation-shell-skipped");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR)).toBe("ok");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR)).toBe("present");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR)).toBe(
      `#${FEEDBACK_OVERLAY_HOST_ID}`,
    );
  });

  it("marks legacy install failure before rethrowing install error", () => {
    expect(() =>
      installFeedbackUiWithFallback({
        installReactRoot: () => false,
        installAgentationShell: () => false,
        installLegacyOverlay: () => {
          throw new Error("overlay install failed");
        },
        log: vi.fn(),
      }),
    ).toThrow("overlay install failed");

    expect(document.documentElement.getAttribute(FEEDBACK_UI_MODE_ATTR)).toBe("legacy-overlay");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_REASON_ATTR)).toBe("legacy-overlay-install-failed");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR)).toBe("mismatch");
    expect(document.documentElement.getAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR)).toBe("absent");
  });

  it("clears stale fallback reason when next run switches to react-root", () => {
    installFeedbackUiWithFallback({
      installReactRoot: () => false,
      installAgentationShell: () => true,
      installLegacyOverlay: vi.fn(),
      log: vi.fn(),
    });
    expect(document.documentElement.getAttribute(FEEDBACK_UI_REASON_ATTR)).toBe("react-root-skipped");

    installFeedbackUiWithFallback({
      installReactRoot: () => {
        appendHost(AGENTATION_REACT_HOST_ID);
        return true;
      },
      installAgentationShell: vi.fn(),
      installLegacyOverlay: vi.fn(),
      log: vi.fn(),
    });
    expect(document.documentElement.getAttribute(FEEDBACK_UI_MODE_ATTR)).toBe("react-root");
    expect(document.documentElement.hasAttribute(FEEDBACK_UI_REASON_ATTR)).toBe(false);
  });
});

describe("installAgentationReactRoot", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    cleanupUiHosts();
    clearFeedbackUiDiagnostics();
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

function appendHost(hostId: string): void {
  const existing = document.getElementById(hostId);
  if (existing) {
    return;
  }
  const host = document.createElement("div");
  host.id = hostId;
  document.body.appendChild(host);
}

function cleanupUiHosts(): void {
  document.getElementById(AGENTATION_REACT_HOST_ID)?.remove();
  document.getElementById("__page_context_agentation_shell_host__")?.remove();
  document.getElementById(FEEDBACK_OVERLAY_HOST_ID)?.remove();
}

function clearFeedbackUiDiagnostics(): void {
  document.documentElement.removeAttribute(FEEDBACK_UI_MODE_ATTR);
  document.documentElement.removeAttribute(FEEDBACK_UI_REASON_ATTR);
  document.documentElement.removeAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR);
  document.documentElement.removeAttribute(FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR);
  document.documentElement.removeAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR);
}
