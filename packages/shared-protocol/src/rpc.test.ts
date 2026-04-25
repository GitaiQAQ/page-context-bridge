import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createErrorResponse,
  createNotification,
  createRequest,
  createSuccessResponse,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  normalizeError,
  parseMessage,
  RPC_ERROR_CODES,
  RpcPeer,
  RpcProtocolError,
  serializeMessage,
} from "./rpc.js";

describe("RpcPeer", () => {
  describe("constructor", () => {
    it("accepts send callback", () => {
      const send = vi.fn();
      const peer = new RpcPeer({ send });
      expect(peer).toBeDefined();
    });

    it("sets default timeout to 30000ms", () => {
      const peer = new RpcPeer({ send: vi.fn() });
      expect(peer.getPendingCount()).toBe(0);
    });

    it("accepts custom defaultTimeoutMs", () => {
      const peer = new RpcPeer({ send: vi.fn(), defaultTimeoutMs: 5000 });
      expect(peer).toBeDefined();
    });

    it("initializes empty pending requests map", () => {
      const peer = new RpcPeer({ send: vi.fn() });
      expect(peer.getPendingCount()).toBe(0);
    });
  });

  describe("register / unregister", () => {
    it("registers handler for method", () => {
      const peer = new RpcPeer({ send: vi.fn() });
      const handler = vi.fn();
      peer.register("test.method", handler);
      expect(peer.getPendingCount()).toBe(0);
    });

    it("replaces existing handler on re-register", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      const handler1 = vi.fn().mockResolvedValue("result1");
      const handler2 = vi.fn().mockResolvedValue("result2");

      peer.register("test.method", handler1);
      peer.register("test.method", handler2);

      await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "test.method" }));

      expect(handler2).toHaveBeenCalled();
      expect(handler1).not.toHaveBeenCalled();
    });

    it("unregister removes handler", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });
      const handler = vi.fn();

      peer.register("test.method", handler);
      peer.unregister("test.method");

      await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "test.method" }));

      expect(handler).not.toHaveBeenCalled();
      const response = JSON.parse(sent[0]!);
      expect(response.error.code).toBe(RPC_ERROR_CODES.methodNotFound);
    });

    it("unregister non-existent handler is no-op", () => {
      const peer = new RpcPeer({ send: vi.fn() });
      expect(() => peer.unregister("nonexistent")).not.toThrow();
    });
  });

  describe("request()", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("sends valid JSON-RPC request with unique ID", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      const requestPromise = peer.request("test.method", { foo: "bar" });
      // Prevent unhandled rejection in case of timeout
      requestPromise.catch(() => {});

      const request = JSON.parse(sent[0]!);
      expect(request.jsonrpc).toBe("2.0");
      expect(request.method).toBe("test.method");
      expect(request.params).toEqual({ foo: "bar" });
      expect(typeof request.id).toBe("string");
    });

    it("includes meta from getMeta callback", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({
        send: (msg) => { sent.push(msg); },
        getMeta: () => ({ sessionId: "session-123" }),
      });

      const requestPromise = peer.request("test.method");
      requestPromise.catch(() => {});

      const request = JSON.parse(sent[0]!);
      expect(request.meta.sessionId).toBe("session-123");
    });

    it("resolves with result on success response", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      const requestPromise = peer.request<number>("test.method");
      const request = JSON.parse(sent[0]!);

      await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: 42 }));

      const result = await requestPromise;
      expect(result).toBe(42);
    });

    it("rejects with error on failure response", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      const requestPromise = peer.request("test.method");
      const request = JSON.parse(sent[0]!);

      await peer.receive(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "Internal error" },
      }));

      await expect(requestPromise).rejects.toThrow("Internal error");
    });

    it("rejects with timeout error after timeoutMs", async () => {
      const peer = new RpcPeer({ send: vi.fn() });

      const requestPromise = peer.request("test.method", undefined, { timeoutMs: 1000 });
      // Catch to avoid unhandled rejection
      requestPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(1001);

      await expect(requestPromise).rejects.toThrow("timed out");
    });

    it("clears timer on successful response", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      const requestPromise = peer.request("test.method", undefined, { timeoutMs: 1000 });
      const request = JSON.parse(sent[0]!);

      await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "ok" }));
      await vi.advanceTimersByTimeAsync(2000);

      await expect(requestPromise).resolves.toBe("ok");
    });

    it("handles sendImpl rejection (network error)", async () => {
      const peer = new RpcPeer({
        send: () => Promise.reject(new Error("Network failed")),
      });

      await expect(peer.request("test.method")).rejects.toThrow("Network failed");
    });

    it("supports custom timeout per request", async () => {
      const peer = new RpcPeer({ send: vi.fn(), defaultTimeoutMs: 30000 });

      const requestPromise = peer.request("test.method", undefined, { timeoutMs: 500 });
      requestPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(501);

      await expect(requestPromise).rejects.toThrow("timed out after 500ms");
    });

    it("generates unique IDs for concurrent requests", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      const p1 = peer.request("method1");
      const p2 = peer.request("method2");
      // Prevent unhandled rejections
      p1.catch(() => {});
      p2.catch(() => {});

      const req1 = JSON.parse(sent[0]!);
      const req2 = JSON.parse(sent[1]!);

      expect(req1.id).not.toBe(req2.id);
      expect(peer.getPendingCount()).toBe(2);
    });

    it("tracks pending count correctly", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      const p1 = peer.request("method1");
      expect(peer.getPendingCount()).toBe(1);

      const req1 = JSON.parse(sent[0]!);
      await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: req1.id, result: "ok" }));

      await p1;
      expect(peer.getPendingCount()).toBe(0);
    });
  });

  describe("notify()", () => {
    it("sends notification without id field", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      await peer.notify("test.event", { data: "value" });

      const notification = JSON.parse(sent[0]!);
      expect(notification.jsonrpc).toBe("2.0");
      expect(notification.method).toBe("test.event");
      expect(notification.id).toBeUndefined();
    });

    it("does not track in pending map", async () => {
      const peer = new RpcPeer({ send: vi.fn() });

      await peer.notify("test.event");
      expect(peer.getPendingCount()).toBe(0);
    });
  });

  describe("receive() - Request Handling", () => {
    it("dispatches to registered handler", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });
      const handler = vi.fn().mockResolvedValue({ result: "success" });

      peer.register("test.method", handler);
      await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "test.method", params: { a: 1 } }));

      expect(handler).toHaveBeenCalledWith({ a: 1 }, expect.objectContaining({ id: "1", method: "test.method" }));
    });

    it("returns success response for resolved promise", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      peer.register("test.method", async () => "result-value");
      await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "test.method" }));

      const response = JSON.parse(sent[0]!);
      expect(response.result).toBe("result-value");
    });

    it("returns error response for thrown error", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      peer.register("test.method", async () => { throw new Error("Handler error"); });
      await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "test.method" }));

      const response = JSON.parse(sent[0]!);
      expect(response.error.code).toBe(RPC_ERROR_CODES.internalError);
      expect(response.error.message).toBe("Handler error");
    });

    it("normalizes Error instances to RpcProtocolError", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      const error = new RpcProtocolError(-32001, "Custom error", { detail: "extra" });
      peer.register("test.method", async () => { throw error; });
      await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "test.method" }));

      const response = JSON.parse(sent[0]!);
      expect(response.error.code).toBe(-32001);
      expect(response.error.data.detail).toBe("extra");
    });

    it("returns methodNotFound for unregistered methods", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "unregistered" }));

      const response = JSON.parse(sent[0]!);
      expect(response.error.code).toBe(RPC_ERROR_CODES.methodNotFound);
    });
  });

  describe("receive() - Notification Handling", () => {
    it("calls handler without expecting response", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });
      const handler = vi.fn();

      peer.register("test.event", handler);
      await peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "test.event", params: { x: 1 } }));

      expect(handler).toHaveBeenCalled();
      expect(sent.length).toBe(0);
    });

    it("silently ignores unregistered notification methods", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      await expect(peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "unknown.event" }))).resolves.toBeUndefined();
      expect(sent.length).toBe(0);
    });
  });

  describe("receive() - Response Handling", () => {
    it("resolves pending request with success result", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      const requestPromise = peer.request<string>("test.method");
      const request = JSON.parse(sent[0]!);

      await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "response-data" }));

      await expect(requestPromise).resolves.toBe("response-data");
    });

    it("rejects pending request with error", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      const requestPromise = peer.request("test.method");
      const request = JSON.parse(sent[0]!);

      await peer.receive(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: "Server error" },
      }));

      await expect(requestPromise).rejects.toThrow("Server error");
    });

    it("ignores response for unknown request ID", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      const requestPromise = peer.request("test.method");

      await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: "unknown-id", result: "orphan" }));
      expect(peer.getPendingCount()).toBe(1);
    });

    it("clears pending after resolution", async () => {
      const sent: string[] = [];
      const peer = new RpcPeer({ send: (msg) => { sent.push(msg); } });

      const requestPromise = peer.request("test.method");
      const request = JSON.parse(sent[0]!);

      await peer.receive(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "ok" }));
      await requestPromise;

      expect(peer.getPendingCount()).toBe(0);
    });
  });

  describe("failAllPending()", () => {
    it("rejects all pending requests with string reason", async () => {
      const peer = new RpcPeer({ send: vi.fn() });

      const p1 = peer.request("method1");
      const p2 = peer.request("method2");

      expect(peer.getPendingCount()).toBe(2);
      peer.failAllPending("Connection closed");

      await expect(p1).rejects.toThrow("Connection closed");
      await expect(p2).rejects.toThrow("Connection closed");
      expect(peer.getPendingCount()).toBe(0);
    });

    it("uses RpcProtocolError for string reasons", async () => {
      const peer = new RpcPeer({ send: vi.fn() });

      const p = peer.request("method");
      peer.failAllPending("Disconnected");

      try {
        await p;
      } catch (error) {
        expect(error).toBeInstanceOf(RpcProtocolError);
        expect((error as RpcProtocolError).code).toBe(RPC_ERROR_CODES.disconnected);
      }
    });

    it("preserves Error instance for Error reasons", async () => {
      const peer = new RpcPeer({ send: vi.fn() });

      const p = peer.request("method");
      const customError = new Error("Custom failure");
      peer.failAllPending(customError);

      try {
        await p;
      } catch (error) {
        expect(error).toBe(customError);
      }
    });

    it("handles empty pending map", () => {
      const peer = new RpcPeer({ send: vi.fn() });
      expect(() => peer.failAllPending("No pending")).not.toThrow();
    });
  });
});

