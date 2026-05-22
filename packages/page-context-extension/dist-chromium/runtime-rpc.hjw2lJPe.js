import { r as runtimeSendMessage, u as tabsSendMessage } from './extension-api.BMHS3pcA.js';
//#region src/browser-polyfill.ts
/**
 * Browser API polyfill for Firefox compatibility.
 *
 * Firefox provides `browser.*` with native Promise support and `chrome.*` as
 * callback-only compat layer. Vite/Rollup tree-shaking may inline `chrome.*`
 * calls that `await` the result — which silently resolves to `undefined` on
 * Firefox because `chrome.*` methods don't return Promises.
 *
 * This polyfill replaces `chrome.*` async methods with `browser.*` equivalents
 * so `await chrome.runtime.sendMessage(...)` works in all contexts.
 * On Chromium (where `browser` is undefined), this is a no-op.
 */
(function () {
  const b = globalThis.browser;
  if (!b) return;
  function wrap(chromeTarget, browserTarget, method) {
    const browserMethod = browserTarget[method];
    if (typeof browserMethod !== 'function') return;
    chromeTarget[method] = function () {
      return browserMethod.apply(browserTarget, arguments);
    };
  }
  if (b.runtime && chrome.runtime) wrap(chrome.runtime, b.runtime, 'sendMessage');
  if (b.tabs && chrome.tabs) {
    wrap(chrome.tabs, b.tabs, 'sendMessage');
    wrap(chrome.tabs, b.tabs, 'create');
    wrap(chrome.tabs, b.tabs, 'query');
    wrap(chrome.tabs, b.tabs, 'get');
    wrap(chrome.tabs, b.tabs, 'remove');
  }
  if (b.storage && b.storage.local && chrome.storage && chrome.storage.local) {
    wrap(chrome.storage.local, b.storage.local, 'get');
    wrap(chrome.storage.local, b.storage.local, 'set');
    wrap(chrome.storage.local, b.storage.local, 'remove');
  }
  if (b.windows && chrome.windows) wrap(chrome.windows, b.windows, 'getCurrent');
  if (b.sidebarAction && chrome.sidebarAction) {
    wrap(chrome.sidebarAction, b.sidebarAction, 'open');
    wrap(chrome.sidebarAction, b.sidebarAction, 'close');
    wrap(chrome.sidebarAction, b.sidebarAction, 'setPanel');
    wrap(chrome.sidebarAction, b.sidebarAction, 'setTitle');
  }
})();
var RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  internalError: -32603,
  timeout: -32001,
  disconnected: -32002,
};
var RpcProtocolError = class extends Error {
  code;
  data;
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcProtocolError';
    this.code = code;
    this.data = data;
  }
};
var RpcPeer = class {
  sendImpl;
  getMeta;
  defaultTimeoutMs;
  pending = /* @__PURE__ */ new Map();
  handlers = /* @__PURE__ */ new Map();
  constructor(options) {
    this.sendImpl = options.send;
    this.getMeta = options.getMeta;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 3e4;
  }
  register(method, handler) {
    this.handlers.set(method, handler);
  }
  unregister(method) {
    this.handlers.delete(method);
  }
  async request(method, params, options) {
    const id = createRequestId();
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const request = createRequest(method, params, id, mergeMeta(this.getMeta?.(), options?.meta));
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RpcProtocolError(
            RPC_ERROR_CODES.timeout,
            `RPC request '${method}' timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value),
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
  async notify(method, params, meta) {
    const notification = createNotification(method, params, mergeMeta(this.getMeta?.(), meta));
    await this.sendImpl(serializeMessage(notification));
  }
  async receive(raw) {
    const message = parseMessage(raw);
    if (isRpcResponse(message)) {
      this.resolvePending(message);
      return;
    }
    const handler = this.handlers.get(message.method);
    if (!isRpcRequest(message)) {
      if (!handler) return;
      await handler(
        message.params,
        createRequest(message.method, message.params, 'notification', message.meta),
      );
      return;
    }
    if (!handler) {
      await this.sendImpl(
        serializeMessage(
          createErrorResponse(
            message.id,
            new RpcProtocolError(
              RPC_ERROR_CODES.methodNotFound,
              `Method not found: ${message.method}`,
            ),
          ),
        ),
      );
      return;
    }
    try {
      const result = await handler(message.params, message);
      await this.sendImpl(serializeMessage(createSuccessResponse(message.id, result)));
    } catch (error) {
      await this.sendImpl(serializeMessage(createErrorResponse(message.id, normalizeError(error))));
    }
  }
  failAllPending(reason) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(
        reason instanceof Error
          ? reason
          : new RpcProtocolError(RPC_ERROR_CODES.disconnected, reason),
      );
      this.pending.delete(id);
    }
  }
  getPendingCount() {
    return this.pending.size;
  }
  resolvePending(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if ('error' in message) {
      pending.reject(
        new RpcProtocolError(message.error.code, message.error.message, message.error.data),
      );
      return;
    }
    pending.resolve(message.result);
  }
};
function createRequest(method, params, id = createRequestId(), meta) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params,
    meta: withTimestamp(meta),
  };
}
function createNotification(method, params, meta) {
  return {
    jsonrpc: '2.0',
    method,
    params,
    meta: withTimestamp(meta),
  };
}
function createSuccessResponse(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}
function createErrorResponse(id, error) {
  const normalized = normalizeError(error);
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: normalized.code,
      message: normalized.message,
      data: normalized.data,
    },
  };
}
function parseMessage(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RpcProtocolError(
      RPC_ERROR_CODES.parseError,
      'Failed to parse JSON-RPC message',
      error,
    );
  }
  if (!isJsonRpcEnvelope(parsed))
    throw new RpcProtocolError(RPC_ERROR_CODES.invalidRequest, 'Invalid JSON-RPC envelope', parsed);
  return parsed;
}
function serializeMessage(message) {
  return JSON.stringify(message);
}
function isRpcRequest(value) {
  return (
    isJsonRpcEnvelope(value) && typeof value.id === 'string' && typeof value.method === 'string'
  );
}
function isRpcNotification(value) {
  return isJsonRpcEnvelope(value) && !('id' in value) && typeof value.method === 'string';
}
function isRpcResponse(value) {
  return (
    isJsonRpcEnvelope(value) &&
    typeof value.id === 'string' &&
    ('result' in value || 'error' in value)
  );
}
function normalizeError(error) {
  if (error instanceof RpcProtocolError) return error;
  if (error instanceof Error)
    return new RpcProtocolError(RPC_ERROR_CODES.internalError, error.message, {
      stack: error.stack,
    });
  return new RpcProtocolError(RPC_ERROR_CODES.internalError, String(error));
}
function isJsonRpcEnvelope(value) {
  return Boolean(value) && typeof value === 'object' && value.jsonrpc === '2.0';
}
function createRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
function mergeMeta(base, next) {
  const merged = {
    ...(base ?? {}),
    ...(next ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : void 0;
}
function withTimestamp(meta) {
  if (!meta) return { timestamp: Date.now() };
  return {
    timestamp: meta.timestamp ?? Date.now(),
    ...meta,
  };
}
//#endregion
//#region ../shared-protocol/dist/context-manifest.js
/**
 * Context manifest types and bridge method constants.
 */
var BRIDGE_METHODS = {
  sessionRegister: 'session.register',
  sessionHeartbeat: 'session.heartbeat',
  bridgeToolCall: 'bridge.tool.call',
  bridgeToolsList: 'bridge.tools.list',
  bridgeTabsList: 'bridge.tabs.list',
  bridgePageEvent: 'bridge.page.event',
  bridgePageToolsRegistered: 'bridge.pageTools.registered',
  bridgePageToolsUnregistered: 'bridge.pageTools.unregistered',
  bridgeBuiltinToolsUpdated: 'bridge.builtinTools.updated',
  bridgeTabActivated: 'bridge.tab.activated',
  bridgeTabUpdated: 'bridge.tab.updated',
  extensionStatusGet: 'extension.status.get',
  extensionReconnect: 'extension.session.reconnect',
  extensionPageToolsGet: 'extension.pageTools.get',
  extensionPageToolsTreeGet: 'extension.pageTools.tree.get',
  extensionPageToolsDiscover: 'extension.pageTools.discover',
  extensionPageToolsRefresh: 'extension.pageTools.refresh',
  extensionPageToolsSetEnabled: 'extension.pageTools.setEnabled',
  extensionContextManifestGet: 'extension.context.manifest.get',
  extensionContextResourceRead: 'extension.context.resource.read',
  extensionContextSkillGet: 'extension.context.skill.get',
  extensionContentContextManifestGet: 'extension.content.context.manifest.get',
  extensionContentContextResourceRead: 'extension.content.context.resource.read',
  extensionContentContextSkillGet: 'extension.content.context.skill.get',
  extensionContentPageToolsDiscover: 'extension.content.pageTools.discover',
  extensionContentPageToolExecute: 'extension.content.pageTool.execute',
  extensionToolDebugCall: 'extension.tool.debug.call',
  extensionToolExecute: 'extension.tool.execute',
  extensionMainWorldHostEnsure: 'extension.mainWorld.host.ensure',
  extensionAgentationMainEnsure: 'extension.agentation.main.ensure',
  extensionPageEvent: 'extension.page.event',
  extensionPageToolsRegister: 'extension.pageTools.register',
  feedbackStateSnapshot: 'feedback.state.snapshot',
  feedbackStateDelta: 'feedback.state.delta',
  feedbackAnnotationCreate: 'feedback.annotation.create',
  feedbackAnnotationUpdate: 'feedback.annotation.update',
  feedbackAnnotationClaim: 'feedback.annotation.claim',
  feedbackAnnotationReply: 'feedback.annotation.reply',
  feedbackAnnotationResolve: 'feedback.annotation.resolve',
  feedbackAnnotationDismiss: 'feedback.annotation.dismiss',
  extensionFeedbackStateSnapshot: 'extension.feedback.state.snapshot',
  extensionFeedbackStateDelta: 'extension.feedback.state.delta',
  extensionFeedbackAnnotationCreate: 'extension.feedback.annotation.create',
  extensionFeedbackAnnotationUpdate: 'extension.feedback.annotation.update',
  extensionFeedbackAnnotationClaim: 'extension.feedback.annotation.claim',
  extensionFeedbackAnnotationReply: 'extension.feedback.annotation.reply',
  extensionFeedbackAnnotationResolve: 'extension.feedback.annotation.resolve',
  extensionFeedbackAnnotationDismiss: 'extension.feedback.annotation.dismiss',
};
//#endregion
//#region src/runtime-rpc.ts
async function sendRuntimeRequest(method, params) {
  return unwrapRpcResponse(await runtimeSendMessage(createRequest(method, params)));
}
async function sendTabRequest(tabId, method, params) {
  return unwrapRpcResponse(await tabsSendMessage(tabId, createRequest(method, params)));
}
function createRuntimeListener(handler) {
  return (message, sender, sendResponse) => {
    if (!isRpcRequest(message) && !isRpcNotification(message)) return false;
    const rpcMessage = message;
    Promise.resolve(handler(rpcMessage, sender))
      .then((result) => {
        if (!hasRequestId(rpcMessage)) {
          sendResponse({ ok: true });
          return;
        }
        sendResponse(createSuccessResponse(rpcMessage.id, result));
      })
      .catch((error) => {
        if (!hasRequestId(rpcMessage)) {
          sendResponse({
            ok: false,
            error: normalizeError(error).message,
          });
          return;
        }
        sendResponse(createErrorResponse(rpcMessage.id, error));
      });
    return true;
  };
}
function unwrapRpcResponse(message) {
  if (!isRpcResponse(message)) throw new Error('Expected JSON-RPC response envelope');
  const rpcMessage = message;
  if ('error' in rpcMessage) throw new Error(rpcMessage.error.message);
  return rpcMessage.result;
}
function hasRequestId(message) {
  return 'id' in message && typeof message.id === 'string';
}
//#endregion
export {
  RPC_ERROR_CODES as a,
  BRIDGE_METHODS as i,
  sendRuntimeRequest as n,
  RpcPeer as o,
  sendTabRequest as r,
  RpcProtocolError as s,
  createRuntimeListener as t,
};
