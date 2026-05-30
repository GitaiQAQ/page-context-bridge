/**
 * Shared connection panel protocol.
 *
 * This file only defines connection shape, allowed actions, and RPC methods.
 * UI copy does not belong here, and drivers do not put business logic here.
 */

export const CONNECTION_METHODS = {
  list: 'connections.list',
  subscribe: 'connections.subscribe',
  action: 'connections.action',
  changed: 'connections.changed',
} as const;

/**
 * Connection kind.
 *
 * Keep names explicit so the sidepanel does not infer semantics from raw strings later.
 */
export type ConnectionKind =
  | 'bridge-default-ws'
  | 'opencode-http'
  | 'opencode-bridge-ws'
  | 'page-tools'
  | 'main-world-host'
  | 'agentation-main-world-host';

/**
 * Connection status.
 *
 * Constraints:
 * - drivers only report status codes
 * - UI renders badges from status codes centrally
 * - feature modules must not hand-roll green/red status text
 */
export type ConnectionStatus =
  | 'connected'
  | 'connecting'
  | 'reachable'
  | 'unreachable'
  | 'closed'
  | 'error';

export type ConnectionAction = 'reconnect' | 'disconnect';

export interface ConnectionCapabilities {
  reconnect?: boolean;
  disconnect?: boolean;
}

/**
 * Unified connection descriptor.
 *
 * Notes:
 * - `id` is the registry primary key
 * - `label` is human-readable
 * - `endpoint` helps humans debug the link
 * - `statusReason` is supplemental and not primary status copy
 */
export interface ConnectionDescriptor {
  id: string;
  kind: ConnectionKind;
  label: string;
  endpoint: string | null;
  status: ConnectionStatus;
  statusReason?: string | null;
  capabilities?: ConnectionCapabilities;
  meta?: Record<string, unknown>;
  updatedAt: string;
}

export interface ConnectionsListResult {
  descriptors: ConnectionDescriptor[];
}

/**
 * Keep `subscribe` lightweight:
 * - return the current snapshot
 * - tell callers which runtime notification to listen for next
 *
 * Avoid long-lived subscription tables in background to keep implementation simple and recoverable.
 */
export interface ConnectionsSubscribeResult extends ConnectionsListResult {
  notificationMethod: typeof CONNECTION_METHODS.changed;
}

export interface ConnectionActionParams {
  descriptorId: string;
  action: ConnectionAction;
}
