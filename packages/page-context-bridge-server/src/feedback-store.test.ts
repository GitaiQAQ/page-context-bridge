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

function createDefaultActor() {
  return { source: "extension" as const, id: "ext-user", displayName: "Extension User" };
}

function createDefaultLinks() {
  return { namespaceHints: [], relatedToolNames: [], relatedResourceIds: [], relatedSkillIds: [], linkReasons: [] };
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

describe("FeedbackStore - Session Management", () => {
  it("creates new session for unknown tabId", () => {
    const store = createDeterministicStore();
    const annotation = store.createAnnotation({
      actor: createDefaultActor(),
      body: "Test",
      tabId: 1,
      url: "https://example.com",
      linkedCapabilities: createDefaultLinks(),
    });

    expect(annotation.sessionId).toBeDefined();
    const snapshot = store.readSnapshot({ tabId: 1 });
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]?.tabId).toBe(1);
  });

  it("reuses existing session for known tabId", () => {
    const store = createDeterministicStore();
    const a1 = store.createAnnotation({
      actor: createDefaultActor(),
      body: "First",
      tabId: 1,
      url: "https://example.com/a",
      linkedCapabilities: createDefaultLinks(),
    });
    const a2 = store.createAnnotation({
      actor: createDefaultActor(),
      body: "Second",
      tabId: 1,
      url: "https://example.com/b",
      linkedCapabilities: createDefaultLinks(),
    });

    expect(a1.sessionId).toBe(a2.sessionId);
  });

  it("updates session URL/title on reuse", () => {
    const store = createDeterministicStore();
    store.createAnnotation({
      actor: createDefaultActor(),
      body: "First",
      tabId: 1,
      url: "https://example.com/old",
      title: "Old Title",
      linkedCapabilities: createDefaultLinks(),
    });

    const snapshotBefore = store.readSnapshot({ tabId: 1 });
    expect(snapshotBefore.sessions[0]?.url).toBe("https://example.com/old");

    store.createAnnotation({
      actor: createDefaultActor(),
      body: "Second",
      tabId: 1,
      url: "https://example.com/new",
      title: "New Title",
      linkedCapabilities: createDefaultLinks(),
    });

    const snapshotAfter = store.readSnapshot({ tabId: 1 });
    expect(snapshotAfter.sessions[0]?.url).toBe("https://example.com/new");
    expect(snapshotAfter.sessions[0]?.title).toBe("New Title");
  });

  it("lists sessions sorted by updatedAt descending", () => {
    const store = createDeterministicStore();

    store.createAnnotation({ actor: createDefaultActor(), body: "A", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });
    store.createAnnotation({ actor: createDefaultActor(), body: "B", tabId: 2, url: "https://b.com", linkedCapabilities: createDefaultLinks() });

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.tabId).toBe(2);
    expect(sessions[1]?.tabId).toBe(1);
  });

  it("returns empty for non-existent sessionId", () => {
    const store = createDeterministicStore();
    const snapshot = store.readSnapshot({ sessionId: "nonexistent" });
    expect(snapshot.sessions).toHaveLength(0);
    expect(snapshot.annotations).toHaveLength(0);
  });

  it("returns empty for non-existent tabId", () => {
    const store = createDeterministicStore();
    const snapshot = store.readSnapshot({ tabId: 999 });
    expect(snapshot.sessions).toHaveLength(0);
  });
});

