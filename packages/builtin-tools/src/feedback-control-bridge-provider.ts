/**
 * Bridge-side provider for feedback control tools.
 *
 * 这批工具只做“参数适配 + 能力编排”，状态真值仍由 bridge 的 feedback-store 维护。
 * 命名统一走 `feedback.*` namespace。
 */

import type {
  FeedbackActor,
  FeedbackActorSource,
  FeedbackAnnotationClaimParams,
  FeedbackAnnotationCreateParams,
  FeedbackAnnotationDismissParams,
  FeedbackAnnotationReplyParams,
  FeedbackAnnotationResolveParams,
  FeedbackAnnotationUpdateParams,
  FeedbackStateDeltaParams,
  FeedbackStateSnapshotParams,
} from "@page-context/shared-protocol";
import { z } from "zod";

function createTextResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export interface FeedbackControlBridgeRpc {
  getFeedbackSnapshot(params: FeedbackStateSnapshotParams): unknown;
  getFeedbackDelta(params: FeedbackStateDeltaParams): unknown;
  createFeedbackAnnotation(params: FeedbackAnnotationCreateParams): unknown;
  updateFeedbackAnnotation(params: FeedbackAnnotationUpdateParams): unknown;
  claimFeedbackAnnotation(params: FeedbackAnnotationClaimParams): unknown;
  replyFeedbackAnnotation(params: FeedbackAnnotationReplyParams): unknown;
  resolveFeedbackAnnotation(params: FeedbackAnnotationResolveParams): unknown;
  dismissFeedbackAnnotation(params: FeedbackAnnotationDismissParams): unknown;
}

export interface FeedbackControlBridgeProviderOptions {
  namespace?: string;
  includeLegacyAliases?: boolean;
}

export const FEEDBACK_CONTROL_TOOL_SUFFIXES = {
  getSnapshot: "get_snapshot",
  watchEvents: "watch_events",
  createAnnotation: "create_annotation",
  updateAnnotation: "update_annotation",
  claim: "claim",
  reply: "reply",
  resolve: "resolve",
  dismiss: "dismiss",
} as const;

