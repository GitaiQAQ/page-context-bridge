export const JSON_RPC_VERSION = "2.0" as const;

export const RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  internalError: -32603,
  timeout: -32001,
  disconnected: -32002,
} as const;

export const BRIDGE_METHODS = {
  sessionRegister: "session.register",
  sessionHeartbeat: "session.heartbeat",
  bridgeToolCall: "bridge.tool.call",
  bridgeToolsList: "bridge.tools.list",
  bridgeTabsList: "bridge.tabs.list",
  bridgePageEvent: "bridge.page.event",
  bridgePageToolsRegistered: "bridge.pageTools.registered",
  bridgePageToolsUnregistered: "bridge.pageTools.unregistered",
  bridgeBuiltinToolsUpdated: "bridge.builtinTools.updated",
  bridgeTabActivated: "bridge.tab.activated",
  bridgeTabUpdated: "bridge.tab.updated",
  extensionStatusGet: "extension.status.get",
  extensionReconnect: "extension.session.reconnect",
  extensionPageToolsGet: "extension.pageTools.get",
  extensionPageToolsTreeGet: "extension.pageTools.tree.get",
  extensionPageToolsDiscover: "extension.pageTools.discover",
  extensionPageToolsSetEnabled: "extension.pageTools.setEnabled",
  extensionContextManifestGet: "extension.context.manifest.get",
  extensionContextResourceRead: "extension.context.resource.read",
  extensionContextSkillGet: "extension.context.skill.get",
  extensionToolDebugCall: "extension.tool.debug.call",
  extensionToolExecute: "extension.tool.execute",
  extensionPageEvent: "extension.page.event",
  extensionPageToolsRegister: "extension.pageTools.register",
} as const;

export interface ContextNamespaceDescriptor {
  namespace: string;
  title: string;
  description?: string;
  tags?: string[];
}

export interface ContextResourceDescriptor {
  id: string;
  namespace: string;
  title: string;
  description?: string;
  mimeType?: string;
  kind?: "json" | "text";
  tags?: string[];
}

export interface ContextResourcePayload {
  id: string;
  mimeType?: string;
  text: string;
}

export interface ContextSkillDescriptor {
  id: string;
  namespace: string;
  title: string;
  description: string;
  intentTags?: string[];
  resourceIds?: string[];
  toolNames?: string[];
  mode?: "analysis" | "readonly" | "mutation" | "macro";
}

export interface ContextSkillPrompt {
  skill: ContextSkillDescriptor;
  text: string;
}

export interface PageContextManifest {
  version: string;
  app: string;
  route: string;
  scene: string;
  namespaces: ContextNamespaceDescriptor[];
  resources: ContextResourceDescriptor[];
  skills: ContextSkillDescriptor[];
  generatedAt: string;
}

export interface RpcMeta {
  sessionId?: string;
  source?: string;
  target?: string;
  tabId?: number;
  timestamp?: number;
  timeoutMs?: number;
}

export interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcRequest<TParams = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string;
  method: string;
  params?: TParams;
  meta?: RpcMeta;
}

export interface RpcNotification<TParams = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  method: string;
  params?: TParams;
  meta?: RpcMeta;
}

export interface RpcSuccess<TResult = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string;
  result: TResult;
}

export interface RpcFailure {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string;
  error: RpcErrorShape;
}

export type RpcResponse<TResult = unknown> = RpcSuccess<TResult> | RpcFailure;
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export class RpcProtocolError extends Error {
  public readonly code: number;
  public readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcProtocolError";
    this.code = code;
    this.data = data;
  }
}

export type RpcHandler = (params: unknown, request: RpcRequest) => Promise<unknown> | unknown;

