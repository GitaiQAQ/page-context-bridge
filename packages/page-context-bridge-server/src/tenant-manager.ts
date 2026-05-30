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
   * Register a tenant removal listener.
   * Expose only tenantId so callers own resource cleanup for the transports they hold.
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

  /**
   * Extract tenantId.
   *
   * Priority:
   * 1. `?tenantId=xxx`, for extension WebSocket use;
   * 2. `/{tenantId}/...`, so existing HTTP MCP/SSE routes can keep reusing it.
   *
   * This preserves the existing "WS uses query" and "HTTP uses path" contract without adding another protocol branch.
   */
  static extractTenantId(rawUrl: string): string {
    const parsed = new URL(rawUrl, 'http://localhost');
    const queryTenantId = parsed.searchParams.get('tenantId')?.trim();
    if (queryTenantId) {
      return queryTenantId;
    }

    const path = parsed.pathname.replace(/\/+$/, '');
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
