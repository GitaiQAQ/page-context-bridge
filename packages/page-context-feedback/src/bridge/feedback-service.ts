import type {
  FeedbackActor,
  FeedbackAnnotation,
  FeedbackAnnotationClaimParams,
  FeedbackAnnotationCreateParams,
  FeedbackAnnotationDismissParams,
  FeedbackAnnotationReplyParams,
  FeedbackAnnotationResolveParams,
  FeedbackAnnotationUpdateParams,
  FeedbackCapabilityLinks,
  FeedbackPushAgentStatus,
  FeedbackSession,
  FeedbackStateDeltaParams,
  FeedbackStateDeltaResult,
  FeedbackStateSnapshotParams,
  FeedbackStateSnapshotResult,
  PageContextManifest,
} from "@page-context/shared-protocol";

import { FeedbackStore } from "./feedback-store.js";
import type { FeedbackAgentPushAdapter, FeedbackAgentPushStatusReader } from "./feedback-agent-push.js";

function createFeedbackActor(input: FeedbackActor): FeedbackActor {
  return { source: input.source, id: input.id, displayName: input.displayName };
}

function isFeedbackAgentPushStatusReader(
  adapter: FeedbackAgentPushAdapter | null,
): adapter is FeedbackAgentPushAdapter & FeedbackAgentPushStatusReader {
  return !!adapter && typeof (adapter as unknown as FeedbackAgentPushStatusReader).getPushAgentStatus === "function";
}

function log(...args: unknown[]): void {
  process.stderr.write(`[PAGE-CONTEXT-FEEDBACK] ${args.map(String).join(" ")}\n`);
}

export interface FeedbackLinksDerivedFromState {
  links: FeedbackCapabilityLinks;
  manifest: PageContextManifest | null;
}

export interface RegistryFeedbackService {
  getFeedbackSnapshot(params?: FeedbackStateSnapshotParams): FeedbackStateSnapshotResult;
  getFeedbackDelta(params: FeedbackStateDeltaParams): FeedbackStateDeltaResult;
  createFeedbackAnnotation(params: FeedbackAnnotationCreateParams): FeedbackAnnotation;
  updateFeedbackAnnotation(params: FeedbackAnnotationUpdateParams): FeedbackAnnotation;
  claimFeedbackAnnotation(params: FeedbackAnnotationClaimParams): FeedbackAnnotation;
  replyFeedbackAnnotation(params: FeedbackAnnotationReplyParams): FeedbackAnnotation;
  resolveFeedbackAnnotation(params: FeedbackAnnotationResolveParams): FeedbackAnnotation;
  dismissFeedbackAnnotation(params: FeedbackAnnotationDismissParams): FeedbackAnnotation;
  getFeedbackSession(sessionId: string): { session: FeedbackSession; annotations: FeedbackAnnotation[] } | null;
  listFeedbackSessions(tabId?: number): FeedbackSession[];
  listFeedbackAnnotations(input: { tabId?: number; sessionId?: string }): FeedbackAnnotation[];
  getFeedbackAnnotation(annotationId: string): FeedbackAnnotation | null;
}

export interface CreateRegistryFeedbackServiceInput {
  tenantId: string;
  feedbackAgentPushAdapter: FeedbackAgentPushAdapter | null;
  feedbackAgentPushStatusFallback: FeedbackPushAgentStatus;
  deriveFeedbackLinks: (tabId: number) => FeedbackLinksDerivedFromState;
  logger?: (...args: unknown[]) => void;
}

