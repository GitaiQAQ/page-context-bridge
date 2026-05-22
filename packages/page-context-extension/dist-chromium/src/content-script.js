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
  function createRequest(method, params, id = createRequestId(), meta) {
    return {
      jsonrpc: '2.0',
      id,
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
  Object.entries(BUILTIN_TOOL_SUFFIXES_BY_CATEGORY).reduce((accumulator, [category, suffixes]) => {
    for (const suffix of suffixes) {
      const categories = accumulator.get(suffix) ?? [];
      categories.push(category);
      accumulator.set(suffix, categories);
    }
    return accumulator;
  }, /* @__PURE__ */ new Map());
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
  //#region ../builtin-tools/dist/console-capture.js
  /**
   * Console capture utility for content scripts.
   *
   * Intercepts console.log/warn/error/info calls and window error events,
   * storing entries in a capped buffer for retrieval via get_console_logs.
   */
  var MAX_CONSOLE_ENTRIES = 200;
  function createConsoleCapture(win, consoleEntries) {
    const originalConsole = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      info: console.info.bind(console),
    };
    const capture = (level, args) => {
      const entry = {
        level,
        timestamp: Date.now(),
        args: args
          .map((value) => {
            try {
              return typeof value === 'object' ? JSON.stringify(value) : String(value);
            } catch {
              return String(value);
            }
          })
          .join(' '),
      };
      consoleEntries.push(entry);
      if (consoleEntries.length > MAX_CONSOLE_ENTRIES) consoleEntries.shift();
    };
    console.log = (...args) => {
      capture('log', args);
      originalConsole.log(...args);
    };
    console.warn = (...args) => {
      capture('warn', args);
      originalConsole.warn(...args);
    };
    console.error = (...args) => {
      capture('error', args);
      originalConsole.error(...args);
    };
    console.info = (...args) => {
      capture('info', args);
      originalConsole.info(...args);
    };
    win.addEventListener('error', (event) => {
      capture('error', [`${event.message} at ${event.filename}:${event.lineno}`]);
    });
  }
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
  object({
    root: _enum(['builtin', 'page']).optional(),
    tabId: number().int().positive().optional(),
    namespace: string().trim().min(1).optional(),
    instanceId: string().trim().min(1).optional(),
    toolName: string().trim().min(1).optional(),
    enabled: boolean(),
  });
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
  object({
    tabId: number().int().optional(),
    sessionId: string().optional(),
  });
  object({
    afterSeq: number().int().nonnegative().default(0),
    sessionId: string().optional(),
  });
  object({
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
  object({
    annotationId: string().trim().min(1),
    body: string().trim().min(1),
    priority: feedbackPrioritySchema.optional(),
    actorSource: feedbackActorSourceSchema.optional(),
    actorId: string().trim().min(1).optional(),
    actorName: string().trim().min(1).optional(),
  });
  object({
    annotationId: string().trim().min(1),
    actorSource: feedbackActorSourceSchema.optional(),
    actorId: string().trim().min(1).optional(),
    actorName: string().trim().min(1).optional(),
  });
  object({
    annotationId: string().trim().min(1),
    body: string().trim().min(1),
    kind: _enum(['comment', 'action_note', 'resolution_note']).optional(),
    actorSource: feedbackActorSourceSchema.optional(),
    actorId: string().trim().min(1).optional(),
    actorName: string().trim().min(1).optional(),
  });
  object({
    annotationId: string().trim().min(1),
    resolution: string().trim().min(1).optional(),
    actorSource: feedbackActorSourceSchema.optional(),
    actorId: string().trim().min(1).optional(),
    actorName: string().trim().min(1).optional(),
  });
  object({
    annotationId: string().trim().min(1),
    dismissReason: string().trim().min(1).optional(),
    actorSource: feedbackActorSourceSchema.optional(),
    actorId: string().trim().min(1).optional(),
    actorName: string().trim().min(1).optional(),
  });

  //#region src/content-script-readonly-broker.ts
  var PAGE_CONTEXT_READONLY_REQUEST_EVENT = 'page-context:readonly:request';
  var PAGE_CONTEXT_READONLY_RESPONSE_EVENT = 'page-context:readonly:response';
  function parseReadonlyBrokerPayload(value) {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  function stringifyReadonlyBrokerPayload(payload) {
    return JSON.stringify(payload);
  }
  async function requestReadonlyFromMainWorld(win, method, params, timeoutMs = 4e3) {
    const requestId = `pc-readonly-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const request = {
      requestId,
      method,
      params: params === void 0 ? void 0 : cloneCrossWorldJson(params),
    };
    return await new Promise((resolve, reject) => {
      const cleanup = (listener, timer) => {
        clearTimeout(timer);
        win.removeEventListener(PAGE_CONTEXT_READONLY_RESPONSE_EVENT, listener);
      };
      const onResponse = (event) => {
        const detail = parseReadonlyBrokerResponse(event.detail);
        if (!isReadonlyBrokerResponse(detail) || detail.requestId !== requestId) return;
        cleanup(onResponse, timer);
        if (!detail.ok) {
          reject(new Error(detail.error));
          return;
        }
        resolve(detail.result);
      };
      const timer = setTimeout(() => {
        cleanup(onResponse, timer);
        reject(/* @__PURE__ */ new Error(`Main world readonly broker timeout: ${method}`));
      }, timeoutMs);
      win.addEventListener(PAGE_CONTEXT_READONLY_RESPONSE_EVENT, onResponse);
      win.dispatchEvent(
        new CustomEvent(PAGE_CONTEXT_READONLY_REQUEST_EVENT, {
          detail: stringifyReadonlyBrokerPayload(request),
        }),
      );
    });
  }
  function isReadonlyBrokerResponse(value) {
    if (!isRecord(value)) return false;
    if (typeof value.requestId !== 'string' || typeof value.ok !== 'boolean') return false;
    if (value.ok) return true;
    return typeof value.error === 'string';
  }
  function parseReadonlyBrokerResponse(value) {
    const parsedValue = parseReadonlyBrokerPayload(value);
    return isReadonlyBrokerResponse(parsedValue) ? parsedValue : null;
  }
  function isRecord(value) {
    return typeof value === 'object' && value !== null;
  }
  /**
   * Strip Firefox Xray wrappers by JSON round-tripping.
   * On Chromium this is a no-op (JSON.parse(JSON.stringify(x)) === x for plain objects).
   * On Firefox, Xray-wrapped objects from MAIN world become opaque;
   * serializing and parsing back produces plain JS objects that message passing can handle.
   */
  function unwrapXray(value) {
    if (value == null) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
  function cloneCrossWorldJson(value) {
    return unwrapXray(value);
  }

  //#region src/feedback-ui-adapter.ts
  /**
   * Create feedback bridge adapter.
   * Only responsible for "protocol field mapping + afterSeq cursor maintenance", keeping clear message boundaries between UI layer and runtime.
   */
  function createFeedbackUiAdapter(deps = {}) {
    const sendRequest = deps.sendRequest ?? sendRuntimeRequest;
    let feedbackLastSeq = 0;
    return {
      async createAnnotation(input) {
        const payload = {
          body: input.body,
          priority: input.priority,
          selectedText: input.selectedText,
          uiAnchor: input.uiAnchor,
        };
        return normalizeCreateResult(
          await sendRequest(BRIDGE_METHODS.extensionFeedbackAnnotationCreate, payload),
        );
      },
      async updateAnnotation(input) {
        const payload = {
          annotationId: input.annotationId,
          body: input.body,
          priority: input.priority,
        };
        return await sendRequest(BRIDGE_METHODS.extensionFeedbackAnnotationUpdate, payload);
      },
      async dismissAnnotation(input) {
        const payload = {
          annotationId: input.annotationId,
          dismissReason: input.dismissReason,
        };
        return await sendRequest(BRIDGE_METHODS.extensionFeedbackAnnotationDismiss, payload);
      },
      async getFeedbackSnapshot() {
        const snapshot = await sendRequest(BRIDGE_METHODS.extensionFeedbackStateSnapshot);
        feedbackLastSeq = normalizeFeedbackSeq(snapshot.lastSeq, feedbackLastSeq);
        return snapshot;
      },
      async getFeedbackStateDelta() {
        const delta = await sendRequest(BRIDGE_METHODS.extensionFeedbackStateDelta, {
          afterSeq: feedbackLastSeq,
        });
        feedbackLastSeq = normalizeFeedbackSeq(delta.lastSeq, feedbackLastSeq);
        return delta;
      },
    };
  }
  function normalizeFeedbackSeq(next, fallback) {
    const value = Number(next);
    if (!Number.isFinite(value) || value < 0) return fallback;
    return value;
  }
  function normalizeCreateResult(raw) {
    if (!raw || typeof raw !== 'object') return { raw };
    const record = raw;
    if (typeof record.id === 'string')
      return {
        id: record.id,
        raw,
      };
    const annotation = record.annotation;
    if (annotation && typeof annotation === 'object' && typeof annotation.id === 'string')
      return {
        id: annotation.id,
        raw,
      };
    return { raw };
  }
  //#endregion
  //#region src/content-script.ts
  var CONTENT_READONLY_METHODS = {
    manifestGet: BRIDGE_METHODS.extensionContentContextManifestGet,
    resourceRead: BRIDGE_METHODS.extensionContentContextResourceRead,
    skillGet: BRIDGE_METHODS.extensionContentContextSkillGet,
    pageToolsDiscover: BRIDGE_METHODS.extensionContentPageToolsDiscover,
    pageToolExecute: BRIDGE_METHODS.extensionContentPageToolExecute,
  };
  var consoleEntries = [];
  var EXTENSION_E2E_REPORT_METHOD = 'extension.e2e.report';
  function log(...args) {
    console.log('[PAGE-CONTEXT-CS]', ...args);
  }
  createConsoleCapture(window, consoleEntries);
  var feedbackUiAdapter = createFeedbackUiAdapter();
  notifyFirefoxE2EContentScriptReady(window);
  /** Basic validation: discard events with no annotation, no comment, or outdated timestamps */
  function isValidAnnotationEvent(detail) {
    if (!detail || typeof detail !== 'object') return false;
    const d = detail;
    if (!d.annotation || typeof d.annotation !== 'object') return false;
    if (typeof d.annotation.comment !== 'string' || !d.annotation.comment.trim()) return false;
    if (typeof d.timestamp !== 'number' || d.timestamp <= 0) return false;
    if (Date.now() - d.timestamp > 6e4) return false;
    return true;
  }
  window.addEventListener('page-context:agentation:annotation:add', (event) => {
    const detail = event.detail;
    if (!isValidAnnotationEvent(detail)) return;
    const payload = buildCreatePayload(detail.annotation);
    if (!payload) return;
    feedbackUiAdapter.createAnnotation?.(payload)?.catch((error) => {
      log('Failed to create annotation from MAIN world Agentation', error);
    });
  });
  window.addEventListener('page-context:agentation:annotation:update', (event) => {
    const detail = event.detail;
    if (!isValidAnnotationEvent(detail)) return;
    const id = normalizeId(detail.annotation.id);
    const body = detail.annotation.comment.trim();
    if (!id || !body) return;
    feedbackUiAdapter
      .updateAnnotation?.({
        annotationId: id,
        body,
        priority: toFeedbackPriority(detail.annotation.severity),
      })
      .catch((error) => {
        log('Failed to update annotation from MAIN world Agentation', error);
      });
  });
  window.addEventListener('page-context:agentation:annotation:delete', (event) => {
    const detail = event.detail;
    if (!isValidAnnotationEvent(detail)) return;
    const id = normalizeId(detail.annotation.id);
    if (!id) return;
    feedbackUiAdapter
      .dismissAnnotation?.({
        annotationId: id,
        dismissReason: 'deleted from agentation main world',
      })
      .catch((error) => {
        log('Failed to dismiss annotation from MAIN world Agentation', error);
      });
  });
  chrome.runtime.onMessage.addListener(
    createRuntimeListener(async (message) => {
      switch (message.method) {
        case CONTENT_READONLY_METHODS.manifestGet:
          return await requestReadonlyFromMainWorld(window, 'context.manifest.get');
        case CONTENT_READONLY_METHODS.resourceRead:
          return await requestReadonlyFromMainWorld(
            window,
            'context.resource.read',
            message.params,
          );
        case CONTENT_READONLY_METHODS.skillGet:
          return await requestReadonlyFromMainWorld(window, 'context.skill.get', message.params);
        case CONTENT_READONLY_METHODS.pageToolsDiscover:
          return await requestReadonlyFromMainWorld(window, 'page.tools.discover');
        case CONTENT_READONLY_METHODS.pageToolExecute:
          return await requestReadonlyFromMainWorld(window, 'page.tool.execute', message.params);
        case BRIDGE_METHODS.extensionToolExecute: {
          const payload = message.params ?? {};
          return executeContentScriptTool(payload.tool, payload.args ?? {}, {
            win: window,
            doc: document,
            consoleEntries,
          });
        }
        default:
          throw new Error(`Unknown content-script method: ${message.method}`);
      }
    }),
  );
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'PAGE_CONTEXT_REQUEST') {
      log('Forwarding page context request from page to background');
      sendRuntimeRequest(BRIDGE_METHODS.extensionPageEvent, { payload: data.payload }).catch(
        (error) => {
          log('Failed to forward page event', error);
        },
      );
    }
  });
  function buildCreatePayload(ann) {
    const body = ann.comment?.trim();
    if (!body) return null;
    const targetRect = resolveTargetRect(ann);
    const selectedText = normalizeText(ann.selectedText);
    return {
      body,
      priority: toFeedbackPriority(ann.severity),
      selectedText,
      uiAnchor: buildUiAnchor(ann, targetRect, selectedText),
      target: {
        elementName: normalizeText(ann.element) ?? 'element',
        elementPath: normalizeText(ann.elementPath) ?? '',
        rect: targetRect,
      },
    };
  }
  function resolveTargetRect(ann) {
    const box = ann.boundingBox;
    if (box) {
      const viewportY = ann.isFixed ? box.y : box.y - window.scrollY;
      return new DOMRectReadOnly(box.x, viewportY, Math.max(1, box.width), Math.max(1, box.height));
    }
    const vx = Number.isFinite(ann.x) ? (ann.x / 100) * window.innerWidth : window.innerWidth / 2;
    const ry = Number.isFinite(ann.y) ? ann.y : window.innerHeight / 2;
    const vy = ann.isFixed ? ry : ry - window.scrollY;
    return new DOMRectReadOnly(vx, vy, 1, 1);
  }
  function buildUiAnchor(ann, rect, selectedText) {
    const meta = {
      source: 'agentation-main-world',
      element: normalizeText(ann.element),
      elementPath: normalizeText(ann.elementPath),
      fullPath: normalizeText(ann.fullPath),
      reactComponents: normalizeText(ann.reactComponents),
      sourceFile: normalizeText(ann.sourceFile),
    };
    if (ann.isMultiSelect) meta.isMultiSelect = true;
    if (ann.isFixed) meta.isFixed = true;
    return {
      cssSelector: toCssSelectorCandidate(ann.elementPath),
      textQuote: selectedText,
      framePath: [0],
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      meta,
    };
  }
  function toFeedbackPriority(severity) {
    switch (severity) {
      case 'blocking':
        return 'critical';
      case 'important':
        return 'high';
      default:
        return 'normal';
    }
  }
  function toCssSelectorCandidate(elementPath) {
    const path = elementPath?.trim();
    if (!path || path.includes('⟨shadow⟩')) return void 0;
    const segments = path
      .split('>')
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0) return void 0;
    const leaf = segments.at(-1);
    if (!leaf) return void 0;
    if (/^#[A-Za-z0-9_-]+$/.test(leaf)) return leaf;
    if (/^\.[A-Za-z0-9_-]+$/.test(leaf)) return leaf;
    if (/^[A-Za-z][A-Za-z0-9-]*$/.test(leaf)) return leaf.toLowerCase();
  }
  function normalizeText(value) {
    return value?.trim() || void 0;
  }
  function normalizeId(value) {
    if (typeof value !== 'string') return void 0;
    return value.trim() || void 0;
  }
  window.__PAGE_CONTEXT_BRIDGE_DEMO__ = () => {
    const selection = window.getSelection();
    const text = selection ? selection.toString() : '';
    window.postMessage(
      {
        type: 'PAGE_CONTEXT_REQUEST',
        payload: {
          type: 'demo.selection',
          text,
        },
      },
      '*',
    );
  };
  var firefoxReadonlyRegistrationPromise = registerFirefoxPageToolsFromReadonlyBridge();
  runFirefoxE2EProbeIfRequested();
  async function registerFirefoxPageToolsFromReadonlyBridge() {
    const runtimeManifest = chrome.runtime?.getManifest?.();
    if (
      !(
        Boolean(runtimeManifest?.browser_specific_settings?.gecko) ||
        /Firefox\//i.test(navigator.userAgent)
      )
    )
      return {
        ok: false,
        registeredEntryCount: 0,
        lastError: 'Not running in Firefox runtime',
      };
    const delays = [0, 500, 1500, 3e3];
    let lastError;
    for (const delay of delays) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const entries = await requestReadonlyFromMainWorld(window, 'page.tools.discover');
        if (!Array.isArray(entries) || entries.length === 0) continue;
        const validEntries = entries.filter(
          (entry) =>
            entry &&
            typeof entry.namespace === 'string' &&
            typeof entry.instanceId === 'string' &&
            Array.isArray(entry.tools) &&
            entry.tools.length > 0,
        );
        if (validEntries.length === 0) continue;
        await replayFirefoxPageToolRegistration(validEntries);
        log('Registered Firefox page tools from readonly bridge', validEntries.length);
        return {
          ok: true,
          registeredEntryCount: validEntries.length,
        };
      } catch (error) {
        log('Firefox readonly tool registration attempt failed', error);
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      ok: false,
      registeredEntryCount: 0,
      lastError,
    };
  }
  async function replayFirefoxPageToolRegistration(entries) {
    await Promise.all(
      entries.map((entry) =>
        sendRuntimeRequest(BRIDGE_METHODS.extensionPageToolsRegister, {
          namespace: entry.namespace,
          instanceId: entry.instanceId,
          tools: entry.tools,
        }),
      ),
    );
    const replayDelays = [0, 300, 1e3, 3e3];
    (async () => {
      for (const delay of replayDelays) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        await Promise.allSettled(
          entries.map((entry) =>
            sendRuntimeRequest(BRIDGE_METHODS.extensionPageToolsRegister, {
              namespace: entry.namespace,
              instanceId: entry.instanceId,
              tools: entry.tools,
            }),
          ),
        );
      }
    })();
  }
  async function runFirefoxE2EProbeIfRequested() {
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get('__pcE2E') !== '1') return;
    const bootstrapOnly = searchParams.get('pcBootstrapOnly') === '1';
    const reportUrl = searchParams.get('__pcE2EReport');
    if (!reportUrl && !bootstrapOnly) return;
    const report = {
      href: window.location.href,
      contentScriptLoaded: true,
    };
    const expectedPageToolName = searchParams.get('pcExpectedToolName')?.trim() ?? '';
    const expectedPageToolNamespace = searchParams.get('pcExpectedToolNamespace')?.trim() ?? '';
    const expectedPageToolInstanceId = searchParams.get('pcExpectedToolInstanceId')?.trim() ?? '';
    const expectedPageToolArgsRaw = searchParams.get('pcExpectedToolArgs')?.trim() ?? '';
    const skipReadonlyExecute = searchParams.get('pcSkipReadonlyExecute') === '1';
    let expectedPageToolArgs = {};
    if (expectedPageToolArgsRaw)
      try {
        const parsed = JSON.parse(expectedPageToolArgsRaw);
        if (parsed && typeof parsed === 'object') expectedPageToolArgs = parsed;
      } catch (error) {
        report.readonlyExecuteConfigError = error instanceof Error ? error.message : String(error);
      }
    if (bootstrapOnly) {
      const wsUrl = searchParams.get('__pcE2EWs');
      if (!wsUrl) return;
      try {
        await storageLocalSet({ mcpWsUrl: wsUrl });
        await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect);
      } catch (error) {
        log('Failed to bootstrap Firefox E2E WebSocket connection', error);
      }
      return;
    }
    try {
      const registration = await firefoxReadonlyRegistrationPromise;
      report.readonlyRegistrationOk = registration.ok;
      report.readonlyRegisteredEntryCount = registration.registeredEntryCount;
      if (registration.lastError) report.readonlyRegistrationError = registration.lastError;
      try {
        const readonlyEntries = await requestReadonlyFromMainWorld(window, 'page.tools.discover');
        report.readonlyToolCount = Array.isArray(readonlyEntries)
          ? readonlyEntries.reduce(
              (count, entry) => count + (Array.isArray(entry?.tools) ? entry.tools.length : 0),
              0,
            )
          : 0;
      } catch (error) {
        report.readonlyToolCountError = error instanceof Error ? error.message : String(error);
        throw error;
      }
      if (!skipReadonlyExecute)
        try {
          const readonlyExecute = await requestReadonlyFromMainWorld(window, 'page.tool.execute', {
            pageToolName: expectedPageToolName || 'e2e-tool-1',
            namespace: expectedPageToolNamespace || 'e2e',
            instanceId: expectedPageToolInstanceId || 'test',
            args: expectedPageToolName ? expectedPageToolArgs : { probe: 'firefox-e2e' },
          });
          report.readonlyExecuteTarget = {
            pageToolName: expectedPageToolName || 'e2e-tool-1',
            namespace: expectedPageToolNamespace || 'e2e',
            instanceId: expectedPageToolInstanceId || 'test',
          };
          report.readonlyExecuteOk = Boolean(readonlyExecute?.ok);
          if (readonlyExecute?.result !== void 0)
            report.readonlyExecuteResult = readonlyExecute.result;
          if (readonlyExecute?.error) report.readonlyExecuteError = readonlyExecute.error;
        } catch (error) {
          report.readonlyExecuteThrownError =
            error instanceof Error ? error.message : String(error);
          throw error;
        }
      else report.readonlyExecuteSkipped = true;
      try {
        const runtimeDiscover = await sendRuntimeRequest(
          BRIDGE_METHODS.extensionPageToolsDiscover,
          { source: 'firefox-e2e' },
        );
        report.runtimeDiscoveredToolCount = Array.isArray(runtimeDiscover?.tools)
          ? runtimeDiscover.tools.length
          : 0;
      } catch (error) {
        report.runtimeDiscoverError = error instanceof Error ? error.message : String(error);
        throw error;
      }
      try {
        const toolTree = await sendRuntimeRequest(BRIDGE_METHODS.extensionPageToolsTreeGet);
        report.toolTreeTotalTools = Number(toolTree?.totalTools ?? 0);
        report.toolTreeEnabledTools = Number(toolTree?.enabledTools ?? 0);
        const currentTabNode = Array.isArray(toolTree?.tabs)
          ? toolTree.tabs.find(
              (tab) => typeof tab?.url === 'string' && tab.url === window.location.href,
            )
          : void 0;
        report.currentTabToolCount = Number(currentTabNode?.totalTools ?? 0);
      } catch (error) {
        report.toolTreeError = error instanceof Error ? error.message : String(error);
        throw error;
      }
      const wsUrl = searchParams.get('__pcE2EWs');
      if (wsUrl)
        try {
          await storageLocalSet({ mcpWsUrl: wsUrl });
          await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect);
          const deadline = Date.now() + 15e3;
          let connected = false;
          let sessionId = null;
          while (Date.now() < deadline) {
            const status = await sendRuntimeRequest(BRIDGE_METHODS.extensionStatusGet);
            connected = Boolean(status?.connected);
            sessionId = typeof status?.sessionId === 'string' ? status.sessionId : null;
            if (connected) {
              report.wsPendingToolCalls = Number(status?.pendingToolCalls ?? 0);
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          report.wsConnected = connected;
          report.wsSessionId = sessionId;
        } catch (error) {
          report.wsError = error instanceof Error ? error.message : String(error);
          throw error;
        }
      report.ok =
        (Boolean(report.readonlyRegistrationOk) || Number(report.readonlyToolCount ?? 0) > 0) &&
        (Boolean(report.readonlyExecuteOk) || Boolean(report.readonlyExecuteSkipped)) &&
        Number(report.runtimeDiscoveredToolCount ?? 0) > 0 &&
        Number(report.currentTabToolCount ?? 0) > 0;
    } catch (error) {
      report.ok = false;
      report.error = error instanceof Error ? error.message : String(error);
    }
    try {
      await sendRuntimeRequest(EXTENSION_E2E_REPORT_METHOD, {
        reportUrl,
        payload: report,
      });
    } catch (runtimeError) {
      try {
        await fetch(reportUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(report),
        });
      } catch (fetchError) {
        log('Failed to send Firefox E2E probe report', runtimeError, fetchError);
      }
    }
  }
  function notifyFirefoxE2EContentScriptReady(win) {
    if (new URLSearchParams(win.location.search).get('__pcE2E') !== '1') return;
    win.dispatchEvent(new CustomEvent('page-context:e2e:content-script-ready'));
  }
  //#endregion
})();
