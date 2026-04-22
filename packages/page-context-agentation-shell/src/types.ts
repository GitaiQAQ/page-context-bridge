import type {
  FeedbackPriority,
  FeedbackStateDeltaResult,
  FeedbackStateSnapshotResult,
  FeedbackUiAnchor,
  FeedbackUiRect,
} from "@page-context/shared-protocol";

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
 * 编辑 marker 时写回远端 annotation 的最小输入。
 * 只同步当前需求中的 body/priority，避免引入额外耦合。
 */
export interface AgentationShellUpdateAnnotationInput {
  annotationId: string;
  body: string;
  priority: FeedbackPriority;
}

/**
 * 删除 marker 时在远端做可识别移除。
 * 当前走 dismiss 语义，保留历史痕迹，满足“可识别移除”。
 */
export interface AgentationShellDismissAnnotationInput {
  annotationId: string;
  dismissReason?: string;
}

/**
 * shell 拉取反馈快照时使用 shared-protocol 原生结构，
 * 避免额外中间类型造成协议漂移。
 */
export type AgentationShellFeedbackSnapshot = FeedbackStateSnapshotResult;

/**
 * 壳体增量同步直接复用 shared-protocol 结构。
 * 由 content-script 负责维护 afterSeq，壳体只关心事件语义。
 */
export type AgentationShellFeedbackDelta = FeedbackStateDeltaResult;

/**
 * 壳体与 bridge 的注入边界。
 * UI 只依赖接口，不感知 runtime/network/store 实现。
 */
export interface AgentationShellBridgeAdapter {
  createAnnotation(input: AgentationShellCreateAnnotationInput): Promise<AgentationShellCreateAnnotationResult>;
  updateAnnotation?(input: AgentationShellUpdateAnnotationInput): Promise<unknown>;
  dismissAnnotation?(input: AgentationShellDismissAnnotationInput): Promise<unknown>;
  getFeedbackSnapshot?(): Promise<AgentationShellFeedbackSnapshot>;
  getFeedbackStateDelta?(): Promise<AgentationShellFeedbackDelta>;
}

export interface AgentationShellDeps {
  adapter: AgentationShellBridgeAdapter;
  doc?: Document;
  win?: Window;
  logger?: (level: "debug" | "error", message: string, extra?: unknown) => void;
}

/**
 * 可复用挂载 API 的输入。
 * host 可选：不传时沿用默认 body host；传入时复用外部容器。
 */
export interface AgentationShellMountDeps extends AgentationShellDeps {
  host?: HTMLDivElement;
}

/**
 * 挂载句柄只暴露最小清理能力。
 * 调用方通过 unmount 回收事件和 UI，避免内存/监听器泄漏。
 */
export interface AgentationShellMountHandle {
  host: HTMLDivElement;
  unmount: () => void;
}