export function createRegistryFeedbackService(input: CreateRegistryFeedbackServiceInput): RegistryFeedbackService {
  const {
    tenantId,
    feedbackAgentPushAdapter,
    feedbackAgentPushStatusFallback,
    deriveFeedbackLinks,
    logger = log,
  } = input;
  const feedbackStore = new FeedbackStore(tenantId);

  function readFeedbackAgentPushStatus(): FeedbackPushAgentStatus {
    if (feedbackAgentPushAdapter && isFeedbackAgentPushStatusReader(feedbackAgentPushAdapter)) {
      return feedbackAgentPushAdapter.getPushAgentStatus();
    }
    return {
      ...feedbackAgentPushStatusFallback,
      lastLaunch: feedbackAgentPushStatusFallback.lastLaunch
        ? { ...feedbackAgentPushStatusFallback.lastLaunch }
        : null,
    };
  }

  function getFeedbackSnapshot(params: FeedbackStateSnapshotParams = {}): FeedbackStateSnapshotResult {
    const snapshot = feedbackStore.readSnapshot(params);
    return {
      ...snapshot,
      pushAgent: readFeedbackAgentPushStatus(),
    };
  }

  function getFeedbackDelta(params: FeedbackStateDeltaParams): FeedbackStateDeltaResult {
    return feedbackStore.readDelta(params);
  }

  function createFeedbackAnnotation(params: FeedbackAnnotationCreateParams): FeedbackAnnotation {
    const derived = deriveFeedbackLinks(params.tabId);
    const created = feedbackStore.createAnnotation({
      actor: params.actor ?? createFeedbackActor({ source: "extension", id: "extension.user", displayName: "Extension User" }),
      body: params.body,
      priority: params.priority,
      tabId: params.tabId,
      url: params.url,
      title: params.title,
      selectedText: params.selectedText,
      uiAnchor: params.uiAnchor,
      pageInfoExtra: {
        app: derived.manifest?.app,
        scene: derived.manifest?.scene,
        route: derived.manifest?.route,
      },
      manifestSummary: derived.manifest
        ? {
            namespaceCount: derived.manifest.namespaces.length,
            resourceCount: derived.manifest.resources.length,
            skillCount: derived.manifest.skills.length,
          }
        : undefined,
      linkedCapabilities: derived.links,
    });

    try {
      feedbackAgentPushAdapter?.pushNewAnnotation(created);
    } catch (error) {
      logger(`[feedback-agent-push] unexpected trigger error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return created;
  }

  function updateFeedbackAnnotation(params: FeedbackAnnotationUpdateParams): FeedbackAnnotation {
    return feedbackStore.updateAnnotation({
      annotationId: params.annotationId,
      body: params.body,
      priority: params.priority,
      actor: params.actor ?? createFeedbackActor({ source: "extension", id: "extension.user", displayName: "Extension User" }),
    });
  }

  function claimFeedbackAnnotation(params: FeedbackAnnotationClaimParams): FeedbackAnnotation {
    return feedbackStore.claimAnnotation({
      annotationId: params.annotationId,
      actor: params.actor ?? createFeedbackActor({ source: "agent", id: "mcp.agent", displayName: "MCP Agent" }),
    });
  }

  function replyFeedbackAnnotation(params: FeedbackAnnotationReplyParams): FeedbackAnnotation {
    return feedbackStore.replyAnnotation({
      annotationId: params.annotationId,
      actor: params.actor ?? createFeedbackActor({ source: "agent", id: "mcp.agent", displayName: "MCP Agent" }),
      body: params.body,
      kind: params.kind,
    });
  }

  function resolveFeedbackAnnotation(params: FeedbackAnnotationResolveParams): FeedbackAnnotation {
    return feedbackStore.resolveAnnotation({
      annotationId: params.annotationId,
      actor: params.actor ?? createFeedbackActor({ source: "agent", id: "mcp.agent", displayName: "MCP Agent" }),
      resolution: params.resolution,
    });
  }

  function dismissFeedbackAnnotation(params: FeedbackAnnotationDismissParams): FeedbackAnnotation {
    return feedbackStore.dismissAnnotation({
      annotationId: params.annotationId,
      actor: params.actor ?? createFeedbackActor({ source: "agent", id: "mcp.agent", displayName: "MCP Agent" }),
      dismissReason: params.dismissReason,
    });
  }

  function getFeedbackSession(sessionId: string): { session: FeedbackSession; annotations: FeedbackAnnotation[] } | null {
    const session = feedbackStore.getSession(sessionId);
    if (!session) return null;
    return {
      session,
      annotations: feedbackStore.listAnnotationsBySession(sessionId),
    };
  }

  function listFeedbackSessions(tabId?: number): FeedbackSession[] {
    return feedbackStore.listSessions(tabId);
  }

  function listFeedbackAnnotations(input: { tabId?: number; sessionId?: string }): FeedbackAnnotation[] {
    if (input.sessionId) {
      return feedbackStore.listAnnotationsBySession(input.sessionId);
    }
    const sessions = feedbackStore.listSessions(input.tabId);
    return sessions.flatMap((session) => feedbackStore.listAnnotationsBySession(session.id));
  }

  function getFeedbackAnnotation(annotationId: string): FeedbackAnnotation | null {
    return feedbackStore.getAnnotation(annotationId);
  }

  return {
    getFeedbackSnapshot,
    getFeedbackDelta,
    createFeedbackAnnotation,
    updateFeedbackAnnotation,
    claimFeedbackAnnotation,
    replyFeedbackAnnotation,
    resolveFeedbackAnnotation,
    dismissFeedbackAnnotation,
    getFeedbackSession,
    listFeedbackSessions,
    listFeedbackAnnotations,
    getFeedbackAnnotation,
  };
}
