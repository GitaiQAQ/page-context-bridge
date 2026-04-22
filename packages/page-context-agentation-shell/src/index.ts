import type { FeedbackAnnotation, FeedbackAnnotationStatus, FeedbackPriority, FeedbackUiAnchor, FeedbackUiRect } from "@page-context/shared-protocol";

import { extractElementContextMeta, extractReactAnchorMeta, identifyElement } from "./element-identification";
import type {
  AgentationShellBridgeAdapter,
  AgentationShellCreateAnnotationInput,
  AgentationShellCreateAnnotationResult,
  AgentationShellFeedbackDelta,
  AgentationShellFeedbackSnapshot,
  AgentationShellDeps,
  AgentationShellDismissAnnotationInput,
  AgentationShellMultiSelectItem,
  AgentationShellMultiSelectMeta,
  AgentationShellUpdateAnnotationInput,
} from "./types";
export type {
  AgentationShellBridgeAdapter,
  AgentationShellCreateAnnotationInput,
  AgentationShellCreateAnnotationResult,
  AgentationShellFeedbackDelta,
  AgentationShellFeedbackSnapshot,
  AgentationShellDeps,
  AgentationShellDismissAnnotationInput,
  AgentationShellMultiSelectItem,
  AgentationShellMultiSelectMeta,
  AgentationShellUpdateAnnotationInput,
} from "./types";

const AGENTATION_SHELL_HOST_ID = "__page_context_agentation_shell_host__";
const TOOLBAR_STATE_STORAGE_KEY = "__page_context_agentation_shell_toolbar_state_v1__";
const TOOLBAR_STATE_VERSION = 1;
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);
const PRIORITY_ORDER: FeedbackPriority[] = ["low", "normal", "high", "critical"];
const DRAG_SELECTION_THRESHOLD_PX = 6;
const AREA_SELECTION_MIN_SIZE_PX = 20;
const DEFAULT_ANNOTATING_HINT = "点击页面元素打开标注弹窗，Cmd/Ctrl+Shift+Click 可多选，Esc 可退出。";
const MARKER_DISMISS_REASON = "marker deleted from agentation shell";
const POPUP_ENTER_DURATION_MS = 120;
const POPUP_EXIT_DURATION_MS = 140;
const POPUP_SHAKE_DURATION_MS = 280;
const AREA_SELECTION_ELEMENT_SELECTOR = "button, a, input, img, p, h1, h2, h3, h4, h5, h6, li, label, td, th";
const DRAG_SELECTION_TEXT_TAGS = new Set([
  "P",
  "SPAN",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "TD",
  "TH",
  "LABEL",
  "BLOCKQUOTE",
  "FIGCAPTION",
  "CAPTION",
  "LEGEND",
  "DT",
  "DD",
  "PRE",
  "CODE",
  "EM",
  "STRONG",
  "B",
  "I",
  "U",
  "S",
  "A",
  "TIME",
  "ADDRESS",
  "CITE",
  "Q",
  "ABBR",
  "DFN",
  "MARK",
  "SMALL",
  "SUB",
  "SUP",
]);
const NON_REPLAYABLE_ANNOTATION_STATUS = new Set<FeedbackAnnotationStatus>(["resolved", "dismissed"]);

interface MarkerRecord {
  id: string;
  remoteAnnotationId?: string;
  body: string;
  priority: FeedbackPriority;
  selectedText?: string;
  elementName: string;
  targetInput: AgentationShellCreateAnnotationInput["target"];
  x: number;
  y: number;
}

interface PopupState {
  mode: "create" | "edit";
  editMarkerId?: string;
  returnFocusElement?: HTMLElement;
  anchorX: number;
  anchorY: number;
  initialBody?: string;
  initialPriority?: FeedbackPriority;
  selectedText?: string;
  targetElement?: HTMLElement;
  targetInput: AgentationShellCreateAnnotationInput["target"];
  multiSelectMeta?: AgentationShellMultiSelectMeta;
}

interface MultiSelectTargetSnapshot {
  element: HTMLElement;
  elementName: string;
  elementPath: string;
  rect: DOMRectReadOnly;
}

interface Point {
  x: number;
  y: number;
}

interface ToolbarPosition {
  left: number;
  top: number;
}

interface ToolbarDragState {
  source: "toolbar" | "dock";
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startLeft: number;
  startTop: number;
  moved: boolean;
}

interface ToolbarPersistedState {
  version: typeof TOOLBAR_STATE_VERSION;
  hidden: boolean;
  left: number;
  top: number;
}

interface ReplayMarkerTarget {
  anchorX: number;
  anchorY: number;
  elementName: string;
  targetInput: AgentationShellCreateAnnotationInput["target"];
}

interface FeedbackDeltaPlan {
  dismissedAnnotationIds: Set<string>;
  shouldReloadSnapshot: boolean;
  eventCount: number;
}

interface MarkerTooltipPlacement {
  horizontal: "left" | "center" | "right";
  vertical: "top" | "bottom";
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

  private readonly toolbar: HTMLDivElement;
  private readonly toolbarToggle: HTMLButtonElement;
  private readonly toolbarHint: HTMLSpanElement;
  private readonly toolbarDragHandle: HTMLButtonElement;
  private readonly toolbarHideButton: HTMLButtonElement;
  private readonly toolbarDock: HTMLButtonElement;
  private readonly hoverBox: HTMLDivElement;
  private readonly dragSelectionBox: HTMLDivElement;
  private readonly markerLayer: HTMLDivElement;
  private readonly popupForm: HTMLFormElement;
  private readonly popupTitleView: HTMLParagraphElement;
  private readonly popupTargetView: HTMLParagraphElement;
  private readonly popupSelectionLabel: HTMLLabelElement;
  private readonly popupSelectionView: HTMLParagraphElement;
  private readonly popupBodyInput: HTMLTextAreaElement;
  private readonly popupPrioritySelect: HTMLSelectElement;
  private readonly popupStatusView: HTMLParagraphElement;
  private readonly popupDeleteButton: HTMLButtonElement;
  private readonly popupCancelButton: HTMLButtonElement;
  private readonly popupSubmitButton: HTMLButtonElement;
  private readonly markerContextMenu: HTMLDivElement;
  private readonly markerContextMenuDeleteButton: HTMLButtonElement;

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
  private dragSelectionMouseDownPoint: Point | null = null;
  private dragSelectionStartPoint: Point | null = null;
  private dragSelecting = false;
  private suppressClickOnceAfterDrag = false;
  private toolbarHidden = false;
  private toolbarPosition: ToolbarPosition | null = null;
  private toolbarDragState: ToolbarDragState | null = null;
  private toolbarDockClickBlocked = false;
  private feedbackSnapshotSyncInFlight: Promise<void> | null = null;
  private feedbackDeltaSyncInFlight: Promise<void> | null = null;
  private popupReturnFocusTarget: HTMLElement | null = null;
  private popupClosing = false;
  private popupEnterTimerId: number | null = null;
  private popupExitTimerId: number | null = null;
  private popupShakeTimerId: number | null = null;
  private markerContextMenuMarkerId: string | null = null;
  private markerContextMenuListening = false;

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

