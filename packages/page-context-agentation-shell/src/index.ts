import type { FeedbackPriority, FeedbackUiAnchor } from "@page-context/shared-protocol";

import { extractReactAnchorMeta, identifyElement } from "./element-identification";
import type {
  AgentationShellBridgeAdapter,
  AgentationShellCreateAnnotationInput,
  AgentationShellCreateAnnotationResult,
  AgentationShellDeps,
  AgentationShellMultiSelectItem,
  AgentationShellMultiSelectMeta,
} from "./types";
export type {
  AgentationShellBridgeAdapter,
  AgentationShellCreateAnnotationInput,
  AgentationShellCreateAnnotationResult,
  AgentationShellDeps,
  AgentationShellMultiSelectItem,
  AgentationShellMultiSelectMeta,
} from "./types";

const AGENTATION_SHELL_HOST_ID = "__page_context_agentation_shell_host__";
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);
const PRIORITY_ORDER: FeedbackPriority[] = ["low", "normal", "high", "critical"];

interface MarkerRecord {
  id: string;
  body: string;
  priority: FeedbackPriority;
  selectedText?: string;
  elementName: string;
  x: number;
  y: number;
}

interface PopupState {
  anchorX: number;
  anchorY: number;
  selectedText?: string;
  targetElement: HTMLElement;
  targetInput: AgentationShellCreateAnnotationInput["target"];
  multiSelectMeta?: AgentationShellMultiSelectMeta;
}

interface MultiSelectTargetSnapshot {
  element: HTMLElement;
  elementName: string;
  elementPath: string;
  rect: DOMRectReadOnly;
}

/**
 * content-script 调用入口。
 * 成功挂载返回 true；若页面不适合注入则返回 false。
 */
export function installAgentationShell(deps: AgentationShellDeps): boolean {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  if (!shouldInstallShell(doc, win)) {
    return false;
  }
  if (doc.getElementById(AGENTATION_SHELL_HOST_ID)) {
    return true;
  }

  const runtime = new AgentationShellRuntime({
    adapter: deps.adapter,
    doc,
    win,
    logger: deps.logger,
  });
  runtime.mount();
  return true;
}

