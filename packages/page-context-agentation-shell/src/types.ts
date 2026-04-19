import type { FeedbackPriority, FeedbackUiAnchor, FeedbackUiRect } from "@page-context/shared-protocol";

/**
 * 多选模式下，每个被聚合元素的最小快照。
 * 只保留提交和排障必需字段，避免把 DOM 引用塞进协议 meta。
 */
export interface AgentationShellMultiSelectItem {
  elementName: string;
  elementPath: string;
  rect: FeedbackUiRect;
}

/**
 * 多选提交时写入 uiAnchor.meta 的结构化明细。
 * count + items 用于还原选择集合，unionRect 用于快速定位整体区域。
 */
export interface AgentationShellMultiSelectMeta {
  count: number;
  unionRect: FeedbackUiRect;
  items: AgentationShellMultiSelectItem[];
}

/**
 * UI 壳对 bridge 的最小输入结构。
 * 当前只要求 create 主链路，其他操作后续按需扩展。
 */
export interface AgentationShellCreateAnnotationInput {
  body: string;
  priority: FeedbackPriority;
  selectedText?: string;
  // 与 shared-protocol 对齐的锚点，供 content-script 直接透传给 background。
  uiAnchor?: FeedbackUiAnchor;
  target: {
    elementName: string;
    elementPath: string;
    rect: DOMRectReadOnly;
  };
}

/**
 * create 结果只约束可选 id。
 * bridge 返回结构可能在并行开发中变化，因此这里保持宽松。
 */
export interface AgentationShellCreateAnnotationResult {
  id?: string;
  raw?: unknown;
}

/**
 * 壳体与 bridge 的注入边界。
 * UI 只依赖接口，不感知 runtime/network/store 实现。
 */
export interface AgentationShellBridgeAdapter {
  createAnnotation(input: AgentationShellCreateAnnotationInput): Promise<AgentationShellCreateAnnotationResult>;
}

export interface AgentationShellDeps {
  adapter: AgentationShellBridgeAdapter;
  doc?: Document;
  win?: Window;
  logger?: (level: "debug" | "error", message: string, extra?: unknown) => void;
}
