import type {
  FeedbackPriority,
  FeedbackStateDeltaResult,
  FeedbackStateSnapshotResult,
  FeedbackUiAnchor,
  FeedbackUiRect,
} from './feedback';

export interface FeedbackUiTarget {
  elementName: string;
  elementPath: string;
  rect: FeedbackUiRect;
}

export interface FeedbackUiCreateInput {
  body: string;
  priority: FeedbackPriority;
  selectedText?: string;
  uiAnchor?: FeedbackUiAnchor;
  target: FeedbackUiTarget;
}

export interface FeedbackUiCreateResult {
  id?: string;
  raw?: unknown;
}

export interface FeedbackUiUpdateInput {
  annotationId: string;
  body: string;
  priority: FeedbackPriority;
}

export interface FeedbackUiDismissInput {
  annotationId: string;
  dismissReason?: string;
}

export interface FeedbackUiAdapter {
  createAnnotation(input: FeedbackUiCreateInput): Promise<FeedbackUiCreateResult>;
  updateAnnotation?(input: FeedbackUiUpdateInput): Promise<unknown>;
  dismissAnnotation?(input: FeedbackUiDismissInput): Promise<unknown>;
  getFeedbackSnapshot?(): Promise<FeedbackStateSnapshotResult>;
  getFeedbackStateDelta?(): Promise<FeedbackStateDeltaResult>;
}

export interface FeedbackRuntimeCreatePayload {
  body: string;
  priority: FeedbackPriority;
  selectedText?: string;
  uiAnchor?: FeedbackUiAnchor;
  anchor?: FeedbackUiAnchor;
}

export interface FeedbackRuntimeUpdatePayload {
  annotationId: string;
  body: string;
  priority: FeedbackPriority;
}

export interface FeedbackRuntimeDismissPayload {
  annotationId: string;
  dismissReason?: string;
}