function shouldInstallShell(doc: Document, win: Window): boolean {
  if (!doc.body) {
    return false;
  }
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

class AgentationShellRuntime {
  private readonly adapter: AgentationShellBridgeAdapter;
  private readonly doc: Document;
  private readonly win: Window;
  private readonly logger?: AgentationShellDeps["logger"];

  private readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;

  private readonly toolbarToggle: HTMLButtonElement;
  private readonly toolbarHint: HTMLSpanElement;
  private readonly hoverBox: HTMLDivElement;
  private readonly markerLayer: HTMLDivElement;
  private readonly popupForm: HTMLFormElement;
  private readonly popupTargetView: HTMLParagraphElement;
  private readonly popupSelectionView: HTMLParagraphElement;
  private readonly popupBodyInput: HTMLTextAreaElement;
  private readonly popupPrioritySelect: HTMLSelectElement;
  private readonly popupStatusView: HTMLParagraphElement;
  private readonly popupCancelButton: HTMLButtonElement;
  private readonly popupSubmitButton: HTMLButtonElement;

  private annotating = false;
  private submitting = false;
  private popupState: PopupState | null = null;
  private hoveredElement: HTMLElement | null = null;
  private hoveredElementLabel = "";
  private markerIdSeq = 0;
  private readonly markers: MarkerRecord[] = [];
  private readonly multiSelectTargets = new Map<HTMLElement, MultiSelectTargetSnapshot>();
  private multiSelectLastAnchorX = 0;
  private multiSelectLastAnchorY = 0;

  constructor(args: {
    adapter: AgentationShellBridgeAdapter;
    doc: Document;
    win: Window;
    logger?: AgentationShellDeps["logger"];
  }) {
    this.adapter = args.adapter;
    this.doc = args.doc;
    this.win = args.win;
    this.logger = args.logger;

    this.host = this.doc.createElement("div");
    this.host.id = AGENTATION_SHELL_HOST_ID;
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.innerHTML = SHELL_TEMPLATE;

    this.toolbarToggle = queryRequired<HTMLButtonElement>(this.shadow, "[data-toolbar-toggle]");
    this.toolbarHint = queryRequired<HTMLSpanElement>(this.shadow, "[data-toolbar-hint]");
    this.hoverBox = queryRequired<HTMLDivElement>(this.shadow, "[data-hover-box]");
    this.markerLayer = queryRequired<HTMLDivElement>(this.shadow, "[data-marker-layer]");
    this.popupForm = queryRequired<HTMLFormElement>(this.shadow, "[data-popup]");
    this.popupTargetView = queryRequired<HTMLParagraphElement>(this.shadow, "[data-popup-target]");
    this.popupSelectionView = queryRequired<HTMLParagraphElement>(this.shadow, "[data-popup-selection]");
    this.popupBodyInput = queryRequired<HTMLTextAreaElement>(this.shadow, "[data-popup-body]");
    this.popupPrioritySelect = queryRequired<HTMLSelectElement>(this.shadow, "[data-popup-priority]");
    this.popupStatusView = queryRequired<HTMLParagraphElement>(this.shadow, "[data-popup-status]");
    this.popupCancelButton = queryRequired<HTMLButtonElement>(this.shadow, "[data-popup-cancel]");
    this.popupSubmitButton = queryRequired<HTMLButtonElement>(this.shadow, "[data-popup-submit]");
  }

  mount(): void {
    this.doc.body.appendChild(this.host);
    this.toolbarToggle.addEventListener("click", this.onToolbarToggleClick);
    this.popupCancelButton.addEventListener("click", this.onPopupCancelClick);
    this.popupForm.addEventListener("submit", this.onPopupSubmit);
    this.popupPrioritySelect.addEventListener("change", this.onPriorityChange);
  }

  private readonly onToolbarToggleClick = (): void => {
    if (this.annotating) {
      this.stopAnnotating();
      return;
    }
    this.startAnnotating();
  };

  private startAnnotating(): void {
    this.annotating = true;
    this.toolbarToggle.dataset.active = "true";
    this.toolbarToggle.textContent = "标注中";
    this.toolbarHint.textContent = "点击页面元素打开标注弹窗，Cmd/Ctrl+Shift+Click 可多选，Esc 可退出。";
    this.doc.addEventListener("pointermove", this.onDocumentPointerMove, true);
    this.doc.addEventListener("click", this.onDocumentClick, true);
    this.doc.addEventListener("keydown", this.onDocumentKeyDown, true);
    this.doc.addEventListener("keyup", this.onDocumentKeyUp, true);
    this.win.addEventListener("scroll", this.onWindowScroll, true);
  }

  private stopAnnotating(): void {
    this.annotating = false;
    this.toolbarToggle.dataset.active = "false";
    this.toolbarToggle.textContent = "UI 标注";
    this.toolbarHint.textContent = "开启后，点击页面元素创建反馈。";
    this.doc.removeEventListener("pointermove", this.onDocumentPointerMove, true);
    this.doc.removeEventListener("click", this.onDocumentClick, true);
    this.doc.removeEventListener("keydown", this.onDocumentKeyDown, true);
    this.doc.removeEventListener("keyup", this.onDocumentKeyUp, true);
    this.win.removeEventListener("scroll", this.onWindowScroll, true);
    this.hoveredElement = null;
    this.hoveredElementLabel = "";
    this.clearMultiSelectTargets();
    this.hideHoverBox();
    this.closePopup();
  }

  private readonly onDocumentPointerMove = (event: PointerEvent): void => {
    if (!this.annotating || this.isEventFromShell(event)) {
      return;
    }
    const target = deepElementFromPoint(this.doc, event.clientX, event.clientY);
    if (!target || this.isNodeInsideShell(target)) {
      this.hoveredElement = null;
      this.hoveredElementLabel = "";
      this.hideHoverBox();
      return;
    }

    if (target !== this.hoveredElement) {
      this.hoveredElement = target;
      this.hoveredElementLabel = identifyElement(target).name;
    }
    this.syncHoverBox(target, this.hoveredElementLabel);
  };

  private readonly onDocumentClick = (event: MouseEvent): void => {
    if (!this.annotating || this.isEventFromShell(event)) {
      return;
    }
    const target = deepElementFromPoint(this.doc, event.clientX, event.clientY);
    if (!target || this.isNodeInsideShell(target)) {
      return;
    }

    // 标注模式下接管点击，避免触发页面真实交互（跳转、提交等）。
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (isMultiSelectChordPressed(event)) {
      this.toggleMultiSelectTarget(target, event.clientX, event.clientY);
      return;
    }

    // 非组合键点击仍保持单选行为，先把残留聚合态清掉，避免后续 Esc 逻辑混乱。
    this.clearMultiSelectTargets();
    this.openPopupForTarget(target, event.clientX, event.clientY);
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (!this.annotating) {
      return;
    }
    if (event.key !== "Escape") {
      return;
    }

    // Esc 优先清理多选聚合，避免误触发关闭流程。
    if (this.multiSelectTargets.size > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.clearMultiSelectTargets();
      this.setPopupStatus("已清空多选聚合", "info");
      return;
    }

    // 无聚合时沿用原逻辑：先关弹窗，再退出标注模式。
    if (!this.popupForm.hidden) {
      event.preventDefault();
      event.stopPropagation();
      this.closePopup();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.stopAnnotating();
  };

  private readonly onDocumentKeyUp = (event: KeyboardEvent): void => {
    if (!this.annotating || this.multiSelectTargets.size === 0) {
      return;
    }
    if (isMultiSelectChordPressed(event)) {
      return;
    }
    this.flushMultiSelectToPopup();
  };

  private readonly onWindowScroll = (): void => {
    // hover 框跟随目标元素滚动，避免视觉错位。
    if (this.hoveredElement && this.annotating) {
      this.syncHoverBox(this.hoveredElement, this.hoveredElementLabel);
    }
  };

  private readonly onPopupCancelClick = (event: MouseEvent): void => {
    event.preventDefault();
    this.closePopup();
  };

  private readonly onPriorityChange = (): void => {
    if (!isFeedbackPriority(this.popupPrioritySelect.value)) {
      this.popupPrioritySelect.value = "normal";
    }
  };

  private readonly onPopupSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (this.submitting || !this.popupState) {
      return;
    }

    const body = this.popupBodyInput.value.trim();
    if (!body) {
      this.setPopupStatus("请输入反馈内容", "error");
      this.popupBodyInput.focus();
      return;
    }

    const priority = normalizePriority(this.popupPrioritySelect.value);
    const uiAnchor = buildUiAnchorFromTarget(
      this.popupState.targetInput,
      this.popupState.selectedText,
      {
        targetElement: this.popupState.targetElement,
        multiSelectMeta: this.popupState.multiSelectMeta,
      },
    );
    const payload: AgentationShellCreateAnnotationInput = {
      body,
      priority,
      selectedText: this.popupState.selectedText,
      uiAnchor,
      target: this.popupState.targetInput,
    };

    this.submitting = true;
    this.syncPopupSubmittingState();
    this.setPopupStatus("Submitting...", "info");

    try {
      const result = await this.adapter.createAnnotation(payload);
      this.applyAnnotationSuccess(result, payload);
      this.setPopupStatus("反馈已创建", "success");
      this.popupBodyInput.value = "";
      this.closePopup();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setPopupStatus(`提交失败: ${message}`, "error");
      this.log("error", "Agentation shell create annotation failed", error);
    } finally {
      this.submitting = false;
      this.syncPopupSubmittingState();
    }
  };

  private applyAnnotationSuccess(
    result: AgentationShellCreateAnnotationResult,
    input: AgentationShellCreateAnnotationInput,
  ): void {
    const idFromResult = typeof result?.id === "string" ? result.id : "";
    const markerId = idFromResult.trim() || `local-${Date.now()}-${this.markerIdSeq++}`;
    if (!this.popupState) {
      return;
    }

    this.markers.push({
      id: markerId,
      body: input.body,
      priority: input.priority,
      selectedText: input.selectedText,
      elementName: input.target.elementName,
      x: this.popupState.anchorX,
      y: this.popupState.anchorY,
    });
    this.renderMarkers();
  }

  private renderMarkers(): void {
    this.markerLayer.innerHTML = "";
    this.markers.forEach((marker, index) => {
      const button = this.doc.createElement("button");
      button.type = "button";
      button.className = "pc-agent-marker";
      button.style.left = `${marker.x}px`;
      button.style.top = `${marker.y}px`;
      button.style.background = markerColor(marker.priority);
      button.textContent = String(index + 1);
      button.setAttribute("aria-label", `annotation-marker-${index + 1}`);

      const tooltip = this.doc.createElement("span");
      tooltip.className = "pc-agent-marker-tooltip";
      tooltip.textContent = buildMarkerTooltip(marker);
      button.appendChild(tooltip);

      this.markerLayer.appendChild(button);
    });
  }

  /**
   * 组合键点击时维护聚合集合：
   * - 第一次点击加入
   * - 再点同元素则移除
   */
  private toggleMultiSelectTarget(target: HTMLElement, clientX: number, clientY: number): void {
    this.multiSelectLastAnchorX = clientX;
    this.multiSelectLastAnchorY = clientY;
    if (!this.popupForm.hidden) {
      this.closePopup();
    }

    if (this.multiSelectTargets.has(target)) {
      this.multiSelectTargets.delete(target);
    } else {
      const info = identifyElement(target);
      this.multiSelectTargets.set(target, {
        element: target,
        elementName: info.name,
        elementPath: info.path,
        rect: snapshotRect(target.getBoundingClientRect()),
      });
    }

    const count = this.multiSelectTargets.size;
    if (count === 0) {
      this.toolbarHint.textContent = "点击页面元素打开标注弹窗，Cmd/Ctrl+Shift+Click 可多选，Esc 可退出。";
      this.setPopupStatus("多选聚合为空", "info");
      return;
    }
    this.toolbarHint.textContent = `已聚合 ${count} 个元素，松开 Cmd/Ctrl+Shift 后弹出统一反馈框。`;
    this.setPopupStatus(`多选聚合中（${count}）`, "info");
  }

  /**
   * Esc 和模式切换都会走这里，保证多选状态被一次性清空。
   */
  private clearMultiSelectTargets(): void {
    this.multiSelectTargets.clear();
    this.multiSelectLastAnchorX = 0;
    this.multiSelectLastAnchorY = 0;
    if (this.annotating) {
      this.toolbarHint.textContent = "点击页面元素打开标注弹窗，Cmd/Ctrl+Shift+Click 可多选，Esc 可退出。";
    }
  }

  /**
   * 组合键松开后，将聚合元素合并成一次提交弹窗。
   */
  private flushMultiSelectToPopup(): void {
    if (this.multiSelectTargets.size === 0) {
      return;
    }
    const snapshots = Array.from(this.multiSelectTargets.values());
    const unionRect = unionRects(snapshots.map((item) => item.rect));
    const unionUiRect = unionRect ? toUiRect(unionRect) : undefined;
    if (!unionRect || !unionUiRect) {
      this.clearMultiSelectTargets();
      return;
    }

    const items: AgentationShellMultiSelectItem[] = snapshots
      .map((snapshot) => {
        const uiRect = toUiRect(snapshot.rect);
        if (!uiRect) {
          return null;
        }
        return {
          elementName: snapshot.elementName,
          elementPath: snapshot.elementPath,
          rect: uiRect,
        };
      })
      .filter((item): item is AgentationShellMultiSelectItem => Boolean(item));
    if (items.length === 0) {
      this.clearMultiSelectTargets();
      return;
    }

    const selectedText = normalizeSelectionText(capturePageSelection(this.win, this.doc));
    const first = snapshots[0];
    const state: PopupState = {
      anchorX:
        this.multiSelectLastAnchorX || clamp(unionRect.left + unionRect.width / 2, 0, this.win.innerWidth),
      anchorY:
        this.multiSelectLastAnchorY || clamp(unionRect.top + unionRect.height / 2, 0, this.win.innerHeight),
      selectedText: selectedText || undefined,
      targetElement: first.element,
      targetInput: {
        elementName: `multi-select (${items.length})`,
        elementPath: first.elementPath,
        rect: snapshotRect(unionRect),
      },
      multiSelectMeta: {
        count: items.length,
        unionRect: unionUiRect,
        items,
      },
    };

    this.clearMultiSelectTargets();
    this.openPopupWithState(state);
  }

  private openPopupForTarget(target: HTMLElement, clientX: number, clientY: number): void {
    const elementInfo = identifyElement(target);
    const selectedText = normalizeSelectionText(capturePageSelection(this.win, this.doc));
    this.openPopupWithState({
      anchorX: clientX,
      anchorY: clientY,
      selectedText: selectedText || undefined,
      targetElement: target,
      targetInput: {
        elementName: elementInfo.name,
        elementPath: elementInfo.path,
        rect: snapshotRect(target.getBoundingClientRect()),
      },
    });
  }

  private openPopupWithState(state: PopupState): void {
    this.popupState = state;
    const nextTop = computePopupTop(state.anchorY, this.win.innerHeight);
    const nextLeft = computePopupLeft(state.anchorX, this.win.innerWidth);
    this.popupForm.style.top = `${nextTop}px`;
    this.popupForm.style.left = `${nextLeft}px`;
    this.popupTargetView.textContent = `${state.targetInput.elementName} · ${state.targetInput.elementPath || "unknown path"}`;
    if (state.selectedText) {
      this.popupSelectionView.textContent = state.selectedText;
    } else if (state.multiSelectMeta) {
      this.popupSelectionView.textContent = `已聚合 ${state.multiSelectMeta.count} 个元素，提交后会写入一条合并标注。`;
    } else {
      this.popupSelectionView.textContent = "未检测到页面选中内容";
    }
    this.popupPrioritySelect.value = "normal";
    this.popupForm.hidden = false;
    this.setPopupStatus("Idle", "info");
    this.win.setTimeout(() => {
      this.popupBodyInput.focus();
    }, 0);
  }

  private closePopup(): void {
    this.popupState = null;
    this.popupForm.hidden = true;
    this.popupBodyInput.value = "";
    this.popupPrioritySelect.value = "normal";
    this.setPopupStatus("Idle", "info");
  }

  private syncHoverBox(target: HTMLElement, label: string): void {
    const rect = target.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      this.hideHoverBox();
      return;
    }
    this.hoverBox.hidden = false;
    this.hoverBox.style.left = `${rect.left}px`;
    this.hoverBox.style.top = `${rect.top}px`;
    this.hoverBox.style.width = `${rect.width}px`;
    this.hoverBox.style.height = `${rect.height}px`;
    this.hoverBox.setAttribute("data-label", label || target.tagName.toLowerCase());
  }

  private hideHoverBox(): void {
    this.hoverBox.hidden = true;
    this.hoverBox.removeAttribute("data-label");
  }

  private setPopupStatus(message: string, level: "info" | "success" | "error"): void {
    this.popupStatusView.textContent = message;
    this.popupStatusView.className = `pc-agent-popup-status ${level}`;
  }

  private syncPopupSubmittingState(): void {
    this.popupSubmitButton.disabled = this.submitting;
    this.popupCancelButton.disabled = this.submitting;
    this.popupPrioritySelect.disabled = this.submitting;
    this.popupBodyInput.readOnly = this.submitting;
  }

  private isEventFromShell(event: Event): boolean {
    return event.composedPath().includes(this.host);
  }

  private isNodeInsideShell(node: Node): boolean {
    if (node.getRootNode() === this.shadow) {
      return true;
    }
    return this.host.contains(node);
  }

  private log(level: "debug" | "error", message: string, extra?: unknown): void {
    if (this.logger) {
      this.logger(level, message, extra);
      return;
    }
    if (level === "error") {
      console.error("[AGENTATION-SHELL]", message, extra);
      return;
    }
    console.debug("[AGENTATION-SHELL]", message, extra);
  }
}

