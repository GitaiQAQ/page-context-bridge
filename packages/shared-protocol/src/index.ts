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
} from "./rpc";

export {
  BRIDGE_METHODS,
  type ContextNamespaceDescriptor,
  type ContextResourceDescriptor,
  type ContextResourcePayload,
  type ContextSkillDescriptor,
  type ContextSkillPrompt,
  type PageContextManifest,
} from "./context-manifest";

export {
  type ToolSpec,
  type ToolExecutionContext,
  type ToolDefinition,
  type BridgeToolCallFn,
  type BridgeToolProvider,
  type ExtensionToolProvider,
  type ContentScriptToolEnv,
  type ServiceWorkerToolContext,
} from "./tool-provider";
