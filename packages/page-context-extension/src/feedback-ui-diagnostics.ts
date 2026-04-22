export const FEEDBACK_UI_MODE_ATTR = "data-page-context-feedback-ui-mode";
export const FEEDBACK_UI_REASON_ATTR = "data-page-context-feedback-ui-reason";
export const FEEDBACK_UI_SELF_CHECK_STATUS_ATTR = "data-page-context-feedback-ui-self-check-status";
export const FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR = "data-page-context-feedback-ui-self-check-selector";
export const FEEDBACK_UI_SELF_CHECK_RESULT_ATTR = "data-page-context-feedback-ui-self-check-result";

export type FeedbackUiMode = "react-root" | "shell-fallback" | "legacy-overlay";
export type FeedbackUiSelfCheckExpected = "present" | "absent";
export type FeedbackUiSelfCheckResult = "present" | "absent" | "invalid-selector";
export type FeedbackUiSelfCheckStatus = "ok" | "mismatch";

interface FeedbackUiSelfCheckOptions {
  selector: string;
  expected?: FeedbackUiSelfCheckExpected;
}

interface MarkFeedbackUiModeOptions {
  doc?: Document;
  reason?: string;
  selfCheck?: FeedbackUiSelfCheckOptions;
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
  } else {
    root.removeAttribute(FEEDBACK_UI_REASON_ATTR);
  }

  applyFeedbackUiSelfCheck(root, options.selfCheck);
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

function applyFeedbackUiSelfCheck(root: HTMLElement, options?: FeedbackUiSelfCheckOptions): void {
  const selector = options?.selector?.trim();
  if (!selector) {
    // 当前打点不需要自检时，主动清空旧字段，避免旧状态误导排障。
    clearFeedbackUiSelfCheck(root);
    return;
  }

  const expected = options?.expected ?? "present";
  const result = resolveSelfCheckResult(root, selector);
  const status: FeedbackUiSelfCheckStatus = result === expected ? "ok" : "mismatch";
  root.setAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR, status);
  root.setAttribute(FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR, selector);
  root.setAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR, result);
}

function resolveSelfCheckResult(root: HTMLElement, selector: string): FeedbackUiSelfCheckResult {
  const doc = root.ownerDocument;
  if (!doc) {
    return "absent";
  }
  try {
    return doc.querySelector(selector) ? "present" : "absent";
  } catch {
    // selector 非法时明确标记，避免把“探针语法错误”误判成“节点不存在”。
    return "invalid-selector";
  }
}

function clearFeedbackUiSelfCheck(root: HTMLElement): void {
  root.removeAttribute(FEEDBACK_UI_SELF_CHECK_STATUS_ATTR);
  root.removeAttribute(FEEDBACK_UI_SELF_CHECK_SELECTOR_ATTR);
  root.removeAttribute(FEEDBACK_UI_SELF_CHECK_RESULT_ATTR);
}
