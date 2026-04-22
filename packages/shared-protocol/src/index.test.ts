import { describe, expect, it } from "vitest";

import {
  BRIDGE_METHODS,
  FEEDBACK_METHODS,
  type FeedbackAnnotationCreateParams,
  RpcPeer,
  RpcProtocolError,
  parseMessage,
  serializeMessage,
} from "./index";

describe("RpcPeer", () => {
  it("completes request/response roundtrip", async () => {
    const wire: string[] = [];
    const client = new RpcPeer({ send: (message) => wire.push(message) });
    const server = new RpcPeer({ send: (message) => wire.push(message) });

    server.register(BRIDGE_METHODS.bridgeTabsList, async () => [{ id: 1, title: "Tab" }]);

    const pending = client.request(BRIDGE_METHODS.bridgeTabsList);
    await server.receive(wire.shift()!);
    await client.receive(wire.shift()!);

    await expect(pending).resolves.toEqual([{ id: 1, title: "Tab" }]);
  });

  it("dispatches notifications without waiting for response", async () => {
    const sent: string[] = [];
    const peer = new RpcPeer({ send: (message) => sent.push(message) });

    await peer.notify(BRIDGE_METHODS.bridgePageEvent, { type: "demo" });

    const message = parseMessage(sent[0]);
    expect("id" in message).toBe(false);
  });

  it("fails pending requests on disconnect", async () => {
    const peer = new RpcPeer({ send: () => undefined, defaultTimeoutMs: 1000 });
    const pending = peer.request("demo.method");

    peer.failAllPending("transport closed");

    await expect(pending).rejects.toBeInstanceOf(RpcProtocolError);
  });

  it("serializes valid json-rpc envelopes", () => {
    const raw = serializeMessage({ jsonrpc: "2.0", method: BRIDGE_METHODS.sessionHeartbeat, params: { ok: true } });
    expect(parseMessage(raw)).toMatchObject({ method: BRIDGE_METHODS.sessionHeartbeat });
  });

  it("exports feedback method constants through the shared barrel", () => {
    expect(BRIDGE_METHODS.feedbackStateSnapshot).toBe("feedback.state.snapshot");
    expect(BRIDGE_METHODS.extensionFeedbackAnnotationCreate).toBe("extension.feedback.annotation.create");
    expect(BRIDGE_METHODS.extensionFeedbackAnnotationUpdate).toBe("extension.feedback.annotation.update");
    expect(FEEDBACK_METHODS.feedbackAnnotationResolve).toBe("feedback.annotation.resolve");
    expect(FEEDBACK_METHODS.feedbackAnnotationUpdate).toBe("feedback.annotation.update");
  });

  it("keeps feedback create payload backward compatible while supporting uiAnchor", () => {
    // 老 payload 不带 uiAnchor 仍应可通过类型约束，避免升级阻塞。
    const legacyPayload: FeedbackAnnotationCreateParams = {
      body: "legacy body",
      tabId: 1,
      url: "https://example.com/legacy",
    };

    const enhancedPayload: FeedbackAnnotationCreateParams = {
      body: "new body",
      tabId: 2,
      url: "https://example.com/new",
      uiAnchor: {
        cssSelector: "#submit",
        framePath: [0],
        rect: { x: 10, y: 20, width: 30, height: 40 },
        textRange: { start: 0, end: 6 },
      },
    };

    expect(legacyPayload.uiAnchor).toBeUndefined();
    expect(enhancedPayload.uiAnchor?.cssSelector).toBe("#submit");
  });
});
