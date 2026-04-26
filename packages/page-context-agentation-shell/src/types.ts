import type { FeedbackUiAdapter, FeedbackUiRect } from '@page-context/shared-protocol';

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

export interface AgentationShellDeps {
  adapter: FeedbackUiAdapter;
  doc?: Document;
  win?: Window;
  logger?: (level: 'debug' | 'error', message: string, extra?: unknown) => void;
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