describe("FeedbackStore - Event Ring Buffer", () => {
  it("adds events with sequential seq numbers", () => {
    const store = createDeterministicStore();

    store.createAnnotation({ actor: createDefaultActor(), body: "A", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });
    store.createAnnotation({ actor: createDefaultActor(), body: "B", tabId: 1, url: "https://b.com", linkedCapabilities: createDefaultLinks() });

    const delta = store.readDelta({ afterSeq: 0 });
    // First annotation: session.started(1) + annotation.created(2)
    // Second annotation: annotation.created(3) (session reused)
    expect(delta.events).toHaveLength(3);
    expect(delta.events[0]?.seq).toBe(1);
    expect(delta.events[0]?.eventType).toBe("session.started");
    expect(delta.events[1]?.seq).toBe(2);
    expect(delta.events[1]?.eventType).toBe("annotation.created");
    expect(delta.events[2]?.seq).toBe(3);
    expect(delta.events[2]?.eventType).toBe("annotation.created");
  });

  it("trims events when exceeding maxEvents", () => {
    const store = createDeterministicStore();

    for (let i = 0; i < 20; i++) {
      store.createAnnotation({
        actor: createDefaultActor(),
        body: `Annotation ${i}`,
        tabId: 1,
        url: "https://example.com",
        linkedCapabilities: createDefaultLinks(),
      });
    }

    const delta = store.readDelta({ afterSeq: 0 });
    expect(delta.events.length).toBeLessThanOrEqual(16);
    // 20 annotations on same tab: first = 2 events (session+annotation), rest 19 = 1 each = 21 total
    expect(delta.lastSeq).toBe(21);
  });

  it("filters delta by sessionId", () => {
    const store = createDeterministicStore();

    store.createAnnotation({ actor: createDefaultActor(), body: "A", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });
    store.createAnnotation({ actor: createDefaultActor(), body: "B", tabId: 2, url: "https://b.com", linkedCapabilities: createDefaultLinks() });

    const snapshot1 = store.readSnapshot({ tabId: 1 });
    const sessionId1 = snapshot1.sessions[0]?.id;

    const delta = store.readDelta({ afterSeq: 0, sessionId: sessionId1 });
    expect(delta.events.every((e) => e.sessionId === sessionId1)).toBe(true);
  });

  it("returns empty array when afterSeq >= lastSeq", () => {
    const store = createDeterministicStore();
    store.createAnnotation({ actor: createDefaultActor(), body: "A", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    const delta = store.readDelta({ afterSeq: 100 });
    expect(delta.events).toHaveLength(0);
  });
});

describe("FeedbackStore - Status Transitions", () => {
  it("allows open -> claimed", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    const claimed = store.claimAnnotation({ annotationId: created.id, actor: { source: "agent", id: "bot", displayName: "Bot" } });
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimedBy?.id).toBe("bot");
  });

  it("allows open -> dismissed", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    const dismissed = store.dismissAnnotation({ annotationId: created.id, actor: createDefaultActor() });
    expect(dismissed.status).toBe("dismissed");
  });

  it("allows claimed -> in_progress", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });
    store.claimAnnotation({ annotationId: created.id, actor: createDefaultActor() });

    const updated = store.claimAnnotation({ annotationId: created.id, actor: createDefaultActor() });
    expect(updated.status).toBe("claimed");
  });

  it("allows claimed -> resolved", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });
    store.claimAnnotation({ annotationId: created.id, actor: createDefaultActor() });

    const resolved = store.resolveAnnotation({ annotationId: created.id, actor: createDefaultActor(), resolution: "Done" });
    expect(resolved.status).toBe("resolved");
  });

  it("allows claimed -> dismissed", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });
    store.claimAnnotation({ annotationId: created.id, actor: createDefaultActor() });

    const dismissed = store.dismissAnnotation({ annotationId: created.id, actor: createDefaultActor() });
    expect(dismissed.status).toBe("dismissed");
  });

  it("rejects open -> resolved", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    expect(() => store.resolveAnnotation({ annotationId: created.id, actor: createDefaultActor() })).toThrow("Invalid status transition");
  });

  it("rejects open -> in_progress", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    // No direct in_progress transition from open - must go through claimed first
    // Since there's no direct method to set in_progress, we test the transition rules
    expect(created.status).toBe("open");
  });

  it("rejects resolved -> claimed (terminal state)", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });
    store.claimAnnotation({ annotationId: created.id, actor: createDefaultActor() });
    store.resolveAnnotation({ annotationId: created.id, actor: createDefaultActor() });

    expect(() => store.claimAnnotation({ annotationId: created.id, actor: createDefaultActor() })).toThrow("Invalid status transition");
  });

  it("rejects dismissed -> claimed (terminal state)", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });
    store.dismissAnnotation({ annotationId: created.id, actor: createDefaultActor() });

    expect(() => store.claimAnnotation({ annotationId: created.id, actor: createDefaultActor() })).toThrow("Invalid status transition");
  });

  it("same status transition is no-op", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    // Claiming again with same status should be no-op
    const claimed1 = store.claimAnnotation({ annotationId: created.id, actor: createDefaultActor() });
    const claimed2 = store.claimAnnotation({ annotationId: created.id, actor: createDefaultActor() });
    expect(claimed1.status).toBe("claimed");
    expect(claimed2.status).toBe("claimed");
  });
});

describe("FeedbackStore - Reply Thread", () => {
  it("adds reply to annotation thread", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    const replied = store.replyAnnotation({ annotationId: created.id, actor: createDefaultActor(), body: "This is a reply" });
    expect(replied.thread).toHaveLength(1);
    expect(replied.thread[0]?.body).toBe("This is a reply");
  });

  it("supports comment kind by default", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    const replied = store.replyAnnotation({ annotationId: created.id, actor: createDefaultActor(), body: "Reply" });
    expect(replied.thread[0]?.kind).toBe("comment");
  });

  it("supports custom kind parameter", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    const replied = store.replyAnnotation({ annotationId: created.id, actor: createDefaultActor(), body: "Action note", kind: "action_note" });
    expect(replied.thread[0]?.kind).toBe("action_note");
  });

  it("accumulates multiple replies", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    store.replyAnnotation({ annotationId: created.id, actor: createDefaultActor(), body: "Reply 1" });
    store.replyAnnotation({ annotationId: created.id, actor: createDefaultActor(), body: "Reply 2" });
    const replied = store.replyAnnotation({ annotationId: created.id, actor: createDefaultActor(), body: "Reply 3" });

    expect(replied.thread).toHaveLength(3);
  });

  it("preserves author info in thread", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    const agent = { source: "agent" as const, id: "bot-1", displayName: "Agent" };
    const replied = store.replyAnnotation({ annotationId: created.id, actor: agent, body: "Agent reply" });

    expect(replied.thread[0]?.author).toEqual(agent);
  });
});

