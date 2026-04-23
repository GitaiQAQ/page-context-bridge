import { BRIDGE_METHODS, type FeedbackPriority } from "@page-context/shared-protocol";

import { sendRuntimeRequest } from "./runtime-rpc";

const FEEDBACK_OVERLAY_HOST_ID = "__page_context_feedback_overlay_host__";
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

interface FeedbackCreatePayload {
  body: string;
  priority: FeedbackPriority;
  selectedText?: string;
}

interface FeedbackUpdatePayload {
  annotationId: string;
  body: string;
  priority?: FeedbackPriority;
}

interface FeedbackDismissPayload {
  annotationId: string;
  dismissReason?: string;
}

interface FeedbackOverlayDeps {
  doc?: Document;
  win?: Window;
  submitFeedback?: (payload: FeedbackCreatePayload) => Promise<unknown>;
  updateFeedback?: (payload: FeedbackUpdatePayload) => Promise<unknown>;
  dismissFeedback?: (payload: FeedbackDismissPayload) => Promise<unknown>;
}

/**
 * 在页面注入最小反馈入口：
 * 1) 固定入口按钮
 * 2) 轻量表单
 * 3) 提交到 extension.feedback.annotation.create
 */
export function installFeedbackOverlay(deps: FeedbackOverlayDeps = {}): void {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  if (!shouldInstallOverlay(doc, win)) {
    return;
  }

  if (doc.getElementById(FEEDBACK_OVERLAY_HOST_ID)) {
    return;
  }

  const submitFeedback = deps.submitFeedback ?? defaultSubmitFeedback;
  const updateFeedback = deps.updateFeedback ?? defaultUpdateFeedback;
  const dismissFeedback = deps.dismissFeedback ?? defaultDismissFeedback;

  const host = doc.createElement("div");
  host.id = FEEDBACK_OVERLAY_HOST_ID;
  doc.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      .pc-feedback-root {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #1f2937;
      }
      .pc-feedback-entry {
        border: 1px solid #d1d5db;
        background: #ffffff;
        color: #111827;
        border-radius: 999px;
        padding: 6px 12px;
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(15, 23, 42, 0.12);
      }
      .pc-feedback-panel {
        margin-top: 8px;
        width: 280px;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        background: #ffffff;
        box-shadow: 0 12px 24px rgba(15, 23, 42, 0.18);
        padding: 10px;
      }
      .pc-feedback-panel[hidden] {
        display: none;
      }
      .pc-feedback-title {
        margin: 0 0 8px 0;
        font-size: 12px;
        font-weight: 600;
      }
      .pc-feedback-label {
        display: block;
        margin: 8px 0 4px 0;
        font-size: 12px;
        color: #374151;
      }
      .pc-feedback-input,
      .pc-feedback-select {
        box-sizing: border-box;
        width: 100%;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        padding: 6px 8px;
        font-size: 12px;
        color: #111827;
        background: #ffffff;
      }
      .pc-feedback-input {
        resize: vertical;
        min-height: 72px;
      }
      .pc-feedback-selection {
        margin: 0;
        font-size: 12px;
        line-height: 1.4;
        color: #6b7280;
        border: 1px dashed #d1d5db;
        border-radius: 6px;
        padding: 6px 8px;
        max-height: 78px;
        overflow: auto;
        white-space: pre-wrap;
      }
      .pc-feedback-actions {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-top: 10px;
      }
      .pc-feedback-btn {
        border: 1px solid #d1d5db;
        border-radius: 6px;
        background: #ffffff;
        color: #111827;
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
      }
      .pc-feedback-btn-primary {
        border-color: #2563eb;
        background: #2563eb;
        color: #ffffff;
      }
      .pc-feedback-btn[disabled] {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .pc-feedback-status {
        margin-top: 8px;
        min-height: 16px;
        font-size: 12px;
      }
      .pc-feedback-status.info { color: #6b7280; }
      .pc-feedback-status.success { color: #15803d; }
      .pc-feedback-status.error { color: #b91c1c; }
    </style>
    <div class="pc-feedback-root">
      <button type="button" class="pc-feedback-entry" data-entry>UI 标注</button>
      <form class="pc-feedback-panel" data-panel hidden>
        <p class="pc-feedback-title">Create Annotation</p>
        <label class="pc-feedback-label" for="pc-feedback-body">反馈内容</label>
        <textarea id="pc-feedback-body" class="pc-feedback-input" data-body maxlength="2000" placeholder="描述问题或建议"></textarea>
        <label class="pc-feedback-label" for="pc-feedback-priority">优先级</label>
        <select id="pc-feedback-priority" class="pc-feedback-select" data-priority>
          <option value="low">low</option>
          <option value="normal" selected>normal</option>
          <option value="high">high</option>
          <option value="critical">critical</option>
        </select>
        <label class="pc-feedback-label" for="pc-feedback-annotation-id">Annotation ID（用于 update / dismiss）</label>
        <input id="pc-feedback-annotation-id" class="pc-feedback-select" data-annotation-id placeholder="例如 anno-123" />
        <label class="pc-feedback-label" for="pc-feedback-dismiss-reason">Dismiss 原因（可选）</label>
        <input id="pc-feedback-dismiss-reason" class="pc-feedback-select" data-dismiss-reason placeholder="误报 / 重复 / 已处理" />
        <label class="pc-feedback-label">当前选中文本</label>
        <p class="pc-feedback-selection" data-selection>未检测到页面选中内容</p>
        <div class="pc-feedback-actions">
          <button type="button" class="pc-feedback-btn" data-refresh-selection>刷新选中</button>
          <button type="button" class="pc-feedback-btn" data-update>更新</button>
          <button type="button" class="pc-feedback-btn" data-dismiss>Dismiss</button>
          <button type="submit" class="pc-feedback-btn pc-feedback-btn-primary" data-submit>Create</button>
        </div>
        <p class="pc-feedback-status info" data-status aria-live="polite">Idle</p>
      </form>
    </div>
  `;

  const entryButton = queryRequired<HTMLButtonElement>(shadow, "[data-entry]");
  const panel = queryRequired<HTMLFormElement>(shadow, "[data-panel]");
  const bodyInput = queryRequired<HTMLTextAreaElement>(shadow, "[data-body]");
  const prioritySelect = queryRequired<HTMLSelectElement>(shadow, "[data-priority]");
  const annotationIdInput = queryRequired<HTMLInputElement>(shadow, "[data-annotation-id]");
  const dismissReasonInput = queryRequired<HTMLInputElement>(shadow, "[data-dismiss-reason]");
  const selectionView = queryRequired<HTMLParagraphElement>(shadow, "[data-selection]");
  const refreshSelectionButton = queryRequired<HTMLButtonElement>(shadow, "[data-refresh-selection]");
  const updateButton = queryRequired<HTMLButtonElement>(shadow, "[data-update]");
  const dismissButton = queryRequired<HTMLButtonElement>(shadow, "[data-dismiss]");
  const submitButton = queryRequired<HTMLButtonElement>(shadow, "[data-submit]");
  const statusView = queryRequired<HTMLParagraphElement>(shadow, "[data-status]");

  let cachedSelection = "";
  let currentSelectionText = "";
  let mutating = false;

  const setStatus = (message: string, level: "info" | "success" | "error" = "info") => {
    statusView.textContent = message;
    statusView.className = `pc-feedback-status ${level}`;
  };

  const setMutating = (next: boolean) => {
    mutating = next;
    submitButton.disabled = next;
    updateButton.disabled = next;
    dismissButton.disabled = next;
    refreshSelectionButton.disabled = next;
    annotationIdInput.disabled = next;
    dismissReasonInput.disabled = next;
    entryButton.disabled = next;
  };

  const syncSelectionView = (nextValue: string) => {
    currentSelectionText = nextValue;
    selectionView.textContent = currentSelectionText || "未检测到页面选中内容";
  };

  const refreshSelection = (preferred = "") => {
    // 优先使用点击入口前缓存的选区，避免按钮抢焦点导致选区丢失。
    const next = normalizeSelectionText(preferred || capturePageSelection(win, doc));
    syncSelectionView(next);
  };

  const openPanel = () => {
    panel.hidden = false;
    entryButton.textContent = "收起";
    refreshSelection(cachedSelection);
    setStatus("Idle", "info");
    bodyInput.focus();
  };

  const closePanel = () => {
    panel.hidden = true;
    entryButton.textContent = "UI 标注";
    setStatus("Idle", "info");
  };

  entryButton.addEventListener("pointerdown", () => {
    cachedSelection = capturePageSelection(win, doc);
  });

  entryButton.addEventListener("click", () => {
    if (panel.hidden) {
      openPanel();
      return;
    }
    closePanel();
  });

  refreshSelectionButton.addEventListener("click", () => {
    if (mutating) {
      return;
    }
    refreshSelection();
    setStatus("已刷新选中内容", "info");
  });

  const buildUpdatePayload = (): FeedbackUpdatePayload | null => {
    // update 与 create 共用 body/priority 输入，校验集中在这里，减少分支重复。
    const annotationId = annotationIdInput.value.trim();
    if (!annotationId) {
      setStatus("请输入 Annotation ID", "error");
      annotationIdInput.focus();
      return null;
    }
    const body = bodyInput.value.trim();
    if (!body) {
      setStatus("请输入反馈内容", "error");
      bodyInput.focus();
      return null;
    }
    return {
      annotationId,
      body,
      priority: (prioritySelect.value as FeedbackPriority) || "normal",
    };
  };

  const getAnnotationIdOrFail = (): string | null => {
    // dismiss 只依赖 annotationId，原因字段保持可选，尽量不阻塞操作链路。
    const annotationId = annotationIdInput.value.trim();
    if (annotationId) {
      return annotationId;
    }
    setStatus("请输入 Annotation ID", "error");
    annotationIdInput.focus();
    return null;
  };

  panel.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (mutating) {
      return;
    }

    const body = bodyInput.value.trim();
    if (!body) {
      setStatus("请输入反馈内容", "error");
      bodyInput.focus();
      return;
    }

    setMutating(true);
    setStatus("Submitting...", "info");

    try {
      const result = await submitFeedback({
        body,
        priority: (prioritySelect.value as FeedbackPriority) || "normal",
        selectedText: currentSelectionText || undefined,
      });
      // create 成功后尽量自动回填 id，让 update/dismiss 能无缝接着走。
      const createdAnnotationId = extractAnnotationId(result);
      if (createdAnnotationId) {
        annotationIdInput.value = createdAnnotationId;
      }
      bodyInput.value = "";
      setStatus("反馈已创建", "success");
      closePanel();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`提交失败: ${message}`, "error");
    } finally {
      setMutating(false);
    }
  });

  updateButton.addEventListener("click", async () => {
    if (mutating) {
      return;
    }
    const payload = buildUpdatePayload();
    if (!payload) {
      return;
    }

    setMutating(true);
    setStatus("Updating...", "info");
    try {
      await updateFeedback(payload);
      setStatus("反馈已更新", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`更新失败: ${message}`, "error");
    } finally {
      setMutating(false);
    }
  });

  dismissButton.addEventListener("click", async () => {
    if (mutating) {
      return;
    }
    const annotationId = getAnnotationIdOrFail();
    if (!annotationId) {
      return;
    }

    setMutating(true);
    setStatus("Dismissing...", "info");
    try {
      await dismissFeedback({
        annotationId,
        dismissReason: dismissReasonInput.value.trim() || undefined,
      });
      setStatus("反馈已 dismiss", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Dismiss 失败: ${message}`, "error");
    } finally {
      setMutating(false);
    }
  });
}

