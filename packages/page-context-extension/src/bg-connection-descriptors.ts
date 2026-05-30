/**
 * Helpers for tab-related connection descriptors.
 *
 * These links are not standard sockets, but users still see them as external connections
 * between the extension and the page. Registering them together lets the Connections panel show them at a glance.
 */

import type { ConnectionKind, ConnectionStatus } from '@page-context/shared-protocol';

import { getConnectionRegistry } from './bg-connection-registry';

function upsertTabScopedDescriptor(input: {
  id: string;
  kind: ConnectionKind;
  label: string;
  tabId: number;
  frameId?: number;
  endpoint?: string | null;
  status: ConnectionStatus;
  statusReason?: string | null;
  capabilities?: {
    reconnect?: boolean;
    disconnect?: boolean;
  };
}): void {
  const registry = getConnectionRegistry();
  const current = registry.get(input.id);
  const endpoint = input.endpoint ?? `tab:${input.tabId}`;

  if (current) {
    registry.update(input.id, {
      endpoint,
      status: input.status,
      statusReason: input.statusReason ?? null,
      capabilities: input.capabilities ?? current.capabilities,
      meta: {
        ...(current.meta ?? {}),
        tabId: input.tabId,
        ...(input.frameId != null ? { frameId: input.frameId } : {}),
      },
    });
    return;
  }

  registry.register({
    id: input.id,
    kind: input.kind,
    label: input.label,
    endpoint,
    status: input.status,
    statusReason: input.statusReason ?? null,
    capabilities: input.capabilities ?? {},
    meta: {
      tabId: input.tabId,
      ...(input.frameId != null ? { frameId: input.frameId } : {}),
    },
  });
}

export function getPageToolsDescriptorId(tabId: number): string {
  return `page-tools:${tabId}`;
}

export function updatePageToolsDescriptor(
  tabId: number,
  status: ConnectionStatus,
  statusReason?: string | null,
): void {
  upsertTabScopedDescriptor({
    id: getPageToolsDescriptorId(tabId),
    kind: 'page-tools',
    label: `Page Tools · tab ${tabId}`,
    tabId,
    status,
    statusReason,
    capabilities: {
      reconnect: true,
      disconnect: false,
    },
  });
}

export function getMainWorldHostDescriptorId(tabId: number, frameId?: number): string {
  return frameId != null ? `main-world-host:${tabId}:${frameId}` : `main-world-host:${tabId}`;
}

export function updateMainWorldHostDescriptor(
  tabId: number,
  frameId: number | undefined,
  status: ConnectionStatus,
  statusReason?: string | null,
): void {
  upsertTabScopedDescriptor({
    id: getMainWorldHostDescriptorId(tabId, frameId),
    kind: 'main-world-host',
    label:
      frameId != null
        ? `Main World Host · tab ${tabId} · frame ${frameId}`
        : `Main World Host · tab ${tabId}`,
    tabId,
    frameId,
    status,
    statusReason,
    capabilities: {
      reconnect: true,
      disconnect: false,
    },
  });
}

export function getAgentationDescriptorId(tabId: number, frameId?: number): string {
  return frameId != null
    ? `agentation-main-world-host:${tabId}:${frameId}`
    : `agentation-main-world-host:${tabId}`;
}

export function updateAgentationDescriptor(
  tabId: number,
  frameId: number | undefined,
  status: ConnectionStatus,
  statusReason?: string | null,
): void {
  upsertTabScopedDescriptor({
    id: getAgentationDescriptorId(tabId, frameId),
    kind: 'agentation-main-world-host',
    label:
      frameId != null
        ? `Agentation Main World · tab ${tabId} · frame ${frameId}`
        : `Agentation Main World · tab ${tabId}`,
    tabId,
    frameId,
    status,
    statusReason,
    capabilities: {
      reconnect: true,
      disconnect: false,
    },
  });
}
