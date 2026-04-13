import { describe, expect, it } from "vitest";

import {
  BRIDGE_METHODS,
  RpcPeer,
  RpcProtocolError,
  parseMessage,
  serializeMessage,
} from "./index.js";

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
});
