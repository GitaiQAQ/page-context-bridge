import { beforeEach, describe, expect, it, vi } from "vitest";

import { BRIDGE_METHODS } from "@page-context/shared-protocol";
import { createFeedbackUiAdapter } from "./feedback-ui-adapter";

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
      // Inject fake runtime request in tests to avoid dependency on chrome API.
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

  it("normalizes various create result shapes", async () => {
    const sendRequest = vi.fn();

    // Shape 1: { id: "x" }
    sendRequest.mockResolvedValueOnce({ id: "anno-a" });
    const adapter1 = createFeedbackUiAdapter({ sendRequest: sendRequest as never });
    const r1 = await adapter1.createAnnotation({ body: "test", priority: "normal", target: { elementName: "el", elementPath: "", rect: new DOMRectReadOnly() } });
    expect(r1.id).toBe("anno-a");

    // Shape 2: { annotation: { id: "x" } }
    sendRequest.mockResolvedValueOnce({ annotation: { id: "anno-b" } });
    const r2 = await adapter1.createAnnotation({ body: "test", priority: "normal", target: { elementName: "el", elementPath: "", rect: new DOMRectReadOnly() } });
    expect(r2.id).toBe("anno-b");

    // Shape 3: no id → returns { raw }
    sendRequest.mockResolvedValueOnce({ ok: true });
    const r3 = await adapter1.createAnnotation({ body: "test", priority: "normal", target: { elementName: "el", elementPath: "", rect: new DOMRectReadOnly() } });
    expect(r3.id).toBeUndefined();
    expect(r3.raw).toEqual({ ok: true });
  });
});
