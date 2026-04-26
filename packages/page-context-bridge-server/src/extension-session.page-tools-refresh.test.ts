import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { BRIDGE_METHODS, RPC_ERROR_CODES, RpcProtocolError } from '@page-context/shared-protocol';

import { refreshPageToolsFromExtension } from './extension-session.js';
import type { TenantManager } from './tenant-manager.js';

function createManagerWithRequestMock(requestMock: ReturnType<typeof vi.fn>): TenantManager {
  const slot = {
    ws: { readyState: WebSocket.OPEN } as unknown as WebSocket,
    peer: { request: requestMock },
    ready: true,
    sessionId: 'session-test',
    lastHeartbeatAt: Date.now(),
  };

  return {
    get: vi.fn(() => ({
      extension: slot,
    })),
  } as unknown as TenantManager;
}

describe('extension-session refresh page tools rpc', () => {
  it('uses extension.pageTools.refresh by default', async () => {
    const requestMock = vi.fn(async () => ({
      tools: [{ name: 'crm.inspect' }],
    }));
    const manager = createManagerWithRequestMock(requestMock);

    const tools = await refreshPageToolsFromExtension('tenant-a', manager, 12);

    expect(tools).toEqual([{ name: 'crm.inspect' }]);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0]?.[0]).toBe(BRIDGE_METHODS.extensionPageToolsRefresh);
    expect(requestMock.mock.calls[0]?.[1]).toEqual({ tabId: 12 });
  });

  it('falls back to extension.pageTools.discover when refresh is not supported', async () => {
    const requestMock = vi
      .fn()
      .mockRejectedValueOnce(
        new RpcProtocolError(RPC_ERROR_CODES.methodNotFound, 'Method not found'),
      )
      .mockResolvedValueOnce({
        tools: [{ name: 'crm.inspect' }],
      });
    const manager = createManagerWithRequestMock(requestMock);

    const tools = await refreshPageToolsFromExtension('tenant-a', manager, 21);

    expect(tools).toEqual([{ name: 'crm.inspect' }]);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[0]?.[0]).toBe(BRIDGE_METHODS.extensionPageToolsRefresh);
    expect(requestMock.mock.calls[1]?.[0]).toBe(BRIDGE_METHODS.extensionPageToolsDiscover);
    expect(requestMock.mock.calls[1]?.[1]).toEqual({ tabId: 21 });
  });

  it('rethrows non-methodNotFound rpc errors', async () => {
    const requestMock = vi.fn(async () => {
      throw new RpcProtocolError(-32000, 'bad gateway');
    });
    const manager = createManagerWithRequestMock(requestMock);

    await expect(() => refreshPageToolsFromExtension('tenant-a', manager, 99)).rejects.toThrow(
      /bad gateway/,
    );
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0]?.[0]).toBe(BRIDGE_METHODS.extensionPageToolsRefresh);
  });
});
