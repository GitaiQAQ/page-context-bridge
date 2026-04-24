import { BRIDGE_METHODS } from "@page-context/shared-protocol";
import { createConsoleCapture, executeContentScriptTool, type ConsoleEntry } from "@page-context/builtin-tools";
import { createFeedbackUiAdapter } from "./feedback-ui-adapter";
import { createRuntimeListener, sendRuntimeRequest } from "./runtime-rpc";

const consoleEntries: ConsoleEntry[] = [];

function log(...args: unknown[]): void {
  console.log("[PAGE-CONTEXT-CS]", ...args);
}

createConsoleCapture(window, consoleEntries);
const feedbackUiAdapter = createFeedbackUiAdapter();

// ── Trigger MAIN world Agentation injection ──
// Agentation UI (including react-detection.ts) now runs in the MAIN world,
// Object.keys(element) can directly see the __reactFiber$xxx property.
void sendRuntimeRequest(BRIDGE_METHODS.extensionAgentationMainEnsure).catch((error) => {
  log("Failed to ensure MAIN world Agentation", error);
});

// ── Listen to MAIN world Agentation callback events ──
// CustomEvent can cross Chrome Extension World boundaries (shared DOM event system)
// Agentation in the MAIN world sends annotation operations via dispatchEvent, which are received and forwarded to the bridge here.

interface AgentationAnnotationEventDetail {
  annotation: {
    id?: string;
    comment: string;
    severity?: "blocking" | "important" | "suggestion";
    element?: string;
    elementPath?: string;
    fullPath?: string;
    reactComponents?: string;
    sourceFile?: string;
    isMultiSelect?: boolean;
    isFixed?: boolean;
    x?: number;
    y?: number;
    boundingBox?: { x: number; y: number; width: number; height: number };
    selectedText?: string;
  };
  timestamp: number;
}

/** Basic validation: discard events with no annotation, no comment, or outdated timestamps */
function isValidAnnotationEvent(detail: unknown): detail is AgentationAnnotationEventDetail {
  if (!detail || typeof detail !== "object") return false;
  const d = detail as AgentationAnnotationEventDetail;
  if (!d.annotation || typeof d.annotation !== "object") return false;
  if (typeof d.annotation.comment !== "string" || !d.annotation.comment.trim()) return false;
  if (typeof d.timestamp !== "number" || d.timestamp <= 0) return false;
  // Discard events older than 60s to prevent replay attacks
  if (Date.now() - d.timestamp > 60_000) return false;
  return true;
}

window.addEventListener("page-context:agentation:annotation:add", ((event: Event) => {
  const detail = (event as CustomEvent<AgentationAnnotationEventDetail>).detail;
  if (!isValidAnnotationEvent(detail)) return;

  const payload = buildCreatePayload(detail.annotation);
  if (!payload) return;

  void feedbackUiAdapter.createAnnotation?.(payload)?.catch((error) => {
    log("Failed to create annotation from MAIN world Agentation", error);
  });
}) as EventListener);

window.addEventListener("page-context:agentation:annotation:update", ((event: Event) => {
  const detail = (event as CustomEvent<AgentationAnnotationEventDetail>).detail;
  if (!isValidAnnotationEvent(detail)) return;

  const id = normalizeId(detail.annotation.id);
  const body = detail.annotation.comment.trim();
  if (!id || !body) return;

  void feedbackUiAdapter.updateAnnotation?.({
    annotationId: id,
    body,
    priority: toFeedbackPriority(detail.annotation.severity),
  }).catch((error) => {
    log("Failed to update annotation from MAIN world Agentation", error);
  });
}) as EventListener);

window.addEventListener("page-context:agentation:annotation:delete", ((event: Event) => {
  const detail = (event as CustomEvent<AgentationAnnotationEventDetail>).detail;
  if (!isValidAnnotationEvent(detail)) return;

  const id = normalizeId(detail.annotation.id);
  if (!id) return;

  void feedbackUiAdapter.dismissAnnotation?.({
    annotationId: id,
    dismissReason: "deleted from agentation main world",
  }).catch((error) => {
    log("Failed to dismiss annotation from MAIN world Agentation", error);
  });
}) as EventListener);

// ── Tool execution listener (remains unchanged) ──

