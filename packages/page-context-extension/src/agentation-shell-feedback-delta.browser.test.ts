import { beforeEach, describe, expect, it, vi } from "vitest";

import { installAgentationShell, type AgentationShellFeedbackDelta, type AgentationShellFeedbackSnapshot } from "@page-context/agentation-shell";

const AGENTATION_SHELL_HOST_ID = "__page_context_agentation_shell_host__";

describe("agentation shell feedback delta fallback", () => {
  beforeEach(() => {
    document.body.innerHTML = `<button id="target">checkout</button>`;
    const target = queryRequired<HTMLElement>(document, "#target");
    mockRect(target, 80, 120, 140, 36);
  });

  it("deletes marker directly when delta event is annotation.dismissed", async () => {
    const getFeedbackSnapshot = vi.fn().mockResolvedValue(buildSnapshot({ body: "from snapshot" }));
    const getFeedbackStateDelta = vi.fn().mockResolvedValue(
      buildDeltaResult([
        buildDeltaEvent({
          eventType: "annotation.dismissed",
          annotationId: "snapshot-1",
          seq: 8,
        }),
      ], 8),
    );

    const mounted = installAgentationShell({
      adapter: {
        createAnnotation: vi.fn(),
        getFeedbackSnapshot,
        getFeedbackStateDelta,
      },
      doc: document,
      win: window,
      logger: () => {},
    });
    expect(mounted).toBe(true);
    await waitForExpect(() => {
      expect(getFeedbackStateDelta).toHaveBeenCalledTimes(1);
    });
    const shadow = getAgentationShellShadowRoot();
    expect(shadow.querySelector('[data-marker-id="snapshot-1"]')).toBeNull();
    // dismissed 直删不需要额外全量回放。
    expect(getFeedbackSnapshot).toHaveBeenCalledTimes(1);
  });

  it("reloads snapshot once for non-dismissed annotation delta events", async () => {
    const getFeedbackSnapshot = vi
      .fn()
      .mockResolvedValueOnce(buildSnapshot({ body: "before delta reload" }))
      .mockResolvedValueOnce(buildSnapshot({ body: "after delta reload" }));
    const getFeedbackStateDelta = vi.fn().mockResolvedValue(
      buildDeltaResult([
        buildDeltaEvent({
          eventType: "annotation.updated",
          annotationId: "snapshot-1",
          seq: 8,
        }),
      ], 8),
    );

    installAgentationShell({
      adapter: {
        createAnnotation: vi.fn(),
        getFeedbackSnapshot,
        getFeedbackStateDelta,
      },
      doc: document,
      win: window,
      logger: () => {},
    });
    await waitForExpect(() => {
      expect(getFeedbackStateDelta).toHaveBeenCalledTimes(1);
    });
    expect(getFeedbackSnapshot).toHaveBeenCalledTimes(2);
    const shadow = getAgentationShellShadowRoot();
    const marker = queryRequired<HTMLButtonElement>(shadow, '[data-marker-id="snapshot-1"]');
    expect(readMarkerTooltip(marker)).toContain("after delta reload");
  });

  it("falls back to snapshot reload when dismissed delta payload misses annotationId", async () => {
    const getFeedbackSnapshot = vi
      .fn()
      .mockResolvedValueOnce(buildSnapshot({ body: "before incomplete dismissed event" }))
      .mockResolvedValueOnce(buildSnapshot({ includeAnnotation: false }));
    const getFeedbackStateDelta = vi.fn().mockResolvedValue(
      buildDeltaResult([
        buildDeltaEvent({
          eventType: "annotation.dismissed",
          seq: 8,
        }),
      ], 8),
    );

    installAgentationShell({
      adapter: {
        createAnnotation: vi.fn(),
        getFeedbackSnapshot,
        getFeedbackStateDelta,
      },
      doc: document,
      win: window,
      logger: () => {},
    });
    await waitForExpect(() => {
      expect(getFeedbackStateDelta).toHaveBeenCalledTimes(1);
    });
    const shadow = getAgentationShellShadowRoot();
    expect(shadow.querySelector('[data-marker-id="snapshot-1"]')).toBeNull();
    expect(getFeedbackSnapshot).toHaveBeenCalledTimes(2);
  });
});

function buildSnapshot(options?: { body?: string; includeAnnotation?: boolean }): AgentationShellFeedbackSnapshot {
  const includeAnnotation = options?.includeAnnotation ?? true;
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
    annotations: includeAnnotation
      ? [
          {
            id: "snapshot-1",
            sessionId: "session-1",
            author: { source: "extension", id: "u-1", displayName: "Ext User" },
            body: options?.body ?? "snapshot body",
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
        ]
      : [],
    snapshotVersion: 2,
    lastSeq: 7,
  };
}

function buildDeltaResult(events: AgentationShellFeedbackDelta["events"], lastSeq: number): AgentationShellFeedbackDelta {
  return {
    events,
    lastSeq,
  };
}

function buildDeltaEvent(options: {
  eventType: AgentationShellFeedbackDelta["events"][number]["eventType"];
  annotationId?: string;
  seq: number;
}): AgentationShellFeedbackDelta["events"][number] {
  return {
    eventId: `event-${options.seq}`,
    tenantId: "default",
    sessionId: "session-1",
    annotationId: options.annotationId,
    seq: options.seq,
    eventType: options.eventType,
    occurredAt: "2026-04-22T00:00:00.000Z",
    source: "bridge",
    payload: {},
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

async function waitForExpect(assertion: () => void, retries = 40): Promise<void> {
  let lastError: unknown = undefined;
  for (let index = 0; index < retries; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw lastError;
}