    this.toolbar = queryRequired<HTMLDivElement>(this.shadow, "[data-toolbar]");
    this.toolbarToggle = queryRequired<HTMLButtonElement>(this.shadow, "[data-toolbar-toggle]");
    this.toolbarHint = queryRequired<HTMLSpanElement>(this.shadow, "[data-toolbar-hint]");
    this.toolbarDragHandle = queryRequired<HTMLButtonElement>(this.shadow, "[data-toolbar-drag]");
    this.toolbarHideButton = queryRequired<HTMLButtonElement>(this.shadow, "[data-toolbar-hide]");
    this.toolbarDock = queryRequired<HTMLButtonElement>(this.shadow, "[data-toolbar-dock]");
    this.hoverBox = queryRequired<HTMLDivElement>(this.shadow, "[data-hover-box]");
    this.dragSelectionBox = queryRequired<HTMLDivElement>(this.shadow, "[data-drag-selection]");
    this.markerLayer = queryRequired<HTMLDivElement>(this.shadow, "[data-marker-layer]");
    this.popupForm = queryRequired<HTMLFormElement>(this.shadow, "[data-popup]");
    this.popupTitleView = queryRequired<HTMLParagraphElement>(this.shadow, "[data-popup-title]");
    this.popupTargetView = queryRequired<HTMLParagraphElement>(this.shadow, "[data-popup-target]");
    this.popupSelectionLabel = queryRequired<HTMLLabelElement>(this.shadow, "[data-popup-selection-label]");
    this.popupSelectionView = queryRequired<HTMLParagraphElement>(this.shadow, "[data-popup-selection]");
    this.popupBodyInput = queryRequired<HTMLTextAreaElement>(this.shadow, "[data-popup-body]");
    this.popupPrioritySelect = queryRequired<HTMLSelectElement>(this.shadow, "[data-popup-priority]");
    this.popupStatusView = queryRequired<HTMLParagraphElement>(this.shadow, "[data-popup-status]");
    this.popupDeleteButton = queryRequired<HTMLButtonElement>(this.shadow, "[data-popup-delete]");
    this.popupCancelButton = queryRequired<HTMLButtonElement>(this.shadow, "[data-popup-cancel]");
    this.popupSubmitButton = queryRequired<HTMLButtonElement>(this.shadow, "[data-popup-submit]");
    this.markerContextMenu = queryRequired<HTMLDivElement>(this.shadow, "[data-marker-context-menu]");
    this.markerContextMenuDeleteButton = queryRequired<HTMLButtonElement>(this.shadow, "[data-marker-context-menu-delete]");
  }

  mount(): void {
    this.doc.body.appendChild(this.host);
    this.restoreToolbarStateFromStorage();
    if (this.toolbarPosition) {
      this.syncToolbarVisibility();
    } else {
      this.captureToolbarPositionFromLayout();
    }
    this.toolbarToggle.addEventListener("click", this.onToolbarToggleClick);
    this.toolbarDragHandle.addEventListener("pointerdown", this.onToolbarDragPointerDown);
    this.toolbarHideButton.addEventListener("click", this.onToolbarHideClick);
    this.toolbarDock.addEventListener("pointerdown", this.onToolbarDockPointerDown);
    this.toolbarDock.addEventListener("click", this.onToolbarDockClick);
    this.popupDeleteButton.addEventListener("click", this.onPopupDeleteClick);
    this.popupCancelButton.addEventListener("click", this.onPopupCancelClick);
    this.popupForm.addEventListener("keydown", this.onPopupKeyDown);
    this.popupForm.addEventListener("submit", this.onPopupSubmit);
    this.popupBodyInput.addEventListener("input", this.onPopupBodyInput);
    this.popupPrioritySelect.addEventListener("change", this.onPriorityChange);
    this.markerContextMenuDeleteButton.addEventListener("click", this.onMarkerContextMenuDeleteClick);
    this.win.addEventListener("resize", this.onWindowResize, true);
    this.bootstrapFeedbackReplay();
  }

  /**
   * 初始化后主动拉一次 snapshot，把历史 annotation 回放成 marker。
   */
  private bootstrapFeedbackReplay(): void {
    if (!this.adapter.getFeedbackSnapshot) {
      return;
    }
    // 先回放全量，再补一轮增量，兜住 snapshot 拉取窗口内的事件竞态。
    void this.syncMarkersFromFeedbackSnapshot().then(() => this.syncMarkersFromFeedbackDelta());
  }

  /**
   * snapshot 是壳体状态的权威来源：刷新后的回放统一走这里。
   */
  private async syncMarkersFromFeedbackSnapshot(): Promise<void> {
    if (!this.adapter.getFeedbackSnapshot) {
      return;
    }
    if (this.feedbackSnapshotSyncInFlight) {
      await this.feedbackSnapshotSyncInFlight;
      return;
    }

    const task = (async () => {
      const snapshot = await this.adapter.getFeedbackSnapshot!();
      this.reconcileMarkersFromFeedbackSnapshot(snapshot);
      this.log("debug", "Agentation shell feedback snapshot replay completed", {
        annotationCount: snapshot.annotations.length,
        snapshotVersion: snapshot.snapshotVersion,
      });
    })().catch((error) => {
      this.log("error", "Agentation shell feedback snapshot replay failed", error);
    });

    this.feedbackSnapshotSyncInFlight = task.finally(() => {
      this.feedbackSnapshotSyncInFlight = null;
    });
    await this.feedbackSnapshotSyncInFlight;
  }

  /**
   * 最小 delta fallback：
   * - dismissed 且有 annotationId：直接删 marker
   * - 其他 annotation 事件：回退触发一次 snapshot reload
   */
  private async syncMarkersFromFeedbackDelta(): Promise<void> {
    if (!this.adapter.getFeedbackStateDelta) {
      return;
    }
    if (this.feedbackDeltaSyncInFlight) {
      await this.feedbackDeltaSyncInFlight;
      return;
    }

    const task = (async () => {
      const delta = await this.adapter.getFeedbackStateDelta!();
      const plan = buildFeedbackDeltaPlan(delta);
      const removedCount = this.deleteMarkersByRemoteAnnotationIds(plan.dismissedAnnotationIds);

      let snapshotReloaded = false;
      if (plan.shouldReloadSnapshot && this.adapter.getFeedbackSnapshot) {
        snapshotReloaded = true;
        await this.syncMarkersFromFeedbackSnapshot();
      }

      this.log("debug", "Agentation shell feedback delta sync completed", {
        eventCount: plan.eventCount,
        removedCount,
        snapshotReloaded,
        lastSeq: delta.lastSeq,
      });
    })().catch((error) => {
      this.log("error", "Agentation shell feedback delta sync failed", error);
    });

    this.feedbackDeltaSyncInFlight = task.finally(() => {
      this.feedbackDeltaSyncInFlight = null;
    });
    await this.feedbackDeltaSyncInFlight;
  }

  private triggerFeedbackDeltaSync(): void {
    void this.syncMarkersFromFeedbackDelta();
  }

  /**
   * 只覆盖远端 marker；本地临时 marker（无 remote id）继续保留，避免打断当前操作。
   */
  private reconcileMarkersFromFeedbackSnapshot(snapshot: AgentationShellFeedbackSnapshot): void {
    const replayedByRemoteId = new Map<string, MarkerRecord>();
    for (const annotation of snapshot.annotations) {
      if (!isReplayableFeedbackAnnotation(annotation)) {
        continue;
      }
      const marker = this.buildMarkerFromFeedbackAnnotation(annotation);
      if (!marker) {
        continue;
      }
      replayedByRemoteId.set(annotation.id, marker);
    }

    const nextMarkers: MarkerRecord[] = [];
    for (const marker of this.markers) {
      if (!marker.remoteAnnotationId) {
        nextMarkers.push(marker);
        continue;
      }
      const replayed = replayedByRemoteId.get(marker.remoteAnnotationId);
      if (!replayed) {
        continue;
      }
      replayedByRemoteId.delete(marker.remoteAnnotationId);
      nextMarkers.push({
        ...marker,
        body: replayed.body,
        priority: replayed.priority,
        selectedText: replayed.selectedText,
        elementName: replayed.elementName,
        targetInput: replayed.targetInput,
        x: replayed.x,
        y: replayed.y,
      });
    }
    for (const marker of replayedByRemoteId.values()) {
      nextMarkers.push(marker);
    }

    this.markers.splice(0, this.markers.length, ...nextMarkers);
    if (this.popupState?.mode === "edit" && this.popupState.editMarkerId) {
      const markerExists = this.markers.some((marker) => marker.id === this.popupState?.editMarkerId);
      if (!markerExists) {
        this.closePopup();
      }
    }
    this.renderMarkers();
  }

  /**
   * 回放目标优先用 uiAnchor 里可结构化字段；
   * 缺失时回退到 selector 现场定位，保证最小可用。
   */
  private buildMarkerFromFeedbackAnnotation(annotation: FeedbackAnnotation): MarkerRecord | null {
    const replayTarget = resolveReplayMarkerTarget(annotation, this.doc, this.host, this.win.innerWidth, this.win.innerHeight);
    if (!replayTarget) {
      this.log("debug", "Skip replay annotation because uiAnchor target is unavailable", {
        annotationId: annotation.id,
      });
      return null;
    }

    const selectedText = normalizeSelectionText(annotation.target.textQuote ?? annotation.target.uiAnchor?.textQuote ?? "");
    return {
      id: annotation.id,
      remoteAnnotationId: annotation.id,
      body: annotation.body,
      priority: normalizePriority(annotation.priority),
      selectedText: selectedText || undefined,
      elementName: replayTarget.elementName,
      targetInput: replayTarget.targetInput,
      x: replayTarget.anchorX,
      y: replayTarget.anchorY,
    };
  }

  private readonly onToolbarToggleClick = (): void => {
    if (this.annotating) {
      this.stopAnnotating();
      return;
    }
    this.startAnnotating();
  };

  private readonly onToolbarHideClick = (event: MouseEvent): void => {
    event.preventDefault();
    this.closeMarkerContextMenu();

    // 隐藏时先退出标注态，避免页面继续被透明层接管却没有可见入口。
    if (this.annotating) {
      this.stopAnnotating();
    }
    this.toolbarHidden = true;
    this.syncToolbarVisibility();
    this.persistToolbarState();
  };

  private readonly onToolbarDockClick = (event: MouseEvent): void => {
    if (this.toolbarDockClickBlocked) {
      this.toolbarDockClickBlocked = false;
      event.preventDefault();
      return;
    }
    event.preventDefault();
    this.closeMarkerContextMenu();
    this.toolbarHidden = false;
    this.syncToolbarVisibility();
    this.persistToolbarState();
  };

  private readonly onToolbarDragPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();

    if (!this.toolbarPosition) {
      this.captureToolbarPositionFromLayout();
    }
    if (!this.toolbarPosition) {
      return;
    }

    this.toolbarDragState = {
      source: "toolbar",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLeft: this.toolbarPosition.left,
      startTop: this.toolbarPosition.top,
      moved: false,
    };
    this.toolbar.dataset.dragging = "true";
    this.toolbarDragHandle.setPointerCapture?.(event.pointerId);
    this.win.addEventListener("pointermove", this.onToolbarDragPointerMove, true);
    this.win.addEventListener("pointerup", this.onToolbarDragPointerEnd, true);
    this.win.addEventListener("pointercancel", this.onToolbarDragPointerEnd, true);
  };

  private readonly onToolbarDockPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();

    if (!this.toolbarHidden) {
      return;
    }
    if (!this.toolbarPosition) {
      this.captureToolbarPositionFromLayout();
    }
    if (!this.toolbarPosition) {
      return;
    }

    this.toolbarDragState = {
      source: "dock",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLeft: this.toolbarPosition.left,
      startTop: this.toolbarPosition.top,
      moved: false,
    };
    this.toolbarDock.dataset.dragging = "true";
    this.toolbarDock.setPointerCapture?.(event.pointerId);
    this.win.addEventListener("pointermove", this.onToolbarDragPointerMove, true);
    this.win.addEventListener("pointerup", this.onToolbarDragPointerEnd, true);
    this.win.addEventListener("pointercancel", this.onToolbarDragPointerEnd, true);
  };

  private readonly onToolbarDragPointerMove = (event: PointerEvent): void => {
    if (!this.toolbarDragState || event.pointerId !== this.toolbarDragState.pointerId) {
      return;
    }

    const deltaX = event.clientX - this.toolbarDragState.startClientX;
    const deltaY = event.clientY - this.toolbarDragState.startClientY;
    if (!this.toolbarDragState.moved && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
      this.toolbarDragState.moved = true;
    }

    const nextLeft = this.toolbarDragState.startLeft + deltaX;
    const nextTop = this.toolbarDragState.startTop + deltaY;
    this.setToolbarPosition(nextLeft, nextTop);
  };

  private readonly onToolbarDragPointerEnd = (event: PointerEvent): void => {
    if (!this.toolbarDragState || event.pointerId !== this.toolbarDragState.pointerId) {
      return;
    }
    this.stopToolbarDrag();
  };

  private readonly onWindowResize = (): void => {
    this.closeMarkerContextMenu();
    this.syncToolbarVisibility();
    this.persistToolbarState();
  };

  private startAnnotating(): void {
    this.annotating = true;
    this.toolbar.dataset.annotating = "true";
    this.toolbarToggle.dataset.active = "true";
    this.toolbarToggle.textContent = "标注中";
    this.toolbarHint.textContent = DEFAULT_ANNOTATING_HINT;
    this.doc.addEventListener("pointermove", this.onDocumentPointerMove, true);
    this.doc.addEventListener("mousedown", this.onDocumentMouseDown, true);
    this.doc.addEventListener("mousemove", this.onDocumentMouseMove, true);
    this.doc.addEventListener("mouseup", this.onDocumentMouseUp, true);
    this.doc.addEventListener("click", this.onDocumentClick, true);
    this.doc.addEventListener("keydown", this.onDocumentKeyDown, true);
    this.doc.addEventListener("keyup", this.onDocumentKeyUp, true);
    this.win.addEventListener("scroll", this.onWindowScroll, true);
    this.win.addEventListener("blur", this.onWindowBlur, true);
  }

  private stopAnnotating(): void {
    this.annotating = false;
    this.toolbar.dataset.annotating = "false";
    this.toolbarToggle.dataset.active = "false";
    this.toolbarToggle.textContent = "UI 标注";
    this.toolbarHint.textContent = "开启后，点击页面元素创建反馈。";
    this.doc.removeEventListener("pointermove", this.onDocumentPointerMove, true);
    this.doc.removeEventListener("mousedown", this.onDocumentMouseDown, true);
    this.doc.removeEventListener("mousemove", this.onDocumentMouseMove, true);
    this.doc.removeEventListener("mouseup", this.onDocumentMouseUp, true);
    this.doc.removeEventListener("click", this.onDocumentClick, true);
    this.doc.removeEventListener("keydown", this.onDocumentKeyDown, true);
    this.doc.removeEventListener("keyup", this.onDocumentKeyUp, true);
    this.win.removeEventListener("scroll", this.onWindowScroll, true);
    this.win.removeEventListener("blur", this.onWindowBlur, true);
    this.hoveredElement = null;
    this.hoveredElementLabel = "";
    this.resetDragSelectionState();
    this.clearMultiSelectTargets();
    this.hideHoverBox();
    this.closeMarkerContextMenu();
    this.closePopup();
  }

  private captureToolbarPositionFromLayout(): void {
    const rect = this.toolbar.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      return;
    }
    this.toolbarPosition = {
      left: rect.left,
      top: rect.top,
    };
    this.syncToolbarVisibility();
  }

  private restoreToolbarStateFromStorage(): void {
    // 刷新后优先恢复上次状态；无有效数据再走布局兜底。
    const state = readToolbarPersistedState(this.win);
    if (!state) {
      return;
    }
    this.toolbarHidden = state.hidden;
    this.toolbarPosition = {
      left: state.left,
      top: state.top,
    };
  }

  private persistToolbarState(): void {
    // 仅在已有定位坐标时写盘，避免写入半状态数据。
    if (!this.toolbarPosition) {
      return;
    }
    writeToolbarPersistedState(this.win, {
      version: TOOLBAR_STATE_VERSION,
      hidden: this.toolbarHidden,
      left: this.toolbarPosition.left,
      top: this.toolbarPosition.top,
    });
  }

  private setToolbarPosition(left: number, top: number): void {
    const floatingBox = this.toolbarHidden ? this.toolbarDock : this.toolbar;
    const rect = floatingBox.getBoundingClientRect();
    const width = rect.width || 96;
    const height = rect.height || 40;

    // 始终给页面留出一点边距，避免拖到视口外后用户无法再点回来。
    this.toolbarPosition = {
      left: clamp(left, 12, Math.max(12, this.win.innerWidth - width - 12)),
      top: clamp(top, 12, Math.max(12, this.win.innerHeight - height - 12)),
    };
    this.applyToolbarPosition();
  }

  private applyToolbarPosition(): void {
    if (!this.toolbarPosition) {
      return;
    }

    const { left, top } = this.toolbarPosition;
    this.toolbar.style.left = `${left}px`;
    this.toolbar.style.top = `${top}px`;
    this.toolbar.style.right = "auto";
    this.toolbar.style.bottom = "auto";

    this.toolbarDock.style.left = `${left}px`;
    this.toolbarDock.style.top = `${top}px`;
    this.toolbarDock.style.right = "auto";
    this.toolbarDock.style.bottom = "auto";
  }

  private syncToolbarVisibility(): void {
    this.toolbar.hidden = this.toolbarHidden;
    this.toolbarDock.hidden = !this.toolbarHidden;
    if (this.toolbarPosition) {
      const basePosition = this.toolbarPosition;
      this.toolbarPosition = null;
      this.setToolbarPosition(basePosition.left, basePosition.top);
      return;
    }
    this.applyToolbarPosition();
  }

  private stopToolbarDrag(): void {
    const dragState = this.toolbarDragState;
    const pointerId = dragState?.pointerId;
    this.toolbarDragState = null;
    delete this.toolbar.dataset.dragging;
    delete this.toolbarDock.dataset.dragging;
    if (pointerId !== undefined) {
      if (dragState?.source === "toolbar") {
        this.toolbarDragHandle.releasePointerCapture?.(pointerId);
      } else {
        this.toolbarDock.releasePointerCapture?.(pointerId);
      }
    }

    // dock 上拖动结束后，屏蔽紧随其后的 click，避免“刚挪完就自动打开”。
    if (dragState?.source === "dock" && dragState.moved) {
      this.toolbarDockClickBlocked = true;
    }
    this.persistToolbarState();
    this.win.removeEventListener("pointermove", this.onToolbarDragPointerMove, true);
    this.win.removeEventListener("pointerup", this.onToolbarDragPointerEnd, true);
    this.win.removeEventListener("pointercancel", this.onToolbarDragPointerEnd, true);
  }

  private readonly onDocumentMouseDown = (event: MouseEvent): void => {
    if (!this.annotating || this.isEventFromShell(event)) {
      return;
    }
    if (event.button !== 0 || isMultiSelectChordPressed(event)) {
      return;
    }

    const target = resolveEventTargetElement(event);
    if (!target || this.isNodeInsideShell(target) || shouldSkipDragSelectionStart(target)) {
      return;
    }

    // 进入拖框候选态后先阻止默认行为，避免页面文本被误选中。
    event.preventDefault();
    this.dragSelectionMouseDownPoint = {
      x: event.clientX,
      y: event.clientY,
    };
    this.dragSelectionStartPoint = null;
    this.dragSelecting = false;
    this.suppressClickOnceAfterDrag = false;
  };

  private readonly onDocumentMouseMove = (event: MouseEvent): void => {
    if (!this.annotating || !this.dragSelectionMouseDownPoint) {
      return;
    }

    const thresholdSq = DRAG_SELECTION_THRESHOLD_PX * DRAG_SELECTION_THRESHOLD_PX;
    const deltaX = event.clientX - this.dragSelectionMouseDownPoint.x;
    const deltaY = event.clientY - this.dragSelectionMouseDownPoint.y;
    const distanceSq = deltaX * deltaX + deltaY * deltaY;

    if (!this.dragSelecting && distanceSq < thresholdSq) {
      return;
    }

    if (!this.dragSelecting) {
      this.dragSelecting = true;
      this.dragSelectionStartPoint = {
        x: this.dragSelectionMouseDownPoint.x,
        y: this.dragSelectionMouseDownPoint.y,
      };

      // 拖框是独立选择模式，开始时清理其他临时态，避免状态重叠。
      this.hideHoverBox();
      this.clearMultiSelectTargets();
      if (!this.popupForm.hidden) {
        this.closePopup();
      }
      this.toolbarHint.textContent = "拖框中，松开鼠标后创建统一反馈。";
    }

    if (!this.dragSelectionStartPoint) {
      return;
    }

    event.preventDefault();
    const rect = buildSelectionRect(
      this.dragSelectionStartPoint,
      { x: event.clientX, y: event.clientY },
      this.win.innerWidth,
      this.win.innerHeight,
    );
    if (!rect) {
      this.hideDragSelectionBox();
      return;
    }
    this.syncDragSelectionBox(rect);
  };

  private readonly onDocumentMouseUp = (event: MouseEvent): void => {
    if (!this.annotating || !this.dragSelectionMouseDownPoint) {
      return;
    }

    const dragStart = this.dragSelectionStartPoint;
    const dragged = this.dragSelecting;
    this.dragSelectionMouseDownPoint = null;
    this.dragSelectionStartPoint = null;
    this.dragSelecting = false;
    this.hideDragSelectionBox();

    if (!dragged || !dragStart) {
      return;
    }

    // 拖框完成后吞掉本次 mouseup/click，避免被单击链路误处理。
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.suppressClickOnceAfterDrag = true;

    const rect = buildSelectionRect(
      dragStart,
      { x: event.clientX, y: event.clientY },
      this.win.innerWidth,
      this.win.innerHeight,
    );
    if (!rect) {
      this.toolbarHint.textContent = DEFAULT_ANNOTATING_HINT;
      return;
    }
    if (rect.width < AREA_SELECTION_MIN_SIZE_PX || rect.height < AREA_SELECTION_MIN_SIZE_PX) {
      this.toolbarHint.textContent = DEFAULT_ANNOTATING_HINT;
      return;
    }

    this.openPopupForAreaSelection(rect, event.clientX, event.clientY);
  };

  private readonly onWindowBlur = (): void => {
    if (!this.annotating) {
      return;
    }

    // 失焦时统一回收临时态，避免“按键已松开但内部状态还挂着”。
    this.resetDragSelectionState();
    this.clearMultiSelectTargets();
  };

  private readonly onDocumentPointerMove = (event: PointerEvent): void => {
    if (!this.annotating || this.dragSelectionMouseDownPoint || this.isEventFromShell(event)) {
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
    if (this.submitting) {
      // 提交期间冻结页面点击，避免重复提交和页面误操作并发发生。
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }
    if (this.suppressClickOnceAfterDrag) {
      // 对齐参考实现：拖框收尾会跟一发 click，这里只消费一次。
      this.suppressClickOnceAfterDrag = false;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
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

    if (this.dragSelectionMouseDownPoint || this.dragSelecting) {
      event.preventDefault();
      event.stopPropagation();
      this.resetDragSelectionState();
      this.toolbarHint.textContent = DEFAULT_ANNOTATING_HINT;
      this.setPopupStatus("已取消拖框选择", "info");
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
    if (!this.popupForm.hidden && !this.popupClosing) {
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
    if (this.hoveredElement && this.annotating && !this.dragSelectionMouseDownPoint) {
      this.syncHoverBox(this.hoveredElement, this.hoveredElementLabel);
    }
  };

  private readonly onPopupCancelClick = (event: MouseEvent): void => {
    event.preventDefault();
    this.closeMarkerContextMenu();
    this.closePopup();
  };

  private readonly onPopupKeyDown = (event: KeyboardEvent): void => {
    // 逻辑关闭态（含 exit 过渡）不再消费按键，避免焦点链路被旧弹窗截断。
    if (this.popupForm.hidden || this.popupClosing || !this.popupState) {
      return;
    }

    if (event.key === "Tab") {
      const focusableElements = this.collectPopupFocusableElements();
      if (focusableElements.length === 0) {
        return;
      }
      const activeElement = this.resolvePopupActiveElement(event.target);
      const activeIndex = activeElement ? focusableElements.indexOf(activeElement) : -1;
      const nextIndex = event.shiftKey
        ? (activeIndex <= 0 ? focusableElements.length - 1 : activeIndex - 1)
        : (activeIndex < 0 || activeIndex >= focusableElements.length - 1 ? 0 : activeIndex + 1);
      // popup 内部循环焦点，避免 Tab 跳回页面导致键盘链路中断。
      event.preventDefault();
      event.stopPropagation();
      focusableElements[nextIndex].focus();
      return;
    }

    if (event.key === "Escape") {
      // 编辑弹窗内的 Esc 永远先收口弹窗，不让事件冒泡到页面。
      event.preventDefault();
      event.stopPropagation();
      if (!this.submitting) {
        this.closePopup();
      }
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    // 只在 textarea 内接管 Enter：Shift+Enter 继续换行，普通 Enter 提交。
    if (
      event.target instanceof HTMLTextAreaElement
      && !event.isComposing
      && !event.shiftKey
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (!this.submitting) {
        this.popupForm.requestSubmit();
      }
    }
  };

  private readonly onPopupDeleteClick = async (event: MouseEvent): Promise<void> => {
    event.preventDefault();
    this.closeMarkerContextMenu();
    if (this.submitting || !this.popupState || this.popupState.mode !== "edit") {
      return;
    }

    const markerId = this.popupState.editMarkerId;
    if (!markerId) {
      this.setPopupStatus("删除失败：找不到标注", "error");
      return;
    }

    const marker = this.findMarkerById(markerId);
    if (!marker) {
      this.setPopupStatus("删除失败：标注可能已被移除", "error");
      return;
    }

    this.submitting = true;
    this.syncPopupSubmittingState();
    this.setPopupStatus("正在删除...", "info");
    try {
      await this.dismissRemoteAnnotationIfNeeded(marker);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setPopupStatus(`删除失败: ${message}`, "error");
      this.log("error", "Agentation shell dismiss annotation failed", error);
      return;
    } finally {
      this.submitting = false;
      this.syncPopupSubmittingState();
    }

    if (!this.deleteMarkerById(markerId)) {
      this.setPopupStatus("删除失败：标注可能已被移除", "error");
      return;
    }
    this.setPopupStatus("反馈已删除", "success");
    this.closePopup();
    this.triggerFeedbackDeltaSync();
  };

  private readonly onMarkerContextMenuDeleteClick = async (event: MouseEvent): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    const markerId = this.markerContextMenuMarkerId;
    this.closeMarkerContextMenu();
    if (this.submitting || !markerId) {
      return;
    }

    const marker = this.findMarkerById(markerId);
    if (!marker) {
      this.setPopupStatus("删除失败：标注可能已被移除", "error");
      return;
    }

    this.submitting = true;
    this.syncPopupSubmittingState();
    this.setPopupStatus("正在删除...", "info");
    try {
      await this.dismissRemoteAnnotationIfNeeded(marker);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setPopupStatus(`删除失败: ${message}`, "error");
      this.log("error", "Agentation shell dismiss annotation failed from marker context menu", error);
      return;
    } finally {
      this.submitting = false;
      this.syncPopupSubmittingState();
    }

    if (!this.deleteMarkerById(markerId)) {
      this.setPopupStatus("删除失败：标注可能已被移除", "error");
      return;
    }
    if (this.popupState?.mode === "edit" && this.popupState.editMarkerId === markerId) {
      this.closePopup();
    }
    this.setPopupStatus("反馈已删除", "success");
    this.triggerFeedbackDeltaSync();
  };

  private readonly onMarkerContextMenuPointerDown = (event: PointerEvent): void => {
    if (this.markerContextMenu.hidden) {
      return;
    }
    if (event.composedPath().includes(this.markerContextMenu)) {
      return;
    }
    this.closeMarkerContextMenu();
  };

  private readonly onMarkerContextMenuKeyDown = (event: KeyboardEvent): void => {
    if (this.markerContextMenu.hidden) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeMarkerContextMenu();
      return;
    }
    if (event.key === "Tab") {
      // 菜单只有一个动作，Tab 不应把焦点送回页面。
      event.preventDefault();
      event.stopPropagation();
      this.markerContextMenuDeleteButton.focus();
    }
  };

  private readonly onMarkerContextMenuViewportChange = (): void => {
    if (this.markerContextMenu.hidden) {
      return;
    }
    // 视口变化时直接收起，避免菜单位置悬空。
    this.closeMarkerContextMenu();
  };

  private readonly onPriorityChange = (): void => {
    if (!isFeedbackPriority(this.popupPrioritySelect.value)) {
      this.popupPrioritySelect.value = "normal";
    }
  };

  private readonly onPopupBodyInput = (): void => {
    // 用户开始输入后立即撤销空内容强调，避免错误态残留干扰下一步编辑。
    if (this.popupBodyInput.value.trim().length > 0) {
      this.clearPopupValidationFeedback();
    }
  };

  private readonly onPopupSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (this.submitting || this.popupClosing || !this.popupState) {
      return;
    }
    const popupState = this.popupState;

    const body = this.popupBodyInput.value.trim();
    if (!body) {
      this.raisePopupBodyRequiredFeedback();
      return;
    }
    this.clearPopupValidationFeedback();

    const priority = normalizePriority(this.popupPrioritySelect.value);
    if (popupState.mode === "edit") {
      const markerId = popupState.editMarkerId;
      if (!markerId) {
        this.setPopupStatus("更新失败：找不到标注", "error");
        return;
      }

      const marker = this.findMarkerById(markerId);
      if (!marker) {
        this.setPopupStatus("更新失败：标注可能已被移除", "error");
        return;
      }

      this.submitting = true;
      this.syncPopupSubmittingState();
      this.setPopupStatus("正在更新...", "info");
      try {
        await this.updateRemoteAnnotationIfNeeded(marker, body, priority);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setPopupStatus(`更新失败: ${message}`, "error");
        this.log("error", "Agentation shell update annotation failed", error);
        return;
      } finally {
        this.submitting = false;
        this.syncPopupSubmittingState();
      }

      if (!this.updateMarkerById(markerId, body, priority)) {
        this.setPopupStatus("更新失败：标注可能已被移除", "error");
        return;
      }
      this.setPopupStatus("反馈已更新", "success");
      this.closePopup();
      this.triggerFeedbackDeltaSync();
      return;
    }

    const uiAnchor = buildUiAnchorFromTarget(
      popupState.targetInput,
      popupState.selectedText,
      {
        targetElement: popupState.targetElement,
        multiSelectMeta: popupState.multiSelectMeta,
      },
    );
    const payload: AgentationShellCreateAnnotationInput = {
      body,
      priority,
      selectedText: popupState.selectedText,
      uiAnchor,
      target: popupState.targetInput,
    };

    this.submitting = true;
    this.syncPopupSubmittingState();
    this.setPopupStatus("正在提交...", "info");

    try {
      const result = await this.adapter.createAnnotation(payload);
      this.applyAnnotationSuccess(result, payload, popupState);
      this.setPopupStatus("反馈已创建", "success");
      this.popupBodyInput.value = "";
      this.closePopup();
      this.triggerFeedbackDeltaSync();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setPopupStatus(`提交失败: ${message}`, "error");
      this.log("error", "Agentation shell create annotation failed", error);
    } finally {
      this.submitting = false;
      this.syncPopupSubmittingState();
    }
  };

  private findMarkerById(markerId: string): MarkerRecord | undefined {
    return this.markers.find((item) => item.id === markerId);
  }

  private async updateRemoteAnnotationIfNeeded(
    marker: MarkerRecord,
    body: string,
    priority: FeedbackPriority,
  ): Promise<void> {
    // 仅对有远端 ID 且 adapter 支持 update 的 marker 做同步，其余场景保持本地可用。
    if (!marker.remoteAnnotationId || !this.adapter.updateAnnotation) {
      return;
    }
    const payload: AgentationShellUpdateAnnotationInput = {
      annotationId: marker.remoteAnnotationId,
      body,
      priority,
    };
    await this.adapter.updateAnnotation(payload);
  }

  private async dismissRemoteAnnotationIfNeeded(marker: MarkerRecord): Promise<void> {
    // 删除优先走远端 dismiss，保证 bridge/server 能识别“已移除”。
    if (!marker.remoteAnnotationId || !this.adapter.dismissAnnotation) {
      return;
    }
    const payload: AgentationShellDismissAnnotationInput = {
      annotationId: marker.remoteAnnotationId,
      dismissReason: MARKER_DISMISS_REASON,
    };
    await this.adapter.dismissAnnotation(payload);
  }

  private updateMarkerById(markerId: string, body: string, priority: FeedbackPriority): boolean {
    const marker = this.findMarkerById(markerId);
    if (!marker) {
      return false;
    }
    marker.body = body;
    marker.priority = priority;
    this.renderMarkers();
    return true;
  }

  private deleteMarkerById(markerId: string): boolean {
    const markerIndex = this.markers.findIndex((item) => item.id === markerId);
    if (markerIndex < 0) {
      return false;
    }
    this.markers.splice(markerIndex, 1);
    this.renderMarkers();
    return true;
  }

  private deleteMarkersByRemoteAnnotationIds(annotationIds: ReadonlySet<string>): number {
    if (annotationIds.size === 0) {
      return 0;
    }

    const popupEditingMarkerId = this.popupState?.mode === "edit" ? this.popupState.editMarkerId : undefined;
    const beforeCount = this.markers.length;
    const remained = this.markers.filter((marker) => {
      if (!marker.remoteAnnotationId) {
        return true;
      }
      return !annotationIds.has(marker.remoteAnnotationId);
    });

    const removedCount = beforeCount - remained.length;
    if (removedCount < 1) {
      return 0;
    }

    this.markers.splice(0, this.markers.length, ...remained);
    if (popupEditingMarkerId && !this.markers.some((marker) => marker.id === popupEditingMarkerId)) {
      this.closePopup();
    }
    this.renderMarkers();
    return removedCount;
  }

  private applyAnnotationSuccess(
    result: AgentationShellCreateAnnotationResult,
    input: AgentationShellCreateAnnotationInput,
    popupState: PopupState,
  ): void {
    if (popupState.mode !== "create") {
      return;
    }
    const idFromResult = typeof result?.id === "string" ? result.id : "";
    const remoteAnnotationId = idFromResult.trim() || undefined;
    const markerId = remoteAnnotationId ?? `local-${Date.now()}-${this.markerIdSeq++}`;
    this.markers.push({
      id: markerId,
      remoteAnnotationId,
      body: input.body,
      priority: input.priority,
      selectedText: input.selectedText,
      elementName: input.target.elementName,
      targetInput: {
        elementName: input.target.elementName,
        elementPath: input.target.elementPath,
        rect: snapshotRect(input.target.rect),
      },
      x: popupState.anchorX,
      y: popupState.anchorY,
    });
    this.renderMarkers();
  }

  private renderMarkers(): void {
    this.closeMarkerContextMenu();
    this.markerLayer.innerHTML = "";
    this.markers.forEach((marker, index) => {
      const button = this.doc.createElement("button");
      button.type = "button";
      button.className = "pc-agent-marker";
      button.dataset.markerId = marker.id;
      button.style.left = `${marker.x}px`;
      button.style.top = `${marker.y}px`;
      button.style.background = markerColor(marker.priority);
      button.textContent = String(index + 1);
      button.setAttribute("aria-label", `annotation-marker-${index + 1}`);
      const tooltipPlacement = resolveMarkerTooltipPlacement(marker.x, marker.y, this.win.innerWidth, this.win.innerHeight);
      // 只在 marker 维度打标签，交给 CSS 控制 tooltip 摆位，避免引入额外动画状态。
      button.dataset.tooltipX = tooltipPlacement.horizontal;
      button.dataset.tooltipY = tooltipPlacement.vertical;
      // 仅补交互提示层：告诉用户 marker 点击会进入编辑，并可在弹窗删除。
      button.title = "点击编辑；弹窗内可删除";
      button.addEventListener("click", (event) => {
        // marker 点击只用于编辑，不应触发页面层点击逻辑。
        event.preventDefault();
        event.stopPropagation();
        this.closeMarkerContextMenu();
        this.openPopupForMarker(marker.id);
      });
      button.addEventListener("contextmenu", (event) => {
        // 右键提供快速删除入口；这里只弹上下文菜单，不直接删除。
        event.preventDefault();
        event.stopPropagation();
        const anchorX = event.clientX || marker.x;
        const anchorY = event.clientY || marker.y;
        this.openMarkerContextMenu(marker.id, anchorX, anchorY);
      });

      const affordance = this.doc.createElement("span");
      affordance.className = "pc-agent-marker-affordance";
      affordance.textContent = "编辑 / 删除";
      affordance.setAttribute("aria-hidden", "true");
      button.appendChild(affordance);

      const tooltip = this.doc.createElement("span");
      tooltip.className = "pc-agent-marker-tooltip";
      const tooltipQuote = this.doc.createElement("span");
      tooltipQuote.className = "pc-agent-marker-quote";
      tooltipQuote.textContent = buildMarkerTooltipQuote(marker);
      const tooltipNote = this.doc.createElement("span");
      tooltipNote.className = "pc-agent-marker-note";
      tooltipNote.textContent = buildMarkerTooltipNote(marker);
      tooltip.append(tooltipQuote, tooltipNote);
      button.appendChild(tooltip);

      this.markerLayer.appendChild(button);
    });
  }

  private openPopupForMarker(markerId: string): void {
    if (this.submitting) {
      return;
    }
    this.closeMarkerContextMenu();
    const marker = this.markers.find((item) => item.id === markerId);
    if (!marker) {
      return;
    }

    // 进入编辑态时统一清掉临时选择态，避免键盘事件误触发旧上下文。
    this.resetDragSelectionState();
    this.clearMultiSelectTargets();
    this.hideHoverBox();
    this.openPopupWithState({
      mode: "edit",
      editMarkerId: marker.id,
      returnFocusElement: this.doc.activeElement instanceof HTMLElement ? this.doc.activeElement : undefined,
      anchorX: marker.x,
      anchorY: marker.y,
      initialBody: marker.body,
      initialPriority: marker.priority,
      selectedText: marker.selectedText,
      targetInput: marker.targetInput,
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
      this.toolbarHint.textContent = DEFAULT_ANNOTATING_HINT;
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
      this.toolbarHint.textContent = DEFAULT_ANNOTATING_HINT;
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
      mode: "create",
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

  /**
   * 拖框完成后统一走这里：
   * 1) 命中元素 -> 多选聚合提交
   * 2) 未命中元素 -> 区域标注提交
   */
  private openPopupForAreaSelection(selectionRect: DOMRectReadOnly, clientX: number, clientY: number): void {
    const snapshots = collectAreaSelectionTargets(
      this.doc,
      this.host,
      selectionRect,
      this.win.innerWidth,
      this.win.innerHeight,
    );
    const selectedText = normalizeSelectionText(capturePageSelection(this.win, this.doc));

    if (snapshots.length > 0) {
      const unionRect = unionRects(snapshots.map((item) => item.rect));
      const unionUiRect = unionRect ? toUiRect(unionRect) : undefined;
      if (!unionRect || !unionUiRect) {
        this.toolbarHint.textContent = DEFAULT_ANNOTATING_HINT;
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
        this.toolbarHint.textContent = DEFAULT_ANNOTATING_HINT;
        return;
      }

      const first = snapshots[0];
      this.openPopupWithState({
        mode: "create",
        anchorX: clamp(clientX, 0, this.win.innerWidth),
        anchorY: clamp(clientY, 0, this.win.innerHeight),
        selectedText: selectedText || undefined,
        targetElement: first.element,
        targetInput: {
          elementName: `multi-select (${items.length})`,
          elementPath: "multi-select",
          rect: snapshotRect(unionRect),
        },
        multiSelectMeta: {
          count: items.length,
          unionRect: unionUiRect,
          items,
        },
      });
      this.toolbarHint.textContent = `框选命中 ${items.length} 个元素，已打开统一反馈框。`;
      this.setPopupStatus(`框选命中 ${items.length} 个元素`, "info");
      return;
    }

    const areaUiRect = toUiRect(selectionRect);
    if (!areaUiRect) {
      this.toolbarHint.textContent = DEFAULT_ANNOTATING_HINT;
      return;
    }

    const fallbackTarget = deepElementFromPoint(
      this.doc,
      selectionRect.left + selectionRect.width / 2,
      selectionRect.top + selectionRect.height / 2,
    );
    this.openPopupWithState({
      mode: "create",
      anchorX: clamp(clientX, 0, this.win.innerWidth),
      anchorY: clamp(clientY, 0, this.win.innerHeight),
      selectedText: selectedText || undefined,
      targetElement: fallbackTarget ?? undefined,
      targetInput: {
        elementName: "area-select",
        elementPath: `region at (${Math.round(selectionRect.left)}, ${Math.round(selectionRect.top)})`,
        rect: snapshotRect(selectionRect),
      },
      multiSelectMeta: {
        count: 0,
        unionRect: areaUiRect,
        items: [],
      },
    });
    this.toolbarHint.textContent = "已选择区域，填写反馈后可提交。";
    this.setPopupStatus("未命中可聚合元素，已按区域创建标注。", "info");
  }

  private openPopupForTarget(target: HTMLElement, clientX: number, clientY: number): void {
    const elementInfo = identifyElement(target);
    const selectedText = normalizeSelectionText(capturePageSelection(this.win, this.doc));
    this.openPopupWithState({
      mode: "create",
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
    this.closeMarkerContextMenu();
    // 若上一次在做 exit 过渡，先中止收尾定时器，避免新弹窗被旧任务误隐藏。
    this.cancelPopupExitIfNeeded();
    this.clearPopupValidationFeedback();
    this.popupState = state;
    this.popupReturnFocusTarget = this.resolvePopupReturnFocusTarget(state);
    const nextTop = computePopupTop(state.anchorY, this.win.innerHeight);
    const nextLeft = computePopupLeft(state.anchorX, this.win.innerWidth);
    this.popupForm.style.top = `${nextTop}px`;
    this.popupForm.style.left = `${nextLeft}px`;
    if (state.mode === "edit") {
      this.popupTitleView.textContent = "编辑标注";
      this.popupSubmitButton.textContent = "保存修改";
      this.popupDeleteButton.hidden = false;
    } else {
      this.popupTitleView.textContent = "新建标注";
      this.popupSubmitButton.textContent = "提交标注";
      this.popupDeleteButton.hidden = true;
    }
    this.popupTargetView.textContent = `${state.targetInput.elementName} · ${state.targetInput.elementPath || "unknown path"}`;
    if (state.selectedText) {
      this.popupSelectionLabel.textContent = "当前选中文本";
      this.popupSelectionView.textContent = state.selectedText;
    } else if (state.multiSelectMeta) {
      if (state.multiSelectMeta.count > 0) {
        // 聚合与区域场景共用一个展示区，只切换标签名，减少模板分叉。
        this.popupSelectionLabel.textContent = "聚合范围说明";
        this.popupSelectionView.textContent = `已聚合 ${state.multiSelectMeta.count} 个元素，提交后会写入一条合并标注。`;
      } else {
        this.popupSelectionLabel.textContent = "区域说明";
        this.popupSelectionView.textContent = "已选择一个区域，提交后会写入一条区域标注。";
      }
    } else {
      this.popupSelectionLabel.textContent = "当前选中文本";
      this.popupSelectionView.textContent = "未检测到页面选中内容";
    }
    this.popupBodyInput.value = state.initialBody ?? "";
    this.popupPrioritySelect.value = normalizePriority(state.initialPriority ?? "normal");
    this.popupForm.hidden = false;
    this.popupClosing = false;
    delete this.popupForm.dataset.closing;
    this.playPopupMotion("enter");
    this.syncPopupSubmittingState();
    this.setPopupStatus("等待操作", "info");
    this.win.setTimeout(() => {
      if (!this.popupForm.hidden && !this.popupClosing && this.popupState) {
        this.popupBodyInput.focus();
      }
    }, 0);
  }

  private closePopup(): void {
    this.closeMarkerContextMenu();
    const returnFocusTarget = this.popupReturnFocusTarget;
    this.popupReturnFocusTarget = null;
    this.popupState = null;
    if (!this.popupForm.hidden && !this.popupClosing) {
      this.popupClosing = true;
      this.popupForm.dataset.closing = "true";
      this.playPopupMotion("exit");
      this.syncPopupSubmittingState();
      if (this.popupExitTimerId !== null) {
        this.win.clearTimeout(this.popupExitTimerId);
      }
      this.popupExitTimerId = this.win.setTimeout(() => {
        this.popupExitTimerId = null;
        this.finalizePopupClose();
      }, POPUP_EXIT_DURATION_MS);
    }
    // 弹窗关闭后回收焦点，保证键盘用户可继续无鼠标操作。
    if (returnFocusTarget && returnFocusTarget.isConnected) {
      returnFocusTarget.focus();
    }
  }

  private cancelPopupExitIfNeeded(): void {
    if (this.popupExitTimerId !== null) {
      this.win.clearTimeout(this.popupExitTimerId);
      this.popupExitTimerId = null;
    }
    this.popupClosing = false;
    delete this.popupForm.dataset.closing;
    if (this.popupForm.dataset.motion === "exit") {
      delete this.popupForm.dataset.motion;
    }
  }

  private finalizePopupClose(): void {
    this.popupClosing = false;
    this.popupForm.hidden = true;
    delete this.popupForm.dataset.closing;
    delete this.popupForm.dataset.motion;
    this.resetPopupToDefaultView();
    this.syncPopupSubmittingState();
  }

  private resetPopupToDefaultView(): void {
    this.popupDeleteButton.hidden = true;
    this.popupTitleView.textContent = "新建标注";
    this.popupSubmitButton.textContent = "提交标注";
    this.popupSelectionLabel.textContent = "当前选中文本";
    this.popupBodyInput.value = "";
    this.popupPrioritySelect.value = "normal";
    this.clearPopupValidationFeedback();
    this.setPopupStatus("等待操作", "info");
  }

  private playPopupMotion(motion: "enter" | "exit"): void {
    if (this.popupEnterTimerId !== null) {
      this.win.clearTimeout(this.popupEnterTimerId);
      this.popupEnterTimerId = null;
    }
    this.popupForm.dataset.motion = motion;
    if (motion !== "enter") {
      return;
    }
    this.popupEnterTimerId = this.win.setTimeout(() => {
      this.popupEnterTimerId = null;
      if (this.popupForm.dataset.motion === "enter") {
        delete this.popupForm.dataset.motion;
      }
    }, POPUP_ENTER_DURATION_MS);
  }

  private raisePopupBodyRequiredFeedback(): void {
    this.setPopupStatus("请输入反馈内容", "error");
    this.popupBodyInput.dataset.invalid = "true";
    this.popupBodyInput.setAttribute("aria-invalid", "true");
    this.popupForm.classList.remove("pc-agent-popup-shake");
    // 先强制回流再重新加类，保证连续两次校验失败也能触发抖动。
    void this.popupForm.offsetWidth;
    this.popupForm.classList.add("pc-agent-popup-shake");
    if (this.popupShakeTimerId !== null) {
      this.win.clearTimeout(this.popupShakeTimerId);
    }
    this.popupShakeTimerId = this.win.setTimeout(() => {
      this.popupShakeTimerId = null;
      this.popupForm.classList.remove("pc-agent-popup-shake");
    }, POPUP_SHAKE_DURATION_MS);
    this.popupBodyInput.focus();
  }

  private clearPopupValidationFeedback(): void {
    delete this.popupBodyInput.dataset.invalid;
    this.popupBodyInput.removeAttribute("aria-invalid");
    this.popupForm.classList.remove("pc-agent-popup-shake");
    if (this.popupShakeTimerId !== null) {
      this.win.clearTimeout(this.popupShakeTimerId);
      this.popupShakeTimerId = null;
    }
  }

  private openMarkerContextMenu(markerId: string, clientX: number, clientY: number): void {
    if (this.submitting) {
      return;
    }
    this.closeMarkerContextMenu();
    this.markerContextMenuMarkerId = markerId;
    this.markerContextMenu.hidden = false;

    const nextLeft = computeMarkerContextMenuLeft(clientX, this.win.innerWidth);
    const nextTop = computeMarkerContextMenuTop(clientY, this.win.innerHeight);
    this.markerContextMenu.style.left = `${nextLeft}px`;
    this.markerContextMenu.style.top = `${nextTop}px`;

    this.attachMarkerContextMenuListeners();
    this.markerContextMenuDeleteButton.focus();
  }

  private closeMarkerContextMenu(): void {
    this.markerContextMenuMarkerId = null;
    this.markerContextMenu.hidden = true;
    this.markerContextMenu.style.left = "0px";
    this.markerContextMenu.style.top = "0px";
    this.detachMarkerContextMenuListeners();
  }

  private attachMarkerContextMenuListeners(): void {
    if (this.markerContextMenuListening) {
      return;
    }
    this.markerContextMenuListening = true;
    this.doc.addEventListener("pointerdown", this.onMarkerContextMenuPointerDown, true);
    this.doc.addEventListener("keydown", this.onMarkerContextMenuKeyDown, true);
    this.win.addEventListener("scroll", this.onMarkerContextMenuViewportChange, true);
    this.win.addEventListener("blur", this.onMarkerContextMenuViewportChange, true);
  }

  private detachMarkerContextMenuListeners(): void {
    if (!this.markerContextMenuListening) {
      return;
    }
    this.markerContextMenuListening = false;
    this.doc.removeEventListener("pointerdown", this.onMarkerContextMenuPointerDown, true);
    this.doc.removeEventListener("keydown", this.onMarkerContextMenuKeyDown, true);
    this.win.removeEventListener("scroll", this.onMarkerContextMenuViewportChange, true);
    this.win.removeEventListener("blur", this.onMarkerContextMenuViewportChange, true);
  }

  private collectPopupFocusableElements(): HTMLElement[] {
    const candidates = Array.from(
      this.popupForm.querySelectorAll<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      ),
    );
    return candidates.filter((item) => isFocusableInPopup(item));
  }

  private resolvePopupActiveElement(eventTarget: EventTarget | null): HTMLElement | null {
    if (eventTarget instanceof HTMLElement && this.popupForm.contains(eventTarget)) {
      return eventTarget;
    }
    const activeElement = this.shadow.activeElement;
    if (activeElement instanceof HTMLElement && this.popupForm.contains(activeElement)) {
      return activeElement;
    }
    return null;
  }

  private resolvePopupReturnFocusTarget(state: PopupState): HTMLElement | null {
    const activeElement = this.doc.activeElement;
    if (
      activeElement instanceof HTMLElement
      && activeElement !== this.doc.body
      && activeElement !== this.host
      && !this.popupForm.contains(activeElement)
    ) {
      return activeElement;
    }
    if (
      state.returnFocusElement
      && state.returnFocusElement !== this.doc.body
      && state.returnFocusElement !== this.host
      && state.returnFocusElement.isConnected
      && !this.popupForm.contains(state.returnFocusElement)
    ) {
      return state.returnFocusElement;
    }
    // 找不到可靠来源时，退回到工具栏主按钮，确保焦点不丢失。
    if (!this.toolbarToggle.hidden && this.toolbarToggle.isConnected) {
      return this.toolbarToggle;
    }
    return null;
  }

  private syncDragSelectionBox(rect: DOMRectReadOnly): void {
    this.dragSelectionBox.hidden = false;
    this.dragSelectionBox.style.left = `${rect.left}px`;
    this.dragSelectionBox.style.top = `${rect.top}px`;
    this.dragSelectionBox.style.width = `${rect.width}px`;
    this.dragSelectionBox.style.height = `${rect.height}px`;
  }

  private hideDragSelectionBox(): void {
    this.dragSelectionBox.hidden = true;
    this.dragSelectionBox.style.width = "0px";
    this.dragSelectionBox.style.height = "0px";
  }

  private resetDragSelectionState(): void {
    this.dragSelectionMouseDownPoint = null;
    this.dragSelectionStartPoint = null;
    this.dragSelecting = false;
    this.suppressClickOnceAfterDrag = false;
    this.hideDragSelectionBox();
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
    const controlsLocked = this.submitting || this.popupClosing;
    this.popupSubmitButton.disabled = controlsLocked;
    this.popupDeleteButton.disabled = controlsLocked;
    this.popupCancelButton.disabled = controlsLocked;
    this.popupPrioritySelect.disabled = controlsLocked;
    this.popupBodyInput.readOnly = controlsLocked;
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

function resolveEventTargetElement(event: Event): HTMLElement | null {
  const path = event.composedPath();
  for (const node of path) {
    if (node instanceof HTMLElement) {
      return node;
    }
  }
  if (event.target instanceof HTMLElement) {
    return event.target;
  }
  return null;
}

function shouldSkipDragSelectionStart(target: HTMLElement): boolean {
  if (target.isContentEditable) {
    return true;
  }
  return DRAG_SELECTION_TEXT_TAGS.has(target.tagName);
}

/**
 * 拖框坐标统一夹在视口内，避免越界后出现负尺寸。
 */
function buildSelectionRect(
  start: Point,
  end: Point,
  viewportWidth: number,
  viewportHeight: number,
): DOMRectReadOnly | null {
  const left = clamp(Math.min(start.x, end.x), 0, Math.max(0, viewportWidth));
  const top = clamp(Math.min(start.y, end.y), 0, Math.max(0, viewportHeight));
  const right = clamp(Math.max(start.x, end.x), 0, Math.max(0, viewportWidth));
  const bottom = clamp(Math.max(start.y, end.y), 0, Math.max(0, viewportHeight));
  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1) {
    return null;
  }
  return new DOMRect(left, top, width, height);
}

function collectAreaSelectionTargets(
  doc: Document,
  shellHost: HTMLElement,
  selectionRect: DOMRectReadOnly,
  viewportWidth: number,
  viewportHeight: number,
): MultiSelectTargetSnapshot[] {
  const matched: Array<{ element: HTMLElement; rect: DOMRectReadOnly }> = [];

  doc.querySelectorAll(AREA_SELECTION_ELEMENT_SELECTOR).forEach((candidate) => {
    if (!(candidate instanceof HTMLElement)) {
      return;
    }
    if (candidate === shellHost || shellHost.contains(candidate)) {
      return;
    }

    const rect = snapshotRect(candidate.getBoundingClientRect());
    if (rect.width > viewportWidth * 0.8 && rect.height > viewportHeight * 0.5) {
      return;
    }
    if (rect.width < 10 || rect.height < 10) {
      return;
    }
    if (!isRectIntersecting(rect, selectionRect)) {
      return;
    }
    matched.push({ element: candidate, rect });
  });

  // 跟参考实现保持一致：命中集合里优先保留更具体的叶子节点。
  const leafMatched = matched.filter(
    ({ element }) =>
      !matched.some(
        ({ element: otherElement }) => otherElement !== element && element.contains(otherElement),
      ),
  );

  return leafMatched.map(({ element, rect }) => {
    const info = identifyElement(element);
    return {
      element,
      elementName: info.name,
      elementPath: info.path,
      rect,
    };
  });
}

function isRectIntersecting(a: DOMRectReadOnly, b: DOMRectReadOnly): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function readToolbarPersistedState(win: Window): ToolbarPersistedState | null {
  const storage = getSafeLocalStorage(win);
  if (!storage) {
    return null;
  }
  // 解析失败时返回 null，上层自动退回默认显示逻辑。
  return parseToolbarPersistedState(storage.getItem(TOOLBAR_STATE_STORAGE_KEY));
}

function writeToolbarPersistedState(win: Window, state: ToolbarPersistedState): void {
  const storage = getSafeLocalStorage(win);
  if (!storage) {
    return;
  }
  try {
    storage.setItem(TOOLBAR_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 某些受限环境可能禁写 localStorage；这里静默降级，不阻塞主功能。
  }
}

function parseToolbarPersistedState(raw: string | null): ToolbarPersistedState | null {
  if (!raw) {
    return null;
  }
  try {
    return normalizeToolbarPersistedState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function normalizeToolbarPersistedState(value: unknown): ToolbarPersistedState | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.version !== TOOLBAR_STATE_VERSION) {
    return null;
  }
  if (typeof value.hidden !== "boolean") {
    return null;
  }
  if (!isFiniteNumber(value.left) || !isFiniteNumber(value.top)) {
    return null;
  }
  return {
    version: TOOLBAR_STATE_VERSION,
    hidden: value.hidden,
    left: value.left,
    top: value.top,
  };
}

function getSafeLocalStorage(win: Window): Storage | null {
  try {
    return win.localStorage;
  } catch {
    // Safari 隐私模式、沙箱 iframe 等场景都可能抛异常。
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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

  // DOM/a11y/邻近文本上下文只做轻量快照，帮助后续回放和定位。
  if (options?.targetElement) {
    meta.elementContext = extractElementContextMeta(options.targetElement);
  }

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

/**
 * 终态 annotation 不再可编辑，回放时跳过，避免用户在壳体里改到“已结束”记录。
 */
function isReplayableFeedbackAnnotation(annotation: FeedbackAnnotation): boolean {
  if (!annotation.id.trim()) {
    return false;
  }
  return !NON_REPLAYABLE_ANNOTATION_STATUS.has(annotation.status);
}

function buildFeedbackDeltaPlan(delta: AgentationShellFeedbackDelta): FeedbackDeltaPlan {
  const plan: FeedbackDeltaPlan = {
    dismissedAnnotationIds: new Set<string>(),
    shouldReloadSnapshot: false,
    eventCount: 0,
  };

  for (const event of delta.events) {
    const eventType = event.eventType;
    if (!eventType.startsWith("annotation.")) {
      continue;
    }
    plan.eventCount += 1;

    if (eventType === "annotation.dismissed") {
      const annotationId = event.annotationId?.trim() ?? "";
      if (annotationId) {
        // dismiss 事件直接删 marker，避免每次都回放全量 snapshot。
        plan.dismissedAnnotationIds.add(annotationId);
        continue;
      }
      // delta payload 不完整时保守回退到 snapshot，确保状态最终一致。
      plan.shouldReloadSnapshot = true;
      continue;
    }

    // created/updated/claimed/replied/resolved 等统一走一次 snapshot reload。
    plan.shouldReloadSnapshot = true;
  }

  return plan;
}

function resolveReplayMarkerTarget(
  annotation: FeedbackAnnotation,
  doc: Document,
  shellHost: HTMLElement,
  viewportWidth: number,
  viewportHeight: number,
): ReplayMarkerTarget | null {
  const uiAnchor = annotation.target.uiAnchor;
  const anchorMeta = isRecord(uiAnchor?.meta) ? uiAnchor.meta : null;
  const selector = typeof uiAnchor?.cssSelector === "string" ? uiAnchor.cssSelector.trim() : "";
  const selectorElement = selector ? queryReplayElementBySelector(doc, shellHost, selector) : null;
  const rect = toDomRectFromUiRect(uiAnchor?.rect)
    ?? readMultiSelectUnionRect(anchorMeta)
    ?? (selectorElement ? snapshotRect(selectorElement.getBoundingClientRect()) : null);
  if (!rect || rect.width < 1 || rect.height < 1) {
    return null;
  }

  const identified = selectorElement ? identifyElement(selectorElement) : null;
  const elementName = readRecordString(anchorMeta, "elementName") || identified?.name || "annotation";
  const elementPath = readRecordString(anchorMeta, "elementPath") || selector || identified?.path || "unknown path";
  return {
    anchorX: clamp(rect.left + rect.width / 2, 0, Math.max(0, viewportWidth)),
    anchorY: clamp(rect.top + rect.height / 2, 0, Math.max(0, viewportHeight)),
    elementName,
    targetInput: {
      elementName,
      elementPath,
      rect: snapshotRect(rect),
    },
  };
}

function queryReplayElementBySelector(doc: Document, shellHost: HTMLElement, selector: string): HTMLElement | null {
  try {
    const node = doc.querySelector(selector);
    if (!(node instanceof HTMLElement)) {
      return null;
    }
    if (node === shellHost || shellHost.contains(node)) {
      return null;
    }
    return node;
  } catch {
    // selector 可能来自历史数据，语法异常时直接降级。
    return null;
  }
}

function readMultiSelectUnionRect(meta: Record<string, unknown> | null): DOMRectReadOnly | null {
  if (!meta) {
    return null;
  }
  const multiSelect = meta.multiSelect;
  if (!isRecord(multiSelect)) {
    return null;
  }
  const unionRect = multiSelect.unionRect;
  if (!isRecord(unionRect)) {
    return null;
  }
  const x = unionRect.x;
  const y = unionRect.y;
  const width = unionRect.width;
  const height = unionRect.height;
  return toDomRectFromUiRect(
    isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(width) && isFiniteNumber(height)
      ? { x, y, width, height }
      : undefined,
  );
}

function toDomRectFromUiRect(rect: FeedbackUiRect | undefined): DOMRectReadOnly | null {
  if (!rect) {
    return null;
  }
  if (!isFiniteNumber(rect.x) || !isFiniteNumber(rect.y) || !isFiniteNumber(rect.width) || !isFiniteNumber(rect.height)) {
    return null;
  }
  if (rect.width < 1 || rect.height < 1) {
    return null;
  }
  return new DOMRect(rect.x, rect.y, rect.width, rect.height);
}

function readRecordString(record: Record<string, unknown> | null, key: string): string {
  if (!record) {
    return "";
  }
  const value = record[key];
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
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

function isFocusableInPopup(element: HTMLElement): boolean {
  if (element.hasAttribute("hidden") || element.closest("[hidden]")) {
    return false;
  }
  if (!element.isConnected || element.tabIndex < 0) {
    return false;
  }
  if (
    element instanceof HTMLButtonElement
    || element instanceof HTMLInputElement
    || element instanceof HTMLSelectElement
    || element instanceof HTMLTextAreaElement
  ) {
    return !element.disabled;
  }
  return true;
}

function buildMarkerTooltipQuote(marker: MarkerRecord): string {
  if (!marker.selectedText) {
    return "无选中文本";
  }
  return `“${marker.selectedText.slice(0, 40)}”`;
}

function buildMarkerTooltipNote(marker: MarkerRecord): string {
  return `${marker.elementName} · ${marker.body.slice(0, 80)}`;
}

function resolveMarkerTooltipPlacement(
  markerX: number,
  markerY: number,
  viewportWidth: number,
  viewportHeight: number,
): MarkerTooltipPlacement {
  const horizontalSpacing = 8;
  const verticalSpacing = 8;
  const markerRadius = 11;
  const tooltipMaxWidth = 260;
  const tooltipEstimatedHeight = 84;
  const horizontalHalf = tooltipMaxWidth / 2;

  let horizontal: MarkerTooltipPlacement["horizontal"] = "center";
  if (markerX - horizontalHalf < horizontalSpacing) {
    horizontal = "left";
  } else if (markerX + horizontalHalf > viewportWidth - horizontalSpacing) {
    horizontal = "right";
  }

  let vertical: MarkerTooltipPlacement["vertical"] = "bottom";
  if (markerY + markerRadius + verticalSpacing + tooltipEstimatedHeight > viewportHeight - verticalSpacing) {
    vertical = "top";
  }

  return { horizontal, vertical };
}

function computeMarkerContextMenuLeft(clientX: number, viewportWidth: number): number {
  const width = 132;
  const spacing = 8;
  return clamp(clientX + 4, spacing, Math.max(spacing, viewportWidth - width - spacing));
}

function computeMarkerContextMenuTop(clientY: number, viewportHeight: number): number {
  const height = 38;
  const spacing = 8;
  return clamp(clientY + 4, spacing, Math.max(spacing, viewportHeight - height - spacing));
}

function computePopupLeft(clientX: number, viewportWidth: number): number {
  // 与当前样式宽度保持一致，避免靠边时出现过度保守的留白。
  const width = 280;
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
      --agentation-color-blue: #0088ff;
      --agentation-color-green: #34c759;
      --agentation-color-red: #ff383c;
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
      width: auto;
      max-width: min(240px, calc(100vw - 24px));
      background: #1a1a1a;
      color: #fff;
      border-radius: 18px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
      padding: 6px 8px;
      display: flex;
      align-items: center;
      gap: 8px;
      pointer-events: auto;
    }

    .pc-agent-toolbar[hidden] {
      display: none;
    }

    .pc-agent-toolbar[data-dragging="true"] {
      user-select: none;
    }

    .pc-agent-toolbar-toggle {
      min-width: 74px;
      height: 28px;
      border: 0;
      border-radius: 999px;
      background: #0088ff;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.15s ease, background 0.15s ease;
      flex-shrink: 0;
    }

    .pc-agent-toolbar-toggle[data-active="true"] {
      background: #34c759;
    }

    .pc-agent-toolbar-toggle:hover {
      transform: translateY(-1px);
    }

    .pc-agent-toolbar-hint {
      display: none;
      line-height: 1.3;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.72);
      max-width: 118px;
      flex: 1 1 auto;
      min-width: 72px;
      white-space: normal;
      word-break: break-word;
    }

    .pc-agent-toolbar[data-annotating="true"] .pc-agent-toolbar-hint {
      display: block;
    }

    .pc-agent-toolbar-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .pc-agent-toolbar-icon {
      width: 24px;
      height: 24px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.9);
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.15s ease;
    }

    .pc-agent-toolbar-icon:hover {
      background: rgba(255, 255, 255, 0.14);
      transform: translateY(-1px);
    }

    .pc-agent-toolbar-drag {
      cursor: grab;
      letter-spacing: -1px;
      font-weight: 700;
    }

    .pc-agent-toolbar[data-dragging="true"] .pc-agent-toolbar-drag {
      cursor: grabbing;
    }

    .pc-agent-toolbar-dock {
      position: fixed;
      right: 20px;
      bottom: 20px;
      border: 0;
      border-radius: 999px;
      background: rgba(26, 26, 26, 0.94);
      color: rgba(255, 255, 255, 0.92);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
      padding: 8px 10px;
      cursor: pointer;
      pointer-events: auto;
    }

    .pc-agent-toolbar-dock[hidden] {
      display: none;
    }

    .pc-agent-toolbar-dock[data-dragging="true"] {
      cursor: grabbing;
      user-select: none;
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

    .pc-agent-drag-selection {
      position: fixed;
      box-sizing: border-box;
      border: 2px dashed rgba(0, 136, 255, 0.92);
      background: rgba(0, 136, 255, 0.16);
      border-radius: 6px;
      pointer-events: none;
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
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 0.6875rem;
      font-weight: 600;
      transform: translate(-50%, -50%);
      box-shadow:
        0 2px 6px rgba(0, 0, 0, 0.2),
        inset 0 0 0 1px rgba(0, 0, 0, 0.04);
      cursor: pointer;
      pointer-events: auto;
      user-select: none;
      will-change: transform, opacity;
      contain: layout style;
      z-index: 1;
      transition:
        background-color 0.15s ease,
        transform 0.1s ease;
    }

    .pc-agent-marker:hover,
    .pc-agent-marker:focus-visible {
      transform: translate(-50%, -50%) scale(1.1);
      z-index: 2;
    }

    .pc-agent-marker-affordance {
      position: absolute;
      left: 50%;
      bottom: calc(100% + 8px);
      transform: translateX(-50%);
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.24);
      background: rgba(0, 0, 0, 0.82);
      color: rgba(255, 255, 255, 0.92);
      font-size: 11px;
      line-height: 1;
      padding: 4px 8px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s ease;
    }

    .pc-agent-marker-tooltip {
      position: absolute;
      left: 50%;
      top: calc(100% + 10px);
      transform: translateX(-50%) scale(0.909);
      min-width: 120px;
      max-width: 200px;
      z-index: 100002;
      border-radius: 0.75rem;
      background: #1a1a1a;
      color: #fff;
      box-shadow:
        0 4px 20px rgba(0, 0, 0, 0.3),
        0 0 0 1px rgba(255, 255, 255, 0.08);
      font-size: 13px;
      line-height: 1.4;
      padding: 8px 0.75rem;
      white-space: normal;
      text-align: left;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s ease;
    }

    .pc-agent-marker[data-tooltip-x="left"] .pc-agent-marker-tooltip {
      left: 0;
      transform: scale(0.909);
      transform-origin: left top;
    }

    .pc-agent-marker[data-tooltip-x="right"] .pc-agent-marker-tooltip {
      left: auto;
      right: 0;
      transform: scale(0.909);
      transform-origin: right top;
    }

    .pc-agent-marker[data-tooltip-y="top"] .pc-agent-marker-tooltip {
      top: auto;
      bottom: calc(100% + 8px);
    }

    .pc-agent-marker:hover .pc-agent-marker-affordance,
    .pc-agent-marker:focus-visible .pc-agent-marker-affordance {
      opacity: 1;
    }

    .pc-agent-marker:hover .pc-agent-marker-tooltip,
    .pc-agent-marker:focus-visible .pc-agent-marker-tooltip {
      opacity: 1;
    }

    .pc-agent-marker-quote {
      display: block;
      font-size: 12px;
      font-style: italic;
      color: rgba(255, 255, 255, 0.6);
      margin-bottom: 0.3125rem;
      line-height: 1.4;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .pc-agent-marker-note {
      display: block;
      font-size: 13px;
      line-height: 1.4;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      padding-bottom: 2px;
    }

    .pc-agent-marker-context-menu {
      position: fixed;
      width: 132px;
      box-sizing: border-box;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 10px;
      background: #1a1a1a;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.34);
      padding: 4px;
      pointer-events: auto;
    }

    .pc-agent-marker-context-menu[hidden] {
      display: none;
    }

    .pc-agent-marker-context-menu-item {
      width: 100%;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: rgba(255, 255, 255, 0.88);
      cursor: pointer;
      font-size: 12px;
      line-height: 1;
      padding: 8px 10px;
      text-align: left;
    }

    .pc-agent-marker-context-menu-item:hover,
    .pc-agent-marker-context-menu-item:focus-visible {
      background: rgba(255, 255, 255, 0.08);
      outline: none;
    }

    .pc-agent-marker-context-menu-item.danger {
      color: #ffd2d2;
    }

    .pc-agent-popup {
      position: fixed;
      width: 280px;
      box-sizing: border-box;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      background: #1a1a1a;
      box-shadow:
        0 4px 24px rgba(0, 0, 0, 0.3),
        0 0 0 1px rgba(255, 255, 255, 0.08);
      padding: 0.75rem 1rem 14px;
      color: #fff;
      pointer-events: auto;
      will-change: transform, opacity;
    }

    .pc-agent-popup[data-closing="true"] {
      pointer-events: none;
    }

    .pc-agent-popup[hidden] {
      display: none;
    }

    .pc-agent-popup[data-motion="enter"] {
      animation: pc-agent-popup-enter ${POPUP_ENTER_DURATION_MS}ms ease-out;
    }

    .pc-agent-popup[data-motion="exit"] {
      animation: pc-agent-popup-exit ${POPUP_EXIT_DURATION_MS}ms ease-in forwards;
    }

    .pc-agent-popup.pc-agent-popup-shake {
      animation: pc-agent-popup-shake ${POPUP_SHAKE_DURATION_MS}ms ease-in-out;
    }

    .pc-agent-popup-title {
      margin: 0 0 8px 0;
      font-size: 12px;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.92);
    }

    .pc-agent-popup-target,
    .pc-agent-popup-selection {
      margin: 0 0 0.5rem 0;
      border-radius: 0.375rem;
      background: rgba(255, 255, 255, 0.05);
      color: rgba(255, 255, 255, 0.65);
      font-size: 12px;
      line-height: 1.45;
      padding: 0.4rem 0.5rem;
      max-height: 72px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .pc-agent-popup-label {
      display: block;
      margin: 0.5rem 0 0.25rem;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.75);
    }

    .pc-agent-popup-body,
    .pc-agent-popup-priority {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
      color: #fff;
      font-size: 0.8125rem;
      padding: 0.5rem 0.625rem;
    }

    .pc-agent-popup-body {
      min-height: 80px;
      resize: vertical;
    }

    .pc-agent-popup-body[data-invalid="true"],
    .pc-agent-popup-body[aria-invalid="true"] {
      border-color: rgba(255, 123, 123, 0.92);
      box-shadow: 0 0 0 1px rgba(255, 123, 123, 0.3);
    }

    .pc-agent-popup-actions {
      margin-top: 0.5rem;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 0.375rem;
    }

    .pc-agent-popup-actions-secondary {
      display: flex;
      align-items: center;
      gap: 0.375rem;
    }

    /* 主操作单独分层，后续可直接承接成品的主按钮布局规则。 */
    .pc-agent-popup-actions-primary {
      display: flex;
      align-items: center;
    }

    .pc-agent-popup-btn {
      border: 0;
      border-radius: 1rem;
      background: transparent;
      color: rgba(255, 255, 255, 0.5);
      cursor: pointer;
      font-size: 0.75rem;
      font-weight: 500;
      padding: 0.4rem 0.875rem;
      transition:
        background-color 0.15s ease,
        color 0.15s ease,
        opacity 0.15s ease;
    }

    .pc-agent-popup-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.8);
    }

    .pc-agent-popup-btn.primary {
      background: var(--agentation-color-blue);
      color: #fff;
      font-weight: 600;
    }

    .pc-agent-popup-btn.primary:hover {
      filter: brightness(0.9);
    }

    .pc-agent-popup-btn.danger {
      background: rgba(255, 123, 123, 0.14);
      color: #ffd2d2;
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

    @keyframes pc-agent-popup-enter {
      from {
        opacity: 0;
        transform: translateY(6px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    @keyframes pc-agent-popup-exit {
      from {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      to {
        opacity: 0;
        transform: translateY(4px) scale(0.985);
      }
    }

    @keyframes pc-agent-popup-shake {
      0%, 100% { transform: translateX(0); }
      20% { transform: translateX(-4px); }
      40% { transform: translateX(4px); }
      60% { transform: translateX(-3px); }
      80% { transform: translateX(3px); }
    }

    @media (prefers-reduced-motion: reduce) {
      .pc-agent-popup[data-motion="enter"],
      .pc-agent-popup[data-motion="exit"],
      .pc-agent-popup.pc-agent-popup-shake {
        animation-duration: 1ms;
      }
    }
  </style>
  <div class="pc-agent-root">
    <div class="pc-agent-marker-layer" data-marker-layer></div>
    <div class="pc-agent-hover-box" data-hover-box hidden></div>
    <div class="pc-agent-drag-selection" data-drag-selection hidden></div>
    <div class="pc-agent-marker-context-menu" data-marker-context-menu hidden>
      <button type="button" class="pc-agent-marker-context-menu-item danger" data-marker-context-menu-delete>删除标注</button>
    </div>

    <div class="pc-agent-toolbar" data-toolbar data-annotating="false">
      <button type="button" class="pc-agent-toolbar-toggle" data-active="false" data-toolbar-toggle>UI 标注</button>
      <span class="pc-agent-toolbar-hint" data-toolbar-hint>开启后，点击页面元素创建反馈。</span>
      <div class="pc-agent-toolbar-actions">
        <button
          type="button"
          class="pc-agent-toolbar-icon pc-agent-toolbar-drag"
          data-toolbar-drag
          aria-label="拖动 UI 标注浮窗"
          title="拖动浮窗"
        >⋮⋮</button>
        <button
          type="button"
          class="pc-agent-toolbar-icon"
          data-toolbar-hide
          aria-label="隐藏 UI 标注浮窗"
          title="隐藏浮窗"
        >×</button>
      </div>
    </div>
    <button type="button" class="pc-agent-toolbar-dock" data-toolbar-dock hidden>标注</button>

    <form class="pc-agent-popup" data-popup hidden>
      <p class="pc-agent-popup-title" data-popup-title>新建标注</p>
      <p class="pc-agent-popup-target" data-popup-target>unknown target</p>

      <label class="pc-agent-popup-label" data-popup-selection-label>当前选中文本</label>
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

      <div class="pc-agent-popup-actions" data-popup-actions>
        <div class="pc-agent-popup-actions-secondary" data-popup-actions-secondary>
          <button type="button" class="pc-agent-popup-btn" data-popup-cancel>取消</button>
          <button type="button" class="pc-agent-popup-btn danger" data-popup-delete hidden>删除标注</button>
        </div>
        <div class="pc-agent-popup-actions-primary" data-popup-actions-primary>
          <button type="submit" class="pc-agent-popup-btn primary" data-popup-submit>提交标注</button>
        </div>
      </div>
      <p class="pc-agent-popup-status info" data-popup-status>等待操作</p>
    </form>
  </div>
`;
