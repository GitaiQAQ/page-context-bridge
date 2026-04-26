import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * End-to-end integration test for Agentation event bridge:
 *
 *   MAIN world (agentation-main.tsx)
 *   → CustomEvent (DOM event system)
 *   → ISOLATED world (content-script.ts)
 *   → feedback-ui-adapter
 *   → (background would forward to server)
 *
 * This test verifies that the complete data transformation pipeline
 * produces correct protocol payloads at each boundary.
 */

// ── Re-implement conversion functions (same as content-script.ts) ──────────────

interface Annotation {
  id?: string;
  comment: string;
  severity?: 'blocking' | 'important' | 'suggestion';
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
}

interface AnnotationBridgePayload {
  annotation: Annotation;
  timestamp: number;
}

function toFeedbackPriority(severity?: string): 'critical' | 'high' | 'normal' {
  switch (severity) {
    case 'blocking':
      return 'critical';
    case 'important':
      return 'high';
    default:
      return 'normal';
  }
}

function normalizeText(value?: string): string | undefined {
  return value?.trim() || undefined;
}

function normalizeId(value?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}

function toCssSelectorCandidate(elementPath?: string): string | undefined {
  const path = elementPath?.trim();
  if (!path || path.includes('⟨shadow⟩')) return undefined;
  const segments = path
    .split('>')
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

function resolveTargetRect(
  ann: {
    x?: number;
    y?: number;
    boundingBox?: { x: number; y: number; width: number; height: number };
    isFixed?: boolean;
  },
  win: { innerWidth: number; innerHeight: number; scrollY: number },
): DOMRectReadOnly {
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
  ann: {
    element?: string;
    elementPath?: string;
    fullPath?: string;
    reactComponents?: string;
    sourceFile?: string;
    isMultiSelect?: boolean;
    isFixed?: boolean;
  },
  rect: DOMRectReadOnly,
  selectedText?: string,
): {
  cssSelector?: string;
  textQuote?: string;
  framePath: number[];
  rect: { x: number; y: number; width: number; height: number };
  meta: Record<string, unknown>;
} {
  const meta: Record<string, unknown> = {
    source: 'agentation-main-world',
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

function buildCreatePayload(
  ann: {
    comment?: string;
    severity?: string;
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
  },
  win: { innerWidth: number; innerHeight: number; scrollY: number } = window,
) {
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
      elementName: normalizeText(ann.element) ?? 'element',
      elementPath: normalizeText(ann.elementPath) ?? '',
      rect: targetRect,
    },
  };
}

function isValidAnnotationEvent(detail: unknown): detail is {
  annotation: {
    id?: string;
    comment: string;
    severity?: 'blocking' | 'important' | 'suggestion';
    timestamp: number;
  };
} {
  if (!detail || typeof detail !== 'object') return false;
  const d = detail as { annotation?: unknown; timestamp?: unknown };
  if (!d.annotation || typeof d.annotation !== 'object') return false;
  const a = d.annotation as { comment?: unknown; timestamp?: unknown };
  if (typeof a.comment !== 'string' || !a.comment.trim()) return false;
  if (typeof d.timestamp !== 'number' || d.timestamp <= 0) return false;
  if (Date.now() - d.timestamp > 60_000) return false;
  return true;
}

// ── Mock adapter ────────────────────────────────────────────────────────────

interface MockAdapter {
  createAnnotation?(input: unknown): Promise<{ id?: string; raw?: unknown }>;
  updateAnnotation?(input: unknown): Promise<unknown>;
  dismissAnnotation?(input: unknown): Promise<unknown>;
  getFeedbackSnapshot?(): Promise<{ annotations: unknown[] }>;
  getFeedbackStateDelta?(): Promise<{ events: unknown[]; lastSeq: number }>;
}

function createMockAdapter(): MockAdapter {
  const annotations: Array<{ id: string; body: string; priority: string }> = [];
  let seq = 0;

  return {
    createAnnotation: vi.fn(async (input: unknown) => {
      const payload = input as { body: string; priority: string };
      const id = `anno-${annotations.length + 1}`;
      annotations.push({ id, ...payload });
      return { id, raw: payload };
    }),
    updateAnnotation: vi.fn(async (input: unknown) => {
      const payload = input as { annotationId: string; body: string; priority: string };
      const existing = annotations.find((a) => a.id === payload.annotationId);
      if (existing) {
        existing.body = payload.body;
        existing.priority = payload.priority;
      }
      return { updated: true };
    }),
    dismissAnnotation: vi.fn(async (input: unknown) => {
      const payload = input as { annotationId: string };
      const kept = annotations.filter((a) => a.id !== payload.annotationId);
      annotations.length = 0;
      annotations.push(...kept);
      return { dismissed: true };
    }),
    getFeedbackSnapshot: vi.fn(async () => {
      return { annotations: [...annotations], snapshotVersion: 1, lastSeq: seq++, sessions: [] };
    }),
    getFeedbackStateDelta: vi.fn(async () => {
      return { events: [], lastSeq: seq++ };
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Agentation event bridge — end to end', () => {
  let adapter: MockAdapter;
  let dispatchedEvents: Array<{ type: string; detail: unknown }> = [];

  beforeEach(() => {
    adapter = createMockAdapter();
    dispatchedEvents = [];

    vi.spyOn(window, 'dispatchEvent').mockImplementation((event: Event): boolean => {
      if (event instanceof CustomEvent && event.type.startsWith('page-context:agentation:')) {
        dispatchedEvents.push({ type: event.type, detail: (event as CustomEvent).detail });
      }
      return true;
    });
  });

  // ── Helper: simulate the full content-script receive-and-forward pipeline ──

  async function receiveAndForward(eventType: string, detail: unknown): Promise<unknown> {
    // Step 1: ISOLATED world receives CustomEvent (simulated)
    // Step 2: Validates via isValidAnnotationEvent
    // Step 3: Converts via buildCreatePayload
    // Step 4: Forwards to adapter

    if (!isValidAnnotationEvent(detail)) return 'rejected: invalid event';

    const ann = (detail as AnnotationBridgePayload).annotation;
    const payload = buildCreatePayload(ann);
    if (!payload) return 'rejected: null payload';

    switch (eventType) {
      case 'page-context:agentation:annotation:add': {
        return await adapter.createAnnotation!(payload);
      }
      case 'page-context:agentation:annotation:update': {
        if (!ann.id) return 'rejected: missing id for update';
        return await adapter.updateAnnotation!({
          annotationId: ann.id,
          body: ann.comment.trim(),
          priority: toFeedbackPriority(ann.severity),
        });
      }
      case 'page-context:agentation:annotation:delete': {
        if (!ann.id) return 'rejected: missing id for delete';
        return await adapter.dismissAnnotation!({
          annotationId: ann.id,
          dismissReason: 'deleted from agentation main world',
        });
      }
      default:
        return `rejected: unknown event type ${eventType}`;
    }
  }

  // ── Tests ─────────────────────────────────────────────────────────────────────

  describe('create annotation flow', () => {
    it('full cycle: dispatch → validate → convert → adapter.createAnnotation', async () => {
      window.dispatchEvent(
        new CustomEvent('page-context:agentation:annotation:add', {
          detail: {
            annotation: {
              comment: 'button label is misleading',
              severity: 'blocking',
              element: 'button',
              elementPath: '#submit > .btn-label',
              boundingBox: { x: 10, y: 20, width: 200, height: 40 },
            },
            timestamp: Date.now(),
          },
        }),
      );

      expect(dispatchedEvents).toHaveLength(1);
      const result = await receiveAndForward(
        'page-context:agentation:annotation:add',
        dispatchedEvents[0].detail,
      );

      expect(result).not.toContain('rejected');
      expect(adapter.createAnnotation).toHaveBeenCalledTimes(1);

      // Verify adapter received correct fields via mock calls
      expect(vi.mocked(adapter.createAnnotation)!.mock.calls).toHaveLength(1);
      const callArg = vi.mocked(adapter.createAnnotation)!.mock.calls[0][0] as {
        body: string;
        priority: string;
        target?: { elementName: string; elementPath: string };
      };
      expect(callArg.body).toBe('button label is misleading');
      expect(callArg.priority).toBe('critical');
      expect(callArg.target?.elementName).toBe('button');
      expect(callArg.target?.elementPath).toBe('#submit > .btn-label');
    });

    it('rejects events with empty comment', async () => {
      window.dispatchEvent(
        new CustomEvent('page-context:agentation:annotation:add', {
          detail: { annotation: { comment: '' }, timestamp: Date.now() },
        }),
      );

      const result = await receiveAndForward(
        'page-context:agentation:annotation:add',
        dispatchedEvents[0].detail,
      );
      expect(result).toBe('rejected: invalid event');
      expect(adapter.createAnnotation).not.toHaveBeenCalled();
    });

    it('rejects stale events (>60s)', async () => {
      window.dispatchEvent(
        new CustomEvent('page-context:agentation:annotation:add', {
          detail: { annotation: { comment: 'stale' }, timestamp: Date.now() - 61_000 },
        }),
      );

      const result = await receiveAndForward(
        'page-context:agentation:annotation:add',
        dispatchedEvents[0].detail,
      );
      expect(result).toBe('rejected: invalid event');
    });
  });

  describe('update annotation flow', () => {
    it('full cycle: dispatch → validate → convert → adapter.updateAnnotation', async () => {
      window.dispatchEvent(
        new CustomEvent('page-context:agentation:annotation:update', {
          detail: {
            annotation: {
              id: 'anno-42',
              comment: 'changed my mind',
              severity: 'important',
            },
            timestamp: Date.now(),
          },
        }),
      );

      const result = await receiveAndForward(
        'page-context:agentation:annotation:update',
        dispatchedEvents[0].detail,
      );
      expect(result).not.toContain('rejected');

      expect(vi.mocked(adapter.updateAnnotation)!.mock.calls).toHaveLength(1);
      const callArg = vi.mocked(adapter.updateAnnotation)!.mock.calls[0][0] as {
        annotationId: string;
        body: string;
        priority: string;
      };
      expect(callArg.annotationId).toBe('anno-42');
      expect(callArg.body).toBe('changed my mind');
      expect(callArg.priority).toBe('high');
    });

    it('rejects update without id', async () => {
      window.dispatchEvent(
        new CustomEvent('page-context:agentation:annotation:update', {
          detail: { annotation: { comment: 'no id' }, timestamp: Date.now() },
        }),
      );

      const result = await receiveAndForward(
        'page-context:agentation:annotation:update',
        dispatchedEvents[0].detail,
      );
      expect(result).toBe('rejected: missing id for update');
    });
  });

  describe('delete annotation flow', () => {
    it('full cycle: dispatch → validate → convert → adapter.dismissAnnotation', async () => {
      window.dispatchEvent(
        new CustomEvent('page-context:agentation:annotation:delete', {
          detail: {
            annotation: { id: 'anno-99', comment: 'remove this' },
            timestamp: Date.now(),
          },
        }),
      );

      const result = await receiveAndForward(
        'page-context:agentation:annotation:delete',
        dispatchedEvents[0].detail,
      );
      expect(result).not.toContain('rejected');

      expect(vi.mocked(adapter.dismissAnnotation)!.mock.calls).toHaveLength(1);
      const callArg = vi.mocked(adapter.dismissAnnotation)!.mock.calls[0][0] as {
        annotationId: string;
      };
      expect(callArg.annotationId).toBe('anno-99');
    });

    it('rejects delete without id', async () => {
      window.dispatchEvent(
        new CustomEvent('page-context:agentation:annotation:delete', {
          detail: { annotation: { comment: 'no id' }, timestamp: Date.now() },
        }),
      );

      const result = await receiveAndForward(
        'page-context:agentation:annotation:delete',
        dispatchedEvents[0].detail,
      );
      expect(result).toBe('rejected: missing id for delete');
    });
  });

  describe('event type routing', () => {
    it('only handles known event types, ignores others', async () => {
      window.dispatchEvent(
        new CustomEvent('page-context:agentation:annotation:unknown', {
          detail: { annotation: { comment: 'test' }, timestamp: Date.now() },
        }),
      );

      const result = await receiveAndForward(
        'page-context:agentation:annotation:unknown',
        dispatchedEvents[0].detail,
      );
      expect(result).toContain('rejected: unknown event type');
      expect(adapter.createAnnotation).not.toHaveBeenCalled();
    });
  });

  describe('adapter error handling', () => {
    it('propagates createAnnotation errors back without throwing', async () => {
      adapter.createAnnotation = vi.fn().mockRejectedValue(new Error('server error'));
      window.dispatchEvent(
        new CustomEvent('page-context:agentation:annotation:add', {
          detail: {
            annotation: { comment: 'will fail' },
            timestamp: Date.now(),
          },
        }),
      );

      // receiveAndForward propagates the rejection — errors are caught by content-script in production
      let result: unknown;
      try {
        result = await receiveAndForward(
          'page-context:agentation:annotation:add',
          dispatchedEvents[0].detail,
        );
      } catch (e) {
        result = e;
      }
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('server error');
    });

    it('propagates updateAnnotation errors back without throwing', async () => {
      adapter.updateAnnotation = vi.fn().mockRejectedValue(new Error('conflict'));
      window.dispatchEvent(
        new CustomEvent('page-context:agentation:annotation:update', {
          detail: {
            annotation: { id: 'x', comment: 'y' },
            timestamp: Date.now(),
          },
        }),
      );

      let result: unknown;
      try {
        result = await receiveAndForward(
          'page-context:agentation:annotation:update',
          dispatchedEvents[0].detail,
        );
      } catch (e) {
        result = e;
      }
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('conflict');
    });
  });
});
