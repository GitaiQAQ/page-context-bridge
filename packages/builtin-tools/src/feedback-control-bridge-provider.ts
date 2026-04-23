/**
 * Bridge-side provider for feedback control tools.
 *
 * 这批工具只做“参数适配 + 能力编排”，状态真值仍由 bridge 的 feedback-store 维护。
 * 命名统一走 namespace 形式：`feedback.*`。
 */

import type {
  FeedbackActor,
  FeedbackActorSource,
  FeedbackAnnotationCreateParams,
  FeedbackAnnotationUpdateParams,
  FeedbackStateSnapshotParams,
} from "@page-context/shared-protocol";
import { z } from "zod";

function createTextResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export interface FeedbackControlBridgeRpc {
  getFeedbackSnapshot(params: FeedbackStateSnapshotParams): unknown;
  createFeedbackAnnotation(params: FeedbackAnnotationCreateParams): unknown;
  updateFeedbackAnnotation(params: FeedbackAnnotationUpdateParams): unknown;
}

export interface FeedbackControlBridgeProviderOptions {
  namespace?: string;
  includeLegacyAliases?: boolean;
}

export const FEEDBACK_CONTROL_TOOL_SUFFIXES = {
  getSnapshot: "get_snapshot",
  createAnnotation: "create_annotation",
  updateAnnotation: "update_annotation",
} as const;

export const FEEDBACK_CONTROL_LEGACY_TOOL_NAMES = {
  getSnapshot: "feedback_get_snapshot",
  createAnnotation: "feedback_create_annotation",
  updateAnnotation: "feedback_update_annotation",
} as const;

const feedbackPrioritySchema = z.enum(["low", "normal", "high", "critical"]);
const feedbackActorSourceSchema = z.enum(["user", "agent", "bridge", "extension"]);

// uiAnchor 只做结构校验；详细清洗继续下沉到 feedback-store，避免重复实现规则。
const feedbackUiRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const feedbackUiTextRangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
}).refine((value) => value.end >= value.start, {
  path: ["end"],
  message: "end must be greater than or equal to start",
});

