export const FEEDBACK_UI_MODE_ATTR = "data-page-context-feedback-ui-mode";
export const FEEDBACK_UI_REASON_ATTR = "data-page-context-feedback-ui-reason";

export type FeedbackUiMode = "react-root" | "shell-fallback" | "legacy-overlay";

interface MarkFeedbackUiModeOptions {
  doc?: Document;
  reason?: string;
}

/**
 * 统一在 documentElement 打“当前 UI 模式”标记。
 * 约束：只暴露稳定、最小字段，方便 DOM 和 browser test 直接判定当前链路。
 */
export function markFeedbackUiMode(mode: FeedbackUiMode, options: MarkFeedbackUiModeOptions = {}): void {
  const root = resolveFeedbackUiDiagnosticRoot(options.doc);
  if (!root) {
    return;
  }

  root.setAttribute(FEEDBACK_UI_MODE_ATTR, mode);
  const normalizedReason = options.reason?.trim();
  if (normalizedReason) {
    root.setAttribute(FEEDBACK_UI_REASON_ATTR, normalizedReason);
    return;
  }
  root.removeAttribute(FEEDBACK_UI_REASON_ATTR);
}

function resolveFeedbackUiDiagnosticRoot(doc?: Document): HTMLElement | null {
  if (doc?.documentElement) {
    return doc.documentElement;
  }
  // 允许在非浏览器上下文安全调用：拿不到 document 时直接 no-op。
  if (typeof globalThis.document === "undefined") {
    return null;
  }
  return globalThis.document.documentElement;
}