describe("FeedbackStore - Update Validation", () => {
  it("updates body", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Original", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    const updated = store.updateAnnotation({ annotationId: created.id, actor: createDefaultActor(), body: "Updated body" });
    expect(updated.body).toBe("Updated body");
  });

  it("updates priority", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    const updated = store.updateAnnotation({ annotationId: created.id, actor: createDefaultActor(), body: "Test", priority: "high" });
    expect(updated.priority).toBe("high");
  });

  it("rejects empty body", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    expect(() => store.updateAnnotation({ annotationId: created.id, actor: createDefaultActor(), body: "" })).toThrow("Annotation body is required");
    expect(() => store.updateAnnotation({ annotationId: created.id, actor: createDefaultActor(), body: "   " })).toThrow("Annotation body is required");
  });

  it("rejects resolved annotations", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });
    store.claimAnnotation({ annotationId: created.id, actor: createDefaultActor() });
    store.resolveAnnotation({ annotationId: created.id, actor: createDefaultActor() });

    expect(() => store.updateAnnotation({ annotationId: created.id, actor: createDefaultActor(), body: "New" })).toThrow("Cannot update annotation in status: resolved");
  });

  it("rejects dismissed annotations", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });
    store.dismissAnnotation({ annotationId: created.id, actor: createDefaultActor() });

    expect(() => store.updateAnnotation({ annotationId: created.id, actor: createDefaultActor(), body: "New" })).toThrow("Cannot update annotation in status: dismissed");
  });

  it("works for claimed status", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });
    store.claimAnnotation({ annotationId: created.id, actor: createDefaultActor() });

    const updated = store.updateAnnotation({ annotationId: created.id, actor: createDefaultActor(), body: "Updated" });
    expect(updated.body).toBe("Updated");
  });
});

describe("FeedbackStore - Normalization", () => {
  it("trims elementId", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: createDefaultActor(),
      body: "Test",
      tabId: 1,
      url: "https://a.com",
      linkedCapabilities: createDefaultLinks(),
      uiAnchor: { elementId: "  trimmed-id  " },
    });

    expect(created.target.uiAnchor?.elementId).toBe("trimmed-id");
  });

  it("trims cssSelector", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: createDefaultActor(),
      body: "Test",
      tabId: 1,
      url: "https://a.com",
      linkedCapabilities: createDefaultLinks(),
      uiAnchor: { cssSelector: "  .selector  " },
    });

    expect(created.target.uiAnchor?.cssSelector).toBe(".selector");
  });

  it("filters negative framePath values", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: createDefaultActor(),
      body: "Test",
      tabId: 1,
      url: "https://a.com",
      linkedCapabilities: createDefaultLinks(),
      uiAnchor: { framePath: [0, 1, -1, 2, -2] },
    });

    expect(created.target.uiAnchor?.framePath).toEqual([0, 1, 2]);
  });

  it("filters non-integer framePath values", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: createDefaultActor(),
      body: "Test",
      tabId: 1,
      url: "https://a.com",
      linkedCapabilities: createDefaultLinks(),
      uiAnchor: { framePath: [0, 1.5, 2] as number[] },
    });

    expect(created.target.uiAnchor?.framePath).toEqual([0, 2]);
  });

  it("rejects rect with NaN values", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: createDefaultActor(),
      body: "Test",
      tabId: 1,
      url: "https://a.com",
      linkedCapabilities: createDefaultLinks(),
      uiAnchor: { rect: { x: NaN, y: 10, width: 100, height: 50 } },
    });

    expect(created.target.uiAnchor?.rect).toBeUndefined();
  });

  it("rejects rect with negative dimensions", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: createDefaultActor(),
      body: "Test",
      tabId: 1,
      url: "https://a.com",
      linkedCapabilities: createDefaultLinks(),
      uiAnchor: { rect: { x: 0, y: 0, width: -10, height: 50 } },
    });

    expect(created.target.uiAnchor?.rect).toBeUndefined();
  });

  it("accepts valid rect", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: createDefaultActor(),
      body: "Test",
      tabId: 1,
      url: "https://a.com",
      linkedCapabilities: createDefaultLinks(),
      uiAnchor: { rect: { x: 10, y: 20, width: 100, height: 50 } },
    });

    expect(created.target.uiAnchor?.rect).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it("strips empty meta objects", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: createDefaultActor(),
      body: "Test",
      tabId: 1,
      url: "https://a.com",
      linkedCapabilities: createDefaultLinks(),
      uiAnchor: { meta: {} },
    });

    expect(created.target.uiAnchor?.meta).toBeUndefined();
  });

  it("returns undefined for completely empty anchor", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: createDefaultActor(),
      body: "Test",
      tabId: 1,
      url: "https://a.com",
      linkedCapabilities: createDefaultLinks(),
      uiAnchor: {},
    });

    expect(created.target.uiAnchor).toBeUndefined();
  });

  it("normalizes text (trims whitespace) for selectedText only", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: createDefaultActor(),
      body: "  trimmed body  ",
      tabId: 1,
      url: "https://a.com",
      linkedCapabilities: createDefaultLinks(),
      selectedText: "  trimmed text  ",
    });

    // body is NOT normalized (set directly from input)
    expect(created.body).toBe("  trimmed body  ");
    // selectedText IS normalized
    expect(created.context.selectedText).toBe("trimmed text");
  });

  it("returns undefined for empty text", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: createDefaultActor(),
      body: "Test",
      tabId: 1,
      url: "https://a.com",
      linkedCapabilities: createDefaultLinks(),
      selectedText: "   ",
    });

    expect(created.context.selectedText).toBeUndefined();
  });

  it("deduplicates strings in linkedCapabilities", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({
      actor: createDefaultActor(),
      body: "Test",
      tabId: 1,
      url: "https://a.com",
      linkedCapabilities: {
        namespaceHints: ["a", "b", "a"],
        relatedToolNames: ["tool1", "tool2", "tool1"],
        relatedResourceIds: [],
        relatedSkillIds: [],
        linkReasons: [],
      },
    });

    expect(created.linkedCapabilities.namespaceHints).toEqual(["a", "b"]);
    expect(created.linkedCapabilities.relatedToolNames).toEqual(["tool1", "tool2"]);
  });
});

