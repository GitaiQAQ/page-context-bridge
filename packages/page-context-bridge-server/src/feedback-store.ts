import type {
  FeedbackActor,
  FeedbackAnnotation,
  FeedbackAnnotationDismissParams,
  FeedbackAnnotationResolveParams,
  FeedbackAnnotationUpdateParams,
  FeedbackAnnotationStatus,
  FeedbackCapabilityLinks,
  FeedbackContext,
  FeedbackEvent,
  FeedbackEventType,
  FeedbackPriority,
  FeedbackSession,
  FeedbackStateDeltaParams,
  FeedbackStateDeltaResult,
  FeedbackStateSnapshotParams,
  FeedbackStateSnapshotResult,
  FeedbackThreadMessage,
  FeedbackUiAnchor,
} from '@page-context/shared-protocol';
import {
  cloneValue,
  normalizeText,
  normalizeUiAnchor,
  normalizeUiRect,
  normalizeUiTextRange,
  uniqueStrings,
} from './feedback-normalizers';

const DEFAULT_EVENT_RING_SIZE = 500;

const ALLOWED_STATUS_TRANSITIONS: Record<FeedbackAnnotationStatus, FeedbackAnnotationStatus[]> = {
  open: ['claimed', 'dismissed'],
  claimed: ['in_progress', 'resolved', 'dismissed'],
  in_progress: ['needs_info', 'resolved', 'dismissed'],
  needs_info: ['claimed', 'in_progress', 'dismissed'],
  resolved: [],
  dismissed: [],
};

export interface FeedbackStoreState {
  sessionsById: Map<string, FeedbackSession>;
  sessionIdByTabId: Map<number, string>;
  annotationsById: Map<string, FeedbackAnnotation>;
  annotationIdsBySessionId: Map<string, string[]>;
  events: FeedbackEvent[];
  lastSeq: number;
  snapshotVersion: number;
}

export interface FeedbackStoreOptions {
  maxEvents?: number;
  now?: () => string;
  createId?: (prefix: string) => string;
}

export interface CreateFeedbackAnnotationInput {
  actor: FeedbackActor;
  body: string;
  priority?: FeedbackPriority;
  tabId: number;
  url: string;
  title?: string;
  selectedText?: string;
  uiAnchor?: FeedbackUiAnchor;
  pageInfoExtra?: {
    app?: string;
    scene?: string;
    route?: string;
  };
  manifestSummary?: FeedbackContext['manifestSummary'];
  linkedCapabilities: FeedbackCapabilityLinks;
}

export interface ClaimFeedbackAnnotationInput {
  annotationId: string;
  actor: FeedbackActor;
}

export interface ReplyFeedbackAnnotationInput {
  annotationId: string;
  actor: FeedbackActor;
  body: string;
  kind?: FeedbackThreadMessage['kind'];
}

export interface ResolveFeedbackAnnotationInput extends Omit<
  FeedbackAnnotationResolveParams,
  'actor'
> {
  actor: FeedbackActor;
}

export interface DismissFeedbackAnnotationInput extends Omit<
  FeedbackAnnotationDismissParams,
  'actor'
> {
  actor: FeedbackActor;
}

export interface UpdateFeedbackAnnotationInput extends Omit<
  FeedbackAnnotationUpdateParams,
  'actor'
> {
  actor: FeedbackActor;
}

/**
 * In-memory feedback store per tenant.
 * Goal: Maintain deterministic behavior, simple structure, easy to replace with persistent storage later.
 */
export class FeedbackStore {
  private readonly maxEvents: number;
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;

  private readonly state: FeedbackStoreState = {
    sessionsById: new Map(),
    sessionIdByTabId: new Map(),
    annotationsById: new Map(),
    annotationIdsBySessionId: new Map(),
    events: [],
    lastSeq: 0,
    snapshotVersion: 0,
  };

