/**
 * Sidepanel type definitions for the tool tree and context manifest UI.
 */

import type {
  ContextResourceDescriptor,
  ContextSkillDescriptor,
  FeedbackPriority,
  PageContextManifest,
} from '@page-context/shared-protocol';

import type { ContextManifestFilterDebug } from './context-manifest-filter-debug';

export interface RuntimeScopedSessionStatus {
  tenantId: string;
  wsUrl: string | null;
  connected: boolean;
  bridgeSessionId: string | null;
}

export interface RuntimeStatus {
  connected: boolean;
  pendingToolCalls?: number;
  sessionId?: string | null;
  scopedSessions?: RuntimeScopedSessionStatus[];
}

export interface ToolTreeTool {
  kind: 'tool';
  tabId: number;
  namespace: string;
  instanceId: string;
  toolName: string;
  label: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  enabled: boolean;
  readOnly: boolean;
}

export interface ToolTreeInstance {
  kind: 'instance';
  tabId: number;
  namespace: string;
  instanceId: string;
  totalTools: number;
  enabledTools: number;
  tools: ToolTreeTool[];
}

export interface ToolTreeNamespace {
  kind: 'namespace';
  tabId: number;
  namespace: string;
  title?: string;
  description?: string;
  totalTools: number;
  enabledTools: number;
  instances: ToolTreeInstance[];
}

export interface ToolTreeTab {
  kind: 'tab';
  tabId: number;
  title: string;
  url: string;
  active: boolean;
  totalTools: number;
  enabledTools: number;
  namespaces: ToolTreeNamespace[];
}

export interface ToolTreeResponse {
  builtins: ToolTreeBuiltins;
  tabs: ToolTreeTab[];
  totalTools: number;
  enabledTools: number;
}

export interface ToolTreeBuiltins {
  kind: 'builtins';
  totalTools: number;
  enabledTools: number;
  namespaces: ToolTreeBuiltinNamespace[];
  /**
   * Compatible field: Keep flat list for legacy consumption.
   * New logic uniformly follows namespaces -> instances -> tools to avoid parallel implementations.
   */
  tools: ToolTreeBuiltinTool[];
}

export interface ToolTreeBuiltinNamespace {
  kind: 'builtin-namespace';
  namespace: string;
  totalTools: number;
  enabledTools: number;
  instances: ToolTreeBuiltinInstance[];
}

export interface ToolTreeBuiltinInstance {
  kind: 'builtin-instance';
  namespace: string;
  instanceId: string;
  totalTools: number;
  enabledTools: number;
  tools: ToolTreeBuiltinTool[];
}

export interface ToolTreeBuiltinTool {
  kind: 'builtin-tool';
  namespace: string;
  instanceId: string;
  toolName: string;
  label: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  enabled: boolean;
  readOnly: boolean;
  bridgeControl: boolean;
}

export interface ToolDebugResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ToolTestSelection {
  root: 'builtin' | 'page';
  toolName: string;
  label: string;
  tabId?: number;
  inputSchema?: Record<string, unknown>;
}

export interface ContextManifestResponse {
  manifest: PageContextManifest | null;
  rawManifest?: PageContextManifest | null;
  debug?: ContextManifestFilterDebug;
}

export interface ContextSkillResponse {
  prompt: { skill: ContextSkillDescriptor; text: string } | null;
}

/**
 * Sidepanel URL query binding.
 * 只用于 launcher/fallback URL，和 runtime RPC payload 分离，避免语义混淆。
 */
export interface SidepanelUrlTabBinding {
  /**
   * 兼容字段：已有 fallback URL 使用 boundTabId。
   * query 层继续保留该名字，避免旧链接失效。
   */
  boundTabId?: number;
  windowId?: number;
}

/**
 * Runtime/feedback 显式 tab 绑定。
 * RPC 层统一使用 tabId/windowId，不和 URL query 字段名耦合。
 */
export interface RuntimeExplicitTabBinding {
  tabId?: number;
  windowId?: number;
}

/**
 * runtime 入口兼容输入：
 * - 新字段 tabId
 * - 兼容字段 boundTabId（例如从 URL 绑定透传过来的场景）
 */
export type RuntimeExplicitTabBindingInput = RuntimeExplicitTabBinding & {
  boundTabId?: number;
};

export interface SidepanelFeedbackDraft extends RuntimeExplicitTabBinding {
  body: string;
  priority: FeedbackPriority;
}