function shouldInstallOverlay(doc: Document, win: Window): boolean {
  if (!doc.body) {
    return false;
  }
  // 仅在常规网页注入，避免干扰扩展页/浏览器内部页。
  if (!SUPPORTED_PROTOCOLS.has(win.location.protocol)) {
    return false;
  }
  return isTopWindow(win);
}

function isTopWindow(win: Window): boolean {
  try {
    return win.top === win;
  } catch {
    return false;
  }
}

function capturePageSelection(win: Window, doc: Document): string {
  const fromRange = win.getSelection?.()?.toString?.() ?? "";
  if (fromRange.trim()) {
    return fromRange;
  }

  const activeElement = doc.activeElement;
  if (!(activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement)) {
    return "";
  }

  const start = activeElement.selectionStart ?? 0;
  const end = activeElement.selectionEnd ?? 0;
  if (start === end) {
    return "";
  }
  return activeElement.value.slice(start, end);
}

function normalizeSelectionText(value: string): string {
  return value.trim().slice(0, 2_000);
}

function queryRequired<T extends Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector(selector);
  if (!node) {
    throw new Error(`Feedback overlay missing node: ${selector}`);
  }
  return node as T;
}

async function defaultSubmitFeedback(payload: FeedbackCreatePayload): Promise<unknown> {
  return await sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationCreate, payload);
}

async function defaultUpdateFeedback(payload: FeedbackUpdatePayload): Promise<unknown> {
  return await sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationUpdate, payload);
}

async function defaultDismissFeedback(payload: FeedbackDismissPayload): Promise<unknown> {
  return await sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationDismiss, payload);
}

function extractAnnotationId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  if (typeof record.id === "string" && record.id.trim()) {
    return record.id.trim();
  }
  const annotation = record.annotation;
  if (!annotation || typeof annotation !== "object") {
    return undefined;
  }
  const annotationId = (annotation as { id?: unknown }).id;
  if (typeof annotationId === "string" && annotationId.trim()) {
    return annotationId.trim();
  }
  return undefined;
}
