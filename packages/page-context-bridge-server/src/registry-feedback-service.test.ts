import { describe, expect, it, vi } from 'vitest';

import {
  createRegistryFeedbackService,
  type CreateRegistryFeedbackServiceInput,
} from './registry-feedback-service.js';

const FALLBACK_STATUS = {
  enabled: false,
  readiness: 'disabled' as const,
  mode: 'disabled' as const,
  lastLaunch: null,
};

const NULL_ADAPTER = {
  pushNewAnnotation: vi.fn(),
  getPushAgentStatus: undefined,
};

function makeInput(
  extra?: Partial<CreateRegistryFeedbackServiceInput>,
): CreateRegistryFeedbackServiceInput {
  return {
    tenantId: 'test-tenant',
    feedbackAgentPushAdapter: extra?.feedbackAgentPushAdapter ?? NULL_ADAPTER,
    feedbackAgentPushStatusFallback: extra?.feedbackAgentPushStatusFallback ?? FALLBACK_STATUS,
    deriveFeedbackLinks:
      extra?.deriveFeedbackLinks ??
      ((tabId: number) => ({
        links: {
          namespaceHints: [],
          relatedToolNames: [],
          relatedResourceIds: [],
          relatedSkillIds: [],
          linkReasons: [],
        },
        manifest: null,
      })),
    logger: vi.fn(),
  };
}

describe('createRegistryFeedbackService', () => {
  it('creates service with correct interface', () => {
    const svc = createRegistryFeedbackService(makeInput());
    expect(typeof svc.getFeedbackSnapshot).toBe('function');
    expect(typeof svc.getFeedbackDelta).toBe('function');
    expect(typeof svc.createFeedbackAnnotation).toBe('function');
    expect(typeof svc.updateFeedbackAnnotation).toBe('function');
    expect(typeof svc.claimFeedbackAnnotation).toBe('function');
    expect(typeof svc.replyFeedbackAnnotation).toBe('function');
    expect(typeof svc.resolveFeedbackAnnotation).toBe('function');
    expect(typeof svc.dismissFeedbackAnnotation).toBe('function');
    expect(typeof svc.getFeedbackSession).toBe('function');
    expect(typeof svc.listFeedbackSessions).toBe('function');
    expect(typeof svc.listFeedbackAnnotations).toBe('function');
    expect(typeof svc.getFeedbackAnnotation).toBe('function');
  });

  it('initializes with empty snapshot', () => {
    const snap = createRegistryFeedbackService(makeInput()).getFeedbackSnapshot();
    expect(snap.sessions).toEqual([]);
    expect(snap.annotations).toEqual([]);
    expect(snap.snapshotVersion).toBe(0);
  });
});

describe('CRUD operations', () => {
  it('full lifecycle: create -> claim -> resolve', () => {
    const svc = createRegistryFeedbackService(makeInput());
    const a = svc.createFeedbackAnnotation({
      actor: { source: 'extension' as const, id: 'eu', displayName: 'EU' },
      body: 'Bug report',
      priority: 'high',
      tabId: 1,
      url: 'https://example.com',
    });
    expect(a.status).toBe('open');

    const c = svc.claimFeedbackAnnotation({ annotationId: a.id });
    expect(c.status).toBe('claimed');

    const r = svc.resolveFeedbackAnnotation({ annotationId: a.id, resolution: 'Fixed' });
    expect(r.status).toBe('resolved');
    expect(r.resolution).toBe('Fixed');
  });

  it('full lifecycle: create -> claim -> dismiss', () => {
    const svc = createRegistryFeedbackService(makeInput());
    const a = svc.createFeedbackAnnotation({
      actor: { source: 'extension' as const, id: 'eu', displayName: 'EU' },
      body: 'Duplicate',
      tabId: 1,
      url: 'https://example.com',
    });
    expect(a.status).toBe('open');

    svc.claimFeedbackAnnotation({ annotationId: a.id });
    const d = svc.dismissFeedbackAnnotation({ annotationId: a.id, dismissReason: 'Dup' });
    expect(d.status).toBe('dismissed');
    expect(d.dismissReason).toBe('Dup');
  });

  it('update + reply on claimed annotation', () => {
    const svc = createRegistryFeedbackService(makeInput());
    const a = svc.createFeedbackAnnotation({
      actor: { source: 'extension' as const, id: 'eu', displayName: 'EU' },
      body: 'Bug',
      tabId: 1,
      url: 'https://example.com',
    });
    svc.claimFeedbackAnnotation({ annotationId: a.id });
    svc.updateFeedbackAnnotation({ annotationId: a.id, body: 'Updated' });
    const r = svc.replyFeedbackAnnotation({ annotationId: a.id, body: 'Note' });
    expect(r.thread).toHaveLength(1);
    expect(r.thread[0]?.kind).toBe('comment');
  });

  it('list sessions and annotations', () => {
    const svc = createRegistryFeedbackService(makeInput());
    svc.createFeedbackAnnotation({
      actor: { source: 'extension' as const, id: 'eu', displayName: 'EU' },
      body: 'A',
      tabId: 1,
      url: 'https://a.com',
    });
    svc.createFeedbackAnnotation({
      actor: { source: 'extension' as const, id: 'eu', displayName: 'EU' },
      body: 'B',
      tabId: 2,
      url: 'https://b.com',
    });
    expect(svc.listFeedbackSessions()).toHaveLength(2);
    expect(svc.listFeedbackAnnotations({ tabId: 1 })).toHaveLength(1);
    const sessions = svc.listFeedbackSessions();
    expect(svc.listFeedbackAnnotations({ sessionId: sessions[0]!.id })).toHaveLength(1);
  });

  it('getAnnotation returns null for missing', () => {
    const svc = createRegistryFeedbackService(makeInput());
    expect(svc.getFeedbackAnnotation('missing')).toBeNull();
  });
});

describe('getFeedbackDelta()', () => {
  it('delegates to store.readDelta', () => {
    const svc = createRegistryFeedbackService(makeInput());
    svc.createFeedbackAnnotation({
      actor: { source: 'extension' as const, id: 'ext-user', displayName: 'Extension User' },
      body: 'Test',
      tabId: 1,
      url: 'https://example.com',
    });

    const delta = svc.getFeedbackDelta({ afterSeq: 0 });
    expect(delta.events.length).toBeGreaterThan(0);
  });
});
