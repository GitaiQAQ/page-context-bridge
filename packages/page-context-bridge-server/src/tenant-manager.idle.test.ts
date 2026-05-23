import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { TenantManager } from './tenant-manager.js';

function createIdleOnlyRegistryMock() {
  return {
    getPageToolsByTab: () => new Map(),
    getServerCount: () => 0,
  };
}

describe('tenant-manager idle cleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  it('removes an idle tenant and notifies remove listeners once', async () => {
    vi.useFakeTimers();

    const manager = new TenantManager({
      createRegistry: () => createIdleOnlyRegistryMock() as never,
    });
    const onRemove = vi.fn();
    manager.onRemove(onRemove);

    manager.getOrCreate('idle-tenant');
    manager.startCleanup(10, 20);

    await vi.advanceTimersByTimeAsync(50);

    expect(manager.get('idle-tenant')).toBeUndefined();
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith('idle-tenant');
  });

  it('keeps a tenant alive while an extension connection is still attached', async () => {
    vi.useFakeTimers();

    const manager = new TenantManager({
      createRegistry: () => createIdleOnlyRegistryMock() as never,
    });

    const tenant = manager.getOrCreate('tenant-with-extension');
    tenant.extension = {
      ws: { readyState: WebSocket.OPEN } as unknown as WebSocket,
      peer: { failAllPending: vi.fn() } as never,
      ready: true,
      sessionId: 'extension-session',
      lastHeartbeatAt: Date.now(),
    };

    manager.startCleanup(10, 20);
    await vi.advanceTimersByTimeAsync(50);

    expect(manager.get('tenant-with-extension')).toBe(tenant);
  });
});
