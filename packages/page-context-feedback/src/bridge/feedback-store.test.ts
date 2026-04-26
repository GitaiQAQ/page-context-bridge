import { describe, expect, it } from 'vitest';

import { FeedbackStore } from './feedback-store';

/** 构造一个最小合法的 actor */
const mockActor = { id: 'user-1', source: 'sidepanel' as const };

/** 构造最小合法的 linkedCapabilities */
const mockCapabilities = {
  namespaceHints: [],
  relatedToolNames: [],
  relatedResourceIds: [],
  relatedSkillIds: [],
  linkReasons: [],
};

/**
 * 创建可控制的 store 实例：
 * - now() 返回固定时间戳，确保断言稳定
 * - createId() 返回递增 ID，避免随机性
 */
function createStore(nowStr = '2026-01-01T00:00:00.000Z') {
  let counter = 0;
  return new FeedbackStore('test-tenant', {
    now: () => nowStr,
    createId: (prefix) => `${prefix}_${counter++}`,
  });
}

describe('FeedbackStore', () => {
  // ─── 创建 annotation ──────────────────────────────────────────

  describe('createAnnotation', () => {
    it('创建 annotation 并自动关联 session', () => {
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

    it('同一 tabId 复用 session', () => {
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

      // 同一 session 下应有两个 annotation
      const list = store.listAnnotationsBySession(a1.sessionId);
      expect(list).toHaveLength(2);
    });

    it('不同 tabId 产生独立 session', () => {
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

    it('默认优先级为 normal', () => {
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

    it('支持自定义优先级', () => {
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

    it('规范化 selectedText（去除空白）', () => {
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

  // ─── 状态转换 ─────────────────────────────────────────────────

  describe('claimAnnotation / resolveAnnotation / dismissAnnotation', () => {
    it('open -> claimed -> resolved 完整流转', () => {
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

    it('open -> dismissed 流转', () => {
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

    it('非法状态转换抛出异常', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'x',
        tabId: 1,
        url: 'https://x.com',
        linkedCapabilities: mockCapabilities,
      });
      store.dismissAnnotation({ annotationId: ann.id, actor: mockActor });

      // dismissed 之后不能再 claim
      expect(() => store.claimAnnotation({ annotationId: ann.id, actor: mockActor })).toThrow(
        'Invalid status transition',
      );
    });

    it('不存在的 annotation 抛出异常', () => {
      const store = createStore();
      expect(() =>
        store.claimAnnotation({ annotationId: 'nonexistent', actor: mockActor }),
      ).toThrow('Annotation not found');
    });
  });

  // ─── reply ─────────────────────────────────────────────────────

  describe('replyAnnotation', () => {
    it('追加回复到 thread', () => {
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
      expect(updated.thread[0].kind).toBe('comment'); // 默认 kind
    });

    it('支持自定义 kind', () => {
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
    it('更新 open annotation 的 body 和 priority', () => {
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

    it('已终结状态（resolved/dismissed）不可编辑', () => {
      const store = createStore();
      const ann = store.createAnnotation({
        actor: mockActor,
        body: 'x',
        tabId: 1,
        url: 'https://x.com',
        linkedCapabilities: mockCapabilities,
      });
      // open -> claimed -> resolved（合法路径）
      store.claimAnnotation({ annotationId: ann.id, actor: mockActor });
      store.resolveAnnotation({ annotationId: ann.id, actor: mockActor });

      expect(() =>
        store.updateAnnotation({ annotationId: ann.id, actor: mockActor, body: 'hack' }),
      ).toThrow('Cannot update annotation in status: resolved');
    });

    it('空 body 被拒绝', () => {
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

  // ─── 查询 / 快照 ───────────────────────────────────────────────

  describe('readSnapshot / readDelta / listSessions', () => {
    it('readSnapshot 返回所有 sessions 和 annotations', () => {
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

    it('readDelta 只返回 afterSeq 之后的事件', () => {
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
      // 应包含第二个 annotation 的 created 事件 + session.started 事件
      expect(delta.events.length).toBeGreaterThanOrEqual(1);
      expect(delta.lastSeq).toBeGreaterThan(snap1.lastSeq);
    });

    it('listSessions 按 tabId 过滤', () => {
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
      expect(store.listSessions()).toHaveLength(2); // 无参数返回全部
    });
  });

  // ─── getAnnotation / getSession ─────────────────────────────────

  describe('getAnnotation / getSession', () => {
    it('按 ID 查找 annotation，不存在返回 null', () => {
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

    it('按 ID 查找 session，不存在返回 null', () => {
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

  // ─── snapshotVersion 递增 ──────────────────────────────────────

  describe('snapshotVersion', () => {
    it('每次写操作都递增版本号', () => {
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
