import type {
  AgentationShellBridgeAdapter,
  AgentationShellDeps,
  AgentationShellFeedbackDelta,
  AgentationShellFeedbackSnapshot,
} from "@page-context/agentation-shell";
import type { FeedbackAnnotation, FeedbackPriority, FeedbackUiAnchor, FeedbackUiRect } from "@page-context/shared-protocol";

import { loadAnnotations, saveAnnotations } from "./vendor/agentation/utils/storage";
import type { Annotation as VendorAnnotation } from "./vendor/agentation/types";

const NON_REPLAYABLE_ANNOTATION_STATUS = new Set(["resolved", "dismissed"]);

export interface AgentationSnapshotReplayBinding {
  localId: string;
  remoteId: string;
  priority: FeedbackPriority;
}

export interface AgentationSnapshotWarmupResult {
  status: "skipped" | "completed" | "failed";
  replayBindings: AgentationSnapshotReplayBinding[];
  annotationCount: number;
}

export interface AgentationFeedbackDeltaPlan {
  dismissedAnnotationIds: Set<string>;
  shouldReloadSnapshot: boolean;
  eventCount: number;
}

export interface DismissVendorAnnotationsResult {
  removedCount: number;
  annotationCount: number;
}

export interface AgentationSnapshotWarmupDeps {
  adapter: AgentationShellBridgeAdapter;
  win: Window;
  logger?: AgentationShellDeps["logger"];
}

/**
 * 在 vendored Agentation 挂载前，把远端 snapshot 预热到它既有 localStorage key。
 * 后续要接入 delta 时，只需复用本文件的映射函数并改写写入策略即可。
 */
export async function warmupAgentationSnapshotBeforeMount(
  deps: AgentationSnapshotWarmupDeps,
): Promise<AgentationSnapshotWarmupResult> {
  if (!deps.adapter.getFeedbackSnapshot) {
    return { status: "skipped", replayBindings: [], annotationCount: 0 };
  }

  const pathname = normalizePathname(deps.win.location.pathname);
  try {
    const snapshot = await deps.adapter.getFeedbackSnapshot();
    const mapped = mapFeedbackSnapshotToVendorAnnotations(snapshot, deps.win);
    // 覆盖写入使 snapshot 成为首次渲染权威来源，避免继续依赖旧 localStorage 残留。
    saveAnnotations<VendorAnnotation>(pathname, mapped.annotations);
    return {
      status: "completed",
      replayBindings: mapped.replayBindings,
      annotationCount: mapped.annotations.length,
    };
  } catch (error) {
    deps.logger?.("error", "agentation package snapshot warmup failed", {
      error,
      pathname,
    });
    return { status: "failed", replayBindings: [], annotationCount: 0 };
  }
}

/**
 * React root 和 shell 共享同一套最小 delta 策略，避免策略分叉：
 * - dismissed + annotationId：直删本地
 * - 其他 annotation 事件：回退 snapshot reload
 */
export function buildAgentationFeedbackDeltaPlan(delta: AgentationShellFeedbackDelta): AgentationFeedbackDeltaPlan {
  const plan: AgentationFeedbackDeltaPlan = {
    dismissedAnnotationIds: new Set<string>(),
    shouldReloadSnapshot: false,
    eventCount: 0,
  };

  for (const event of delta.events) {
    const eventType = event.eventType;
    if (!eventType.startsWith("annotation.")) {
      continue;
    }
    plan.eventCount += 1;

    if (eventType === "annotation.dismissed") {
      const annotationId = normalizeText(event.annotationId);
      if (annotationId) {
        plan.dismissedAnnotationIds.add(annotationId);
        continue;
      }
      // payload 缺关键字段时保守回退，优先保证最终一致性。
      plan.shouldReloadSnapshot = true;
      continue;
    }

    // created/updated/claimed/replied/resolved 等都统一触发一次全量回放。
    plan.shouldReloadSnapshot = true;
  }

  return plan;
}

/**
 * 只在 extension bridge 层动 localStorage，不侵入 vendored 组件状态机。
 * 返回删除数量，供上层决定是否需要 remount。
 */
export function dismissVendorAnnotationsFromStorage(args: {
  win: Window;
  annotationIds: Iterable<string>;
}): DismissVendorAnnotationsResult {
  const pathname = normalizePathname(args.win.location.pathname);
  const ids = new Set<string>();
  for (const rawId of args.annotationIds) {
    const id = normalizeText(rawId);
    if (id) {
      ids.add(id);
    }
  }

  const stored = loadAnnotations<VendorAnnotation>(pathname);
  if (stored.length === 0 || ids.size === 0) {
    return { removedCount: 0, annotationCount: stored.length };
  }

  const next = stored.filter((annotation) => {
    const annotationId = normalizeText(annotation.id);
    if (!annotationId) {
      return true;
    }
    return !ids.has(annotationId);
  });
  const removedCount = stored.length - next.length;
  if (removedCount > 0) {
    saveAnnotations<VendorAnnotation>(pathname, next);
  }

  return {
    removedCount,
    annotationCount: next.length,
  };
}

interface SnapshotMappingResult {
  annotations: VendorAnnotation[];
  replayBindings: AgentationSnapshotReplayBinding[];
}