chrome.runtime.onMessage.addListener(
  createRuntimeListener(async (message) => {
    switch (message.method) {
      case BRIDGE_METHODS.extensionToolExecute: {
        const payload = (message.params ?? {}) as { tool: string; args?: Record<string, unknown> };
        return executeContentScriptTool(payload.tool, payload.args ?? {}, {
          win: window,
          doc: document,
          consoleEntries,
        });
      }
      default:
        throw new Error(`Unknown content-script method: ${message.method}`);
    }
  }),
);

// ── Page event forwarding (remains unchanged) ──

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }
  const data = event.data;
  if (!data || typeof data !== "object") {
    return;
  }

  if ((data as { type?: string }).type === "PAGE_CONTEXT_REQUEST") {
    log("Forwarding page context request from page to background");
    void sendRuntimeRequest(BRIDGE_METHODS.extensionPageEvent, {
      payload: (data as { payload?: unknown }).payload,
    }).catch((error) => {
      log("Failed to forward page event", error);
    });
  }
});

// ── Helper function: convert Agentation raw annotation to bridge payload ──

function buildCreatePayload(ann: AgentationAnnotationEventDetail["annotation"]) {
  const body = ann.comment?.trim();
  if (!body) return null;

  const targetRect = resolveTargetRect(ann);
  const selectedText = normalizeText(ann.selectedText);

  return {
    body,
    priority: toFeedbackPriority(ann.severity),
    selectedText,
    uiAnchor: buildUiAnchor(ann, targetRect, selectedText),
    target: {
      elementName: normalizeText(ann.element) ?? "element",
      elementPath: normalizeText(ann.elementPath) ?? "",
      rect: targetRect,
    },
  };
}

function resolveTargetRect(ann: AgentationAnnotationEventDetail["annotation"]): DOMRectReadOnly {
  const box = ann.boundingBox;
  if (box) {
    const viewportY = ann.isFixed ? box.y : box.y - window.scrollY;
    return new DOMRectReadOnly(box.x, viewportY, Math.max(1, box.width), Math.max(1, box.height));
  }

  const vx = Number.isFinite(ann.x) ? (ann.x! / 100) * window.innerWidth : window.innerWidth / 2;
  const ry = Number.isFinite(ann.y) ? ann.y! : window.innerHeight / 2;
  const vy = ann.isFixed ? ry : ry - window.scrollY;
  return new DOMRectReadOnly(vx, vy, 1, 1);
}

function buildUiAnchor(
  ann: AgentationAnnotationEventDetail["annotation"],
  rect: DOMRectReadOnly,
  selectedText?: string,
) {
  const meta: Record<string, unknown> = {
    source: "agentation-main-world",
    element: normalizeText(ann.element),
    elementPath: normalizeText(ann.elementPath),
    fullPath: normalizeText(ann.fullPath),
    reactComponents: normalizeText(ann.reactComponents),
    sourceFile: normalizeText(ann.sourceFile),
  };
  if (ann.isMultiSelect) meta.isMultiSelect = true;
  if (ann.isFixed) meta.isFixed = true;

  return {
    cssSelector: toCssSelectorCandidate(ann.elementPath),
    textQuote: selectedText,
    framePath: [0],
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    meta,
  };
}

function toFeedbackPriority(severity?: string): "critical" | "high" | "normal" {
  switch (severity) {
    case "blocking": return "critical";
    case "important": return "high";
    default: return "normal";
  }
}

function toCssSelectorCandidate(elementPath?: string): string | undefined {
  const path = elementPath?.trim();
  if (!path || path.includes("⟨shadow⟩")) return undefined;
  const segments = path.split(">").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return undefined;
  const leaf = segments.at(-1);
  if (!leaf) return undefined;
  if (/^#[A-Za-z0-9_-]+$/.test(leaf)) return leaf;
  if (/^\.[A-Za-z0-9_-]+$/.test(leaf)) return leaf;
  if (/^[A-Za-z][A-Za-z0-9-]*$/.test(leaf)) return leaf.toLowerCase();
  return undefined;
}

function normalizeText(value?: string): string | undefined {
  return value?.trim() || undefined;
}

function normalizeId(value?: string): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

window.__PAGE_CONTEXT_BRIDGE_DEMO__ = () => {
  const selection = window.getSelection();
  const text = selection ? selection.toString() : "";

  window.postMessage(
    {
      type: "PAGE_CONTEXT_REQUEST",
      payload: {
        type: "demo.selection",
        text,
      },
    },
    "*",
  );
};

declare global {
  interface Window {
    __PAGE_CONTEXT_BRIDGE_DEMO__?: () => void;
  }
}