function deepElementFromPoint(doc: Document, x: number, y: number): HTMLElement | null {
  let element = doc.elementFromPoint(x, y) as HTMLElement | null;
  if (!element) {
    return null;
  }
  while (element.shadowRoot) {
    const deeper = element.shadowRoot.elementFromPoint(x, y) as HTMLElement | null;
    if (!deeper || deeper === element) {
      break;
    }
    element = deeper;
  }
  return element;
}

function isMultiSelectChordPressed(event: Pick<MouseEvent | KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey">): boolean {
  return event.shiftKey && (event.metaKey || event.ctrlKey);
}

function snapshotRect(rect: DOMRectReadOnly): DOMRectReadOnly {
  return new DOMRect(rect.x, rect.y, rect.width, rect.height);
}

/**
 * 将多个元素框合成一个包络框，作为统一提交的定位 rect。
 */
function unionRects(rects: readonly DOMRectReadOnly[]): DOMRectReadOnly | null {
  if (rects.length === 0) {
    return null;
  }

  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const rect of rects) {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }

  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
    return null;
  }
  if (right < left || bottom < top) {
    return null;
  }
  return new DOMRect(left, top, right - left, bottom - top);
}

function capturePageSelection(win: Window, doc: Document): string {
  const fromSelection = win.getSelection?.()?.toString?.() ?? "";
  if (fromSelection.trim()) {
    return fromSelection;
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

/**
 * 将 UI 壳内部的 target 结构映射成 shared-protocol 的 uiAnchor。
 * 这里坚持“保守可用”策略：能稳定提供的字段先给出，复杂 selector 引擎留到后续迭代。
 */
function buildUiAnchorFromTarget(
  target: AgentationShellCreateAnnotationInput["target"],
  selectedText?: string,
  options?: {
    targetElement?: HTMLElement;
    multiSelectMeta?: AgentationShellMultiSelectMeta;
  },
): FeedbackUiAnchor {
  const meta: Record<string, unknown> = {
    source: "agentation-shell",
    elementName: target.elementName,
    elementPath: target.elementPath,
  };

  // React 线索可选注入，拿不到时保持静默，不影响普通页面。
  if (options?.targetElement) {
    const reactMeta = extractReactAnchorMeta(options.targetElement);
    if (reactMeta) {
      meta.reactPath = reactMeta.reactPath;
      meta.reactLeaf = reactMeta.reactLeaf;
    }
  }

  // 多选提交仍只创建单条 annotation，这里把聚合明细挂进 meta 便于回放定位。
  if (options?.multiSelectMeta) {
    meta.multiSelect = options.multiSelectMeta;
  }

  return {
    cssSelector: toCssSelectorCandidate(target.elementPath),
    textQuote: normalizeUiTextQuote(selectedText),
    framePath: [0],
    rect: toUiRect(target.rect),
    meta,
  };
}

function normalizeUiTextQuote(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, 2_000);
}

function toUiRect(rect: DOMRectReadOnly): FeedbackUiAnchor["rect"] {
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return undefined;
  }
  if (width < 0 || height < 0) {
    return undefined;
  }
  return { x, y, width, height };
}

