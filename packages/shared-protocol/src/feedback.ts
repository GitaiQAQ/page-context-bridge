/**
 * Feedback domain shared types and method constants.
 */

// Feedback RPC methods are maintained separately to facilitate reuse of the same string constants across extension/bridge/MCP three ends.
export const FEEDBACK_METHODS = {
  feedbackStateSnapshot: 'feedback.state.snapshot',
  feedbackStateDelta: 'feedback.state.delta',
  feedbackAnnotationCreate: 'feedback.annotation.create',
  feedbackAnnotationUpdate: 'feedback.annotation.update',
  feedbackAnnotationClaim: 'feedback.annotation.claim',
  feedbackAnnotationReply: 'feedback.annotation.reply',
  feedbackAnnotationResolve: 'feedback.annotation.resolve',
  feedbackAnnotationDismiss: 'feedback.annotation.dismiss',
  extensionFeedbackStateSnapshot: 'extension.feedback.state.snapshot',
  extensionFeedbackStateDelta: 'extension.feedback.state.delta',
  extensionFeedbackAnnotationCreate: 'extension.feedback.annotation.create',
  extensionFeedbackAnnotationUpdate: 'extension.feedback.annotation.update',
  extensionFeedbackAnnotationClaim: 'extension.feedback.annotation.claim',
  extensionFeedbackAnnotationReply: 'extension.feedback.annotation.reply',
  extensionFeedbackAnnotationResolve: 'extension.feedback.annotation.resolve',
  extensionFeedbackAnnotationDismiss: 'extension.feedback.annotation.dismiss',
} as const;

export type FeedbackAnnotationStatus =
  | 'open'
  | 'claimed'
  | 'in_progress'
  | 'needs_info'
  | 'resolved'
  | 'dismissed';

export type FeedbackPriority = 'low' | 'normal' | 'high' | 'critical';

export type FeedbackActorSource = 'user' | 'agent' | 'bridge' | 'extension';

export interface FeedbackActor {
  source: FeedbackActorSource;
  id: string;
  displayName: string;
}

export interface FeedbackSession {
  id: string;
  tenantId: string;
  tabId: number;
  url: string;
  title?: string;
  route?: string;
  scene?: string;
  app?: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  lastEventSeq: number;
}

export interface FeedbackTarget {
  tabId: number;
  url: string;
  title?: string;
  textQuote?: string;
  uiAnchor?: FeedbackUiAnchor;
}

/**
 * Structured UI positioning anchor.
 * All fields are optional to ensure old data and old calls can continue working without modification.
 */
export interface FeedbackUiAnchor {
  elementId?: string;
  cssSelector?: string;
  xpath?: string;
  textQuote?: string;
  framePath?: number[];
  rect?: FeedbackUiRect;
  textRange?: FeedbackUiTextRange;
  meta?: Record<string, unknown>;
}

export interface FeedbackUiRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FeedbackUiTextRange {
  start: number;
  end: number;
}

export interface FeedbackCapabilityLinks {
  namespaceHints: string[];
  relatedToolNames: string[];
  relatedResourceIds: string[];
  relatedSkillIds: string[];
  linkReasons: string[];
}

export interface FeedbackContext {
  pageInfo: {
    tabId: number;
    url: string;
    title?: string;
    app?: string;
    scene?: string;
    route?: string;
  };
  selectedText?: string;
  uiAnchor?: FeedbackUiAnchor;
  manifestSummary?: {
    namespaceCount: number;
    resourceCount: number;
    skillCount: number;
  };
}

export interface FeedbackThreadMessage {
  id: string;
  annotationId: string;
  author: FeedbackActor;
  body: string;
  kind: 'comment' | 'action_note' | 'resolution_note';
  createdAt: string;
}

export interface FeedbackAnnotation {
  id: string;
  sessionId: string;
  author: FeedbackActor;
  body: string;
  status: FeedbackAnnotationStatus;
  priority: FeedbackPriority;
  target: FeedbackTarget;
  context: FeedbackContext;
  linkedCapabilities: FeedbackCapabilityLinks;
  thread: FeedbackThreadMessage[];
  createdAt: string;
  updatedAt: string;
  claimedBy?: FeedbackActor;
  resolvedBy?: FeedbackActor;
  resolution?: string;
  dismissReason?: string;
}

export type FeedbackEventType =
  | 'session.started'
  | 'annotation.created'
  | 'annotation.updated'
  | 'annotation.claimed'
  | 'annotation.replied'
  | 'annotation.resolved'
  | 'annotation.dismissed';

export interface FeedbackEvent {
  eventId: string;
  tenantId: string;
  sessionId: string;
  annotationId?: string;
  seq: number;
  eventType: FeedbackEventType;
  occurredAt: string;
  source: FeedbackActorSource;
  payload: Record<string, unknown>;
}

export interface FeedbackStateSnapshotParams {
  tabId?: number;
  sessionId?: string;
}

/**
 * Last launch result of feedback auto-push.
 * Only retains the most critical troubleshooting information, avoiding leaking implementation details to the UI layer.
 */
export interface FeedbackPushAgentLastLaunch {
  annotationId: string;
  sessionId: string;
  attemptedAt: string;
  result: 'success' | 'failed';
  failureReason?: string;
}

/**
 * Runtime status signals for feedback auto-push.
 * - enabled: Whether the configuration switch is enabled
 * - readiness: Whether launch can be attempted currently (minimum readiness signal)
 * - lastLaunch: Last launch result (including failure reason)
 */
export interface FeedbackPushAgentStatus {
  enabled: boolean;
  readiness: 'ready' | 'disabled';
  mode: 'local-opencode' | 'disabled' | 'custom';
  lastLaunch: FeedbackPushAgentLastLaunch | null;
}

export interface FeedbackStateSnapshotResult {
  sessions: FeedbackSession[];
  annotations: FeedbackAnnotation[];
  snapshotVersion: number;
  lastSeq: number;
  pushAgent?: FeedbackPushAgentStatus;
}

export interface FeedbackStateDeltaParams {
  afterSeq: number;
  sessionId?: string;
}

export interface FeedbackStateDeltaResult {
  events: FeedbackEvent[];
  lastSeq: number;
}

export interface FeedbackAnnotationCreateParams {
  body: string;
  priority?: FeedbackPriority;
  tabId: number;
  url: string;
  title?: string;
  selectedText?: string;
  uiAnchor?: FeedbackUiAnchor;
  actor?: FeedbackActor;
}

export interface FeedbackAnnotationUpdateParams {
  annotationId: string;
  body: string;
  priority?: FeedbackPriority;
  actor?: FeedbackActor;
}

export interface FeedbackAnnotationClaimParams {
  annotationId: string;
  actor?: FeedbackActor;
}

export interface FeedbackAnnotationReplyParams {
  annotationId: string;
  body: string;
  actor?: FeedbackActor;
  kind?: FeedbackThreadMessage['kind'];
}

export interface FeedbackAnnotationResolveParams {
  annotationId: string;
  resolution?: string;
  actor?: FeedbackActor;
}

export interface FeedbackAnnotationDismissParams {
  annotationId: string;
  dismissReason?: string;
  actor?: FeedbackActor;
}
