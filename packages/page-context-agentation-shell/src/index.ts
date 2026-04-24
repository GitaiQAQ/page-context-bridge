import type { FeedbackAnnotation, FeedbackAnnotationStatus, FeedbackPriority, FeedbackUiAnchor, FeedbackUiRect } from "@page-context/shared-protocol";

import { extractElementContextMeta, extractReactAnchorMeta, identifyElement } from "./element-identification";
import type {
  AgentationShellBridgeAdapter,
  AgentationShellCreateAnnotationInput,
  AgentationShellCreateAnnotationResult,
  AgentationShellMountDeps,
  AgentationShellMountHandle,
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
  AgentationShellMountDeps,
  AgentationShellMountHandle,
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
const DEFAULT_ANNOTATING_HINT = "Click page elements to open annotation popup, Cmd/Ctrl+Shift+Click for multi-select, Esc to exit.";
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
const runtimeByHost = new WeakMap<HTMLDivElement, AgentationShellRuntime>();

interface MarkerRecord {
  id: string;
  remoteAnnotationId?: string;
  body: string;
  priority: FeedbackPriority;
  selectedText?: string;
  elementName: string;
  targetInput: AgentationShellCreateAnnotationInput["target"];
  // Aggregation semantics are only used in the shell's local rendering layer and not written back to the protocol structure.
  multiSelectMeta?: AgentationShellMultiSelectMeta;
  // Pixel coordinate cache for compatibility with current logic, for direct reuse by tooltip/popup.
  x: number;
  y: number;
  // Normalized coordinates based on viewport; recalculate position after resize.
  normalizedX: number;
  normalizedY: number;
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

interface MarkerVisualSemantic {
  kind: "single" | "multi-select" | "area-select";
  isAggregate: boolean;
  aggregateCount: number;
  mainLabel: string;
  badgeLabel?: string;
  title: string;
  ariaLabel: string;
  affordanceLabel: string;
}

interface MarkerAnchor {
  x: number;
  y: number;
  normalizedX: number;
  normalizedY: number;
}

/**
 * content-script entry point.
 * Returns true if mounted successfully; returns false if the page is not suitable for injection.
 */
export function installAgentationShell(deps: AgentationShellDeps): boolean {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  if (!shouldInstallShell(doc, win)) {
    return false;
  }
  // Maintain historical compatibility: if the default host id already exists, it is considered installed.
  if (doc.getElementById(AGENTATION_SHELL_HOST_ID)) {
    return true;
  }
  return mountAgentationShell({
    adapter: deps.adapter,
    doc,
    win,
    logger: deps.logger,
  }) !== null;
}

/**
 * Reusable mount API:
 * - Supports external host (e.g., React component embedded div);
 * - Returns idempotent unmount handle for proper cleanup during strict mode re-mounting.
 */
export function mountAgentationShell(deps: AgentationShellMountDeps): AgentationShellMountHandle | null {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  if (!shouldInstallShell(doc, win)) {
    return null;
  }

  const { host, removeHostOnUnmount } = resolveMountHost(doc, deps.host);
  // When re-mounting on the same host, first reclaim the old runtime to avoid listener duplication.
  const previousRuntime = runtimeByHost.get(host);
  if (previousRuntime) {
    previousRuntime.unmount();
    runtimeByHost.delete(host);
  }

  const runtime = new AgentationShellRuntime({
    host,
    removeHostOnUnmount,
    adapter: deps.adapter,
    doc,
    win,
    logger: deps.logger,
  });
  runtime.mount();
  runtimeByHost.set(host, runtime);

  let disposed = false;
  return {
    host,
    unmount() {
      if (disposed) {
        return;
      }
      disposed = true;
      // Old handle must not delete new instance: only clean up the currently active runtime.
      if (runtimeByHost.get(host) !== runtime) {
        return;
      }
      runtime.unmount();
      runtimeByHost.delete(host);
    },
  };
}

function resolveMountHost(
  doc: Document,
  providedHost?: HTMLDivElement,
): { host: HTMLDivElement; removeHostOnUnmount: boolean } {
  if (providedHost) {
    return { host: providedHost, removeHostOnUnmount: false };
  }
  const existing = doc.getElementById(AGENTATION_SHELL_HOST_ID);
  if (existing) {
    if (!(existing instanceof HTMLDivElement)) {
      throw new Error(`agentation shell host id conflicts with non-div element: ${AGENTATION_SHELL_HOST_ID}`);
    }
    return { host: existing, removeHostOnUnmount: false };
  }
  const host = doc.createElement("div");
  host.id = AGENTATION_SHELL_HOST_ID;
  return { host, removeHostOnUnmount: true };
}

function resolveShellShadowRoot(host: HTMLDivElement): ShadowRoot {
  if (host.shadowRoot) {
    return host.shadowRoot;
  }
  return host.attachShadow({ mode: "open" });
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
  private readonly removeHostOnUnmount: boolean;

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
  private mounted = false;

  constructor(args: {
    host: HTMLDivElement;
    removeHostOnUnmount: boolean;
    adapter: AgentationShellBridgeAdapter;
    doc: Document;
    win: Window;
    logger?: AgentationShellDeps["logger"];
  }) {
    this.host = args.host;
    this.removeHostOnUnmount = args.removeHostOnUnmount;
    this.adapter = args.adapter;
    this.doc = args.doc;
    this.win = args.win;
    this.logger = args.logger;

    this.shadow = resolveShellShadowRoot(this.host);
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
    if (this.mounted) {
      return;
    }
    this.mounted = true;

    // External host may not have been inserted into DOM yet, fallback to document root.
    if (!this.host.isConnected) {
      const parent = this.doc.body ?? this.doc.documentElement;
      if (!parent) {
        throw new Error("agentation shell host cannot be mounted: missing document root");
      }
      parent.appendChild(this.host);
    }

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

  unmount(): void {
    if (!this.mounted) {
      return;
    }
    this.mounted = false;

    // Remove runtime listeners first before DOM cleanup to avoid callbacks during cleanup.
    this.stopAnnotating();
    this.stopToolbarDrag();
    this.closeMarkerContextMenu();
    this.closePopup();
    this.clearPopupTimers();
    this.detachMarkerContextMenuListeners();
    this.win.removeEventListener("resize", this.onWindowResize, true);

    this.toolbarToggle.removeEventListener("click", this.onToolbarToggleClick);
    this.toolbarDragHandle.removeEventListener("pointerdown", this.onToolbarDragPointerDown);
    this.toolbarHideButton.removeEventListener("click", this.onToolbarHideClick);
    this.toolbarDock.removeEventListener("pointerdown", this.onToolbarDockPointerDown);
    this.toolbarDock.removeEventListener("click", this.onToolbarDockClick);
    this.popupDeleteButton.removeEventListener("click", this.onPopupDeleteClick);
    this.popupCancelButton.removeEventListener("click", this.onPopupCancelClick);
    this.popupForm.removeEventListener("keydown", this.onPopupKeyDown);
    this.popupForm.removeEventListener("submit", this.onPopupSubmit);
    this.popupBodyInput.removeEventListener("input", this.onPopupBodyInput);
    this.popupPrioritySelect.removeEventListener("change", this.onPriorityChange);
    this.markerContextMenuDeleteButton.removeEventListener("click", this.onMarkerContextMenuDeleteClick);

    // When reusing external host, do not directly remove the node, only clear shadow content.
    this.shadow.replaceChildren();
    if (this.removeHostOnUnmount) {
      this.host.remove();
    }
  }

  /**
   * Actively fetch snapshot once after initialization to replay historical annotations as markers.
   */
  private bootstrapFeedbackReplay(): void {
    if (!this.mounted) {
      return;
    }
    if (!this.adapter.getFeedbackSnapshot) {
      return;
    }
    // First replay full snapshot, then supplement with delta to cover event races within the snapshot fetch window.
    void this.syncMarkersFromFeedbackSnapshot().then(() => this.syncMarkersFromFeedbackDelta());
  }

  /**
   * Snapshot is the authoritative source of shell state: replay after refresh goes through here.
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
      if (!this.mounted) {
        return;
      }
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
   * Minimal delta fallback:
   * - dismissed with annotationId: directly delete marker
   * - other annotation events: fall back to triggering a snapshot reload
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
      if (!this.mounted) {
        return;
      }
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
   * Only overwrite remote markers; local temporary markers (without remote id) are retained to avoid interrupting current operations.
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
        multiSelectMeta: replayed.multiSelectMeta,
        x: replayed.x,
        y: replayed.y,
        normalizedX: replayed.normalizedX,
        normalizedY: replayed.normalizedY,
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
   * Replay target prioritizes structured fields in uiAnchor;
   * When missing, fall back to selector on-site positioning to ensure minimal usability.
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
    const markerAnchor = buildMarkerAnchor(replayTarget.anchorX, replayTarget.anchorY, this.win.innerWidth, this.win.innerHeight);
    const multiSelectMeta = readMultiSelectMetaFromUiAnchor(annotation.target.uiAnchor);
    return {
      id: annotation.id,
      remoteAnnotationId: annotation.id,
      body: annotation.body,
      priority: normalizePriority(annotation.priority),
      selectedText: selectedText || undefined,
      elementName: replayTarget.elementName,
      targetInput: replayTarget.targetInput,
      multiSelectMeta,
      x: markerAnchor.x,
      y: markerAnchor.y,
      normalizedX: markerAnchor.normalizedX,
      normalizedY: markerAnchor.normalizedY,
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

    // Exit annotation mode before hiding to avoid the page remaining under transparent layer without a visible entry.
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
    // Recalculate marker pixel positions based on normalized coordinates to reduce drift after window size changes.
    this.renderMarkers();
    this.syncToolbarVisibility();
    this.persistToolbarState();
  };

  private startAnnotating(): void {
    this.annotating = true;
    this.toolbar.dataset.annotating = "true";
    this.toolbarToggle.dataset.active = "true";
    this.toolbarToggle.textContent = "Annotating";
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
    this.toolbarToggle.textContent = "UI Annotation";
    this.toolbarHint.textContent = "After enabling, click page elements to create feedback.";
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
    // Prioritize restoring last state after refresh; fall back to layout if no valid data.
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
    // Only write to storage when positioning coordinates exist to avoid writing partial state data.
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

    // Always leave a small margin on the page to avoid users being unable to click back after dragging outside the viewport.
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

    // After dragging on the dock, block the subsequent click to avoid "auto-open immediately after moving".
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

    // Prevent default behavior after entering drag selection candidate state to avoid accidental text selection.
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

      // Drag selection is an independent selection mode, clear other temporary states at the start to avoid state overlap.
      this.hideHoverBox();
      this.clearMultiSelectTargets();
      if (!this.popupForm.hidden) {
        this.closePopup();
      }
      this.toolbarHint.textContent = "Dragging selection box, release mouse to create unified feedback.";
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

    // Consume this mouseup/click after drag selection completes to avoid mishandling by the single-click chain.
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

    // Unified recovery of temporary states on blur to avoid "keys released but internal states still hanging".
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
      // Freeze page clicks during submission to avoid concurrent duplicate submissions and page misoperations.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }
    if (this.suppressClickOnceAfterDrag) {
      // Align with reference implementation: drag selection end is followed by a click, consume only once here.
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

    // Take over clicks in annotation mode to avoid triggering real page interactions (navigation, submission, etc.).
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (isMultiSelectChordPressed(event)) {
      this.toggleMultiSelectTarget(target, event.clientX, event.clientY);
      return;
    }

    // Non-modifier key clicks still maintain single-selection behavior, clear residual aggregation state first to avoid subsequent Esc logic confusion.
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
      this.setPopupStatus("Drag selection cancelled", "info");
      return;
    }

    // Esc prioritizes clearing multi-select aggregation to avoid accidentally triggering the close flow.
    if (this.multiSelectTargets.size > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.clearMultiSelectTargets();
      this.setPopupStatus("Multi-select aggregation cleared", "info");
      return;
    }

    // When no aggregation, follow original logic: close popup first, then exit annotation mode.
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
    // Hover box follows target element scrolling to avoid visual misalignment.
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
    // Logical closed state (including exit transition) no longer consumes keys to avoid focus chain being interrupted by old popups.
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
      // Cycle focus inside popup to avoid Tab jumping back to page and breaking keyboard chain.
      event.preventDefault();
      event.stopPropagation();
      focusableElements[nextIndex].focus();
      return;
    }

    if (event.key === "Escape") {
      // Esc inside edit popup always closes the popup first, preventing event bubbling to page.
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

    // Only take over Enter inside textarea: Shift+Enter continues new line, regular Enter submits.
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
      this.setPopupStatus("Deletion failed: annotation not found", "error");
      return;
    }

    const marker = this.findMarkerById(markerId);
    if (!marker) {
      this.setPopupStatus("Deletion failed: annotation may have been removed", "error");
      return;
    }

    this.submitting = true;
    this.syncPopupSubmittingState();
    this.setPopupStatus("Deleting...", "info");
    try {
      await this.dismissRemoteAnnotationIfNeeded(marker);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setPopupStatus(`Deletion failed: ${message}`, "error");
      this.log("error", "Agentation shell dismiss annotation failed", error);
      return;
    } finally {
      this.submitting = false;
      this.syncPopupSubmittingState();
    }

    if (!this.deleteMarkerById(markerId)) {
      this.setPopupStatus("Deletion failed: annotation may have been removed", "error");
      return;
    }
    this.setPopupStatus("Feedback deleted", "success");
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
      this.setPopupStatus("Deletion failed: annotation may have been removed", "error");
      return;
    }

    this.submitting = true;
    this.syncPopupSubmittingState();
    this.setPopupStatus("Deleting...", "info");
    try {
      await this.dismissRemoteAnnotationIfNeeded(marker);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setPopupStatus(`Deletion failed: ${message}`, "error");
      this.log("error", "Agentation shell dismiss annotation failed from marker context menu", error);
      return;
    } finally {
      this.submitting = false;
      this.syncPopupSubmittingState();
    }

    if (!this.deleteMarkerById(markerId)) {
      this.setPopupStatus("Deletion failed: annotation may have been removed", "error");
      return;
    }
    if (this.popupState?.mode === "edit" && this.popupState.editMarkerId === markerId) {
      this.closePopup();
    }
    this.setPopupStatus("Feedback deleted", "success");
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
      // Menu has only one action, Tab should not send focus back to page.
      event.preventDefault();
      event.stopPropagation();
      this.markerContextMenuDeleteButton.focus();
    }
  };

  private readonly onMarkerContextMenuViewportChange = (): void => {
    if (this.markerContextMenu.hidden) {
      return;
    }
    // Directly collapse when viewport changes to avoid menu position hanging.
    this.closeMarkerContextMenu();
  };

  private readonly onPriorityChange = (): void => {
    if (!isFeedbackPriority(this.popupPrioritySelect.value)) {
      this.popupPrioritySelect.value = "normal";
    }
  };

  private readonly onPopupBodyInput = (): void => {
    // Immediately revoke empty content emphasis after user starts input to avoid error state residue interfering with next edits.
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
        this.setPopupStatus("Update failed: annotation not found", "error");
        return;
      }

      const marker = this.findMarkerById(markerId);
      if (!marker) {
        this.setPopupStatus("Update failed: annotation may have been removed", "error");
        return;
      }

      this.submitting = true;
      this.syncPopupSubmittingState();
      this.setPopupStatus("Updating...", "info");
      try {
        await this.updateRemoteAnnotationIfNeeded(marker, body, priority);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setPopupStatus(`Update failed: ${message}`, "error");
        this.log("error", "Agentation shell update annotation failed", error);
        return;
      } finally {
        this.submitting = false;
        this.syncPopupSubmittingState();
      }

      if (!this.updateMarkerById(markerId, body, priority)) {
        this.setPopupStatus("Update failed: annotation may have been removed", "error");
        return;
      }
      this.setPopupStatus("Feedback updated", "success");
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
    this.setPopupStatus("Submitting...", "info");

    try {
      const result = await this.adapter.createAnnotation(payload);
      this.applyAnnotationSuccess(result, payload, popupState);
      this.setPopupStatus("Feedback created", "success");
      this.popupBodyInput.value = "";
      this.closePopup();
      this.triggerFeedbackDeltaSync();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setPopupStatus(`Submission failed: ${message}`, "error");
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
    // Only sync markers with remote ID and adapter support for update; keep local availability for other scenarios.
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
    // Deletion prioritizes remote dismiss to ensure bridge/server can recognize "removed" status.
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
    const markerAnchor = buildMarkerAnchor(popupState.anchorX, popupState.anchorY, this.win.innerWidth, this.win.innerHeight);
    const multiSelectMeta = readMultiSelectMetaFromUiAnchor(input.uiAnchor);
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
      multiSelectMeta,
      x: markerAnchor.x,
      y: markerAnchor.y,
      normalizedX: markerAnchor.normalizedX,
      normalizedY: markerAnchor.normalizedY,
    });
    this.renderMarkers();
  }

  private renderMarkers(): void {
    this.closeMarkerContextMenu();
    this.markerLayer.innerHTML = "";
    this.markers.forEach((marker, index) => {
      // Project based on current viewport for each render to avoid markers staying at old coordinates after resize.
      const markerAnchor = denormalizeMarkerAnchor(marker.normalizedX, marker.normalizedY, this.win.innerWidth, this.win.innerHeight);
      marker.x = markerAnchor.x;
      marker.y = markerAnchor.y;
      const button = this.doc.createElement("button");
      button.type = "button";
      button.className = "pc-agent-marker";
      button.dataset.markerId = marker.id;
      button.style.left = `${markerAnchor.x}px`;
      button.style.top = `${markerAnchor.y}px`;
      button.style.background = markerColor(marker.priority);
      const semantic = resolveMarkerVisualSemantic(marker, index);
      // Explicitly pass aggregation semantics to DOM for quick recognition by styles and debugging tools.
      button.dataset.markerKind = semantic.kind;
      button.dataset.markerAggregate = semantic.isAggregate ? "true" : "false";
      button.dataset.markerAggregateCount = String(semantic.aggregateCount);
      button.setAttribute("aria-label", semantic.ariaLabel);
      const tooltipPlacement = resolveMarkerTooltipPlacement(
        markerAnchor.x,
        markerAnchor.y,
        this.win.innerWidth,
        this.win.innerHeight,
      );
      // Only tag at marker dimension, let CSS control tooltip positioning to avoid introducing extra animation states.
      button.dataset.tooltipX = tooltipPlacement.horizontal;
      button.dataset.tooltipY = tooltipPlacement.vertical;
      // Title text also carries semantics to immediately distinguish between "regular annotation" and "aggregate annotation" on hover.
      button.title = semantic.title;

      const mainLabel = this.doc.createElement("span");
      mainLabel.className = "pc-agent-marker-main-label";
      mainLabel.textContent = semantic.mainLabel;
      mainLabel.setAttribute("aria-hidden", "true");
      button.appendChild(mainLabel);
      if (semantic.badgeLabel) {
        const badge = this.doc.createElement("span");
        badge.className = "pc-agent-marker-badge";
        badge.textContent = semantic.badgeLabel;
        badge.setAttribute("aria-hidden", "true");
        button.appendChild(badge);
      }

      button.addEventListener("click", (event) => {
        // Marker clicks are only for editing, should not trigger page-level click logic.
        event.preventDefault();
        event.stopPropagation();
        this.closeMarkerContextMenu();
        this.openPopupForMarker(marker.id);
      });
      button.addEventListener("contextmenu", (event) => {
        // Right-click provides quick delete entry; only show context menu here, not direct deletion.
        event.preventDefault();
        event.stopPropagation();
        const anchorX = event.clientX || marker.x;
        const anchorY = event.clientY || marker.y;
        this.openMarkerContextMenu(marker.id, anchorX, anchorY);
      });

      const affordance = this.doc.createElement("span");
      affordance.className = "pc-agent-marker-affordance";
      affordance.textContent = semantic.affordanceLabel;
      affordance.setAttribute("aria-hidden", "true");
      button.appendChild(affordance);

      const tooltip = this.doc.createElement("span");
      tooltip.className = "pc-agent-marker-tooltip";
      const tooltipQuote = this.doc.createElement("span");
      tooltipQuote.className = "pc-agent-marker-quote";
      tooltipQuote.textContent = buildMarkerTooltipQuote(marker, semantic);
      const tooltipNote = this.doc.createElement("span");
      tooltipNote.className = "pc-agent-marker-note";
      tooltipNote.textContent = buildMarkerTooltipNote(marker, semantic);
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

    // Clear temporary selection state when entering edit mode to avoid keyboard events accidentally triggering old context.
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
   * Maintain aggregation set on modifier key click:
   * - First click adds
   * - Clicking the same element again removes
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
      this.setPopupStatus("Multi-select aggregation is empty", "info");
      return;
    }
    this.toolbarHint.textContent = `Aggregated ${count} elements, release Cmd/Ctrl+Shift to open unified feedback box.`;
    this.setPopupStatus(`Multi-select aggregating (${count})`, "info");
  }

  /**
   * Both Esc and mode switching go through here to ensure multi-select state is cleared at once.
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
   * After releasing modifier keys, merge aggregated elements into a single submission popup.
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
   * After drag selection completes, go through here:
   * 1) Hit elements -> multi-select aggregation submission
   * 2) No hit elements -> area annotation submission
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
      this.toolbarHint.textContent = `Box selection hit ${items.length} elements, unified feedback box opened.`;
      this.setPopupStatus(`Box selection hit ${items.length} elements`, "info");
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
    this.toolbarHint.textContent = "Area selected, fill feedback to submit.";
    this.setPopupStatus("No aggregatable elements hit, area annotation created.", "info");
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
    // If the previous exit transition is in progress, cancel the cleanup timer first to avoid new popup being mistakenly hidden by old task.
    this.cancelPopupExitIfNeeded();
    this.clearPopupValidationFeedback();
    this.popupState = state;
    this.popupReturnFocusTarget = this.resolvePopupReturnFocusTarget(state);
    const nextTop = computePopupTop(state.anchorY, this.win.innerHeight);
    const nextLeft = computePopupLeft(state.anchorX, this.win.innerWidth);
    this.popupForm.style.top = `${nextTop}px`;
    this.popupForm.style.left = `${nextLeft}px`;
    if (state.mode === "edit") {
      this.popupTitleView.textContent = "Edit Annotation";
      this.popupSubmitButton.textContent = "Save Changes";
      this.popupDeleteButton.hidden = false;
    } else {
      this.popupTitleView.textContent = "New Annotation";
      this.popupSubmitButton.textContent = "Submit Annotation";
      this.popupDeleteButton.hidden = true;
    }
    this.popupTargetView.textContent = `${state.targetInput.elementName} · ${state.targetInput.elementPath || "unknown path"}`;
    if (state.selectedText) {
      this.popupSelectionLabel.textContent = "Current Selected Text";
      this.popupSelectionView.textContent = state.selectedText;
    } else if (state.multiSelectMeta) {
      if (state.multiSelectMeta.count > 0) {
        // Aggregation and area scenarios share one display area, only switch label names to reduce template branching.
        this.popupSelectionLabel.textContent = "Aggregation Range Description";
        this.popupSelectionView.textContent = `Aggregated ${state.multiSelectMeta.count} elements, a merged annotation will be written after submission.`;
      } else {
        this.popupSelectionLabel.textContent = "Area Description";
        this.popupSelectionView.textContent = "An area has been selected, an area annotation will be written after submission.";
      }
    } else {
      this.popupSelectionLabel.textContent = "Current Selected Text";
      this.popupSelectionView.textContent = "No page selection detected";
    }
    this.popupBodyInput.value = state.initialBody ?? "";
    this.popupPrioritySelect.value = normalizePriority(state.initialPriority ?? "normal");
    this.popupForm.hidden = false;
    this.popupClosing = false;
    delete this.popupForm.dataset.closing;
    this.playPopupMotion("enter");
    this.syncPopupSubmittingState();
    this.setPopupStatus("Waiting for operation", "info");
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
    // Recover focus after popup closes to ensure keyboard users can continue without mouse.
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
    this.popupTitleView.textContent = "New Annotation";
    this.popupSubmitButton.textContent = "Submit Annotation";
    this.popupSelectionLabel.textContent = "Current Selected Text";
    this.popupBodyInput.value = "";
    this.popupPrioritySelect.value = "normal";
    this.clearPopupValidationFeedback();
    this.setPopupStatus("Waiting for operation", "info");
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
    this.setPopupStatus("Please enter feedback content", "error");
    this.popupBodyInput.dataset.invalid = "true";
    this.popupBodyInput.setAttribute("aria-invalid", "true");
    this.popupForm.classList.remove("pc-agent-popup-shake");
    // Force reflow before re-adding class to ensure shake triggers even on consecutive validation failures.
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

  private clearPopupTimers(): void {
    if (this.popupEnterTimerId !== null) {
      this.win.clearTimeout(this.popupEnterTimerId);
      this.popupEnterTimerId = null;
    }
    if (this.popupExitTimerId !== null) {
      this.win.clearTimeout(this.popupExitTimerId);
      this.popupExitTimerId = null;
    }
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
    // When no reliable source is found, fall back to the toolbar main button to ensure focus is not lost.
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
 * Drag selection coordinates are uniformly clamped within the viewport to avoid negative dimensions after out-of-bounds.
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

  // Align with reference implementation: prioritize keeping more specific leaf nodes in the hit set.
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
  // Return null on parsing failure, upper layer automatically falls back to default display logic.
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
    // Some restricted environments may block localStorage writes; silently degrade here without blocking main functionality.
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
    // Safari private mode, sandboxed iframes, etc. may throw exceptions.
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
 * Combine multiple elements into a bounding box as the positioning rect for unified submission.
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
 * Map the internal target structure of the UI shell to the shared-protocol uiAnchor.
 * Adhere to a "conservatively usable" strategy: provide stable fields first, leave complex selector engine for future iterations.
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

  // DOM/a11y/nearby text context only takes lightweight snapshots to aid subsequent replay and positioning.
  if (options?.targetElement) {
    meta.elementContext = extractElementContextMeta(options.targetElement);
  }

  // React clues are optionally injected, remain silent when unavailable, and do not affect regular pages.
  if (options?.targetElement) {
    const reactMeta = extractReactAnchorMeta(options.targetElement);
    if (reactMeta) {
      meta.reactPath = reactMeta.reactPath;
      meta.reactLeaf = reactMeta.reactLeaf;
    }
  }

  // Multi-select submission still creates only a single annotation; attach aggregation details to meta for easier replay and positioning.
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

  // Shadow boundary paths are for human reading, not guaranteed to follow CSS syntax, direct degradation is more stable.
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

  // Only accept three types of simple fragments: "single tag / single class / single id" to avoid putting dirty paths into protocol fields.
  const simpleSelectorSegmentPattern = /^(?:[a-z][a-z0-9-]*|#[^\s>]+|\.[^\s>.#]+)$/i;
  if (!segments.every((segment) => simpleSelectorSegmentPattern.test(segment))) {
    return undefined;
  }

  return segments.join(" > ");
}

/**
 * Final-state annotations are no longer editable, skip during replay to avoid users modifying "completed" records in the shell.
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
        // Dismiss events directly delete markers to avoid replaying full snapshot every time.
        plan.dismissedAnnotationIds.add(annotationId);
        continue;
      }
      // Conservatively fall back to snapshot when delta payload is incomplete to ensure final state consistency.
      plan.shouldReloadSnapshot = true;
      continue;
    }

    // created/updated/claimed/replied/resolved all go through a snapshot reload.
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
    // Selector may come from historical data, directly degrade on syntax exceptions.
    return null;
  }
}

function readMultiSelectUnionRect(meta: Record<string, unknown> | null): DOMRectReadOnly | null {
  const multiSelectMeta = readMultiSelectMetaFromMetaRecord(meta);
  if (!multiSelectMeta) {
    return null;
  }
  return toDomRectFromUiRect(multiSelectMeta.unionRect);
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

function readMultiSelectMetaFromUiAnchor(uiAnchor: FeedbackUiAnchor | undefined): AgentationShellMultiSelectMeta | undefined {
  if (!uiAnchor || !isRecord(uiAnchor.meta)) {
    return undefined;
  }
  return readMultiSelectMetaFromMetaRecord(uiAnchor.meta);
}

function readMultiSelectMetaFromMetaRecord(meta: Record<string, unknown> | null): AgentationShellMultiSelectMeta | undefined {
  if (!meta) {
    return undefined;
  }
  const multiSelect = meta.multiSelect;
  if (!isRecord(multiSelect)) {
    return undefined;
  }
  const count = multiSelect.count;
  const unionRect = readUiRectFromUnknown(multiSelect.unionRect);
  const items = readMultiSelectItemsFromUnknown(multiSelect.items);
  if (!isFiniteNumber(count) || !Number.isInteger(count) || count < 0 || !unionRect) {
    return undefined;
  }
  const normalizedCount = Number(count);
  // Only perform minimal "renderable" validation: count and items length are not strongly coupled to be compatible with historical dirty data.
  return {
    count: normalizedCount,
    unionRect,
    items,
  };
}

function readMultiSelectItemsFromUnknown(value: unknown): AgentationShellMultiSelectItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: AgentationShellMultiSelectItem[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const elementName = typeof item.elementName === "string" ? item.elementName.trim() : "";
    const elementPath = typeof item.elementPath === "string" ? item.elementPath.trim() : "";
    const rect = readUiRectFromUnknown(item.rect);
    if (!elementName || !elementPath || !rect) {
      continue;
    }
    items.push({
      elementName,
      elementPath,
      rect,
    });
  }
  return items;
}

function readUiRectFromUnknown(value: unknown): FeedbackUiRect | null {
  if (!isRecord(value)) {
    return null;
  }
  const x = value.x;
  const y = value.y;
  const width = value.width;
  const height = value.height;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    return null;
  }
  if (width < 1 || height < 1) {
    return null;
  }
  return { x, y, width, height };
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

function resolveMarkerVisualSemantic(marker: MarkerRecord, index: number): MarkerVisualSemantic {
  const multiSelectMeta = marker.multiSelectMeta;
  if (multiSelectMeta?.count === 0) {
    return {
      kind: "area-select",
      isAggregate: true,
      aggregateCount: 0,
      mainLabel: "Area",
      title: "Area aggregation annotation: click to edit; can delete in popup",
      ariaLabel: `annotation-area-marker-${index + 1}`,
      affordanceLabel: "Area edit / delete",
    };
  }
  if (multiSelectMeta && multiSelectMeta.count > 1) {
    return {
      kind: "multi-select",
      isAggregate: true,
      aggregateCount: multiSelectMeta.count,
      mainLabel: "Σ",
      badgeLabel: multiSelectMeta.count > 99 ? "99+" : String(multiSelectMeta.count),
      title: `Aggregation annotation (${multiSelectMeta.count} elements): click to edit; can delete in popup`,
      ariaLabel: `annotation-multi-marker-${index + 1}-${multiSelectMeta.count}-items`,
      affordanceLabel: "Aggregation edit / delete",
    };
  }
  return {
    kind: "single",
    isAggregate: false,
    aggregateCount: 1,
    mainLabel: String(index + 1),
    title: "Click to edit; can delete in popup",
    ariaLabel: `annotation-marker-${index + 1}`,
    affordanceLabel: "Edit / delete",
  };
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

function buildMarkerTooltipQuote(marker: MarkerRecord, semantic: MarkerVisualSemantic): string {
  if (semantic.kind === "multi-select") {
    return `Aggregation annotation · hit ${semantic.aggregateCount} elements`;
  }
  if (semantic.kind === "area-select") {
    return "Area aggregation annotation · no aggregatable elements hit";
  }
  if (!marker.selectedText) {
    return "No selected text";
  }
  return `“${marker.selectedText.slice(0, 40)}”`;
}

function buildMarkerTooltipNote(marker: MarkerRecord, semantic: MarkerVisualSemantic): string {
  const content = `${marker.elementName} · ${marker.body.slice(0, 80)}`;
  if (semantic.kind === "single") {
    return content;
  }
  if (semantic.kind === "area-select") {
    return `Area range · ${content}`;
  }
  return `Aggregation range(${semantic.aggregateCount}) · ${content}`;
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
  // Keep consistent with current style width to avoid overly conservative margins when near the edge.
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

function buildMarkerAnchor(
  anchorX: number,
  anchorY: number,
  viewportWidth: number,
  viewportHeight: number,
): MarkerAnchor {
  const normalizedX = normalizeViewportCoordinate(anchorX, viewportWidth);
  const normalizedY = normalizeViewportCoordinate(anchorY, viewportHeight);
  const anchor = denormalizeMarkerAnchor(normalizedX, normalizedY, viewportWidth, viewportHeight);
  return {
    x: anchor.x,
    y: anchor.y,
    normalizedX,
    normalizedY,
  };
}

function denormalizeMarkerAnchor(
  normalizedX: number,
  normalizedY: number,
  viewportWidth: number,
  viewportHeight: number,
): Point {
  return {
    x: denormalizeViewportCoordinate(normalizedX, viewportWidth),
    y: denormalizeViewportCoordinate(normalizedY, viewportHeight),
  };
}

function normalizeViewportCoordinate(value: number, viewportSize: number): number {
  const safeViewportSize = Math.max(0, viewportSize);
  if (safeViewportSize < 1) {
    return 0;
  }
  return clamp(value / safeViewportSize, 0, 1);
}

function denormalizeViewportCoordinate(value: number, viewportSize: number): number {
  const safeViewportSize = Math.max(0, viewportSize);
  if (safeViewportSize < 1) {
    return 0;
  }
  return clamp(value * safeViewportSize, 0, safeViewportSize);
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

    .pc-agent-marker-main-label {
      position: relative;
      z-index: 1;
      line-height: 1;
      font-size: inherit;
      font-weight: inherit;
      pointer-events: none;
    }

    .pc-agent-marker-badge {
      position: absolute;
      right: -6px;
      bottom: -6px;
      min-width: 16px;
      height: 16px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 4px;
      box-sizing: border-box;
      font-size: 10px;
      line-height: 1;
      font-weight: 700;
      color: #0f172a;
      background: #fef08a;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.32);
      pointer-events: none;
    }

    .pc-agent-marker[data-marker-aggregate="true"] {
      outline: 2px solid rgba(255, 255, 255, 0.74);
      outline-offset: 1px;
    }

    .pc-agent-marker[data-marker-kind="multi-select"] {
      width: 28px;
      height: 24px;
      border-radius: 8px;
    }

    .pc-agent-marker[data-marker-kind="area-select"] {
      width: 24px;
      height: 24px;
      border-radius: 0;
      clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%);
    }

    .pc-agent-marker[data-marker-kind="area-select"] .pc-agent-marker-main-label {
      font-size: 10px;
      font-weight: 700;
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

    /* Main actions are layered separately, can directly inherit main button layout rules from finished products later. */
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
      <button type="button" class="pc-agent-marker-context-menu-item danger" data-marker-context-menu-delete>Delete Annotation</button>
    </div>

    <div class="pc-agent-toolbar" data-toolbar data-annotating="false">
      <button type="button" class="pc-agent-toolbar-toggle" data-active="false" data-toolbar-toggle>UI Annotation</button>
      <span class="pc-agent-toolbar-hint" data-toolbar-hint>After enabling, click page elements to create feedback.</span>
      <div class="pc-agent-toolbar-actions">
        <button
          type="button"
          class="pc-agent-toolbar-icon pc-agent-toolbar-drag"
          data-toolbar-drag
          aria-label="Drag UI annotation floating window"
          title="Drag floating window"
        >⋮⋮</button>
        <button
          type="button"
          class="pc-agent-toolbar-icon"
          data-toolbar-hide
          aria-label="Hide UI annotation floating window"
          title="Hide floating window"
        >×</button>
      </div>
    </div>
    <button type="button" class="pc-agent-toolbar-dock" data-toolbar-dock hidden>Annotation</button>

    <form class="pc-agent-popup" data-popup hidden>
      <p class="pc-agent-popup-title" data-popup-title>New Annotation</p>
      <p class="pc-agent-popup-target" data-popup-target>unknown target</p>

      <label class="pc-agent-popup-label" data-popup-selection-label>Current Selected Text</label>
      <p class="pc-agent-popup-selection" data-popup-selection>No page selection detected</p>

      <label class="pc-agent-popup-label" for="pc-agent-popup-body">Feedback Content</label>
      <textarea id="pc-agent-popup-body" class="pc-agent-popup-body" data-popup-body maxlength="2000" placeholder="Describe the issue or suggestion"></textarea>

      <label class="pc-agent-popup-label" for="pc-agent-popup-priority">Priority</label>
      <select id="pc-agent-popup-priority" class="pc-agent-popup-priority" data-popup-priority>
        <option value="low">low</option>
        <option value="normal" selected>normal</option>
        <option value="high">high</option>
        <option value="critical">critical</option>
      </select>

      <div class="pc-agent-popup-actions" data-popup-actions>
        <div class="pc-agent-popup-actions-secondary" data-popup-actions-secondary>
          <button type="button" class="pc-agent-popup-btn" data-popup-cancel>Cancel</button>
          <button type="button" class="pc-agent-popup-btn danger" data-popup-delete hidden>Delete Annotation</button>
        </div>
        <div class="pc-agent-popup-actions-primary" data-popup-actions-primary>
          <button type="submit" class="pc-agent-popup-btn primary" data-popup-submit>Submit Annotation</button>
        </div>
      </div>
      <p class="pc-agent-popup-status info" data-popup-status>Waiting for operation</p>
    </form>
  </div>
`;