  constructor(
    private readonly tenantId: string,
    options: FeedbackStoreOptions = {},
  ) {
    this.maxEvents = options.maxEvents ?? DEFAULT_EVENT_RING_SIZE;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId =
      options.createId ??
      ((prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`);
  }

  readSnapshot(params: FeedbackStateSnapshotParams = {}): FeedbackStateSnapshotResult {
    const selectedSessions = this.pickSessions(params);
    const selectedSessionIds = new Set(selectedSessions.map((session) => session.id));
    const annotations = Array.from(this.state.annotationsById.values())
      .filter((annotation) => selectedSessionIds.has(annotation.sessionId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((annotation) => cloneValue(annotation));

    return {
      sessions: selectedSessions.map((session) => cloneValue(session)),
      annotations,
      snapshotVersion: this.state.snapshotVersion,
      lastSeq: this.state.lastSeq,
    };
  }

  readDelta(params: FeedbackStateDeltaParams): FeedbackStateDeltaResult {
    const events = this.state.events
      .filter((event) => event.seq > params.afterSeq)
      .filter((event) => (params.sessionId ? event.sessionId === params.sessionId : true))
      .map((event) => cloneValue(event));

    return {
      events,
      lastSeq: this.state.lastSeq,
    };
  }

  listSessions(tabId?: number): FeedbackSession[] {
    const sessions = this.pickSessions({ tabId });
    return sessions.map((session) => cloneValue(session));
  }

  getSession(sessionId: string): FeedbackSession | null {
    return cloneValue(this.state.sessionsById.get(sessionId) ?? null);
  }

  listAnnotationsBySession(sessionId: string): FeedbackAnnotation[] {
    const ids = this.state.annotationIdsBySessionId.get(sessionId) ?? [];
    return ids
      .map((id) => this.state.annotationsById.get(id))
      .filter((annotation): annotation is FeedbackAnnotation => annotation != null)
      .map((annotation) => cloneValue(annotation));
  }

  getAnnotation(annotationId: string): FeedbackAnnotation | null {
    return cloneValue(this.state.annotationsById.get(annotationId) ?? null);
  }

  createAnnotation(input: CreateFeedbackAnnotationInput): FeedbackAnnotation {
    const { session } = this.ensureSessionForTab({
      tabId: input.tabId,
      url: input.url,
      title: input.title,
      app: input.pageInfoExtra?.app,
      scene: input.pageInfoExtra?.scene,
      route: input.pageInfoExtra?.route,
    });

    const now = this.now();
    const normalizedUiAnchor = normalizeUiAnchor(input.uiAnchor);
    const targetUiAnchor = normalizedUiAnchor ? cloneValue(normalizedUiAnchor) : undefined;
    const contextUiAnchor = normalizedUiAnchor ? cloneValue(normalizedUiAnchor) : undefined;
    const annotation: FeedbackAnnotation = {
      id: this.createId('annotation'),
      sessionId: session.id,
      author: input.actor,
      body: input.body,
      status: 'open',
      priority: input.priority ?? 'normal',
      target: {
        tabId: input.tabId,
        url: input.url,
        title: input.title,
        textQuote: normalizeText(input.selectedText),
        uiAnchor: targetUiAnchor,
      },
      context: {
        pageInfo: {
          tabId: input.tabId,
          url: input.url,
          title: input.title,
          app: input.pageInfoExtra?.app,
          scene: input.pageInfoExtra?.scene,
          route: input.pageInfoExtra?.route,
        },
        selectedText: normalizeText(input.selectedText),
        uiAnchor: contextUiAnchor,
        manifestSummary: input.manifestSummary,
      },
      linkedCapabilities: {
        namespaceHints: uniqueStrings(input.linkedCapabilities.namespaceHints),
        relatedToolNames: uniqueStrings(input.linkedCapabilities.relatedToolNames),
        relatedResourceIds: uniqueStrings(input.linkedCapabilities.relatedResourceIds),
        relatedSkillIds: uniqueStrings(input.linkedCapabilities.relatedSkillIds),
        linkReasons: uniqueStrings(input.linkedCapabilities.linkReasons),
      },
      thread: [],
      createdAt: now,
      updatedAt: now,
    };

    this.state.annotationsById.set(annotation.id, annotation);
    const annotationIds = this.state.annotationIdsBySessionId.get(session.id) ?? [];
    annotationIds.push(annotation.id);
    this.state.annotationIdsBySessionId.set(session.id, annotationIds);

    this.appendEvent({
      sessionId: session.id,
      annotationId: annotation.id,
      eventType: 'annotation.created',
      source: input.actor.source,
      payload: {
        status: annotation.status,
        priority: annotation.priority,
      },
    });
    this.bumpSnapshotVersion();
    return cloneValue(annotation);
  }

  claimAnnotation(input: ClaimFeedbackAnnotationInput): FeedbackAnnotation {
    const annotation = this.requireAnnotation(input.annotationId);
    this.transition(annotation, 'claimed');
    annotation.claimedBy = input.actor;
    annotation.updatedAt = this.now();

    this.appendEvent({
      sessionId: annotation.sessionId,
      annotationId: annotation.id,
      eventType: 'annotation.claimed',
      source: input.actor.source,
      payload: {
        status: annotation.status,
        claimedBy: input.actor.id,
      },
    });
    this.bumpSnapshotVersion();
    return cloneValue(annotation);
  }

  replyAnnotation(input: ReplyFeedbackAnnotationInput): FeedbackAnnotation {
    const annotation = this.requireAnnotation(input.annotationId);
    const reply: FeedbackThreadMessage = {
      id: this.createId('thread'),
      annotationId: annotation.id,
      author: input.actor,
      body: input.body,
      kind: input.kind ?? 'comment',
      createdAt: this.now(),
    };

    annotation.thread.push(reply);
    annotation.updatedAt = this.now();

    this.appendEvent({
      sessionId: annotation.sessionId,
      annotationId: annotation.id,
      eventType: 'annotation.replied',
      source: input.actor.source,
      payload: {
        kind: reply.kind,
        authorId: reply.author.id,
      },
    });
    this.bumpSnapshotVersion();
    return cloneValue(annotation);
  }

  resolveAnnotation(input: ResolveFeedbackAnnotationInput): FeedbackAnnotation {
    const annotation = this.requireAnnotation(input.annotationId);
    this.transition(annotation, 'resolved');
    annotation.resolvedBy = input.actor;
    annotation.resolution = normalizeText(input.resolution);
    annotation.updatedAt = this.now();

    if (annotation.resolution) {
      annotation.thread.push({
        id: this.createId('thread'),
        annotationId: annotation.id,
        author: input.actor,
        body: annotation.resolution,
        kind: 'resolution_note',
        createdAt: this.now(),
      });
    }

    this.appendEvent({
      sessionId: annotation.sessionId,
      annotationId: annotation.id,
      eventType: 'annotation.resolved',
      source: input.actor.source,
      payload: {
        status: annotation.status,
        resolvedBy: input.actor.id,
      },
    });
    this.bumpSnapshotVersion();
    return cloneValue(annotation);
  }

  dismissAnnotation(input: DismissFeedbackAnnotationInput): FeedbackAnnotation {
    const annotation = this.requireAnnotation(input.annotationId);
    this.transition(annotation, 'dismissed');
    annotation.dismissReason = normalizeText(input.dismissReason);
    annotation.updatedAt = this.now();

    this.appendEvent({
      sessionId: annotation.sessionId,
      annotationId: annotation.id,
      eventType: 'annotation.dismissed',
      source: input.actor.source,
      payload: {
        status: annotation.status,
      },
    });
    this.bumpSnapshotVersion();
    return cloneValue(annotation);
  }

  updateAnnotation(input: UpdateFeedbackAnnotationInput): FeedbackAnnotation {
    const annotation = this.requireAnnotation(input.annotationId);

    // Final state annotations cannot be edited again to avoid silent modification of "processed items".
    if (annotation.status === 'resolved' || annotation.status === 'dismissed') {
      throw new Error(`Cannot update annotation in status: ${annotation.status}`);
    }

    const normalizedBody = normalizeText(input.body);
    if (!normalizedBody) {
      throw new Error('Annotation body is required');
    }
    annotation.body = normalizedBody;
    if (input.priority) {
      annotation.priority = input.priority;
    }
    annotation.updatedAt = this.now();

    this.appendEvent({
      sessionId: annotation.sessionId,
      annotationId: annotation.id,
      eventType: 'annotation.updated',
      source: input.actor.source,
      payload: {
        status: annotation.status,
        priority: annotation.priority,
      },
    });
    this.bumpSnapshotVersion();
    return cloneValue(annotation);
  }

  private ensureSessionForTab(input: {
    tabId: number;
    url: string;
    title?: string;
    app?: string;
    scene?: string;
    route?: string;
  }): { session: FeedbackSession; created: boolean } {
    const existingId = this.state.sessionIdByTabId.get(input.tabId);
    if (existingId) {
      const existing = this.state.sessionsById.get(existingId);
      if (existing) {
        existing.url = input.url;
        existing.title = input.title;
        existing.app = input.app;
        existing.scene = input.scene;
        existing.route = input.route;
        existing.updatedAt = this.now();
        return { session: existing, created: false };
      }
    }

    const now = this.now();
    const session: FeedbackSession = {
      id: this.createId('session'),
      tenantId: this.tenantId,
      tabId: input.tabId,
      url: input.url,
      title: input.title,
      app: input.app,
      scene: input.scene,
      route: input.route,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastEventSeq: this.state.lastSeq,
    };

    this.state.sessionsById.set(session.id, session);
    this.state.sessionIdByTabId.set(input.tabId, session.id);
    this.state.annotationIdsBySessionId.set(session.id, []);

    this.appendEvent({
      sessionId: session.id,
      eventType: 'session.started',
      source: 'bridge',
      payload: {
        tabId: session.tabId,
        url: session.url,
      },
    });

    return { session, created: true };
  }

  private appendEvent(input: {
    sessionId: string;
    annotationId?: string;
    eventType: FeedbackEventType;
    source: FeedbackActor['source'];
    payload: Record<string, unknown>;
  }): FeedbackEvent {
    const event: FeedbackEvent = {
      eventId: this.createId('event'),
      tenantId: this.tenantId,
      sessionId: input.sessionId,
      annotationId: input.annotationId,
      seq: this.state.lastSeq + 1,
      eventType: input.eventType,
      occurredAt: this.now(),
      source: input.source,
      payload: input.payload,
    };

    this.state.lastSeq = event.seq;
    this.state.events.push(event);
    if (this.state.events.length > this.maxEvents) {
      this.state.events.splice(0, this.state.events.length - this.maxEvents);
    }

    const session = this.state.sessionsById.get(input.sessionId);
    if (session) {
      session.lastEventSeq = event.seq;
      session.updatedAt = event.occurredAt;
    }

    return event;
  }

  private transition(annotation: FeedbackAnnotation, next: FeedbackAnnotationStatus): void {
    if (annotation.status === next) {
      return;
    }

    const allowed = ALLOWED_STATUS_TRANSITIONS[annotation.status];
    if (!allowed.includes(next)) {
      throw new Error(`Invalid status transition: ${annotation.status} -> ${next}`);
    }
    annotation.status = next;
  }

  private requireAnnotation(annotationId: string): FeedbackAnnotation {
    const annotation = this.state.annotationsById.get(annotationId);
    if (!annotation) {
      throw new Error(`Annotation not found: ${annotationId}`);
    }
    return annotation;
  }

  private pickSessions(params: FeedbackStateSnapshotParams): FeedbackSession[] {
    if (params.sessionId) {
      const session = this.state.sessionsById.get(params.sessionId);
      return session ? [session] : [];
    }

    if (params.tabId != null) {
      const sessionId = this.state.sessionIdByTabId.get(params.tabId);
      if (!sessionId) {
        return [];
      }
      const session = this.state.sessionsById.get(sessionId);
      return session ? [session] : [];
    }

    return Array.from(this.state.sessionsById.values()).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  private bumpSnapshotVersion(): void {
    this.state.snapshotVersion += 1;
  }
}
