import { describe, expect, it } from "vitest";

import { FeedbackStore } from "./feedback-store.js";

function createDeterministicStore() {
  let idCounter = 0;
  let timeCounter = 0;
  return new FeedbackStore("tenant-a", {
    now: () => `2026-04-18T00:00:${String(timeCounter++).padStart(2, "0")}.000Z`,
    createId: (prefix) => `${prefix}-${++idCounter}`,
    maxEvents: 16,
  });
}

describe("feedback-store", () => {
  it("creates session + annotation and returns snapshot with seq/version", () => {
    const store = createDeterministicStore();
    const annotation = store.createAnnotation({
      actor: { source: "extension", id: "ext-user", displayName: "Extension User" },
      body: "按钮位置不对",
      priority: "high",
      tabId: 7,
      url: "https://example.com/a",
      title: "Example A",
      selectedText: "立即购买",
      linkedCapabilities: {
        namespaceHints: ["catalog"],
        relatedToolNames: ["catalog.inspect"],
        relatedResourceIds: ["catalog.items"],
        relatedSkillIds: ["catalog-debug"],
        linkReasons: ["manifest.skills"],
      },
      manifestSummary: {
        namespaceCount: 1,
        resourceCount: 1,
        skillCount: 1,
      },
      pageInfoExtra: {
        app: "shop",
        scene: "detail",
        route: "/item/1",
      },
    });

    const snapshot = store.readSnapshot({ tabId: 7 });
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.annotations).toHaveLength(1);
    expect(snapshot.lastSeq).toBe(2);
    expect(snapshot.snapshotVersion).toBe(1);
    expect(annotation.context.pageInfo.route).toBe("/item/1");
    expect(annotation.target.textQuote).toBe("立即购买");
  });

  it("supports claim -> resolve and appends delta events in order", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: { source: "extension", id: "ext-user", displayName: "Extension User" },
      body: "文案错别字",
      tabId: 8,
      url: "https://example.com/b",
      linkedCapabilities: {
        namespaceHints: [],
        relatedToolNames: [],
        relatedResourceIds: [],
        relatedSkillIds: [],
        linkReasons: [],
      },
    });

    store.claimAnnotation({
      annotationId: created.id,
      actor: { source: "agent", id: "bot-1", displayName: "Agent A" },
    });
    store.resolveAnnotation({
      annotationId: created.id,
      actor: { source: "agent", id: "bot-1", displayName: "Agent A" },
      resolution: "已修复并发布",
    });

    const delta = store.readDelta({ afterSeq: 2 });
    expect(delta.events.map((item) => item.eventType)).toEqual([
      "annotation.claimed",
      "annotation.resolved",
    ]);
    expect(delta.lastSeq).toBe(4);
  });

  it("rejects invalid status transition", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: { source: "extension", id: "ext-user", displayName: "Extension User" },
      body: "先不处理",
      tabId: 9,
      url: "https://example.com/c",
      linkedCapabilities: {
        namespaceHints: [],
        relatedToolNames: [],
        relatedResourceIds: [],
        relatedSkillIds: [],
        linkReasons: [],
      },
    });

    expect(() =>
      store.resolveAnnotation({
        annotationId: created.id,
        actor: { source: "agent", id: "bot-2", displayName: "Agent B" },
      })
    ).toThrow("Invalid status transition");
  });
});
