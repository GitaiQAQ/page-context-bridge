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
      body: "Button position is incorrect",
      priority: "high",
      tabId: 7,
      url: "https://example.com/a",
      title: "Example A",
      selectedText: "Buy now",
      uiAnchor: {
        elementId: " buy-now-btn ",
        cssSelector: " #buy-now ",
        xpath: "//*[@id='buy-now']",
        textQuote: " Buy now ",
        framePath: [0, 1, -2],
        rect: { x: 12, y: 34, width: 56, height: 20 },
        textRange: { start: 0, end: 4 },
        meta: { from: "ui-shell" },
      },
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
    expect(annotation.target.textQuote).toBe("Buy now");
    expect(annotation.target.uiAnchor).toMatchObject({
      elementId: "buy-now-btn",
      cssSelector: "#buy-now",
      textQuote: "Buy now",
      framePath: [0, 1],
    });
    expect(snapshot.annotations[0]?.context.uiAnchor).toEqual(annotation.context.uiAnchor);
  });

  it("keeps lifecycle behavior unchanged when uiAnchor is absent (legacy payload)", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: { source: "extension", id: "ext-user", displayName: "Extension User" },
      body: "Old version without anchor",
      tabId: 18,
      url: "https://example.com/legacy",
      linkedCapabilities: {
        namespaceHints: [],
        relatedToolNames: [],
        relatedResourceIds: [],
        relatedSkillIds: [],
        linkReasons: [],
      },
    });

    expect(created.target.uiAnchor).toBeUndefined();
    expect(created.context.uiAnchor).toBeUndefined();

    store.claimAnnotation({
      annotationId: created.id,
      actor: { source: "agent", id: "bot-legacy", displayName: "Agent Legacy" },
    });
    const resolved = store.resolveAnnotation({
      annotationId: created.id,
      actor: { source: "agent", id: "bot-legacy", displayName: "Agent Legacy" },
      resolution: "Maintain compatibility",
    });

    expect(resolved.status).toBe("resolved");
  });

  it("supports claim -> resolve and appends delta events in order", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: { source: "extension", id: "ext-user", displayName: "Extension User" },
      body: "Text contains typos",
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
      resolution: "Fixed and deployed",
    });

    const delta = store.readDelta({ afterSeq: 2 });
    expect(delta.events.map((item) => item.eventType)).toEqual([
      "annotation.claimed",
      "annotation.resolved",
    ]);
    expect(delta.lastSeq).toBe(4);
  });

  it("supports update + dismiss for marker edit/delete sync", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: { source: "extension", id: "ext-user", displayName: "Extension User" },
      body: "Original text",
      priority: "normal",
      tabId: 12,
      url: "https://example.com/d",
      linkedCapabilities: {
        namespaceHints: [],
        relatedToolNames: [],
        relatedResourceIds: [],
        relatedSkillIds: [],
        linkReasons: [],
      },
    });

    const updated = store.updateAnnotation({
      annotationId: created.id,
      actor: { source: "extension", id: "ext-user", displayName: "Extension User" },
      body: "Updated text",
      priority: "high",
    });
    expect(updated.body).toBe("Updated text");
    expect(updated.priority).toBe("high");

    const dismissed = store.dismissAnnotation({
      annotationId: created.id,
      actor: { source: "extension", id: "ext-user", displayName: "Extension User" },
      dismissReason: "marker deleted from agentation shell",
    });
    expect(dismissed.status).toBe("dismissed");
    expect(dismissed.dismissReason).toContain("marker deleted");

    const delta = store.readDelta({ afterSeq: 2 });
    expect(delta.events.map((item) => item.eventType)).toEqual([
      "annotation.updated",
      "annotation.dismissed",
    ]);
  });

  it("rejects invalid status transition", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: { source: "extension", id: "ext-user", displayName: "Extension User" },
      body: "Leave for later",
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