function mapFeedbackSnapshotToVendorAnnotations(snapshot: AgentationShellFeedbackSnapshot, win: Window): SnapshotMappingResult {
  const annotations: VendorAnnotation[] = [];
  const replayBindings: AgentationSnapshotReplayBinding[] = [];
  const seenIds = new Set<string>();

  for (const feedbackAnnotation of snapshot.annotations) {
    if (NON_REPLAYABLE_ANNOTATION_STATUS.has(feedbackAnnotation.status)) {
      continue;
    }
    const mapped = mapFeedbackAnnotationToVendorAnnotation(feedbackAnnotation, win);
    if (!mapped) {
      continue;
    }
    if (seenIds.has(mapped.id)) {
      continue;
    }
    seenIds.add(mapped.id);
    annotations.push(mapped);
    replayBindings.push({
      localId: mapped.id,
      remoteId: feedbackAnnotation.id,
      priority: feedbackAnnotation.priority,
    });
  }

  return { annotations, replayBindings };
}

/**
 * 单条映射坚持“只用协议稳定字段”，未知字段不猜测，避免把 bridge 绑死在临时结构上。
 */
function mapFeedbackAnnotationToVendorAnnotation(annotation: FeedbackAnnotation, win: Window): VendorAnnotation | null {
  const id = normalizeText(annotation.id);
  const comment = normalizeText(annotation.body);
  if (!id || !comment) {
    return null;
  }

  const uiAnchor = annotation.target.uiAnchor ?? annotation.context.uiAnchor;
  const rect = normalizeUiRect(uiAnchor?.rect);
  const anchorMeta = readAnchorMeta(uiAnchor);
  const isFixed = readBooleanFromMeta(anchorMeta, "isFixed");

  const viewportWidth = Math.max(1, win.innerWidth);
  const fallbackCenterX = viewportWidth / 2;
  const anchorCenterX = rect ? rect.x + rect.width / 2 : fallbackCenterX;
  const x = clampNumber((anchorCenterX / viewportWidth) * 100, 0, 100);

  const fallbackViewportY = Math.max(0, win.innerHeight / 2);
  const anchorViewportY = rect ? rect.y + rect.height / 2 : fallbackViewportY;
  const y = isFixed ? anchorViewportY : anchorViewportY + win.scrollY;
  const boundingBox = rect
    ? {
        x: rect.x,
        y: isFixed ? rect.y : rect.y + win.scrollY,
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      }
    : undefined;

  const elementPath = firstDefinedText(
    readStringFromMeta(anchorMeta, "elementPath"),
    readStringFromMeta(anchorMeta, "fullPath"),
    normalizeText(uiAnchor?.cssSelector),
    "[feedback-annotation]",
  )!;
  const element = firstDefinedText(
    readStringFromMeta(anchorMeta, "element"),
    readStringFromMeta(anchorMeta, "elementName"),
    inferElementNameFromPath(elementPath),
    "element",
  )!;
  const selectedText = firstDefinedText(
    normalizeText(annotation.target.textQuote),
    normalizeText(annotation.context.selectedText),
    normalizeText(uiAnchor?.textQuote),
  );

  return {
    id,
    x,
    y,
    comment,
    element,
    elementPath,
    // 远端注释可能早于 7 天；用当前时间戳可避免被 vendored retention 规则误清理。
    timestamp: Date.now(),
    selectedText,
    boundingBox,
    fullPath: firstDefinedText(readStringFromMeta(anchorMeta, "fullPath"), elementPath),
    reactComponents: readStringFromMeta(anchorMeta, "reactComponents"),
    sourceFile: readStringFromMeta(anchorMeta, "sourceFile"),
    isMultiSelect: readBooleanFromMeta(anchorMeta, "isMultiSelect"),
    isFixed,
    severity: toVendorSeverity(annotation.priority),
    sessionId: annotation.sessionId,
    url: annotation.target.url,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
  };
}

function normalizePathname(pathname: string | undefined): string {
  const normalized = pathname?.trim();
  return normalized ? normalized : "/";
}

function normalizeUiRect(rect: FeedbackUiRect | undefined): FeedbackUiRect | null {
  if (!rect) {
    return null;
  }
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  return {
    x,
    y,
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

function readAnchorMeta(uiAnchor: FeedbackUiAnchor | undefined): Record<string, unknown> | null {
  if (!uiAnchor || !uiAnchor.meta || typeof uiAnchor.meta !== "object") {
    return null;
  }
  return uiAnchor.meta as Record<string, unknown>;
}

function readStringFromMeta(meta: Record<string, unknown> | null, key: string): string | undefined {
  if (!meta) {
    return undefined;
  }
  const value = meta[key];
  return typeof value === "string" ? normalizeText(value) : undefined;
}

function readBooleanFromMeta(meta: Record<string, unknown> | null, key: string): boolean | undefined {
  if (!meta) {
    return undefined;
  }
  const value = meta[key];
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function inferElementNameFromPath(path: string): string | undefined {
  const normalized = path.trim();
  if (!normalized) {
    return undefined;
  }
  const segments = normalized
    .split(">")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const leaf = segments.at(-1) ?? normalized;
  if (leaf.startsWith("#") || leaf.startsWith(".")) {
    return undefined;
  }
  const matched = leaf.match(/^[A-Za-z][A-Za-z0-9-]*/);
  return matched?.[0]?.toLowerCase();
}

function toVendorSeverity(priority: FeedbackPriority): VendorAnnotation["severity"] {
  switch (priority) {
    case "critical":
      return "blocking";
    case "high":
      return "important";
    default:
      return "suggestion";
  }
}

function firstDefinedText(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
