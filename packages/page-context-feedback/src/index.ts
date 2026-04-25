/**
 * @page-context/feedback — Public API
 *
 * Extracted feedback feature module with dependency injection.
 *
 * Layered architecture:
 *   bridge/     — Store, normalizers, agent push adapter, service interface
 *   extension/  — Background context, runtime adapters, UI adapter, sidepanel renderer
 *   providers/  — MCP tool registration provider
 */

// ─── Bridge Layer ────────────────────────────────────────────────────────

// Store
export { FeedbackStore } from "./bridge/feedback-store.js";
export type {
  FeedbackStoreOptions,
  CreateFeedbackAnnotationInput,
  ClaimFeedbackAnnotationInput,
  ReplyFeedbackAnnotationInput,
  ResolveFeedbackAnnotationInput,
  DismissFeedbackAnnotationInput,
  UpdateFeedbackAnnotationInput,
} from "./bridge/feedback-store.js";

// Normalizers
export {
  normalizeUiAnchor,
  normalizeUiRect,
  normalizeUiTextRange,
  normalizeText,
  uniqueStrings as feedbackUniqueStrings,
  cloneValue,
} from "./bridge/feedback-normalizers.js";

// Agent Push Adapter
export { LocalFeedbackAgentPushAdapter, createFeedbackAgentPushAdapterFromEnv, createFeedbackPushAgentStatus, createFeedbackPushAgentStatusFromEnv } from "./bridge/feedback-agent-push.js";
export type {
  FeedbackAgentPushAdapter,
  FeedbackAgentPushStatusReader,
  LocalFeedbackAgentPushAdapterOptions,
} from "./bridge/feedback-agent-push.js";

// Service Interface
export { createRegistryFeedbackService } from "./bridge/feedback-service.js";
export type { RegistryFeedbackService, CreateRegistryFeedbackServiceInput, FeedbackLinksDerivedFromState } from "./bridge/feedback-service.js";

// ─── Extension Layer ─────────────────────────────────────────────────────

// Background Context
export { captureActiveTabFeedbackContext } from "./extension/bg-feedback-context.js";
export type { ActiveTabFeedbackContext } from "./extension/bg-feedback-context.js";

// Background Adapters
export {
  buildFeedbackAnnotationCreateParams,
  buildFeedbackAnnotationUpdateParams,
  normalizeFeedbackUiAnchor,
} from "./extension/background-feedback-adapters.js";

// UI Adapter
export { createFeedbackUiAdapter } from "./extension/feedback-ui-adapter.js";
export type { FeedbackUiAdapterDeps } from "./extension/feedback-ui-adapter.js";

// Sidepanel Renderer
export {
  renderFeedbackTab,
  renderFeedbackActions,
  renderFeedbackActionForm,
  renderFeedbackThread,
  // Action state management
  createFeedbackActionState,
  reconcileFeedbackActionStates,
  readFeedbackActionState,
  updateFeedbackActionStates,
  // Status helpers
  canClaimAnnotation,
  canReplyAnnotation,
  canResolveAnnotation,
  canDismissAnnotation,
  feedbackStatusBadgeClass,
  feedbackPushAgentBadgeClass,
  feedbackPushAgentBadgeText,
  formatFeedbackTime,
} from "./extension/sidepanel-feedback.js";
export type {
  RenderFeedbackTabInput,
  FeedbackAnnotationActionState,
  FeedbackActionFormMode,
  FeedbackActionInputField,
  SidepanelFeedbackDraft,
} from "./extension/sidepanel-feedback.js";

// ─── Provider Layer ──────────────────────────────────────────────────────

export {
  FeedbackControlBridgeProvider,
  FEEDBACK_CONTROL_TOOL_SUFFIXES,
} from "./providers/feedback-control-provider.js";
export type {
  FeedbackControlBridgeRpc,
  FeedbackControlBridgeProviderOptions,
} from "./providers/feedback-control-provider.js";
