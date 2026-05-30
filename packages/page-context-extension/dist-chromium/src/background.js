(function () {
  'use strict';

  //#region src/extension-api.ts
  function getGlobalApi() {
    const globalApi = globalThis;
    const api = globalApi.browser ?? globalApi.chrome;
    if (!api) throw new Error('WebExtension API is unavailable');
    return api;
  }
  function hasBrowserPromiseApi() {
    return Boolean(globalThis.browser);
  }
  function isThenable(value) {
    return Boolean(value && typeof value.then === 'function');
  }
  function getLastErrorMessage(api) {
    return api.runtime?.lastError?.message ?? globalThis.chrome?.runtime?.lastError?.message;
  }
  function invokeExtensionApi(target, method, args) {
    const api = getGlobalApi();
    if (hasBrowserPromiseApi())
      return Promise.resolve(method.apply(target, args)).then((value) => value);
    return new Promise((resolve, reject) => {
      const callback = (value) => {
        const lastError = getLastErrorMessage(api);
        if (lastError) {
          reject(new Error(lastError));
          return;
        }
        resolve(value);
      };
      try {
        const result = method.apply(target, [...args, callback]);
        if (isThenable(result)) result.then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
  }
  function runtimeSendMessage(message) {
    const api = getGlobalApi();
    return invokeExtensionApi(api.runtime, api.runtime.sendMessage, [message]);
  }
  function tabsSendMessage(tabId, message) {
    const api = getGlobalApi();
    return invokeExtensionApi(api.tabs, api.tabs.sendMessage, [tabId, message]);
  }
  function tabsQuery(queryInfo) {
    const api = getGlobalApi();
    return invokeExtensionApi(api.tabs, api.tabs.query, [queryInfo]);
  }
  function tabsGet(tabId) {
    const api = getGlobalApi();
    return invokeExtensionApi(api.tabs, api.tabs.get, [tabId]);
  }
  function storageLocalGet(keys) {
    const api = getGlobalApi();
    return invokeExtensionApi(api.storage.local, api.storage.local.get, [keys]);
  }
  function storageLocalSet(items) {
    const api = getGlobalApi();
    return invokeExtensionApi(api.storage.local, api.storage.local.set, [items]);
  }

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
        await this.sendImpl(
          serializeMessage(createErrorResponse(message.id, normalizeError(error))),
        );
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
      throw new RpcProtocolError(
        RPC_ERROR_CODES.invalidRequest,
        'Invalid JSON-RPC envelope',
        parsed,
      );
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
  //#region ../shared-protocol/dist/connections.js
  /**
   * 连接面板共享协议。
   *
   * 这里只有“连接长什么样、允许做什么动作、走哪些 RPC”这三件事。
   * UI 不在这里拼文案，driver 也不在这里写业务逻辑。
   */
  var CONNECTION_METHODS = {
    list: 'connections.list',
    subscribe: 'connections.subscribe',
    action: 'connections.action',
    changed: 'connections.changed',
  };
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

  //#region src/bg-connection-registry.ts
  /**
   * 统一连接注册表。
   *
   * 目标：
   * 1. background 内所有“对外链路”都在这里挂账
   * 2. sidepanel 只读 descriptor，不再自己拼状态字符串
   * 3. 动作统一经由 driver 路由，避免 UI 直接耦合具体实现
   */
  var CONNECTIONS_CHANGED_METHOD = 'connections.changed';
  function sortDescriptors(left, right) {
    return (
      left.kind.localeCompare(right.kind) ||
      left.label.localeCompare(right.label) ||
      left.id.localeCompare(right.id)
    );
  }
  function createConnectionRegistry(deps = {}) {
    const descriptors = /* @__PURE__ */ new Map();
    const drivers = /* @__PURE__ */ new Map();
    const broadcast = async (method, params) => {
      if (deps.broadcast) {
        await deps.broadcast(method, params);
        return;
      }
      try {
        await runtimeSendMessage(createNotification(method, params));
      } catch {}
    };
    const broadcastChanged = async () => {
      await broadcast(CONNECTIONS_CHANGED_METHOD, {
        changedAt: /* @__PURE__ */ new Date().toISOString(),
      });
    };
    const setDescriptor = async (next, mode) => {
      if (mode === 'remove') descriptors.delete(next.id);
      else descriptors.set(next.id, next);
      await broadcastChanged();
    };
    return {
      register(descriptor) {
        const next = {
          ...descriptor,
          updatedAt: /* @__PURE__ */ new Date().toISOString(),
        };
        descriptors.set(next.id, next);
        broadcastChanged();
        return next;
      },
      update(descriptorId, patch) {
        const current = descriptors.get(descriptorId);
        if (!current) return null;
        const next = {
          ...current,
          ...patch,
          updatedAt: /* @__PURE__ */ new Date().toISOString(),
        };
        descriptors.set(descriptorId, next);
        broadcastChanged();
        return next;
      },
      remove(descriptorId) {
        const current = descriptors.get(descriptorId);
        if (!current) return false;
        setDescriptor(current, 'remove');
        return true;
      },
      get(descriptorId) {
        return descriptors.get(descriptorId) ?? null;
      },
      list() {
        return Array.from(descriptors.values()).sort(sortDescriptors);
      },
      registerDriver(kind, driver) {
        drivers.set(kind, driver);
      },
      async sendRuntimeBroadcast(method, params) {
        await broadcast(method, params);
      },
      async handleList() {
        return { descriptors: this.list() };
      },
      async handleSubscribe() {
        return {
          descriptors: this.list(),
          notificationMethod: CONNECTIONS_CHANGED_METHOD,
        };
      },
      async handleAction(params) {
        const descriptor = descriptors.get(params.descriptorId);
        if (!descriptor) throw new Error(`Unknown connection descriptor: ${params.descriptorId}`);
        const driver = drivers.get(descriptor.kind);
        if (!driver?.action)
          throw new Error(`Connection kind "${descriptor.kind}" does not support actions`);
        return await driver.action(params.action, descriptor, this);
      },
      clear() {
        descriptors.clear();
        drivers.clear();
      },
    };
  }
  var singletonRegistry = createConnectionRegistry();
  function getConnectionRegistry() {
    return singletonRegistry;
  }
  //#endregion
  //#region src/bg-scoped-ws-connection.ts
  /**
   * OpenCode 多 session WebSocket 管理器。
   *
   * 设计目标：
   * 1. 不动现有 default tenant 单连接实现，避免把旧链路一起改坏。
   * 2. tenantId === opencode sessionId，一条 session 对应一条独立 ws。
   * 3. 只管理“按 session 建连/断连/查询状态”这一件事，不掺入业务路由。
   *
   * 这符合 Linux 哲学：把“连接管理”和“业务处理”拆开，各自只做一件事。
   */
  function getScopedBridgeDescriptorId(tenantId) {
    return `opencode-bridge-ws:${tenantId}`;
  }
  function upsertScopedBridgeDescriptor(tenantId, patch) {
    const registry = getConnectionRegistry();
    const descriptorId = getScopedBridgeDescriptorId(tenantId);
    const current = registry.get(descriptorId);
    if (current) {
      registry.update(descriptorId, {
        endpoint: patch.endpoint,
        status: patch.status,
        statusReason: patch.statusReason ?? null,
        meta: {
          ...(current.meta ?? {}),
          tenantId,
          bridgeSessionId: patch.bridgeSessionId ?? null,
        },
        capabilities: {
          reconnect: true,
          disconnect: true,
        },
      });
      return;
    }
    registry.register({
      id: descriptorId,
      kind: 'opencode-bridge-ws',
      label: `OpenCode Bridge WS · ${tenantId}`,
      endpoint: patch.endpoint,
      status: patch.status,
      statusReason: patch.statusReason ?? null,
      capabilities: {
        reconnect: true,
        disconnect: true,
      },
      meta: {
        tenantId,
        bridgeSessionId: patch.bridgeSessionId ?? null,
      },
    });
  }
  var WS_FORWARD_EXTENSION_METHODS$1 = [
    BRIDGE_METHODS.extensionStatusGet,
    BRIDGE_METHODS.extensionReconnect,
    BRIDGE_METHODS.extensionPageToolsGet,
    BRIDGE_METHODS.extensionPageToolsTreeGet,
    BRIDGE_METHODS.extensionPageToolsDiscover,
    BRIDGE_METHODS.extensionPageToolsRefresh,
    BRIDGE_METHODS.extensionPageToolsSetEnabled,
    BRIDGE_METHODS.extensionToolDebugCall,
    BRIDGE_METHODS.extensionMainWorldHostEnsure,
    BRIDGE_METHODS.extensionAgentationMainEnsure,
    BRIDGE_METHODS.extensionContextManifestGet,
    BRIDGE_METHODS.extensionContextResourceRead,
    BRIDGE_METHODS.extensionContextSkillGet,
  ];
  var RECONNECT_BASE_MS$1 = 1e3;
  var RECONNECT_MAX_MS$1 = 3e4;
  var HEARTBEAT_INTERVAL_MS$1 = 15e3;
  function registerForwardedExtensionMethods$1(peer, onExtensionRequest) {
    for (const method of WS_FORWARD_EXTENSION_METHODS$1)
      peer.register(method, async (params) => await onExtensionRequest(method, params));
  }
  function isOpenOrConnecting(ws) {
    return ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING;
  }
  function clearReconnectTimer$1(connection) {
    if (!connection.reconnectTimer) return;
    clearTimeout(connection.reconnectTimer);
    connection.reconnectTimer = null;
  }
  function clearHeartbeatTimer$1(connection) {
    if (!connection.heartbeatTimer) return;
    clearInterval(connection.heartbeatTimer);
    connection.heartbeatTimer = null;
  }
  function ensureHeartbeatTimer$1(connection) {
    if (connection.heartbeatTimer) return;
    connection.heartbeatTimer = setInterval(() => {
      if (!connection.ready || !connection.rpcPeer || !connection.bridgeSessionId) return;
      connection.rpcPeer
        .notify(BRIDGE_METHODS.sessionHeartbeat, { sentAt: Date.now() })
        .catch((error) => {
          console.warn(
            '[PAGE-CONTEXT-BG]',
            `[${connection.tenantId}] scoped heartbeat failed`,
            error,
          );
        });
    }, HEARTBEAT_INTERVAL_MS$1);
  }
  function closeScopedConnection(connection, reason) {
    connection.ready = false;
    connection.bridgeSessionId = null;
    clearReconnectTimer$1(connection);
    clearHeartbeatTimer$1(connection);
    connection.rpcPeer?.failAllPending(reason);
    connection.handlers = null;
    connection.connectPromise = null;
    if (connection.ws && connection.ws.readyState < WebSocket.CLOSING) connection.ws.close();
    upsertScopedBridgeDescriptor(connection.tenantId, {
      endpoint: connection.wsUrl ?? null,
      status: 'closed',
      statusReason: reason,
      bridgeSessionId: null,
    });
    connection.ws = null;
    connection.rpcPeer = null;
  }
  function createScopedBridgeWsManager() {
    const connections = /* @__PURE__ */ new Map();
    function getOrCreateConnection(tenantId, wsUrl) {
      const current = connections.get(tenantId);
      if (current && current.wsUrl === wsUrl) return current;
      if (current) closeScopedConnection(current, 'Replacing scoped bridge connection');
      const created = {
        tenantId,
        wsUrl,
        ws: null,
        rpcPeer: null,
        ready: false,
        bridgeSessionId: null,
        connectPromise: null,
        reconnectAttempts: 0,
        reconnectTimer: null,
        heartbeatTimer: null,
        handlers: null,
      };
      connections.set(tenantId, created);
      return created;
    }
    function scheduleReconnect(connection) {
      if (connection.reconnectTimer || !connection.handlers) return;
      const delay = Math.min(
        RECONNECT_BASE_MS$1 * 2 ** connection.reconnectAttempts,
        RECONNECT_MAX_MS$1,
      );
      connection.reconnectAttempts += 1;
      connection.reconnectTimer = setTimeout(() => {
        connection.reconnectTimer = null;
        if (!connection.handlers) return;
        connect(connection.tenantId, connection.wsUrl, connection.handlers);
      }, delay);
      console.warn(
        '[PAGE-CONTEXT-BG]',
        `[${connection.tenantId}] reconnecting scoped bridge in ${delay}ms`,
      );
    }
    async function connect(tenantId, wsUrl, handlers) {
      const connection = getOrCreateConnection(tenantId, wsUrl);
      connection.handlers = handlers;
      upsertScopedBridgeDescriptor(tenantId, {
        endpoint: wsUrl,
        status: 'connecting',
        statusReason: 'connecting',
        bridgeSessionId: null,
      });
      if (connection.connectPromise) return await connection.connectPromise;
      if (isOpenOrConnecting(connection.ws)) return;
      connection.connectPromise = (async () => {
        const socket = new WebSocket(wsUrl);
        connection.ws = socket;
        connection.ready = false;
        connection.bridgeSessionId = null;
        const peer = new RpcPeer({
          send: (message) => socket.send(message),
          defaultTimeoutMs: 3e4,
          getMeta: () => ({
            sessionId: connection.bridgeSessionId ?? void 0,
            source: 'extension',
            target: 'bridge',
          }),
        });
        connection.rpcPeer = peer;
        peer.register(BRIDGE_METHODS.bridgeToolCall, async (params, request) => {
          return await handlers.onToolCall(params, request.id);
        });
        peer.register(BRIDGE_METHODS.bridgeToolsList, async () => await handlers.onToolsList());
        peer.register(BRIDGE_METHODS.bridgeTabsList, async () => await handlers.onTabsList());
        registerForwardedExtensionMethods$1(peer, handlers.onExtensionRequest);
        await new Promise((resolve, reject) => {
          let settled = false;
          let opened = false;
          const resolveOnce = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          const rejectOnce = (error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          };
          socket.onopen = () => {
            opened = true;
            resolveOnce();
          };
          socket.onmessage = (event) => {
            if (connection.ws !== socket || connection.rpcPeer !== peer) return;
            peer.receive(String(event.data)).catch((error) => {
              console.warn(
                '[PAGE-CONTEXT-BG]',
                `[${tenantId}] scoped bridge message failed`,
                error,
              );
            });
          };
          socket.onerror = () => {
            if (!opened) {
              rejectOnce(
                /* @__PURE__ */ new Error(
                  `Scoped WebSocket errored before open for session "${tenantId}"`,
                ),
              );
              socket.close();
            }
          };
          socket.onclose = (event) => {
            if (connection.ws !== socket) return;
            connection.ready = false;
            connection.bridgeSessionId = null;
            clearHeartbeatTimer$1(connection);
            peer.failAllPending(`Scoped bridge transport closed for "${tenantId}"`);
            upsertScopedBridgeDescriptor(tenantId, {
              endpoint: connection.wsUrl ?? null,
              status: 'error',
              statusReason: `closed-before-reconnect:${event.code}`,
              bridgeSessionId: null,
            });
            connection.ws = null;
            connection.rpcPeer = null;
            connection.connectPromise = null;
            if (!opened)
              rejectOnce(
                /* @__PURE__ */ new Error(
                  `Scoped WebSocket closed before open for session "${tenantId}" (code=${event.code})`,
                ),
              );
            scheduleReconnect(connection);
          };
        });
        try {
          const result = await peer.request(
            BRIDGE_METHODS.sessionRegister,
            {
              extensionId: chrome.runtime.id,
              version: chrome.runtime.getManifest().version,
            },
            { timeoutMs: 5e3 },
          );
          connection.bridgeSessionId = result.sessionId;
          connection.ready = true;
          connection.reconnectAttempts = 0;
          clearReconnectTimer$1(connection);
          ensureHeartbeatTimer$1(connection);
          upsertScopedBridgeDescriptor(tenantId, {
            endpoint: wsUrl,
            status: 'connected',
            statusReason: 'ready',
            bridgeSessionId: result.sessionId,
          });
        } catch (error) {
          upsertScopedBridgeDescriptor(tenantId, {
            endpoint: wsUrl,
            status: 'error',
            statusReason: error instanceof Error ? error.message : String(error),
            bridgeSessionId: null,
          });
          socket.close();
          throw error;
        }
      })();
      try {
        await connection.connectPromise;
      } finally {
        connection.connectPromise = null;
      }
    }
    async function disconnect(tenantId) {
      const connection = connections.get(tenantId);
      if (!connection) {
        upsertScopedBridgeDescriptor(tenantId, {
          endpoint: null,
          status: 'closed',
          statusReason: 'not-found',
          bridgeSessionId: null,
        });
        return;
      }
      closeScopedConnection(connection, `Scoped bridge session "${tenantId}" disconnected`);
      connections.delete(tenantId);
    }
    function getStatus(tenantId) {
      const connection = connections.get(tenantId);
      return {
        tenantId,
        wsUrl: connection?.wsUrl ?? null,
        connected: Boolean(connection?.ready && connection.ws?.readyState === WebSocket.OPEN),
        bridgeSessionId: connection?.bridgeSessionId ?? null,
      };
    }
    function listStatuses() {
      return Array.from(connections.keys()).map((tenantId) => getStatus(tenantId));
    }
    function getPeer(tenantId) {
      return connections.get(tenantId)?.rpcPeer ?? null;
    }
    function isMethodNotFound(error) {
      return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === RPC_ERROR_CODES.methodNotFound
      );
    }
    return {
      connect,
      disconnect,
      getStatus,
      listStatuses,
      getPeer,
      isMethodNotFound,
    };
  }
  //#endregion
  //#region src/connections-endpoints.ts
  /**
   * Connections 面板的 endpoint 配置读写。
   *
   * 规则：
   * - 新真相源是 `connections.endpoints.v1`
   * - 旧 `opencode.config.v1` 里的 endpoint 只做一次迁移
   * - session 相关历史字段继续留在旧 key，避免把既有恢复逻辑一起打坏
   */
  var CONNECTION_ENDPOINTS_STORAGE_KEY = 'connections.endpoints.v1';
  var DEFAULT_CONNECTION_ENDPOINTS = {
    opencodeBaseUrl: 'http://localhost:4096',
    bridgeBaseUrl: 'http://localhost:22334',
  };
  function normalizeEndpoint(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }
  async function loadConnectionEndpoints() {
    const current = (
      await storageLocalGet({ [CONNECTION_ENDPOINTS_STORAGE_KEY]: DEFAULT_CONNECTION_ENDPOINTS })
    )[CONNECTION_ENDPOINTS_STORAGE_KEY];
    return {
      opencodeBaseUrl: normalizeEndpoint(
        current?.opencodeBaseUrl,
        DEFAULT_CONNECTION_ENDPOINTS.opencodeBaseUrl,
      ),
      bridgeBaseUrl: normalizeEndpoint(
        current?.bridgeBaseUrl,
        DEFAULT_CONNECTION_ENDPOINTS.bridgeBaseUrl,
      ),
    };
  }

  Object.freeze({ status: 'aborted' });
  function $constructor(name, initializer, params) {
    function init(inst, def) {
      if (!inst._zod)
        Object.defineProperty(inst, '_zod', {
          value: {
            def,
            constr: _,
            traits: /* @__PURE__ */ new Set(),
          },
          enumerable: false,
        });
      if (inst._zod.traits.has(name)) return;
      inst._zod.traits.add(name);
      initializer(inst, def);
      const proto = _.prototype;
      const keys = Object.keys(proto);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!(k in inst)) inst[k] = proto[k].bind(inst);
      }
    }
    const Parent = params?.Parent ?? Object;
    class Definition extends Parent {}
    Object.defineProperty(Definition, 'name', { value: name });
    function _(def) {
      var _a;
      const inst = params?.Parent ? new Definition() : this;
      init(inst, def);
      (_a = inst._zod).deferred ?? (_a.deferred = []);
      for (const fn of inst._zod.deferred) fn();
      return inst;
    }
    Object.defineProperty(_, 'init', { value: init });
    Object.defineProperty(_, Symbol.hasInstance, {
      value: (inst) => {
        if (params?.Parent && inst instanceof params.Parent) return true;
        return inst?._zod?.traits?.has(name);
      },
    });
    Object.defineProperty(_, 'name', { value: name });
    return _;
  }
  var $ZodAsyncError = class extends Error {
    constructor() {
      super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
    }
  };
  var $ZodEncodeError = class extends Error {
    constructor(name) {
      super(`Encountered unidirectional transform during encode: ${name}`);
      this.name = 'ZodEncodeError';
    }
  };
  var globalConfig = {};
  function config(newConfig) {
    if (newConfig) Object.assign(globalConfig, newConfig);
    return globalConfig;
  }
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/core/util.js
  function getEnumValues(entries) {
    const numericValues = Object.values(entries).filter((v) => typeof v === 'number');
    return Object.entries(entries)
      .filter(([k, _]) => numericValues.indexOf(+k) === -1)
      .map(([_, v]) => v);
  }
  function jsonStringifyReplacer(_, value) {
    if (typeof value === 'bigint') return value.toString();
    return value;
  }
  function cached(getter) {
    return {
      get value() {
        {
          const value = getter();
          Object.defineProperty(this, 'value', { value });
          return value;
        }
      },
    };
  }
  function nullish(input) {
    return input === null || input === void 0;
  }
  function cleanRegex(source) {
    const start = source.startsWith('^') ? 1 : 0;
    const end = source.endsWith('$') ? source.length - 1 : source.length;
    return source.slice(start, end);
  }
  function floatSafeRemainder(val, step) {
    const valDecCount = (val.toString().split('.')[1] || '').length;
    const stepString = step.toString();
    let stepDecCount = (stepString.split('.')[1] || '').length;
    if (stepDecCount === 0 && /\d?e-\d?/.test(stepString)) {
      const match = stepString.match(/\d?e-(\d?)/);
      if (match?.[1]) stepDecCount = Number.parseInt(match[1]);
    }
    const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
    return (
      (Number.parseInt(val.toFixed(decCount).replace('.', '')) %
        Number.parseInt(step.toFixed(decCount).replace('.', ''))) /
      10 ** decCount
    );
  }
  var EVALUATING = Symbol('evaluating');
  function defineLazy(object, key, getter) {
    let value = void 0;
    Object.defineProperty(object, key, {
      get() {
        if (value === EVALUATING) return;
        if (value === void 0) {
          value = EVALUATING;
          value = getter();
        }
        return value;
      },
      set(v) {
        Object.defineProperty(object, key, { value: v });
      },
      configurable: true,
    });
  }
  function assignProp(target, prop, value) {
    Object.defineProperty(target, prop, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  function mergeDefs(...defs) {
    const mergedDescriptors = {};
    for (const def of defs) Object.assign(mergedDescriptors, Object.getOwnPropertyDescriptors(def));
    return Object.defineProperties({}, mergedDescriptors);
  }
  function esc(str) {
    return JSON.stringify(str);
  }
  function slugify(input) {
    return input
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  var captureStackTrace = 'captureStackTrace' in Error ? Error.captureStackTrace : (..._args) => {};
  function isObject(data) {
    return typeof data === 'object' && data !== null && !Array.isArray(data);
  }
  var allowsEval = cached(() => {
    if (typeof navigator !== 'undefined' && navigator?.userAgent?.includes('Cloudflare'))
      return false;
    try {
      new Function('');
      return true;
    } catch (_) {
      return false;
    }
  });
  function isPlainObject(o) {
    if (isObject(o) === false) return false;
    const ctor = o.constructor;
    if (ctor === void 0) return true;
    if (typeof ctor !== 'function') return true;
    const prot = ctor.prototype;
    if (isObject(prot) === false) return false;
    if (Object.prototype.hasOwnProperty.call(prot, 'isPrototypeOf') === false) return false;
    return true;
  }
  function shallowClone(o) {
    if (isPlainObject(o)) return { ...o };
    if (Array.isArray(o)) return [...o];
    return o;
  }
  var propertyKeyTypes = new Set(['string', 'number', 'symbol']);
  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function clone(inst, def, params) {
    const cl = new inst._zod.constr(def ?? inst._zod.def);
    if (!def || params?.parent) cl._zod.parent = inst;
    return cl;
  }
  function normalizeParams(_params) {
    const params = _params;
    if (!params) return {};
    if (typeof params === 'string') return { error: () => params };
    if (params?.message !== void 0) {
      if (params?.error !== void 0)
        throw new Error('Cannot specify both `message` and `error` params');
      params.error = params.message;
    }
    delete params.message;
    if (typeof params.error === 'string')
      return {
        ...params,
        error: () => params.error,
      };
    return params;
  }
  function optionalKeys(shape) {
    return Object.keys(shape).filter((k) => {
      return shape[k]._zod.optin === 'optional' && shape[k]._zod.optout === 'optional';
    });
  }
  var NUMBER_FORMAT_RANGES = {
    safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    int32: [-2147483648, 2147483647],
    uint32: [0, 4294967295],
    float32: [-34028234663852886e22, 34028234663852886e22],
    float64: [-Number.MAX_VALUE, Number.MAX_VALUE],
  };
  function pick(schema, mask) {
    const currDef = schema._zod.def;
    const checks = currDef.checks;
    if (checks && checks.length > 0)
      throw new Error('.pick() cannot be used on object schemas containing refinements');
    return clone(
      schema,
      mergeDefs(schema._zod.def, {
        get shape() {
          const newShape = {};
          for (const key in mask) {
            if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
            if (!mask[key]) continue;
            newShape[key] = currDef.shape[key];
          }
          assignProp(this, 'shape', newShape);
          return newShape;
        },
        checks: [],
      }),
    );
  }
  function omit(schema, mask) {
    const currDef = schema._zod.def;
    const checks = currDef.checks;
    if (checks && checks.length > 0)
      throw new Error('.omit() cannot be used on object schemas containing refinements');
    return clone(
      schema,
      mergeDefs(schema._zod.def, {
        get shape() {
          const newShape = { ...schema._zod.def.shape };
          for (const key in mask) {
            if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
            if (!mask[key]) continue;
            delete newShape[key];
          }
          assignProp(this, 'shape', newShape);
          return newShape;
        },
        checks: [],
      }),
    );
  }
  function extend(schema, shape) {
    if (!isPlainObject(shape)) throw new Error('Invalid input to extend: expected a plain object');
    const checks = schema._zod.def.checks;
    if (checks && checks.length > 0) {
      const existingShape = schema._zod.def.shape;
      for (const key in shape)
        if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0)
          throw new Error(
            'Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.',
          );
    }
    return clone(
      schema,
      mergeDefs(schema._zod.def, {
        get shape() {
          const _shape = {
            ...schema._zod.def.shape,
            ...shape,
          };
          assignProp(this, 'shape', _shape);
          return _shape;
        },
      }),
    );
  }
  function safeExtend(schema, shape) {
    if (!isPlainObject(shape))
      throw new Error('Invalid input to safeExtend: expected a plain object');
    return clone(
      schema,
      mergeDefs(schema._zod.def, {
        get shape() {
          const _shape = {
            ...schema._zod.def.shape,
            ...shape,
          };
          assignProp(this, 'shape', _shape);
          return _shape;
        },
      }),
    );
  }
  function merge(a, b) {
    return clone(
      a,
      mergeDefs(a._zod.def, {
        get shape() {
          const _shape = {
            ...a._zod.def.shape,
            ...b._zod.def.shape,
          };
          assignProp(this, 'shape', _shape);
          return _shape;
        },
        get catchall() {
          return b._zod.def.catchall;
        },
        checks: [],
      }),
    );
  }
  function partial(Class, schema, mask) {
    const checks = schema._zod.def.checks;
    if (checks && checks.length > 0)
      throw new Error('.partial() cannot be used on object schemas containing refinements');
    return clone(
      schema,
      mergeDefs(schema._zod.def, {
        get shape() {
          const oldShape = schema._zod.def.shape;
          const shape = { ...oldShape };
          if (mask)
            for (const key in mask) {
              if (!(key in oldShape)) throw new Error(`Unrecognized key: "${key}"`);
              if (!mask[key]) continue;
              shape[key] = Class
                ? new Class({
                    type: 'optional',
                    innerType: oldShape[key],
                  })
                : oldShape[key];
            }
          else
            for (const key in oldShape)
              shape[key] = Class
                ? new Class({
                    type: 'optional',
                    innerType: oldShape[key],
                  })
                : oldShape[key];
          assignProp(this, 'shape', shape);
          return shape;
        },
        checks: [],
      }),
    );
  }
  function required(Class, schema, mask) {
    return clone(
      schema,
      mergeDefs(schema._zod.def, {
        get shape() {
          const oldShape = schema._zod.def.shape;
          const shape = { ...oldShape };
          if (mask)
            for (const key in mask) {
              if (!(key in shape)) throw new Error(`Unrecognized key: "${key}"`);
              if (!mask[key]) continue;
              shape[key] = new Class({
                type: 'nonoptional',
                innerType: oldShape[key],
              });
            }
          else
            for (const key in oldShape)
              shape[key] = new Class({
                type: 'nonoptional',
                innerType: oldShape[key],
              });
          assignProp(this, 'shape', shape);
          return shape;
        },
      }),
    );
  }
  function aborted(x, startIndex = 0) {
    if (x.aborted === true) return true;
    for (let i = startIndex; i < x.issues.length; i++)
      if (x.issues[i]?.continue !== true) return true;
    return false;
  }
  function prefixIssues(path, issues) {
    return issues.map((iss) => {
      var _a;
      (_a = iss).path ?? (_a.path = []);
      iss.path.unshift(path);
      return iss;
    });
  }
  function unwrapMessage(message) {
    return typeof message === 'string' ? message : message?.message;
  }
  function finalizeIssue(iss, ctx, config) {
    const full = {
      ...iss,
      path: iss.path ?? [],
    };
    if (!iss.message)
      full.message =
        unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ??
        unwrapMessage(ctx?.error?.(iss)) ??
        unwrapMessage(config.customError?.(iss)) ??
        unwrapMessage(config.localeError?.(iss)) ??
        'Invalid input';
    delete full.inst;
    delete full.continue;
    if (!ctx?.reportInput) delete full.input;
    return full;
  }
  function getLengthableOrigin(input) {
    if (Array.isArray(input)) return 'array';
    if (typeof input === 'string') return 'string';
    return 'unknown';
  }
  function issue(...args) {
    const [iss, input, inst] = args;
    if (typeof iss === 'string')
      return {
        message: iss,
        code: 'custom',
        input,
        inst,
      };
    return { ...iss };
  }
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/core/errors.js
  var initializer$1 = (inst, def) => {
    inst.name = '$ZodError';
    Object.defineProperty(inst, '_zod', {
      value: inst._zod,
      enumerable: false,
    });
    Object.defineProperty(inst, 'issues', {
      value: def,
      enumerable: false,
    });
    inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
    Object.defineProperty(inst, 'toString', {
      value: () => inst.message,
      enumerable: false,
    });
  };
  var $ZodError = $constructor('$ZodError', initializer$1);
  var $ZodRealError = $constructor('$ZodError', initializer$1, { Parent: Error });
  function flattenError(error, mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of error.issues)
      if (sub.path.length > 0) {
        fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
        fieldErrors[sub.path[0]].push(mapper(sub));
      } else formErrors.push(mapper(sub));
    return {
      formErrors,
      fieldErrors,
    };
  }
  function formatError(error, mapper = (issue) => issue.message) {
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues)
        if (issue.code === 'invalid_union' && issue.errors.length)
          issue.errors.map((issues) => processError({ issues }));
        else if (issue.code === 'invalid_key') processError({ issues: issue.issues });
        else if (issue.code === 'invalid_element') processError({ issues: issue.issues });
        else if (issue.path.length === 0) fieldErrors._errors.push(mapper(issue));
        else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            if (!(i === issue.path.length - 1)) curr[el] = curr[el] || { _errors: [] };
            else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
    };
    processError(error);
    return fieldErrors;
  }
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/core/parse.js
  var _parse = (_Err) => (schema, value, _ctx, _params) => {
    const ctx = _ctx ? Object.assign(_ctx, { async: false }) : { async: false };
    const result = schema._zod.run(
      {
        value,
        issues: [],
      },
      ctx,
    );
    if (result instanceof Promise) throw new $ZodAsyncError();
    if (result.issues.length) {
      const e = new (_params?.Err ?? _Err)(
        result.issues.map((iss) => finalizeIssue(iss, ctx, config())),
      );
      captureStackTrace(e, _params?.callee);
      throw e;
    }
    return result.value;
  };
  var _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
    const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
    let result = schema._zod.run(
      {
        value,
        issues: [],
      },
      ctx,
    );
    if (result instanceof Promise) result = await result;
    if (result.issues.length) {
      const e = new (params?.Err ?? _Err)(
        result.issues.map((iss) => finalizeIssue(iss, ctx, config())),
      );
      captureStackTrace(e, params?.callee);
      throw e;
    }
    return result.value;
  };
  var _safeParse = (_Err) => (schema, value, _ctx) => {
    const ctx = _ctx
      ? {
          ..._ctx,
          async: false,
        }
      : { async: false };
    const result = schema._zod.run(
      {
        value,
        issues: [],
      },
      ctx,
    );
    if (result instanceof Promise) throw new $ZodAsyncError();
    return result.issues.length
      ? {
          success: false,
          error: new (_Err ?? $ZodError)(
            result.issues.map((iss) => finalizeIssue(iss, ctx, config())),
          ),
        }
      : {
          success: true,
          data: result.value,
        };
  };
  var safeParse$1 = /* @__PURE__ */ _safeParse($ZodRealError);
  var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
    const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
    let result = schema._zod.run(
      {
        value,
        issues: [],
      },
      ctx,
    );
    if (result instanceof Promise) result = await result;
    return result.issues.length
      ? {
          success: false,
          error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config()))),
        }
      : {
          success: true,
          data: result.value,
        };
  };
  var safeParseAsync$1 = /* @__PURE__ */ _safeParseAsync($ZodRealError);
  var _encode = (_Err) => (schema, value, _ctx) => {
    const ctx = _ctx ? Object.assign(_ctx, { direction: 'backward' }) : { direction: 'backward' };
    return _parse(_Err)(schema, value, ctx);
  };
  var _decode = (_Err) => (schema, value, _ctx) => {
    return _parse(_Err)(schema, value, _ctx);
  };
  var _encodeAsync = (_Err) => async (schema, value, _ctx) => {
    const ctx = _ctx ? Object.assign(_ctx, { direction: 'backward' }) : { direction: 'backward' };
    return _parseAsync(_Err)(schema, value, ctx);
  };
  var _decodeAsync = (_Err) => async (schema, value, _ctx) => {
    return _parseAsync(_Err)(schema, value, _ctx);
  };
  var _safeEncode = (_Err) => (schema, value, _ctx) => {
    const ctx = _ctx ? Object.assign(_ctx, { direction: 'backward' }) : { direction: 'backward' };
    return _safeParse(_Err)(schema, value, ctx);
  };
  var _safeDecode = (_Err) => (schema, value, _ctx) => {
    return _safeParse(_Err)(schema, value, _ctx);
  };
  var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
    const ctx = _ctx ? Object.assign(_ctx, { direction: 'backward' }) : { direction: 'backward' };
    return _safeParseAsync(_Err)(schema, value, ctx);
  };
  var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
    return _safeParseAsync(_Err)(schema, value, _ctx);
  };
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/core/regexes.js
  var cuid = /^[cC][^\s-]{8,}$/;
  var cuid2 = /^[0-9a-z]+$/;
  var ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
  var xid = /^[0-9a-vA-V]{20}$/;
  var ksuid = /^[A-Za-z0-9]{27}$/;
  var nanoid = /^[a-zA-Z0-9_-]{21}$/;
  /** ISO 8601-1 duration regex. Does not support the 8601-2 extensions like negative durations or fractional/negative components. */
  var duration$1 =
    /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
  /** A regex for any UUID-like identifier: 8-4-4-4-12 hex pattern */
  var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
  /** Returns a regex for validating an RFC 9562/4122 UUID.
   *
   * @param version Optionally specify a version 1-8. If no version is specified, all versions are supported. */
  var uuid = (version) => {
    if (!version)
      return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
    return new RegExp(
      `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`,
    );
  };
  /** Practical email validation */
  var email =
    /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
  var _emoji$1 = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
  function emoji() {
    return new RegExp(_emoji$1, 'u');
  }
  var ipv4 =
    /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
  var ipv6 =
    /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
  var cidrv4 =
    /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
  var cidrv6 =
    /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
  var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
  var base64url = /^[A-Za-z0-9_-]*$/;
  var e164 = /^\+[1-9]\d{6,14}$/;
  var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
  var date$1 = /* @__PURE__ */ new RegExp(`^${dateSource}$`);
  function timeSource(args) {
    const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
    return typeof args.precision === 'number'
      ? args.precision === -1
        ? `${hhmm}`
        : args.precision === 0
          ? `${hhmm}:[0-5]\\d`
          : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}`
      : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  }
  function time$1(args) {
    return new RegExp(`^${timeSource(args)}$`);
  }
  function datetime$1(args) {
    const time = timeSource({ precision: args.precision });
    const opts = ['Z'];
    if (args.local) opts.push('');
    if (args.offset) opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
    const timeRegex = `${time}(?:${opts.join('|')})`;
    return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
  }
  var string$1 = (params) => {
    const regex = params
      ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ''}}`
      : `[\\s\\S]*`;
    return new RegExp(`^${regex}$`);
  };
  var integer = /^-?\d+$/;
  var number$1 = /^-?\d+(?:\.\d+)?$/;
  var boolean$1 = /^(?:true|false)$/i;
  var lowercase = /^[^A-Z]*$/;
  var uppercase = /^[^a-z]*$/;
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/core/checks.js
  var $ZodCheck = /* @__PURE__ */ $constructor('$ZodCheck', (inst, def) => {
    var _a;
    inst._zod ?? (inst._zod = {});
    inst._zod.def = def;
    (_a = inst._zod).onattach ?? (_a.onattach = []);
  });
  var numericOriginMap = {
    number: 'number',
    bigint: 'bigint',
    object: 'date',
  };
  var $ZodCheckLessThan = /* @__PURE__ */ $constructor('$ZodCheckLessThan', (inst, def) => {
    $ZodCheck.init(inst, def);
    const origin = numericOriginMap[typeof def.value];
    inst._zod.onattach.push((inst) => {
      const bag = inst._zod.bag;
      const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
      if (def.value < curr)
        if (def.inclusive) bag.maximum = def.value;
        else bag.exclusiveMaximum = def.value;
    });
    inst._zod.check = (payload) => {
      if (def.inclusive ? payload.value <= def.value : payload.value < def.value) return;
      payload.issues.push({
        origin,
        code: 'too_big',
        maximum: typeof def.value === 'object' ? def.value.getTime() : def.value,
        input: payload.value,
        inclusive: def.inclusive,
        inst,
        continue: !def.abort,
      });
    };
  });
  var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor('$ZodCheckGreaterThan', (inst, def) => {
    $ZodCheck.init(inst, def);
    const origin = numericOriginMap[typeof def.value];
    inst._zod.onattach.push((inst) => {
      const bag = inst._zod.bag;
      const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
      if (def.value > curr)
        if (def.inclusive) bag.minimum = def.value;
        else bag.exclusiveMinimum = def.value;
    });
    inst._zod.check = (payload) => {
      if (def.inclusive ? payload.value >= def.value : payload.value > def.value) return;
      payload.issues.push({
        origin,
        code: 'too_small',
        minimum: typeof def.value === 'object' ? def.value.getTime() : def.value,
        input: payload.value,
        inclusive: def.inclusive,
        inst,
        continue: !def.abort,
      });
    };
  });
  var $ZodCheckMultipleOf = /* @__PURE__ */ $constructor('$ZodCheckMultipleOf', (inst, def) => {
    $ZodCheck.init(inst, def);
    inst._zod.onattach.push((inst) => {
      var _a;
      (_a = inst._zod.bag).multipleOf ?? (_a.multipleOf = def.value);
    });
    inst._zod.check = (payload) => {
      if (typeof payload.value !== typeof def.value)
        throw new Error('Cannot mix number and bigint in multiple_of check.');
      if (
        typeof payload.value === 'bigint'
          ? payload.value % def.value === BigInt(0)
          : floatSafeRemainder(payload.value, def.value) === 0
      )
        return;
      payload.issues.push({
        origin: typeof payload.value,
        code: 'not_multiple_of',
        divisor: def.value,
        input: payload.value,
        inst,
        continue: !def.abort,
      });
    };
  });
  var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor('$ZodCheckNumberFormat', (inst, def) => {
    $ZodCheck.init(inst, def);
    def.format = def.format || 'float64';
    const isInt = def.format?.includes('int');
    const origin = isInt ? 'int' : 'number';
    const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
    inst._zod.onattach.push((inst) => {
      const bag = inst._zod.bag;
      bag.format = def.format;
      bag.minimum = minimum;
      bag.maximum = maximum;
      if (isInt) bag.pattern = integer;
    });
    inst._zod.check = (payload) => {
      const input = payload.value;
      if (isInt) {
        if (!Number.isInteger(input)) {
          payload.issues.push({
            expected: origin,
            format: def.format,
            code: 'invalid_type',
            continue: false,
            input,
            inst,
          });
          return;
        }
        if (!Number.isSafeInteger(input)) {
          if (input > 0)
            payload.issues.push({
              input,
              code: 'too_big',
              maximum: Number.MAX_SAFE_INTEGER,
              note: 'Integers must be within the safe integer range.',
              inst,
              origin,
              inclusive: true,
              continue: !def.abort,
            });
          else
            payload.issues.push({
              input,
              code: 'too_small',
              minimum: Number.MIN_SAFE_INTEGER,
              note: 'Integers must be within the safe integer range.',
              inst,
              origin,
              inclusive: true,
              continue: !def.abort,
            });
          return;
        }
      }
      if (input < minimum)
        payload.issues.push({
          origin: 'number',
          input,
          code: 'too_small',
          minimum,
          inclusive: true,
          inst,
          continue: !def.abort,
        });
      if (input > maximum)
        payload.issues.push({
          origin: 'number',
          input,
          code: 'too_big',
          maximum,
          inclusive: true,
          inst,
          continue: !def.abort,
        });
    };
  });
  var $ZodCheckMaxLength = /* @__PURE__ */ $constructor('$ZodCheckMaxLength', (inst, def) => {
    var _a;
    $ZodCheck.init(inst, def);
    (_a = inst._zod.def).when ??
      (_a.when = (payload) => {
        const val = payload.value;
        return !nullish(val) && val.length !== void 0;
      });
    inst._zod.onattach.push((inst) => {
      const curr = inst._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
      if (def.maximum < curr) inst._zod.bag.maximum = def.maximum;
    });
    inst._zod.check = (payload) => {
      const input = payload.value;
      if (input.length <= def.maximum) return;
      const origin = getLengthableOrigin(input);
      payload.issues.push({
        origin,
        code: 'too_big',
        maximum: def.maximum,
        inclusive: true,
        input,
        inst,
        continue: !def.abort,
      });
    };
  });
  var $ZodCheckMinLength = /* @__PURE__ */ $constructor('$ZodCheckMinLength', (inst, def) => {
    var _a;
    $ZodCheck.init(inst, def);
    (_a = inst._zod.def).when ??
      (_a.when = (payload) => {
        const val = payload.value;
        return !nullish(val) && val.length !== void 0;
      });
    inst._zod.onattach.push((inst) => {
      const curr = inst._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
      if (def.minimum > curr) inst._zod.bag.minimum = def.minimum;
    });
    inst._zod.check = (payload) => {
      const input = payload.value;
      if (input.length >= def.minimum) return;
      const origin = getLengthableOrigin(input);
      payload.issues.push({
        origin,
        code: 'too_small',
        minimum: def.minimum,
        inclusive: true,
        input,
        inst,
        continue: !def.abort,
      });
    };
  });
  var $ZodCheckLengthEquals = /* @__PURE__ */ $constructor('$ZodCheckLengthEquals', (inst, def) => {
    var _a;
    $ZodCheck.init(inst, def);
    (_a = inst._zod.def).when ??
      (_a.when = (payload) => {
        const val = payload.value;
        return !nullish(val) && val.length !== void 0;
      });
    inst._zod.onattach.push((inst) => {
      const bag = inst._zod.bag;
      bag.minimum = def.length;
      bag.maximum = def.length;
      bag.length = def.length;
    });
    inst._zod.check = (payload) => {
      const input = payload.value;
      const length = input.length;
      if (length === def.length) return;
      const origin = getLengthableOrigin(input);
      const tooBig = length > def.length;
      payload.issues.push({
        origin,
        ...(tooBig
          ? {
              code: 'too_big',
              maximum: def.length,
            }
          : {
              code: 'too_small',
              minimum: def.length,
            }),
        inclusive: true,
        exact: true,
        input: payload.value,
        inst,
        continue: !def.abort,
      });
    };
  });
  var $ZodCheckStringFormat = /* @__PURE__ */ $constructor('$ZodCheckStringFormat', (inst, def) => {
    var _a, _b;
    $ZodCheck.init(inst, def);
    inst._zod.onattach.push((inst) => {
      const bag = inst._zod.bag;
      bag.format = def.format;
      if (def.pattern) {
        bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
        bag.patterns.add(def.pattern);
      }
    });
    if (def.pattern)
      (_a = inst._zod).check ??
        (_a.check = (payload) => {
          def.pattern.lastIndex = 0;
          if (def.pattern.test(payload.value)) return;
          payload.issues.push({
            origin: 'string',
            code: 'invalid_format',
            format: def.format,
            input: payload.value,
            ...(def.pattern ? { pattern: def.pattern.toString() } : {}),
            inst,
            continue: !def.abort,
          });
        });
    else (_b = inst._zod).check ?? (_b.check = () => {});
  });
  var $ZodCheckRegex = /* @__PURE__ */ $constructor('$ZodCheckRegex', (inst, def) => {
    $ZodCheckStringFormat.init(inst, def);
    inst._zod.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value)) return;
      payload.issues.push({
        origin: 'string',
        code: 'invalid_format',
        format: 'regex',
        input: payload.value,
        pattern: def.pattern.toString(),
        inst,
        continue: !def.abort,
      });
    };
  });
  var $ZodCheckLowerCase = /* @__PURE__ */ $constructor('$ZodCheckLowerCase', (inst, def) => {
    def.pattern ?? (def.pattern = lowercase);
    $ZodCheckStringFormat.init(inst, def);
  });
  var $ZodCheckUpperCase = /* @__PURE__ */ $constructor('$ZodCheckUpperCase', (inst, def) => {
    def.pattern ?? (def.pattern = uppercase);
    $ZodCheckStringFormat.init(inst, def);
  });
  var $ZodCheckIncludes = /* @__PURE__ */ $constructor('$ZodCheckIncludes', (inst, def) => {
    $ZodCheck.init(inst, def);
    const escapedRegex = escapeRegex(def.includes);
    const pattern = new RegExp(
      typeof def.position === 'number' ? `^.{${def.position}}${escapedRegex}` : escapedRegex,
    );
    def.pattern = pattern;
    inst._zod.onattach.push((inst) => {
      const bag = inst._zod.bag;
      bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
      bag.patterns.add(pattern);
    });
    inst._zod.check = (payload) => {
      if (payload.value.includes(def.includes, def.position)) return;
      payload.issues.push({
        origin: 'string',
        code: 'invalid_format',
        format: 'includes',
        includes: def.includes,
        input: payload.value,
        inst,
        continue: !def.abort,
      });
    };
  });
  var $ZodCheckStartsWith = /* @__PURE__ */ $constructor('$ZodCheckStartsWith', (inst, def) => {
    $ZodCheck.init(inst, def);
    const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
    def.pattern ?? (def.pattern = pattern);
    inst._zod.onattach.push((inst) => {
      const bag = inst._zod.bag;
      bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
      bag.patterns.add(pattern);
    });
    inst._zod.check = (payload) => {
      if (payload.value.startsWith(def.prefix)) return;
      payload.issues.push({
        origin: 'string',
        code: 'invalid_format',
        format: 'starts_with',
        prefix: def.prefix,
        input: payload.value,
        inst,
        continue: !def.abort,
      });
    };
  });
  var $ZodCheckEndsWith = /* @__PURE__ */ $constructor('$ZodCheckEndsWith', (inst, def) => {
    $ZodCheck.init(inst, def);
    const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
    def.pattern ?? (def.pattern = pattern);
    inst._zod.onattach.push((inst) => {
      const bag = inst._zod.bag;
      bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
      bag.patterns.add(pattern);
    });
    inst._zod.check = (payload) => {
      if (payload.value.endsWith(def.suffix)) return;
      payload.issues.push({
        origin: 'string',
        code: 'invalid_format',
        format: 'ends_with',
        suffix: def.suffix,
        input: payload.value,
        inst,
        continue: !def.abort,
      });
    };
  });
  var $ZodCheckOverwrite = /* @__PURE__ */ $constructor('$ZodCheckOverwrite', (inst, def) => {
    $ZodCheck.init(inst, def);
    inst._zod.check = (payload) => {
      payload.value = def.tx(payload.value);
    };
  });
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/core/doc.js
  var Doc = class {
    constructor(args = []) {
      this.content = [];
      this.indent = 0;
      if (this) this.args = args;
    }
    indented(fn) {
      this.indent += 1;
      fn(this);
      this.indent -= 1;
    }
    write(arg) {
      if (typeof arg === 'function') {
        arg(this, { execution: 'sync' });
        arg(this, { execution: 'async' });
        return;
      }
      const lines = arg.split('\n').filter((x) => x);
      const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
      const dedented = lines
        .map((x) => x.slice(minIndent))
        .map((x) => ' '.repeat(this.indent * 2) + x);
      for (const line of dedented) this.content.push(line);
    }
    compile() {
      const F = Function;
      const args = this?.args;
      const lines = [...(this?.content ?? [``]).map((x) => `  ${x}`)];
      return new F(...args, lines.join('\n'));
    }
  };
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/core/versions.js
  var version = {
    major: 4,
    minor: 3,
    patch: 6,
  };
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/core/schemas.js
  var $ZodType = /* @__PURE__ */ $constructor('$ZodType', (inst, def) => {
    var _a;
    inst ?? (inst = {});
    inst._zod.def = def;
    inst._zod.bag = inst._zod.bag || {};
    inst._zod.version = version;
    const checks = [...(inst._zod.def.checks ?? [])];
    if (inst._zod.traits.has('$ZodCheck')) checks.unshift(inst);
    for (const ch of checks) for (const fn of ch._zod.onattach) fn(inst);
    if (checks.length === 0) {
      (_a = inst._zod).deferred ?? (_a.deferred = []);
      inst._zod.deferred?.push(() => {
        inst._zod.run = inst._zod.parse;
      });
    } else {
      const runChecks = (payload, checks, ctx) => {
        let isAborted = aborted(payload);
        let asyncResult;
        for (const ch of checks) {
          if (ch._zod.def.when) {
            if (!ch._zod.def.when(payload)) continue;
          } else if (isAborted) continue;
          const currLen = payload.issues.length;
          const _ = ch._zod.check(payload);
          if (_ instanceof Promise && ctx?.async === false) throw new $ZodAsyncError();
          if (asyncResult || _ instanceof Promise)
            asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
              await _;
              if (payload.issues.length === currLen) return;
              if (!isAborted) isAborted = aborted(payload, currLen);
            });
          else {
            if (payload.issues.length === currLen) continue;
            if (!isAborted) isAborted = aborted(payload, currLen);
          }
        }
        if (asyncResult)
          return asyncResult.then(() => {
            return payload;
          });
        return payload;
      };
      const handleCanaryResult = (canary, payload, ctx) => {
        if (aborted(canary)) {
          canary.aborted = true;
          return canary;
        }
        const checkResult = runChecks(payload, checks, ctx);
        if (checkResult instanceof Promise) {
          if (ctx.async === false) throw new $ZodAsyncError();
          return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
        }
        return inst._zod.parse(checkResult, ctx);
      };
      inst._zod.run = (payload, ctx) => {
        if (ctx.skipChecks) return inst._zod.parse(payload, ctx);
        if (ctx.direction === 'backward') {
          const canary = inst._zod.parse(
            {
              value: payload.value,
              issues: [],
            },
            {
              ...ctx,
              skipChecks: true,
            },
          );
          if (canary instanceof Promise)
            return canary.then((canary) => {
              return handleCanaryResult(canary, payload, ctx);
            });
          return handleCanaryResult(canary, payload, ctx);
        }
        const result = inst._zod.parse(payload, ctx);
        if (result instanceof Promise) {
          if (ctx.async === false) throw new $ZodAsyncError();
          return result.then((result) => runChecks(result, checks, ctx));
        }
        return runChecks(result, checks, ctx);
      };
    }
    defineLazy(inst, '~standard', () => ({
      validate: (value) => {
        try {
          const r = safeParse$1(inst, value);
          return r.success ? { value: r.data } : { issues: r.error?.issues };
        } catch (_) {
          return safeParseAsync$1(inst, value).then((r) =>
            r.success ? { value: r.data } : { issues: r.error?.issues },
          );
        }
      },
      vendor: 'zod',
      version: 1,
    }));
  });
  var $ZodString = /* @__PURE__ */ $constructor('$ZodString', (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.pattern = [...(inst?._zod.bag?.patterns ?? [])].pop() ?? string$1(inst._zod.bag);
    inst._zod.parse = (payload, _) => {
      if (def.coerce)
        try {
          payload.value = String(payload.value);
        } catch (_) {}
      if (typeof payload.value === 'string') return payload;
      payload.issues.push({
        expected: 'string',
        code: 'invalid_type',
        input: payload.value,
        inst,
      });
      return payload;
    };
  });
  var $ZodStringFormat = /* @__PURE__ */ $constructor('$ZodStringFormat', (inst, def) => {
    $ZodCheckStringFormat.init(inst, def);
    $ZodString.init(inst, def);
  });
  var $ZodGUID = /* @__PURE__ */ $constructor('$ZodGUID', (inst, def) => {
    def.pattern ?? (def.pattern = guid);
    $ZodStringFormat.init(inst, def);
  });
  var $ZodUUID = /* @__PURE__ */ $constructor('$ZodUUID', (inst, def) => {
    if (def.version) {
      const v = {
        v1: 1,
        v2: 2,
        v3: 3,
        v4: 4,
        v5: 5,
        v6: 6,
        v7: 7,
        v8: 8,
      }[def.version];
      if (v === void 0) throw new Error(`Invalid UUID version: "${def.version}"`);
      def.pattern ?? (def.pattern = uuid(v));
    } else def.pattern ?? (def.pattern = uuid());
    $ZodStringFormat.init(inst, def);
  });
  var $ZodEmail = /* @__PURE__ */ $constructor('$ZodEmail', (inst, def) => {
    def.pattern ?? (def.pattern = email);
    $ZodStringFormat.init(inst, def);
  });
  var $ZodURL = /* @__PURE__ */ $constructor('$ZodURL', (inst, def) => {
    $ZodStringFormat.init(inst, def);
    inst._zod.check = (payload) => {
      try {
        const trimmed = payload.value.trim();
        const url = new URL(trimmed);
        if (def.hostname) {
          def.hostname.lastIndex = 0;
          if (!def.hostname.test(url.hostname))
            payload.issues.push({
              code: 'invalid_format',
              format: 'url',
              note: 'Invalid hostname',
              pattern: def.hostname.source,
              input: payload.value,
              inst,
              continue: !def.abort,
            });
        }
        if (def.protocol) {
          def.protocol.lastIndex = 0;
          if (
            !def.protocol.test(
              url.protocol.endsWith(':') ? url.protocol.slice(0, -1) : url.protocol,
            )
          )
            payload.issues.push({
              code: 'invalid_format',
              format: 'url',
              note: 'Invalid protocol',
              pattern: def.protocol.source,
              input: payload.value,
              inst,
              continue: !def.abort,
            });
        }
        if (def.normalize) payload.value = url.href;
        else payload.value = trimmed;
        return;
      } catch (_) {
        payload.issues.push({
          code: 'invalid_format',
          format: 'url',
          input: payload.value,
          inst,
          continue: !def.abort,
        });
      }
    };
  });
  var $ZodEmoji = /* @__PURE__ */ $constructor('$ZodEmoji', (inst, def) => {
    def.pattern ?? (def.pattern = emoji());
    $ZodStringFormat.init(inst, def);
  });
  var $ZodNanoID = /* @__PURE__ */ $constructor('$ZodNanoID', (inst, def) => {
    def.pattern ?? (def.pattern = nanoid);
    $ZodStringFormat.init(inst, def);
  });
  var $ZodCUID = /* @__PURE__ */ $constructor('$ZodCUID', (inst, def) => {
    def.pattern ?? (def.pattern = cuid);
    $ZodStringFormat.init(inst, def);
  });
  var $ZodCUID2 = /* @__PURE__ */ $constructor('$ZodCUID2', (inst, def) => {
    def.pattern ?? (def.pattern = cuid2);
    $ZodStringFormat.init(inst, def);
  });
  var $ZodULID = /* @__PURE__ */ $constructor('$ZodULID', (inst, def) => {
    def.pattern ?? (def.pattern = ulid);
    $ZodStringFormat.init(inst, def);
  });
  var $ZodXID = /* @__PURE__ */ $constructor('$ZodXID', (inst, def) => {
    def.pattern ?? (def.pattern = xid);
    $ZodStringFormat.init(inst, def);
  });
  var $ZodKSUID = /* @__PURE__ */ $constructor('$ZodKSUID', (inst, def) => {
    def.pattern ?? (def.pattern = ksuid);
    $ZodStringFormat.init(inst, def);
  });
  var $ZodISODateTime = /* @__PURE__ */ $constructor('$ZodISODateTime', (inst, def) => {
    def.pattern ?? (def.pattern = datetime$1(def));
    $ZodStringFormat.init(inst, def);
  });
  var $ZodISODate = /* @__PURE__ */ $constructor('$ZodISODate', (inst, def) => {
    def.pattern ?? (def.pattern = date$1);
    $ZodStringFormat.init(inst, def);
  });
  var $ZodISOTime = /* @__PURE__ */ $constructor('$ZodISOTime', (inst, def) => {
    def.pattern ?? (def.pattern = time$1(def));
    $ZodStringFormat.init(inst, def);
  });
  var $ZodISODuration = /* @__PURE__ */ $constructor('$ZodISODuration', (inst, def) => {
    def.pattern ?? (def.pattern = duration$1);
    $ZodStringFormat.init(inst, def);
  });
  var $ZodIPv4 = /* @__PURE__ */ $constructor('$ZodIPv4', (inst, def) => {
    def.pattern ?? (def.pattern = ipv4);
    $ZodStringFormat.init(inst, def);
    inst._zod.bag.format = `ipv4`;
  });
  var $ZodIPv6 = /* @__PURE__ */ $constructor('$ZodIPv6', (inst, def) => {
    def.pattern ?? (def.pattern = ipv6);
    $ZodStringFormat.init(inst, def);
    inst._zod.bag.format = `ipv6`;
    inst._zod.check = (payload) => {
      try {
        new URL(`http://[${payload.value}]`);
      } catch {
        payload.issues.push({
          code: 'invalid_format',
          format: 'ipv6',
          input: payload.value,
          inst,
          continue: !def.abort,
        });
      }
    };
  });
  var $ZodCIDRv4 = /* @__PURE__ */ $constructor('$ZodCIDRv4', (inst, def) => {
    def.pattern ?? (def.pattern = cidrv4);
    $ZodStringFormat.init(inst, def);
  });
  var $ZodCIDRv6 = /* @__PURE__ */ $constructor('$ZodCIDRv6', (inst, def) => {
    def.pattern ?? (def.pattern = cidrv6);
    $ZodStringFormat.init(inst, def);
    inst._zod.check = (payload) => {
      const parts = payload.value.split('/');
      try {
        if (parts.length !== 2) throw new Error();
        const [address, prefix] = parts;
        if (!prefix) throw new Error();
        const prefixNum = Number(prefix);
        if (`${prefixNum}` !== prefix) throw new Error();
        if (prefixNum < 0 || prefixNum > 128) throw new Error();
        new URL(`http://[${address}]`);
      } catch {
        payload.issues.push({
          code: 'invalid_format',
          format: 'cidrv6',
          input: payload.value,
          inst,
          continue: !def.abort,
        });
      }
    };
  });
  function isValidBase64(data) {
    if (data === '') return true;
    if (data.length % 4 !== 0) return false;
    try {
      atob(data);
      return true;
    } catch {
      return false;
    }
  }
  var $ZodBase64 = /* @__PURE__ */ $constructor('$ZodBase64', (inst, def) => {
    def.pattern ?? (def.pattern = base64);
    $ZodStringFormat.init(inst, def);
    inst._zod.bag.contentEncoding = 'base64';
    inst._zod.check = (payload) => {
      if (isValidBase64(payload.value)) return;
      payload.issues.push({
        code: 'invalid_format',
        format: 'base64',
        input: payload.value,
        inst,
        continue: !def.abort,
      });
    };
  });
  function isValidBase64URL(data) {
    if (!base64url.test(data)) return false;
    const base64 = data.replace(/[-_]/g, (c) => (c === '-' ? '+' : '/'));
    return isValidBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  }
  var $ZodBase64URL = /* @__PURE__ */ $constructor('$ZodBase64URL', (inst, def) => {
    def.pattern ?? (def.pattern = base64url);
    $ZodStringFormat.init(inst, def);
    inst._zod.bag.contentEncoding = 'base64url';
    inst._zod.check = (payload) => {
      if (isValidBase64URL(payload.value)) return;
      payload.issues.push({
        code: 'invalid_format',
        format: 'base64url',
        input: payload.value,
        inst,
        continue: !def.abort,
      });
    };
  });
  var $ZodE164 = /* @__PURE__ */ $constructor('$ZodE164', (inst, def) => {
    def.pattern ?? (def.pattern = e164);
    $ZodStringFormat.init(inst, def);
  });
  function isValidJWT(token, algorithm = null) {
    try {
      const tokensParts = token.split('.');
      if (tokensParts.length !== 3) return false;
      const [header] = tokensParts;
      if (!header) return false;
      const parsedHeader = JSON.parse(atob(header));
      if ('typ' in parsedHeader && parsedHeader?.typ !== 'JWT') return false;
      if (!parsedHeader.alg) return false;
      if (algorithm && (!('alg' in parsedHeader) || parsedHeader.alg !== algorithm)) return false;
      return true;
    } catch {
      return false;
    }
  }
  var $ZodJWT = /* @__PURE__ */ $constructor('$ZodJWT', (inst, def) => {
    $ZodStringFormat.init(inst, def);
    inst._zod.check = (payload) => {
      if (isValidJWT(payload.value, def.alg)) return;
      payload.issues.push({
        code: 'invalid_format',
        format: 'jwt',
        input: payload.value,
        inst,
        continue: !def.abort,
      });
    };
  });
  var $ZodNumber = /* @__PURE__ */ $constructor('$ZodNumber', (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.pattern = inst._zod.bag.pattern ?? number$1;
    inst._zod.parse = (payload, _ctx) => {
      if (def.coerce)
        try {
          payload.value = Number(payload.value);
        } catch (_) {}
      const input = payload.value;
      if (typeof input === 'number' && !Number.isNaN(input) && Number.isFinite(input))
        return payload;
      const received =
        typeof input === 'number'
          ? Number.isNaN(input)
            ? 'NaN'
            : !Number.isFinite(input)
              ? 'Infinity'
              : void 0
          : void 0;
      payload.issues.push({
        expected: 'number',
        code: 'invalid_type',
        input,
        inst,
        ...(received ? { received } : {}),
      });
      return payload;
    };
  });
  var $ZodNumberFormat = /* @__PURE__ */ $constructor('$ZodNumberFormat', (inst, def) => {
    $ZodCheckNumberFormat.init(inst, def);
    $ZodNumber.init(inst, def);
  });
  var $ZodBoolean = /* @__PURE__ */ $constructor('$ZodBoolean', (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.pattern = boolean$1;
    inst._zod.parse = (payload, _ctx) => {
      if (def.coerce)
        try {
          payload.value = Boolean(payload.value);
        } catch (_) {}
      const input = payload.value;
      if (typeof input === 'boolean') return payload;
      payload.issues.push({
        expected: 'boolean',
        code: 'invalid_type',
        input,
        inst,
      });
      return payload;
    };
  });
  var $ZodUnknown = /* @__PURE__ */ $constructor('$ZodUnknown', (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.parse = (payload) => payload;
  });
  var $ZodNever = /* @__PURE__ */ $constructor('$ZodNever', (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.parse = (payload, _ctx) => {
      payload.issues.push({
        expected: 'never',
        code: 'invalid_type',
        input: payload.value,
        inst,
      });
      return payload;
    };
  });
  function handleArrayResult(result, final, index) {
    if (result.issues.length) final.issues.push(...prefixIssues(index, result.issues));
    final.value[index] = result.value;
  }
  var $ZodArray = /* @__PURE__ */ $constructor('$ZodArray', (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.parse = (payload, ctx) => {
      const input = payload.value;
      if (!Array.isArray(input)) {
        payload.issues.push({
          expected: 'array',
          code: 'invalid_type',
          input,
          inst,
        });
        return payload;
      }
      payload.value = Array(input.length);
      const proms = [];
      for (let i = 0; i < input.length; i++) {
        const item = input[i];
        const result = def.element._zod.run(
          {
            value: item,
            issues: [],
          },
          ctx,
        );
        if (result instanceof Promise)
          proms.push(result.then((result) => handleArrayResult(result, payload, i)));
        else handleArrayResult(result, payload, i);
      }
      if (proms.length) return Promise.all(proms).then(() => payload);
      return payload;
    };
  });
  function handlePropertyResult(result, final, key, input, isOptionalOut) {
    if (result.issues.length) {
      if (isOptionalOut && !(key in input)) return;
      final.issues.push(...prefixIssues(key, result.issues));
    }
    if (result.value === void 0) {
      if (key in input) final.value[key] = void 0;
    } else final.value[key] = result.value;
  }
  function normalizeDef(def) {
    const keys = Object.keys(def.shape);
    for (const k of keys)
      if (!def.shape?.[k]?._zod?.traits?.has('$ZodType'))
        throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
    const okeys = optionalKeys(def.shape);
    return {
      ...def,
      keys,
      keySet: new Set(keys),
      numKeys: keys.length,
      optionalKeys: new Set(okeys),
    };
  }
  function handleCatchall(proms, input, payload, ctx, def, inst) {
    const unrecognized = [];
    const keySet = def.keySet;
    const _catchall = def.catchall._zod;
    const t = _catchall.def.type;
    const isOptionalOut = _catchall.optout === 'optional';
    for (const key in input) {
      if (keySet.has(key)) continue;
      if (t === 'never') {
        unrecognized.push(key);
        continue;
      }
      const r = _catchall.run(
        {
          value: input[key],
          issues: [],
        },
        ctx,
      );
      if (r instanceof Promise)
        proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalOut)));
      else handlePropertyResult(r, payload, key, input, isOptionalOut);
    }
    if (unrecognized.length)
      payload.issues.push({
        code: 'unrecognized_keys',
        keys: unrecognized,
        input,
        inst,
      });
    if (!proms.length) return payload;
    return Promise.all(proms).then(() => {
      return payload;
    });
  }
  var $ZodObject = /* @__PURE__ */ $constructor('$ZodObject', (inst, def) => {
    $ZodType.init(inst, def);
    if (!Object.getOwnPropertyDescriptor(def, 'shape')?.get) {
      const sh = def.shape;
      Object.defineProperty(def, 'shape', {
        get: () => {
          const newSh = { ...sh };
          Object.defineProperty(def, 'shape', { value: newSh });
          return newSh;
        },
      });
    }
    const _normalized = cached(() => normalizeDef(def));
    defineLazy(inst._zod, 'propValues', () => {
      const shape = def.shape;
      const propValues = {};
      for (const key in shape) {
        const field = shape[key]._zod;
        if (field.values) {
          propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
          for (const v of field.values) propValues[key].add(v);
        }
      }
      return propValues;
    });
    const isObject$2 = isObject;
    const catchall = def.catchall;
    let value;
    inst._zod.parse = (payload, ctx) => {
      value ?? (value = _normalized.value);
      const input = payload.value;
      if (!isObject$2(input)) {
        payload.issues.push({
          expected: 'object',
          code: 'invalid_type',
          input,
          inst,
        });
        return payload;
      }
      payload.value = {};
      const proms = [];
      const shape = value.shape;
      for (const key of value.keys) {
        const el = shape[key];
        const isOptionalOut = el._zod.optout === 'optional';
        const r = el._zod.run(
          {
            value: input[key],
            issues: [],
          },
          ctx,
        );
        if (r instanceof Promise)
          proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalOut)));
        else handlePropertyResult(r, payload, key, input, isOptionalOut);
      }
      if (!catchall) return proms.length ? Promise.all(proms).then(() => payload) : payload;
      return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
    };
  });
  var $ZodObjectJIT = /* @__PURE__ */ $constructor('$ZodObjectJIT', (inst, def) => {
    $ZodObject.init(inst, def);
    const superParse = inst._zod.parse;
    const _normalized = cached(() => normalizeDef(def));
    const generateFastpass = (shape) => {
      const doc = new Doc(['shape', 'payload', 'ctx']);
      const normalized = _normalized.value;
      const parseStr = (key) => {
        const k = esc(key);
        return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
      };
      doc.write(`const input = payload.value;`);
      const ids = Object.create(null);
      let counter = 0;
      for (const key of normalized.keys) ids[key] = `key_${counter++}`;
      doc.write(`const newResult = {};`);
      for (const key of normalized.keys) {
        const id = ids[key];
        const k = esc(key);
        const isOptionalOut = shape[key]?._zod?.optout === 'optional';
        doc.write(`const ${id} = ${parseStr(key)};`);
        if (isOptionalOut)
          doc.write(`
        if (${id}.issues.length) {
          if (${k} in input) {
            payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${k}, ...iss.path] : [${k}]
            })));
          }
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
        else
          doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
      }
      doc.write(`payload.value = newResult;`);
      doc.write(`return payload;`);
      const fn = doc.compile();
      return (payload, ctx) => fn(shape, payload, ctx);
    };
    let fastpass;
    const isObject$1 = isObject;
    const jit = !globalConfig.jitless;
    const fastEnabled = jit && allowsEval.value;
    const catchall = def.catchall;
    let value;
    inst._zod.parse = (payload, ctx) => {
      value ?? (value = _normalized.value);
      const input = payload.value;
      if (!isObject$1(input)) {
        payload.issues.push({
          expected: 'object',
          code: 'invalid_type',
          input,
          inst,
        });
        return payload;
      }
      if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
        if (!fastpass) fastpass = generateFastpass(def.shape);
        payload = fastpass(payload, ctx);
        if (!catchall) return payload;
        return handleCatchall([], input, payload, ctx, value, inst);
      }
      return superParse(payload, ctx);
    };
  });
  function handleUnionResults(results, final, inst, ctx) {
    for (const result of results)
      if (result.issues.length === 0) {
        final.value = result.value;
        return final;
      }
    const nonaborted = results.filter((r) => !aborted(r));
    if (nonaborted.length === 1) {
      final.value = nonaborted[0].value;
      return nonaborted[0];
    }
    final.issues.push({
      code: 'invalid_union',
      input: final.value,
      inst,
      errors: results.map((result) =>
        result.issues.map((iss) => finalizeIssue(iss, ctx, config())),
      ),
    });
    return final;
  }
  var $ZodUnion = /* @__PURE__ */ $constructor('$ZodUnion', (inst, def) => {
    $ZodType.init(inst, def);
    defineLazy(inst._zod, 'optin', () =>
      def.options.some((o) => o._zod.optin === 'optional') ? 'optional' : void 0,
    );
    defineLazy(inst._zod, 'optout', () =>
      def.options.some((o) => o._zod.optout === 'optional') ? 'optional' : void 0,
    );
    defineLazy(inst._zod, 'values', () => {
      if (def.options.every((o) => o._zod.values))
        return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
    });
    defineLazy(inst._zod, 'pattern', () => {
      if (def.options.every((o) => o._zod.pattern)) {
        const patterns = def.options.map((o) => o._zod.pattern);
        return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join('|')})$`);
      }
    });
    const single = def.options.length === 1;
    const first = def.options[0]._zod.run;
    inst._zod.parse = (payload, ctx) => {
      if (single) return first(payload, ctx);
      let async = false;
      const results = [];
      for (const option of def.options) {
        const result = option._zod.run(
          {
            value: payload.value,
            issues: [],
          },
          ctx,
        );
        if (result instanceof Promise) {
          results.push(result);
          async = true;
        } else {
          if (result.issues.length === 0) return result;
          results.push(result);
        }
      }
      if (!async) return handleUnionResults(results, payload, inst, ctx);
      return Promise.all(results).then((results) => {
        return handleUnionResults(results, payload, inst, ctx);
      });
    };
  });
  var $ZodIntersection = /* @__PURE__ */ $constructor('$ZodIntersection', (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.parse = (payload, ctx) => {
      const input = payload.value;
      const left = def.left._zod.run(
        {
          value: input,
          issues: [],
        },
        ctx,
      );
      const right = def.right._zod.run(
        {
          value: input,
          issues: [],
        },
        ctx,
      );
      if (left instanceof Promise || right instanceof Promise)
        return Promise.all([left, right]).then(([left, right]) => {
          return handleIntersectionResults(payload, left, right);
        });
      return handleIntersectionResults(payload, left, right);
    };
  });
  function mergeValues(a, b) {
    if (a === b)
      return {
        valid: true,
        data: a,
      };
    if (a instanceof Date && b instanceof Date && +a === +b)
      return {
        valid: true,
        data: a,
      };
    if (isPlainObject(a) && isPlainObject(b)) {
      const bKeys = Object.keys(b);
      const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
      const newObj = {
        ...a,
        ...b,
      };
      for (const key of sharedKeys) {
        const sharedValue = mergeValues(a[key], b[key]);
        if (!sharedValue.valid)
          return {
            valid: false,
            mergeErrorPath: [key, ...sharedValue.mergeErrorPath],
          };
        newObj[key] = sharedValue.data;
      }
      return {
        valid: true,
        data: newObj,
      };
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length)
        return {
          valid: false,
          mergeErrorPath: [],
        };
      const newArray = [];
      for (let index = 0; index < a.length; index++) {
        const itemA = a[index];
        const itemB = b[index];
        const sharedValue = mergeValues(itemA, itemB);
        if (!sharedValue.valid)
          return {
            valid: false,
            mergeErrorPath: [index, ...sharedValue.mergeErrorPath],
          };
        newArray.push(sharedValue.data);
      }
      return {
        valid: true,
        data: newArray,
      };
    }
    return {
      valid: false,
      mergeErrorPath: [],
    };
  }
  function handleIntersectionResults(result, left, right) {
    const unrecKeys = /* @__PURE__ */ new Map();
    let unrecIssue;
    for (const iss of left.issues)
      if (iss.code === 'unrecognized_keys') {
        unrecIssue ?? (unrecIssue = iss);
        for (const k of iss.keys) {
          if (!unrecKeys.has(k)) unrecKeys.set(k, {});
          unrecKeys.get(k).l = true;
        }
      } else result.issues.push(iss);
    for (const iss of right.issues)
      if (iss.code === 'unrecognized_keys')
        for (const k of iss.keys) {
          if (!unrecKeys.has(k)) unrecKeys.set(k, {});
          unrecKeys.get(k).r = true;
        }
      else result.issues.push(iss);
    const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
    if (bothKeys.length && unrecIssue)
      result.issues.push({
        ...unrecIssue,
        keys: bothKeys,
      });
    if (aborted(result)) return result;
    const merged = mergeValues(left.value, right.value);
    if (!merged.valid)
      throw new Error(
        `Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`,
      );
    result.value = merged.data;
    return result;
  }
  var $ZodRecord = /* @__PURE__ */ $constructor('$ZodRecord', (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.parse = (payload, ctx) => {
      const input = payload.value;
      if (!isPlainObject(input)) {
        payload.issues.push({
          expected: 'record',
          code: 'invalid_type',
          input,
          inst,
        });
        return payload;
      }
      const proms = [];
      const values = def.keyType._zod.values;
      if (values) {
        payload.value = {};
        const recordKeys = /* @__PURE__ */ new Set();
        for (const key of values)
          if (typeof key === 'string' || typeof key === 'number' || typeof key === 'symbol') {
            recordKeys.add(typeof key === 'number' ? key.toString() : key);
            const result = def.valueType._zod.run(
              {
                value: input[key],
                issues: [],
              },
              ctx,
            );
            if (result instanceof Promise)
              proms.push(
                result.then((result) => {
                  if (result.issues.length)
                    payload.issues.push(...prefixIssues(key, result.issues));
                  payload.value[key] = result.value;
                }),
              );
            else {
              if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
              payload.value[key] = result.value;
            }
          }
        let unrecognized;
        for (const key in input)
          if (!recordKeys.has(key)) {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          }
        if (unrecognized && unrecognized.length > 0)
          payload.issues.push({
            code: 'unrecognized_keys',
            input,
            inst,
            keys: unrecognized,
          });
      } else {
        payload.value = {};
        for (const key of Reflect.ownKeys(input)) {
          if (key === '__proto__') continue;
          let keyResult = def.keyType._zod.run(
            {
              value: key,
              issues: [],
            },
            ctx,
          );
          if (keyResult instanceof Promise)
            throw new Error('Async schemas not supported in object keys currently');
          if (typeof key === 'string' && number$1.test(key) && keyResult.issues.length) {
            const retryResult = def.keyType._zod.run(
              {
                value: Number(key),
                issues: [],
              },
              ctx,
            );
            if (retryResult instanceof Promise)
              throw new Error('Async schemas not supported in object keys currently');
            if (retryResult.issues.length === 0) keyResult = retryResult;
          }
          if (keyResult.issues.length) {
            if (def.mode === 'loose') payload.value[key] = input[key];
            else
              payload.issues.push({
                code: 'invalid_key',
                origin: 'record',
                issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
                input: key,
                path: [key],
                inst,
              });
            continue;
          }
          const result = def.valueType._zod.run(
            {
              value: input[key],
              issues: [],
            },
            ctx,
          );
          if (result instanceof Promise)
            proms.push(
              result.then((result) => {
                if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
                payload.value[keyResult.value] = result.value;
              }),
            );
          else {
            if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
            payload.value[keyResult.value] = result.value;
          }
        }
      }
      if (proms.length) return Promise.all(proms).then(() => payload);
      return payload;
    };
  });
  var $ZodEnum = /* @__PURE__ */ $constructor('$ZodEnum', (inst, def) => {
    $ZodType.init(inst, def);
    const values = getEnumValues(def.entries);
    const valuesSet = new Set(values);
    inst._zod.values = valuesSet;
    inst._zod.pattern = new RegExp(
      `^(${values
        .filter((k) => propertyKeyTypes.has(typeof k))
        .map((o) => (typeof o === 'string' ? escapeRegex(o) : o.toString()))
        .join('|')})$`,
    );
    inst._zod.parse = (payload, _ctx) => {
      const input = payload.value;
      if (valuesSet.has(input)) return payload;
      payload.issues.push({
        code: 'invalid_value',
        values,
        input,
        inst,
      });
      return payload;
    };
  });
  var $ZodTransform = /* @__PURE__ */ $constructor('$ZodTransform', (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.parse = (payload, ctx) => {
      if (ctx.direction === 'backward') throw new $ZodEncodeError(inst.constructor.name);
      const _out = def.transform(payload.value, payload);
      if (ctx.async)
        return (_out instanceof Promise ? _out : Promise.resolve(_out)).then((output) => {
          payload.value = output;
          return payload;
        });
      if (_out instanceof Promise) throw new $ZodAsyncError();
      payload.value = _out;
      return payload;
    };
  });
  function handleOptionalResult(result, input) {
    if (result.issues.length && input === void 0)
      return {
        issues: [],
        value: void 0,
      };
    return result;
  }
  var $ZodOptional = /* @__PURE__ */ $constructor('$ZodOptional', (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.optin = 'optional';
    inst._zod.optout = 'optional';
    defineLazy(inst._zod, 'values', () => {
      return def.innerType._zod.values ? new Set([...def.innerType._zod.values, void 0]) : void 0;
    });
    defineLazy(inst._zod, 'pattern', () => {
      const pattern = def.innerType._zod.pattern;
      return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
    });
    inst._zod.parse = (payload, ctx) => {
      if (def.innerType._zod.optin === 'optional') {
        const result = def.innerType._zod.run(payload, ctx);
        if (result instanceof Promise)
          return result.then((r) => handleOptionalResult(r, payload.value));
        return handleOptionalResult(result, payload.value);
      }
      if (payload.value === void 0) return payload;
      return def.innerType._zod.run(payload, ctx);
    };
  });
  var $ZodExactOptional = /* @__PURE__ */ $constructor('$ZodExactOptional', (inst, def) => {
    $ZodOptional.init(inst, def);
    defineLazy(inst._zod, 'values', () => def.innerType._zod.values);
    defineLazy(inst._zod, 'pattern', () => def.innerType._zod.pattern);
    inst._zod.parse = (payload, ctx) => {
      return def.innerType._zod.run(payload, ctx);
    };
  });
  var $ZodNullable = /* @__PURE__ */ $constructor('$ZodNullable', (inst, def) => {
    $ZodType.init(inst, def);
    defineLazy(inst._zod, 'optin', () => def.innerType._zod.optin);
    defineLazy(inst._zod, 'optout', () => def.innerType._zod.optout);
    defineLazy(inst._zod, 'pattern', () => {
      const pattern = def.innerType._zod.pattern;
      return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
    });
    defineLazy(inst._zod, 'values', () => {
      return def.innerType._zod.values ? new Set([...def.innerType._zod.values, null]) : void 0;
    });
    inst._zod.parse = (payload, ctx) => {
      if (payload.value === null) return payload;
      return def.innerType._zod.run(payload, ctx);
    };
  });
  var $ZodDefault = /* @__PURE__ */ $constructor('$ZodDefault', (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.optin = 'optional';
    defineLazy(inst._zod, 'values', () => def.innerType._zod.values);
    inst._zod.parse = (payload, ctx) => {
      if (ctx.direction === 'backward') return def.innerType._zod.run(payload, ctx);
      if (payload.value === void 0) {
        payload.value = def.defaultValue;
        /**
         * $ZodDefault returns the default value immediately in forward direction.
         * It doesn't pass the default value into the validator ("prefault"). There's no reason to pass the default value through validation. The validity of the default is enforced by TypeScript statically. Otherwise, it's the responsibility of the user to ensure the default is valid. In the case of pipes with divergent in/out types, you can specify the default on the `in` schema of your ZodPipe to set a "prefault" for the pipe.   */
        return payload;
      }
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise)
        return result.then((result) => handleDefaultResult(result, def));
      return handleDefaultResult(result, def);
    };
  });
  function handleDefaultResult(payload, def) {
    if (payload.value === void 0) payload.value = def.defaultValue;
    return payload;
  }
  var $ZodPrefault = /* @__PURE__ */ $constructor('$ZodPrefault', (inst, def) => {
    $ZodType.init(inst, def);
    inst._zod.optin = 'optional';
    defineLazy(inst._zod, 'values', () => def.innerType._zod.values);
    inst._zod.parse = (payload, ctx) => {
      if (ctx.direction === 'backward') return def.innerType._zod.run(payload, ctx);
      if (payload.value === void 0) payload.value = def.defaultValue;
      return def.innerType._zod.run(payload, ctx);
    };
  });
  var $ZodNonOptional = /* @__PURE__ */ $constructor('$ZodNonOptional', (inst, def) => {
    $ZodType.init(inst, def);
    defineLazy(inst._zod, 'values', () => {
      const v = def.innerType._zod.values;
      return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
    });
    inst._zod.parse = (payload, ctx) => {
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise)
        return result.then((result) => handleNonOptionalResult(result, inst));
      return handleNonOptionalResult(result, inst);
    };
  });
  function handleNonOptionalResult(payload, inst) {
    if (!payload.issues.length && payload.value === void 0)
      payload.issues.push({
        code: 'invalid_type',
        expected: 'nonoptional',
        input: payload.value,
        inst,
      });
    return payload;
  }
  var $ZodCatch = /* @__PURE__ */ $constructor('$ZodCatch', (inst, def) => {
    $ZodType.init(inst, def);
    defineLazy(inst._zod, 'optin', () => def.innerType._zod.optin);
    defineLazy(inst._zod, 'optout', () => def.innerType._zod.optout);
    defineLazy(inst._zod, 'values', () => def.innerType._zod.values);
    inst._zod.parse = (payload, ctx) => {
      if (ctx.direction === 'backward') return def.innerType._zod.run(payload, ctx);
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise)
        return result.then((result) => {
          payload.value = result.value;
          if (result.issues.length) {
            payload.value = def.catchValue({
              ...payload,
              error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
              input: payload.value,
            });
            payload.issues = [];
          }
          return payload;
        });
      payload.value = result.value;
      if (result.issues.length) {
        payload.value = def.catchValue({
          ...payload,
          error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
          input: payload.value,
        });
        payload.issues = [];
      }
      return payload;
    };
  });
  var $ZodPipe = /* @__PURE__ */ $constructor('$ZodPipe', (inst, def) => {
    $ZodType.init(inst, def);
    defineLazy(inst._zod, 'values', () => def.in._zod.values);
    defineLazy(inst._zod, 'optin', () => def.in._zod.optin);
    defineLazy(inst._zod, 'optout', () => def.out._zod.optout);
    defineLazy(inst._zod, 'propValues', () => def.in._zod.propValues);
    inst._zod.parse = (payload, ctx) => {
      if (ctx.direction === 'backward') {
        const right = def.out._zod.run(payload, ctx);
        if (right instanceof Promise)
          return right.then((right) => handlePipeResult(right, def.in, ctx));
        return handlePipeResult(right, def.in, ctx);
      }
      const left = def.in._zod.run(payload, ctx);
      if (left instanceof Promise) return left.then((left) => handlePipeResult(left, def.out, ctx));
      return handlePipeResult(left, def.out, ctx);
    };
  });
  function handlePipeResult(left, next, ctx) {
    if (left.issues.length) {
      left.aborted = true;
      return left;
    }
    return next._zod.run(
      {
        value: left.value,
        issues: left.issues,
      },
      ctx,
    );
  }
  var $ZodReadonly = /* @__PURE__ */ $constructor('$ZodReadonly', (inst, def) => {
    $ZodType.init(inst, def);
    defineLazy(inst._zod, 'propValues', () => def.innerType._zod.propValues);
    defineLazy(inst._zod, 'values', () => def.innerType._zod.values);
    defineLazy(inst._zod, 'optin', () => def.innerType?._zod?.optin);
    defineLazy(inst._zod, 'optout', () => def.innerType?._zod?.optout);
    inst._zod.parse = (payload, ctx) => {
      if (ctx.direction === 'backward') return def.innerType._zod.run(payload, ctx);
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise) return result.then(handleReadonlyResult);
      return handleReadonlyResult(result);
    };
  });
  function handleReadonlyResult(payload) {
    payload.value = Object.freeze(payload.value);
    return payload;
  }
  var $ZodCustom = /* @__PURE__ */ $constructor('$ZodCustom', (inst, def) => {
    $ZodCheck.init(inst, def);
    $ZodType.init(inst, def);
    inst._zod.parse = (payload, _) => {
      return payload;
    };
    inst._zod.check = (payload) => {
      const input = payload.value;
      const r = def.fn(input);
      if (r instanceof Promise) return r.then((r) => handleRefineResult(r, payload, input, inst));
      handleRefineResult(r, payload, input, inst);
    };
  });
  function handleRefineResult(result, payload, input, inst) {
    if (!result) {
      const _iss = {
        code: 'custom',
        input,
        inst,
        path: [...(inst._zod.def.path ?? [])],
        continue: !inst._zod.def.abort,
      };
      if (inst._zod.def.params) _iss.params = inst._zod.def.params;
      payload.issues.push(issue(_iss));
    }
  }
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/core/registries.js
  var _a;
  var $ZodRegistry = class {
    constructor() {
      this._map = /* @__PURE__ */ new WeakMap();
      this._idmap = /* @__PURE__ */ new Map();
    }
    add(schema, ..._meta) {
      const meta = _meta[0];
      this._map.set(schema, meta);
      if (meta && typeof meta === 'object' && 'id' in meta) this._idmap.set(meta.id, schema);
      return this;
    }
    clear() {
      this._map = /* @__PURE__ */ new WeakMap();
      this._idmap = /* @__PURE__ */ new Map();
      return this;
    }
    remove(schema) {
      const meta = this._map.get(schema);
      if (meta && typeof meta === 'object' && 'id' in meta) this._idmap.delete(meta.id);
      this._map.delete(schema);
      return this;
    }
    get(schema) {
      const p = schema._zod.parent;
      if (p) {
        const pm = { ...(this.get(p) ?? {}) };
        delete pm.id;
        const f = {
          ...pm,
          ...this._map.get(schema),
        };
        return Object.keys(f).length ? f : void 0;
      }
      return this._map.get(schema);
    }
    has(schema) {
      return this._map.has(schema);
    }
  };
  function registry() {
    return new $ZodRegistry();
  }
  (_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry());
  var globalRegistry = globalThis.__zod_globalRegistry;
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/core/api.js
  /* @__NO_SIDE_EFFECTS__ */
  function _string(Class, params) {
    return new Class({
      type: 'string',
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _email(Class, params) {
    return new Class({
      type: 'string',
      format: 'email',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _guid(Class, params) {
    return new Class({
      type: 'string',
      format: 'guid',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _uuid(Class, params) {
    return new Class({
      type: 'string',
      format: 'uuid',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _uuidv4(Class, params) {
    return new Class({
      type: 'string',
      format: 'uuid',
      check: 'string_format',
      abort: false,
      version: 'v4',
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _uuidv6(Class, params) {
    return new Class({
      type: 'string',
      format: 'uuid',
      check: 'string_format',
      abort: false,
      version: 'v6',
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _uuidv7(Class, params) {
    return new Class({
      type: 'string',
      format: 'uuid',
      check: 'string_format',
      abort: false,
      version: 'v7',
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _url(Class, params) {
    return new Class({
      type: 'string',
      format: 'url',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _emoji(Class, params) {
    return new Class({
      type: 'string',
      format: 'emoji',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _nanoid(Class, params) {
    return new Class({
      type: 'string',
      format: 'nanoid',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _cuid(Class, params) {
    return new Class({
      type: 'string',
      format: 'cuid',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _cuid2(Class, params) {
    return new Class({
      type: 'string',
      format: 'cuid2',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _ulid(Class, params) {
    return new Class({
      type: 'string',
      format: 'ulid',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _xid(Class, params) {
    return new Class({
      type: 'string',
      format: 'xid',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _ksuid(Class, params) {
    return new Class({
      type: 'string',
      format: 'ksuid',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _ipv4(Class, params) {
    return new Class({
      type: 'string',
      format: 'ipv4',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _ipv6(Class, params) {
    return new Class({
      type: 'string',
      format: 'ipv6',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _cidrv4(Class, params) {
    return new Class({
      type: 'string',
      format: 'cidrv4',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _cidrv6(Class, params) {
    return new Class({
      type: 'string',
      format: 'cidrv6',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _base64(Class, params) {
    return new Class({
      type: 'string',
      format: 'base64',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _base64url(Class, params) {
    return new Class({
      type: 'string',
      format: 'base64url',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _e164(Class, params) {
    return new Class({
      type: 'string',
      format: 'e164',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _jwt(Class, params) {
    return new Class({
      type: 'string',
      format: 'jwt',
      check: 'string_format',
      abort: false,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _isoDateTime(Class, params) {
    return new Class({
      type: 'string',
      format: 'datetime',
      check: 'string_format',
      offset: false,
      local: false,
      precision: null,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _isoDate(Class, params) {
    return new Class({
      type: 'string',
      format: 'date',
      check: 'string_format',
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _isoTime(Class, params) {
    return new Class({
      type: 'string',
      format: 'time',
      check: 'string_format',
      precision: null,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _isoDuration(Class, params) {
    return new Class({
      type: 'string',
      format: 'duration',
      check: 'string_format',
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _number(Class, params) {
    return new Class({
      type: 'number',
      checks: [],
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _int(Class, params) {
    return new Class({
      type: 'number',
      check: 'number_format',
      abort: false,
      format: 'safeint',
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _boolean(Class, params) {
    return new Class({
      type: 'boolean',
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _unknown(Class) {
    return new Class({ type: 'unknown' });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _never(Class, params) {
    return new Class({
      type: 'never',
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _lt(value, params) {
    return new $ZodCheckLessThan({
      check: 'less_than',
      ...normalizeParams(params),
      value,
      inclusive: false,
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _lte(value, params) {
    return new $ZodCheckLessThan({
      check: 'less_than',
      ...normalizeParams(params),
      value,
      inclusive: true,
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _gt(value, params) {
    return new $ZodCheckGreaterThan({
      check: 'greater_than',
      ...normalizeParams(params),
      value,
      inclusive: false,
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _gte(value, params) {
    return new $ZodCheckGreaterThan({
      check: 'greater_than',
      ...normalizeParams(params),
      value,
      inclusive: true,
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _multipleOf(value, params) {
    return new $ZodCheckMultipleOf({
      check: 'multiple_of',
      ...normalizeParams(params),
      value,
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _maxLength(maximum, params) {
    return new $ZodCheckMaxLength({
      check: 'max_length',
      ...normalizeParams(params),
      maximum,
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _minLength(minimum, params) {
    return new $ZodCheckMinLength({
      check: 'min_length',
      ...normalizeParams(params),
      minimum,
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _length(length, params) {
    return new $ZodCheckLengthEquals({
      check: 'length_equals',
      ...normalizeParams(params),
      length,
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _regex(pattern, params) {
    return new $ZodCheckRegex({
      check: 'string_format',
      format: 'regex',
      ...normalizeParams(params),
      pattern,
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _lowercase(params) {
    return new $ZodCheckLowerCase({
      check: 'string_format',
      format: 'lowercase',
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _uppercase(params) {
    return new $ZodCheckUpperCase({
      check: 'string_format',
      format: 'uppercase',
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _includes(includes, params) {
    return new $ZodCheckIncludes({
      check: 'string_format',
      format: 'includes',
      ...normalizeParams(params),
      includes,
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _startsWith(prefix, params) {
    return new $ZodCheckStartsWith({
      check: 'string_format',
      format: 'starts_with',
      ...normalizeParams(params),
      prefix,
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _endsWith(suffix, params) {
    return new $ZodCheckEndsWith({
      check: 'string_format',
      format: 'ends_with',
      ...normalizeParams(params),
      suffix,
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _overwrite(tx) {
    return new $ZodCheckOverwrite({
      check: 'overwrite',
      tx,
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _normalize(form) {
    return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _trim() {
    return /* @__PURE__ */ _overwrite((input) => input.trim());
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _toLowerCase() {
    return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _toUpperCase() {
    return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _slugify() {
    return /* @__PURE__ */ _overwrite((input) => slugify(input));
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _array(Class, element, params) {
    return new Class({
      type: 'array',
      element,
      ...normalizeParams(params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _refine(Class, fn, _params) {
    return new Class({
      type: 'custom',
      check: 'custom',
      fn,
      ...normalizeParams(_params),
    });
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _superRefine(fn) {
    const ch = /* @__PURE__ */ _check((payload) => {
      payload.addIssue = (issue$2) => {
        if (typeof issue$2 === 'string')
          payload.issues.push(issue(issue$2, payload.value, ch._zod.def));
        else {
          const _issue = issue$2;
          if (_issue.fatal) _issue.continue = false;
          _issue.code ?? (_issue.code = 'custom');
          _issue.input ?? (_issue.input = payload.value);
          _issue.inst ?? (_issue.inst = ch);
          _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
          payload.issues.push(issue(_issue));
        }
      };
      return fn(payload.value, payload);
    });
    return ch;
  }
  /* @__NO_SIDE_EFFECTS__ */
  function _check(fn, params) {
    const ch = new $ZodCheck({
      check: 'custom',
      ...normalizeParams(params),
    });
    ch._zod.check = fn;
    return ch;
  }
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/core/to-json-schema.js
  function initializeContext(params) {
    let target = params?.target ?? 'draft-2020-12';
    if (target === 'draft-4') target = 'draft-04';
    if (target === 'draft-7') target = 'draft-07';
    return {
      processors: params.processors ?? {},
      metadataRegistry: params?.metadata ?? globalRegistry,
      target,
      unrepresentable: params?.unrepresentable ?? 'throw',
      override: params?.override ?? (() => {}),
      io: params?.io ?? 'output',
      counter: 0,
      seen: /* @__PURE__ */ new Map(),
      cycles: params?.cycles ?? 'ref',
      reused: params?.reused ?? 'inline',
      external: params?.external ?? void 0,
    };
  }
  function process(
    schema,
    ctx,
    _params = {
      path: [],
      schemaPath: [],
    },
  ) {
    var _a;
    const def = schema._zod.def;
    const seen = ctx.seen.get(schema);
    if (seen) {
      seen.count++;
      if (_params.schemaPath.includes(schema)) seen.cycle = _params.path;
      return seen.schema;
    }
    const result = {
      schema: {},
      count: 1,
      cycle: void 0,
      path: _params.path,
    };
    ctx.seen.set(schema, result);
    const overrideSchema = schema._zod.toJSONSchema?.();
    if (overrideSchema) result.schema = overrideSchema;
    else {
      const params = {
        ..._params,
        schemaPath: [..._params.schemaPath, schema],
        path: _params.path,
      };
      if (schema._zod.processJSONSchema) schema._zod.processJSONSchema(ctx, result.schema, params);
      else {
        const _json = result.schema;
        const processor = ctx.processors[def.type];
        if (!processor)
          throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
        processor(schema, ctx, _json, params);
      }
      const parent = schema._zod.parent;
      if (parent) {
        if (!result.ref) result.ref = parent;
        process(parent, ctx, params);
        ctx.seen.get(parent).isParent = true;
      }
    }
    const meta = ctx.metadataRegistry.get(schema);
    if (meta) Object.assign(result.schema, meta);
    if (ctx.io === 'input' && isTransforming(schema)) {
      delete result.schema.examples;
      delete result.schema.default;
    }
    if (ctx.io === 'input' && result.schema._prefault)
      (_a = result.schema).default ?? (_a.default = result.schema._prefault);
    delete result.schema._prefault;
    return ctx.seen.get(schema).schema;
  }
  function extractDefs(ctx, schema) {
    const root = ctx.seen.get(schema);
    if (!root) throw new Error('Unprocessed schema. This is a bug in Zod.');
    const idToSchema = /* @__PURE__ */ new Map();
    for (const entry of ctx.seen.entries()) {
      const id = ctx.metadataRegistry.get(entry[0])?.id;
      if (id) {
        const existing = idToSchema.get(id);
        if (existing && existing !== entry[0])
          throw new Error(
            `Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`,
          );
        idToSchema.set(id, entry[0]);
      }
    }
    const makeURI = (entry) => {
      const defsSegment = ctx.target === 'draft-2020-12' ? '$defs' : 'definitions';
      if (ctx.external) {
        const externalId = ctx.external.registry.get(entry[0])?.id;
        const uriGenerator = ctx.external.uri ?? ((id) => id);
        if (externalId) return { ref: uriGenerator(externalId) };
        const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
        entry[1].defId = id;
        return {
          defId: id,
          ref: `${uriGenerator('__shared')}#/${defsSegment}/${id}`,
        };
      }
      if (entry[1] === root) return { ref: '#' };
      const defUriPrefix = `#/${defsSegment}/`;
      const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
      return {
        defId,
        ref: defUriPrefix + defId,
      };
    };
    const extractToDef = (entry) => {
      if (entry[1].schema.$ref) return;
      const seen = entry[1];
      const { ref, defId } = makeURI(entry);
      seen.def = { ...seen.schema };
      if (defId) seen.defId = defId;
      const schema = seen.schema;
      for (const key in schema) delete schema[key];
      schema.$ref = ref;
    };
    if (ctx.cycles === 'throw')
      for (const entry of ctx.seen.entries()) {
        const seen = entry[1];
        if (seen.cycle)
          throw new Error(`Cycle detected: #/${seen.cycle?.join('/')}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
      }
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (schema === entry[0]) {
        extractToDef(entry);
        continue;
      }
      if (ctx.external) {
        const ext = ctx.external.registry.get(entry[0])?.id;
        if (schema !== entry[0] && ext) {
          extractToDef(entry);
          continue;
        }
      }
      if (ctx.metadataRegistry.get(entry[0])?.id) {
        extractToDef(entry);
        continue;
      }
      if (seen.cycle) {
        extractToDef(entry);
        continue;
      }
      if (seen.count > 1) {
        if (ctx.reused === 'ref') {
          extractToDef(entry);
          continue;
        }
      }
    }
  }
  function finalize(ctx, schema) {
    const root = ctx.seen.get(schema);
    if (!root) throw new Error('Unprocessed schema. This is a bug in Zod.');
    const flattenRef = (zodSchema) => {
      const seen = ctx.seen.get(zodSchema);
      if (seen.ref === null) return;
      const schema = seen.def ?? seen.schema;
      const _cached = { ...schema };
      const ref = seen.ref;
      seen.ref = null;
      if (ref) {
        flattenRef(ref);
        const refSeen = ctx.seen.get(ref);
        const refSchema = refSeen.schema;
        if (
          refSchema.$ref &&
          (ctx.target === 'draft-07' || ctx.target === 'draft-04' || ctx.target === 'openapi-3.0')
        ) {
          schema.allOf = schema.allOf ?? [];
          schema.allOf.push(refSchema);
        } else Object.assign(schema, refSchema);
        Object.assign(schema, _cached);
        if (zodSchema._zod.parent === ref)
          for (const key in schema) {
            if (key === '$ref' || key === 'allOf') continue;
            if (!(key in _cached)) delete schema[key];
          }
        if (refSchema.$ref && refSeen.def)
          for (const key in schema) {
            if (key === '$ref' || key === 'allOf') continue;
            if (
              key in refSeen.def &&
              JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])
            )
              delete schema[key];
          }
      }
      const parent = zodSchema._zod.parent;
      if (parent && parent !== ref) {
        flattenRef(parent);
        const parentSeen = ctx.seen.get(parent);
        if (parentSeen?.schema.$ref) {
          schema.$ref = parentSeen.schema.$ref;
          if (parentSeen.def)
            for (const key in schema) {
              if (key === '$ref' || key === 'allOf') continue;
              if (
                key in parentSeen.def &&
                JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])
              )
                delete schema[key];
            }
        }
      }
      ctx.override({
        zodSchema,
        jsonSchema: schema,
        path: seen.path ?? [],
      });
    };
    for (const entry of [...ctx.seen.entries()].reverse()) flattenRef(entry[0]);
    const result = {};
    if (ctx.target === 'draft-2020-12')
      result.$schema = 'https://json-schema.org/draft/2020-12/schema';
    else if (ctx.target === 'draft-07') result.$schema = 'http://json-schema.org/draft-07/schema#';
    else if (ctx.target === 'draft-04') result.$schema = 'http://json-schema.org/draft-04/schema#';
    else if (ctx.target === 'openapi-3.0');
    if (ctx.external?.uri) {
      const id = ctx.external.registry.get(schema)?.id;
      if (!id) throw new Error('Schema is missing an `id` property');
      result.$id = ctx.external.uri(id);
    }
    Object.assign(result, root.def ?? root.schema);
    const defs = ctx.external?.defs ?? {};
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.def && seen.defId) defs[seen.defId] = seen.def;
    }
    if (ctx.external);
    else if (Object.keys(defs).length > 0)
      if (ctx.target === 'draft-2020-12') result.$defs = defs;
      else result.definitions = defs;
    try {
      const finalized = JSON.parse(JSON.stringify(result));
      Object.defineProperty(finalized, '~standard', {
        value: {
          ...schema['~standard'],
          jsonSchema: {
            input: createStandardJSONSchemaMethod(schema, 'input', ctx.processors),
            output: createStandardJSONSchemaMethod(schema, 'output', ctx.processors),
          },
        },
        enumerable: false,
        writable: false,
      });
      return finalized;
    } catch (_err) {
      throw new Error('Error converting schema to JSON.');
    }
  }
  function isTransforming(_schema, _ctx) {
    const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
    if (ctx.seen.has(_schema)) return false;
    ctx.seen.add(_schema);
    const def = _schema._zod.def;
    if (def.type === 'transform') return true;
    if (def.type === 'array') return isTransforming(def.element, ctx);
    if (def.type === 'set') return isTransforming(def.valueType, ctx);
    if (def.type === 'lazy') return isTransforming(def.getter(), ctx);
    if (
      def.type === 'promise' ||
      def.type === 'optional' ||
      def.type === 'nonoptional' ||
      def.type === 'nullable' ||
      def.type === 'readonly' ||
      def.type === 'default' ||
      def.type === 'prefault'
    )
      return isTransforming(def.innerType, ctx);
    if (def.type === 'intersection')
      return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
    if (def.type === 'record' || def.type === 'map')
      return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
    if (def.type === 'pipe') return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
    if (def.type === 'object') {
      for (const key in def.shape) if (isTransforming(def.shape[key], ctx)) return true;
      return false;
    }
    if (def.type === 'union') {
      for (const option of def.options) if (isTransforming(option, ctx)) return true;
      return false;
    }
    if (def.type === 'tuple') {
      for (const item of def.items) if (isTransforming(item, ctx)) return true;
      if (def.rest && isTransforming(def.rest, ctx)) return true;
      return false;
    }
    return false;
  }
  /**
   * Creates a toJSONSchema method for a schema instance.
   * This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
   */
  var createToJSONSchemaMethod =
    (schema, processors = {}) =>
    (params) => {
      const ctx = initializeContext({
        ...params,
        processors,
      });
      process(schema, ctx);
      extractDefs(ctx, schema);
      return finalize(ctx, schema);
    };
  var createStandardJSONSchemaMethod =
    (schema, io, processors = {}) =>
    (params) => {
      const { libraryOptions, target } = params ?? {};
      const ctx = initializeContext({
        ...(libraryOptions ?? {}),
        target,
        io,
        processors,
      });
      process(schema, ctx);
      extractDefs(ctx, schema);
      return finalize(ctx, schema);
    };
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/core/json-schema-processors.js
  var formatMap = {
    guid: 'uuid',
    url: 'uri',
    datetime: 'date-time',
    json_string: 'json-string',
    regex: '',
  };
  var stringProcessor = (schema, ctx, _json, _params) => {
    const json = _json;
    json.type = 'string';
    const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
    if (typeof minimum === 'number') json.minLength = minimum;
    if (typeof maximum === 'number') json.maxLength = maximum;
    if (format) {
      json.format = formatMap[format] ?? format;
      if (json.format === '') delete json.format;
      if (format === 'time') delete json.format;
    }
    if (contentEncoding) json.contentEncoding = contentEncoding;
    if (patterns && patterns.size > 0) {
      const regexes = [...patterns];
      if (regexes.length === 1) json.pattern = regexes[0].source;
      else if (regexes.length > 1)
        json.allOf = [
          ...regexes.map((regex) => ({
            ...(ctx.target === 'draft-07' ||
            ctx.target === 'draft-04' ||
            ctx.target === 'openapi-3.0'
              ? { type: 'string' }
              : {}),
            pattern: regex.source,
          })),
        ];
    }
  };
  var numberProcessor = (schema, ctx, _json, _params) => {
    const json = _json;
    const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } =
      schema._zod.bag;
    if (typeof format === 'string' && format.includes('int')) json.type = 'integer';
    else json.type = 'number';
    if (typeof exclusiveMinimum === 'number')
      if (ctx.target === 'draft-04' || ctx.target === 'openapi-3.0') {
        json.minimum = exclusiveMinimum;
        json.exclusiveMinimum = true;
      } else json.exclusiveMinimum = exclusiveMinimum;
    if (typeof minimum === 'number') {
      json.minimum = minimum;
      if (typeof exclusiveMinimum === 'number' && ctx.target !== 'draft-04')
        if (exclusiveMinimum >= minimum) delete json.minimum;
        else delete json.exclusiveMinimum;
    }
    if (typeof exclusiveMaximum === 'number')
      if (ctx.target === 'draft-04' || ctx.target === 'openapi-3.0') {
        json.maximum = exclusiveMaximum;
        json.exclusiveMaximum = true;
      } else json.exclusiveMaximum = exclusiveMaximum;
    if (typeof maximum === 'number') {
      json.maximum = maximum;
      if (typeof exclusiveMaximum === 'number' && ctx.target !== 'draft-04')
        if (exclusiveMaximum <= maximum) delete json.maximum;
        else delete json.exclusiveMaximum;
    }
    if (typeof multipleOf === 'number') json.multipleOf = multipleOf;
  };
  var booleanProcessor = (_schema, _ctx, json, _params) => {
    json.type = 'boolean';
  };
  var neverProcessor = (_schema, _ctx, json, _params) => {
    json.not = {};
  };
  var unknownProcessor = (_schema, _ctx, _json, _params) => {};
  var enumProcessor = (schema, _ctx, json, _params) => {
    const def = schema._zod.def;
    const values = getEnumValues(def.entries);
    if (values.every((v) => typeof v === 'number')) json.type = 'number';
    if (values.every((v) => typeof v === 'string')) json.type = 'string';
    json.enum = values;
  };
  var customProcessor = (_schema, ctx, _json, _params) => {
    if (ctx.unrepresentable === 'throw')
      throw new Error('Custom types cannot be represented in JSON Schema');
  };
  var transformProcessor = (_schema, ctx, _json, _params) => {
    if (ctx.unrepresentable === 'throw')
      throw new Error('Transforms cannot be represented in JSON Schema');
  };
  var arrayProcessor = (schema, ctx, _json, params) => {
    const json = _json;
    const def = schema._zod.def;
    const { minimum, maximum } = schema._zod.bag;
    if (typeof minimum === 'number') json.minItems = minimum;
    if (typeof maximum === 'number') json.maxItems = maximum;
    json.type = 'array';
    json.items = process(def.element, ctx, {
      ...params,
      path: [...params.path, 'items'],
    });
  };
  var objectProcessor = (schema, ctx, _json, params) => {
    const json = _json;
    const def = schema._zod.def;
    json.type = 'object';
    json.properties = {};
    const shape = def.shape;
    for (const key in shape)
      json.properties[key] = process(shape[key], ctx, {
        ...params,
        path: [...params.path, 'properties', key],
      });
    const allKeys = new Set(Object.keys(shape));
    const requiredKeys = new Set(
      [...allKeys].filter((key) => {
        const v = def.shape[key]._zod;
        if (ctx.io === 'input') return v.optin === void 0;
        else return v.optout === void 0;
      }),
    );
    if (requiredKeys.size > 0) json.required = Array.from(requiredKeys);
    if (def.catchall?._zod.def.type === 'never') json.additionalProperties = false;
    else if (!def.catchall) {
      if (ctx.io === 'output') json.additionalProperties = false;
    } else if (def.catchall)
      json.additionalProperties = process(def.catchall, ctx, {
        ...params,
        path: [...params.path, 'additionalProperties'],
      });
  };
  var unionProcessor = (schema, ctx, json, params) => {
    const def = schema._zod.def;
    const isExclusive = def.inclusive === false;
    const options = def.options.map((x, i) =>
      process(x, ctx, {
        ...params,
        path: [...params.path, isExclusive ? 'oneOf' : 'anyOf', i],
      }),
    );
    if (isExclusive) json.oneOf = options;
    else json.anyOf = options;
  };
  var intersectionProcessor = (schema, ctx, json, params) => {
    const def = schema._zod.def;
    const a = process(def.left, ctx, {
      ...params,
      path: [...params.path, 'allOf', 0],
    });
    const b = process(def.right, ctx, {
      ...params,
      path: [...params.path, 'allOf', 1],
    });
    const isSimpleIntersection = (val) => 'allOf' in val && Object.keys(val).length === 1;
    json.allOf = [
      ...(isSimpleIntersection(a) ? a.allOf : [a]),
      ...(isSimpleIntersection(b) ? b.allOf : [b]),
    ];
  };
  var recordProcessor = (schema, ctx, _json, params) => {
    const json = _json;
    const def = schema._zod.def;
    json.type = 'object';
    const keyType = def.keyType;
    const patterns = keyType._zod.bag?.patterns;
    if (def.mode === 'loose' && patterns && patterns.size > 0) {
      const valueSchema = process(def.valueType, ctx, {
        ...params,
        path: [...params.path, 'patternProperties', '*'],
      });
      json.patternProperties = {};
      for (const pattern of patterns) json.patternProperties[pattern.source] = valueSchema;
    } else {
      if (ctx.target === 'draft-07' || ctx.target === 'draft-2020-12')
        json.propertyNames = process(def.keyType, ctx, {
          ...params,
          path: [...params.path, 'propertyNames'],
        });
      json.additionalProperties = process(def.valueType, ctx, {
        ...params,
        path: [...params.path, 'additionalProperties'],
      });
    }
    const keyValues = keyType._zod.values;
    if (keyValues) {
      const validKeyValues = [...keyValues].filter(
        (v) => typeof v === 'string' || typeof v === 'number',
      );
      if (validKeyValues.length > 0) json.required = validKeyValues;
    }
  };
  var nullableProcessor = (schema, ctx, json, params) => {
    const def = schema._zod.def;
    const inner = process(def.innerType, ctx, params);
    const seen = ctx.seen.get(schema);
    if (ctx.target === 'openapi-3.0') {
      seen.ref = def.innerType;
      json.nullable = true;
    } else json.anyOf = [inner, { type: 'null' }];
  };
  var nonoptionalProcessor = (schema, ctx, _json, params) => {
    const def = schema._zod.def;
    process(def.innerType, ctx, params);
    const seen = ctx.seen.get(schema);
    seen.ref = def.innerType;
  };
  var defaultProcessor = (schema, ctx, json, params) => {
    const def = schema._zod.def;
    process(def.innerType, ctx, params);
    const seen = ctx.seen.get(schema);
    seen.ref = def.innerType;
    json.default = JSON.parse(JSON.stringify(def.defaultValue));
  };
  var prefaultProcessor = (schema, ctx, json, params) => {
    const def = schema._zod.def;
    process(def.innerType, ctx, params);
    const seen = ctx.seen.get(schema);
    seen.ref = def.innerType;
    if (ctx.io === 'input') json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
  };
  var catchProcessor = (schema, ctx, json, params) => {
    const def = schema._zod.def;
    process(def.innerType, ctx, params);
    const seen = ctx.seen.get(schema);
    seen.ref = def.innerType;
    let catchValue;
    try {
      catchValue = def.catchValue(void 0);
    } catch {
      throw new Error('Dynamic catch values are not supported in JSON Schema');
    }
    json.default = catchValue;
  };
  var pipeProcessor = (schema, ctx, _json, params) => {
    const def = schema._zod.def;
    const innerType =
      ctx.io === 'input' ? (def.in._zod.def.type === 'transform' ? def.out : def.in) : def.out;
    process(innerType, ctx, params);
    const seen = ctx.seen.get(schema);
    seen.ref = innerType;
  };
  var readonlyProcessor = (schema, ctx, json, params) => {
    const def = schema._zod.def;
    process(def.innerType, ctx, params);
    const seen = ctx.seen.get(schema);
    seen.ref = def.innerType;
    json.readOnly = true;
  };
  var optionalProcessor = (schema, ctx, _json, params) => {
    const def = schema._zod.def;
    process(def.innerType, ctx, params);
    const seen = ctx.seen.get(schema);
    seen.ref = def.innerType;
  };
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/classic/iso.js
  var ZodISODateTime = /* @__PURE__ */ $constructor('ZodISODateTime', (inst, def) => {
    $ZodISODateTime.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  function datetime(params) {
    return /* @__PURE__ */ _isoDateTime(ZodISODateTime, params);
  }
  var ZodISODate = /* @__PURE__ */ $constructor('ZodISODate', (inst, def) => {
    $ZodISODate.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  function date(params) {
    return /* @__PURE__ */ _isoDate(ZodISODate, params);
  }
  var ZodISOTime = /* @__PURE__ */ $constructor('ZodISOTime', (inst, def) => {
    $ZodISOTime.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  function time(params) {
    return /* @__PURE__ */ _isoTime(ZodISOTime, params);
  }
  var ZodISODuration = /* @__PURE__ */ $constructor('ZodISODuration', (inst, def) => {
    $ZodISODuration.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  function duration(params) {
    return /* @__PURE__ */ _isoDuration(ZodISODuration, params);
  }
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/classic/errors.js
  var initializer = (inst, issues) => {
    $ZodError.init(inst, issues);
    inst.name = 'ZodError';
    Object.defineProperties(inst, {
      format: { value: (mapper) => formatError(inst, mapper) },
      flatten: { value: (mapper) => flattenError(inst, mapper) },
      addIssue: {
        value: (issue) => {
          inst.issues.push(issue);
          inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
        },
      },
      addIssues: {
        value: (issues) => {
          inst.issues.push(...issues);
          inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
        },
      },
      isEmpty: {
        get() {
          return inst.issues.length === 0;
        },
      },
    });
  };
  $constructor('ZodError', initializer);
  var ZodRealError = $constructor('ZodError', initializer, { Parent: Error });
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/classic/parse.js
  var parse = /* @__PURE__ */ _parse(ZodRealError);
  var parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
  var safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
  var safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
  var encode = /* @__PURE__ */ _encode(ZodRealError);
  var decode = /* @__PURE__ */ _decode(ZodRealError);
  var encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
  var decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
  var safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
  var safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
  var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
  var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);
  //#endregion
  //#region ../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/classic/schemas.js
  var ZodType = /* @__PURE__ */ $constructor('ZodType', (inst, def) => {
    $ZodType.init(inst, def);
    Object.assign(inst['~standard'], {
      jsonSchema: {
        input: createStandardJSONSchemaMethod(inst, 'input'),
        output: createStandardJSONSchemaMethod(inst, 'output'),
      },
    });
    inst.toJSONSchema = createToJSONSchemaMethod(inst, {});
    inst.def = def;
    inst.type = def.type;
    Object.defineProperty(inst, '_def', { value: def });
    inst.check = (...checks) => {
      return inst.clone(
        mergeDefs(def, {
          checks: [
            ...(def.checks ?? []),
            ...checks.map((ch) =>
              typeof ch === 'function'
                ? {
                    _zod: {
                      check: ch,
                      def: { check: 'custom' },
                      onattach: [],
                    },
                  }
                : ch,
            ),
          ],
        }),
        { parent: true },
      );
    };
    inst.with = inst.check;
    inst.clone = (def, params) => clone(inst, def, params);
    inst.brand = () => inst;
    inst.register = (reg, meta) => {
      reg.add(inst, meta);
      return inst;
    };
    inst.parse = (data, params) => parse(inst, data, params, { callee: inst.parse });
    inst.safeParse = (data, params) => safeParse(inst, data, params);
    inst.parseAsync = async (data, params) =>
      parseAsync(inst, data, params, { callee: inst.parseAsync });
    inst.safeParseAsync = async (data, params) => safeParseAsync(inst, data, params);
    inst.spa = inst.safeParseAsync;
    inst.encode = (data, params) => encode(inst, data, params);
    inst.decode = (data, params) => decode(inst, data, params);
    inst.encodeAsync = async (data, params) => encodeAsync(inst, data, params);
    inst.decodeAsync = async (data, params) => decodeAsync(inst, data, params);
    inst.safeEncode = (data, params) => safeEncode(inst, data, params);
    inst.safeDecode = (data, params) => safeDecode(inst, data, params);
    inst.safeEncodeAsync = async (data, params) => safeEncodeAsync(inst, data, params);
    inst.safeDecodeAsync = async (data, params) => safeDecodeAsync(inst, data, params);
    inst.refine = (check, params) => inst.check(refine(check, params));
    inst.superRefine = (refinement) => inst.check(superRefine(refinement));
    inst.overwrite = (fn) => inst.check(/* @__PURE__ */ _overwrite(fn));
    inst.optional = () => optional(inst);
    inst.exactOptional = () => exactOptional(inst);
    inst.nullable = () => nullable(inst);
    inst.nullish = () => optional(nullable(inst));
    inst.nonoptional = (params) => nonoptional(inst, params);
    inst.array = () => array(inst);
    inst.or = (arg) => union([inst, arg]);
    inst.and = (arg) => intersection(inst, arg);
    inst.transform = (tx) => pipe(inst, transform(tx));
    inst.default = (def) => _default(inst, def);
    inst.prefault = (def) => prefault(inst, def);
    inst.catch = (params) => _catch(inst, params);
    inst.pipe = (target) => pipe(inst, target);
    inst.readonly = () => readonly(inst);
    inst.describe = (description) => {
      const cl = inst.clone();
      globalRegistry.add(cl, { description });
      return cl;
    };
    Object.defineProperty(inst, 'description', {
      get() {
        return globalRegistry.get(inst)?.description;
      },
      configurable: true,
    });
    inst.meta = (...args) => {
      if (args.length === 0) return globalRegistry.get(inst);
      const cl = inst.clone();
      globalRegistry.add(cl, args[0]);
      return cl;
    };
    inst.isOptional = () => inst.safeParse(void 0).success;
    inst.isNullable = () => inst.safeParse(null).success;
    inst.apply = (fn) => fn(inst);
    return inst;
  });
  /** @internal */
  var _ZodString = /* @__PURE__ */ $constructor('_ZodString', (inst, def) => {
    $ZodString.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json);
    const bag = inst._zod.bag;
    inst.format = bag.format ?? null;
    inst.minLength = bag.minimum ?? null;
    inst.maxLength = bag.maximum ?? null;
    inst.regex = (...args) => inst.check(/* @__PURE__ */ _regex(...args));
    inst.includes = (...args) => inst.check(/* @__PURE__ */ _includes(...args));
    inst.startsWith = (...args) => inst.check(/* @__PURE__ */ _startsWith(...args));
    inst.endsWith = (...args) => inst.check(/* @__PURE__ */ _endsWith(...args));
    inst.min = (...args) => inst.check(/* @__PURE__ */ _minLength(...args));
    inst.max = (...args) => inst.check(/* @__PURE__ */ _maxLength(...args));
    inst.length = (...args) => inst.check(/* @__PURE__ */ _length(...args));
    inst.nonempty = (...args) => inst.check(/* @__PURE__ */ _minLength(1, ...args));
    inst.lowercase = (params) => inst.check(/* @__PURE__ */ _lowercase(params));
    inst.uppercase = (params) => inst.check(/* @__PURE__ */ _uppercase(params));
    inst.trim = () => inst.check(/* @__PURE__ */ _trim());
    inst.normalize = (...args) => inst.check(/* @__PURE__ */ _normalize(...args));
    inst.toLowerCase = () => inst.check(/* @__PURE__ */ _toLowerCase());
    inst.toUpperCase = () => inst.check(/* @__PURE__ */ _toUpperCase());
    inst.slugify = () => inst.check(/* @__PURE__ */ _slugify());
  });
  var ZodString = /* @__PURE__ */ $constructor('ZodString', (inst, def) => {
    $ZodString.init(inst, def);
    _ZodString.init(inst, def);
    inst.email = (params) => inst.check(/* @__PURE__ */ _email(ZodEmail, params));
    inst.url = (params) => inst.check(/* @__PURE__ */ _url(ZodURL, params));
    inst.jwt = (params) => inst.check(/* @__PURE__ */ _jwt(ZodJWT, params));
    inst.emoji = (params) => inst.check(/* @__PURE__ */ _emoji(ZodEmoji, params));
    inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
    inst.uuid = (params) => inst.check(/* @__PURE__ */ _uuid(ZodUUID, params));
    inst.uuidv4 = (params) => inst.check(/* @__PURE__ */ _uuidv4(ZodUUID, params));
    inst.uuidv6 = (params) => inst.check(/* @__PURE__ */ _uuidv6(ZodUUID, params));
    inst.uuidv7 = (params) => inst.check(/* @__PURE__ */ _uuidv7(ZodUUID, params));
    inst.nanoid = (params) => inst.check(/* @__PURE__ */ _nanoid(ZodNanoID, params));
    inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
    inst.cuid = (params) => inst.check(/* @__PURE__ */ _cuid(ZodCUID, params));
    inst.cuid2 = (params) => inst.check(/* @__PURE__ */ _cuid2(ZodCUID2, params));
    inst.ulid = (params) => inst.check(/* @__PURE__ */ _ulid(ZodULID, params));
    inst.base64 = (params) => inst.check(/* @__PURE__ */ _base64(ZodBase64, params));
    inst.base64url = (params) => inst.check(/* @__PURE__ */ _base64url(ZodBase64URL, params));
    inst.xid = (params) => inst.check(/* @__PURE__ */ _xid(ZodXID, params));
    inst.ksuid = (params) => inst.check(/* @__PURE__ */ _ksuid(ZodKSUID, params));
    inst.ipv4 = (params) => inst.check(/* @__PURE__ */ _ipv4(ZodIPv4, params));
    inst.ipv6 = (params) => inst.check(/* @__PURE__ */ _ipv6(ZodIPv6, params));
    inst.cidrv4 = (params) => inst.check(/* @__PURE__ */ _cidrv4(ZodCIDRv4, params));
    inst.cidrv6 = (params) => inst.check(/* @__PURE__ */ _cidrv6(ZodCIDRv6, params));
    inst.e164 = (params) => inst.check(/* @__PURE__ */ _e164(ZodE164, params));
    inst.datetime = (params) => inst.check(datetime(params));
    inst.date = (params) => inst.check(date(params));
    inst.time = (params) => inst.check(time(params));
    inst.duration = (params) => inst.check(duration(params));
  });
  function string(params) {
    return /* @__PURE__ */ _string(ZodString, params);
  }
  var ZodStringFormat = /* @__PURE__ */ $constructor('ZodStringFormat', (inst, def) => {
    $ZodStringFormat.init(inst, def);
    _ZodString.init(inst, def);
  });
  var ZodEmail = /* @__PURE__ */ $constructor('ZodEmail', (inst, def) => {
    $ZodEmail.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodGUID = /* @__PURE__ */ $constructor('ZodGUID', (inst, def) => {
    $ZodGUID.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodUUID = /* @__PURE__ */ $constructor('ZodUUID', (inst, def) => {
    $ZodUUID.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodURL = /* @__PURE__ */ $constructor('ZodURL', (inst, def) => {
    $ZodURL.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodEmoji = /* @__PURE__ */ $constructor('ZodEmoji', (inst, def) => {
    $ZodEmoji.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodNanoID = /* @__PURE__ */ $constructor('ZodNanoID', (inst, def) => {
    $ZodNanoID.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodCUID = /* @__PURE__ */ $constructor('ZodCUID', (inst, def) => {
    $ZodCUID.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodCUID2 = /* @__PURE__ */ $constructor('ZodCUID2', (inst, def) => {
    $ZodCUID2.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodULID = /* @__PURE__ */ $constructor('ZodULID', (inst, def) => {
    $ZodULID.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodXID = /* @__PURE__ */ $constructor('ZodXID', (inst, def) => {
    $ZodXID.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodKSUID = /* @__PURE__ */ $constructor('ZodKSUID', (inst, def) => {
    $ZodKSUID.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodIPv4 = /* @__PURE__ */ $constructor('ZodIPv4', (inst, def) => {
    $ZodIPv4.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodIPv6 = /* @__PURE__ */ $constructor('ZodIPv6', (inst, def) => {
    $ZodIPv6.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodCIDRv4 = /* @__PURE__ */ $constructor('ZodCIDRv4', (inst, def) => {
    $ZodCIDRv4.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodCIDRv6 = /* @__PURE__ */ $constructor('ZodCIDRv6', (inst, def) => {
    $ZodCIDRv6.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodBase64 = /* @__PURE__ */ $constructor('ZodBase64', (inst, def) => {
    $ZodBase64.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodBase64URL = /* @__PURE__ */ $constructor('ZodBase64URL', (inst, def) => {
    $ZodBase64URL.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodE164 = /* @__PURE__ */ $constructor('ZodE164', (inst, def) => {
    $ZodE164.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodJWT = /* @__PURE__ */ $constructor('ZodJWT', (inst, def) => {
    $ZodJWT.init(inst, def);
    ZodStringFormat.init(inst, def);
  });
  var ZodNumber = /* @__PURE__ */ $constructor('ZodNumber', (inst, def) => {
    $ZodNumber.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json);
    inst.gt = (value, params) => inst.check(/* @__PURE__ */ _gt(value, params));
    inst.gte = (value, params) => inst.check(/* @__PURE__ */ _gte(value, params));
    inst.min = (value, params) => inst.check(/* @__PURE__ */ _gte(value, params));
    inst.lt = (value, params) => inst.check(/* @__PURE__ */ _lt(value, params));
    inst.lte = (value, params) => inst.check(/* @__PURE__ */ _lte(value, params));
    inst.max = (value, params) => inst.check(/* @__PURE__ */ _lte(value, params));
    inst.int = (params) => inst.check(int(params));
    inst.safe = (params) => inst.check(int(params));
    inst.positive = (params) => inst.check(/* @__PURE__ */ _gt(0, params));
    inst.nonnegative = (params) => inst.check(/* @__PURE__ */ _gte(0, params));
    inst.negative = (params) => inst.check(/* @__PURE__ */ _lt(0, params));
    inst.nonpositive = (params) => inst.check(/* @__PURE__ */ _lte(0, params));
    inst.multipleOf = (value, params) => inst.check(/* @__PURE__ */ _multipleOf(value, params));
    inst.step = (value, params) => inst.check(/* @__PURE__ */ _multipleOf(value, params));
    inst.finite = () => inst;
    const bag = inst._zod.bag;
    inst.minValue =
      Math.max(
        bag.minimum ?? Number.NEGATIVE_INFINITY,
        bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY,
      ) ?? null;
    inst.maxValue =
      Math.min(
        bag.maximum ?? Number.POSITIVE_INFINITY,
        bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY,
      ) ?? null;
    inst.isInt = (bag.format ?? '').includes('int') || Number.isSafeInteger(bag.multipleOf ?? 0.5);
    inst.isFinite = true;
    inst.format = bag.format ?? null;
  });
  function number(params) {
    return /* @__PURE__ */ _number(ZodNumber, params);
  }
  var ZodNumberFormat = /* @__PURE__ */ $constructor('ZodNumberFormat', (inst, def) => {
    $ZodNumberFormat.init(inst, def);
    ZodNumber.init(inst, def);
  });
  function int(params) {
    return /* @__PURE__ */ _int(ZodNumberFormat, params);
  }
  var ZodBoolean = /* @__PURE__ */ $constructor('ZodBoolean', (inst, def) => {
    $ZodBoolean.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json);
  });
  function boolean(params) {
    return /* @__PURE__ */ _boolean(ZodBoolean, params);
  }
  var ZodUnknown = /* @__PURE__ */ $constructor('ZodUnknown', (inst, def) => {
    $ZodUnknown.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => unknownProcessor();
  });
  function unknown() {
    return /* @__PURE__ */ _unknown(ZodUnknown);
  }
  var ZodNever = /* @__PURE__ */ $constructor('ZodNever', (inst, def) => {
    $ZodNever.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json);
  });
  function never(params) {
    return /* @__PURE__ */ _never(ZodNever, params);
  }
  var ZodArray = /* @__PURE__ */ $constructor('ZodArray', (inst, def) => {
    $ZodArray.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
    inst.element = def.element;
    inst.min = (minLength, params) => inst.check(/* @__PURE__ */ _minLength(minLength, params));
    inst.nonempty = (params) => inst.check(/* @__PURE__ */ _minLength(1, params));
    inst.max = (maxLength, params) => inst.check(/* @__PURE__ */ _maxLength(maxLength, params));
    inst.length = (len, params) => inst.check(/* @__PURE__ */ _length(len, params));
    inst.unwrap = () => inst.element;
  });
  function array(element, params) {
    return /* @__PURE__ */ _array(ZodArray, element, params);
  }
  var ZodObject = /* @__PURE__ */ $constructor('ZodObject', (inst, def) => {
    $ZodObjectJIT.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
    defineLazy(inst, 'shape', () => {
      return def.shape;
    });
    inst.keyof = () => _enum(Object.keys(inst._zod.def.shape));
    inst.catchall = (catchall) =>
      inst.clone({
        ...inst._zod.def,
        catchall,
      });
    inst.passthrough = () =>
      inst.clone({
        ...inst._zod.def,
        catchall: unknown(),
      });
    inst.loose = () =>
      inst.clone({
        ...inst._zod.def,
        catchall: unknown(),
      });
    inst.strict = () =>
      inst.clone({
        ...inst._zod.def,
        catchall: never(),
      });
    inst.strip = () =>
      inst.clone({
        ...inst._zod.def,
        catchall: void 0,
      });
    inst.extend = (incoming) => {
      return extend(inst, incoming);
    };
    inst.safeExtend = (incoming) => {
      return safeExtend(inst, incoming);
    };
    inst.merge = (other) => merge(inst, other);
    inst.pick = (mask) => pick(inst, mask);
    inst.omit = (mask) => omit(inst, mask);
    inst.partial = (...args) => partial(ZodOptional, inst, args[0]);
    inst.required = (...args) => required(ZodNonOptional, inst, args[0]);
  });
  function object(shape, params) {
    return new ZodObject({
      type: 'object',
      shape: shape ?? {},
      ...normalizeParams(params),
    });
  }
  var ZodUnion = /* @__PURE__ */ $constructor('ZodUnion', (inst, def) => {
    $ZodUnion.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
    inst.options = def.options;
  });
  function union(options, params) {
    return new ZodUnion({
      type: 'union',
      options,
      ...normalizeParams(params),
    });
  }
  var ZodIntersection = /* @__PURE__ */ $constructor('ZodIntersection', (inst, def) => {
    $ZodIntersection.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) =>
      intersectionProcessor(inst, ctx, json, params);
  });
  function intersection(left, right) {
    return new ZodIntersection({
      type: 'intersection',
      left,
      right,
    });
  }
  var ZodRecord = /* @__PURE__ */ $constructor('ZodRecord', (inst, def) => {
    $ZodRecord.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
    inst.keyType = def.keyType;
    inst.valueType = def.valueType;
  });
  function record(keyType, valueType, params) {
    return new ZodRecord({
      type: 'record',
      keyType,
      valueType,
      ...normalizeParams(params),
    });
  }
  var ZodEnum = /* @__PURE__ */ $constructor('ZodEnum', (inst, def) => {
    $ZodEnum.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json);
    inst.enum = def.entries;
    inst.options = Object.values(def.entries);
    const keys = new Set(Object.keys(def.entries));
    inst.extract = (values, params) => {
      const newEntries = {};
      for (const value of values)
        if (keys.has(value)) newEntries[value] = def.entries[value];
        else throw new Error(`Key ${value} not found in enum`);
      return new ZodEnum({
        ...def,
        checks: [],
        ...normalizeParams(params),
        entries: newEntries,
      });
    };
    inst.exclude = (values, params) => {
      const newEntries = { ...def.entries };
      for (const value of values)
        if (keys.has(value)) delete newEntries[value];
        else throw new Error(`Key ${value} not found in enum`);
      return new ZodEnum({
        ...def,
        checks: [],
        ...normalizeParams(params),
        entries: newEntries,
      });
    };
  });
  function _enum(values, params) {
    return new ZodEnum({
      type: 'enum',
      entries: Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values,
      ...normalizeParams(params),
    });
  }
  var ZodTransform = /* @__PURE__ */ $constructor('ZodTransform', (inst, def) => {
    $ZodTransform.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx);
    inst._zod.parse = (payload, _ctx) => {
      if (_ctx.direction === 'backward') throw new $ZodEncodeError(inst.constructor.name);
      payload.addIssue = (issue$1) => {
        if (typeof issue$1 === 'string') payload.issues.push(issue(issue$1, payload.value, def));
        else {
          const _issue = issue$1;
          if (_issue.fatal) _issue.continue = false;
          _issue.code ?? (_issue.code = 'custom');
          _issue.input ?? (_issue.input = payload.value);
          _issue.inst ?? (_issue.inst = inst);
          payload.issues.push(issue(_issue));
        }
      };
      const output = def.transform(payload.value, payload);
      if (output instanceof Promise)
        return output.then((output) => {
          payload.value = output;
          return payload;
        });
      payload.value = output;
      return payload;
    };
  });
  function transform(fn) {
    return new ZodTransform({
      type: 'transform',
      transform: fn,
    });
  }
  var ZodOptional = /* @__PURE__ */ $constructor('ZodOptional', (inst, def) => {
    $ZodOptional.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
    inst.unwrap = () => inst._zod.def.innerType;
  });
  function optional(innerType) {
    return new ZodOptional({
      type: 'optional',
      innerType,
    });
  }
  var ZodExactOptional = /* @__PURE__ */ $constructor('ZodExactOptional', (inst, def) => {
    $ZodExactOptional.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
    inst.unwrap = () => inst._zod.def.innerType;
  });
  function exactOptional(innerType) {
    return new ZodExactOptional({
      type: 'optional',
      innerType,
    });
  }
  var ZodNullable = /* @__PURE__ */ $constructor('ZodNullable', (inst, def) => {
    $ZodNullable.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
    inst.unwrap = () => inst._zod.def.innerType;
  });
  function nullable(innerType) {
    return new ZodNullable({
      type: 'nullable',
      innerType,
    });
  }
  var ZodDefault = /* @__PURE__ */ $constructor('ZodDefault', (inst, def) => {
    $ZodDefault.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
    inst.unwrap = () => inst._zod.def.innerType;
    inst.removeDefault = inst.unwrap;
  });
  function _default(innerType, defaultValue) {
    return new ZodDefault({
      type: 'default',
      innerType,
      get defaultValue() {
        return typeof defaultValue === 'function' ? defaultValue() : shallowClone(defaultValue);
      },
    });
  }
  var ZodPrefault = /* @__PURE__ */ $constructor('ZodPrefault', (inst, def) => {
    $ZodPrefault.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
    inst.unwrap = () => inst._zod.def.innerType;
  });
  function prefault(innerType, defaultValue) {
    return new ZodPrefault({
      type: 'prefault',
      innerType,
      get defaultValue() {
        return typeof defaultValue === 'function' ? defaultValue() : shallowClone(defaultValue);
      },
    });
  }
  var ZodNonOptional = /* @__PURE__ */ $constructor('ZodNonOptional', (inst, def) => {
    $ZodNonOptional.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) =>
      nonoptionalProcessor(inst, ctx, json, params);
    inst.unwrap = () => inst._zod.def.innerType;
  });
  function nonoptional(innerType, params) {
    return new ZodNonOptional({
      type: 'nonoptional',
      innerType,
      ...normalizeParams(params),
    });
  }
  var ZodCatch = /* @__PURE__ */ $constructor('ZodCatch', (inst, def) => {
    $ZodCatch.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
    inst.unwrap = () => inst._zod.def.innerType;
    inst.removeCatch = inst.unwrap;
  });
  function _catch(innerType, catchValue) {
    return new ZodCatch({
      type: 'catch',
      innerType,
      catchValue: typeof catchValue === 'function' ? catchValue : () => catchValue,
    });
  }
  var ZodPipe = /* @__PURE__ */ $constructor('ZodPipe', (inst, def) => {
    $ZodPipe.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
    inst.in = def.in;
    inst.out = def.out;
  });
  function pipe(in_, out) {
    return new ZodPipe({
      type: 'pipe',
      in: in_,
      out,
    });
  }
  var ZodReadonly = /* @__PURE__ */ $constructor('ZodReadonly', (inst, def) => {
    $ZodReadonly.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
    inst.unwrap = () => inst._zod.def.innerType;
  });
  function readonly(innerType) {
    return new ZodReadonly({
      type: 'readonly',
      innerType,
    });
  }
  var ZodCustom = /* @__PURE__ */ $constructor('ZodCustom', (inst, def) => {
    $ZodCustom.init(inst, def);
    ZodType.init(inst, def);
    inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx);
  });
  function refine(fn, _params = {}) {
    return /* @__PURE__ */ _refine(ZodCustom, fn, _params);
  }
  function superRefine(fn) {
    return /* @__PURE__ */ _superRefine(fn);
  }
  //#endregion
  //#region ../builtin-tools/dist/runtime-tool-names.js
  /**
   * Runtime builtin tool naming model.
   *
   * Canonical names are unified as `builtin.<category>.<action>`.
   * Bridge and extension runtimes still accept a small compatibility alias set
   * and resolve it back to the canonical name before execution.
   */
  var BUILTIN_RUNTIME_NAMESPACE = 'builtin';
  /** Semantic categories for builtin tools — each becomes a namespace in the tool tree UI. */
  var BUILTIN_CATEGORY = {
    tabs: 'tabs',
    page: 'page',
    dom: 'dom',
    console: 'console',
    input: 'input',
  };
  var BUILTIN_TOOL_SUFFIXES_BY_CATEGORY = {
    [BUILTIN_CATEGORY.tabs]: ['list_tabs', 'open_tab', 'close_tab', 'screenshot_tab'],
    [BUILTIN_CATEGORY.page]: [
      'get_page_info',
      'navigate',
      'reload',
      'go_back',
      'go_forward',
      'wait_for_navigation',
      'screenshot_page',
    ],
    [BUILTIN_CATEGORY.dom]: [
      'get_selected_text',
      'click_element',
      'scroll_into_view',
      'get_element_text',
      'get_element_html',
      'query_elements',
      'fill_input',
      'execute_js',
      'wait_for_selector',
    ],
    [BUILTIN_CATEGORY.console]: ['get_console_logs'],
    [BUILTIN_CATEGORY.input]: ['press_key', 'type_text'],
  };
  var BUILTIN_SUFFIX_TO_CATEGORIES = Object.entries(BUILTIN_TOOL_SUFFIXES_BY_CATEGORY).reduce(
    (accumulator, [category, suffixes]) => {
      for (const suffix of suffixes) {
        const categories = accumulator.get(suffix) ?? [];
        categories.push(category);
        accumulator.set(suffix, categories);
      }
      return accumulator;
    },
    /* @__PURE__ */ new Map(),
  );
  /**
   * Helper for constructing canonical runtime builtin tool names with semantic category.
   *
   * Produces names like `builtin.tabs.list_tabs`, `builtin.dom.click_element`, etc.
   */
  function builtinToolName(category, suffix) {
    return `${BUILTIN_RUNTIME_NAMESPACE}.${category}.${suffix}`;
  }
  function parseBuiltinToolName(toolName) {
    const match = /^builtin\.([^.]+)\.(.+)$/.exec(toolName);
    if (!match) return null;
    return {
      namespace: BUILTIN_RUNTIME_NAMESPACE,
      category: match[1],
      suffix: match[2],
    };
  }
  /**
   * Resolve a builtin tool alias back to its canonical `builtin.<category>.<suffix>` name.
   *
   * Supported aliases:
   * - `builtin.<category>.<suffix>` (already canonical)
   * - `builtin.<suffix>`
   * - `<suffix>`
   * - `page-context_<suffix>` (observed from flattened MCP client prefixes)
   */
  function resolveBuiltinToolNameAlias(toolName) {
    if (parseBuiltinToolName(toolName)) return toolName;
    const strippedToolName = toolName.startsWith('page-context_') ? toolName.slice(13) : toolName;
    const suffix = /^builtin\.([^.]+)$/.exec(strippedToolName)?.[1] ?? strippedToolName;
    const categories = BUILTIN_SUFFIX_TO_CATEGORIES.get(suffix);
    if (!categories || categories.length !== 1) return null;
    return builtinToolName(categories[0], suffix);
  }
  var CDP_DEBUGGER_BUILTIN_TOOL_NAMES = [
    builtinToolName(BUILTIN_CATEGORY.page, 'screenshot_page'),
    builtinToolName(BUILTIN_CATEGORY.input, 'press_key'),
    builtinToolName(BUILTIN_CATEGORY.input, 'type_text'),
  ];
  var CDP_DEBUGGER_BUILTIN_TOOL_NAME_SET = new Set(CDP_DEBUGGER_BUILTIN_TOOL_NAMES);
  function isCdpDebuggerBuiltinToolName(toolName) {
    return CDP_DEBUGGER_BUILTIN_TOOL_NAME_SET.has(toolName);
  }
  function filterBuiltinToolsByRuntimeCapabilities(
    tools,
    capabilities = detectBuiltinRuntimeCapabilities(),
  ) {
    if (capabilities.supportsChromeDebuggerCdp) return [...tools];
    return tools.filter((tool) => !isCdpDebuggerBuiltinToolName(tool.name));
  }
  function detectBuiltinRuntimeCapabilities(probe = {}) {
    const manifest = probe.manifest ?? safeGetRuntimeManifest$1();
    const userAgent = probe.userAgent ?? safeGetRuntimeUserAgent$1();
    const hasFirefoxSignal =
      detectManifestTarget$1(manifest) === 'firefox' ||
      /Firefox\/\d+/i.test(userAgent) ||
      (probe.hasBrowserRuntimeGetBrowserInfo ?? safeHasBrowserRuntimeGetBrowserInfo$1());
    const hasChromeDebuggerCdp = probe.hasChromeDebuggerCdp ?? safeHasChromeDebuggerCdp();
    if (hasFirefoxSignal)
      return {
        target: 'firefox',
        supportsChromeDebuggerCdp: false,
      };
    return {
      target: hasChromeDebuggerCdp ? 'chromium' : 'unknown',
      supportsChromeDebuggerCdp: hasChromeDebuggerCdp,
    };
  }
  function safeGetRuntimeManifest$1() {
    const maybeChrome = globalThis.chrome;
    if (!isRecord$1(maybeChrome)) return null;
    const runtime = maybeChrome.runtime;
    if (!isRecord$1(runtime) || typeof runtime.getManifest !== 'function') return null;
    try {
      const manifest = runtime.getManifest();
      return isRecord$1(manifest) ? manifest : null;
    } catch {
      return null;
    }
  }
  function safeGetRuntimeUserAgent$1() {
    const maybeNavigator = globalThis.navigator;
    if (!isRecord$1(maybeNavigator)) return '';
    return typeof maybeNavigator.userAgent === 'string' ? maybeNavigator.userAgent : '';
  }
  function safeHasChromeDebuggerCdp() {
    const maybeChrome = globalThis.chrome;
    if (!isRecord$1(maybeChrome)) return false;
    const maybeDebugger = maybeChrome.debugger;
    if (!isRecord$1(maybeDebugger)) return false;
    return (
      typeof maybeDebugger.attach === 'function' &&
      typeof maybeDebugger.detach === 'function' &&
      typeof maybeDebugger.sendCommand === 'function'
    );
  }
  function safeHasBrowserRuntimeGetBrowserInfo$1() {
    const maybeBrowser = globalThis.browser;
    if (!isRecord$1(maybeBrowser)) return false;
    const runtime = maybeBrowser.runtime;
    if (!isRecord$1(runtime)) return false;
    return typeof runtime.getBrowserInfo === 'function';
  }
  function detectManifestTarget$1(manifest) {
    if (!isRecord$1(manifest)) return 'unknown';
    const browserSpecificSettings = manifest.browser_specific_settings;
    if (isRecord$1(browserSpecificSettings) && isRecord$1(browserSpecificSettings.gecko))
      return 'firefox';
    const applications = manifest.applications;
    if (isRecord$1(applications) && isRecord$1(applications.gecko)) return 'firefox';
    return 'unknown';
  }
  function isRecord$1(value) {
    return typeof value === 'object' && value !== null;
  }
  [
    {
      name: builtinToolName(BUILTIN_CATEGORY.tabs, 'list_tabs'),
      description: 'List all open browser tabs',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.tabs, 'open_tab'),
      description: 'Open a new tab',
      inputSchema: {
        url: string(),
        active: boolean().optional(),
      },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.tabs, 'close_tab'),
      description: 'Close a tab',
      inputSchema: { tabId: number().optional() },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.tabs, 'screenshot_tab'),
      description: 'Take a screenshot of the current tab',
      inputSchema: {
        format: _enum(['png', 'jpeg']).optional(),
        quality: number().optional(),
        tabId: number().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.page, 'get_page_info'),
      description: 'Get the current page URL, title, and metadata',
      inputSchema: { tabId: number().optional() },
      annotations: { readOnlyHint: true },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.page, 'navigate'),
      description: 'Navigate the current tab to a URL',
      inputSchema: {
        url: string(),
        waitUntil: _enum(['load', 'none']).optional(),
        timeoutMs: number().optional(),
        tabId: number().optional(),
      },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.page, 'reload'),
      description: 'Reload the tab',
      inputSchema: {
        bypassCache: boolean().optional(),
        waitUntil: _enum(['load', 'none']).optional(),
        timeoutMs: number().optional(),
        tabId: number().optional(),
      },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.page, 'go_back'),
      description: 'Go back in history',
      inputSchema: {
        waitUntil: _enum(['load', 'none']).optional(),
        timeoutMs: number().optional(),
        tabId: number().optional(),
      },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.page, 'go_forward'),
      description: 'Go forward in history',
      inputSchema: {
        waitUntil: _enum(['load', 'none']).optional(),
        timeoutMs: number().optional(),
        tabId: number().optional(),
      },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.page, 'wait_for_navigation'),
      description: 'Wait for the tab navigation to complete',
      inputSchema: {
        timeoutMs: number().optional(),
        tabId: number().optional(),
      },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.page, 'screenshot_page'),
      description: 'Capture a screenshot via CDP (supports fullPage)',
      inputSchema: {
        format: _enum(['png', 'jpeg']).optional(),
        quality: number().optional(),
        fullPage: boolean().optional(),
        maxPixels: number().optional(),
        tabId: number().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'get_selected_text'),
      description: 'Get the currently selected text on the page',
      inputSchema: { tabId: number().optional() },
      annotations: { readOnlyHint: true },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'click_element'),
      description: 'Click an element on the page by CSS selector',
      inputSchema: {
        selector: string(),
        tabId: number().optional(),
      },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'scroll_into_view'),
      description: 'Scroll an element into view by CSS selector',
      inputSchema: {
        selector: string(),
        behavior: _enum(['auto', 'smooth']).optional(),
        tabId: number().optional(),
      },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'get_element_text'),
      description: 'Get text content of an element',
      inputSchema: {
        selector: string(),
        tabId: number().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'get_element_html'),
      description: 'Get outer HTML of an element',
      inputSchema: {
        selector: string(),
        tabId: number().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'query_elements'),
      description: 'Query elements by CSS selector',
      inputSchema: {
        selector: string(),
        limit: number().optional(),
        tabId: number().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'fill_input'),
      description: 'Fill an input field with a value',
      inputSchema: {
        selector: string(),
        value: string(),
        tabId: number().optional(),
      },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'execute_js'),
      description: 'Execute JavaScript expression in page context',
      inputSchema: {
        expression: string(),
        tabId: number().optional(),
      },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'wait_for_selector'),
      description: 'Wait for an element to appear',
      inputSchema: {
        selector: string(),
        state: _enum(['attached', 'visible']).optional(),
        timeoutMs: number().optional(),
        tabId: number().optional(),
      },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.console, 'get_console_logs'),
      description: 'Get recent console log entries from the page',
      inputSchema: {
        limit: number().optional(),
        level: _enum(['all', 'log', 'warn', 'error', 'info']).optional(),
        tabId: number().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.input, 'press_key'),
      description: 'Press a key via CDP',
      inputSchema: {
        key: string(),
        modifiers: array(_enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
        tabId: number().optional(),
      },
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.input, 'type_text'),
      description: 'Type text via CDP',
      inputSchema: {
        text: string(),
        tabId: number().optional(),
      },
    },
  ].reduce((counts, tool) => {
    const parsed = parseBuiltinToolName(tool.name);
    if (!parsed) return counts;
    counts.set(parsed.suffix, (counts.get(parsed.suffix) ?? 0) + 1);
    return counts;
  }, /* @__PURE__ */ new Map());
  //#endregion
  //#region ../builtin-tools/dist/content-script-tools.js
  /**
   * Sanitize a CSS selector to prevent selector injection attacks.
   * Allows tag, id, class, attribute, pseudo-class and combinators.
   * Rejects strings containing dangerous patterns.
   */
  function sanitizeSelector(selector) {
    const trimmed = (selector ?? '').trim();
    if (!trimmed) return trimmed;
    if (/[\x00-\x1f]/.test(trimmed)) return '';
    if (!/^[\w#.\-[\]()=+*'"':,>~\s]+$/.test(trimmed)) return '';
    if (trimmed.length > 500) return '';
    return trimmed;
  }
  /**
   * Execute a builtin tool in the content script context.
   * Only handles tools with executionContext === "content-script".
   */
  function executeContentScriptTool(tool, args, env) {
    const win = env.win;
    const doc = env.doc;
    const { consoleEntries } = env;
    switch (tool) {
      case 'builtin.page.get_page_info':
        return {
          url: win.location.href,
          title: doc.title,
          meta: Array.from(doc.querySelectorAll('meta'))
            .slice(0, 10)
            .map((element) => ({
              name: element.getAttribute('name') || element.getAttribute('property') || '',
              content: element.getAttribute('content') || '',
            })),
        };
      case 'builtin.dom.get_selected_text': {
        const selection = win.getSelection();
        return { text: selection ? selection.toString() : '' };
      }
      case 'builtin.dom.click_element': {
        const selector = sanitizeSelector(String(args.selector ?? ''));
        if (!selector) throw new Error(`Invalid or empty CSS selector`);
        const element = doc.querySelector(selector);
        if (!element) throw new Error(`Element not found: ${selector}`);
        element.click();
        return {
          clicked: true,
          selector,
        };
      }
      case 'builtin.dom.scroll_into_view': {
        const selector = sanitizeSelector(String(args.selector ?? ''));
        const behavior = String(args.behavior ?? 'auto');
        const element = doc.querySelector(selector);
        if (!element) throw new Error(`Element not found: ${selector}`);
        element.scrollIntoView({
          behavior: behavior === 'smooth' ? 'smooth' : 'auto',
          block: 'center',
          inline: 'center',
        });
        return {
          scrolled: true,
          selector,
        };
      }
      case 'builtin.dom.get_element_text': {
        const selector = sanitizeSelector(String(args.selector ?? ''));
        const element = doc.querySelector(selector);
        if (!element) throw new Error(`Element not found: ${selector}`);
        return {
          text: element.textContent,
          selector,
        };
      }
      case 'builtin.dom.get_element_html': {
        const selector = sanitizeSelector(String(args.selector ?? ''));
        const element = doc.querySelector(selector);
        if (!element) throw new Error(`Element not found: ${selector}`);
        const html = element.outerHTML;
        if (html.length > 5e4)
          return {
            html: `${html.slice(0, 5e4)}\n... (truncated)`,
            truncated: true,
            totalLength: html.length,
          };
        return {
          html,
          selector,
        };
      }
      case 'builtin.dom.query_elements': {
        const selector = sanitizeSelector(String(args.selector ?? ''));
        const limit = Number(args.limit ?? 20);
        const matches = Array.from(doc.querySelectorAll(selector));
        return {
          count: matches.length,
          results: matches.slice(0, limit).map((element) => ({
            tag: element.tagName.toLowerCase(),
            id: element.id || void 0,
            className: element.className || void 0,
            text: (element.textContent || '').substring(0, 200).trim(),
            attributes: Array.from(element.attributes)
              .filter((attribute) => !['class', 'id', 'style'].includes(attribute.name))
              .reduce((accumulator, attribute) => {
                accumulator[attribute.name] = attribute.value;
                return accumulator;
              }, {}),
          })),
        };
      }
      case 'builtin.dom.fill_input': {
        const selector = sanitizeSelector(String(args.selector ?? ''));
        const value = String(args.value ?? '');
        const element = doc.querySelector(selector);
        if (!element) throw new Error(`Element not found: ${selector}`);
        element.focus();
        const setter =
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(element, value);
        else element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          filled: true,
          selector,
          value,
        };
      }
      case 'builtin.dom.execute_js': {
        const expression = String(args.expression ?? '');
        const MAX_EXPR_LENGTH = 1e4;
        if (expression.length > MAX_EXPR_LENGTH)
          return {
            ok: false,
            error: `Expression too long: ${expression.length} chars (max ${MAX_EXPR_LENGTH})`,
            type: 'validation_error',
          };
        try {
          const body =
            'with(win) { with(doc) { with(consoleEntries) { return (' + expression + '); } }';
          const result = new Function('win', 'doc', 'consoleEntries', body)(
            win,
            doc,
            consoleEntries,
          );
          return {
            ok: true,
            result: typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result),
            type: typeof result,
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            type: 'execution_error',
          };
        }
      }
      case 'builtin.console.get_console_logs': {
        const limit = Number(args.limit ?? 50);
        const level = String(args.level ?? 'all');
        const filtered =
          level === 'all'
            ? consoleEntries
            : consoleEntries.filter((entry) => entry.level === level);
        return {
          entries: filtered.slice(-limit),
          total: filtered.length,
        };
      }
      case 'builtin.dom.wait_for_selector': {
        const selector = sanitizeSelector(String(args.selector ?? ''));
        const state = String(args.state ?? 'attached');
        const timeoutMs = Math.max(0, Math.floor(Number(args.timeoutMs ?? 1e4)));
        const isVisible = (element) => {
          const el = element;
          const style = win.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
            return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const check = () => {
          const element = doc.querySelector(selector);
          if (!element) return { ok: false };
          if (state === 'visible' && !isVisible(element))
            return {
              ok: false,
              element,
            };
          return {
            ok: true,
            element,
          };
        };
        if (check().ok)
          return {
            matched: true,
            selector,
            state: state === 'visible' ? 'visible' : 'attached',
          };
        return new Promise((resolve, reject) => {
          const start = Date.now();
          const tick = () => {
            const now = Date.now();
            if (check().ok) {
              resolve({
                matched: true,
                selector,
                state: state === 'visible' ? 'visible' : 'attached',
                waitedMs: now - start,
              });
              return;
            }
            if (now - start >= timeoutMs) {
              reject(
                /* @__PURE__ */ new Error(
                  `Timeout waiting for selector: ${selector} (state=${state})`,
                ),
              );
              return;
            }
            win.requestAnimationFrame(tick);
          };
          tick();
        });
      }
      default:
        throw new Error(`Unknown content-script tool: ${tool}`);
    }
  }
  //#endregion
  //#region ../builtin-tools/dist/service-worker-tools.js
  /**
   * Service-worker tool implementations.
   *
   * These tools execute in the page-context extension service worker (background)
   * where they have access to extension APIs (tabs, etc.) but not the DOM.
   */
  function isValidUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }
  function toTargetTabId(args, ctx) {
    const explicit = Number(args.tabId ?? 0);
    if (explicit) return Promise.resolve(explicit);
    return ctx.getActiveTabId().then((id) => {
      if (!id) throw new Error('No active tab available');
      return id;
    });
  }
  function normalizeWaitUntil(value) {
    return String(value ?? 'load') === 'none' ? 'none' : 'load';
  }
  function clampNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }
  function modifierMask(modifiers) {
    const list = Array.isArray(modifiers) ? modifiers.map(String) : [];
    let mask = 0;
    for (const m of list)
      switch (m) {
        case 'Alt':
          mask |= 1;
          break;
        case 'Control':
          mask |= 2;
          break;
        case 'Meta':
          mask |= 4;
          break;
        case 'Shift':
          mask |= 8;
          break;
      }
    return mask;
  }
  function keyToCdp(key) {
    const k = key;
    const hit = {
      Enter: {
        code: 'Enter',
        vk: 13,
      },
      Tab: {
        code: 'Tab',
        vk: 9,
      },
      Escape: {
        code: 'Escape',
        vk: 27,
      },
      Backspace: {
        code: 'Backspace',
        vk: 8,
      },
      Delete: {
        code: 'Delete',
        vk: 46,
      },
      ArrowUp: {
        code: 'ArrowUp',
        vk: 38,
      },
      ArrowDown: {
        code: 'ArrowDown',
        vk: 40,
      },
      ArrowLeft: {
        code: 'ArrowLeft',
        vk: 37,
      },
      ArrowRight: {
        code: 'ArrowRight',
        vk: 39,
      },
      Home: {
        code: 'Home',
        vk: 36,
      },
      End: {
        code: 'End',
        vk: 35,
      },
      PageUp: {
        code: 'PageUp',
        vk: 33,
      },
      PageDown: {
        code: 'PageDown',
        vk: 34,
      },
      Space: {
        code: 'Space',
        vk: 32,
      },
    }[k];
    if (hit)
      return {
        key: k === 'Space' ? ' ' : k,
        code: hit.code,
        windowsVirtualKeyCode: hit.vk,
        nativeVirtualKeyCode: hit.vk,
        text: k === 'Space' ? ' ' : void 0,
      };
    if (k.length === 1) {
      const ch = k;
      const upper = ch.toUpperCase();
      const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(ch) ? `Digit${ch}` : void 0;
      const vk = upper.charCodeAt(0);
      return {
        key: ch,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        text: ch,
      };
    }
    return { key: k };
  }
  /**
   * Execute a builtin tool in the service worker context.
   * Only handles tools with executionContext === "service-worker".
   */
  async function executeServiceWorkerTool(tool, args, ctx) {
    switch (tool) {
      case 'builtin.tabs.list_tabs':
        return { tabs: await ctx.listTabs() };
      case 'builtin.tabs.screenshot_tab': {
        const format = args.format ?? 'jpeg';
        const quality = clampNumber(args.quality, 70, 0, 100);
        const dataUrl = await ctx.captureVisibleTab(
          format,
          format === 'jpeg' ? Math.round(quality) : void 0,
        );
        return {
          format,
          dataUrl,
          sizeHint: dataUrl.length,
        };
      }
      case 'builtin.page.screenshot_page': {
        const tabId = await toTargetTabId(args, ctx);
        const format = args.format ?? 'jpeg';
        const quality = clampNumber(args.quality, 70, 0, 100);
        const fullPage = Boolean(args.fullPage ?? false);
        const maxPixels = clampNumber(args.maxPixels, 4e6, 1e5, 2e8);
        let clip = null;
        try {
          const metrics = await ctx.cdpSendCommand(tabId, 'Page.getLayoutMetrics');
          const contentSize = metrics?.contentSize;
          const visualViewport = metrics?.visualViewport;
          const width = Number(fullPage ? contentSize?.width : visualViewport?.clientWidth);
          const height = Number(fullPage ? contentSize?.height : visualViewport?.clientHeight);
          if (width > 0 && height > 0) {
            const pixels = width * height;
            const scale =
              pixels > maxPixels ? Math.max(0.1, Math.min(1, Math.sqrt(maxPixels / pixels))) : 1;
            if (scale < 1 || fullPage)
              clip = {
                x: 0,
                y: 0,
                width,
                height,
                scale,
              };
          }
        } catch {}
        const params = {
          format,
          fromSurface: true,
          ...(clip ? { clip } : null),
        };
        if (format === 'jpeg') params.quality = quality;
        if (fullPage) params.captureBeyondViewport = true;
        try {
          const result = await ctx.cdpSendCommand(tabId, 'Page.captureScreenshot', params);
          if (!result?.data) throw new Error('CDP Page.captureScreenshot returned no data');
          return {
            tabId,
            format,
            dataBase64: result.data,
            ...(clip
              ? {
                  scale: clip.scale,
                  maxPixels,
                }
              : null),
          };
        } catch (error) {
          if (!fullPage) throw error;
          const size = (await ctx.cdpSendCommand(tabId, 'Page.getLayoutMetrics'))?.contentSize;
          const width = Number(size?.width ?? 0);
          const height = Number(size?.height ?? 0);
          if (!width || !height) throw error;
          const clipped = await ctx.cdpSendCommand(tabId, 'Page.captureScreenshot', {
            ...params,
            clip: {
              x: 0,
              y: 0,
              width,
              height,
              scale: 1,
            },
          });
          if (!clipped?.data) throw error;
          return {
            tabId,
            format,
            dataBase64: clipped.data,
            clipped: true,
            width,
            height,
          };
        }
      }
      case 'builtin.page.navigate': {
        const targetTabId = await toTargetTabId(args, ctx);
        const url = String(args.url ?? '');
        if (!isValidUrl(url))
          return {
            ok: false,
            error: `Invalid or invalid URL: ${url}`,
            type: 'validation_error',
          };
        await ctx.navigateTab(targetTabId, url);
        const waitUntil = normalizeWaitUntil(args.waitUntil);
        const timeoutMs = Math.max(0, Math.floor(Number(args.timeoutMs ?? 15e3)));
        if (waitUntil !== 'none') await ctx.waitForTabStatus(targetTabId, 'complete', timeoutMs);
        return {
          navigating: true,
          tabId: targetTabId,
          url,
          waitUntil,
        };
      }
      case 'builtin.page.wait_for_navigation': {
        const targetTabId = await toTargetTabId(args, ctx);
        const timeoutMs = Math.max(0, Math.floor(Number(args.timeoutMs ?? 15e3)));
        await ctx.waitForTabStatus(targetTabId, 'complete', timeoutMs);
        return {
          ok: true,
          tabId: targetTabId,
          status: 'complete',
        };
      }
      case 'builtin.page.reload': {
        const targetTabId = await toTargetTabId(args, ctx);
        const bypassCache = Boolean(args.bypassCache ?? false);
        await ctx.reloadTab(targetTabId, bypassCache);
        const waitUntil = normalizeWaitUntil(args.waitUntil);
        const timeoutMs = Math.max(0, Math.floor(Number(args.timeoutMs ?? 15e3)));
        if (waitUntil !== 'none') await ctx.waitForTabStatus(targetTabId, 'complete', timeoutMs);
        return {
          reloaded: true,
          tabId: targetTabId,
          bypassCache,
          waitUntil,
        };
      }
      case 'builtin.page.go_back': {
        const targetTabId = await toTargetTabId(args, ctx);
        await ctx.goBack(targetTabId);
        const waitUntil = normalizeWaitUntil(args.waitUntil);
        const timeoutMs = Math.max(0, Math.floor(Number(args.timeoutMs ?? 15e3)));
        if (waitUntil !== 'none') await ctx.waitForTabStatus(targetTabId, 'complete', timeoutMs);
        return {
          ok: true,
          tabId: targetTabId,
          action: 'back',
          waitUntil,
        };
      }
      case 'builtin.page.go_forward': {
        const targetTabId = await toTargetTabId(args, ctx);
        await ctx.goForward(targetTabId);
        const waitUntil = normalizeWaitUntil(args.waitUntil);
        const timeoutMs = Math.max(0, Math.floor(Number(args.timeoutMs ?? 15e3)));
        if (waitUntil !== 'none') await ctx.waitForTabStatus(targetTabId, 'complete', timeoutMs);
        return {
          ok: true,
          tabId: targetTabId,
          action: 'forward',
          waitUntil,
        };
      }
      case 'builtin.tabs.open_tab': {
        const url = String(args.url ?? '');
        if (!url) throw new Error('Missing url');
        const active = args.active == null ? true : Boolean(args.active);
        return {
          opened: true,
          url,
          active,
          tabId: (await ctx.createTab(url, active)).tabId,
        };
      }
      case 'builtin.tabs.close_tab': {
        const targetTabId = await toTargetTabId(args, ctx);
        await ctx.closeTab(targetTabId);
        return {
          closed: true,
          tabId: targetTabId,
        };
      }
      case 'builtin.input.press_key': {
        const targetTabId = await toTargetTabId(args, ctx);
        const key = String(args.key ?? '');
        if (!key) throw new Error('Missing key');
        const modifiers = modifierMask(args.modifiers);
        const def = keyToCdp(key);
        await ctx.cdpSendCommand(targetTabId, 'Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          modifiers,
          ...def,
        });
        await ctx.cdpSendCommand(targetTabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          modifiers,
          ...def,
        });
        return {
          ok: true,
          tabId: targetTabId,
          key,
        };
      }
      case 'builtin.input.type_text': {
        const targetTabId = await toTargetTabId(args, ctx);
        const text = String(args.text ?? '');
        await ctx.cdpSendCommand(targetTabId, 'Input.insertText', { text });
        return {
          ok: true,
          tabId: targetTabId,
          length: text.length,
        };
      }
      default:
        throw new Error(`Unknown service-worker tool: ${tool}`);
    }
  }
  //#endregion
  //#region ../builtin-tools/dist/extension-provider.js
  /**
   * Extension-side builtin tool provider.
   *
   * Implements ExtensionToolProvider from shared-protocol.
   * Routes tool calls to the appropriate execution context
   * (content-script for DOM tools, service-worker for extension API tools).
   */
  var TOOL_DEFINITIONS = [
    {
      name: builtinToolName(BUILTIN_CATEGORY.tabs, 'list_tabs'),
      description: 'List all open browser tabs',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      annotations: { readOnlyHint: true },
      executionContext: 'service-worker',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.tabs, 'open_tab'),
      description: 'Open a new tab',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to open',
          },
          active: {
            type: 'boolean',
            description: 'Whether to activate the new tab',
          },
        },
        required: ['url'],
      },
      executionContext: 'service-worker',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.tabs, 'close_tab'),
      description: 'Close a tab',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: 'Target tab id (defaults to active)',
          },
        },
      },
      executionContext: 'service-worker',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.tabs, 'screenshot_tab'),
      description: 'Take a screenshot of the visible tab',
      inputSchema: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            description: 'png|jpeg (default: jpeg)',
          },
          quality: {
            type: 'number',
            description: 'JPEG quality (0-100, default: 70)',
          },
        },
      },
      annotations: { readOnlyHint: true },
      executionContext: 'service-worker',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.page, 'get_page_info'),
      description: 'Get the current page URL, title, and basic metadata',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      annotations: { readOnlyHint: true },
      executionContext: 'content-script',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.page, 'navigate'),
      description: 'Navigate the current tab to a URL',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: 'Target tab id (defaults to active)',
          },
          url: {
            type: 'string',
            description: 'URL to navigate to',
          },
          waitUntil: {
            type: 'string',
            description: 'load|none',
          },
          timeoutMs: {
            type: 'number',
            description: 'Timeout in milliseconds',
          },
        },
        required: ['url'],
      },
      executionContext: 'service-worker',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.page, 'reload'),
      description: 'Reload the current tab',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: 'Target tab id (defaults to active)',
          },
          bypassCache: {
            type: 'boolean',
            description: 'Force reload from network',
          },
          waitUntil: {
            type: 'string',
            description: 'load|none',
          },
          timeoutMs: {
            type: 'number',
            description: 'Timeout in milliseconds',
          },
        },
      },
      executionContext: 'service-worker',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.page, 'go_back'),
      description: 'Go back in history',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: 'Target tab id (defaults to active)',
          },
          waitUntil: {
            type: 'string',
            description: 'load|none',
          },
          timeoutMs: {
            type: 'number',
            description: 'Timeout in milliseconds',
          },
        },
      },
      executionContext: 'service-worker',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.page, 'go_forward'),
      description: 'Go forward in history',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: 'Target tab id (defaults to active)',
          },
          waitUntil: {
            type: 'string',
            description: 'load|none',
          },
          timeoutMs: {
            type: 'number',
            description: 'Timeout in milliseconds',
          },
        },
      },
      executionContext: 'service-worker',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.page, 'wait_for_navigation'),
      description: 'Wait for current tab navigation to complete',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: 'Target tab id (defaults to active)',
          },
          timeoutMs: {
            type: 'number',
            description: 'Timeout in milliseconds',
          },
        },
      },
      executionContext: 'service-worker',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.page, 'screenshot_page'),
      description: 'Capture a page screenshot via CDP (supports fullPage)',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: 'Target tab id (defaults to active)',
          },
          format: {
            type: 'string',
            description: 'png|jpeg (default: jpeg)',
          },
          quality: {
            type: 'number',
            description: 'JPEG quality (0-100, default: 70)',
          },
          fullPage: {
            type: 'boolean',
            description: 'Capture beyond viewport',
          },
          maxPixels: {
            type: 'number',
            description: 'Max pixel budget for auto downscale (default: 4000000)',
          },
        },
      },
      annotations: { readOnlyHint: true },
      executionContext: 'service-worker',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'get_selected_text'),
      description: 'Get the currently selected text on the page',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      annotations: { readOnlyHint: true },
      executionContext: 'content-script',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'click_element'),
      description: 'Click an element on the page by CSS selector',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector of the element to click',
          },
        },
        required: ['selector'],
      },
      executionContext: 'content-script',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'scroll_into_view'),
      description: 'Scroll an element into view by CSS selector',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector',
          },
          behavior: {
            type: 'string',
            description: 'Scroll behavior: auto|smooth',
          },
        },
        required: ['selector'],
      },
      executionContext: 'content-script',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'get_element_text'),
      description: 'Get the text content of an element by CSS selector',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector of the element',
          },
        },
        required: ['selector'],
      },
      annotations: { readOnlyHint: true },
      executionContext: 'content-script',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'get_element_html'),
      description: 'Get the outer HTML of an element by CSS selector',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector of the element',
          },
        },
        required: ['selector'],
      },
      annotations: { readOnlyHint: true },
      executionContext: 'content-script',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'query_elements'),
      description: 'Query multiple elements and return summary info',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector',
          },
          limit: {
            type: 'number',
            description: 'Max results',
          },
        },
        required: ['selector'],
      },
      annotations: { readOnlyHint: true },
      executionContext: 'content-script',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'fill_input'),
      description: 'Fill an input field with a value',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector',
          },
          value: {
            type: 'string',
            description: 'New value',
          },
        },
        required: ['selector', 'value'],
      },
      executionContext: 'content-script',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'execute_js'),
      description: 'Execute JavaScript in the page context',
      inputSchema: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'JavaScript expression',
          },
        },
        required: ['expression'],
      },
      executionContext: 'content-script',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.dom, 'wait_for_selector'),
      description: 'Wait for an element to appear (and optionally become visible)',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector',
          },
          state: {
            type: 'string',
            description: 'attached|visible',
          },
          timeoutMs: {
            type: 'number',
            description: 'Timeout in milliseconds',
          },
        },
        required: ['selector'],
      },
      executionContext: 'content-script',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.console, 'get_console_logs'),
      description: 'Get recent console log entries from the page',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max entries',
          },
          level: {
            type: 'string',
            description: 'Log level',
          },
        },
      },
      annotations: { readOnlyHint: true },
      executionContext: 'content-script',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.input, 'press_key'),
      description: 'Press a keyboard key via CDP (focused element)',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: 'Target tab id (defaults to active)',
          },
          key: {
            type: 'string',
            description: 'Key name, e.g. Enter, Tab, ArrowDown, a',
          },
          modifiers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Modifier keys: Alt|Control|Meta|Shift',
          },
        },
        required: ['key'],
      },
      executionContext: 'service-worker',
    },
    {
      name: builtinToolName(BUILTIN_CATEGORY.input, 'type_text'),
      description: 'Type text via CDP (focused element)',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: 'Target tab id (defaults to active)',
          },
          text: {
            type: 'string',
            description: 'Text to insert',
          },
        },
        required: ['text'],
      },
      executionContext: 'service-worker',
    },
  ];
  var BuiltinExtensionProvider = class {
    id = 'builtin';
    getToolDefinitions() {
      return filterBuiltinToolsByRuntimeCapabilities(TOOL_DEFINITIONS);
    }
    executeInContentScript(tool, args, env) {
      return executeContentScriptTool(tool, args, env);
    }
    async executeInServiceWorker(tool, args, ctx) {
      return await executeServiceWorkerTool(tool, args, ctx);
    }
  };
  //#endregion
  //#region ../builtin-tools/dist/extension-control-bridge-provider.js
  /**
   * Bridge-side provider for extension control tools.
   *
   * These tools execute locally on the bridge side for managing tool tree enable/disable states
   * and actively refreshing page tools.
   * Names follow the `extension.*` namespace pattern.
   */
  function createTextResponse$1(text) {
    return {
      content: [
        {
          type: 'text',
          text,
        },
      ],
    };
  }
  var EXTENSION_CONTROL_TOOL_SUFFIXES = {
    getRuntimeStatus: 'get_runtime_status',
    reconnect: 'reconnect',
    getContextManifestDebug: 'get_context_manifest_debug',
    getToolTree: 'get_tool_tree',
    setToolsEnabled: 'set_tools_enabled',
    refreshPageTools: 'refresh_page_tools',
    prepareTabForDebug: 'prepare_tab_for_debug',
    toolDebugCall: 'tool_debug_call',
    ensureMainWorldHost: 'ensure_main_world_host',
    ensureAgentationMain: 'ensure_agentation_main',
  };
  var pageToolEnableUpdateSchema = object({
    root: _enum(['builtin', 'page']).optional(),
    tabId: number().int().positive().optional(),
    namespace: string().trim().min(1).optional(),
    instanceId: string().trim().min(1).optional(),
    toolName: string().trim().min(1).optional(),
    enabled: boolean(),
  });
  var ExtensionControlBridgeProvider = class {
    id = 'extension-control';
    namespace;
    constructor(options = {}) {
      this.namespace = options.namespace ?? 'extension';
    }
    getToolNames() {
      return {
        getRuntimeStatus: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.getRuntimeStatus}`,
        reconnect: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.reconnect}`,
        getContextManifestDebug: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.getContextManifestDebug}`,
        getToolTree: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.getToolTree}`,
        setToolsEnabled: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.setToolsEnabled}`,
        refreshPageTools: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.refreshPageTools}`,
        prepareTabForDebug: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.prepareTabForDebug}`,
        toolDebugCall: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.toolDebugCall}`,
        ensureMainWorldHost: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.ensureMainWorldHost}`,
        ensureAgentationMain: `${this.namespace}.${EXTENSION_CONTROL_TOOL_SUFFIXES.ensureAgentationMain}`,
      };
    }
    registerOnBridge(registerTool, rpc) {
      const handles = /* @__PURE__ */ new Map();
      const names = this.getToolNames();
      const register = (name, config, handler) => {
        handles.set(name, registerTool(name, config, handler));
      };
      const getToolTreeConfig = {
        description: 'Read extension tool tree (builtin + page tools) with enabled counters.',
        inputSchema: {},
      };
      const getRuntimeStatusConfig = {
        description: 'Read extension runtime status (ws/session/in-flight diagnostics).',
        inputSchema: {},
      };
      const reconnectConfig = {
        description:
          'Ask extension service worker to force reconnect its bridge websocket session.',
        inputSchema: {},
      };
      const getContextManifestDebugConfig = {
        description: 'Read one tab context manifest with raw/debug filter details from extension.',
        inputSchema: { tabId: number().int().positive() },
      };
      const setToolsEnabledConfig = {
        description:
          'Batch set enable state for builtin/page tool scopes and return updated tool tree.',
        inputSchema: { updates: array(pageToolEnableUpdateSchema).min(1) },
      };
      const refreshPageToolsConfig = {
        description: "Force extension to rediscover one tab's page tools and sync bridge registry.",
        inputSchema: { tabId: number().int().positive() },
      };
      const prepareTabForDebugConfig = {
        description:
          'Prepare one tab for debug flow: ensure injections, refresh tools, and optionally re-enable read-only tools.',
        inputSchema: {
          tabId: number().int().positive(),
          frameId: number().int().nonnegative().optional(),
          enableReadOnlyPageTools: boolean().optional(),
          enableReadOnlyBuiltins: boolean().optional(),
        },
      };
      const ensureMainWorldHostConfig = {
        description: 'Ensure MAIN world bridge host script is injected on the target tab/frame.',
        inputSchema: {
          tabId: number().int().positive(),
          frameId: number().int().nonnegative().optional(),
        },
      };
      const toolDebugCallConfig = {
        description:
          'Safely call extension.tool.debug.call for enabled read-only tools only (blocks mutation/high-risk tools).',
        inputSchema: {
          toolName: string().trim().min(1),
          args: record(string(), unknown()).optional(),
          tabId: number().int().positive().optional(),
        },
      };
      const ensureAgentationMainConfig = {
        description:
          'Ensure agentation-main.js is injected into MAIN world on the target tab/frame.',
        inputSchema: {
          tabId: number().int().positive(),
          frameId: number().int().nonnegative().optional(),
        },
      };
      const getToolTreeHandler = async () => {
        const tree = await rpc.getPageToolsTree();
        return createTextResponse$1(JSON.stringify(tree, null, 2));
      };
      const getRuntimeStatusHandler = async () => {
        try {
          const status = await rpc.getRuntimeStatus();
          return createTextResponse$1(JSON.stringify(status, null, 2));
        } catch (error) {
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          );
        }
      };
      const reconnectHandler = async () => {
        try {
          const result = await rpc.reconnectExtension();
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: true,
                result,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          );
        }
      };
      const getContextManifestDebugHandler = async (args) => {
        const tabId = typeof args.tabId === 'number' ? args.tabId : NaN;
        if (!Number.isInteger(tabId) || tabId <= 0)
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: 'tabId must be a positive integer',
              },
              null,
              2,
            ),
          );
        try {
          const payload = await rpc.getContextManifestDebug(tabId);
          return createTextResponse$1(JSON.stringify(payload, null, 2));
        } catch (error) {
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                tabId,
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          );
        }
      };
      const setToolsEnabledHandler = async (args) => {
        const updates = Array.isArray(args.updates) ? args.updates : [];
        for (let index = 0; index < updates.length; index += 1)
          assertValidPageToolEnableUpdate(updates[index], index);
        const tree = await rpc.setPageToolsEnabledBatch(updates);
        return createTextResponse$1(
          JSON.stringify(
            {
              applied: updates.length,
              tree,
            },
            null,
            2,
          ),
        );
      };
      const refreshPageToolsHandler = async (args) => {
        const tabId = typeof args.tabId === 'number' ? args.tabId : NaN;
        if (!Number.isInteger(tabId) || tabId <= 0)
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: 'tabId must be a positive integer',
              },
              null,
              2,
            ),
          );
        try {
          const refreshed = await rpc.refreshPageToolsForTab(tabId);
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: true,
                tabId,
                refreshedToolCount: refreshed.tools.length,
                toolNames: refreshed.tools.map(
                  (tool) => rpc.normalizePageToolName?.(tool) ?? tool.name,
                ),
                manifestSynced: refreshed.manifest != null,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                tabId,
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          );
        }
      };
      const prepareTabForDebugHandler = async (args) => {
        const tabId = typeof args.tabId === 'number' ? args.tabId : NaN;
        const frameId = parseOptionalFrameId(args.frameId);
        const enableReadOnlyPageTools = parseOptionalBoolean(args.enableReadOnlyPageTools);
        const enableReadOnlyBuiltins = parseOptionalBoolean(args.enableReadOnlyBuiltins);
        if (!Number.isInteger(tabId) || tabId <= 0)
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: 'tabId must be a positive integer',
              },
              null,
              2,
            ),
          );
        if (args.frameId != null && frameId == null)
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: 'frameId must be a non-negative integer',
              },
              null,
              2,
            ),
          );
        if (args.enableReadOnlyPageTools != null && enableReadOnlyPageTools == null)
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: 'enableReadOnlyPageTools must be a boolean',
              },
              null,
              2,
            ),
          );
        if (args.enableReadOnlyBuiltins != null && enableReadOnlyBuiltins == null)
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: 'enableReadOnlyBuiltins must be a boolean',
              },
              null,
              2,
            ),
          );
        const failAtStep = (step, error) =>
          createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                tabId,
                frameId: frameId ?? null,
                step,
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          );
        const runtimeStatus = await rpc.getRuntimeStatus().catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
        let mainWorldHostResult;
        try {
          mainWorldHostResult = await rpc.ensureMainWorldHost(tabId, frameId);
        } catch (error) {
          return failAtStep('ensure_main_world_host', error);
        }
        let agentationMainResult;
        try {
          agentationMainResult = await rpc.ensureAgentationMain(tabId, frameId);
        } catch (error) {
          return failAtStep('ensure_agentation_main', error);
        }
        let refreshed;
        try {
          refreshed = await rpc.refreshPageToolsForTab(tabId);
        } catch (error) {
          return failAtStep('refresh_page_tools', error);
        }
        let tree;
        try {
          tree = await rpc.getPageToolsTree();
        } catch (error) {
          return failAtStep('get_tool_tree', error);
        }
        const pageToolsEnabled = enableReadOnlyPageTools ?? true;
        const builtinToolsEnabled = enableReadOnlyBuiltins ?? false;
        const updates = collectReadOnlyEnableUpdatesForPrepare(tree, {
          tabId,
          enableReadOnlyPageTools: pageToolsEnabled,
          enableReadOnlyBuiltins: builtinToolsEnabled,
        });
        let setToolsEnabledResult = null;
        if (updates.length > 0)
          try {
            setToolsEnabledResult = await rpc.setPageToolsEnabledBatch(updates);
          } catch (error) {
            return failAtStep('set_tools_enabled', error);
          }
        return createTextResponse$1(
          JSON.stringify(
            {
              ok: true,
              tabId,
              frameId: frameId ?? null,
              runtimeStatus,
              ensured: {
                mainWorldHost: mainWorldHostResult,
                agentationMain: agentationMainResult,
              },
              refreshed: {
                toolCount: refreshed.tools.length,
                toolNames: refreshed.tools.map(
                  (tool) => rpc.normalizePageToolName?.(tool) ?? tool.name,
                ),
                manifestSynced: refreshed.manifest != null,
              },
              readOnlyEnable: {
                enableReadOnlyPageTools: pageToolsEnabled,
                enableReadOnlyBuiltins: builtinToolsEnabled,
                applied: updates.length,
                updates,
                tree: setToolsEnabledResult,
              },
            },
            null,
            2,
          ),
        );
      };
      const toolDebugCallHandler = async (args) => {
        const toolName = typeof args.toolName === 'string' ? args.toolName.trim() : '';
        const tabId = parseOptionalTabId(args.tabId);
        if (!toolName)
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: 'toolName is required',
              },
              null,
              2,
            ),
          );
        if (args.tabId != null && tabId == null)
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: 'tabId must be a positive integer',
              },
              null,
              2,
            ),
          );
        if (args.args != null && !isRecord$2(args.args))
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: 'args must be an object when provided',
              },
              null,
              2,
            ),
          );
        try {
          const target = pickDebugTargetFromToolTree(await rpc.getPageToolsTree(), toolName, tabId);
          if (!target)
            return createTextResponse$1(
              JSON.stringify(
                {
                  ok: false,
                  error: `Tool '${toolName}' is not found in current extension tool tree`,
                },
                null,
                2,
              ),
            );
          if (!target.enabled)
            return createTextResponse$1(
              JSON.stringify(
                {
                  ok: false,
                  error: `Tool '${toolName}' is disabled and cannot be called via debug entry`,
                },
                null,
                2,
              ),
            );
          if (!target.readOnly)
            return createTextResponse$1(
              JSON.stringify(
                {
                  ok: false,
                  error: `Tool '${toolName}' is not read-only; extension.tool_debug_call only allows low-risk read-only tools`,
                },
                null,
                2,
              ),
            );
          const callResult = await rpc.debugToolCall(
            toolName,
            args.args ?? {},
            target.root === 'page' ? target.tabId : tabId,
          );
          return createTextResponse$1(JSON.stringify(callResult, null, 2));
        } catch (error) {
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          );
        }
      };
      const ensureMainWorldHostHandler = async (args) => {
        const tabId = typeof args.tabId === 'number' ? args.tabId : NaN;
        const frameId = parseOptionalFrameId(args.frameId);
        if (!Number.isInteger(tabId) || tabId <= 0)
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: 'tabId must be a positive integer',
              },
              null,
              2,
            ),
          );
        if (args.frameId != null && frameId == null)
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: 'frameId must be a non-negative integer',
              },
              null,
              2,
            ),
          );
        try {
          const result = await rpc.ensureMainWorldHost(tabId, frameId);
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: true,
                tabId,
                frameId: frameId ?? null,
                result,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                tabId,
                frameId: frameId ?? null,
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          );
        }
      };
      const ensureAgentationMainHandler = async (args) => {
        const tabId = typeof args.tabId === 'number' ? args.tabId : NaN;
        const frameId = parseOptionalFrameId(args.frameId);
        if (!Number.isInteger(tabId) || tabId <= 0)
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: 'tabId must be a positive integer',
              },
              null,
              2,
            ),
          );
        if (args.frameId != null && frameId == null)
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                error: 'frameId must be a non-negative integer',
              },
              null,
              2,
            ),
          );
        try {
          const result = await rpc.ensureAgentationMain(tabId, frameId);
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: true,
                tabId,
                frameId: frameId ?? null,
                result,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          return createTextResponse$1(
            JSON.stringify(
              {
                ok: false,
                tabId,
                frameId: frameId ?? null,
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          );
        }
      };
      register(names.getToolTree, getToolTreeConfig, getToolTreeHandler);
      register(names.getRuntimeStatus, getRuntimeStatusConfig, getRuntimeStatusHandler);
      register(names.reconnect, reconnectConfig, reconnectHandler);
      register(
        names.getContextManifestDebug,
        getContextManifestDebugConfig,
        getContextManifestDebugHandler,
      );
      register(names.setToolsEnabled, setToolsEnabledConfig, setToolsEnabledHandler);
      register(names.refreshPageTools, refreshPageToolsConfig, refreshPageToolsHandler);
      register(names.prepareTabForDebug, prepareTabForDebugConfig, prepareTabForDebugHandler);
      register(names.toolDebugCall, toolDebugCallConfig, toolDebugCallHandler);
      register(names.ensureMainWorldHost, ensureMainWorldHostConfig, ensureMainWorldHostHandler);
      register(names.ensureAgentationMain, ensureAgentationMainConfig, ensureAgentationMainHandler);
      return handles;
    }
  };
  function assertValidPageToolEnableUpdate(update, index) {
    if ((update.root ?? 'page') === 'page' && update.tabId == null)
      throw new Error(`updates[${index}] requires tabId when root is "page"`);
  }
  function parseOptionalFrameId(value) {
    if (value == null) return;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : void 0;
  }
  function parseOptionalTabId(value) {
    if (value == null) return;
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : void 0;
  }
  function parseOptionalBoolean(value) {
    if (value == null) return;
    return typeof value === 'boolean' ? value : void 0;
  }
  function collectReadOnlyEnableUpdatesForPrepare(tree, options) {
    if (!isRecord$2(tree)) return [];
    const updates = [];
    const seen = /* @__PURE__ */ new Set();
    const pushUniqueUpdate = (update, key) => {
      if (seen.has(key)) return;
      seen.add(key);
      updates.push(update);
    };
    if (options.enableReadOnlyBuiltins) {
      const builtinTools = collectBuiltinToolsFromTree(tree);
      for (const tool of builtinTools) {
        if (!isRecord$2(tool) || typeof tool.toolName !== 'string') continue;
        if (!tool.readOnly || tool.enabled) continue;
        pushUniqueUpdate(
          {
            root: 'builtin',
            toolName: tool.toolName,
            enabled: true,
          },
          `builtin:${tool.toolName}`,
        );
      }
    }
    if (options.enableReadOnlyPageTools && Array.isArray(tree.tabs))
      for (const tab of tree.tabs) {
        if (!isRecord$2(tab) || tab.tabId !== options.tabId) continue;
        const namespaces = Array.isArray(tab.namespaces) ? tab.namespaces : [];
        for (const namespace of namespaces) {
          if (!isRecord$2(namespace) || typeof namespace.namespace !== 'string') continue;
          const instances = Array.isArray(namespace.instances) ? namespace.instances : [];
          for (const instance of instances) {
            if (!isRecord$2(instance) || typeof instance.instanceId !== 'string') continue;
            const tools = Array.isArray(instance.tools) ? instance.tools : [];
            for (const tool of tools) {
              if (!isRecord$2(tool) || typeof tool.toolName !== 'string') continue;
              if (!tool.readOnly || tool.enabled) continue;
              pushUniqueUpdate(
                {
                  root: 'page',
                  tabId: options.tabId,
                  namespace: namespace.namespace,
                  instanceId: instance.instanceId,
                  toolName: tool.toolName,
                  enabled: true,
                },
                `page:${options.tabId}:${namespace.namespace}:${instance.instanceId}:${tool.toolName}`,
              );
            }
          }
        }
      }
    return updates;
  }
  function pickDebugTargetFromToolTree(tree, toolName, preferredTabId) {
    const builtinMatches = collectBuiltinToolMatches(
      tree,
      toolName.startsWith(`builtin.`) ? toolName : builtinToolName(BUILTIN_CATEGORY.tabs, toolName),
    );
    const pageMatches = collectPageToolMatches(tree, toolName, preferredTabId);
    if (preferredTabId != null) {
      if (pageMatches.length > 1)
        throw new Error(
          `Tool '${toolName}' has multiple matches on tab ${preferredTabId}; please narrow by namespace/instance`,
        );
      if (pageMatches.length === 1) return pageMatches[0];
      if (builtinMatches.length === 1) return builtinMatches[0];
      if (builtinMatches.length > 1)
        throw new Error(`Tool '${toolName}' has duplicated builtin matches in tool tree`);
      return null;
    }
    const allMatches = [...builtinMatches, ...pageMatches];
    if (allMatches.length === 0) return null;
    if (allMatches.length > 1)
      throw new Error(`Tool '${toolName}' matches multiple targets; provide tabId to disambiguate`);
    return allMatches[0];
  }
  function collectBuiltinToolMatches(tree, toolName) {
    return collectBuiltinToolsFromTree(tree)
      .filter((item) => isRecord$2(item) && item.toolName === toolName)
      .map((item) => ({
        root: 'builtin',
        enabled: Boolean(item.enabled),
        readOnly: Boolean(item.readOnly),
      }));
  }
  function collectPageToolMatches(tree, toolName, preferredTabId) {
    if (!isRecord$2(tree) || !Array.isArray(tree.tabs)) return [];
    const matches = [];
    for (const tab of tree.tabs) {
      if (!isRecord$2(tab) || typeof tab.tabId !== 'number') continue;
      if (preferredTabId != null && tab.tabId !== preferredTabId) continue;
      const namespaces = Array.isArray(tab.namespaces) ? tab.namespaces : [];
      for (const namespace of namespaces) {
        if (!isRecord$2(namespace)) continue;
        const instances = Array.isArray(namespace.instances) ? namespace.instances : [];
        for (const instance of instances) {
          if (!isRecord$2(instance)) continue;
          const tools = Array.isArray(instance.tools) ? instance.tools : [];
          for (const tool of tools) {
            if (!isRecord$2(tool) || tool.toolName !== toolName) continue;
            matches.push({
              root: 'page',
              tabId: tab.tabId,
              enabled: Boolean(tool.enabled),
              readOnly: Boolean(tool.readOnly),
            });
          }
        }
      }
    }
    return matches;
  }
  function collectBuiltinToolsFromTree(tree) {
    if (!isRecord$2(tree)) return [];
    const builtins = isRecord$2(tree.builtins) ? tree.builtins : null;
    if (!builtins) return [];
    if (Array.isArray(builtins.namespaces)) {
      const tools = [];
      for (const namespace of builtins.namespaces) {
        if (!isRecord$2(namespace) || !Array.isArray(namespace.instances)) continue;
        for (const instance of namespace.instances) {
          if (!isRecord$2(instance) || !Array.isArray(instance.tools)) continue;
          tools.push(...instance.tools);
        }
      }
      return tools;
    }
    return Array.isArray(builtins.tools) ? builtins.tools : [];
  }
  function isRecord$2(value) {
    return typeof value === 'object' && value != null && !Array.isArray(value);
  }
  //#endregion
  //#region ../builtin-tools/dist/feedback-control-bridge-provider.js
  /**
   * Bridge-side provider for feedback control tools.
   *
   * These tools only handle "parameter adaptation + capability orchestration",
   * actual state values are still maintained by bridge's feedback-store.
   * Names follow the `feedback.*` namespace pattern.
   */
  function createTextResponse(text) {
    return {
      content: [
        {
          type: 'text',
          text,
        },
      ],
    };
  }
  var FEEDBACK_CONTROL_TOOL_SUFFIXES = {
    getSnapshot: 'get_snapshot',
    watchEvents: 'watch_events',
    createAnnotation: 'create_annotation',
    updateAnnotation: 'update_annotation',
    claim: 'claim',
    reply: 'reply',
    resolve: 'resolve',
    dismiss: 'dismiss',
  };
  var feedbackPrioritySchema = _enum(['low', 'normal', 'high', 'critical']);
  var feedbackActorSourceSchema = _enum(['user', 'agent', 'bridge', 'extension']);
  var feedbackUiRectSchema = object({
    x: number(),
    y: number(),
    width: number(),
    height: number(),
  });
  var feedbackUiTextRangeSchema = object({
    start: number().int().nonnegative(),
    end: number().int().nonnegative(),
  }).refine((value) => value.end >= value.start, {
    path: ['end'],
    message: 'end must be greater than or equal to start',
  });
  var feedbackUiAnchorSchema = object({
    elementId: string().optional(),
    cssSelector: string().optional(),
    xpath: string().optional(),
    textQuote: string().optional(),
    framePath: array(number().int().nonnegative()).optional(),
    rect: feedbackUiRectSchema.optional(),
    textRange: feedbackUiTextRangeSchema.optional(),
    meta: record(string(), unknown()).optional(),
  });
  var feedbackGetSnapshotSchema = object({
    tabId: number().int().optional(),
    sessionId: string().optional(),
  });
  var feedbackWatchEventsSchema = object({
    afterSeq: number().int().nonnegative().default(0),
    sessionId: string().optional(),
  });
  var feedbackCreateAnnotationSchema = object({
    body: string().trim().min(1),
    priority: feedbackPrioritySchema.optional(),
    tabId: number().int().positive(),
    url: string().trim().min(1),
    title: string().optional(),
    selectedText: string().optional(),
    uiAnchor: feedbackUiAnchorSchema.optional(),
    actorSource: feedbackActorSourceSchema.optional(),
    actorId: string().trim().min(1).optional(),
    actorName: string().trim().min(1).optional(),
  });
  var feedbackUpdateAnnotationSchema = object({
    annotationId: string().trim().min(1),
    body: string().trim().min(1),
    priority: feedbackPrioritySchema.optional(),
    actorSource: feedbackActorSourceSchema.optional(),
    actorId: string().trim().min(1).optional(),
    actorName: string().trim().min(1).optional(),
  });
  var feedbackClaimAnnotationSchema = object({
    annotationId: string().trim().min(1),
    actorSource: feedbackActorSourceSchema.optional(),
    actorId: string().trim().min(1).optional(),
    actorName: string().trim().min(1).optional(),
  });
  var feedbackReplyAnnotationSchema = object({
    annotationId: string().trim().min(1),
    body: string().trim().min(1),
    kind: _enum(['comment', 'action_note', 'resolution_note']).optional(),
    actorSource: feedbackActorSourceSchema.optional(),
    actorId: string().trim().min(1).optional(),
    actorName: string().trim().min(1).optional(),
  });
  var feedbackResolveAnnotationSchema = object({
    annotationId: string().trim().min(1),
    resolution: string().trim().min(1).optional(),
    actorSource: feedbackActorSourceSchema.optional(),
    actorId: string().trim().min(1).optional(),
    actorName: string().trim().min(1).optional(),
  });
  var feedbackDismissAnnotationSchema = object({
    annotationId: string().trim().min(1),
    dismissReason: string().trim().min(1).optional(),
    actorSource: feedbackActorSourceSchema.optional(),
    actorId: string().trim().min(1).optional(),
    actorName: string().trim().min(1).optional(),
  });
  var FeedbackControlBridgeProvider = class {
    id = 'feedback-control';
    namespace;
    constructor(options = {}) {
      this.namespace = options.namespace ?? 'feedback';
    }
    getToolNames() {
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
    registerOnBridge(registerTool, rpc) {
      const handles = /* @__PURE__ */ new Map();
      const names = this.getToolNames();
      const register = (name, config, handler) => {
        handles.set(name, registerTool(name, config, handler));
      };
      const getSnapshotConfig = {
        description: 'Read feedback snapshot (sessions + annotations + cursor metadata).',
        inputSchema: {
          tabId: feedbackGetSnapshotSchema.shape.tabId,
          sessionId: feedbackGetSnapshotSchema.shape.sessionId,
        },
        annotations: { readOnlyHint: true },
      };
      const createAnnotationConfig = {
        description: 'Create a feedback annotation from MCP side with tab context.',
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
        description: 'Read feedback delta events after a cursor.',
        inputSchema: {
          afterSeq: feedbackWatchEventsSchema.shape.afterSeq,
          sessionId: feedbackWatchEventsSchema.shape.sessionId,
        },
        annotations: { readOnlyHint: true },
      };
      const updateAnnotationConfig = {
        description: 'Update an existing feedback annotation body/priority.',
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
        description: 'Claim an open feedback annotation for execution.',
        inputSchema: {
          annotationId: feedbackClaimAnnotationSchema.shape.annotationId,
          actorSource: feedbackClaimAnnotationSchema.shape.actorSource,
          actorId: feedbackClaimAnnotationSchema.shape.actorId,
          actorName: feedbackClaimAnnotationSchema.shape.actorName,
        },
      };
      const replyConfig = {
        description: 'Append a reply to an annotation thread.',
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
        description: 'Resolve a claimed feedback annotation.',
        inputSchema: {
          annotationId: feedbackResolveAnnotationSchema.shape.annotationId,
          resolution: feedbackResolveAnnotationSchema.shape.resolution,
          actorSource: feedbackResolveAnnotationSchema.shape.actorSource,
          actorId: feedbackResolveAnnotationSchema.shape.actorId,
          actorName: feedbackResolveAnnotationSchema.shape.actorName,
        },
      };
      const dismissConfig = {
        description: 'Dismiss a feedback annotation.',
        inputSchema: {
          annotationId: feedbackDismissAnnotationSchema.shape.annotationId,
          dismissReason: feedbackDismissAnnotationSchema.shape.dismissReason,
          actorSource: feedbackDismissAnnotationSchema.shape.actorSource,
          actorId: feedbackDismissAnnotationSchema.shape.actorId,
          actorName: feedbackDismissAnnotationSchema.shape.actorName,
        },
      };
      const getSnapshotHandler = async (args) => {
        const parsed = feedbackGetSnapshotSchema.parse(args);
        const snapshot = rpc.getFeedbackSnapshot(parsed);
        return createTextResponse(JSON.stringify(snapshot, null, 2));
      };
      const createAnnotationHandler = async (args) => {
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
      const watchEventsHandler = async (args) => {
        const parsed = feedbackWatchEventsSchema.parse(args);
        const delta = rpc.getFeedbackDelta({
          afterSeq: parsed.afterSeq,
          sessionId: parsed.sessionId,
        });
        return createTextResponse(JSON.stringify(delta, null, 2));
      };
      const updateAnnotationHandler = async (args) => {
        const parsed = feedbackUpdateAnnotationSchema.parse(args);
        const annotation = rpc.updateFeedbackAnnotation({
          annotationId: parsed.annotationId,
          body: parsed.body,
          priority: parsed.priority,
          actor: toFeedbackActor(parsed.actorSource, parsed.actorId, parsed.actorName),
        });
        return createTextResponse(JSON.stringify({ annotation }, null, 2));
      };
      const claimHandler = async (args) => {
        const parsed = feedbackClaimAnnotationSchema.parse(args);
        const annotation = rpc.claimFeedbackAnnotation({
          annotationId: parsed.annotationId,
          actor: toFeedbackActor(parsed.actorSource, parsed.actorId, parsed.actorName),
        });
        return createTextResponse(JSON.stringify({ annotation }, null, 2));
      };
      const replyHandler = async (args) => {
        const parsed = feedbackReplyAnnotationSchema.parse(args);
        const annotation = rpc.replyFeedbackAnnotation({
          annotationId: parsed.annotationId,
          body: parsed.body,
          kind: parsed.kind,
          actor: toFeedbackActor(parsed.actorSource, parsed.actorId, parsed.actorName),
        });
        return createTextResponse(JSON.stringify({ annotation }, null, 2));
      };
      const resolveHandler = async (args) => {
        const parsed = feedbackResolveAnnotationSchema.parse(args);
        const annotation = rpc.resolveFeedbackAnnotation({
          annotationId: parsed.annotationId,
          resolution: parsed.resolution,
          actor: toFeedbackActor(parsed.actorSource, parsed.actorId, parsed.actorName),
        });
        return createTextResponse(JSON.stringify({ annotation }, null, 2));
      };
      const dismissHandler = async (args) => {
        const parsed = feedbackDismissAnnotationSchema.parse(args);
        const annotation = rpc.dismissFeedbackAnnotation({
          annotationId: parsed.annotationId,
          dismissReason: parsed.dismissReason,
          actor: toFeedbackActor(parsed.actorSource, parsed.actorId, parsed.actorName),
        });
        return createTextResponse(JSON.stringify({ annotation }, null, 2));
      };
      register(names.getSnapshot, getSnapshotConfig, getSnapshotHandler);
      register(names.watchEvents, watchEventsConfig, watchEventsHandler);
      register(names.createAnnotation, createAnnotationConfig, createAnnotationHandler);
      register(names.updateAnnotation, updateAnnotationConfig, updateAnnotationHandler);
      register(names.claim, claimConfig, claimHandler);
      register(names.reply, replyConfig, replyHandler);
      register(names.resolve, resolveConfig, resolveHandler);
      register(names.dismiss, dismissConfig, dismissHandler);
      return handles;
    }
  };
  function toFeedbackActor(actorSource, actorId, actorName) {
    return {
      source: actorSource ?? 'agent',
      id: actorId ?? 'mcp.agent',
      displayName: actorName ?? 'MCP Agent',
    };
  }
  //#endregion
  //#region ../builtin-tools/dist/control-tool-specs.js
  /**
   * Collect bridge control tool specifications by reusing provider register logic.
   *
   * This allows extension-side visibility/tree model to stay consistent with the provider,
   * avoiding the need to maintain redundant constants.
   */
  function collectBridgeControlToolSpecs() {
    const specsByName = /* @__PURE__ */ new Map();
    collectFromExtensionControlProvider(specsByName);
    collectFromFeedbackControlProvider(specsByName);
    return Array.from(specsByName.values()).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }
  function collectFromExtensionControlProvider(specsByName) {
    const provider = new ExtensionControlBridgeProvider();
    const noopRpc = createNoopRpc();
    provider.registerOnBridge((name, schema) => {
      addControlToolSpec(specsByName, name, schema);
      return { remove: () => void 0 };
    }, noopRpc);
  }
  function collectFromFeedbackControlProvider(specsByName) {
    const provider = new FeedbackControlBridgeProvider();
    const noopRpc = createNoopRpc();
    provider.registerOnBridge((name, schema) => {
      addControlToolSpec(specsByName, name, schema);
      return { remove: () => void 0 };
    }, noopRpc);
  }
  function addControlToolSpec(specsByName, name, schema) {
    if (!name.includes('.')) return;
    if (specsByName.has(name)) return;
    specsByName.set(name, {
      name,
      description: schema.description,
      inputSchema: schema.inputSchema,
      annotations: schema.annotations,
      _bridgeControlTool: true,
    });
  }
  function createNoopRpc() {
    return new Proxy({}, { get: () => async () => ({}) });
  }

  //#region ../page-context-agentation/dist/main-world/injection.js
  /**
   * MAIN world injection utilities for page-context extension.
   *
   * Provides typed wrappers around chrome.scripting.executeScript
   * for both bridge host installation and agentation React injection.
   */
  /**
   * Inject a script function into a specific tab's MAIN world.
   */
  async function ensureMainWorldBridgeHostOnTab(tabId, installer, frameId) {
    await chrome.scripting.executeScript({
      target:
        typeof frameId === 'number'
          ? {
              tabId,
              frameIds: [frameId],
            }
          : { tabId },
      world: 'MAIN',
      func: installer,
    });
    return { ok: true };
  }
  /**
   * Inject a script function into the sender tab's MAIN world.
   * Derives tabId from sender.tab, with optional frameId from sender.frameId.
   */
  async function ensureMainWorldBridgeHostOnSenderTab(sender, installer) {
    const tabId = sender.tab?.id;
    if (!tabId) throw new Error('No sender tab available for MAIN world host injection.');
    return await ensureMainWorldBridgeHostOnTab(
      tabId,
      installer,
      typeof sender.frameId === 'number' ? sender.frameId : 0,
    );
  }
  /**
   * Inject agentation-main.js (built React bundle) into a specific tab's MAIN world.
   * The JS file must have been built by vite and available via web_accessible_resources.
   */
  async function ensureAgentationMainOnTab(tabId, frameId) {
    await chrome.scripting.executeScript({
      target:
        typeof frameId === 'number'
          ? {
              tabId,
              frameIds: [frameId],
            }
          : { tabId },
      world: 'MAIN',
      files: ['agentation-main.js'],
    });
    return { ok: true };
  }
  /**
   * Inject agentation-main.js into the sender tab's MAIN world.
   * Derives tabId from sender.tab, with optional frameId from sender.frameId.
   */
  async function ensureAgentationMainOnSenderTab(sender) {
    const tabId = sender.tab?.id;
    if (!tabId) throw new Error('No sender tab available for Agentation MAIN world injection.');
    return await ensureAgentationMainOnTab(
      tabId,
      typeof sender.frameId === 'number' ? sender.frameId : 0,
    );
  }
  /**
   * Extract tabId/frameId from an unknown params object (e.g., RPC payload).
   * Used by consumers that receive params from content-script or sidepanel.
   */
  function getMainWorldInjectionTarget(params) {
    const payload = params;
    const tabId = Number(payload?.tabId ?? 0);
    if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('tabId must be a positive integer');
    if (payload?.frameId == null) return { tabId };
    if (!Number.isInteger(payload.frameId) || payload.frameId < 0)
      throw new Error('frameId must be a non-negative integer');
    return {
      tabId,
      frameId: payload.frameId,
    };
  }
  //#endregion
  //#region ../page-context-agentation/dist/react-meta.js
  /**
   * React Fiber detection and metadata enrichment for background-side use.
   *
   * Runs inside MAIN world via chrome.scripting.executeScript to read
   * __reactFiber$ / __reactInternalInstance$ properties directly from DOM elements.
   * Only supplements reactPath/reactLeaf on uiAnchor.meta; any failure silently degrades.
   */
  /**
   * Enrich uiAnchor with React component path/leaf metadata collected from MAIN world.
   * Skips injection if both fields already exist to avoid overhead.
   */
  async function enrichUiAnchorReactMetaInMainWorld(tabId, uiAnchor) {
    if (!uiAnchor) return uiAnchor;
    const existingMeta = toPlainRecord(uiAnchor.meta);
    const existingReactPath = toReactPath(existingMeta?.reactPath);
    const existingReactLeaf = toReactLeaf(existingMeta?.reactLeaf);
    if (existingReactPath && existingReactLeaf) return uiAnchor;
    try {
      const [injectionResult] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: collectReactMetaInMainWorld,
        args: [
          {
            cssSelector: uiAnchor.cssSelector,
            rect: uiAnchor.rect,
          },
        ],
      });
      const collected = toReactAnchorMeta(injectionResult?.result);
      if (!collected) return uiAnchor;
      const nextReactPath = existingReactPath ?? collected.reactPath;
      const nextReactLeaf = existingReactLeaf ?? collected.reactLeaf;
      if (!nextReactPath || !nextReactLeaf) return uiAnchor;
      return {
        ...uiAnchor,
        meta: {
          ...(existingMeta ?? {}),
          reactPath: nextReactPath,
          reactLeaf: nextReactLeaf,
        },
      };
    } catch {
      return uiAnchor;
    }
  }
  function toPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    return value;
  }
  function toReactAnchorMeta(value) {
    const record = toPlainRecord(value);
    if (!record) return null;
    const reactPath = toReactPath(record.reactPath);
    const reactLeaf = toReactLeaf(record.reactLeaf);
    if (!reactPath || !reactLeaf) return null;
    return {
      reactPath,
      reactLeaf,
    };
  }
  function toReactPath(value) {
    if (!Array.isArray(value)) return null;
    return value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12)
      .filter(Boolean);
  }
  function toReactLeaf(value) {
    if (typeof value !== 'string') return null;
    return value.trim() || null;
  }
  function collectReactMetaInMainWorld(input) {
    const REACT_FIBER_KEY_PREFIXES = [
      '__reactFiber$',
      '__reactInternalInstance$',
      '__reactContainer$',
    ];
    const REACT_DOM_WALK_MAX_DEPTH = 12;
    const REACT_FIBER_MAX_DEPTH = 30;
    const REACT_PATH_MAX_COMPONENTS = 8;
    const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
    const getParentElement = (element) => {
      if (element.parentElement) return element.parentElement;
      const root = element.getRootNode();
      if (root instanceof ShadowRoot) return root.host;
      return null;
    };
    const resolveTargetElement = () => {
      const selector = typeof input.cssSelector === 'string' ? input.cssSelector.trim() : '';
      if (selector)
        try {
          const bySelector = document.querySelector(selector);
          if (bySelector) return bySelector;
        } catch {}
      const rect = input.rect;
      if (!rect) return null;
      if (
        !isFiniteNumber(rect.x) ||
        !isFiniteNumber(rect.y) ||
        !isFiniteNumber(rect.width) ||
        !isFiniteNumber(rect.height)
      )
        return null;
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;
      return document.elementFromPoint(centerX, centerY);
    };
    const getReactFiberFromElement = (element) => {
      let keys;
      try {
        keys = Object.keys(element);
      } catch {
        return null;
      }
      const fiberKey = keys.find((key) =>
        REACT_FIBER_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)),
      );
      if (!fiberKey) return null;
      const fiber = element[fiberKey];
      if (!fiber || typeof fiber !== 'object') return null;
      return fiber;
    };
    const getReactFiberFromElementOrAncestors = (target) => {
      let current = target;
      let depth = 0;
      while (current && depth < REACT_DOM_WALK_MAX_DEPTH) {
        const fiber = getReactFiberFromElement(current);
        if (fiber) return fiber;
        current = getParentElement(current);
        depth += 1;
      }
      return null;
    };
    const normalizeName = (value) => {
      if (typeof value !== 'string') return null;
      return value.trim() || null;
    };
    const isLikelyMinifiedName = (name) => {
      if (name.length <= 2) return true;
      if (name.length <= 3 && name === name.toLowerCase()) return true;
      return false;
    };
    const readComponentNameFromType = (type, depth) => {
      if (!type || depth > 3) return null;
      if (typeof type === 'function') {
        const fn = type;
        return normalizeName(fn.displayName ?? fn.name);
      }
      if (typeof type !== 'object') return null;
      const record = type;
      const displayName = normalizeName(record.displayName);
      if (displayName) return displayName;
      const directName = normalizeName(record.name);
      if (directName) return directName;
      const nameFromRender = readComponentNameFromType(record.render, depth + 1);
      if (nameFromRender) return nameFromRender;
      const nameFromNestedType = readComponentNameFromType(record.type, depth + 1);
      if (nameFromNestedType) return nameFromNestedType;
      const nameFromLazyResult = readComponentNameFromType(record._result, depth + 1);
      if (nameFromLazyResult) return nameFromLazyResult;
      const contextRecord = record._context;
      if (contextRecord && typeof contextRecord === 'object') {
        const contextName = normalizeName(contextRecord.displayName);
        if (contextName) return `${contextName}.Provider`;
      }
      return null;
    };
    const getComponentNameFromFiber = (fiber) => {
      if (typeof fiber.type === 'string') return null;
      return (
        readComponentNameFromType(fiber.elementType, 0) ?? readComponentNameFromType(fiber.type, 0)
      );
    };
    const targetElement = resolveTargetElement();
    if (!targetElement) return null;
    const fiber = getReactFiberFromElementOrAncestors(targetElement);
    if (!fiber) return null;
    const components = [];
    const visitedFibers = /* @__PURE__ */ new Set();
    let current = fiber;
    let depth = 0;
    try {
      while (
        current &&
        depth < REACT_FIBER_MAX_DEPTH &&
        components.length < REACT_PATH_MAX_COMPONENTS
      ) {
        if (visitedFibers.has(current)) break;
        visitedFibers.add(current);
        const name = getComponentNameFromFiber(current);
        if (name && !isLikelyMinifiedName(name)) {
          if (components[components.length - 1] !== name) components.push(name);
        }
        current = current.return;
        depth += 1;
      }
    } catch {
      return null;
    }
    if (components.length === 0) return null;
    return {
      reactPath: components.slice().reverse(),
      reactLeaf: components[0],
    };
  }
  //#endregion
  //#region src/bg-ws-connection.ts
  /**
   * WebSocket connection management for the background service worker.
   * Handles connect/reconnect, heartbeat, and queued notifications.
   */
  var DEFAULT_MCP_WS_URL = 'ws://127.0.0.1:22335/default';
  var RECONNECT_BASE_MS = 1e3;
  var RECONNECT_MAX_MS = 3e4;
  var HEARTBEAT_INTERVAL_MS = 15e3;
  var MCP_WS_URL_KEY = 'mcpWsUrl';
  var DEFAULT_BRIDGE_DESCRIPTOR_ID = 'bridge-default-ws';
  var WS_FORWARD_EXTENSION_METHODS = [
    BRIDGE_METHODS.extensionStatusGet,
    BRIDGE_METHODS.extensionReconnect,
    BRIDGE_METHODS.extensionPageToolsGet,
    BRIDGE_METHODS.extensionPageToolsTreeGet,
    BRIDGE_METHODS.extensionPageToolsDiscover,
    BRIDGE_METHODS.extensionPageToolsRefresh,
    BRIDGE_METHODS.extensionPageToolsSetEnabled,
    BRIDGE_METHODS.extensionToolDebugCall,
    BRIDGE_METHODS.extensionMainWorldHostEnsure,
    BRIDGE_METHODS.extensionAgentationMainEnsure,
    BRIDGE_METHODS.extensionContextManifestGet,
    BRIDGE_METHODS.extensionContextResourceRead,
    BRIDGE_METHODS.extensionContextSkillGet,
  ];
  var ws = null;
  var rpcPeer = null;
  var wsReady = false;
  var sessionId = null;
  var connectPromise = null;
  var reconnectAttempts = 0;
  var reconnectTimer = null;
  var wsEpoch = 0;
  var heartbeatTimer = null;
  var reconnectHandlers = null;
  var manualDisconnect = false;
  var queuedNotifications = [];
  function registerDefaultBridgeDescriptor(status, patch = {}) {
    const registry = getConnectionRegistry();
    const current = registry.get(DEFAULT_BRIDGE_DESCRIPTOR_ID);
    const next = {
      id: DEFAULT_BRIDGE_DESCRIPTOR_ID,
      kind: 'bridge-default-ws',
      label: 'Bridge Default WS',
      endpoint: patch.endpoint ?? current?.endpoint ?? null,
      status,
      statusReason: patch.statusReason ?? current?.statusReason ?? null,
      capabilities: {
        reconnect: true,
        disconnect: true,
      },
      meta: {},
    };
    if (current) {
      registry.update(DEFAULT_BRIDGE_DESCRIPTOR_ID, {
        endpoint: next.endpoint,
        status: next.status,
        statusReason: next.statusReason,
        capabilities: next.capabilities,
        meta: next.meta,
      });
      return;
    }
    registry.register(next);
  }
  function getWsReady() {
    return wsReady;
  }
  function getSessionId() {
    return sessionId;
  }
  async function defaultOnExtensionRequest(method) {
    throw new RpcProtocolError(
      RPC_ERROR_CODES.methodNotFound,
      `Unhandled WS extension method: ${method}`,
    );
  }
  async function requestBridge(method, params, options) {
    if (!wsReady || !rpcPeer) throw new Error('Bridge is not connected');
    return await rpcPeer.request(method, params, options);
  }
  function queueNotification(method, params) {
    if (wsReady && rpcPeer) {
      rpcPeer.notify(method, params).catch((error) => log(`Failed to notify ${method}`, error));
      return;
    }
    queuedNotifications.push({
      method,
      params,
    });
  }
  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }
  function clearHeartbeatTimer() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  function ensureHeartbeatTimer() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (!wsReady || !rpcPeer || !sessionId) return;
      rpcPeer.notify(BRIDGE_METHODS.sessionHeartbeat, { sentAt: Date.now() }).catch((error) => {
        log('Heartbeat failed', error);
      });
    }, HEARTBEAT_INTERVAL_MS);
  }
  async function flushQueuedNotifications() {
    if (!wsReady || !rpcPeer) return;
    while (queuedNotifications.length > 0) {
      const next = queuedNotifications.shift();
      if (!next) continue;
      await rpcPeer.notify(next.method, next.params);
    }
  }
  async function getWsUrl() {
    return (await storageLocalGet({ [MCP_WS_URL_KEY]: DEFAULT_MCP_WS_URL }))[MCP_WS_URL_KEY];
  }
  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!reconnectHandlers) return;
      connectWebSocket(
        reconnectHandlers.onToolCall,
        reconnectHandlers.onToolsList,
        reconnectHandlers.onTabsList,
        reconnectHandlers.onExtensionRequest,
      );
    }, delay);
    log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  }
  function registerForwardedExtensionMethods(peer, onExtensionRequest) {
    for (const method of WS_FORWARD_EXTENSION_METHODS)
      peer.register(method, async (params) => await onExtensionRequest(method, params));
  }
  async function connectWebSocket(
    onToolCall,
    onToolsList,
    onTabsList,
    onExtensionRequest = defaultOnExtensionRequest,
  ) {
    reconnectHandlers = {
      onToolCall,
      onToolsList,
      onTabsList,
      onExtensionRequest,
    };
    manualDisconnect = false;
    if (connectPromise) return await connectPromise;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    connectPromise = (async () => {
      const url = await getWsUrl();
      log('Connecting to WebSocket:', url);
      registerDefaultBridgeDescriptor('connecting', {
        endpoint: url,
        statusReason: 'connecting',
      });
      const socket = new WebSocket(url);
      const epoch = ++wsEpoch;
      ws = socket;
      wsReady = false;
      sessionId = null;
      rpcPeer = new RpcPeer({
        send: (message) => socket.send(message),
        defaultTimeoutMs: 3e4,
        getMeta: () => ({
          sessionId: sessionId ?? void 0,
          source: 'extension',
          target: 'bridge',
        }),
      });
      rpcPeer.register(BRIDGE_METHODS.bridgeToolCall, async (params, request) => {
        return await onToolCall(params, request.id);
      });
      rpcPeer.register(BRIDGE_METHODS.bridgeToolsList, async () => onToolsList());
      rpcPeer.register(BRIDGE_METHODS.bridgeTabsList, async () => onTabsList());
      registerForwardedExtensionMethods(rpcPeer, onExtensionRequest);
      await new Promise((resolve, reject) => {
        let settled = false;
        let opened = false;
        const resolveOnce = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const rejectOnce = (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        socket.onopen = () => {
          opened = true;
          resolveOnce();
        };
        socket.onmessage = (event) => {
          if (ws !== socket || epoch !== wsEpoch || !rpcPeer) return;
          rpcPeer
            .receive(String(event.data))
            .catch((error) => log('Failed to process bridge message', error));
        };
        socket.onerror = (error) => {
          if (ws !== socket || epoch !== wsEpoch) return;
          log('WebSocket error', error, 'readyState=', socket.readyState, 'url=', socket.url);
          if (!opened) {
            rejectOnce(
              /* @__PURE__ */ new Error(
                `WebSocket errored before open (readyState=${socket.readyState})`,
              ),
            );
            socket.close();
          }
        };
        socket.onclose = (event) => {
          if (ws !== socket || epoch !== wsEpoch) return;
          log('WebSocket closed');
          if (!opened)
            rejectOnce(
              /* @__PURE__ */ new Error(`WebSocket closed before open (code=${event.code})`),
            );
          wsReady = false;
          sessionId = null;
          clearHeartbeatTimer();
          rpcPeer?.failAllPending('Bridge transport closed');
          ws = null;
          registerDefaultBridgeDescriptor(manualDisconnect ? 'closed' : 'error', {
            endpoint: url,
            statusReason: manualDisconnect
              ? 'disconnected-by-user'
              : `closed-before-reconnect:${event.code}`,
          });
          if (!manualDisconnect) scheduleReconnect();
        };
      });
      try {
        sessionId = (
          await rpcPeer.request(
            BRIDGE_METHODS.sessionRegister,
            {
              extensionId: chrome.runtime.id,
              version: chrome.runtime.getManifest().version,
            },
            { timeoutMs: 5e3 },
          )
        ).sessionId;
        wsReady = true;
        reconnectAttempts = 0;
        clearReconnectTimer();
        ensureHeartbeatTimer();
        await flushQueuedNotifications();
        registerDefaultBridgeDescriptor('connected', {
          endpoint: url,
          statusReason: 'ready',
        });
        log('Bridge session ready', sessionId);
      } catch (error) {
        log('Bridge session register failed', error);
        registerDefaultBridgeDescriptor('error', {
          endpoint: url,
          statusReason: error instanceof Error ? error.message : String(error),
        });
        socket.close();
      }
    })();
    try {
      await connectPromise;
    } finally {
      connectPromise = null;
    }
  }
  function forceReconnect(
    onToolCall,
    onToolsList,
    onTabsList,
    onExtensionRequest = defaultOnExtensionRequest,
  ) {
    clearReconnectTimer();
    clearHeartbeatTimer();
    reconnectAttempts = 0;
    wsReady = false;
    connectPromise = null;
    manualDisconnect = false;
    ws?.close();
    return connectWebSocket(onToolCall, onToolsList, onTabsList, onExtensionRequest);
  }
  /**
   * 手动断开默认 bridge。
   *
   * 这里要显式压住自动重连；否则 UI 点了 Disconnect，后台马上又自己连回去。
   */
  function disconnectWebSocket() {
    manualDisconnect = true;
    clearReconnectTimer();
    clearHeartbeatTimer();
    reconnectAttempts = 0;
    wsReady = false;
    connectPromise = null;
    sessionId = null;
    rpcPeer?.failAllPending('Bridge transport closed by user');
    registerDefaultBridgeDescriptor('closed', {
      endpoint: ws?.url ?? null,
      statusReason: 'disconnected-by-user',
    });
    ws?.close();
    ws = null;
    rpcPeer = null;
  }
  function initDefaultWsUrl() {
    return storageLocalGet(MCP_WS_URL_KEY).then((data) => {
      registerDefaultBridgeDescriptor('closed', {
        endpoint:
          typeof data[MCP_WS_URL_KEY] === 'string' && data[MCP_WS_URL_KEY]
            ? String(data[MCP_WS_URL_KEY])
            : DEFAULT_MCP_WS_URL,
        statusReason: 'idle',
      });
      if (!data[MCP_WS_URL_KEY]) return storageLocalSet({ [MCP_WS_URL_KEY]: DEFAULT_MCP_WS_URL });
    });
  }
  function log(...args) {
    console.log('[PAGE-CONTEXT-BG]', ...args);
  }
  //#endregion
  //#region src/bg-page-access-backend.ts
  /**
   * 页面访问后端（Phase 4）。
   * 目标很单一：把 Chromium 专属的 MAIN world 执行细节集中到一个薄层，
   * 让上层只关心“读什么/调什么”，不关心“怎么注入”。
   */
  /**
   * 兼容策略：就算 shared-protocol 的 dist 还没刷新，这里也能用字面量兜底。
   * 这样 Firefox 只读链路不会因为常量未同步而退化为 undefined method。
   */
  var FIREFOX_READONLY_METHODS = {
    manifestGet: BRIDGE_METHODS.extensionContentContextManifestGet,
    resourceRead: BRIDGE_METHODS.extensionContentContextResourceRead,
    skillGet: BRIDGE_METHODS.extensionContentContextSkillGet,
    pageToolsDiscover: BRIDGE_METHODS.extensionContentPageToolsDiscover,
    pageToolExecute: BRIDGE_METHODS.extensionContentPageToolExecute,
  };
  var PageAccessBackendError = class extends Error {
    constructor(params) {
      super(`[page-access-backend:${params.backendKind}] ${params.operation}: ${params.reason}`);
      this.code = 'PAGE_ACCESS_BACKEND_UNAVAILABLE';
      this.name = 'PageAccessBackendError';
      this.backendKind = params.backendKind;
      this.operation = params.operation;
    }
  };
  function isPageAccessBackendError(error) {
    return error instanceof PageAccessBackendError;
  }
  /**
   * 薄探测：只做“路由判定”，不承诺该路径已经可用。
   * Phase 6 的 Firefox 走只读 RPC fallback，避免再误走 Chromium MAIN world。
   */
  function detectPageAccessBackend(probe) {
    const manifestTarget = detectManifestTarget(probe?.manifest ?? safeGetRuntimeManifest());
    const userAgent = probe?.userAgent ?? safeGetRuntimeUserAgent();
    const hasFirefoxUserAgent = /Firefox\/\d+/i.test(userAgent);
    const hasBrowserRuntimeGetBrowserInfo =
      probe?.hasBrowserRuntimeGetBrowserInfo ?? safeHasBrowserRuntimeGetBrowserInfo();
    const hasChromeScriptingExecuteScript =
      probe?.hasChromeScriptingExecuteScript ?? safeHasChromeScriptingExecuteScript();
    if (manifestTarget === 'firefox' || hasFirefoxUserAgent || hasBrowserRuntimeGetBrowserInfo)
      return {
        kind: 'firefox-probe',
        reason:
          'Firefox probe signal detected (manifest/browser API/userAgent). Readonly RPC fallback is available.',
      };
    if (hasChromeScriptingExecuteScript)
      return {
        kind: 'chromium-native-main-world',
        reason: 'Chromium MAIN world capability detected via chrome.scripting.executeScript.',
      };
    return {
      kind: 'unsupported',
      reason: 'No supported page access backend capability detected.',
    };
  }
  /** Chromium 继续走 MAIN world 注入执行。 */
  function createChromiumPageAccessBackend() {
    return {
      async getRawManifest(tabId) {
        return (
          (
            await chrome.scripting.executeScript({
              target: { tabId },
              world: 'MAIN',
              func: () => {
                const contextWindow = window;
                const pageTools =
                  contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
                if (!pageTools || typeof pageTools.getManifest !== 'function') return null;
                return pageTools.getManifest();
              },
            })
          )[0]?.result ?? null
        );
      },
      async readResource(tabId, resourceId) {
        return (
          await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (id) => {
              const contextWindow = window;
              const pageTools =
                contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
              if (!pageTools || typeof pageTools.readResource !== 'function')
                throw new Error('Page Context Bridge does not expose readResource()');
              return pageTools.readResource(id);
            },
            args: [resourceId],
          })
        )[0]?.result;
      },
      async getSkill(tabId, skillId, input) {
        return (
          (
            await chrome.scripting.executeScript({
              target: { tabId },
              world: 'MAIN',
              func: (id, args) => {
                const contextWindow = window;
                const pageTools =
                  contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
                if (!pageTools || typeof pageTools.getSkill !== 'function') return null;
                return pageTools.getSkill(id, args);
              },
              args: [skillId, input ?? {}],
            })
          )[0]?.result ?? null
        );
      },
      async ensureBridgeHost(_tabId) {},
      async discoverTools(tabId) {
        return (
          (
            await chrome.scripting.executeScript({
              target: { tabId },
              world: 'MAIN',
              func: () => {
                const contextWindow = window;
                const pageTools =
                  contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
                if (!pageTools || typeof pageTools !== 'object') return [];
                const entries = [];
                const namespaceMetadataById = {};
                if (typeof pageTools.getManifest === 'function')
                  try {
                    const manifest = pageTools.getManifest();
                    const manifestNamespaces =
                      manifest && typeof manifest === 'object' && Array.isArray(manifest.namespaces)
                        ? (manifest.namespaces ?? [])
                        : [];
                    for (const entry of manifestNamespaces) {
                      if (!entry || typeof entry !== 'object') continue;
                      const namespace =
                        typeof entry.namespace === 'string' ? entry.namespace : null;
                      if (!namespace) continue;
                      namespaceMetadataById[namespace] = {
                        title: typeof entry.title === 'string' ? entry.title : void 0,
                        description:
                          typeof entry.description === 'string' ? entry.description : void 0,
                      };
                    }
                  } catch {}
                if (
                  typeof pageTools.listNamespaces === 'function' &&
                  typeof pageTools.version === 'string'
                ) {
                  for (const namespace of pageTools.listNamespaces()) {
                    const namespaceObject = pageTools.getNamespace(namespace) ?? {};
                    if (!namespaceObject || typeof namespaceObject !== 'object') continue;
                    const instanceIds = namespaceObject.listInstances?.() ?? [];
                    const namespaceMetadata = namespaceMetadataById[namespace] ?? {};
                    for (const instanceId of instanceIds) {
                      const tools = namespaceObject.getInstance?.(instanceId)?.listTools?.() ?? [];
                      if (Array.isArray(tools) && tools.length > 0)
                        entries.push({
                          namespace,
                          namespaceTitle: namespaceMetadata.title,
                          namespaceDescription: namespaceMetadata.description,
                          instanceId,
                          tools,
                        });
                    }
                    if (
                      instanceIds.length === 0 &&
                      typeof namespaceObject.listTools === 'function'
                    ) {
                      const tools = namespaceObject.listTools();
                      if (Array.isArray(tools) && tools.length > 0)
                        entries.push({
                          namespace,
                          namespaceTitle: namespaceMetadata.title,
                          namespaceDescription: namespaceMetadata.description,
                          instanceId: 'default',
                          tools,
                        });
                    }
                  }
                  return entries;
                }
                if (typeof pageTools.listTools === 'function') {
                  const tools = pageTools.listTools();
                  if (Array.isArray(tools) && tools.length > 0) {
                    const namespace = String(pageTools.namespace || 'page');
                    const namespaceMetadata = namespaceMetadataById[namespace] ?? {};
                    entries.push({
                      namespace,
                      namespaceTitle: namespaceMetadata.title,
                      namespaceDescription: namespaceMetadata.description,
                      instanceId: String(pageTools.instanceId || 'default'),
                      tools,
                    });
                  }
                }
                return entries;
              },
            })
          )[0]?.result ?? []
        );
      },
      async executePageTool(tabId, pageToolName, args, namespace, instanceId) {
        const serializedInstanceId = instanceId ?? null;
        return (
          (
            await chrome.scripting.executeScript({
              target: { tabId },
              world: 'MAIN',
              func: async (name, input, ns, instId) => {
                const contextWindow = window;
                const pageTools =
                  contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
                if (!pageTools || typeof pageTools !== 'object')
                  return {
                    ok: false,
                    error: 'No Page Context Bridge object available on this page',
                  };
                if (
                  typeof pageTools.listNamespaces === 'function' &&
                  typeof pageTools.version === 'string'
                ) {
                  const namespaceObject = pageTools.getNamespace(ns) ?? {};
                  if (!namespaceObject || typeof namespaceObject !== 'object')
                    return {
                      ok: false,
                      error: `Namespace not found: ${ns}`,
                    };
                  const listInstances = namespaceObject.listInstances;
                  const getInstance = namespaceObject.getInstance;
                  const actualInstance = instId
                    ? getInstance?.(instId)
                    : getInstance?.(String(listInstances?.()?.[0] ?? ''));
                  if (!actualInstance || typeof actualInstance.callTool !== 'function')
                    return {
                      ok: false,
                      error: `Instance not found: ${instId ?? 'default'}`,
                    };
                  try {
                    const callFn = actualInstance.callTool;
                    return {
                      ok: true,
                      result: await Promise.resolve(callFn(name, input)),
                    };
                  } catch (error) {
                    return {
                      ok: false,
                      error: error instanceof Error ? error.message : String(error),
                    };
                  }
                }
                if (typeof pageTools.callTool !== 'function')
                  return {
                    ok: false,
                    error: 'Page Context Bridge has no callable API',
                  };
                try {
                  return {
                    ok: true,
                    result: await Promise.resolve(pageTools.callTool(name, input)),
                  };
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                  };
                }
              },
              args: [pageToolName, args, namespace, serializedInstanceId],
            })
          )[0]?.result ?? {
            ok: false,
            error: 'No result returned',
          }
        );
      },
    };
  }
  /**
   * Firefox backend：manifest/resource/skill/discover/execute 走 content-script main-world broker。
   */
  function createFirefoxProbePageAccessBackend() {
    return {
      async getRawManifest(tabId) {
        try {
          return await sendTabRequest(tabId, FIREFOX_READONLY_METHODS.manifestGet);
        } catch (error) {
          return await fallbackToMainWorldIfFirefoxReadonlyFailed(error, 'getRawManifest', () =>
            chromiumPageAccessBackend.getRawManifest(tabId),
          );
        }
      },
      async readResource(tabId, resourceId) {
        try {
          return await sendTabRequest(tabId, FIREFOX_READONLY_METHODS.resourceRead, { resourceId });
        } catch (error) {
          return await fallbackToMainWorldIfFirefoxReadonlyFailed(error, 'readResource', () =>
            chromiumPageAccessBackend.readResource(tabId, resourceId),
          );
        }
      },
      async getSkill(tabId, skillId, input) {
        try {
          return await sendTabRequest(tabId, FIREFOX_READONLY_METHODS.skillGet, {
            skillId,
            input: input ?? {},
          });
        } catch (error) {
          return await fallbackToMainWorldIfFirefoxReadonlyFailed(error, 'getSkill', () =>
            chromiumPageAccessBackend.getSkill(tabId, skillId, input),
          );
        }
      },
      async ensureBridgeHost() {},
      async discoverTools(tabId) {
        try {
          return await sendTabRequest(tabId, FIREFOX_READONLY_METHODS.pageToolsDiscover);
        } catch (error) {
          return await fallbackToMainWorldIfFirefoxReadonlyFailed(error, 'discoverTools', () =>
            chromiumPageAccessBackend.discoverTools(tabId),
          );
        }
      },
      async executePageTool(tabId, pageToolName, args, namespace, instanceId) {
        try {
          return await sendTabRequest(tabId, FIREFOX_READONLY_METHODS.pageToolExecute, {
            pageToolName,
            args,
            namespace,
            instanceId,
          });
        } catch (error) {
          return await fallbackToMainWorldIfFirefoxReadonlyFailed(error, 'executePageTool', () =>
            chromiumPageAccessBackend.executePageTool(
              tabId,
              pageToolName,
              args,
              namespace,
              instanceId,
            ),
          );
        }
      },
    };
  }
  function createUnsupportedPageAccessBackend(params) {
    const fail = (operation) => {
      throw new PageAccessBackendError({
        backendKind: params.kind,
        operation,
        reason: params.reason,
      });
    };
    return {
      async getRawManifest() {
        return fail('getRawManifest');
      },
      async readResource() {
        return fail('readResource');
      },
      async getSkill() {
        return fail('getSkill');
      },
      async ensureBridgeHost() {},
      async discoverTools() {
        return fail('discoverTools');
      },
      async executePageTool() {
        return fail('executePageTool');
      },
    };
  }
  var chromiumPageAccessBackend = createChromiumPageAccessBackend();
  var firefoxProbePageAccessBackend = createFirefoxProbePageAccessBackend();
  var unsupportedPageAccessBackend = createUnsupportedPageAccessBackend({
    kind: 'unsupported',
    reason: 'Current runtime does not provide a supported page access backend.',
  });
  function selectPageAccessBackend(detection = detectPageAccessBackend()) {
    switch (detection.kind) {
      case 'chromium-native-main-world':
        return {
          kind: detection.kind,
          detection,
          backend: chromiumPageAccessBackend,
        };
      case 'firefox-probe':
        return {
          kind: detection.kind,
          detection,
          backend: firefoxProbePageAccessBackend,
        };
      default:
        return {
          kind: detection.kind,
          detection,
          backend: unsupportedPageAccessBackend,
        };
    }
  }
  var selectedPageAccessBackend = selectPageAccessBackend();
  function safeHasChromeScriptingExecuteScript() {
    const maybeChrome = globalThis.chrome;
    if (!isRecord(maybeChrome)) return false;
    const scripting = maybeChrome.scripting;
    if (!isRecord(scripting)) return false;
    return typeof scripting.executeScript === 'function';
  }
  function safeHasBrowserRuntimeGetBrowserInfo() {
    const maybeBrowser = globalThis.browser;
    if (!isRecord(maybeBrowser)) return false;
    const runtime = maybeBrowser.runtime;
    if (!isRecord(runtime)) return false;
    return typeof runtime.getBrowserInfo === 'function';
  }
  async function fallbackToMainWorldIfFirefoxReadonlyFailed(
    error,
    operation,
    runMainWorldFallback,
  ) {
    if (!shouldFallbackFirefoxReadonlyToMainWorld(error)) throw error;
    try {
      return await runMainWorldFallback();
    } catch (fallbackError) {
      throw new Error(
        `Firefox readonly ${operation} failed: ${error instanceof Error ? error.message : String(error)}; MAIN world fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      );
    }
  }
  function shouldFallbackFirefoxReadonlyToMainWorld(error) {
    if (!safeHasChromeScriptingExecuteScript()) return false;
    const message = error instanceof Error ? error.message : String(error);
    return /Permission denied to access object/i.test(message);
  }
  function safeGetRuntimeManifest() {
    const maybeChrome = globalThis.chrome;
    if (!isRecord(maybeChrome)) return null;
    const runtime = maybeChrome.runtime;
    if (!isRecord(runtime) || typeof runtime.getManifest !== 'function') return null;
    try {
      const manifest = runtime.getManifest();
      return isRecord(manifest) ? manifest : null;
    } catch {
      return null;
    }
  }
  function safeGetRuntimeUserAgent() {
    const maybeNavigator = globalThis.navigator;
    if (!isRecord(maybeNavigator)) return '';
    return typeof maybeNavigator.userAgent === 'string' ? maybeNavigator.userAgent : '';
  }
  function detectManifestTarget(manifest) {
    if (!isRecord(manifest)) return 'unknown';
    const browserSpecificSettings = manifest.browser_specific_settings;
    if (isRecord(browserSpecificSettings) && isRecord(browserSpecificSettings.gecko))
      return 'firefox';
    const applications = manifest.applications;
    if (isRecord(applications) && isRecord(applications.gecko)) return 'firefox';
    return 'unknown';
  }
  function isRecord(value) {
    return typeof value === 'object' && value !== null;
  }
  //#endregion
  //#region src/bg-page-context.ts
  var pageAccessBackend = selectedPageAccessBackend.backend;
  /**
   * 暴露探测结果给上层观测/测试，避免 Firefox 路径再次被误判为 Chromium。
   */
  var pageAccessBackendKind = selectedPageAccessBackend.kind;
  async function getRawPageContextManifest(tabId) {
    return await pageAccessBackend.getRawManifest(tabId);
  }
  async function readPageContextResource(tabId, resourceId) {
    return await pageAccessBackend.readResource(tabId, resourceId);
  }
  async function getPageContextSkill(tabId, skillId, input) {
    return await pageAccessBackend.getSkill(tabId, skillId, input);
  }
  async function discoverPageToolsInTab(tabId) {
    await pageAccessBackend.ensureBridgeHost(tabId);
    return await pageAccessBackend.discoverTools(tabId);
  }
  async function executePageToolInTab(tabId, pageToolName, args, namespace, instanceId) {
    return await pageAccessBackend.executePageTool(
      tabId,
      pageToolName,
      args,
      namespace,
      instanceId,
    );
  }
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  //#endregion
  //#region ../page-context-tool-executor/dist/executor.js
  /**
   * Tool execution logic: dispatches tool calls to extension providers or page context.
   */
  var cdpAttachedTabs = /* @__PURE__ */ new Set();
  function chromeLastErrorMessage() {
    return chrome.runtime.lastError?.message ?? null;
  }
  function debuggerAttach(debuggee, protocolVersion = '1.3') {
    return new Promise((resolve, reject) => {
      chrome.debugger.attach(debuggee, protocolVersion, () => {
        const msg = chromeLastErrorMessage();
        if (msg) {
          reject(new Error(msg));
          return;
        }
        resolve();
      });
    });
  }
  function debuggerDetach(debuggee) {
    return new Promise((resolve, reject) => {
      chrome.debugger.detach(debuggee, () => {
        if (chromeLastErrorMessage()) {
          resolve();
          return;
        }
        resolve();
      });
    });
  }
  function debuggerSendCommand(debuggee, method, params) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(debuggee, method, params ?? {}, (result) => {
        const msg = chromeLastErrorMessage();
        if (msg) {
          reject(new Error(msg));
          return;
        }
        resolve(result);
      });
    });
  }
  async function ensureCdpAttached(tabId) {
    if (cdpAttachedTabs.has(tabId)) return;
    await debuggerAttach({ tabId });
    cdpAttachedTabs.add(tabId);
  }
  async function waitForTabStatus(tabId, status, timeoutMs) {
    const timeout = Math.max(0, Math.floor(timeoutMs));
    try {
      if ((await chrome.tabs.get(tabId)).status === status) return;
    } catch {}
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(/* @__PURE__ */ new Error(`Timeout waiting for tab ${tabId} status '${status}'`));
      }, timeout);
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId) return;
        if (changeInfo.status === status) {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }
  if (typeof chrome !== 'undefined') {
    chrome.tabs?.onRemoved?.addListener?.((tabId) => {
      if (!cdpAttachedTabs.has(tabId)) return;
      debuggerDetach({ tabId }).finally(() => {
        cdpAttachedTabs.delete(tabId);
      });
    });
    chrome.debugger?.onDetach?.addListener?.((source) => {
      if (typeof source.tabId === 'number') cdpAttachedTabs.delete(source.tabId);
    });
  }
  /** Extension-side tool providers. */
  var extensionToolProviders = [new BuiltinExtensionProvider()];
  /** Build a ServiceWorkerToolContext backed by extension APIs. */
  var serviceWorkerContext = {
    async getActiveTabId() {
      return (
        (
          await chrome.tabs.query({
            active: true,
            currentWindow: true,
          })
        )[0]?.id ?? null
      );
    },
    async listTabs() {
      return (await chrome.tabs.query({})).map((tab) => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
      }));
    },
    async captureVisibleTab(format, quality) {
      return await chrome.tabs.captureVisibleTab({
        format,
        quality,
      });
    },
    async navigateTab(tabId, url) {
      await chrome.tabs.update(tabId, { url });
    },
    async reloadTab(tabId, bypassCache) {
      if (bypassCache) await chrome.tabs.reload(tabId, { bypassCache: true });
      else await chrome.tabs.reload(tabId);
    },
    async goBack(tabId) {
      await chrome.tabs.goBack(tabId);
    },
    async goForward(tabId) {
      await chrome.tabs.goForward(tabId);
    },
    async createTab(url, active) {
      const tab = await chrome.tabs.create({
        url,
        active: active ?? true,
      });
      if (!tab.id) throw new Error('Failed to create tab (missing tab.id)');
      return { tabId: tab.id };
    },
    async closeTab(tabId) {
      await chrome.tabs.remove(tabId);
    },
    async waitForTabStatus(tabId, status, timeoutMs) {
      await waitForTabStatus(tabId, status, timeoutMs);
    },
    async cdpSendCommand(tabId, method, params) {
      await ensureCdpAttached(tabId);
      return await debuggerSendCommand({ tabId }, method, params);
    },
    async cdpDetach(tabId) {
      if (!cdpAttachedTabs.has(tabId)) return;
      await debuggerDetach({ tabId });
      cdpAttachedTabs.delete(tabId);
    },
  };
  function getBuiltinToolDefinitions() {
    return extensionToolProviders.flatMap((provider) =>
      provider.getToolDefinitions().map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: def.annotations,
      })),
    );
  }
  /**
   * Execute a tool call by dispatching to the appropriate provider.
   *
   * @param tool Full tool name (e.g., "builtin.list_tabs" or "page.namespace.tool")
   * @param args Tool arguments
   * @param tabId Target tab for page tools / content-script tools
   */
  async function executeToolCall(tool, args, tabId, deps) {
    const resolvedBuiltinTool = resolveBuiltinToolNameAlias(tool);
    const effectiveTool = resolvedBuiltinTool ?? tool;
    for (const provider of extensionToolProviders) {
      const def = provider.getToolDefinitions().find((d) => d.name === effectiveTool);
      if (!def) continue;
      if (def.executionContext === 'service-worker' && provider.executeInServiceWorker) {
        const mergedArgs = { ...args };
        if (tabId != null && args.tabId == null) mergedArgs.tabId = tabId;
        return await provider.executeInServiceWorker(
          effectiveTool,
          mergedArgs,
          serviceWorkerContext,
        );
      }
      if (def.executionContext === 'content-script') {
        if (!deps?.sendTabRequest)
          throw new Error(
            'executeToolCall: sendTabRequest dependency required for content-script tools',
          );
        const targetTabId = tabId ?? (await serviceWorkerContext.getActiveTabId());
        if (!targetTabId)
          throw new RpcProtocolError(RPC_ERROR_CODES.invalidRequest, 'No active tab available');
        return await deps.sendTabRequest(targetTabId, 'extension.tool.execute', {
          tool: effectiveTool,
          args,
          _providerId: provider.id,
        });
      }
    }
    if (resolvedBuiltinTool || tool.startsWith('builtin.'))
      throw new RpcProtocolError(
        RPC_ERROR_CODES.methodNotFound,
        `Builtin tool is unavailable in this browser runtime: ${effectiveTool}`,
      );
    if (effectiveTool.includes('.')) {
      if (!deps?.executePageToolInTab)
        throw new Error('executeToolCall: executePageToolInTab dependency required for page tools');
      return await executePageTool(effectiveTool, args, tabId, deps.executePageToolInTab);
    }
    throw new RpcProtocolError(RPC_ERROR_CODES.methodNotFound, `Unknown tool: ${tool}`);
  }
  async function executePageTool(tool, args, tabId, executePageToolInTab) {
    const parts = tool.split('.');
    const pageToolName = parts.at(-1) ?? tool;
    const namespace = parts.length >= 2 ? parts[0] : 'page';
    const instanceId = parts.length >= 3 ? parts[1] : void 0;
    const targetTabId = tabId ?? (await serviceWorkerContext.getActiveTabId());
    if (!targetTabId) throw new Error('No active tab available');
    const outcome = await executePageToolInTab(
      targetTabId,
      pageToolName,
      args,
      namespace,
      instanceId,
    );
    if (!outcome.ok) throw new Error(outcome.error ?? 'Unknown page tool execution failure');
    return outcome.result ?? {};
  }
  //#endregion
  //#region ../page-context-tool-visibility/dist/registry.js
  function normalizePageToolEntries(rawEntries) {
    return rawEntries.map((entry) => {
      const prefix =
        entry.instanceId !== 'default' ? `${entry.namespace}.${entry.instanceId}` : entry.namespace;
      return {
        namespace: entry.namespace,
        namespaceTitle: entry.namespaceTitle,
        namespaceDescription: entry.namespaceDescription,
        instanceId: entry.instanceId,
        tools: entry.tools.map((tool) => ({
          ...tool,
          name: `${prefix}.${stripExistingPrefix(tool.name, entry.namespace, entry.instanceId)}`,
          _pageTool: true,
          _namespace: entry.namespace,
          _instanceId: entry.instanceId,
        })),
      };
    });
  }
  function mergePageToolEntry(entries, nextEntry) {
    return [
      ...entries.filter(
        (entry) =>
          !(entry.namespace === nextEntry.namespace && entry.instanceId === nextEntry.instanceId),
      ),
      nextEntry,
    ];
  }
  function flattenPageTools(entries) {
    return (entries ?? []).flatMap((entry) =>
      entry.tools.map((tool) => {
        const { _pageTool, _namespace, _instanceId, ...cleanTool } = tool;
        return {
          ...cleanTool,
          namespace: _namespace ?? entry.namespace,
          instanceId: _instanceId ?? entry.instanceId,
        };
      }),
    );
  }
  function stripExistingPrefix(name, namespace, instanceId) {
    const instancePrefix = `${namespace}.${instanceId}.`;
    if (instanceId !== 'default' && name.startsWith(instancePrefix))
      return name.slice(instancePrefix.length);
    const namespacePrefix = `${namespace}.`;
    if (name.startsWith(namespacePrefix)) return name.slice(namespacePrefix.length);
    return name;
  }
  //#endregion
  //#region ../page-context-tool-visibility/dist/preferences.js
  /**
   * Default allowlist for builtin runtime tools.
   *
   * Policy: only enable simple read operations by default.
   * All other builtin runtime tools are disabled unless explicitly enabled in preferences.
   */
  var DEFAULT_ENABLED_BUILTIN_RUNTIME_TOOLS = new Set([
    'builtin.tabs.list_tabs',
    'builtin.page.get_page_info',
    'builtin.dom.get_selected_text',
    'builtin.dom.get_element_text',
    'builtin.dom.get_element_html',
    'builtin.dom.query_elements',
    'builtin.console.get_console_logs',
  ]);
  function getEnabledToolsForTab(entries, preferences, tabId) {
    return (entries ?? []).flatMap((entry) =>
      entry.tools.filter((tool) =>
        isToolEnabled(preferences, {
          root: 'page',
          tabId,
          namespace: tool._namespace ?? entry.namespace,
          instanceId: tool._instanceId ?? entry.instanceId,
          toolName: tool.name,
        }),
      ),
    );
  }
  function getEnabledBuiltinTools(tools, preferences) {
    return tools.filter((tool) => {
      if (isBridgeControlBuiltinTool(tool)) return true;
      return isToolEnabled(preferences, {
        root: 'builtin',
        toolName: tool.name,
      });
    });
  }
  function isToolEnabled(preferences, scope) {
    if (scope.root === 'builtin') {
      if (scope.toolName && isBridgeControlBuiltinToolName(scope.toolName)) return true;
      if (preferences.builtins?.enabled === false) return false;
      if (!scope.toolName) return true;
      if (!scope.toolName.startsWith(`builtin.`)) return false;
      const toolOverrides = preferences.builtins?.tools ?? {};
      if (toolOverrides[scope.toolName] === false) return false;
      if (toolOverrides[scope.toolName] === true) return true;
      return DEFAULT_ENABLED_BUILTIN_RUNTIME_TOOLS.has(scope.toolName);
    }
    if (scope.tabId == null) return true;
    const tabPreference = preferences.tabs?.[String(scope.tabId)];
    if (tabPreference?.enabled === false) return false;
    if (!scope.namespace) return true;
    const namespacePreference = tabPreference?.namespaces?.[scope.namespace];
    if (namespacePreference?.enabled === false) return false;
    if (!scope.instanceId) return true;
    const instancePreference = namespacePreference?.instances?.[scope.instanceId];
    if (instancePreference?.enabled === false) return false;
    if (!scope.toolName) return true;
    return instancePreference?.tools?.[scope.toolName] !== false;
  }
  function setScopeEnabled(preferences, scope, enabled, entries) {
    if (scope.root === 'builtin') {
      const next = {
        ...preferences,
        builtins: {
          ...(preferences.builtins ?? {}),
          tools: { ...(preferences.builtins?.tools ?? {}) },
        },
        tabs: { ...(preferences.tabs ?? {}) },
      };
      if (!scope.toolName) {
        if (!scope.namespace) {
          next.builtins.enabled = enabled;
          if (entries?.builtinTools)
            next.builtins.tools = enabled
              ? buildBuiltinToolOverridesWithValue(entries.builtinTools, true)
              : buildBuiltinToolOverridesWithValue(entries.builtinTools, false);
          else
            next.builtins.tools = enabled ? {} : buildBuiltinToolOverrides(entries?.builtinTools);
          return next;
        }
        applyBuiltinScopeOverrides(next.builtins.tools, entries?.builtinTools, scope, enabled);
        return next;
      }
      if (isBridgeControlBuiltinToolName(scope.toolName)) return next;
      applyBuiltinToolOverride(next.builtins.tools, scope.toolName, enabled);
      return next;
    }
    if (scope.tabId == null) return preferences;
    const next = {
      builtins: preferences.builtins
        ? {
            ...preferences.builtins,
            tools: { ...(preferences.builtins.tools ?? {}) },
          }
        : void 0,
      tabs: { ...(preferences.tabs ?? {}) },
    };
    const tabId = String(scope.tabId);
    const tabPreference = {
      ...(next.tabs?.[tabId] ?? {}),
      namespaces: { ...(next.tabs?.[tabId]?.namespaces ?? {}) },
    };
    next.tabs[tabId] = tabPreference;
    if (!scope.namespace) {
      tabPreference.enabled = enabled;
      tabPreference.namespaces = enabled ? {} : buildTabNamespaceOverrides(entries?.pageEntries);
      return next;
    }
    const namespacePreference = {
      ...(tabPreference.namespaces?.[scope.namespace] ?? {}),
      instances: { ...(tabPreference.namespaces?.[scope.namespace]?.instances ?? {}) },
    };
    tabPreference.namespaces[scope.namespace] = namespacePreference;
    if (!scope.instanceId) {
      namespacePreference.enabled = enabled;
      namespacePreference.instances = enabled
        ? {}
        : buildNamespaceInstanceOverrides(entries?.pageEntries);
      return next;
    }
    const instancePreference = {
      ...(namespacePreference.instances?.[scope.instanceId] ?? {}),
      tools: { ...(namespacePreference.instances?.[scope.instanceId]?.tools ?? {}) },
    };
    namespacePreference.instances[scope.instanceId] = instancePreference;
    if (!scope.toolName) {
      instancePreference.enabled = enabled;
      instancePreference.tools = enabled
        ? {}
        : buildInstanceToolOverrides(entries?.pageEntries?.[0]);
      return next;
    }
    if (enabled) delete instancePreference.tools[scope.toolName];
    else instancePreference.tools[scope.toolName] = false;
    return next;
  }
  function buildBuiltinToolOverrides(tools) {
    return buildBuiltinToolOverridesWithValue(tools, false);
  }
  function buildBuiltinToolOverridesWithValue(tools, value) {
    return Object.fromEntries(
      (tools ?? [])
        .filter((tool) => !isBridgeControlBuiltinTool(tool))
        .map((tool) => [tool.name, value]),
    );
  }
  function applyBuiltinScopeOverrides(overrides, tools, scope, enabled) {
    for (const tool of tools ?? []) {
      if (isBridgeControlBuiltinTool(tool)) continue;
      const path = parseBuiltinToolPath(tool.name);
      if (scope.namespace && path.namespace !== scope.namespace) continue;
      if (scope.instanceId && path.instanceId !== scope.instanceId) continue;
      applyBuiltinToolOverride(overrides, tool.name, enabled);
    }
  }
  function applyBuiltinToolOverride(overrides, toolName, enabled) {
    overrides[toolName] = enabled;
  }
  function buildTabNamespaceOverrides(entries) {
    const overrides = {};
    const entriesByNamespace = /* @__PURE__ */ new Map();
    for (const entry of entries ?? [])
      entriesByNamespace.set(entry.namespace, [
        ...(entriesByNamespace.get(entry.namespace) ?? []),
        entry,
      ]);
    for (const [namespace, namespaceEntries] of entriesByNamespace.entries())
      overrides[namespace] = {
        enabled: false,
        instances: buildNamespaceInstanceOverrides(namespaceEntries),
      };
    return overrides;
  }
  function buildNamespaceInstanceOverrides(entries) {
    return Object.fromEntries(
      (entries ?? []).map((entry) => [
        entry.instanceId,
        {
          enabled: false,
          tools: buildInstanceToolOverrides(entry),
        },
      ]),
    );
  }
  function buildInstanceToolOverrides(entry) {
    return Object.fromEntries((entry?.tools ?? []).map((tool) => [tool.name, false]));
  }
  function buildToolTree(tabs, pageToolsByTab, builtinTools, preferences) {
    const treeTabs = tabs
      .filter((tab) => tab.id != null && (pageToolsByTab.get(tab.id) ?? []).length > 0)
      .map((tab) => buildTabNode(tab, pageToolsByTab.get(tab.id) ?? [], preferences))
      .filter((tab) => tab.totalTools > 0)
      .sort(
        (left, right) =>
          Number(Boolean(right.active)) - Number(Boolean(left.active)) ||
          left.title.localeCompare(right.title),
      );
    const builtins = buildBuiltinNode(builtinTools, preferences);
    return {
      builtins,
      tabs: treeTabs,
      totalTools: builtins.totalTools + treeTabs.reduce((sum, tab) => sum + tab.totalTools, 0),
      enabledTools:
        builtins.enabledTools + treeTabs.reduce((sum, tab) => sum + tab.enabledTools, 0),
    };
  }
  function buildBuiltinNode(tools, preferences) {
    const dedupedByName = /* @__PURE__ */ new Map();
    for (const tool of tools) if (!dedupedByName.has(tool.name)) dedupedByName.set(tool.name, tool);
    const builtinTools = Array.from(dedupedByName.values())
      .map((tool) => {
        const path = parseBuiltinToolPath(tool.name);
        return {
          kind: 'builtin-tool',
          namespace: path.namespace,
          instanceId: path.instanceId,
          toolName: tool.name,
          label: path.label,
          description: tool.description,
          inputSchema: tool.inputSchema,
          enabled: isToolEnabled(preferences, {
            root: 'builtin',
            toolName: tool.name,
          }),
          readOnly: isReadOnlyTool(tool),
          bridgeControl: isBridgeControlBuiltinTool(tool),
        };
      })
      .sort(
        (left, right) =>
          left.namespace.localeCompare(right.namespace) || left.label.localeCompare(right.label),
      );
    const namespacesMap = /* @__PURE__ */ new Map();
    for (const tool of builtinTools) {
      const byInstance = namespacesMap.get(tool.namespace) ?? /* @__PURE__ */ new Map();
      byInstance.set(tool.instanceId, [...(byInstance.get(tool.instanceId) ?? []), tool]);
      namespacesMap.set(tool.namespace, byInstance);
    }
    const namespaces = Array.from(namespacesMap.entries())
      .map(([namespace, byInstance]) => {
        const instances = Array.from(byInstance.entries())
          .map(([instanceId, instanceTools]) => ({
            kind: 'builtin-instance',
            namespace,
            instanceId,
            totalTools: instanceTools.length,
            enabledTools: instanceTools.filter((tool) => tool.enabled).length,
            tools: [...instanceTools].sort((left, right) => left.label.localeCompare(right.label)),
          }))
          .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
        return {
          kind: 'builtin-namespace',
          namespace,
          totalTools: instances.reduce((sum, instance) => sum + instance.totalTools, 0),
          enabledTools: instances.reduce((sum, instance) => sum + instance.enabledTools, 0),
          instances,
        };
      })
      .sort((left, right) => left.namespace.localeCompare(right.namespace));
    return {
      kind: 'builtins',
      totalTools: namespaces.reduce((sum, namespace) => sum + namespace.totalTools, 0),
      enabledTools: namespaces.reduce((sum, namespace) => sum + namespace.enabledTools, 0),
      namespaces,
      tools: builtinTools,
    };
  }
  function parseBuiltinToolPath(toolName) {
    const parts = toolName.split('.');
    if (parts.length >= 3 && parts[0] === 'builtin')
      return {
        namespace: parts[1],
        instanceId: 'default',
        label: parts.slice(2).join('.'),
      };
    const firstDot = toolName.indexOf('.');
    if (firstDot < 0)
      return {
        namespace: 'builtin',
        instanceId: 'default',
        label: toolName,
      };
    return {
      namespace: toolName.slice(0, firstDot) || 'builtin',
      instanceId: 'default',
      label: toolName.slice(firstDot + 1) || toolName,
    };
  }
  function buildTabNode(tab, entries, preferences) {
    const entriesByNamespace = /* @__PURE__ */ new Map();
    for (const entry of entries)
      entriesByNamespace.set(entry.namespace, [
        ...(entriesByNamespace.get(entry.namespace) ?? []),
        entry,
      ]);
    const namespaces = [...entriesByNamespace.entries()]
      .map(([namespace, namespaceEntries]) =>
        buildNamespaceNode(tab.id, namespace, namespaceEntries, preferences),
      )
      .sort((left, right) => left.namespace.localeCompare(right.namespace));
    return {
      kind: 'tab',
      tabId: tab.id,
      title: tab.title || `Tab ${tab.id}`,
      url: tab.url || '',
      active: Boolean(tab.active),
      totalTools: namespaces.reduce((sum, namespace) => sum + namespace.totalTools, 0),
      enabledTools: namespaces.reduce((sum, namespace) => sum + namespace.enabledTools, 0),
      namespaces,
    };
  }
  function buildNamespaceNode(tabId, namespace, entries, preferences) {
    const instances = entries
      .map((entry) => buildInstanceNode(tabId, entry, preferences))
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    return {
      kind: 'namespace',
      tabId,
      namespace,
      title: firstNonEmptyString(entries.map((entry) => entry.namespaceTitle)),
      description: firstNonEmptyString(entries.map((entry) => entry.namespaceDescription)),
      totalTools: instances.reduce((sum, instance) => sum + instance.totalTools, 0),
      enabledTools: instances.reduce((sum, instance) => sum + instance.enabledTools, 0),
      instances,
    };
  }
  function firstNonEmptyString(values) {
    for (const value of values) {
      const trimmedValue = value?.trim();
      if (trimmedValue) return trimmedValue;
    }
  }
  function buildInstanceNode(tabId, entry, preferences) {
    const tools = entry.tools
      .map((tool) => ({
        kind: 'tool',
        tabId,
        namespace: entry.namespace,
        instanceId: entry.instanceId,
        toolName: tool.name,
        label: getDisplayName(tool, entry.namespace, entry.instanceId),
        description: tool.description,
        inputSchema: tool.inputSchema,
        enabled: isToolEnabled(preferences, {
          root: 'page',
          tabId,
          namespace: entry.namespace,
          instanceId: entry.instanceId,
          toolName: tool.name,
        }),
        readOnly: isReadOnlyTool(tool),
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
    return {
      kind: 'instance',
      tabId,
      namespace: entry.namespace,
      instanceId: entry.instanceId,
      totalTools: tools.length,
      enabledTools: tools.filter((tool) => tool.enabled).length,
      tools,
    };
  }
  function getDisplayName(tool, namespace, instanceId) {
    const prefix = instanceId === 'default' ? `${namespace}.` : `${namespace}.${instanceId}.`;
    return tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name;
  }
  function isReadOnlyTool(tool) {
    return Boolean(tool.annotations?.readOnlyHint || tool._meta?.readOnly);
  }
  function isBridgeControlBuiltinTool(tool) {
    if (tool._bridgeControlTool === true) return true;
    return isBridgeControlBuiltinToolName(tool.name);
  }
  function isBridgeControlBuiltinToolName(name) {
    return name.startsWith('extension.') || name.startsWith('feedback.');
  }
  //#endregion
  //#region src/bg-connection-descriptors.ts
  function upsertTabScopedDescriptor(input) {
    const registry = getConnectionRegistry();
    const current = registry.get(input.id);
    const endpoint = input.endpoint ?? `tab:${input.tabId}`;
    if (current) {
      registry.update(input.id, {
        endpoint,
        status: input.status,
        statusReason: input.statusReason ?? null,
        capabilities: input.capabilities ?? current.capabilities,
        meta: {
          ...(current.meta ?? {}),
          tabId: input.tabId,
          ...(input.frameId != null ? { frameId: input.frameId } : {}),
        },
      });
      return;
    }
    registry.register({
      id: input.id,
      kind: input.kind,
      label: input.label,
      endpoint,
      status: input.status,
      statusReason: input.statusReason ?? null,
      capabilities: input.capabilities ?? {},
      meta: {
        tabId: input.tabId,
        ...(input.frameId != null ? { frameId: input.frameId } : {}),
      },
    });
  }
  function getPageToolsDescriptorId(tabId) {
    return `page-tools:${tabId}`;
  }
  function updatePageToolsDescriptor(tabId, status, statusReason) {
    upsertTabScopedDescriptor({
      id: getPageToolsDescriptorId(tabId),
      kind: 'page-tools',
      label: `Page Tools · tab ${tabId}`,
      tabId,
      status,
      statusReason,
      capabilities: {
        reconnect: true,
        disconnect: false,
      },
    });
  }
  function getMainWorldHostDescriptorId(tabId, frameId) {
    return frameId != null ? `main-world-host:${tabId}:${frameId}` : `main-world-host:${tabId}`;
  }
  function updateMainWorldHostDescriptor(tabId, frameId, status, statusReason) {
    upsertTabScopedDescriptor({
      id: getMainWorldHostDescriptorId(tabId, frameId),
      kind: 'main-world-host',
      label:
        frameId != null
          ? `Main World Host · tab ${tabId} · frame ${frameId}`
          : `Main World Host · tab ${tabId}`,
      tabId,
      frameId,
      status,
      statusReason,
      capabilities: {
        reconnect: true,
        disconnect: false,
      },
    });
  }
  function getAgentationDescriptorId(tabId, frameId) {
    return frameId != null
      ? `agentation-main-world-host:${tabId}:${frameId}`
      : `agentation-main-world-host:${tabId}`;
  }
  function updateAgentationDescriptor(tabId, frameId, status, statusReason) {
    upsertTabScopedDescriptor({
      id: getAgentationDescriptorId(tabId, frameId),
      kind: 'agentation-main-world-host',
      label:
        frameId != null
          ? `Agentation Main World · tab ${tabId} · frame ${frameId}`
          : `Agentation Main World · tab ${tabId}`,
      tabId,
      frameId,
      status,
      statusReason,
      capabilities: {
        reconnect: true,
        disconnect: false,
      },
    });
  }
  //#endregion
  //#region src/bg-page-tools.ts
  var PAGE_TOOL_PREFERENCES_KEY = 'pageToolPreferences';
  function createPageToolState() {
    return {
      pageToolPreferences: {},
      pageToolPreferencesReady: null,
      pageToolsByTab: /* @__PURE__ */ new Map(),
      discoveryInFlight: /* @__PURE__ */ new Map(),
      tabReloadDiscoveryInFlight: /* @__PURE__ */ new Map(),
    };
  }
  function getBuiltinTools() {
    const runtimeBuiltins = getBuiltinToolDefinitions().map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations,
    }));
    const bridgeControlBuiltins = collectBridgeControlToolSpecs().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      _bridgeControlTool: true,
    }));
    const deduped = /* @__PURE__ */ new Map();
    for (const tool of [...runtimeBuiltins, ...bridgeControlBuiltins])
      if (!deduped.has(tool.name)) deduped.set(tool.name, tool);
    return Array.from(deduped.values());
  }
  function getAllBuiltinTools() {
    return getBuiltinTools();
  }
  function getAllTools(state) {
    const builtin = getAllBuiltinTools();
    for (const [tabId, entries] of state.pageToolsByTab.entries())
      builtin.push(...flattenPageTools(entries));
    return builtin;
  }
  function ensurePageToolPreferencesLoaded(state) {
    if (!state.pageToolPreferencesReady)
      state.pageToolPreferencesReady = storageLocalGet({ [PAGE_TOOL_PREFERENCES_KEY]: {} }).then(
        (result) => {
          state.pageToolPreferences = result[PAGE_TOOL_PREFERENCES_KEY] ?? {};
        },
      );
    return state.pageToolPreferencesReady;
  }
  async function persistPageToolPreferences(state) {
    await storageLocalSet({ [PAGE_TOOL_PREFERENCES_KEY]: state.pageToolPreferences });
  }
  function publishBuiltinTools(state) {
    ensurePageToolPreferencesLoaded(state).then(() => {
      queueNotification(BRIDGE_METHODS.bridgeBuiltinToolsUpdated, { tools: getAllBuiltinTools() });
    });
  }
  function publishPageToolsForTab(state, tabId) {
    ensurePageToolPreferencesLoaded(state).then(() => {
      queueNotification(BRIDGE_METHODS.bridgePageToolsRegistered, {
        tabId,
        tools: getFlattenedPageToolsForTab(state, tabId),
      });
    });
  }
  async function buildPageToolsTreeResponse(state) {
    return buildToolTree(
      await tabsQuery({}),
      state.pageToolsByTab,
      getBuiltinTools(),
      state.pageToolPreferences,
    );
  }
  function filterManifestByPreferences(state, tabId, manifest) {
    const enabledPageToolNames = new Set(
      getEnabledToolsForTab(state.pageToolsByTab.get(tabId), state.pageToolPreferences, tabId).map(
        (tool) => tool.name,
      ),
    );
    const enabledBuiltinToolNames = new Set(
      getEnabledBuiltinTools(getBuiltinTools(), state.pageToolPreferences).map((tool) => tool.name),
    );
    const enabledNamespaces = new Set(
      manifest.namespaces
        .filter((entry) =>
          isToolEnabled(state.pageToolPreferences, {
            root: 'page',
            tabId,
            namespace: entry.namespace,
          }),
        )
        .map((entry) => entry.namespace),
    );
    return {
      ...manifest,
      namespaces: manifest.namespaces.filter((entry) => enabledNamespaces.has(entry.namespace)),
      resources: manifest.resources.filter((entry) => enabledNamespaces.has(entry.namespace)),
      skills: manifest.skills
        .filter((entry) => enabledNamespaces.has(entry.namespace))
        .map((entry) => ({
          ...entry,
          resourceIds: (entry.resourceIds ?? []).filter((resourceId) =>
            manifest.resources.some(
              (resource) => resource.id === resourceId && enabledNamespaces.has(resource.namespace),
            ),
          ),
          toolNames: (entry.toolNames ?? []).filter(
            (toolName) =>
              enabledPageToolNames.has(toolName) || enabledBuiltinToolNames.has(toolName),
          ),
        })),
    };
  }
  async function discoverPageToolsForTab(
    state,
    tabId,
    installPageContextBridgeHostInMainWorld,
    force = false,
    failOnBackendError = false,
  ) {
    if (!force) {
      const existing = state.discoveryInFlight.get(tabId);
      if (existing) return await existing;
    }
    const discoveryPromise = (async () => {
      state.pageToolsByTab.get(tabId);
      updateMainWorldHostDescriptor(tabId, void 0, 'connecting', 'ensuring-host');
      await ensureMainWorldBridgeHostOnTab(tabId, installPageContextBridgeHostInMainWorld)
        .then(() => {
          updateMainWorldHostDescriptor(tabId, void 0, 'connected', 'host-ready');
        })
        .catch((error) => {
          updateMainWorldHostDescriptor(
            tabId,
            void 0,
            'error',
            error instanceof Error ? error.message : String(error),
          );
          log('Ensure MAIN world host failed before discovery', tabId, error);
        });
      for (const delay of [0, 500, 1500, 3e3]) {
        if (delay > 0) await sleep(delay);
        try {
          const rawEntries = await discoverPageToolsInTab(tabId);
          if (rawEntries.length === 0) {
            updatePageToolsDescriptor(tabId, 'closed', 'no-tools-discovered');
            continue;
          }
          const normalized = normalizePageToolEntries(rawEntries);
          state.pageToolsByTab.set(tabId, normalized);
          updatePageToolsDescriptor(
            tabId,
            'connected',
            `tools=${flattenPageTools(normalized).length}`,
          );
          publishPageToolsForTab(state, tabId);
          return normalized;
        } catch (error) {
          updatePageToolsDescriptor(
            tabId,
            'error',
            error instanceof Error ? error.message : String(error),
          );
          if (failOnBackendError && isPageAccessBackendError(error)) throw error;
          log('Page tool discovery failed', tabId, error);
          break;
        }
      }
      const latestEntries = state.pageToolsByTab.get(tabId) ?? [];
      if (
        pageAccessBackendKind === 'firefox-probe' &&
        latestEntries.some((entry) => Array.isArray(entry.tools) && entry.tools.length > 0)
      ) {
        log('Preserving current Firefox page tools after empty rediscovery', tabId);
        return latestEntries;
      }
      state.pageToolsByTab.delete(tabId);
      updatePageToolsDescriptor(tabId, 'closed', 'cleared-after-empty-discovery');
      return [];
    })();
    state.discoveryInFlight.set(tabId, discoveryPromise);
    try {
      return await discoveryPromise;
    } finally {
      state.discoveryInFlight.delete(tabId);
    }
  }
  function clearPageTools(state, tabId) {
    state.pageToolsByTab.delete(tabId);
    updatePageToolsDescriptor(tabId, 'closed', 'tab-cleared');
    queueNotification(BRIDGE_METHODS.bridgePageToolsUnregistered, { tabId });
  }
  async function discoverPageToolsAfterTabReload(
    state,
    tabId,
    installPageContextBridgeHostInMainWorld,
  ) {
    const existing = state.tabReloadDiscoveryInFlight.get(tabId);
    if (existing) return await existing;
    const discoveryTask = (async () => {
      for (const delay of [0, 2e3]) {
        if (delay > 0) await sleep(delay);
        if (
          (
            await discoverPageToolsForTab(
              state,
              tabId,
              installPageContextBridgeHostInMainWorld,
              true,
              false,
            )
          ).length > 0
        )
          return;
      }
    })().catch((error) => {
      throw error;
    });
    state.tabReloadDiscoveryInFlight.set(tabId, discoveryTask);
    try {
      await discoveryTask;
    } finally {
      state.tabReloadDiscoveryInFlight.delete(tabId);
    }
  }
  function getFlattenedPageToolsForTab(state, tabId) {
    return flattenPageTools(state.pageToolsByTab.get(tabId));
  }
  //#endregion
  //#region src/context-manifest-filter-debug.ts
  function buildContextManifestFilterDebug(
    rawManifest,
    effectiveManifest,
    enabledPageToolNames,
    enabledBuiltinToolNames,
  ) {
    const rawNamespaces = rawManifest?.namespaces ?? [];
    const effectiveNamespaces = new Set(
      (effectiveManifest?.namespaces ?? []).map((entry) => entry.namespace),
    );
    const hiddenNamespaces = rawNamespaces
      .filter((entry) => !effectiveNamespaces.has(entry.namespace))
      .map((entry) => ({
        id: entry.namespace,
        reason: 'namespace_disabled',
      }));
    const hiddenNamespaceSet = new Set(hiddenNamespaces.map((entry) => entry.id));
    const rawResources = rawManifest?.resources ?? [];
    const effectiveResources = new Set(
      (effectiveManifest?.resources ?? []).map((entry) => entry.id),
    );
    const hiddenResources = rawResources
      .filter((entry) => !effectiveResources.has(entry.id))
      .map((entry) => ({
        id: entry.id,
        reason: hiddenNamespaceSet.has(entry.namespace) ? 'namespace_disabled' : 'unknown',
      }));
    const rawSkills = rawManifest?.skills ?? [];
    const effectiveSkills = new Map(
      (effectiveManifest?.skills ?? []).map((entry) => [entry.id, entry]),
    );
    return {
      hiddenNamespaces,
      hiddenResources,
      hiddenSkills: rawSkills
        .filter((entry) => !effectiveSkills.has(entry.id))
        .map((entry) => ({
          id: entry.id,
          reason: hiddenNamespaceSet.has(entry.namespace) ? 'namespace_disabled' : 'unknown',
        })),
      trimmedSkillTools: rawSkills
        .map((entry) => {
          const effective = effectiveSkills.get(entry.id);
          if (!effective) return null;
          const effectiveTools = new Set(effective.toolNames ?? []);
          const removedTools = (entry.toolNames ?? [])
            .filter((toolName) => !effectiveTools.has(toolName))
            .map((toolName) => ({
              id: toolName,
              reason: classifyToolReason(toolName, enabledPageToolNames, enabledBuiltinToolNames),
            }));
          if (removedTools.length === 0) return null;
          return {
            skillId: entry.id,
            removedTools,
          };
        })
        .filter((entry) => entry !== null),
      sceneChanged: (rawManifest?.scene ?? '') !== (effectiveManifest?.scene ?? ''),
    };
  }
  function classifyToolReason(toolName, enabledPageToolNames, enabledBuiltinToolNames) {
    if (toolName.includes('.'))
      return enabledPageToolNames.has(toolName) ? 'unknown' : 'page_tool_disabled';
    return enabledBuiltinToolNames.has(toolName) ? 'unknown' : 'builtin_tool_disabled';
  }
  //#endregion
  //#region src/bg-ws-handlers.ts
  /**
   * WS entry point and extension control method aggregator.
   * Handles only routing and orchestration; holds no implicit global state outside this module.
   */
  function createWsHandlers(deps) {
    function isConnectedStatus(status) {
      return status === 'connected' || status === 'reachable';
    }
    function descriptorToScopedStatus(descriptorId) {
      const descriptor = getConnectionRegistry().get(descriptorId);
      if (!descriptor) return null;
      return {
        tenantId:
          typeof descriptor.meta?.tenantId === 'string'
            ? descriptor.meta.tenantId
            : descriptor.id.replace(/^opencode-bridge-ws:/, ''),
        wsUrl: descriptor.endpoint,
        connected: isConnectedStatus(descriptor.status),
        bridgeSessionId:
          typeof descriptor.meta?.bridgeSessionId === 'string'
            ? descriptor.meta.bridgeSessionId
            : null,
      };
    }
    function assertToolEnabledForExecution(toolName, tabId) {
      const effectiveBuiltinToolName = resolveBuiltinToolNameAlias(toolName);
      if (effectiveBuiltinToolName) {
        if (
          !getEnabledBuiltinTools(getBuiltinTools(), deps.pageToolState.pageToolPreferences).some(
            (tool) => tool.name === effectiveBuiltinToolName,
          )
        )
          throw new Error(`Tool is disabled by preferences: ${effectiveBuiltinToolName}`);
        return effectiveBuiltinToolName;
      }
      if (tabId != null && toolName.includes('.')) {
        if (
          !getEnabledToolsForTab(
            deps.pageToolState.pageToolsByTab.get(tabId),
            deps.pageToolState.pageToolPreferences,
            tabId,
          ).some((tool) => tool.name === toolName)
        )
          throw new Error(`Tool is disabled by preferences: ${toolName}`);
      }
      return toolName;
    }
    async function ensurePageToolReadyForExecution(toolName, tabId) {
      if (resolveBuiltinToolNameAlias(toolName))
        return assertToolEnabledForExecution(toolName, tabId);
      if (tabId == null || !toolName.includes('.'))
        return assertToolEnabledForExecution(toolName, tabId);
      if (
        !(deps.pageToolState.pageToolsByTab.get(tabId) ?? []).some((entry) =>
          entry.tools.some((tool) => tool.name === toolName),
        )
      )
        await discoverPageToolsForTab(
          deps.pageToolState,
          tabId,
          deps.installPageContextBridgeHostInMainWorld,
          true,
          false,
        ).catch(() => void 0);
      return assertToolEnabledForExecution(toolName, tabId);
    }
    const executePageToolInTabForExecutor = async (tabId, name, args, namespace, instanceId) => {
      return await executePageToolInTab(tabId, name, args, namespace ?? 'page', instanceId);
    };
    async function onToolCall(params, requestId) {
      const call = params;
      deps.inFlightToolCalls.set(requestId, call.tool);
      try {
        return await executeToolCall(
          await ensurePageToolReadyForExecution(call.tool, call.tabId),
          call.args ?? {},
          call.tabId,
          {
            executePageToolInTab: executePageToolInTabForExecutor,
            sendTabRequest,
          },
        );
      } finally {
        deps.inFlightToolCalls.delete(requestId);
      }
    }
    async function onToolsList() {
      return getAllTools(deps.pageToolState);
    }
    async function onTabsList() {
      return await deps.listTabs();
    }
    function buildExtensionStatusResponse(params) {
      const registry = getConnectionRegistry();
      const sessionId = params?.sessionId?.trim();
      if (sessionId) {
        const scopedStatus =
          descriptorToScopedStatus(getScopedBridgeDescriptorId(sessionId)) ??
          deps.scopedBridgeConnection.getStatus(sessionId);
        return {
          connected: scopedStatus.connected,
          wsUrl: null,
          pendingToolCalls: deps.inFlightToolCalls.size,
          sessionId,
          scopedSessions: [scopedStatus],
        };
      }
      const defaultDescriptor = registry.get(DEFAULT_BRIDGE_DESCRIPTOR_ID);
      const scopedSessions = registry
        .list()
        .filter((descriptor) => descriptor.kind === 'opencode-bridge-ws')
        .map((descriptor) => descriptorToScopedStatus(descriptor.id))
        .filter((status) => status !== null);
      return {
        connected:
          defaultDescriptor != null
            ? isConnectedStatus(defaultDescriptor.status)
            : deps.bridgeConnection.getWsReady(),
        wsUrl: null,
        pendingToolCalls: deps.inFlightToolCalls.size,
        sessionId: deps.bridgeConnection.getSessionId(),
        scopedSessions,
      };
    }
    async function handleExtensionReconnect(params) {
      const payload = params;
      const tenantId = payload?.sessionId?.trim();
      const wsUrl = payload?.wsUrl?.trim();
      if (tenantId) {
        if (payload?.disconnect) {
          await deps.scopedBridgeConnection.disconnect(tenantId);
          return { ok: true };
        }
        if (!wsUrl)
          throw new Error(`wsUrl is required when reconnecting scoped session "${tenantId}"`);
        await deps.scopedBridgeConnection.connect(tenantId, wsUrl, {
          onToolCall,
          onToolsList,
          onTabsList,
          onExtensionRequest: onBridgeWsExtensionRequest,
        });
        return { ok: true };
      }
      await deps.bridgeConnection.forceReconnect(
        onToolCall,
        onToolsList,
        onTabsList,
        onBridgeWsExtensionRequest,
      );
      return { ok: true };
    }
    function handleExtensionPageToolsGet(params) {
      const tabId = Number(params?.tabId ?? 0);
      return { tools: getFlattenedPageToolsForTab(deps.pageToolState, tabId) };
    }
    async function handleExtensionPageToolsTreeGet() {
      return await buildPageToolsTreeResponse(deps.pageToolState);
    }
    async function handleExtensionPageToolsRefresh(params) {
      const tabId = Number(params?.tabId ?? 0);
      if (!tabId) throw new Error('No tabId provided');
      await discoverPageToolsForTab(
        deps.pageToolState,
        tabId,
        deps.installPageContextBridgeHostInMainWorld,
        true,
        true,
      );
      return { tools: getFlattenedPageToolsForTab(deps.pageToolState, tabId) };
    }
    async function handleExtensionContextManifestGet(params) {
      const tabId = Number(params?.tabId ?? 0);
      if (!tabId) throw new Error('No tabId provided');
      const rawManifest = await getRawPageContextManifest(tabId);
      const manifest = rawManifest
        ? filterManifestByPreferences(deps.pageToolState, tabId, rawManifest)
        : null;
      return {
        manifest,
        rawManifest,
        debug: buildContextManifestFilterDebug(
          rawManifest,
          manifest,
          new Set(
            getEnabledToolsForTab(
              deps.pageToolState.pageToolsByTab.get(tabId),
              deps.pageToolState.pageToolPreferences,
              tabId,
            ).map((tool) => tool.name),
          ),
          new Set(
            getEnabledBuiltinTools(getBuiltinTools(), deps.pageToolState.pageToolPreferences).map(
              (tool) => tool.name,
            ),
          ),
        ),
      };
    }
    async function handleExtensionContextResourceRead(params) {
      const payload = params;
      const tabId = Number(payload.tabId ?? 0);
      if (!tabId || !payload.resourceId) throw new Error('tabId and resourceId are required');
      return await readPageContextResource(tabId, payload.resourceId);
    }
    async function handleExtensionContextSkillGet(params) {
      const payload = params;
      const tabId = Number(payload.tabId ?? 0);
      if (!tabId || !payload.skillId) throw new Error('tabId and skillId are required');
      return { prompt: await getPageContextSkill(tabId, payload.skillId, payload.input) };
    }
    async function handleExtensionPageToolsSetEnabled(params) {
      const payload = params;
      const pageEntries =
        payload.root === 'builtin' || payload.tabId == null
          ? void 0
          : (deps.pageToolState.pageToolsByTab.get(payload.tabId) ?? []).filter((entry) => {
              if (payload.namespace && entry.namespace !== payload.namespace) return false;
              if (payload.instanceId && entry.instanceId !== payload.instanceId) return false;
              return true;
            });
      deps.pageToolState.pageToolPreferences = setScopeEnabled(
        deps.pageToolState.pageToolPreferences,
        payload,
        payload.enabled,
        {
          builtinTools: payload.root === 'builtin' ? getBuiltinTools() : void 0,
          pageEntries,
        },
      );
      await persistPageToolPreferences(deps.pageToolState);
      if (payload.root === 'builtin') publishBuiltinTools(deps.pageToolState);
      else if (payload.tabId != null) publishPageToolsForTab(deps.pageToolState, payload.tabId);
      return await buildPageToolsTreeResponse(deps.pageToolState);
    }
    async function handleExtensionToolDebugCall(params) {
      const payload = params;
      if (!payload.toolName) throw new Error('No toolName provided');
      if (
        payload.toolName.startsWith('builtin.') &&
        !getBuiltinTools().some((tool) => tool.name === payload.toolName)
      )
        return {
          ok: false,
          error: `Builtin tool is unavailable in this browser runtime: ${payload.toolName}`,
        };
      try {
        return {
          ok: true,
          result: await executeToolCall(
            assertToolEnabledForExecution(payload.toolName, payload.tabId),
            payload.args ?? {},
            payload.tabId,
            {
              executePageToolInTab: executePageToolInTabForExecutor,
              sendTabRequest,
            },
          ),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    async function onBridgeWsExtensionRequest(method, params) {
      await ensurePageToolPreferencesLoaded(deps.pageToolState);
      switch (method) {
        case BRIDGE_METHODS.extensionStatusGet:
          return buildExtensionStatusResponse(params);
        case BRIDGE_METHODS.extensionReconnect:
          return await handleExtensionReconnect(params);
        case BRIDGE_METHODS.extensionPageToolsGet:
          return handleExtensionPageToolsGet(params);
        case BRIDGE_METHODS.extensionPageToolsTreeGet:
          return await handleExtensionPageToolsTreeGet();
        case BRIDGE_METHODS.extensionPageToolsDiscover:
        case BRIDGE_METHODS.extensionPageToolsRefresh:
          return await handleExtensionPageToolsRefresh(params);
        case BRIDGE_METHODS.extensionPageToolsSetEnabled:
          return await handleExtensionPageToolsSetEnabled(params);
        case BRIDGE_METHODS.extensionMainWorldHostEnsure: {
          const target = getMainWorldInjectionTarget(params);
          updateMainWorldHostDescriptor(
            target.tabId,
            target.frameId,
            'connecting',
            'ensuring-host',
          );
          try {
            const result = await ensureMainWorldBridgeHostOnTab(
              target.tabId,
              deps.installPageContextBridgeHostInMainWorld,
              target.frameId,
            );
            updateMainWorldHostDescriptor(target.tabId, target.frameId, 'connected', 'host-ready');
            return result;
          } catch (error) {
            updateMainWorldHostDescriptor(
              target.tabId,
              target.frameId,
              'error',
              error instanceof Error ? error.message : String(error),
            );
            throw error;
          }
        }
        case BRIDGE_METHODS.extensionAgentationMainEnsure: {
          const target = getMainWorldInjectionTarget(params);
          updateAgentationDescriptor(target.tabId, target.frameId, 'connecting', 'injecting');
          try {
            const result = await ensureAgentationMainOnTab(target.tabId, target.frameId);
            updateAgentationDescriptor(target.tabId, target.frameId, 'connected', 'ready');
            return result;
          } catch (error) {
            updateAgentationDescriptor(
              target.tabId,
              target.frameId,
              'error',
              error instanceof Error ? error.message : String(error),
            );
            throw error;
          }
        }
        case BRIDGE_METHODS.extensionContextManifestGet:
          return await handleExtensionContextManifestGet(params);
        case BRIDGE_METHODS.extensionContextResourceRead:
          return await handleExtensionContextResourceRead(params);
        case BRIDGE_METHODS.extensionContextSkillGet:
          return await handleExtensionContextSkillGet(params);
        case BRIDGE_METHODS.extensionToolDebugCall:
          return await handleExtensionToolDebugCall(params);
        case CONNECTION_METHODS.list:
          return await getConnectionRegistry().handleList();
        case CONNECTION_METHODS.subscribe:
          return await getConnectionRegistry().handleSubscribe();
        case CONNECTION_METHODS.action:
          return await getConnectionRegistry().handleAction(params);
        default:
          throw new RpcProtocolError(
            RPC_ERROR_CODES.methodNotFound,
            `Unhandled WS method: ${method}`,
          );
      }
    }
    return {
      onToolCall,
      onToolsList,
      onTabsList,
      onBridgeWsExtensionRequest,
      buildExtensionStatusResponse,
      handleExtensionReconnect,
      handleExtensionPageToolsGet,
      handleExtensionPageToolsTreeGet,
      handleExtensionPageToolsRefresh,
      handleExtensionContextManifestGet,
      handleExtensionContextResourceRead,
      handleExtensionContextSkillGet,
      handleExtensionPageToolsSetEnabled,
      handleExtensionToolDebugCall,
    };
  }
  //#endregion
  //#region src/bg-feedback-context.ts
  /**
   * Lightweight context collection during feedback creation.
   * Only reads stable and low-cost information to avoid introducing fragile DOM anchor logic.
   */
  async function captureActiveTabFeedbackContext(sender, target) {
    const tab = await resolveFeedbackTab(sender, target);
    if (!tab?.id || !tab.url) throw new Error('No tab available for feedback');
    return {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      selectedText: await readSelectedText(tab.id),
    };
  }
  async function resolveFeedbackTab(sender, target) {
    if (typeof target?.tabId === 'number') return await tabsGet(target.tabId);
    const senderTab = sender?.tab;
    const senderTabId = senderTab?.id;
    if (typeof senderTabId === 'number') {
      if (senderTab?.url) return senderTab;
      return await tabsGet(senderTabId);
    }
    const [activeTab] = await tabsQuery(
      typeof target?.windowId === 'number'
        ? {
            active: true,
            windowId: target.windowId,
          }
        : {
            active: true,
            currentWindow: true,
          },
    );
    return activeTab;
  }
  async function readSelectedText(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const win = window;
          const fromSelection = win.getSelection?.()?.toString?.() ?? '';
          if (fromSelection.trim()) return fromSelection;
          const activeElement = win.document.activeElement;
          if (
            !(
              activeElement instanceof HTMLInputElement ||
              activeElement instanceof HTMLTextAreaElement
            )
          )
            return '';
          const start = activeElement.selectionStart ?? 0;
          const end = activeElement.selectionEnd ?? 0;
          if (start === end) return '';
          return activeElement.value.slice(start, end);
        },
      });
      return String(results[0]?.result ?? '').trim() || void 0;
    } catch {
      return;
    }
  }
  //#endregion
  //#region src/background-feedback-adapters.ts
  function buildFeedbackAnnotationCreateParams(payload, context) {
    return {
      body: payload.body.trim(),
      priority: payload.priority,
      tabId: context.tabId,
      url: context.url,
      title: context.title,
      selectedText: payload.selectedText?.trim() || context.selectedText,
      uiAnchor: normalizeFeedbackUiAnchor(payload.uiAnchor ?? payload.anchor),
    };
  }
  function buildFeedbackAnnotationUpdateParams(payload) {
    return {
      annotationId: payload.annotationId.trim(),
      body: payload.body.trim(),
      priority: payload.priority,
    };
  }
  function normalizeFeedbackUiAnchor(anchor) {
    if (!anchor) return;
    const framePath = Array.isArray(anchor.framePath)
      ? anchor.framePath.filter((item) => Number.isInteger(item) && item >= 0)
      : void 0;
    const textQuote = anchor.textQuote?.trim();
    const normalized = {
      elementId: anchor.elementId?.trim() || void 0,
      cssSelector: anchor.cssSelector?.trim() || void 0,
      xpath: anchor.xpath?.trim() || void 0,
      textQuote: textQuote || void 0,
      framePath: framePath?.length ? framePath : void 0,
      rect: anchor.rect,
      textRange: anchor.textRange,
      meta: anchor.meta && Object.keys(anchor.meta).length > 0 ? anchor.meta : void 0,
    };
    if (
      normalized.elementId ||
      normalized.cssSelector ||
      normalized.xpath ||
      normalized.textQuote ||
      normalized.framePath ||
      normalized.rect ||
      normalized.textRange ||
      normalized.meta
    )
      return normalized;
  }
  //#endregion
  //#region src/bg-runtime-handlers.ts
  /**
   * runtime.onMessage business handler factory.
   * This module handles only protocol dispatch and parameter validation;
   * all state is provided via dependency injection.
   */
  var EXTENSION_E2E_REPORT_METHOD = 'extension.e2e.report';
  function withSenderTabId(params, sender) {
    const senderTabId = sender.tab?.id;
    if (!senderTabId) return params;
    if (params == null) return { tabId: senderTabId };
    if (typeof params !== 'object') return params;
    const record = params;
    if (typeof record.tabId === 'number' && Number.isFinite(record.tabId)) return params;
    return {
      ...record,
      tabId: senderTabId,
    };
  }
  /**
   * runtime 绑定字段归一化：
   * - 新字段 tabId 优先
   * - 兼容字段 boundTabId 次之
   * - windowId 仅在存在时透传
   */
  function normalizeRuntimeExplicitTabBinding(input) {
    if (input == null) return {};
    return {
      ...(input.tabId != null
        ? { tabId: input.tabId }
        : input.boundTabId != null
          ? { tabId: input.boundTabId }
          : {}),
      ...(input.windowId != null ? { windowId: input.windowId } : {}),
    };
  }
  async function postFirefoxE2EReport(params) {
    const payload = params;
    const reportUrl =
      typeof payload.reportUrl === 'string' && payload.reportUrl.trim()
        ? payload.reportUrl.trim()
        : '';
    if (!reportUrl) throw new Error('E2E reportUrl is required');
    await fetch(reportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload.payload ?? {}),
    });
    return { ok: true };
  }
  function createRuntimeMessageHandler(deps) {
    return async (message, sender) => {
      await ensurePageToolPreferencesLoaded(deps.pageToolState);
      switch (message.method) {
        case EXTENSION_E2E_REPORT_METHOD:
          return await postFirefoxE2EReport(message.params);
        case BRIDGE_METHODS.extensionStatusGet:
          return deps.extensionControlHandlers.buildExtensionStatusResponse(message.params);
        case CONNECTION_METHODS.list:
          return await getConnectionRegistry().handleList();
        case CONNECTION_METHODS.subscribe:
          return await getConnectionRegistry().handleSubscribe();
        case CONNECTION_METHODS.action:
          return await getConnectionRegistry().handleAction(message.params);
        case BRIDGE_METHODS.extensionReconnect:
          return await deps.extensionControlHandlers.handleExtensionReconnect(message.params);
        case BRIDGE_METHODS.extensionPageToolsGet:
          return deps.extensionControlHandlers.handleExtensionPageToolsGet(message.params);
        case BRIDGE_METHODS.extensionPageToolsTreeGet:
          return await deps.extensionControlHandlers.handleExtensionPageToolsTreeGet();
        case BRIDGE_METHODS.extensionPageToolsDiscover:
        case BRIDGE_METHODS.extensionPageToolsRefresh:
          return await deps.extensionControlHandlers.handleExtensionPageToolsRefresh(
            withSenderTabId(message.params, sender),
          );
        case BRIDGE_METHODS.extensionContextManifestGet:
          return await deps.extensionControlHandlers.handleExtensionContextManifestGet(
            message.params,
          );
        case BRIDGE_METHODS.extensionContextResourceRead:
          return await deps.extensionControlHandlers.handleExtensionContextResourceRead(
            message.params,
          );
        case BRIDGE_METHODS.extensionContextSkillGet:
          return await deps.extensionControlHandlers.handleExtensionContextSkillGet(message.params);
        case BRIDGE_METHODS.extensionFeedbackStateSnapshot: {
          const payload = message.params ?? {};
          const runtimeBinding = normalizeRuntimeExplicitTabBinding(payload);
          const params = {
            tabId: runtimeBinding.tabId,
            sessionId: payload.sessionId,
          };
          if (params.tabId == null && !params.sessionId)
            params.tabId = (
              await captureActiveTabFeedbackContext(sender, {
                windowId: runtimeBinding.windowId,
              }).catch(() => null)
            )?.tabId;
          return await deps.requestBridgeMethod(BRIDGE_METHODS.feedbackStateSnapshot, params);
        }
        case BRIDGE_METHODS.extensionFeedbackStateDelta: {
          const payload = message.params ?? {};
          const afterSeq = Number(payload.afterSeq ?? 0);
          if (!Number.isFinite(afterSeq) || afterSeq < 0)
            throw new Error('Feedback delta afterSeq must be a non-negative number');
          const params = {
            ...payload,
            afterSeq,
          };
          return await deps.requestBridgeMethod(BRIDGE_METHODS.feedbackStateDelta, params);
        }
        case BRIDGE_METHODS.extensionFeedbackAnnotationCreate: {
          const payload = message.params ?? {};
          if (!payload.body?.trim()) throw new Error('Feedback body is required');
          if (!payload.priority) throw new Error('Feedback priority is required');
          const context = await captureActiveTabFeedbackContext(
            sender,
            normalizeRuntimeExplicitTabBinding(payload),
          );
          if (payload.uiAnchor)
            payload.uiAnchor = await enrichUiAnchorReactMetaInMainWorld(
              context.tabId,
              payload.uiAnchor,
            );
          return await deps.requestBridgeMethod(
            BRIDGE_METHODS.feedbackAnnotationCreate,
            buildFeedbackAnnotationCreateParams(payload, context),
          );
        }
        case BRIDGE_METHODS.extensionFeedbackAnnotationUpdate: {
          const payload = message.params ?? {};
          if (!payload.annotationId?.trim()) throw new Error('Feedback annotationId is required');
          if (!payload.body?.trim()) throw new Error('Feedback body is required');
          if (!payload.priority) throw new Error('Feedback priority is required');
          return await deps.requestBridgeMethod(
            BRIDGE_METHODS.feedbackAnnotationUpdate,
            buildFeedbackAnnotationUpdateParams(payload),
          );
        }
        case BRIDGE_METHODS.extensionFeedbackAnnotationClaim: {
          const payload = message.params ?? {};
          return await deps.requestBridgeMethod(BRIDGE_METHODS.feedbackAnnotationClaim, payload);
        }
        case BRIDGE_METHODS.extensionFeedbackAnnotationReply: {
          const payload = message.params ?? {};
          return await deps.requestBridgeMethod(BRIDGE_METHODS.feedbackAnnotationReply, payload);
        }
        case BRIDGE_METHODS.extensionFeedbackAnnotationResolve: {
          const payload = message.params ?? {};
          return await deps.requestBridgeMethod(BRIDGE_METHODS.feedbackAnnotationResolve, payload);
        }
        case BRIDGE_METHODS.extensionFeedbackAnnotationDismiss: {
          const payload = message.params ?? {};
          if (!payload.annotationId?.trim()) throw new Error('Feedback annotationId is required');
          payload.annotationId = payload.annotationId.trim();
          if (payload.dismissReason) payload.dismissReason = payload.dismissReason.trim() || void 0;
          return await deps.requestBridgeMethod(BRIDGE_METHODS.feedbackAnnotationDismiss, payload);
        }
        case BRIDGE_METHODS.extensionPageEvent:
          deps.queueNotification(BRIDGE_METHODS.bridgePageEvent, {
            tabId: sender.tab?.id ?? null,
            payload: message.params?.payload,
          });
          return { ok: true };
        case BRIDGE_METHODS.extensionPageToolsRegister: {
          const payload = message.params;
          const tabId = sender.tab?.id;
          if (!tabId) throw new Error('No sender tab available');
          const entry = normalizePageToolEntries([
            {
              namespace: payload.namespace ?? 'page',
              instanceId: payload.instanceId ?? 'default',
              tools: payload.tools ?? [],
            },
          ])[0];
          const mergedEntries = mergePageToolEntry(
            deps.pageToolState.pageToolsByTab.get(tabId) ?? [],
            entry,
          );
          deps.pageToolState.pageToolsByTab.set(tabId, mergedEntries);
          publishPageToolsForTab(deps.pageToolState, tabId);
          return { ok: true };
        }
        case BRIDGE_METHODS.extensionPageToolsSetEnabled:
          return await deps.extensionControlHandlers.handleExtensionPageToolsSetEnabled(
            message.params,
          );
        case BRIDGE_METHODS.extensionToolDebugCall:
          return await deps.extensionControlHandlers.handleExtensionToolDebugCall(message.params);
        case BRIDGE_METHODS.extensionMainWorldHostEnsure:
          return await ensureMainWorldBridgeHostOnSenderTab(
            sender,
            deps.installPageContextBridgeHostInMainWorld,
          );
        case BRIDGE_METHODS.extensionAgentationMainEnsure: {
          const params = message.params ?? {};
          if (
            typeof params.tabId === 'number' &&
            Number.isInteger(params.tabId) &&
            params.tabId > 0
          )
            return await ensureAgentationMainOnTab(params.tabId, params.frameId);
          return await ensureAgentationMainOnSenderTab(sender);
        }
        default:
          throw new RpcProtocolError(
            RPC_ERROR_CODES.methodNotFound,
            `Unhandled runtime method: ${message.method}`,
          );
      }
    };
  }
  //#endregion
  //#region src/bg-lifecycle.ts
  /**
   * Lifecycle listener registrar.
   * Centralizes chrome event binding so that background.ts retains only assembly responsibility.
   */
  function registerLifecycleListeners(deps) {
    const connectBridgeAndRepublishState = async () => {
      await deps.connectWebSocket(
        deps.wsHandlers.onToolCall,
        deps.wsHandlers.onToolsList,
        deps.wsHandlers.onTabsList,
        deps.wsHandlers.onBridgeWsExtensionRequest,
      );
      await ensurePageToolPreferencesLoaded(deps.pageToolState);
      publishBuiltinTools(deps.pageToolState);
      for (const tabId of deps.pageToolState.pageToolsByTab.keys())
        publishPageToolsForTab(deps.pageToolState, tabId);
      const activeTabs = await tabsQuery({ active: true });
      await Promise.allSettled(
        activeTabs
          .map((tab) => tab.id)
          .filter((tabId) => typeof tabId === 'number' && Number.isInteger(tabId))
          .map((tabId) =>
            discoverPageToolsForTab(
              deps.pageToolState,
              tabId,
              deps.installPageContextBridgeHostInMainWorld,
              true,
              false,
            ),
          ),
      );
    };
    chrome.runtime.onMessage.addListener(createRuntimeListener(deps.runtimeMessageHandler));
    chrome.tabs.onActivated.addListener((activeInfo) => {
      deps.queueNotification(BRIDGE_METHODS.bridgeTabActivated, {
        tabId: activeInfo.tabId,
        windowId: activeInfo.windowId,
      });
      discoverPageToolsForTab(
        deps.pageToolState,
        activeInfo.tabId,
        deps.installPageContextBridgeHostInMainWorld,
      ).catch((error) => deps.log('Discovery on tab activation failed', error));
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status === 'loading') {
        deps.pageToolState.tabReloadDiscoveryInFlight.delete(tabId);
        clearPageTools(deps.pageToolState, tabId);
      }
      if (changeInfo.status === 'complete' || changeInfo.url)
        deps.queueNotification(BRIDGE_METHODS.bridgeTabUpdated, {
          tabId,
          url: changeInfo.url,
          status: changeInfo.status,
        });
      if (changeInfo.status === 'complete')
        discoverPageToolsAfterTabReload(
          deps.pageToolState,
          tabId,
          deps.installPageContextBridgeHostInMainWorld,
        ).catch((error) => deps.log('Discovery on tab update failed', error));
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      deps.pageToolState.tabReloadDiscoveryInFlight.delete(tabId);
      clearPageTools(deps.pageToolState, tabId);
    });
    chrome.runtime.onInstalled.addListener(() => {
      deps.initDefaultWsUrl();
      connectBridgeAndRepublishState();
    });
    chrome.runtime.onStartup.addListener(() => {
      connectBridgeAndRepublishState();
    });
    connectBridgeAndRepublishState();
    ensurePageToolPreferencesLoaded(deps.pageToolState).then(() => {
      publishBuiltinTools(deps.pageToolState);
      for (const tabId of deps.pageToolState.pageToolsByTab.keys())
        publishPageToolsForTab(deps.pageToolState, tabId);
    });
    tabsQuery({ active: true })
      .then((tabs) =>
        Promise.allSettled(
          tabs
            .map((tab) => tab.id)
            .filter((tabId) => typeof tabId === 'number' && Number.isInteger(tabId))
            .map((tabId) =>
              discoverPageToolsForTab(
                deps.pageToolState,
                tabId,
                deps.installPageContextBridgeHostInMainWorld,
              ),
            ),
        ),
      )
      .catch((error) => deps.log('Initial active-tab discovery failed', error));
    setInterval(() => {
      chrome.runtime.getPlatformInfo(() => void 0);
    }, 25e3);
  }
  //#endregion
  //#region src/bg-main-world-bridge-host.ts
  var installPageContextBridgeHostInMainWorld = () => {
    const HOST_KEY = '__pageContextBridgeHost__';
    const BRIDGE_KEY = '__pageContextBridge__';
    const TOOLS_KEY = '__pageContextTools__';
    const RAW_BRIDGE_KEY = '__pageContextBridgeRaw__';
    const HOST_READY_EVENT = 'page-context-bridge-host:ready';
    const HOST_DEFAULT_SCENE = 'page-context-host-idle';
    const HOST_ADOPTED_SOURCE_ID = 'adopted-window-bridge';
    const HOST_LEGACY_SOURCE_PREFIX = 'legacy-window-bridge';
    const win = window;
    const existingHost = win[HOST_KEY];
    if (existingHost && typeof existingHost.registerSource === 'function') return;
    const state = {
      sourcesById: /* @__PURE__ */ new Map(),
      registerOrderCursor: 0,
      diagnostics: [],
    };
    const orderedSources = () =>
      Array.from(state.sourcesById.values()).sort((left, right) => {
        if (left.priority !== right.priority) return right.priority - left.priority;
        return left.registerOrder - right.registerOrder;
      });
    const safe = (fn, fallback) => {
      try {
        return fn();
      } catch {
        return fallback;
      }
    };
    const registerSource = (sourceId, bridge, priority = 100, tags = []) => {
      state.sourcesById.set(sourceId, {
        sourceId,
        bridge,
        priority,
        tags: Array.from(new Set((Array.isArray(tags) ? tags : []).filter(Boolean))),
        registeredAt: /* @__PURE__ */ new Date().toISOString(),
        registerOrder: ++state.registerOrderCursor,
      });
      if (sourceId !== HOST_ADOPTED_SOURCE_ID) {
        const adopted = state.sourcesById.get(HOST_ADOPTED_SOURCE_ID);
        if (adopted && adopted.bridge === bridge) state.sourcesById.delete(HOST_ADOPTED_SOURCE_ID);
      }
      return () => {
        const current = state.sourcesById.get(sourceId);
        if (current && current.bridge === bridge) state.sourcesById.delete(sourceId);
      };
    };
    const isBridgeLike = (candidate) =>
      Boolean(
        candidate &&
        typeof candidate.version === 'string' &&
        typeof candidate.listNamespaces === 'function' &&
        typeof candidate.getNamespace === 'function' &&
        typeof candidate.getScene === 'function' &&
        typeof candidate.listResources === 'function' &&
        typeof candidate.readResource === 'function' &&
        typeof candidate.listSkills === 'function' &&
        typeof candidate.getSkill === 'function' &&
        typeof candidate.getManifest === 'function',
      );
    const isLegacyBridgeLike = (candidate) =>
      Boolean(
        candidate &&
        typeof candidate === 'object' &&
        typeof candidate.getManifest === 'function' &&
        (typeof candidate.listTools === 'function' || typeof candidate.callTool === 'function'),
      );
    const adaptLegacyBridge = (candidate) => {
      const resolveNamespace = () => {
        if (typeof candidate.namespace === 'string' && candidate.namespace.trim())
          return candidate.namespace.trim();
        const manifest = safe(() => candidate.getManifest?.(), null);
        const manifestNamespace = Array.isArray(manifest?.namespaces)
          ? manifest.namespaces.find((entry) => entry && typeof entry.namespace === 'string')
          : null;
        return typeof manifestNamespace?.namespace === 'string'
          ? manifestNamespace.namespace
          : 'page';
      };
      const resolveInstanceId = () => {
        if (typeof candidate.instanceId === 'string' && candidate.instanceId.trim())
          return candidate.instanceId.trim();
        return 'default';
      };
      const listTools = () => {
        const tools = safe(() => candidate.listTools?.(), []);
        return Array.isArray(tools) ? tools : [];
      };
      const callTool = (name, args) => {
        const clonedArgs = safe(() => JSON.parse(JSON.stringify(args ?? {})), args ?? {});
        return safe(() => candidate.callTool?.(name, clonedArgs), void 0);
      };
      const namespace = resolveNamespace();
      const instanceId = resolveInstanceId();
      return {
        version:
          typeof candidate.version === 'string' && candidate.version.trim()
            ? candidate.version
            : 'page-context-legacy-bridge/1.0.0',
        listNamespaces: () => [namespace],
        getNamespace: (requestedNamespace) => {
          if (requestedNamespace !== namespace) return;
          if (instanceId === 'default')
            return {
              listTools,
              callTool,
            };
          return {
            listInstances: () => [instanceId],
            getInstance: (requestedInstanceId) => {
              if (requestedInstanceId !== instanceId) return;
              return {
                listTools,
                callTool,
              };
            },
          };
        },
        getScene: () => {
          const manifest = safe(() => candidate.getManifest?.(), null);
          return typeof manifest?.scene === 'string' && manifest.scene ? manifest.scene : namespace;
        },
        listResources: () => {
          const manifest = safe(() => candidate.getManifest?.(), null);
          return Array.isArray(manifest?.resources) ? manifest.resources : [];
        },
        readResource: (id) =>
          safe(() => candidate.readResource?.(id), {
            id,
            mimeType: 'application/json',
            text: JSON.stringify({ error: `Unknown resource id: ${id}` }, null, 2),
          }),
        listSkills: () => {
          const manifest = safe(() => candidate.getManifest?.(), null);
          return Array.isArray(manifest?.skills) ? manifest.skills : [];
        },
        getSkill: (id, input) => safe(() => candidate.getSkill?.(id, input), void 0),
        getManifest: () => safe(() => candidate.getManifest?.(), null),
      };
    };
    const normalizeBridgeCandidate = (candidate) => {
      if (isBridgeLike(candidate)) return candidate;
      if (isLegacyBridgeLike(candidate)) return adaptLegacyBridge(candidate);
      return null;
    };
    const bridgeSourceIdByRef = /* @__PURE__ */ new WeakMap();
    let legacySourceCursor = 0;
    const adoptLegacyAssignedBridge = (candidate, key) => {
      const normalizedBridge = normalizeBridgeCandidate(candidate);
      if (!normalizedBridge || candidate === hostBridge) return;
      win[RAW_BRIDGE_KEY] = candidate;
      const bridge = candidate;
      let sourceId = bridgeSourceIdByRef.get(bridge);
      if (!sourceId) {
        legacySourceCursor += 1;
        sourceId = `${HOST_LEGACY_SOURCE_PREFIX}:${legacySourceCursor}`;
        bridgeSourceIdByRef.set(bridge, sourceId);
      }
      registerSource(sourceId, normalizedBridge, 70, ['legacy-assignment', key]);
    };
    const hostBridge = {
      version: 'page-context-bridge-host/1.0.0',
      listNamespaces: () => {
        const deduped = /* @__PURE__ */ new Set();
        for (const source of orderedSources()) {
          const namespaces = safe(() => source.bridge.listNamespaces(), []);
          for (const namespace of namespaces) deduped.add(namespace);
        }
        return Array.from(deduped);
      },
      getNamespace: (namespace) => {
        for (const source of orderedSources()) {
          const instance = safe(() => source.bridge.getNamespace(namespace), void 0);
          if (instance) return instance;
        }
      },
      getScene: () => {
        const scenes = Array.from(
          new Set(
            orderedSources()
              .map((source) => safe(() => source.bridge.getScene(), ''))
              .filter(Boolean),
          ),
        );
        if (scenes.length === 0) return HOST_DEFAULT_SCENE;
        if (scenes.length === 1) return scenes[0];
        return `page-context-host-mixed:${scenes.join('+')}`;
      },
      listResources: () => {
        const deduped = /* @__PURE__ */ new Map();
        for (const source of orderedSources()) {
          const resources = safe(() => source.bridge.listResources(), []);
          for (const resource of resources)
            if (resource && typeof resource.id === 'string' && !deduped.has(resource.id))
              deduped.set(resource.id, resource);
        }
        return Array.from(deduped.values());
      },
      readResource: (id) => {
        for (const source of orderedSources())
          if (safe(() => source.bridge.listResources(), []).some((resource) => resource?.id === id))
            return safe(() => source.bridge.readResource(id), {
              id,
              mimeType: 'application/json',
              text: JSON.stringify({ error: `Resource read failed: ${id}` }, null, 2),
            });
        return {
          id,
          mimeType: 'application/json',
          text: JSON.stringify({ error: `Unknown resource id: ${id}` }, null, 2),
        };
      },
      listSkills: () => {
        const deduped = /* @__PURE__ */ new Map();
        for (const source of orderedSources()) {
          const skills = safe(() => source.bridge.listSkills(), []);
          for (const skill of skills)
            if (skill && typeof skill.id === 'string' && !deduped.has(skill.id))
              deduped.set(skill.id, skill);
        }
        return Array.from(deduped.values());
      },
      getSkill: (id, input) => {
        for (const source of orderedSources())
          if (safe(() => source.bridge.listSkills(), []).some((skill) => skill?.id === id))
            return safe(() => source.bridge.getSkill(id, input), void 0);
      },
      getManifest: () => {
        const namespaces = /* @__PURE__ */ new Map();
        for (const source of orderedSources()) {
          const manifest = safe(() => source.bridge.getManifest(), null);
          const descriptors = Array.isArray(manifest?.namespaces) ? manifest.namespaces : [];
          for (const descriptor of descriptors)
            if (
              descriptor &&
              typeof descriptor.namespace === 'string' &&
              !namespaces.has(descriptor.namespace)
            )
              namespaces.set(descriptor.namespace, descriptor);
        }
        return {
          version: 'page-context-bridge-host/1.0.0',
          app: 'page-context-bridge-host',
          route: `${window.location.pathname}${window.location.search}`,
          scene: hostBridge.getScene(),
          namespaces: Array.from(namespaces.values()),
          resources: hostBridge.listResources(),
          skills: hostBridge.listSkills(),
          generatedAt: /* @__PURE__ */ new Date().toISOString(),
        };
      },
    };
    const existingBridge = win[BRIDGE_KEY] ?? win[TOOLS_KEY];
    const normalizedExistingBridge = normalizeBridgeCandidate(existingBridge);
    if (normalizedExistingBridge) {
      win[RAW_BRIDGE_KEY] = existingBridge;
      registerSource(HOST_ADOPTED_SOURCE_ID, normalizedExistingBridge, 10, ['adopted']);
    }
    const host = {
      version: 'page-context-bridge-host/1.0.0',
      bridge: hostBridge,
      registerSource: (input) =>
        registerSource(input.sourceId, input.bridge, input.priority, input.tags),
      unregisterSource: (sourceId) => {
        state.sourcesById.delete(String(sourceId));
      },
      listSources: () =>
        orderedSources().map((entry) => ({
          sourceId: entry.sourceId,
          bridge: entry.bridge,
          priority: entry.priority,
          tags: entry.tags.slice(),
          registeredAt: entry.registeredAt,
        })),
      listDiagnostics: () => state.diagnostics.slice(),
    };
    win[HOST_KEY] = host;
    Object.defineProperty(win, BRIDGE_KEY, {
      configurable: true,
      enumerable: false,
      get: () => hostBridge,
      set: (value) => {
        adoptLegacyAssignedBridge(value, BRIDGE_KEY);
      },
    });
    Object.defineProperty(win, TOOLS_KEY, {
      configurable: true,
      enumerable: false,
      get: () => hostBridge,
      set: (value) => {
        adoptLegacyAssignedBridge(value, TOOLS_KEY);
      },
    });
    try {
      window.dispatchEvent(new CustomEvent(HOST_READY_EVENT, { detail: host }));
    } catch {}
  };
  //#endregion
  //#region src/bg-opencode-http-connection.ts
  /**
   * OpenCode HTTP 探活 driver。
   *
   * 设计选择：
   * - 默认后台 30s 周期探活，Connections tab 不开也能看到真实状态
   * - UI 的 Reconnect 动作会触发一次立即探活，避免改完 endpoint 还要等下个周期
   */
  var OPENCODE_HTTP_DESCRIPTOR_ID = 'opencode-http';
  var OPENCODE_HTTP_POLL_INTERVAL_MS = 3e4;
  function buildHealthUrl(baseUrl) {
    const parsed = new URL(baseUrl);
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/global/health`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  }
  async function upsertOpencodeHttpDescriptor(status, statusReason) {
    const registry = getConnectionRegistry();
    const endpoints = await loadConnectionEndpoints();
    const endpoint = buildHealthUrl(endpoints.opencodeBaseUrl);
    if (registry.get('opencode-http')) {
      registry.update(OPENCODE_HTTP_DESCRIPTOR_ID, {
        endpoint,
        status,
        statusReason: statusReason ?? null,
        capabilities: {
          reconnect: true,
          disconnect: false,
        },
        meta: { opencodeBaseUrl: endpoints.opencodeBaseUrl },
      });
      return;
    }
    registry.register({
      id: OPENCODE_HTTP_DESCRIPTOR_ID,
      kind: 'opencode-http',
      label: 'OpenCode HTTP Health',
      endpoint,
      status,
      statusReason: statusReason ?? null,
      capabilities: {
        reconnect: true,
        disconnect: false,
      },
      meta: { opencodeBaseUrl: endpoints.opencodeBaseUrl },
    });
  }
  function createOpencodeHttpConnectionDriver() {
    let pollTimer = null;
    const probe = async () => {
      const healthUrl = buildHealthUrl((await loadConnectionEndpoints()).opencodeBaseUrl);
      try {
        const response = await fetch(healthUrl, { method: 'GET' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await upsertOpencodeHttpDescriptor('reachable', 'health-ok');
      } catch (error) {
        await upsertOpencodeHttpDescriptor(
          'unreachable',
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    return {
      async start() {
        await upsertOpencodeHttpDescriptor('unreachable', 'probing');
        await probe();
        if (pollTimer) return;
        pollTimer = setInterval(() => {
          probe();
        }, OPENCODE_HTTP_POLL_INTERVAL_MS);
      },
      async probeNow() {
        await probe();
      },
    };
  }
  //#endregion
  //#region src/background.ts
  var inFlightToolCalls = /* @__PURE__ */ new Map();
  var pageToolState = createPageToolState();
  var scopedBridgeWsManager = createScopedBridgeWsManager();
  var connectionRegistry = getConnectionRegistry();
  var opencodeHttpDriver = createOpencodeHttpConnectionDriver();
  async function listTabs() {
    return (await tabsQuery({})).map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      active: tab.active,
    }));
  }
  async function requestBridgeMethod(method, params) {
    return await requestBridge(method, params, { timeoutMs: 2e4 });
  }
  var wsHandlers = createWsHandlers({
    pageToolState,
    inFlightToolCalls,
    listTabs,
    installPageContextBridgeHostInMainWorld,
    bridgeConnection: {
      getWsReady,
      getSessionId,
      forceReconnect,
    },
    scopedBridgeConnection: scopedBridgeWsManager,
  });
  var runtimeMessageHandler = createRuntimeMessageHandler({
    pageToolState,
    installPageContextBridgeHostInMainWorld,
    extensionControlHandlers: wsHandlers,
    requestBridgeMethod,
    queueNotification,
  });
  connectionRegistry.registerDriver('bridge-default-ws', {
    async action(action) {
      if (action === 'disconnect') {
        disconnectWebSocket();
        return { ok: true };
      }
      await forceReconnect(
        wsHandlers.onToolCall,
        wsHandlers.onToolsList,
        wsHandlers.onTabsList,
        wsHandlers.onBridgeWsExtensionRequest,
      );
      return { ok: true };
    },
  });
  connectionRegistry.registerDriver('opencode-bridge-ws', {
    async action(action, descriptor) {
      const tenantId =
        typeof descriptor.meta?.tenantId === 'string' ? descriptor.meta.tenantId : void 0;
      if (!tenantId) throw new Error(`Missing tenantId for descriptor "${descriptor.id}"`);
      if (action === 'disconnect') {
        await scopedBridgeWsManager.disconnect(tenantId);
        return { ok: true };
      }
      if (!descriptor.endpoint)
        throw new Error(`Missing endpoint for descriptor "${descriptor.id}"`);
      await scopedBridgeWsManager.connect(tenantId, descriptor.endpoint, {
        onToolCall: wsHandlers.onToolCall,
        onToolsList: wsHandlers.onToolsList,
        onTabsList: wsHandlers.onTabsList,
        onExtensionRequest: wsHandlers.onBridgeWsExtensionRequest,
      });
      return { ok: true };
    },
  });
  connectionRegistry.registerDriver('opencode-http', {
    async action(action) {
      if (action === 'disconnect')
        throw new Error('OpenCode HTTP health probe does not support disconnect');
      await opencodeHttpDriver.probeNow();
      return { ok: true };
    },
  });
  connectionRegistry.registerDriver('page-tools', {});
  connectionRegistry.registerDriver('page-tools', {
    async action(action, descriptor) {
      if (action === 'disconnect')
        throw new Error('Page tools discovery does not support disconnect');
      const tabId = Number(descriptor.meta?.tabId);
      if (!Number.isInteger(tabId))
        throw new Error(`Missing tabId for descriptor "${descriptor.id}"`);
      await discoverPageToolsForTab(
        pageToolState,
        tabId,
        installPageContextBridgeHostInMainWorld,
        true,
      );
      return { ok: true };
    },
  });
  connectionRegistry.registerDriver('main-world-host', {
    async action(action, descriptor) {
      if (action === 'disconnect') throw new Error('Main world host does not support disconnect');
      const tabId = Number(descriptor.meta?.tabId);
      const frameId = descriptor.meta?.frameId;
      if (!Number.isInteger(tabId))
        throw new Error(`Missing tabId for descriptor "${descriptor.id}"`);
      await ensureMainWorldBridgeHostOnTab(
        tabId,
        installPageContextBridgeHostInMainWorld,
        typeof frameId === 'number' ? frameId : void 0,
      );
      return { ok: true };
    },
  });
  connectionRegistry.registerDriver('agentation-main-world-host', {
    async action(action, descriptor) {
      if (action === 'disconnect')
        throw new Error('Agentation main world host does not support disconnect');
      const tabId = Number(descriptor.meta?.tabId);
      const frameId = descriptor.meta?.frameId;
      if (!Number.isInteger(tabId))
        throw new Error(`Missing tabId for descriptor "${descriptor.id}"`);
      await ensureAgentationMainOnTab(tabId, typeof frameId === 'number' ? frameId : void 0);
      return { ok: true };
    },
  });
  opencodeHttpDriver.start().catch(() => {});
  registerLifecycleListeners({
    pageToolState,
    installPageContextBridgeHostInMainWorld,
    runtimeMessageHandler,
    wsHandlers,
    queueNotification,
    connectWebSocket,
    initDefaultWsUrl,
    log,
  });
  //#endregion
})();
