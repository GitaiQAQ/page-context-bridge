import { describe, expect, it } from "vitest";

// ── SUTs extracted from content-script.ts ──────────────────────────────
// These functions form the core data transformation layer between
// MAIN world Agentation events and the bridge adapter protocol.
// They are pure functions with no side effects, ideal for unit testing.

// Re-implemented here to avoid importing from content-script.ts (which pulls in chrome APIs).
// Keep these in sync with content-script.ts implementations.

function toFeedbackPriority(severity?: string): "critical" | "high" | "normal" {
  switch (severity) {
    case "blocking":
      return "critical";
    case "important":
      return "high";
    default:
      return "normal";
  }
}

function normalizeText(value?: string): string | undefined {
  return value?.trim() || undefined;
}

function normalizeId(value?: string): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function toCssSelectorCandidate(elementPath?: string): string | undefined {
  const path = elementPath?.trim();
  if (!path || path.includes("⟨shadow⟩")) return undefined;
  const segments = path
    .split(">")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return undefined;
  const leaf = segments.at(-1);
  if (!leaf) return undefined;
  if (/^#[A-Za-z0-9_-]+$/.test(leaf)) return leaf;
  if (/^\.[A-Za-z0-9_-]+$/.test(leaf)) return leaf;
  if (/^[A-Za-z][A-Za-z0-9-]*$/.test(leaf)) return leaf.toLowerCase();
  return undefined;
}

function resolveTargetRect(ann: { x?: number; y?: number; boundingBox?: { x: number; y: number; width: number; height: number }; isFixed?: boolean }, win: { innerWidth: number; innerHeight: number; scrollY: number }): DOMRectReadOnly {
  const box = ann.boundingBox;
  if (box) {
    const viewportY = ann.isFixed ? box.y : box.y - win.scrollY;
    return new DOMRectReadOnly(box.x, viewportY, Math.max(1, box.width), Math.max(1, box.height));
  }

  const vx = Number.isFinite(ann.x) ? (ann.x! / 100) * win.innerWidth : win.innerWidth / 2;
  const ry = Number.isFinite(ann.y) ? ann.y : win.innerHeight / 2;
  const vy = ann.isFixed ? ry : ry - win.scrollY;
  return new DOMRectReadOnly(vx, vy, 1, 1);
}

function buildUiAnchor(
  ann: { element?: string; elementPath?: string; fullPath?: string; reactComponents?: string; sourceFile?: string; isMultiSelect?: boolean; isFixed?: boolean },
  rect: DOMRectReadOnly,
  selectedText?: string,
): { cssSelector?: string; textQuote?: string; framePath: number[]; rect: { x: number; y: number; width: number; height: number }; meta: Record<string, unknown> } {
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

function buildCreatePayload(ann: { comment?: string; severity?: string; element?: string; elementPath?: string; fullPath?: string; reactComponents?: string; sourceFile?: string; isMultiSelect?: boolean; isFixed?: boolean; x?: number; y?: number; boundingBox?: { x: number; y: number; width: number; height: number }; selectedText?: string }, win: { innerWidth: number; innerHeight: number; scrollY: number } = window) {
  const body = ann.comment?.trim();
  if (!body) return null;

  const targetRect = resolveTargetRect(ann, win);
  const selText = normalizeText(ann.selectedText);

  return {
    body,
    priority: toFeedbackPriority(ann.severity),
    selectedText: selText,
    uiAnchor: buildUiAnchor(ann, targetRect, selText),
    target: {
      elementName: normalizeText(ann.element) ?? "element",
      elementPath: normalizeText(ann.elementPath) ?? "",
      rect: targetRect,
    },
  };
}

function isValidAnnotationEvent(detail: unknown): detail is {
  annotation: {
    id?: string;
    comment: string;
    severity?: "blocking" | "important" | "suggestion";
    timestamp: number;
  };
} {
  if (!detail || typeof detail !== "object") return false;
  const d = detail as { annotation?: unknown; timestamp?: unknown };
  if (!d.annotation || typeof d.annotation !== "object") return false;
  const a = d.annotation as { comment?: unknown; timestamp?: unknown };
  if (typeof a.comment !== "string" || !a.comment.trim()) return false;
  if (typeof d.timestamp !== "number" || d.timestamp <= 0) return false;
  if (Date.now() - d.timestamp > 60_000) return false;
  return true;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("content-script agentation conversion functions", () => {
  describe("toFeedbackPriority", () => {
    it('maps "blocking" to "critical"', () => {
      expect(toFeedbackPriority("blocking")).toBe("critical");
    });

    it('maps "important" to "high"', () => {
      expect(toFeedbackPriority("important")).toBe("high");
    });

    it('maps "suggestion" to "normal"', () => {
      expect(toFeedbackPriority("suggestion")).toBe("normal");
    });

    it('maps undefined to "normal"', () => {
      expect(toFeedbackPriority(undefined)).toBe("normal");
    });

    it('maps unknown severity to "normal"', () => {
      expect(toFeedbackPriority("unknown")).toBe("normal");
    });
  });

  describe("normalizeText", () => {
    it("trims whitespace", () => {
      expect(normalizeText("  hello  ")).toBe("hello");
    });

    it("returns undefined for empty string", () => {
      expect(normalizeText("   ")).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
      expect(normalizeText(undefined)).toBeUndefined();
    });
  });

  describe("normalizeId", () => {
    it("trims non-empty strings", () => {
      expect(normalizeId("  abc-123  ")).toBe("abc-123");
    });

    it("returns undefined for empty/whitespace-only", () => {
      expect(normalizeId("  ")).toBeUndefined();
      expect(normalizeId("")).toBeUndefined();
    });

    it("rejects non-string values", () => {
      expect(normalizeId(123 as unknown)).toBeUndefined();
    });
  });

  describe("toCssSelectorCandidate", () => {
    it("extracts ID selector from leaf element", () => {
      expect(toCssSelectorCandidate("div > span > #my-btn")).toBe("#my-btn");
    });

    it("extracts class selector from leaf element", () => {
      expect(toCssSelectorCandidate(".container > div > .item")).toBe(".item");
    });

    it("extracts tag selector", () => {
      expect(toCssSelectorCandidate("div > span > strong")).toBe("strong");
    });

    it("returns undefined for shadow DOM path", () => {
      expect(toCssSelectorCandidate("div > ⟨shadow⟩ > button")).toBeUndefined();
    });

    it("returns undefined for empty", () => {
      expect(toCssSelectorCandidate("")).toBeUndefined();
    });
  });

  describe("resolveTargetRect", () => {
    const mockWin = { innerWidth: 800, innerHeight: 600, scrollY: 0 };

    it("uses boundingBox when available", () => {
      const rect = resolveTargetRect({ boundingBox: { x: 10, y: 20, width: 100, height: 50 }, isFixed: false }, mockWin);
      expect(rect.x).toBe(10);
      expect(rect.y).toBe(20);
      expect(rect.width).toBe(100);
      expect(rect.height).toBe(50);
    });

    it("adjusts y for fixed elements", () => {
      const rect = resolveTargetRect({ boundingBox: { x: 10, y: 100, width: 100, height: 50 }, isFixed: true }, mockWin);
      expect(rect.y).toBe(100); // no scrollY subtraction for fixed
    });

    it("falls back to percentage-based position when no boundingBox", () => {
      const rect = resolveTargetRect({ x: 50, y: 200, isFixed: false }, mockWin);
      // x=50 means 50% → 400px on 800px viewport
      expect(rect.x).toBe(400);
      expect(rect.y).toBe(200); // non-fixed: y stays as-is (scrollY=0)
      expect(rect.width).toBe(1);
      expect(rect.height).toBe(1);
    });

    it("falls back to center when no coords at all", () => {
      const rect = resolveTargetRect({}, mockWin);
      expect(rect.x).toBe(400); // 50% of 800
      expect(rect.y).toBe(300); // 50% of 600
    });
  });

  describe("buildUiAnchor", () => {
    const baseRect = new DOMRectReadOnly(10, 20, 100, 50);

    it("includes source as agentation-main-world", () => {
      const anchor = buildUiAnchor({}, baseRect, "hello");
      expect(anchor.meta.source).toBe("agentation-main-world");
    });

    it("sets isMultiSelect flag when multi-select is true", () => {
      const anchor = buildUiAnchor({ isMultiSelect: true }, baseRect, "");
      expect(anchor.meta.isMultiSelect).toBe(true);
    });

    it("sets isFixed flag when fixed is true", () => {
      const anchor = buildUiAnchor({ isFixed: true }, baseRect, "");
      expect(anchor.meta.isFixed).toBe(true);
    });

    it("does not set flags by default", () => {
      const anchor = buildUiAnchor({}, baseRect, "");
      expect(anchor.meta.isMultiSelect).toBeUndefined();
      expect(anchor.meta.isFixed).toBeUndefined();
    });

    it("passes through cssSelector from toCssSelectorCandidate", () => {
      const anchor = buildUiAnchor({ elementPath: "div > #target" }, baseRect, "");
      expect(anchor.cssSelector).toBe("#target");
    });

    it("passes through textQuote", () => {
      const anchor = buildUiAnchor({}, baseRect, "selected text");
      expect(anchor.textQuote).toBe("selected text");
    });

    it("hardcodes framePath as [0]", () => {
      const anchor = buildUiAnchor({}, baseRect, "");
      expect(anchor.framePath).toEqual([0]);
    });

    it("copies rect correctly", () => {
      const anchor = buildUiAnchor({}, baseRect, "");
      expect(anchor.rect).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    });

    it("includes element/path/file metadata in meta", () => {
      const anchor = buildUiAnchor({
        element: "SubmitButton",
        elementPath: "form > .submit",
        fullPath: "App > Form > SubmitButton",
        reactComponents: "SubmitButton, Form",
        sourceFile: "SubmitButton.tsx",
      }, baseRect, "");

      expect(anchor.meta.element).toBe("SubmitButton");
      expect(anchor.meta.elementPath).toBe("form > .submit");
      expect(anchor.meta.fullPath).toBe("App > Form > SubmitButton");
      expect(anchor.meta.reactComponents).toBe("SubmitButton, Form");
      expect(anchor.meta.sourceFile).toBe("SubmitButton.tsx");
    });
  });

  describe("buildCreatePayload", () => {
    const mockWin = { innerWidth: 1024, innerHeight: 768, scrollY: 0 };

    it("returns null for empty comment", () => {
      expect(buildCreatePayload({ comment: "" }, mockWin)).toBeNull();
    });

    it("returns null for whitespace-only comment", () => {
      expect(buildCreatePayload({ comment: "   " }, mockWin)).toBeNull();
    });

    it("returns null for missing comment", () => {
      expect(buildCreatePayload({} as never, mockWin)).toBeNull();
    });

    it("builds correct payload for minimal input", () => {
      const payload = buildCreatePayload(
        { comment: "button is broken", severity: "blocking", element: "button", elementPath: "#btn" },
        mockWin,
      );
      expect(payload).toEqual({
        body: "button is broken",
        priority: "critical",
        selectedText: undefined,
        uiAnchor: {
          cssSelector: "#btn",
          textQuote: undefined,
          framePath: [0],
          rect: { x: 512, y: 384, width: 1, height: 1 },
          meta: {
            source: "agentation-main-world",
            element: "button",
            elementPath: "#btn",
            fullPath: undefined,
            reactComponents: undefined,
            sourceFile: undefined,
          },
        },
        target: {
          elementName: "button",
          elementPath: "#btn",
          rect: expect.any(DOMRectReadOnly),
        },
      });
    });

    it("uses normal priority for suggestion severity", () => {
      const payload = buildCreatePayload({ comment: "minor issue", severity: "suggestion" }, mockWin);
      expect(payload.priority).toBe("normal");
    });

    it("uses high priority for important severity", () => {
      const payload = buildCreatePayload({ comment: "major issue", severity: "important" }, mockWin);
      expect(payload.priority).toBe("high");
    });

    it("includes selectedText when present", () => {
      const payload = buildCreatePayload({ comment: "fix this", selectedText: "error text" }, mockWin);
      expect(payload.selectedText).toBe("error text");
    });

    it("uses boundingBox coordinates for rect", () => {
      const payload = buildCreatePayload(
        { comment: "test", boundingBox: { x: 42, y: 13, width: 200, height: 99 } },
        mockWin,
      );
      expect(payload.target.rect).toEqual(new DOMRectReadOnly(42, 13, 200, 99));
    });

    it("adjusts y coordinate for fixed elements", () => {
      const payload = buildCreatePayload(
        { comment: "fixed elem", boundingBox: { x: 0, y: 100, width: 50, height: 50 }, isFixed: true },
        mockWin,
      );
      expect(payload.target.rect.y).toBe(100); // no scrollY subtraction
    });

    it("falls back to percentage-based x when no boundingBox", () => {
      const payload = buildCreatePayload({ comment: "no box", x: 25 }, mockWin);
      // 25% of 1024 = 256
      expect(payload.target.rect.x).toBe(256);
    });
  });

  describe("isValidAnnotationEvent", () => {
    it("rejects null", () => {
      expect(isValidAnnotationEvent(null)).toBe(false);
    });

    it("rejects non-object", () => {
      expect(isValidAnnotationEvent("string")).toBe(false);
      expect(isValidAnnotationEvent(42)).toBe(false);
      expect(isValidAnnotationEvent([])).toBe(false);
    });

    it("rejects object without annotation", () => {
      expect(isValidAnnotationEvent({})).toBe(false);
    });

    it("rejects non-object annotation", () => {
      expect(isValidAnnotationEvent({ annotation: "bad" })).toBe(false);
    });

    it("rejects missing comment", () => {
      expect(isValidAnnotationEvent({ annotation: {} })).toBe(false);
      expect(isValidAnnotationEvent({ annotation: { comment: "" } })).toBe(false);
      expect(isValidAnnotationEvent({ annotation: { comment: "   " } })).toBe(false);
    });

    it("rejects non-string comment", () => {
      expect(isValidAnnotationEvent({ annotation: { comment: 123 } })).toBe(false);
    });

    it("rejects missing or zero timestamp", () => {
      expect(isValidAnnotationEvent({ annotation: { comment: "ok" }, timestamp: 0 })).toBe(false);
      expect(isValidAnnotationEvent({ annotation: { comment: "ok" }, timestamp: -1 })).toBe(false);
        expect(isValidAnnotationEvent({ annotation: { comment: "ok" } })).toBe(false);
    });

    it("rejects stale events older than 60s", () => {
      const old = Date.now() - 61_000;
      expect(isValidAnnotationEvent({ annotation: { comment: "ok" }, timestamp: old })).toBe(false);
    });

    it("accepts valid event within time window", () => {
      const now = Date.now();
      expect(isValidAnnotationEvent({ annotation: { comment: "ok" }, timestamp: now })).toBe(true);
    });

    it("accepts valid event at boundary", () => {
      const near = Date.now() - 59_999;
      expect(isValidAnnotationEvent({ annotation: { comment: "ok" }, timestamp: near })).toBe(true);
    });
  });
});
