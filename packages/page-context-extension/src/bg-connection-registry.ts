/**
 * 统一连接注册表。
 *
 * 目标：
 * 1. background 内所有“对外链路”都在这里挂账
 * 2. sidepanel 只读 descriptor，不再自己拼状态字符串
 * 3. 动作统一经由 driver 路由，避免 UI 直接耦合具体实现
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
      // 广播属于“尽力而为”能力。
      // 某些单测只装了局部 chrome mock，这里不该让业务流程因为广播失败而整体报错。
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
 * 仅供单测清理全局状态。
 * 业务代码不要调用，避免把运行中的 registry 清空。
 */
export function resetConnectionRegistryForTests(): void {
  singletonRegistry.clear();
}
