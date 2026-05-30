/**
 * Shared connection registry.
 *
 * Goals:
 * 1. Track every external background link here.
 * 2. Let the sidepanel read descriptors instead of composing status strings.
 * 3. Route actions through drivers so UI does not couple to concrete implementations.
 */

import {
  createNotification,
  type ConnectionAction,
  type ConnectionActionParams,
  type ConnectionDescriptor,
  type ConnectionKind,
  type ConnectionsListResult,
  type ConnectionsSubscribeResult,
} from '@page-context/shared-protocol';

import { runtimeSendMessage } from './extension-api';

const CONNECTIONS_CHANGED_METHOD = 'connections.changed';

interface ConnectionRegistryDriver {
  action?(
    action: ConnectionAction,
    descriptor: ConnectionDescriptor,
    registry: ConnectionRegistry,
  ): Promise<unknown>;
}

interface CreateConnectionRegistryDeps {
  broadcast?(method: string, params?: unknown): Promise<void>;
}

export interface ConnectionRegistry {
  register(descriptor: Omit<ConnectionDescriptor, 'updatedAt'>): ConnectionDescriptor;
  update(
    descriptorId: string,
    patch: Partial<Omit<ConnectionDescriptor, 'id' | 'kind' | 'updatedAt'>>,
  ): ConnectionDescriptor | null;
  remove(descriptorId: string): boolean;
  get(descriptorId: string): ConnectionDescriptor | null;
  list(): ConnectionDescriptor[];
  registerDriver(kind: ConnectionKind, driver: ConnectionRegistryDriver): void;
  sendRuntimeBroadcast(method: string, params?: unknown): Promise<void>;
  handleList(): Promise<ConnectionsListResult>;
  handleSubscribe(): Promise<ConnectionsSubscribeResult>;
  handleAction(params: ConnectionActionParams): Promise<unknown>;
  clear(): void;
}

function sortDescriptors(left: ConnectionDescriptor, right: ConnectionDescriptor): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.label.localeCompare(right.label) ||
    left.id.localeCompare(right.id)
  );
}

export function createConnectionRegistry(
  deps: CreateConnectionRegistryDeps = {},
): ConnectionRegistry {
  const descriptors = new Map<string, ConnectionDescriptor>();
  const drivers = new Map<ConnectionKind, ConnectionRegistryDriver>();

  const broadcast = async (method: string, params?: unknown): Promise<void> => {
    if (deps.broadcast) {
      await deps.broadcast(method, params);
      return;
    }

    try {
      await runtimeSendMessage(createNotification(method, params));
    } catch {
      // Broadcasts are best effort.
      // Some unit tests install partial chrome mocks, so broadcast failures should not fail the business flow.
    }
  };

  const broadcastChanged = async (): Promise<void> => {
    await broadcast(CONNECTIONS_CHANGED_METHOD, {
      changedAt: new Date().toISOString(),
    });
  };

  const setDescriptor = async (
    next: ConnectionDescriptor,
    mode: 'register' | 'update' | 'remove',
  ): Promise<void> => {
    if (mode === 'remove') {
      descriptors.delete(next.id);
    } else {
      descriptors.set(next.id, next);
    }
    await broadcastChanged();
  };

  return {
    register(descriptor) {
      const next: ConnectionDescriptor = {
        ...descriptor,
        updatedAt: new Date().toISOString(),
      };
      descriptors.set(next.id, next);
      void broadcastChanged();
      return next;
    },

    update(descriptorId, patch) {
      const current = descriptors.get(descriptorId);
      if (!current) {
        return null;
      }

      const next: ConnectionDescriptor = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      descriptors.set(descriptorId, next);
      void broadcastChanged();
      return next;
    },

    remove(descriptorId) {
      const current = descriptors.get(descriptorId);
      if (!current) {
        return false;
      }
      void setDescriptor(current, 'remove');
      return true;
    },

    get(descriptorId) {
      return descriptors.get(descriptorId) ?? null;
    },

    list() {
      return Array.from(descriptors.values()).sort(sortDescriptors);
    },

    registerDriver(kind, driver) {
      drivers.set(kind, driver);
    },

    async sendRuntimeBroadcast(method, params) {
      await broadcast(method, params);
    },

    async handleList() {
      return { descriptors: this.list() };
    },

    async handleSubscribe() {
      return {
        descriptors: this.list(),
        notificationMethod: CONNECTIONS_CHANGED_METHOD as typeof CONNECTIONS_CHANGED_METHOD,
      };
    },

    async handleAction(params) {
      const descriptor = descriptors.get(params.descriptorId);
      if (!descriptor) {
        throw new Error(`Unknown connection descriptor: ${params.descriptorId}`);
      }

      const driver = drivers.get(descriptor.kind);
      if (!driver?.action) {
        throw new Error(`Connection kind "${descriptor.kind}" does not support actions`);
      }

      return await driver.action(params.action, descriptor, this);
    },

    clear() {
      descriptors.clear();
      drivers.clear();
    },
  };
}

const singletonRegistry = createConnectionRegistry();

export function getConnectionRegistry(): ConnectionRegistry {
  return singletonRegistry;
}

/**
 * Only for unit tests that need to clear global state.
 * Production code should not call this, otherwise it may clear a live registry.
 */
export function resetConnectionRegistryForTests(): void {
  singletonRegistry.clear();
}
