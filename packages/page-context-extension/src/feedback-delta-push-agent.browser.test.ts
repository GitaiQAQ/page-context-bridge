import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BRIDGE_METHODS } from '@page-context/shared-protocol';
import { createFeedbackUiAdapter } from './feedback-ui-adapter';

// ── Type re-exports for test readability ───────────────────────────────────

interface FeedbackEvent {
  eventId: string;
  tenantId: string;
  sessionId: string;
  annotationId?: string;
  seq: number;
  eventType:
    | 'session.started'
    | 'annotation.created'
    | 'annotation.updated'
    | 'annotation.claimed'
    | 'annotation.replied'
    | 'annotation.resolved'
    | 'annotation.dismissed';
  occurredAt: string;
  source: string;
  payload: Record<string, unknown>;
}

interface FeedbackStateDeltaResult {
  events: FeedbackEvent[];
  lastSeq: number;
}

interface FeedbackStateSnapshotResult {
  sessions: Array<{ id: string; tabId: number; url: string; title: string }>;
  annotations: Array<unknown>;
  snapshotVersion: number;
  lastSeq: number;
  pushAgent?: {
    enabled: boolean;
    readiness: 'ready' | 'disabled';
    mode?: string;
    lastLaunch: {
      annotationId: string;
      sessionId: string;
      attemptedAt: string;
      result: 'success' | 'failed';
      failureReason?: string;
    } | null;
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('feedback-ui-adapter — delta & pushAgent integration', () => {
  let sendRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendRequest = vi.fn();
  });

  // ── Snapshot + pushAgent observability ─────────────────────────────────

  describe('getFeedbackSnapshot — pushAgent status', () => {
    it('passes through pushAgent enabled/ready state from bridge', async () => {
      sendRequest.mockResolvedValueOnce({
        sessions: [{ id: 's1', tabId: 42, url: 'https://example.com', title: 'Test' }],
        annotations: [],
        snapshotVersion: 5,
        lastSeq: 100,
        pushAgent: {
          enabled: true,
          readiness: 'ready',
          mode: 'local-opencode',
          lastLaunch: null,
        },
      } satisfies FeedbackStateSnapshotResult);

      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });
      const snapshot = await adapter.getFeedbackSnapshot!();

      expect(snapshot.pushAgent).toBeDefined();
      expect(snapshot.pushAgent!.enabled).toBe(true);
      expect(snapshot.pushAgent!.readiness).toBe('ready');
      expect(snapshot.pushAgent!.mode).toBe('local-opencode');
      expect(snapshot.pushAgent!.lastLaunch).toBeNull();
      expect(sendRequest).toHaveBeenCalledWith(BRIDGE_METHODS.extensionFeedbackStateSnapshot);
    });

    it('passes through pushAgent lastLaunch failure info for UI diagnostics', async () => {
      sendRequest.mockResolvedValueOnce({
        sessions: [],
        annotations: [],
        snapshotVersion: 3,
        lastSeq: 50,
        pushAgent: {
          enabled: true,
          readiness: 'disabled',
          lastLaunch: {
            annotationId: 'anno-77',
            sessionId: 'sess-9',
            attemptedAt: '2026-04-23T01:23:45.000Z',
            result: 'failed',
            failureReason: 'ENOENT: opencode not found',
          },
        },
      } satisfies FeedbackStateSnapshotResult);

      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });
      const snapshot = await adapter.getFeedbackSnapshot!();

      expect(snapshot.pushAgent!.readiness).toBe('disabled');
      expect(snapshot.pushAgent!.lastLaunch).not.toBeNull();
      expect(snapshot.pushAgent!.lastLaunch!.result).toBe('failed');
      expect(snapshot.pushAgent!.lastLaunch!.failureReason).toContain('ENOENT');
      expect(snapshot.pushAgent!.lastLaunch!.annotationId).toBe('anno-77');
    });

    it('returns undefined pushAgent when bridge does not provide it', async () => {
      sendRequest.mockResolvedValueOnce({
        sessions: [],
        annotations: [],
        snapshotVersion: 1,
        lastSeq: 0,
        // No pushAgent field — agent push not configured on server
      } satisfies FeedbackStateSnapshotResult);

      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });
      const snapshot = await adapter.getFeedbackSnapshot!();

      expect(snapshot.pushAgent).toBeUndefined();
    });

    it('passes through successful lastLaunch for healthy state display', async () => {
      sendRequest.mockResolvedValueOnce({
        sessions: [],
        annotations: [],
        snapshotVersion: 10,
        lastSeq: 200,
        pushAgent: {
          enabled: true,
          readiness: 'ready',
          lastLaunch: {
            annotationId: 'anno-1',
            sessionId: 'sess-1',
            attemptedAt: '2026-04-23T02:00:00.000Z',
            result: 'success',
          },
        },
      } satisfies FeedbackStateSnapshotResult);

      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });
      const snapshot = await adapter.getFeedbackSnapshot!();

      expect(snapshot.pushAgent!.lastLaunch!.result).toBe('success');
      expect(snapshot.pushAgent!.lastLaunch!.failureReason).toBeUndefined();
    });
  });

  // ── Delta cursor & event stream ────────────────────────────────────────

  describe('getFeedbackStateDelta — cursor semantics', () => {
    it('sends afterSeq=0 on first delta call (initial sync)', async () => {
      sendRequest.mockResolvedValueOnce({
        events: [
          {
            eventId: 'evt-1',
            tenantId: 't1',
            sessionId: 's1',
            seq: 1,
            eventType: 'session.started',
            occurredAt: '2026-04-23T00:00:00.000Z',
            source: 'system',
            payload: {},
          },
        ],
        lastSeq: 1,
      } satisfies FeedbackStateDeltaResult);

      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });
      const delta = await adapter.getFeedbackStateDelta!();

      expect(delta.events).toHaveLength(1);
      expect(delta.events[0].eventType).toBe('session.started');
      expect(delta.lastSeq).toBe(1);

      // Verify the request sent afterSeq=0 (initial cursor)
      expect(sendRequest).toHaveBeenCalledWith(BRIDGE_METHODS.extensionFeedbackStateDelta, {
        afterSeq: 0,
      });
    });

    it('advances cursor after snapshot sets baseline', async () => {
      // Step 1: snapshot establishes baseline seq
      sendRequest.mockResolvedValueOnce({
        sessions: [{ id: 's1', tabId: 1, url: 'https://a.com', title: 'A' }],
        annotations: [],
        snapshotVersion: 2,
        lastSeq: 42,
      } satisfies FeedbackStateSnapshotResult);

      // Step 2: delta should use seq=42 as afterSeq
      sendRequest.mockResolvedValueOnce({
        events: [
          {
            eventId: 'evt-43',
            tenantId: 't1',
            sessionId: 's1',
            annotationId: 'anno-new',
            seq: 43,
            eventType: 'annotation.created',
            occurredAt: '2026-04-23T01:00:00.000Z',
            source: 'user',
            payload: { body: 'new feedback' },
          },
        ],
        lastSeq: 43,
      } satisfies FeedbackStateDeltaResult);

      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });

      await adapter.getFeedbackSnapshot!(); // Sets cursor to 42
      const delta = await adapter.getFeedbackStateDelta!(); // Should send afterSeq=42

      expect(sendRequest).toHaveBeenCalledTimes(2);
      // Second call should be delta with afterSeq=42
      expect(sendRequest).toHaveBeenNthCalledWith(2, BRIDGE_METHODS.extensionFeedbackStateDelta, {
        afterSeq: 42,
      });
      expect(delta.events[0].eventType).toBe('annotation.created');
      expect(delta.events[0].annotationId).toBe('anno-new');
    });

    it('chains multiple deltas with advancing cursor', async () => {
      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });

      // Delta 1: seq 1→5
      sendRequest.mockResolvedValueOnce({
        events: Array.from({ length: 4 }, (_, i) => ({
          eventId: `evt-${i + 1}`,
          tenantId: 't1',
          sessionId: 's1',
          seq: i + 2,
          eventType: 'annotation.created' as const,
          occurredAt: '2026-04-23T01:00:00.000Z',
          source: 'user',
          payload: {},
        })),
        lastSeq: 5,
      } satisfies FeedbackStateDeltaResult);

      // Delta 2: seq 5→8
      sendRequest.mockResolvedValueOnce({
        events: Array.from({ length: 3 }, (_, i) => ({
          eventId: `evt-${i + 5}`,
          tenantId: 't1',
          sessionId: 's1',
          annotationId: `anno-${i}`,
          seq: i + 6,
          eventType: 'annotation.updated' as const,
          occurredAt: '2026-04-23T02:00:00.000Z',
          source: 'agent',
          payload: {},
        })),
        lastSeq: 8,
      } satisfies FeedbackStateDeltaResult);

      const delta1 = await adapter.getFeedbackStateDelta!(); // afterSeq=0 → lastSeq=5
      const delta2 = await adapter.getFeedbackStateDelta!(); // afterSeq=5 → lastSeq=8

      expect(delta1.events).toHaveLength(4);
      expect(delta1.lastSeq).toBe(5);
      expect(delta2.events).toHaveLength(3);
      expect(delta2.lastSeq).toBe(8);

      // Verify cursor advanced correctly
      expect(sendRequest).toHaveBeenNthCalledWith(1, BRIDGE_METHODS.extensionFeedbackStateDelta, {
        afterSeq: 0,
      });
      expect(sendRequest).toHaveBeenNthCalledWith(2, BRIDGE_METHODS.extensionFeedbackStateDelta, {
        afterSeq: 5,
      });
    });

    it('returns empty events when no new activity since last seq', async () => {
      sendRequest.mockResolvedValueOnce({
        events: [],
        lastSeq: 0,
      } satisfies FeedbackStateDeltaResult);

      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });
      const delta = await adapter.getFeedbackStateDelta!();

      expect(delta.events).toHaveLength(0);
      expect(delta.lastSeq).toBe(0);
    });
  });

  // ── Delta event types — full annotation lifecycle ──────────────────────

  describe('getFeedbackStateDelta — annotation lifecycle events', () => {
    it('delivers annotation.created event with correct shape', async () => {
      sendRequest.mockResolvedValueOnce({
        events: [
          {
            eventId: 'evt-created-1',
            tenantId: 't1',
            sessionId: 's1',
            annotationId: 'anno-42',
            seq: 10,
            eventType: 'annotation.created',
            occurredAt: '2026-04-23T03:00:00.000Z',
            source: 'user',
            payload: {
              body: 'Button is broken',
              priority: 'critical',
              elementName: 'SubmitButton',
            },
          },
        ],
        lastSeq: 10,
      } satisfies FeedbackStateDeltaResult);

      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });
      const delta = await adapter.getFeedbackStateDelta!();

      const evt = delta.events[0];
      expect(evt.eventType).toBe('annotation.created');
      expect(evt.annotationId).toBe('anno-42');
      expect(evt.seq).toBe(10);
      expect(evt.source).toBe('user');
      expect(evt.payload.body).toBe('Button is broken');
      expect(evt.payload.priority).toBe('critical');
    });

    it('delivers mixed event types in a single delta batch', async () => {
      sendRequest.mockResolvedValueOnce({
        events: [
          {
            eventId: 'evt-a',
            tenantId: 't1',
            sessionId: 's1',
            annotationId: 'anno-1',
            seq: 20,
            eventType: 'annotation.created',
            occurredAt: '2026-04-23T04:00:00.000Z',
            source: 'user',
            payload: {},
          },
          {
            eventId: 'evt-b',
            tenantId: 't1',
            sessionId: 's1',
            annotationId: 'anno-1',
            seq: 21,
            eventType: 'annotation.claimed',
            occurredAt: '2026-04-23T04:01:00.000Z',
            source: 'agent',
            payload: { actor: 'agent-1' },
          },
          {
            eventId: 'evt-c',
            tenantId: 't1',
            sessionId: 's1',
            annotationId: 'anno-1',
            seq: 22,
            eventType: 'annotation.replied',
            occurredAt: '2026-04-23T04:02:00.000Z',
            source: 'agent',
            payload: { body: 'Working on it', kind: 'reply' },
          },
          {
            eventId: 'evt-d',
            tenantId: 't1',
            sessionId: 's1',
            annotationId: 'anno-1',
            seq: 23,
            eventType: 'annotation.resolved',
            occurredAt: '2026-04-23T05:00:00.000Z',
            source: 'agent',
            payload: { resolution: 'Fixed click handler' },
          },
        ],
        lastSeq: 23,
      } satisfies FeedbackStateDeltaResult);

      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });
      const delta = await adapter.getFeedbackStateDelta!();

      expect(delta.events).toHaveLength(4);
      expect(delta.events.map((e) => e.eventType)).toEqual([
        'annotation.created',
        'annotation.claimed',
        'annotation.replied',
        'annotation.resolved',
      ]);
      // All events belong to same annotation
      expect(delta.events.every((e) => e.annotationId === 'anno-1')).toBe(true);
      // Seq is monotonically increasing
      expect(delta.events.map((e) => e.seq)).toEqual([20, 21, 22, 23]);
    });

    it('delivers annotation.dismissed event', async () => {
      sendRequest.mockResolvedValueOnce({
        events: [
          {
            eventId: 'evt-dismiss-1',
            tenantId: 't1',
            sessionId: 's1',
            annotationId: 'anno-99',
            seq: 30,
            eventType: 'annotation.dismissed',
            occurredAt: '2026-04-23T06:00:00.000Z',
            source: 'user',
            payload: { dismissReason: 'duplicate' },
          },
        ],
        lastSeq: 30,
      } satisfies FeedbackStateDeltaResult);

      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });
      const delta = await adapter.getFeedbackStateDelta!();

      expect(delta.events[0].eventType).toBe('annotation.dismissed');
      expect(delta.events[0].payload.dismissReason).toBe('duplicate');
    });
  });

  // ── Cursor robustness ──────────────────────────────────────────────────

  describe('cursor robustness — edge cases', () => {
    it('falls back to current cursor when delta returns invalid lastSeq', async () => {
      // First call establishes cursor at seq=10
      sendRequest.mockResolvedValueOnce({
        events: [
          {
            eventId: 'e1',
            tenantId: 't1',
            sessionId: 's1',
            seq: 10,
            eventType: 'session.started',
            occurredAt: '',
            source: 'system',
            payload: {},
          },
        ],
        lastSeq: 10,
      } satisfies FeedbackStateDeltaResult);

      // Second call returns invalid lastSeq (negative)
      sendRequest.mockResolvedValueOnce({
        events: [],
        lastSeq: -1,
      } satisfies FeedbackStateDeltaResult);

      // Third call should still use fallback (10), not -1
      sendRequest.mockResolvedValueOnce({
        events: [
          {
            eventId: 'e2',
            tenantId: 't1',
            sessionId: 's1',
            seq: 11,
            eventType: 'annotation.created',
            occurredAt: '',
            source: 'user',
            payload: {},
          },
        ],
        lastSeq: 11,
      } satisfies FeedbackStateDeltaResult);

      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });

      await adapter.getFeedbackStateDelta!(); // → cursor = 10
      await adapter.getFeedbackStateDelta!(); // → lastSeq=-1, cursor stays at 10
      await adapter.getFeedbackStateDelta!(); // → should send afterSeq=10 (fallback)

      expect(sendRequest).toHaveBeenNthCalledWith(3, BRIDGE_METHODS.extensionFeedbackStateDelta, {
        afterSeq: 10,
      });
    });

    it('falls back to current cursor when delta returns non-numeric lastSeq', async () => {
      sendRequest.mockResolvedValueOnce({
        events: [],
        lastSeq: 'NaN' as unknown as number,
      } satisfies FeedbackStateDeltaResult);

      // After this, next delta should use afterSeq=0 (initial fallback)
      sendRequest.mockResolvedValueOnce({
        events: [],
        lastSeq: 0,
      } satisfies FeedbackStateDeltaResult);

      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });

      await adapter.getFeedbackStateDelta!(); // bad lastSeq
      await adapter.getFeedbackStateDelta!(); // should use fallback

      expect(sendRequest).toHaveBeenNthCalledWith(2, BRIDGE_METHODS.extensionFeedbackStateDelta, {
        afterSeq: 0,
      });
    });

    it('snapshot resets cursor even if delta had advanced further', async () => {
      // Delta advances to 50
      sendRequest.mockResolvedValueOnce({
        events: [],
        lastSeq: 50,
      } satisfies FeedbackStateDeltaResult);

      // Snapshot reports lower seq=20 (e.g., server compaction)
      sendRequest.mockResolvedValueOnce({
        sessions: [],
        annotations: [],
        snapshotVersion: 1,
        lastSeq: 20,
      } satisfies FeedbackStateSnapshotResult);

      // Next delta should use afterSeq=20 (snapshot wins)
      sendRequest.mockResolvedValueOnce({
        events: [],
        lastSeq: 20,
      } satisfies FeedbackStateDeltaResult);

      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });

      await adapter.getFeedbackStateDelta!(); // cursor → 50
      await adapter.getFeedbackSnapshot!(); // cursor → 20 (reset by snapshot)
      await adapter.getFeedbackStateDelta!(); // should send afterSeq=20

      expect(sendRequest).toHaveBeenNthCalledWith(3, BRIDGE_METHODS.extensionFeedbackStateDelta, {
        afterSeq: 20,
      });
    });
  });

  // ── End-to-end: create → snapshot shows pushAgent ─────────────────────

  describe('end-to-end: create annotation then observe pushAgent via snapshot', () => {
    it('full flow: createAnnotation → getSnapshot returns pushAgent launch record', async () => {
      // Step 1: Create annotation
      sendRequest.mockResolvedValueOnce({
        annotation: { id: 'anno-new-1' },
      });

      // Step 2: Snapshot reflects the push that server triggered
      sendRequest.mockResolvedValueOnce({
        sessions: [{ id: 's1', tabId: 7, url: 'https://test.com', title: 'Test Page' }],
        annotations: [{ id: 'anno-new-1', status: 'open', body: 'fix this button' }],
        snapshotVersion: 6,
        lastSeq: 55,
        pushAgent: {
          enabled: true,
          readiness: 'ready',
          mode: 'local-opencode',
          lastLaunch: {
            annotationId: 'anno-new-1',
            sessionId: 's1',
            attemptedAt: '2026-04-23T07:00:00.000Z',
            result: 'success',
          },
        },
      } satisfies FeedbackStateSnapshotResult);

      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });

      // Create
      const createResult = await adapter.createAnnotation({
        body: 'fix this button',
        priority: 'high',
        target: { elementName: 'button', elementPath: '#btn', rect: new DOMRectReadOnly() },
      });
      expect(createResult.id).toBe('anno-new-1');

      // Snapshot — verify pushAgent recorded the launch
      const snapshot = await adapter.getFeedbackSnapshot!();
      expect(snapshot.pushAgent!.lastLaunch!.result).toBe('success');
      expect(snapshot.pushAgent!.lastLaunch!.annotationId).toBe('anno-new-1');

      // Verify correct bridge methods were called
      expect(sendRequest).toHaveBeenNthCalledWith(
        1,
        BRIDGE_METHODS.extensionFeedbackAnnotationCreate,
        expect.objectContaining({ body: 'fix this button', priority: 'high' }),
      );
      expect(sendRequest).toHaveBeenNthCalledWith(2, BRIDGE_METHODS.extensionFeedbackStateSnapshot);
    });

    it('full flow: create → delta picks up the created event → snapshot confirms', async () => {
      // Step 1: Create
      sendRequest.mockResolvedValueOnce({ annotation: { id: 'anno-delta-1' } });

      // Step 2: Delta picks up the annotation.created event
      sendRequest.mockResolvedValueOnce({
        events: [
          {
            eventId: 'evt-delta-create',
            tenantId: 't1',
            sessionId: 's1',
            annotationId: 'anno-delta-1',
            seq: 100,
            eventType: 'annotation.created',
            occurredAt: '2026-04-23T08:00:00.000Z',
            source: 'user',
            payload: { body: 'delta test', priority: 'normal' },
          },
        ],
        lastSeq: 100,
      } satisfies FeedbackStateDeltaResult);

      // Step 3: Snapshot confirms final state
      sendRequest.mockResolvedValueOnce({
        sessions: [],
        annotations: [{ id: 'anno-delta-1', status: 'open' }],
        snapshotVersion: 7,
        lastSeq: 100,
        pushAgent: {
          enabled: true,
          readiness: 'ready',
          lastLaunch: {
            annotationId: 'anno-delta-1',
            sessionId: 's1',
            attemptedAt: '2026-04-23T08:00:01.000Z',
            result: 'success',
          },
        },
      } satisfies FeedbackStateSnapshotResult);

      const adapter = createFeedbackUiAdapter({ sendRequest: sendRequest as never });

      await adapter.createAnnotation({
        body: 'delta test',
        priority: 'normal',
        target: { elementName: 'div', elementPath: 'main', rect: new DOMRectReadOnly() },
      });

      // Delta should show the created event
      const delta = await adapter.getFeedbackStateDelta!();
      expect(delta.events).toHaveLength(1);
      expect(delta.events[0].eventType).toBe('annotation.created');
      expect(delta.events[0].annotationId).toBe('anno-delta-1');

      // Snapshot should confirm push succeeded
      const snapshot = await adapter.getFeedbackSnapshot!();
      expect(snapshot.pushAgent!.lastLaunch!.result).toBe('success');
    });
  });
});
