/**
 * Sidepanel connection state controller.
 *
 * Goals:
 * - Share one connection snapshot across all components.
 * - Auto-refresh after background `connections.changed` broadcasts.
 * - Avoid separate RPC polling in each component.
 */

import {
  CONNECTION_METHODS,
  isRpcNotification,
  type ConnectionAction,
  type ConnectionDescriptor,
  type ConnectionsListResult,
  type ConnectionsSubscribeResult,
  type RpcNotification,
} from '@page-context/shared-protocol';
import type { ReactiveController, ReactiveControllerHost } from 'lit';

import { getExtensionApi } from './extension-api';
import { sendRuntimeRequest } from './runtime-rpc';

type ConnectionsListener = () => void;
type RuntimeMessageListener = (message: unknown) => boolean;

class ConnectionsStore {
  private descriptors: ConnectionDescriptor[] = [];
  private listeners = new Set<ConnectionsListener>();
  private subscribed = false;
  private subscribePromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private readonly runtimeListener: RuntimeMessageListener = (message: unknown): boolean => {
    if (
      isRpcNotification(message) &&
      (message as RpcNotification).method === CONNECTION_METHODS.changed
    ) {
      void this.refresh();
    }
    return false;
  };

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private attachRuntimeListener(): void {
    getExtensionApi().runtime.onMessage.addListener(this.runtimeListener);
  }

  private detachRuntimeListener(): void {
    const onMessage = getExtensionApi().runtime.onMessage as {
      removeListener?: (listener: RuntimeMessageListener) => void;
    };
    onMessage.removeListener?.(this.runtimeListener);
  }

  async ensureSubscribed(): Promise<void> {
    if (this.subscribed) {
      return;
    }

    if (this.subscribePromise) {
      return await this.subscribePromise;
    }

    this.subscribePromise = (async () => {
      const result = (await sendRuntimeRequest<ConnectionsSubscribeResult>(
        CONNECTION_METHODS.subscribe,
      ).catch(() => null)) ?? { descriptors: [] };
      this.descriptors = Array.isArray(result.descriptors) ? result.descriptors : [];
      this.subscribed = true;
      this.attachRuntimeListener();
      this.emit();
    })();

    try {
      await this.subscribePromise;
    } finally {
      this.subscribePromise = null;
    }
  }

  getSnapshot(): ConnectionDescriptor[] {
    return this.descriptors;
  }

  getById(descriptorId: string): ConnectionDescriptor | null {
    return this.descriptors.find((descriptor) => descriptor.id === descriptorId) ?? null;
  }

  subscribe(listener: ConnectionsListener): () => void {
    this.listeners.add(listener);
    void this.ensureSubscribed();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.subscribed) {
        this.detachRuntimeListener();
        this.subscribed = false;
      }
    };
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) {
      return await this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      const result = (await sendRuntimeRequest<ConnectionsListResult>(
        CONNECTION_METHODS.list,
      ).catch(() => null)) ?? { descriptors: [] };
      this.descriptors = Array.isArray(result.descriptors) ? result.descriptors : [];
      this.emit();
    })();

    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async performAction(descriptorId: string, action: ConnectionAction): Promise<void> {
    await sendRuntimeRequest(CONNECTION_METHODS.action, {
      descriptorId,
      action,
    });
    await this.refresh();
  }

  /**
   * Wait until one connection matches a predicate.
   *
   * Use short polling instead of tying one-off flows to UI subscription callbacks,
   * keeping imperative connect/restore flows simple.
   */
  async waitForDescriptor(
    descriptorId: string,
    predicate: (descriptor: ConnectionDescriptor | null) => boolean,
    timeoutMs = 5_000,
    intervalMs = 250,
  ): Promise<ConnectionDescriptor | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      await this.refresh();
      const descriptor = this.getById(descriptorId);
      if (predicate(descriptor)) {
        return descriptor;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return this.getById(descriptorId);
  }
}

const connectionsStore = new ConnectionsStore();

export function getConnectionsStore(): ConnectionsStore {
  return connectionsStore;
}

export class ConnectionsController implements ReactiveController {
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostConnected(): void {
    this.unsubscribe = connectionsStore.subscribe(() => {
      this.host.requestUpdate();
    });
  }

  hostDisconnected(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  get descriptors(): ConnectionDescriptor[] {
    return connectionsStore.getSnapshot();
  }

  getDescriptor(descriptorId: string): ConnectionDescriptor | null {
    return connectionsStore.getById(descriptorId);
  }
}
