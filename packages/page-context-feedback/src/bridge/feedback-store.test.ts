import { describe, expect, it } from 'vitest';

import { FeedbackStore } from './feedback-store';

/** Build a minimal valid actor */
const mockActor = { id: 'user-1', source: 'sidepanel' as const };

/** Build minimal valid linkedCapabilities */
const mockCapabilities = {
  namespaceHints: [],
  relatedToolNames: [],
  relatedResourceIds: [],
  relatedSkillIds: [],
  linkReasons: [],
};

/**
 * Create a controllable store instance:
 * - now() returns a fixed timestamp for stable assertions
 * - createId() returns incremental IDs to avoid randomness
 */
function createStore(nowStr = '2026-01-01T00:00:00.000Z') {
  let counter = 0;
  return new FeedbackStore('test-tenant', {
    now: () => nowStr,
    createId: (prefix) => `${prefix}_${counter++}`,
  });
}

describe('FeedbackStore', () => {
  // ─── Create annotation ──────────────────────────────────────────

  describe('createAnnotation', () => {
    it('creates annotation and auto-associates session', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'test feedback',
        tabId: 1,
        url: 'https://example.com',
        linkedCapabilities: mockCapabilities,
      });

      expect(ann.id).toBeDefined();
      expect(ann.body).toBe('test feedback');
      expect(ann.status).toBe('open');
      expect(ann.sessionId).toBeDefined();
      expect(ann.author).toEqual(mockActor);
    });

    it('reuses session for same tabId', () => {
      const store = createStore();
      const a1 = store.createAnnotation({
        actor: mockActor,
        body: 'first',
        tabId: 1,
        url: 'https://a.com',
        linkedCapabilities: mockCapabilities,
      });
      const a2 = store.createAnnotation({
        actor: mockActor,
        body: 'second',
        tabId: 1,
        url: 'https://a.com',
        linkedCapabilities: mockCapabilities,
      });

      expect(a1.sessionId).toBe(a2.sessionId);

      // Same session should have two annotations
      const list = store.listAnnotationsBySession(a1.sessionId);
      expect(list).toHaveLength(2);
    });

    it('different tabIds produce independent sessions', () => {
      const store = createStore();
      const a1 = store.createAnnotation({
        actor: mockActor,
        body: 'tab1',
        tabId: 1,
        url: 'https://a.com',
        linkedCapabilities: mockCapabilities,
      });
      const a2 = store.createAnnotation({
        actor: mockActor,
        body: 'tab2',
        tabId: 2,
        url: 'https://b.com',
        linkedCapabilities: mockCapabilities,
      });

      expect(a1.sessionId).not.toBe(a2.sessionId);
    });

    it('defaults priority to normal', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'prio?',
        tabId: 1,
        url: 'https://x.com',
        linkedCapabilities: mockCapabilities,
      });
      expect(ann.priority).toBe('normal');
    });

    it('supports custom priority', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'urgent!',
        tabId: 1,
        url: 'https://x.com',
        priority: 'high',
        linkedCapabilities: mockCapabilities,
      });
      expect(ann.priority).toBe('high');
    });

    it('normalizes selectedText (trims whitespace)', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'x',
        tabId: 1,
        url: 'https://x.com',
        selectedText: '  hello  ',
        linkedCapabilities: mockCapabilities,
      });
      expect(ann.target.textQuote).toBe('hello');
      expect(ann.context.selectedText).toBe('hello');
    });
  });

  // ─── State transitions ─────────────────────────────────────────

  describe('claimAnnotation / resolveAnnotation / dismissAnnotation', () => {
    it('full flow: open -> claimed -> resolved', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'flow test',
        tabId: 1,
        url: 'https://x.com',
        linkedCapabilities: mockCapabilities,
      });

      const claimed = store.claimAnnotation({ annotationId: ann.id, actor: mockActor });
      expect(claimed.status).toBe('claimed');
      expect(claimed.claimedBy).toEqual(mockActor);

      const resolved = store.resolveAnnotation({
        annotationId: ann.id,
        actor: mockActor,
        resolution: 'fixed',
      });
      expect(resolved.status).toBe('resolved');
      expect(resolved.resolution).toBe('fixed');
      expect(resolved.resolvedBy).toEqual(mockActor);
    });

    it('flow: open -> dismissed', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'dismiss me',
        tabId: 1,
        url: 'https://x.com',
        linkedCapabilities: mockCapabilities,
      });

      const dismissed = store.dismissAnnotation({
        annotationId: ann.id,
        actor: mockActor,
        dismissReason: 'invalid',
      });
      expect(dismissed.status).toBe('dismissed');
      expect(dismissed.dismissReason).toBe('invalid');
    });

    it('throws on invalid state transition', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'x',
        tabId: 1,
        url: 'https://x.com',
        linkedCapabilities: mockCapabilities,
      });
      store.dismissAnnotation({ annotationId: ann.id, actor: mockActor });

      // Cannot claim after dismissed
      expect(() => store.claimAnnotation({ annotationId: ann.id, actor: mockActor })).toThrow(
        'Invalid status transition',
      );
    });

    it('throws for nonexistent annotation', () => {
      const store = createStore();
      expect(() =>
        store.claimAnnotation({ annotationId: 'nonexistent', actor: mockActor }),
      ).toThrow('Annotation not found');
    });
  });

  // ─── reply ─────────────────────────────────────────────────────

  describe('replyAnnotation', () => {
    it('appends reply to thread', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'original',
        tabId: 1,
        url: 'https://x.com',
        linkedCapabilities: mockCapabilities,
      });

      const updated = store.replyAnnotation({
        annotationId: ann.id,
        actor: mockActor,
        body: 'reply text',
      });
      expect(updated.thread).toHaveLength(1);
      expect(updated.thread[0].body).toBe('reply text');
      expect(updated.thread[0].kind).toBe('comment'); // default kind
    });

    it('supports custom kind', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'orig',
        tabId: 1,
        url: 'https://x.com',
        linkedCapabilities: mockCapabilities,
      });

      const updated = store.replyAnnotation({
        annotationId: ann.id,
        actor: mockActor,
        body: 'action!',
        kind: 'action_note',
      });
      expect(updated.thread[0].kind).toBe('action_note');
    });
  });

  // ─── update ────────────────────────────────────────────────────

  describe('updateAnnotation', () => {
    it('updates body and priority of open annotation', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'old',
        tabId: 1,
        url: 'https://x.com',
        linkedCapabilities: mockCapabilities,
      });

      const updated = store.updateAnnotation({
        annotationId: ann.id,
        actor: mockActor,
        body: 'new body',
        priority: 'high',
      });
      expect(updated.body).toBe('new body');
      expect(updated.priority).toBe('high');
    });

    it('cannot edit terminal states (resolved / dismissed)', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'x',
        tabId: 1,
        url: 'https://x.com',
        linkedCapabilities: mockCapabilities,
      });
      // open -> claimed -> resolved (valid path)
      store.claimAnnotation({ annotationId: ann.id, actor: mockActor });
      store.resolveAnnotation({ annotationId: ann.id, actor: mockActor });

      expect(() =>
        store.updateAnnotation({ annotationId: ann.id, actor: mockActor, body: 'hack' }),
      ).toThrow('Cannot update annotation in status: resolved');
    });

    it('rejects empty body', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'x',
        tabId: 1,
        url: 'https://x.com',
        linkedCapabilities: mockCapabilities,
      });

      expect(() =>
        store.updateAnnotation({ annotationId: ann.id, actor: mockActor, body: '   ' }),
      ).toThrow('Annotation body is required');
    });
  });

  // ─── Query / Snapshot ──────────────────────────────────────────

  describe('readSnapshot / readDelta / listSessions', () => {
    it('readSnapshot returns all sessions and annotations', () => {
      const store = createStore();
      store.createAnnotation({
        actor: mockActor,
        body: 's1',
        tabId: 10,
        url: 'https://s1.com',
        linkedCapabilities: mockCapabilities,
      });
      store.createAnnotation({
        actor: mockActor,
        body: 's2',
        tabId: 20,
        url: 'https://s2.com',
        linkedCapabilities: mockCapabilities,
      });

      const snap = store.readSnapshot();
      expect(snap.sessions).toHaveLength(2);
      expect(snap.annotations).toHaveLength(2);
      expect(snap.snapshotVersion).toBeGreaterThan(0);
    });

    it('readDelta only returns events after afterSeq', () => {
      const store = createStore();
      store.createAnnotation({
        actor: mockActor,
        body: 'ev1',
        tabId: 1,
        url: 'https://x.com',
        linkedCapabilities: mockCapabilities,
      });
      const snap1 = store.readSnapshot();

      store.createAnnotation({
        actor: mockActor,
        body: 'ev2',
        tabId: 2,
        url: 'https://y.com',
        linkedCapabilities: mockCapabilities,
      });

      const delta = store.readDelta({ afterSeq: snap1.lastSeq });
      // Should contain second annotation created event + session.started event
      expect(delta.events.length).toBeGreaterThanOrEqual(1);
      expect(delta.lastSeq).toBeGreaterThan(snap1.lastSeq);
    });

    it('listSessions filters by tabId', () => {
      const store = createStore();
      store.createAnnotation({
        actor: mockActor,
        body: 't1',
        tabId: 1,
        url: 'https://a.com',
        linkedCapabilities: mockCapabilities,
      });
      store.createAnnotation({
        actor: mockActor,
        body: 't99',
        tabId: 99,
        url: 'https://b.com',
        linkedCapabilities: mockCapabilities,
      });

      expect(store.listSessions(1)).toHaveLength(1);
      expect(store.listSessions(99)).toHaveLength(1);
      expect(store.listSessions()).toHaveLength(2); // no arg returns all
    });
  });

  // ─── getAnnotation / getSession ─────────────────────────────────

  describe('getAnnotation / getSession', () => {
    it('finds annotation by ID, returns null if not found', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'findme',
        tabId: 1,
        url: 'https://x.com',
        linkedCapabilities: mockCapabilities,
      });

      expect(store.getAnnotation(ann.id)?.body).toBe('findme');
      expect(store.getAnnotation('nope')).toBeNull();
    });

    it('finds session by ID, returns null if not found', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'x',
        tabId: 1,
        url: 'https://x.com',
        linkedCapabilities: mockCapabilities,
      });

      expect(store.getSession(ann.sessionId)).not.toBeNull();
      expect(store.getSession('ghost')).toBeNull();
    });
  });

  // ─── snapshotVersion increment ──────────────────────────────────

  describe('snapshotVersion', () => {
    it('increments version on every write operation', () => {
      const store = createStore();
      const snap0 = store.readSnapshot();
      const v0 = snap0.snapshotVersion;

      store.createAnnotation({
        actor: mockActor,
        body: 'v1',
        tabId: 1,
        url: 'https://x.com',
        linkedCapabilities: mockCapabilities,
      });
      expect(store.readSnapshot().snapshotVersion).toBe(v0 + 1);

      store.claimAnnotation({
        annotationId: store.listAnnotationsBySession(store.listSessions()[0].id)[0].id,
        actor: mockActor,
      });
      expect(store.readSnapshot().snapshotVersion).toBe(v0 + 2);
    });
  });
});
