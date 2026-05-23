/**
 * Multi-tenant session manager.
 * Each session gets a random ID, owns its own McpRegistry, and is fully isolated.
 */

import type { McpRegistry } from './mcp-registry.js';
import { log } from './mcp-registry.js';

export interface Tenant {
  id: string;
  registry: McpRegistry;
  extension: ExtensionSlot | null;
  createdAt: number;
  lastActivityAt: number;
}

export interface ExtensionSlot {
  ws: import('ws').WebSocket;
  peer: import('@page-context/shared-protocol').RpcPeer;
  ready: boolean;
  sessionId: string | null;
  lastHeartbeatAt: number;
}

export interface TenantManagerFactory {
  createRegistry(tenantId: string): McpRegistry;
}

export type TenantRemoveListener = (tenantId: string) => void;

export class TenantManager {
  private readonly tenants = new Map<string, Tenant>();
  private readonly removeListeners: TenantRemoveListener[] = [];
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly factory: TenantManagerFactory) {}

  getOrCreate(tenantId: string): Tenant {
    let tenant = this.tenants.get(tenantId);
    if (!tenant) {
      tenant = {
        id: tenantId,
        registry: this.factory.createRegistry(tenantId),
        extension: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      this.tenants.set(tenantId, tenant);
      log(`Tenant created: ${tenantId}`);
    }
    tenant.lastActivityAt = Date.now();
    return tenant;
  }

  get(tenantId: string): Tenant | undefined {
    return this.tenants.get(tenantId);
  }

  /**
   * 注册 tenant 删除监听。
   * 这里只暴露 tenantId，让资源释放逻辑留在调用方，各自处理各自持有的 transport。
   */
  onRemove(listener: TenantRemoveListener): () => void {
    this.removeListeners.push(listener);
    return () => {
      const index = this.removeListeners.indexOf(listener);
      if (index >= 0) {
        this.removeListeners.splice(index, 1);
      }
    };
  }

  remove(tenantId: string): void {
    const tenant = this.tenants.get(tenantId);
    if (tenant) {
      this.tenants.delete(tenantId);
      for (const listener of [...this.removeListeners]) {
        listener(tenantId);
      }
      log(`Tenant removed: ${tenantId} (idle)`);
    }
  }

  list(): Tenant[] {
    return Array.from(this.tenants.values());
  }

  touch(tenantId: string): void {
    const tenant = this.tenants.get(tenantId);
    if (tenant) {
      tenant.lastActivityAt = Date.now();
    }
  }

  /** Generate a short random tenant ID (e.g. "a1b2c3") */
  static generateId(): string {
    return Math.random().toString(36).slice(2, 8);
  }

  /** Extract tenant ID from URL path. Returns "default" if no /{id} prefix found. */
  static extractTenantId(urlPath: string): string {
    const path = urlPath.split('?')[0].replace(/\/+$/, '');
    // Match first path segment that looks like a tenant ID
    const match = path.match(/^\/([a-zA-Z0-9_.-]+)(?:\/|$)/);
    return match?.[1] ?? 'default';
  }

  /** Start periodic cleanup of idle tenants (no ext + no MCP clients for > 30 min). */
  startCleanup(intervalMs = 5 * 60_000, idleMs = 30 * 60_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, tenant] of this.tenants.entries()) {
        const hasExtension = tenant.extension !== null;
        const hasClients =
          tenant.registry.getPageToolsByTab().size > 0 || tenant.registry.getServerCount() > 0;
        if (!hasExtension && !hasClients && now - tenant.lastActivityAt > idleMs) {
          this.remove(id);
        }
      }
    }, intervalMs);
  }
}
