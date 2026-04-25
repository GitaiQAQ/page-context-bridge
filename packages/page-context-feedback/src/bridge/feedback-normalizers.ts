/**
 * Pure utility functions for normalizing feedback data.
 * No state dependencies — safe to import from any module.
 */

import type { FeedbackUiAnchor } from "@page-context/shared-protocol";

/** Normalizes a UI anchor by cleaning and validating fields. Returns undefined if the result has no meaningful content. */
export function normalizeUiAnchor(anchor: FeedbackUiAnchor | undefined): FeedbackUiAnchor | undefined {
  if (!anchor) return undefined;

  const framePath = Array.isArray(anchor.framePath)
    ? anchor.framePath.filter((item) => Number.isInteger(item) && item >= 0)
    : undefined;
  const textRange = normalizeUiTextRange(anchor.textRange);
  const rect = normalizeUiRect(anchor.rect);
  const meta = anchor.meta && Object.keys(anchor.meta).length > 0 ? cloneValue(anchor.meta) : undefined;

  const normalized: FeedbackUiAnchor = {
    elementId: normalizeText(anchor.elementId),
    cssSelector: normalizeText(anchor.cssSelector),
    xpath: normalizeText(anchor.xpath),
    textQuote: normalizeText(anchor.textQuote),
    framePath: framePath?.length ? framePath : undefined,
    textRange,
    rect,
    meta,
  };

  if (
    normalized.elementId || normalized.cssSelector || normalized.xpath ||
    normalized.textQuote || normalized.framePath || normalized.textRange || normalized.rect || normalized.meta
  ) {
    return normalized;
  }
  return undefined;
}

/** Normalizes a UI rect, discarding invalid geometric data (NaN, negative dimensions). */
export function normalizeUiRect(
  rect: FeedbackUiAnchor["rect"] | undefined,
): FeedbackUiAnchor["rect"] | undefined {
  if (!rect) return undefined;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width < 0 || height < 0) return undefined;
  return { x, y, width, height };
}

/** Normalizes a text range to [start, end] with non-negative integer validation. */
export function normalizeUiTextRange(
  range: FeedbackUiAnchor["textRange"] | undefined,
): FeedbackUiAnchor["textRange"] | undefined {
  if (!range) return undefined;
  const start = Number(range.start);
  const end = Number(range.end);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
  if (start < 0 || end < start) return undefined;
  return { start, end };
}

/** Trims text value, returning undefined if empty. */
export function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Deduplicates string array while preserving order. */
export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

/** Deep clones a value via JSON serialization round-trip. */
export function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