export interface RpcPeerOptions {
  send: (message: string) => Promise<void> | void;
  getMeta?: () => RpcMeta;
  defaultTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcPeer {
  private readonly sendImpl: RpcPeerOptions["send"];
  private readonly getMeta?: RpcPeerOptions["getMeta"];
  private readonly defaultTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly handlers = new Map<string, RpcHandler>();

  constructor(options: RpcPeerOptions) {
    this.sendImpl = options.send;
    this.getMeta = options.getMeta;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  unregister(method: string): void {
    this.handlers.delete(method);
  }

  async request<TResult = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number; meta?: RpcMeta }): Promise<TResult> {
    const id = createRequestId();
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const request = createRequest(method, params, id, mergeMeta(this.getMeta?.(), options?.meta));

    return await new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcProtocolError(RPC_ERROR_CODES.timeout, `RPC request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timer,
      });

      Promise.resolve(this.sendImpl(serializeMessage(request))).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async notify(method: string, params?: unknown, meta?: RpcMeta): Promise<void> {
    const notification = createNotification(method, params, mergeMeta(this.getMeta?.(), meta));
    await this.sendImpl(serializeMessage(notification));
  }

  async receive(raw: string): Promise<void> {
    const message = parseMessage(raw);
    if (isRpcResponse(message)) {
      this.resolvePending(message);
      return;
    }

    const handler = this.handlers.get(message.method);
    if (!isRpcRequest(message)) {
      if (!handler) {
        return;
      }
      await handler(message.params, createRequest(message.method, message.params, "notification", message.meta));
      return;
    }

    if (!handler) {
      await this.sendImpl(serializeMessage(createErrorResponse(message.id, new RpcProtocolError(RPC_ERROR_CODES.methodNotFound, `Method not found: ${message.method}`))));
      return;
    }

    try {
      const result = await handler(message.params, message);
      await this.sendImpl(serializeMessage(createSuccessResponse(message.id, result)));
    } catch (error) {
      await this.sendImpl(serializeMessage(createErrorResponse(message.id, normalizeError(error))));
    }
  }

  failAllPending(reason: string | Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(reason instanceof Error ? reason : new RpcProtocolError(RPC_ERROR_CODES.disconnected, reason));
      this.pending.delete(id);
    }
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  private resolvePending(message: RpcResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if ("error" in message) {
      pending.reject(new RpcProtocolError(message.error.code, message.error.message, message.error.data));
      return;
    }

    pending.resolve(message.result);
  }
}

export function createRequest(method: string, params?: unknown, id = createRequestId(), meta?: RpcMeta): RpcRequest {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method,
    params,
    meta: withTimestamp(meta),
  };
}

export function createNotification(method: string, params?: unknown, meta?: RpcMeta): RpcNotification {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method,
    params,
    meta: withTimestamp(meta),
  };
}

export function createSuccessResponse<TResult>(id: string, result: TResult): RpcSuccess<TResult> {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  };
}

export function createErrorResponse(id: string, error: unknown): RpcFailure {
  const normalized = normalizeError(error);
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: {
      code: normalized.code,
      message: normalized.message,
      data: normalized.data,
    },
  };
}

export function parseMessage(raw: string): RpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RpcProtocolError(RPC_ERROR_CODES.parseError, "Failed to parse JSON-RPC message", error);
  }

  if (!isJsonRpcEnvelope(parsed)) {
    throw new RpcProtocolError(RPC_ERROR_CODES.invalidRequest, "Invalid JSON-RPC envelope", parsed);
  }

  return parsed;
}

export function serializeMessage(message: RpcMessage): string {
  return JSON.stringify(message);
}

export function isRpcRequest(value: unknown): value is RpcRequest {
  return isJsonRpcEnvelope(value) && typeof (value as RpcRequest).id === "string" && typeof (value as RpcRequest).method === "string";
}

export function isRpcNotification(value: unknown): value is RpcNotification {
  return isJsonRpcEnvelope(value)
    && !("id" in (value as unknown as Record<string, unknown>))
    && typeof (value as RpcNotification).method === "string";
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  return isJsonRpcEnvelope(value)
    && typeof (value as RpcResponse).id === "string"
    && (("result" in (value as unknown as Record<string, unknown>)) || ("error" in (value as unknown as Record<string, unknown>)));
}

export function normalizeError(error: unknown): RpcProtocolError {
  if (error instanceof RpcProtocolError) {
    return error;
  }

  if (error instanceof Error) {
    return new RpcProtocolError(RPC_ERROR_CODES.internalError, error.message, { stack: error.stack });
  }

  return new RpcProtocolError(RPC_ERROR_CODES.internalError, String(error));
}

function isJsonRpcEnvelope(value: unknown): value is RpcMessage {
  return Boolean(value) && typeof value === "object" && (value as { jsonrpc?: string }).jsonrpc === JSON_RPC_VERSION;
}

function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function mergeMeta(base?: RpcMeta, next?: RpcMeta): RpcMeta | undefined {
  const merged = {
    ...(base ?? {}),
    ...(next ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function withTimestamp(meta?: RpcMeta): RpcMeta | undefined {
  if (!meta) {
    return { timestamp: Date.now() };
  }
  return {
    timestamp: meta.timestamp ?? Date.now(),
    ...meta,
  };
}
