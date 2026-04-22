import { beforeEach, describe, expect, it, vi } from "vitest";

import { installAgentationShell, type AgentationShellFeedbackSnapshot } from "@page-context/agentation-shell";

const AGENTATION_SHELL_HOST_ID = "__page_context_agentation_shell_host__";

describe("agentation shell feedback snapshot replay", () => {
  beforeEach(() => {
    document.body.innerHTML = `<button id="target">checkout</button>`;
    const target = queryRequired<HTMLElement>(document, "#target");
    mockRect(target, 80, 120, 140, 36);
  });

  it("replays snapshot annotations to markers and keeps edit/delete flow working", async () => {
    const createAnnotation = vi.fn();
    const updateAnnotation = vi.fn().mockResolvedValue({ ok: true });
    const dismissAnnotation = vi.fn().mockResolvedValue({ ok: true });
    const getFeedbackSnapshot = vi.fn().mockResolvedValue(buildSnapshot());

    const mounted = installAgentationShell({
      adapter: {
        createAnnotation,
        updateAnnotation,
        dismissAnnotation,
        getFeedbackSnapshot,
      },
      doc: document,
      win: window,
      logger: () => {},
    });
    expect(mounted).toBe(true);
    await flushMicrotasks();

    expect(getFeedbackSnapshot).toHaveBeenCalledTimes(1);
    const shadow = getAgentationShellShadowRoot();
    const marker = queryRequired<HTMLButtonElement>(shadow, '[data-marker-id="snapshot-1"]');
    expect(marker).toBeTruthy();
    expect(readMarkerTooltip(marker)).toContain("from snapshot");

    // 回放 marker 进入编辑态后，仍应走 update，不应误触发 create。
    marker.click();
    const popup = queryRequired<HTMLFormElement>(shadow, "[data-popup]");
    const popupBody = queryRequired<HTMLTextAreaElement>(shadow, "[data-popup-body]");
    popupBody.value = "edited after replay";
    popup.requestSubmit();
    await flushMicrotasks();

    expect(createAnnotation).not.toHaveBeenCalled();
    expect(updateAnnotation).toHaveBeenCalledWith({
      annotationId: "snapshot-1",
      body: "edited after replay",
      priority: "high",
    });

    queryRequired<HTMLButtonElement>(shadow, '[data-marker-id="snapshot-1"]').click();
    queryRequired<HTMLButtonElement>(shadow, "[data-popup-delete]").click();
    await flushMicrotasks();

    expect(dismissAnnotation).toHaveBeenCalledWith({
      annotationId: "snapshot-1",
      dismissReason: "marker deleted from agentation shell",
    });
    expect(shadow.querySelector('[data-marker-id="snapshot-1"]')).toBeNull();
  });
});

function buildSnapshot(): AgentationShellFeedbackSnapshot {
  return {
    sessions: [
      {
        id: "session-1",
        tenantId: "default",
        tabId: 1,
        url: "https://example.com",
        title: "example",
        status: "active",
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
        lastEventSeq: 7,
      },
    ],
    annotations: [
      {
        id: "snapshot-1",
        sessionId: "session-1",
        author: { source: "extension", id: "u-1", displayName: "Ext User" },
        body: "from snapshot",
        status: "open",
        priority: "high",
        target: {
          tabId: 1,
          url: "https://example.com",
          title: "example",
          textQuote: "checkout",
          uiAnchor: {
            cssSelector: "#target",
            rect: { x: 80, y: 120, width: 140, height: 36 },
            meta: {
              source: "agentation-shell",
              elementName: "button",
              elementPath: "#target",
            },
          },
        },
        context: {
          pageInfo: {
            tabId: 1,
            url: "https://example.com",
            title: "example",
          },
          selectedText: "checkout",
        },
        linkedCapabilities: {
          namespaceHints: [],
          relatedToolNames: [],
          relatedResourceIds: [],
          relatedSkillIds: [],
          linkReasons: [],
        },
        thread: [],
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
    ],
    snapshotVersion: 2,
    lastSeq: 7,
  };
}

function getAgentationShellShadowRoot(): ShadowRoot {
  const host = document.getElementById(AGENTATION_SHELL_HOST_ID);
  if (!(host instanceof HTMLDivElement) || !host.shadowRoot) {
    throw new Error("Agentation shell host missing");
  }
  return host.shadowRoot;
}

function queryRequired<T extends Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector(selector);
  if (!node) {
    throw new Error(`Missing node for selector: ${selector}`);
  }
  return node as T;
}

function mockRect(element: HTMLElement, left: number, top: number, width: number, height: number): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => new DOMRect(left, top, width, height),
    configurable: true,
    writable: true,
  });
}

function readMarkerTooltip(marker: HTMLButtonElement): string {
  const tooltip = marker.querySelector(".pc-agent-marker-tooltip");
  return tooltip?.textContent ?? "";
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