const feedbackUiAnchorSchema = z.object({
  elementId: z.string().optional(),
  cssSelector: z.string().optional(),
  xpath: z.string().optional(),
  textQuote: z.string().optional(),
  framePath: z.array(z.number().int().nonnegative()).optional(),
  rect: feedbackUiRectSchema.optional(),
  textRange: feedbackUiTextRangeSchema.optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const feedbackGetSnapshotSchema = z.object({
  tabId: z.number().int().optional(),
  sessionId: z.string().optional(),
});

const feedbackCreateAnnotationSchema = z.object({
  body: z.string().trim().min(1),
  priority: feedbackPrioritySchema.optional(),
  tabId: z.number().int().positive(),
  url: z.string().trim().min(1),
  title: z.string().optional(),
  selectedText: z.string().optional(),
  uiAnchor: feedbackUiAnchorSchema.optional(),
  actorSource: feedbackActorSourceSchema.optional(),
  actorId: z.string().trim().min(1).optional(),
  actorName: z.string().trim().min(1).optional(),
});

const feedbackUpdateAnnotationSchema = z.object({
  annotationId: z.string().trim().min(1),
  body: z.string().trim().min(1),
  priority: feedbackPrioritySchema.optional(),
  actorSource: feedbackActorSourceSchema.optional(),
  actorId: z.string().trim().min(1).optional(),
  actorName: z.string().trim().min(1).optional(),
});

export class FeedbackControlBridgeProvider {
  readonly id = "feedback-control";
  private readonly namespace: string;
  private readonly includeLegacyAliases: boolean;

  constructor(options: FeedbackControlBridgeProviderOptions = {}) {
    this.namespace = options.namespace ?? "feedback";
    this.includeLegacyAliases = options.includeLegacyAliases ?? true;
  }

  getToolNames(): {
    getSnapshot: string;
    createAnnotation: string;
    updateAnnotation: string;
  } {
    return {
      getSnapshot: `${this.namespace}.${FEEDBACK_CONTROL_TOOL_SUFFIXES.getSnapshot}`,
      createAnnotation: `${this.namespace}.${FEEDBACK_CONTROL_TOOL_SUFFIXES.createAnnotation}`,
      updateAnnotation: `${this.namespace}.${FEEDBACK_CONTROL_TOOL_SUFFIXES.updateAnnotation}`,
    };
  }

  registerOnBridge(
    registerTool: (
      name: string,
      schema: { description: string; inputSchema: Record<string, z.ZodTypeAny>; annotations?: Record<string, unknown> },
      handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
    ) => { remove: () => void },
    rpc: FeedbackControlBridgeRpc,
  ): Map<string, { remove: () => void }> {
    const handles = new Map<string, { remove: () => void }>();
    const names = this.getToolNames();

    const register = (
      name: string,
      config: { description: string; inputSchema: Record<string, z.ZodTypeAny>; annotations?: Record<string, unknown> },
      handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
    ) => {
      handles.set(name, registerTool(name, config, handler));
    };

    const registerAlias = (
      alias: string,
      primaryName: string,
      config: { description: string; inputSchema: Record<string, z.ZodTypeAny>; annotations?: Record<string, unknown> },
      handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
    ) => {
      if (!this.includeLegacyAliases) {
        return;
      }
      register(
        alias,
        {
          ...config,
          // 旧名只保兼容，降低历史 prompt/tool-list 的迁移成本。
          description: `${config.description} (Deprecated alias. Use '${primaryName}' instead.)`,
        },
        handler,
      );
    };

    const getSnapshotConfig = {
      description: "Read feedback snapshot (sessions + annotations + cursor metadata).",
      inputSchema: {
        tabId: feedbackGetSnapshotSchema.shape.tabId,
        sessionId: feedbackGetSnapshotSchema.shape.sessionId,
      },
      annotations: { readOnlyHint: true },
    };
    const createAnnotationConfig = {
      description: "Create a feedback annotation from MCP side with tab context.",
      inputSchema: {
        body: feedbackCreateAnnotationSchema.shape.body,
        priority: feedbackCreateAnnotationSchema.shape.priority,
        tabId: feedbackCreateAnnotationSchema.shape.tabId,
        url: feedbackCreateAnnotationSchema.shape.url,
        title: feedbackCreateAnnotationSchema.shape.title,
        selectedText: feedbackCreateAnnotationSchema.shape.selectedText,
        uiAnchor: feedbackCreateAnnotationSchema.shape.uiAnchor,
        actorSource: feedbackCreateAnnotationSchema.shape.actorSource,
        actorId: feedbackCreateAnnotationSchema.shape.actorId,
        actorName: feedbackCreateAnnotationSchema.shape.actorName,
      },
    };
    const updateAnnotationConfig = {
      description: "Update an existing feedback annotation body/priority.",
      inputSchema: {
        annotationId: feedbackUpdateAnnotationSchema.shape.annotationId,
        body: feedbackUpdateAnnotationSchema.shape.body,
        priority: feedbackUpdateAnnotationSchema.shape.priority,
        actorSource: feedbackUpdateAnnotationSchema.shape.actorSource,
        actorId: feedbackUpdateAnnotationSchema.shape.actorId,
        actorName: feedbackUpdateAnnotationSchema.shape.actorName,
      },
    };

    const getSnapshotHandler = async (args: Record<string, unknown>) => {
      const parsed = feedbackGetSnapshotSchema.parse(args);
      const snapshot = rpc.getFeedbackSnapshot(parsed);
      return createTextResponse(JSON.stringify(snapshot, null, 2));
    };

    const createAnnotationHandler = async (args: Record<string, unknown>) => {
      const parsed = feedbackCreateAnnotationSchema.parse(args);
      const annotation = rpc.createFeedbackAnnotation({
        body: parsed.body,
        priority: parsed.priority,
        tabId: parsed.tabId,
        url: parsed.url,
        title: parsed.title,
        selectedText: parsed.selectedText,
        uiAnchor: parsed.uiAnchor,
        actor: toFeedbackActor(parsed.actorSource, parsed.actorId, parsed.actorName),
      });
      return createTextResponse(JSON.stringify({ annotation }, null, 2));
    };

    const updateAnnotationHandler = async (args: Record<string, unknown>) => {
      const parsed = feedbackUpdateAnnotationSchema.parse(args);
      const annotation = rpc.updateFeedbackAnnotation({
        annotationId: parsed.annotationId,
        body: parsed.body,
        priority: parsed.priority,
        actor: toFeedbackActor(parsed.actorSource, parsed.actorId, parsed.actorName),
      });
      return createTextResponse(JSON.stringify({ annotation }, null, 2));
    };

    register(names.getSnapshot, getSnapshotConfig, getSnapshotHandler);
    registerAlias(FEEDBACK_CONTROL_LEGACY_TOOL_NAMES.getSnapshot, names.getSnapshot, getSnapshotConfig, getSnapshotHandler);

    register(names.createAnnotation, createAnnotationConfig, createAnnotationHandler);
    registerAlias(FEEDBACK_CONTROL_LEGACY_TOOL_NAMES.createAnnotation, names.createAnnotation, createAnnotationConfig, createAnnotationHandler);

    register(names.updateAnnotation, updateAnnotationConfig, updateAnnotationHandler);
    registerAlias(FEEDBACK_CONTROL_LEGACY_TOOL_NAMES.updateAnnotation, names.updateAnnotation, updateAnnotationConfig, updateAnnotationHandler);

    return handles;
  }
}

function toFeedbackActor(
  actorSource: FeedbackActorSource | undefined,
  actorId: string | undefined,
  actorName: string | undefined,
): FeedbackActor {
  return {
    source: actorSource ?? "agent",
    id: actorId ?? "mcp.agent",
    displayName: actorName ?? "MCP Agent",
  };
}
