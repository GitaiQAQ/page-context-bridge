import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { BRIDGE_METHODS } from "@page-context/shared-protocol";

import { debugToolCallOnExtension, ensureAgentationMainFromBridge, ensureMainWorldHostFromBridge } from "./extension-session.js";
import type { TenantManager } from "./tenant-manager.js";

function createManagerWithRequestMock(requestMock: ReturnType<typeof vi.fn>): TenantManager {
  const slot = {
    ws: { readyState: WebSocket.OPEN } as unknown as WebSocket,
    peer: { request: requestMock },
    ready: true,
    sessionId: "session-test",
    lastHeartbeatAt: Date.now(),
  };

  return {
    get: vi.fn(() => ({
      extension: slot,
    })),
  } as unknown as TenantManager;
}

describe("extension-session main world ensure rpc", () => {
  it("calls extension.tool.debug.call with tool/args/tabId", async () => {
    const requestMock = vi.fn(async () => ({ ok: true, result: { rows: [] } }));
    const manager = createManagerWithRequestMock(requestMock);

    const result = await debugToolCallOnExtension("tenant-a", manager, "list_tabs", { limit: 3 }, 18);

    expect(result).toEqual({ ok: true, result: { rows: [] } });
    expect(requestMock).toHaveBeenCalledTimes(1);
    // Debug calls must preserve the original parameter format to avoid the middleware secretly modifying tool names or args.
    expect(requestMock.mock.calls[0]?.[0]).toBe(BRIDGE_METHODS.extensionToolDebugCall);
    expect(requestMock.mock.calls[0]?.[1]).toEqual({ toolName: "list_tabs", args: { limit: 3 }, tabId: 18 });
  });

  it("calls extension.mainWorld.host.ensure with tabId/frameId", async () => {
    const requestMock = vi.fn(async () => ({ ok: true }));
    const manager = createManagerWithRequestMock(requestMock);

    const result = await ensureMainWorldHostFromBridge("tenant-a", manager, 12, 3);

    expect(result).toEqual({ ok: true });
    expect(requestMock).toHaveBeenCalledTimes(1);
    // Ensure bridge only passes through parameters without modifying field names in the middleware.
    expect(requestMock.mock.calls[0]?.[0]).toBe(BRIDGE_METHODS.extensionMainWorldHostEnsure);
    expect(requestMock.mock.calls[0]?.[1]).toEqual({ tabId: 12, frameId: 3 });
  });

  it("calls extension.agentation.main.ensure with tabId only when frameId is omitted", async () => {
    const requestMock = vi.fn(async () => ({ ok: true }));
    const manager = createManagerWithRequestMock(requestMock);

    const result = await ensureAgentationMainFromBridge("tenant-a", manager, 21);

    expect(result).toEqual({ ok: true });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0]?.[0]).toBe(BRIDGE_METHODS.extensionAgentationMainEnsure);
    expect(requestMock.mock.calls[0]?.[1]).toEqual({ tabId: 21 });
  });
});