function toCssSelectorCandidate(elementPath: string): string | undefined {
  const normalizedPath = elementPath.trim();
  if (!normalizedPath) {
    return undefined;
  }

  // shadow 边界路径是给人看的，不保证符合 CSS 语法，直接降级更稳。
  if (normalizedPath.includes("⟨shadow⟩")) {
    return undefined;
  }

  const segments = normalizedPath
    .split(">")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }

  // 只接受“单标签 / 单类名 / 单 id”这三类简单片段，避免把脏路径塞进协议字段。
  const simpleSelectorSegmentPattern = /^(?:[a-z][a-z0-9-]*|#[^\s>]+|\.[^\s>.#]+)$/i;
  if (!segments.every((segment) => simpleSelectorSegmentPattern.test(segment))) {
    return undefined;
  }

  return segments.join(" > ");
}

function normalizePriority(value: string): FeedbackPriority {
  if (isFeedbackPriority(value)) {
    return value;
  }
  return "normal";
}

function isFeedbackPriority(value: string): value is FeedbackPriority {
  return PRIORITY_ORDER.includes(value as FeedbackPriority);
}

function markerColor(priority: FeedbackPriority): string {
  switch (priority) {
    case "low":
      return "#00c3d0";
    case "high":
      return "#ff8d28";
    case "critical":
      return "#ff383c";
    case "normal":
    default:
      return "#0088ff";
  }
}

