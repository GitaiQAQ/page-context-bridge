/**
 * 连接面板共享协议。
 *
 * 这里只有“连接长什么样、允许做什么动作、走哪些 RPC”这三件事。
 * UI 不在这里拼文案，driver 也不在这里写业务逻辑。
 */

export const CONNECTION_METHODS = {
  list: 'connections.list',
  subscribe: 'connections.subscribe',
  action: 'connections.action',
  changed: 'connections.changed',
} as const;

/**
 * 连接种类。
 *
 * 命名保持显式，避免后续在 sidepanel 里再靠字符串猜语义。
 */
export type ConnectionKind =
  | 'bridge-default-ws'
  | 'opencode-http'
  | 'opencode-bridge-ws'
  | 'page-tools'
  | 'main-world-host'
  | 'agentation-main-world-host';

/**
 * 连接状态。
 *
 * 约束：
 * - driver 只上报状态码
 * - UI 统一根据状态码渲染 badge
 * - 不允许业务模块各自手搓“绿色/红色文本”
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
 * 统一连接描述。
 *
 * 说明：
 * - `id` 是 registry 主键
 * - `label` 给人看
 * - `endpoint` 给人排查链路
 * - `statusReason` 只做补充说明，不作为主状态文案
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
 * `subscribe` 维持轻语义：
 * - 返回当前快照
 * - 告诉调用方后续要监听哪个 runtime notification
 *
 * 不在 background 里维持长期订阅表，保持实现简单、可恢复。
 */
export interface ConnectionsSubscribeResult extends ConnectionsListResult {
  notificationMethod: typeof CONNECTION_METHODS.changed;
}

export interface ConnectionActionParams {
  descriptorId: string;
  action: ConnectionAction;
}
