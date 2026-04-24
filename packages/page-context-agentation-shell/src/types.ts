import type {
  FeedbackPriority,
  FeedbackStateDeltaResult,
  FeedbackStateSnapshotResult,
  FeedbackUiAnchor,
  FeedbackUiRect,
} from "@page-context/shared-protocol";

/**
 * Minimal snapshot of each aggregated element in multi-select mode.
 * Only retain fields necessary for submission and troubleshooting, avoid putting DOM references into protocol meta.
 */
export interface AgentationShellMultiSelectItem {
  elementName: string;
  elementPath: string;
  rect: FeedbackUiRect;
}

/**
 * Structured details written to uiAnchor.meta during multi-select submission.
 * count + items are used to restore the selection set, unionRect is used for quick positioning of the overall area.
 */
export interface AgentationShellMultiSelectMeta {
  count: number;
  unionRect: FeedbackUiRect;
  items: AgentationShellMultiSelectItem[];
}

/**
 * Minimal input structure from UI shell to bridge.
 * Currently only requires the main create flow, other operations will be extended as needed.
 */
export interface AgentationShellCreateAnnotationInput {
  body: string;
  priority: FeedbackPriority;
  selectedText?: string;
  // Anchor aligned with shared-protocol, directly passed through by content-script to background.
  uiAnchor?: FeedbackUiAnchor;
  target: {
    elementName: string;
    elementPath: string;
    rect: DOMRectReadOnly;
  };
}

/**
 * create result only constrains optional id.
 * bridge return structure may change during parallel development, so keep it loose here.
 */
export interface AgentationShellCreateAnnotationResult {
  id?: string;
  raw?: unknown;
}

/**
 * Minimal input for writing back to remote annotation when editing marker.
 * Only sync body/priority from current requirements to avoid introducing extra coupling.
 */
export interface AgentationShellUpdateAnnotationInput {
  annotationId: string;
  body: string;
  priority: FeedbackPriority;
}

/**
 * Perform identifiable removal remotely when deleting marker.
 * Currently uses dismiss semantics to preserve historical traces and satisfy "identifiable removal".
 */
export interface AgentationShellDismissAnnotationInput {
  annotationId: string;
  dismissReason?: string;
}

/**
 * shell uses shared-protocol native structure when fetching feedback snapshots,
 * avoid protocol drift caused by extra intermediate types.
 */
export type AgentationShellFeedbackSnapshot = FeedbackStateSnapshotResult;

/**
 * Shell incremental sync directly reuses shared-protocol structure.
 * content-script is responsible for maintaining afterSeq, shell only cares about event semantics.
 */
export type AgentationShellFeedbackDelta = FeedbackStateDeltaResult;

/**
 * Injection boundary between shell and bridge.
 * UI only depends on interfaces, not aware of runtime/network/store implementation.
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
 * Input for reusable mount API.
 * host is optional: when not provided, use default body host; when provided, reuse external container.
 */
export interface AgentationShellMountDeps extends AgentationShellDeps {
  host?: HTMLDivElement;
}

/**
 * Mount handle only exposes minimal cleanup capability.
 * Caller recycles events and UI through unmount to avoid memory/listener leaks.
 */
export interface AgentationShellMountHandle {
  host: HTMLDivElement;
  unmount: () => void;
}
