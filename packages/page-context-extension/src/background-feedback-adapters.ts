import type {
  FeedbackAnnotationCreateParams,
  FeedbackAnnotationUpdateParams,
} from '@page-context/shared-protocol';
import type {
  FeedbackRuntimeCreatePayload,
  FeedbackRuntimeUpdatePayload,
} from '@page-context/shared-protocol';

import type { ActiveTabFeedbackContext } from './bg-feedback-context';

export function buildFeedbackAnnotationCreateParams(
  payload: FeedbackRuntimeCreatePayload,
  context: ActiveTabFeedbackContext,
): FeedbackAnnotationCreateParams {
  return {
    body: payload.body.trim(),
    priority: payload.priority,
    tabId: context.tabId,
    url: context.url,
    title: context.title,
    selectedText: payload.selectedText?.trim() || context.selectedText,
    uiAnchor: normalizeFeedbackUiAnchor(payload.uiAnchor ?? payload.anchor),
  };
}

export function buildFeedbackAnnotationUpdateParams(
  payload: FeedbackRuntimeUpdatePayload,
): FeedbackAnnotationUpdateParams {
  return {
    annotationId: payload.annotationId.trim(),
    body: payload.body.trim(),
    priority: payload.priority,
  };
}

export function normalizeFeedbackUiAnchor(
  anchor: FeedbackAnnotationCreateParams['uiAnchor'],
): FeedbackAnnotationCreateParams['uiAnchor'] {
  if (!anchor) {
    return undefined;
  }

  const framePath = Array.isArray(anchor.framePath)
    ? anchor.framePath.filter((item) => Number.isInteger(item) && item >= 0)
    : undefined;
  const textQuote = anchor.textQuote?.trim();

  const normalized: FeedbackAnnotationCreateParams['uiAnchor'] = {
    elementId: anchor.elementId?.trim() || undefined,
    cssSelector: anchor.cssSelector?.trim() || undefined,
    xpath: anchor.xpath?.trim() || undefined,
    textQuote: textQuote || undefined,
    framePath: framePath?.length ? framePath : undefined,
    rect: anchor.rect,
    textRange: anchor.textRange,
    meta: anchor.meta && Object.keys(anchor.meta).length > 0 ? anchor.meta : undefined,
  };

  if (
    normalized.elementId ||
    normalized.cssSelector ||
    normalized.xpath ||
    normalized.textQuote ||
    normalized.framePath ||
    normalized.rect ||
    normalized.textRange ||
    normalized.meta
  ) {
    return normalized;
  }
  return undefined;
}