export const FEEDBACK_CONTROL_LEGACY_TOOL_NAMES = {
  getSnapshot: "feedback_get_snapshot",
  watchEvents: "feedback_watch_events",
  createAnnotation: "feedback_create_annotation",
  updateAnnotation: "feedback_update_annotation",
  claim: "feedback_claim_annotation",
  reply: "feedback_reply_annotation",
  resolve: "feedback_resolve_annotation",
  dismiss: "feedback_dismiss_annotation",
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

const feedbackWatchEventsSchema = z.object({
  afterSeq: z.number().int().nonnegative().default(0),
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

const feedbackClaimAnnotationSchema = z.object({
  annotationId: z.string().trim().min(1),
  actorSource: feedbackActorSourceSchema.optional(),
  actorId: z.string().trim().min(1).optional(),
  actorName: z.string().trim().min(1).optional(),
});

const feedbackReplyAnnotationSchema = z.object({
  annotationId: z.string().trim().min(1),
  body: z.string().trim().min(1),
  kind: z.enum(["comment", "action_note", "resolution_note"]).optional(),
  actorSource: feedbackActorSourceSchema.optional(),
  actorId: z.string().trim().min(1).optional(),
  actorName: z.string().trim().min(1).optional(),
});

const feedbackResolveAnnotationSchema = z.object({
  annotationId: z.string().trim().min(1),
  resolution: z.string().trim().min(1).optional(),
  actorSource: feedbackActorSourceSchema.optional(),
  actorId: z.string().trim().min(1).optional(),
  actorName: z.string().trim().min(1).optional(),
});

const feedbackDismissAnnotationSchema = z.object({
  annotationId: z.string().trim().min(1),
  dismissReason: z.string().trim().min(1).optional(),
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
    watchEvents: string;
    createAnnotation: string;
    updateAnnotation: string;
    claim: string;
    reply: string;
    resolve: string;
    dismiss: string;
  } {
    return {
      getSnapshot: `${this.namespace}.${FEEDBACK_CONTROL_TOOL_SUFFIXES.getSnapshot}`,
      watchEvents: `${this.namespace}.${FEEDBACK_CONTROL_TOOL_SUFFIXES.watchEvents}`,
      createAnnotation: `${this.namespace}.${FEEDBACK_CONTROL_TOOL_SUFFIXES.createAnnotation}`,
      updateAnnotation: `${this.namespace}.${FEEDBACK_CONTROL_TOOL_SUFFIXES.updateAnnotation}`,
      claim: `${this.namespace}.${FEEDBACK_CONTROL_TOOL_SUFFIXES.claim}`,
      reply: `${this.namespace}.${FEEDBACK_CONTROL_TOOL_SUFFIXES.reply}`,
      resolve: `${this.namespace}.${FEEDBACK_CONTROL_TOOL_SUFFIXES.resolve}`,
      dismiss: `${this.namespace}.${FEEDBACK_CONTROL_TOOL_SUFFIXES.dismiss}`,
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
          // 旧名仅保兼容，降低历史 prompt/tool-list 迁移成本。
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
    const watchEventsConfig = {
      description: "Read feedback delta events after a cursor.",
      inputSchema: {
        afterSeq: feedbackWatchEventsSchema.shape.afterSeq,
        sessionId: feedbackWatchEventsSchema.shape.sessionId,
      },
      annotations: { readOnlyHint: true },
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
    const claimConfig = {
      description: "Claim an open feedback annotation for execution.",
      inputSchema: {
        annotationId: feedbackClaimAnnotationSchema.shape.annotationId,
        actorSource: feedbackClaimAnnotationSchema.shape.actorSource,
        actorId: feedbackClaimAnnotationSchema.shape.actorId,
        actorName: feedbackClaimAnnotationSchema.shape.actorName,
      },
    };
    const replyConfig = {
      description: "Append a reply to an annotation thread.",
      inputSchema: {
        annotationId: feedbackReplyAnnotationSchema.shape.annotationId,
        body: feedbackReplyAnnotationSchema.shape.body,
        kind: feedbackReplyAnnotationSchema.shape.kind,
        actorSource: feedbackReplyAnnotationSchema.shape.actorSource,
        actorId: feedbackReplyAnnotationSchema.shape.actorId,
        actorName: feedbackReplyAnnotationSchema.shape.actorName,
      },
    };
    const resolveConfig = {
      description: "Resolve a claimed feedback annotation.",
      inputSchema: {
        annotationId: feedbackResolveAnnotationSchema.shape.annotationId,
        resolution: feedbackResolveAnnotationSchema.shape.resolution,
        actorSource: feedbackResolveAnnotationSchema.shape.actorSource,
        actorId: feedbackResolveAnnotationSchema.shape.actorId,
        actorName: feedbackResolveAnnotationSchema.shape.actorName,
      },
    };
    const dismissConfig = {
      description: "Dismiss a feedback annotation.",
      inputSchema: {
        annotationId: feedbackDismissAnnotationSchema.shape.annotationId,
        dismissReason: feedbackDismissAnnotationSchema.shape.dismissReason,
        actorSource: feedbackDismissAnnotationSchema.shape.actorSource,
        actorId: feedbackDismissAnnotationSchema.shape.actorId,
        actorName: feedbackDismissAnnotationSchema.shape.actorName,
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

    const watchEventsHandler = async (args: Record<string, unknown>) => {
      const parsed = feedbackWatchEventsSchema.parse(args);
      // 事件模型由 feedback-store 维护；provider 只做轻量入口与参数适配。
      const delta = rpc.getFeedbackDelta({
        afterSeq: parsed.afterSeq,
        sessionId: parsed.sessionId,
      });
      return createTextResponse(JSON.stringify(delta, null, 2));
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

    const claimHandler = async (args: Record<string, unknown>) => {
      const parsed = feedbackClaimAnnotationSchema.parse(args);
      const annotation = rpc.claimFeedbackAnnotation({
        annotationId: parsed.annotationId,
        actor: toFeedbackActor(parsed.actorSource, parsed.actorId, parsed.actorName),
      });
      return createTextResponse(JSON.stringify({ annotation }, null, 2));
    };

    const replyHandler = async (args: Record<string, unknown>) => {
      const parsed = feedbackReplyAnnotationSchema.parse(args);
      const annotation = rpc.replyFeedbackAnnotation({
        annotationId: parsed.annotationId,
        body: parsed.body,
        kind: parsed.kind,
        actor: toFeedbackActor(parsed.actorSource, parsed.actorId, parsed.actorName),
      });
      return createTextResponse(JSON.stringify({ annotation }, null, 2));
    };

    const resolveHandler = async (args: Record<string, unknown>) => {
      const parsed = feedbackResolveAnnotationSchema.parse(args);
      const annotation = rpc.resolveFeedbackAnnotation({
        annotationId: parsed.annotationId,
        resolution: parsed.resolution,
        actor: toFeedbackActor(parsed.actorSource, parsed.actorId, parsed.actorName),
      });
      return createTextResponse(JSON.stringify({ annotation }, null, 2));
    };

    const dismissHandler = async (args: Record<string, unknown>) => {
      const parsed = feedbackDismissAnnotationSchema.parse(args);
      const annotation = rpc.dismissFeedbackAnnotation({
        annotationId: parsed.annotationId,
        dismissReason: parsed.dismissReason,
        actor: toFeedbackActor(parsed.actorSource, parsed.actorId, parsed.actorName),
      });
      return createTextResponse(JSON.stringify({ annotation }, null, 2));
    };

    register(names.getSnapshot, getSnapshotConfig, getSnapshotHandler);
    registerAlias(FEEDBACK_CONTROL_LEGACY_TOOL_NAMES.getSnapshot, names.getSnapshot, getSnapshotConfig, getSnapshotHandler);

    register(names.watchEvents, watchEventsConfig, watchEventsHandler);
    registerAlias(FEEDBACK_CONTROL_LEGACY_TOOL_NAMES.watchEvents, names.watchEvents, watchEventsConfig, watchEventsHandler);

    register(names.createAnnotation, createAnnotationConfig, createAnnotationHandler);
    registerAlias(FEEDBACK_CONTROL_LEGACY_TOOL_NAMES.createAnnotation, names.createAnnotation, createAnnotationConfig, createAnnotationHandler);

    register(names.updateAnnotation, updateAnnotationConfig, updateAnnotationHandler);
    registerAlias(FEEDBACK_CONTROL_LEGACY_TOOL_NAMES.updateAnnotation, names.updateAnnotation, updateAnnotationConfig, updateAnnotationHandler);

    // 动作类入口统一走 feedback.*，别名仅用于兼容历史调用。
    register(names.claim, claimConfig, claimHandler);
    registerAlias(FEEDBACK_CONTROL_LEGACY_TOOL_NAMES.claim, names.claim, claimConfig, claimHandler);

    register(names.reply, replyConfig, replyHandler);
    registerAlias(FEEDBACK_CONTROL_LEGACY_TOOL_NAMES.reply, names.reply, replyConfig, replyHandler);

    register(names.resolve, resolveConfig, resolveHandler);
    registerAlias(FEEDBACK_CONTROL_LEGACY_TOOL_NAMES.resolve, names.resolve, resolveConfig, resolveHandler);

    register(names.dismiss, dismissConfig, dismissHandler);
    registerAlias(FEEDBACK_CONTROL_LEGACY_TOOL_NAMES.dismiss, names.dismiss, dismissConfig, dismissHandler);

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
