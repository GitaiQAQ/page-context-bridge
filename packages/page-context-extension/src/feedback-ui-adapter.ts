import { BRIDGE_METHODS } from "@page-context/shared-protocol";
import type {
  FeedbackStateSnapshotResult,
  FeedbackStateDeltaResult,
  FeedbackUiAdapter,
  FeedbackUiCreateInput,
  FeedbackUiCreateResult,
  FeedbackUiUpdateInput,
  FeedbackUiDismissInput,
} from "@page-context/shared-protocol";

import { sendRuntimeRequest } from "./runtime-rpc";

type RuntimeRequest = <TResult>(method: string, params?: unknown) => Promise<TResult>;

export interface FeedbackUiAdapterDeps {
  sendRequest?: RuntimeRequest;
}

/**
 * Create feedback bridge adapter.
 * Only responsible for "protocol field mapping + afterSeq cursor maintenance", keeping clear message boundaries between UI layer and runtime.
 */
export function createFeedbackUiAdapter(deps: FeedbackUiAdapterDeps = {}): FeedbackUiAdapter {
  const sendRequest = deps.sendRequest ?? sendRuntimeRequest;
  // Cursor state belongs only to the content-script side, not leaked to the UI shell.
  let feedbackLastSeq = 0;

  return {
    async createAnnotation(input: FeedbackUiCreateInput): Promise<FeedbackUiCreateResult> {
      const payload = {
        body: input.body,
        priority: input.priority,
        selectedText: input.selectedText,
        uiAnchor: input.uiAnchor,
      };
      const raw = await sendRequest<unknown>(BRIDGE_METHODS.extensionFeedbackAnnotationCreate, payload);
      return normalizeCreateResult(raw);
    },

    async updateAnnotation(input: FeedbackUiUpdateInput): Promise<unknown> {
      const payload = {
        annotationId: input.annotationId,
        body: input.body,
        priority: input.priority,
      };
      return await sendRequest<unknown>(BRIDGE_METHODS.extensionFeedbackAnnotationUpdate, payload);
    },

    async dismissAnnotation(input: FeedbackUiDismissInput): Promise<unknown> {
      const payload = {
        annotationId: input.annotationId,
        dismissReason: input.dismissReason,
      };
      return await sendRequest<unknown>(BRIDGE_METHODS.extensionFeedbackAnnotationDismiss, payload);
    },

    async getFeedbackSnapshot(): Promise<FeedbackStateSnapshotResult> {
      const snapshot = await sendRequest<FeedbackStateSnapshotResult>(BRIDGE_METHODS.extensionFeedbackStateSnapshot);
      feedbackLastSeq = normalizeFeedbackSeq(snapshot.lastSeq, feedbackLastSeq);
      return snapshot;
    },

    async getFeedbackStateDelta(): Promise<FeedbackStateDeltaResult> {
      const delta = await sendRequest<FeedbackStateDeltaResult>(BRIDGE_METHODS.extensionFeedbackStateDelta, {
        afterSeq: feedbackLastSeq,
      });
      feedbackLastSeq = normalizeFeedbackSeq(delta.lastSeq, feedbackLastSeq);
      return delta;
    },
  };
}

function normalizeFeedbackSeq(next: unknown, fallback: number): number {
  const value = Number(next);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function normalizeCreateResult(raw: unknown): FeedbackUiCreateResult {
  if (!raw || typeof raw !== "object") {
    return { raw };
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.id === "string") {
    return { id: record.id, raw };
  }
  const annotation = record.annotation;
  if (annotation && typeof annotation === "object" && typeof (annotation as { id?: unknown }).id === "string") {
    return { id: (annotation as { id: string }).id, raw };
  }
  return { raw };
}
