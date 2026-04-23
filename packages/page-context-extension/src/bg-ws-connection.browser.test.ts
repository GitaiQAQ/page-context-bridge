import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeRpcPeer {
  private static nextSessionId = 0;
  static registeredMethods: string[] = [];

  register(method: string): void {
    FakeRpcPeer.registeredMethods.push(method);
  }

  async request<T>(method: string): Promise<T> {
    if (method === BRIDGE_METHODS.sessionRegister) {
      FakeRpcPeer.nextSessionId += 1;
      return {
        sessionId: `session-${FakeRpcPeer.nextSessionId}`,
      } as T;
    }
    return {} as T;
  }

  async notify(): Promise<void> {}

  async receive(): Promise<void> {}

  failAllPending(): void {}
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: 1000 }));
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitClose(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

const BRIDGE_METHODS = {
  bridgeToolCall: "bridge/toolCall",
  bridgeToolsList: "bridge/toolsList",
  bridgeTabsList: "bridge/tabsList",
  sessionRegister: "session/register",
  sessionHeartbeat: "session/heartbeat",
  extensionStatusGet: "extension.status.get",
  extensionReconnect: "extension.session.reconnect",
  extensionPageToolsGet: "extension.pageTools.get",
  extensionPageToolsTreeGet: "extension.pageTools.tree.get",
  extensionPageToolsDiscover: "extension.pageTools.discover",
  extensionPageToolsRefresh: "extension.pageTools.refresh",
  extensionPageToolsSetEnabled: "extension.pageTools.setEnabled",
  extensionMainWorldHostEnsure: "extension.mainWorld.host.ensure",
  extensionAgentationMainEnsure: "extension.agentation.main.ensure",
  extensionContextManifestGet: "extension.context.manifest.get",
  extensionContextResourceRead: "extension.context.resource.read",
  extensionContextSkillGet: "extension.context.skill.get",
} as const;

vi.mock("@page-context/shared-protocol", () => ({
  BRIDGE_METHODS,
  RpcPeer: FakeRpcPeer,
}));

function installChromeMock(): void {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (defaults: Record<string, string>) => defaults),
        set: vi.fn(async () => undefined),
      },
    },
    runtime: {
      id: "test-extension-id",
      getManifest: () => ({ version: "0.0.0-test" }),
    },
  };
}

describe("connectWebSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeWebSocket.instances = [];
    FakeRpcPeer.registeredMethods = [];
    (globalThis as { WebSocket: typeof WebSocket }).WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    installChromeMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it("fails fast when socket closes before open and allows next connect", async () => {
    const wsModule = await import("./bg-ws-connection");
    const noop = vi.fn(async () => ({}));

    // 第一次连接在握手阶段直接关闭：应立即失败，而不是悬挂。
    const firstConnect = wsModule.connectWebSocket(noop, noop, noop);
    await flushMicrotasks();
    const firstSocket = FakeWebSocket.instances[0];
    if (!firstSocket) {
      throw new Error("Missing first socket instance");
    }
    firstSocket.emitClose(1006);
    await expect(firstConnect).rejects.toThrow("before open");
    expect(wsModule.getWsState().connectPromise).toBeNull();

    // 第二次连接仍然可用，说明前一次失败不会卡住全局 connectPromise。
    const secondConnect = wsModule.connectWebSocket(noop, noop, noop);
    await flushMicrotasks();
    const secondSocket = FakeWebSocket.instances[1];
    if (!secondSocket) {
      throw new Error("Missing second socket instance");
    }
    secondSocket.emitOpen();
    await expect(secondConnect).resolves.toBeUndefined();
    expect(wsModule.getWsReady()).toBe(true);
  });

  it("registers ws-forward extension methods including ensure main-world routes", async () => {
    const wsModule = await import("./bg-ws-connection");
    const noop = vi.fn(async () => ({}));

    const connectPromise = wsModule.connectWebSocket(noop, noop, noop);
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("Missing socket instance");
    }
    socket.emitOpen();
    await connectPromise;

    // 确保 bridge 可直接通过 WS 调起 MAIN world 自愈入口。
    expect(FakeRpcPeer.registeredMethods).toContain(BRIDGE_METHODS.extensionMainWorldHostEnsure);
    expect(FakeRpcPeer.registeredMethods).toContain(BRIDGE_METHODS.extensionAgentationMainEnsure);
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
