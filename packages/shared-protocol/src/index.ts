/**
 * Shared protocol barrel export.
 * Re-exports everything from the sub-modules for backward compatibility.
 */

export {
  JSON_RPC_VERSION,
  RPC_ERROR_CODES,
  RpcProtocolError,
  RpcPeer,
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  parseMessage,
  serializeMessage,
  isRpcRequest,
  isRpcNotification,
  isRpcResponse,
  normalizeError,
  type RpcMeta,
  type RpcErrorShape,
  type RpcRequest,
  type RpcNotification,
  type RpcSuccess,
  type RpcFailure,
  type RpcResponse,
  type RpcMessage,
  type RpcHandler,
  type RpcPeerOptions,
} from './rpc';

export {
  BRIDGE_METHODS,
  type ContextNamespaceDescriptor,
  type ContextResourceDescriptor,
  type ContextResourcePayload,
  type ContextSkillDescriptor,
  type ContextSkillPrompt,
  type PageContextManifest,
} from './context-manifest';

export {
  CONNECTION_METHODS,
  type ConnectionAction,
  type ConnectionActionParams,
  type ConnectionCapabilities,
  type ConnectionDescriptor,
  type ConnectionKind,
  type ConnectionStatus,
  type ConnectionsListResult,
  type ConnectionsSubscribeResult,
} from './connections';

export {
  FEEDBACK_METHODS,
  type FeedbackAnnotationStatus,
  type FeedbackPriority,
  type FeedbackActorSource,
  type FeedbackActor,
  type FeedbackSession,
  type FeedbackTarget,
  type FeedbackUiAnchor,
  type FeedbackUiRect,
  type FeedbackUiTextRange,
  type FeedbackCapabilityLinks,
  type FeedbackContext,
  type FeedbackThreadMessage,
  type FeedbackAnnotation,
  type FeedbackEventType,
  type FeedbackEvent,
  type FeedbackStateSnapshotParams,
  type FeedbackPushAgentLastLaunch,
  type FeedbackPushAgentStatus,
  type FeedbackStateSnapshotResult,
  type FeedbackStateDeltaParams,
  type FeedbackStateDeltaResult,
  type FeedbackAnnotationCreateParams,
  type FeedbackAnnotationUpdateParams,
  type FeedbackAnnotationClaimParams,
  type FeedbackAnnotationReplyParams,
  type FeedbackAnnotationResolveParams,
  type FeedbackAnnotationDismissParams,
} from './feedback';

export {
  type FeedbackUiTarget,
  type FeedbackUiCreateInput,
  type FeedbackUiCreateResult,
  type FeedbackUiUpdateInput,
  type FeedbackUiDismissInput,
  type FeedbackUiAdapter,
  type FeedbackRuntimeCreatePayload,
  type FeedbackRuntimeUpdatePayload,
  type FeedbackRuntimeDismissPayload,
} from './feedback-ui-contract';

export {
  type ToolSpec,
  type ToolExecutionContext,
  type ToolDefinition,
  type BridgeToolCallFn,
  type BridgeToolProvider,
  type ExtensionToolProvider,
  type ContentScriptToolEnv,
  type ServiceWorkerToolContext,
} from './tool-provider';