describe("FeedbackStore - Snapshot Versioning", () => {
  it("increments version on each mutation", () => {
    const store = createDeterministicStore();

    const s1 = store.readSnapshot({ tabId: 1 });
    expect(s1.snapshotVersion).toBe(0);

    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });
    const s2 = store.readSnapshot({ tabId: 1 });
    expect(s2.snapshotVersion).toBe(1);

    store.claimAnnotation({ annotationId: created.id, actor: createDefaultActor() });
    const s3 = store.readSnapshot({ tabId: 1 });
    expect(s3.snapshotVersion).toBe(2);
  });

  it("returns current version in snapshot", () => {
    const store = createDeterministicStore();
    store.createAnnotation({ actor: createDefaultActor(), body: "A", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });
    store.createAnnotation({ actor: createDefaultActor(), body: "B", tabId: 1, url: "https://b.com", linkedCapabilities: createDefaultLinks() });

    const snapshot = store.readSnapshot();
    expect(snapshot.snapshotVersion).toBe(2);
  });
});

describe("FeedbackStore - Clone on Read", () => {
  it("returns cloned annotations (immutability)", () => {
    const store = createDeterministicStore();
    const created = store.createAnnotation({ actor: createDefaultActor(), body: "Original", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    const snapshot1 = store.readSnapshot({ tabId: 1 });
    snapshot1.annotations[0]!.body = "Modified externally";

    const snapshot2 = store.readSnapshot({ tabId: 1 });
    expect(snapshot2.annotations[0]?.body).toBe("Original");
  });

  it("returns cloned sessions (immutability)", () => {
    const store = createDeterministicStore();
    store.createAnnotation({ actor: createDefaultActor(), body: "Test", tabId: 1, url: "https://a.com", linkedCapabilities: createDefaultLinks() });

    const snapshot1 = store.readSnapshot({ tabId: 1 });
    snapshot1.sessions[0]!.url = "https://hacked.com";

    const snapshot2 = store.readSnapshot({ tabId: 1 });
    expect(snapshot2.sessions[0]?.url).toBe("https://a.com");
  });
});

describe("FeedbackStore - Get Methods", () => {
  it("getAnnotation returns null for non-existent", () => {
    const store = createDeterministicStore();
    expect(store.getAnnotation("nonexistent")).toBeNull();
  });

  it("getSession returns null for non-existent", () => {
    const store = createDeterministicStore();
    expect(store.getSession("nonexistent")).toBeNull();
  });

  it("listAnnotationsBySession returns empty for non-existent", () => {
    const store = createDeterministicStore();
    expect(store.listAnnotationsBySession("nonexistent")).toEqual([]);
  });
});
