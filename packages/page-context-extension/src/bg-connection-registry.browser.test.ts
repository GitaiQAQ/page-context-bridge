import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ConnectionDescriptor } from '@page-context/shared-protocol';

import { createConnectionRegistry } from './bg-connection-registry';

function makeDescriptor(
  overrides: Partial<Omit<ConnectionDescriptor, 'updatedAt'>> = {},
): Omit<ConnectionDescriptor, 'updatedAt'> {
  return {
    id: 'bridge-default',
    kind: 'bridge-default-ws',
    label: 'Bridge Default WS',
    endpoint: 'ws://127.0.0.1:22335/default',
    status: 'closed',
    capabilities: { reconnect: true, disconnect: true },
    meta: {},
    ...overrides,
  };
}

describe('bg-connection-registry', () => {
  const broadcastMock = vi.fn(async () => undefined);

  beforeEach(() => {
    broadcastMock.mockClear();
  });

  it('registers descriptors and broadcasts changes', async () => {
    const registry = createConnectionRegistry({ broadcast: broadcastMock });

    const descriptor = registry.register(makeDescriptor());

    expect(descriptor.updatedAt).toMatch(/T/);
    expect(registry.list()).toHaveLength(1);
    await Promise.resolve();
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith('connections.changed', expect.any(Object));
  });

  it('updates descriptors in place and broadcasts changes', async () => {
    const registry = createConnectionRegistry({ broadcast: broadcastMock });
    registry.register(makeDescriptor());

    const updated = registry.update('bridge-default', {
      status: 'connected',
      statusReason: 'ready',
    });

    expect(updated?.status).toBe('connected');
    expect(updated?.statusReason).toBe('ready');
    await Promise.resolve();
    expect(broadcastMock).toHaveBeenCalledTimes(2);
  });

  it('removes descriptors and broadcasts changes', async () => {
    const registry = createConnectionRegistry({ broadcast: broadcastMock });
    registry.register(makeDescriptor());

    const removed = registry.remove('bridge-default');

    expect(removed).toBe(true);
    expect(registry.list()).toEqual([]);
    await Promise.resolve();
    expect(broadcastMock).toHaveBeenCalledTimes(2);
  });
});