function buildMarkerTooltip(marker: MarkerRecord): string {
  const selected = marker.selectedText ? `“${marker.selectedText.slice(0, 40)}”` : "无选中文本";
  return `${marker.elementName} | ${selected} | ${marker.body.slice(0, 80)}`;
}

function computePopupLeft(clientX: number, viewportWidth: number): number {
  const width = 320;
  const min = 12;
  const max = Math.max(min, viewportWidth - width - 12);
  return clamp(clientX - width / 2, min, max);
}

function computePopupTop(clientY: number, viewportHeight: number): number {
  const height = 260;
  const spacing = 12;
  const preferTop = clientY + spacing;
  if (preferTop + height <= viewportHeight - spacing) {
    return preferTop;
  }
  return clamp(clientY - height - spacing, spacing, Math.max(spacing, viewportHeight - height - spacing));
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function queryRequired<T extends Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector(selector);
  if (!node) {
    throw new Error(`Agentation shell missing node: ${selector}`);
  }
  return node as T;
}

const SHELL_TEMPLATE = `
  <style>
    .pc-agent-root {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    .pc-agent-toolbar {
      position: fixed;
      right: 20px;
      bottom: 20px;
      width: 304px;
      background: #1a1a1a;
      color: #fff;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
      padding: 8px 10px;
      display: flex;
      align-items: center;
      gap: 10px;
      pointer-events: auto;
    }

    .pc-agent-toolbar-toggle {
      width: 88px;
      height: 30px;
      border: 0;
      border-radius: 999px;
      background: #0088ff;
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.15s ease, background 0.15s ease;
    }

    .pc-agent-toolbar-toggle[data-active="true"] {
      background: #34c759;
    }

    .pc-agent-toolbar-toggle:hover {
      transform: translateY(-1px);
    }

    .pc-agent-toolbar-hint {
      display: block;
      line-height: 1.35;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.72);
      flex: 1;
      min-width: 0;
    }

    .pc-agent-hover-box {
      position: fixed;
      box-sizing: border-box;
      border: 2px solid rgba(0, 136, 255, 0.95);
      background: rgba(0, 136, 255, 0.08);
      border-radius: 4px;
      pointer-events: none;
    }

    .pc-agent-hover-box::before {
      content: attr(data-label);
      position: absolute;
      left: 0;
      top: -24px;
      max-width: min(60vw, 520px);
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(0, 136, 255, 0.96);
      color: #fff;
      font-size: 11px;
      line-height: 18px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .pc-agent-marker-layer {
      position: fixed;
      inset: 0;
      pointer-events: none;
    }

    .pc-agent-marker {
      position: fixed;
      width: 22px;
      height: 22px;
      border: 0;
      border-radius: 50%;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      transform: translate(-50%, -50%);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
      cursor: pointer;
      pointer-events: auto;
    }

    .pc-agent-marker-tooltip {
      position: absolute;
      left: 50%;
      top: calc(100% + 8px);
      transform: translateX(-50%);
      min-width: 120px;
      max-width: 260px;
      border-radius: 10px;
      background: #1a1a1a;
      color: rgba(255, 255, 255, 0.92);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
      font-size: 12px;
      line-height: 1.4;
      padding: 6px 8px;
      white-space: normal;
      text-align: left;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s ease;
    }

    .pc-agent-marker:hover .pc-agent-marker-tooltip {
      opacity: 1;
    }

    .pc-agent-popup {
      position: fixed;
      width: 320px;
      box-sizing: border-box;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 16px;
      background: #1a1a1a;
      box-shadow: 0 14px 32px rgba(0, 0, 0, 0.38);
      padding: 12px;
      color: #fff;
      pointer-events: auto;
    }

    .pc-agent-popup[hidden] {
      display: none;
    }

    .pc-agent-popup-title {
      margin: 0 0 8px 0;
      font-size: 12px;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.92);
    }

    .pc-agent-popup-target,
    .pc-agent-popup-selection {
      margin: 0 0 8px 0;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.74);
      font-size: 12px;
      line-height: 1.4;
      padding: 6px 8px;
      max-height: 72px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .pc-agent-popup-label {
      display: block;
      margin: 8px 0 4px;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.75);
    }

    .pc-agent-popup-body,
    .pc-agent-popup-priority {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      font-size: 12px;
      padding: 8px;
    }

    .pc-agent-popup-body {
      min-height: 80px;
      resize: vertical;
    }

    .pc-agent-popup-actions {
      margin-top: 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .pc-agent-popup-btn {
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.04);
      color: rgba(255, 255, 255, 0.88);
      cursor: pointer;
      font-size: 12px;
      padding: 6px 12px;
    }

    .pc-agent-popup-btn.primary {
      border-color: #0088ff;
      background: #0088ff;
      color: #fff;
      font-weight: 600;
    }

    .pc-agent-popup-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .pc-agent-popup-status {
      margin: 8px 0 0;
      min-height: 16px;
      font-size: 12px;
      line-height: 1.3;
    }

    .pc-agent-popup-status.info { color: rgba(255, 255, 255, 0.62); }
    .pc-agent-popup-status.success { color: #34c759; }
    .pc-agent-popup-status.error { color: #ff7b7b; }
  </style>
  <div class="pc-agent-root">
    <div class="pc-agent-marker-layer" data-marker-layer></div>
    <div class="pc-agent-hover-box" data-hover-box hidden></div>

    <div class="pc-agent-toolbar">
      <button type="button" class="pc-agent-toolbar-toggle" data-active="false" data-toolbar-toggle>UI 标注</button>
      <span class="pc-agent-toolbar-hint" data-toolbar-hint>开启后，点击页面元素创建反馈。</span>
    </div>

    <form class="pc-agent-popup" data-popup hidden>
      <p class="pc-agent-popup-title">Create Annotation</p>
      <p class="pc-agent-popup-target" data-popup-target>unknown target</p>

      <label class="pc-agent-popup-label">当前选中文本</label>
      <p class="pc-agent-popup-selection" data-popup-selection>未检测到页面选中内容</p>

      <label class="pc-agent-popup-label" for="pc-agent-popup-body">反馈内容</label>
      <textarea id="pc-agent-popup-body" class="pc-agent-popup-body" data-popup-body maxlength="2000" placeholder="描述问题或建议"></textarea>

      <label class="pc-agent-popup-label" for="pc-agent-popup-priority">优先级</label>
      <select id="pc-agent-popup-priority" class="pc-agent-popup-priority" data-popup-priority>
        <option value="low">low</option>
        <option value="normal" selected>normal</option>
        <option value="high">high</option>
        <option value="critical">critical</option>
      </select>

      <div class="pc-agent-popup-actions">
        <button type="button" class="pc-agent-popup-btn" data-popup-cancel>取消</button>
        <button type="submit" class="pc-agent-popup-btn primary" data-popup-submit>提交</button>
      </div>
      <p class="pc-agent-popup-status info" data-popup-status>Idle</p>
    </form>
  </div>
`;