describe("Message Helpers", () => {
  describe("createRequest()", () => {
    it("creates valid request envelope", () => {
      const request = createRequest("test.method", { a: 1 }, "id-123");

      expect(request.jsonrpc).toBe("2.0");
      expect(request.id).toBe("id-123");
      expect(request.method).toBe("test.method");
      expect(request.params).toEqual({ a: 1 });
    });

    it("auto-generates ID if not provided", () => {
      const request = createRequest("test.method");

      expect(typeof request.id).toBe("string");
      expect(request.id.length).toBeGreaterThan(0);
    });

    it("adds timestamp to meta", () => {
      const request = createRequest("test.method");
      expect(typeof request.meta?.timestamp).toBe("number");
    });

    it("merges provided meta", () => {
      const request = createRequest("test.method", undefined, "id", { sessionId: "s1" });

      expect(request.meta?.sessionId).toBe("s1");
      expect(typeof request.meta?.timestamp).toBe("number");
    });
  });

  describe("createNotification()", () => {
    it("creates notification without id", () => {
      const notification = createNotification("test.event", { x: 1 });

      expect(notification.jsonrpc).toBe("2.0");
      expect(notification.method).toBe("test.event");
      expect("id" in notification).toBe(false);
    });

    it("adds timestamp to meta", () => {
      const notification = createNotification("test.event");
      expect(typeof notification.meta?.timestamp).toBe("number");
    });
  });

  describe("parseMessage()", () => {
    it("parses valid JSON-RPC message", () => {
      const message = parseMessage('{"jsonrpc":"2.0","id":"1","method":"test"}');
      expect(message).toMatchObject({ jsonrpc: "2.0", id: "1", method: "test" });
    });

    it("throws parseError for invalid JSON", () => {
      expect(() => parseMessage("not json")).toThrow(RpcProtocolError);
      try {
        parseMessage("not json");
      } catch (error) {
        expect((error as RpcProtocolError).code).toBe(RPC_ERROR_CODES.parseError);
      }
    });

    it("throws invalidRequest for non-object", () => {
      expect(() => parseMessage('"string"')).toThrow(RpcProtocolError);
      try {
        parseMessage('"string"');
      } catch (error) {
        expect((error as RpcProtocolError).code).toBe(RPC_ERROR_CODES.invalidRequest);
      }
    });

    it("throws invalidRequest for wrong jsonrpc version", () => {
      expect(() => parseMessage('{"jsonrpc":"1.0","id":"1"}')).toThrow(RpcProtocolError);
    });
  });

  describe("serializeMessage()", () => {
    it("converts message to JSON string", () => {
      const request = createRequest("test.method", { a: 1 }, "id-1");
      const serialized = serializeMessage(request);

      expect(typeof serialized).toBe("string");
      const parsed = JSON.parse(serialized);
      expect(parsed.method).toBe("test.method");
    });
  });

  describe("Type Guards", () => {
    it("isRpcRequest identifies requests", () => {
      expect(isRpcRequest({ jsonrpc: "2.0", id: "1", method: "test" })).toBe(true);
      expect(isRpcRequest({ jsonrpc: "2.0", method: "test" })).toBe(false);
    });

    it("isRpcNotification identifies notifications", () => {
      expect(isRpcNotification({ jsonrpc: "2.0", method: "test" })).toBe(true);
      expect(isRpcNotification({ jsonrpc: "2.0", id: "1", method: "test" })).toBe(false);
    });

    it("isRpcResponse identifies responses (success)", () => {
      expect(isRpcResponse({ jsonrpc: "2.0", id: "1", result: "ok" })).toBe(true);
    });

    it("isRpcResponse identifies responses (error)", () => {
      expect(isRpcResponse({ jsonrpc: "2.0", id: "1", error: { code: -1, message: "err" } })).toBe(true);
    });

    it("rejects non-conforming objects", () => {
      expect(isRpcRequest({})).toBe(false);
      expect(isRpcNotification({})).toBe(false);
      expect(isRpcResponse({})).toBe(false);
    });
  });

  describe("normalizeError()", () => {
    it("passes through RpcProtocolError unchanged", () => {
      const error = new RpcProtocolError(-32001, "Custom");
      const normalized = normalizeError(error);
      expect(normalized).toBe(error);
    });

    it("wraps Error with internalError code", () => {
      const error = new Error("Test error");
      const normalized = normalizeError(error);

      expect(normalized.code).toBe(RPC_ERROR_CODES.internalError);
      expect(normalized.message).toBe("Test error");
      expect(normalized.data?.stack).toBeDefined();
    });

    it("converts primitive to string message", () => {
      const normalized = normalizeError("plain string");

      expect(normalized.code).toBe(RPC_ERROR_CODES.internalError);
      expect(normalized.message).toBe("plain string");
    });
  });
});

describe("createSuccessResponse / createErrorResponse", () => {
  it("createSuccessResponse creates valid success response", () => {
    const response = createSuccessResponse("id-1", { result: "data" });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe("id-1");
    expect(response.result).toEqual({ result: "data" });
    expect("error" in response).toBe(false);
  });

  it("createErrorResponse creates valid error response", () => {
    const error = new RpcProtocolError(-32001, "Test error", { detail: "extra" });
    const response = createErrorResponse("id-1", error);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe("id-1");
    expect(response.error.code).toBe(-32001);
    expect(response.error.message).toBe("Test error");
    expect(response.error.data?.detail).toBe("extra");
  });
});
