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
function isReadonlyBrokerRequest(value) {
  if (!isRecord(value)) return false;
  if (typeof value.requestId !== 'string' || !value.requestId) return false;
  if (typeof value.method !== 'string') return false;
  return (
    value.method === 'context.manifest.get' ||
    value.method === 'context.resource.read' ||
    value.method === 'context.skill.get' ||
    value.method === 'page.tools.discover' ||
    value.method === 'page.tool.execute'
  );
}
function dispatchReadonlyBrokerResponse(win, response) {
  win.dispatchEvent(
    new CustomEvent(PAGE_CONTEXT_READONLY_RESPONSE_EVENT, {
      detail: stringifyReadonlyBrokerPayload(response),
    }),
  );
}
async function runReadonlyBrokerRequest(win, request) {
  try {
    const result = await resolveReadonlyRequest(win, request);
    return {
      requestId: request.requestId,
      ok: true,
      result: unwrapXray(result),
    };
  } catch (error) {
    return {
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
async function resolveReadonlyRequest(win, request) {
  const bridge = getPageContextBridge(win);
  switch (request.method) {
    case 'context.manifest.get': {
      const getManifest = readCallableField(bridge, 'getManifest', 'bridge.getManifest');
      if (!bridge || !getManifest) return null;
      return await Promise.resolve(
        wrapReadonlyStep('bridge.getManifest()', () => Reflect.apply(getManifest, bridge, [])),
      );
    }
    case 'context.resource.read': {
      const resourceId = extractStringParam(request.params, 'resourceId');
      const readResource = readCallableField(bridge, 'readResource', 'bridge.readResource');
      if (!bridge || !readResource)
        throw new Error('Page Context Bridge does not expose readResource()');
      return await Promise.resolve(
        wrapReadonlyStep('bridge.readResource()', () =>
          Reflect.apply(readResource, bridge, [resourceId]),
        ),
      );
    }
    case 'context.skill.get': {
      const skillId = extractStringParam(request.params, 'skillId');
      const input = extractJsonRecordParam(request.params, 'input');
      const getSkill = readCallableField(bridge, 'getSkill', 'bridge.getSkill');
      if (!bridge || !getSkill) return null;
      return await Promise.resolve(
        wrapReadonlyStep('bridge.getSkill()', () =>
          Reflect.apply(getSkill, bridge, [skillId, input]),
        ),
      );
    }
    case 'page.tools.discover':
      return discoverToolsFromBridge(bridge);
    case 'page.tool.execute':
      return executeToolFromBridge(bridge, request.params);
    default:
      throw new Error(`Unknown readonly broker method: ${String(request.method)}`);
  }
}
async function executeToolFromBridge(bridge, params) {
  const pageToolName = extractStringParam(params, 'pageToolName');
  const namespace = extractStringParam(params, 'namespace');
  const args = extractJsonRecordParam(params, 'args');
  const instanceId = extractOptionalStringParam(params, 'instanceId');
  const clonedArgs = cloneCrossWorldJson(args);
  if (!bridge || typeof bridge !== 'object')
    return {
      ok: false,
      error: 'No Page Context Bridge object available on this page',
    };
  const listNamespaces = readCallableField(bridge, 'listNamespaces', 'bridge.listNamespaces');
  const bridgeVersion = readStringField(bridge, 'version', 'bridge.version');
  if (listNamespaces && bridgeVersion) {
    const getNamespace = readCallableField(bridge, 'getNamespace', 'bridge.getNamespace');
    const namespaceObject = asRecord(
      getNamespace
        ? wrapReadonlyStep(`bridge.getNamespace(${namespace})`, () =>
            Reflect.apply(getNamespace, bridge, [namespace]),
          )
        : null,
    );
    if (!namespaceObject)
      return {
        ok: false,
        error: `Namespace not found: ${namespace}`,
      };
    const listInstances = readCallableField(
      namespaceObject,
      'listInstances',
      `namespace(${namespace}).listInstances`,
    );
    const getInstance = readCallableField(
      namespaceObject,
      'getInstance',
      `namespace(${namespace}).getInstance`,
    );
    const instanceIds = listInstances
      ? wrapReadonlyStep(`namespace(${namespace}).listInstances()`, () =>
          Reflect.apply(listInstances, namespaceObject, []),
        )
      : [];
    const normalizedInstanceIds = Array.isArray(instanceIds)
      ? instanceIds.filter((id) => typeof id === 'string' && !!id)
      : [];
    const actualInstanceId = instanceId ?? normalizedInstanceIds[0];
    const instance = asRecord(
      getInstance && actualInstanceId
        ? wrapReadonlyStep(`namespace(${namespace}).getInstance(${actualInstanceId})`, () =>
            Reflect.apply(getInstance, namespaceObject, [actualInstanceId]),
          )
        : null,
    );
    const callTool = readCallableField(instance, 'callTool', `instance(${namespace}).callTool`);
    if (!instance || !callTool)
      return {
        ok: false,
        error: `Instance not found: ${instanceId ?? 'default'}`,
      };
    try {
      return {
        ok: true,
        result: await Promise.resolve(
          wrapReadonlyStep(`instance(${namespace}).callTool(${pageToolName})`, () =>
            Reflect.apply(callTool, instance, [pageToolName, clonedArgs]),
          ),
        ),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const legacyCallTool = readCallableField(bridge, 'callTool', 'legacyBridge.callTool');
  if (!legacyCallTool)
    return {
      ok: false,
      error: 'Page Context Bridge has no callable API',
    };
  try {
    return {
      ok: true,
      result: await Promise.resolve(
        wrapReadonlyStep(`legacyBridge.callTool(${pageToolName})`, () =>
          Reflect.apply(legacyCallTool, bridge, [pageToolName, clonedArgs]),
        ),
      ),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
function discoverToolsFromBridge(bridge) {
  if (!bridge || typeof bridge !== 'object') return [];
  const entries = [];
  const namespaceMetadataById = collectNamespaceMetadata(bridge);
  const listNamespaces = readCallableField(bridge, 'listNamespaces', 'bridge.listNamespaces');
  const bridgeVersion = readStringField(bridge, 'version', 'bridge.version');
  if (listNamespaces && bridgeVersion) {
    const namespaces = wrapReadonlyStep('bridge.listNamespaces()', () =>
      Reflect.apply(listNamespaces, bridge, []),
    );
    if (!Array.isArray(namespaces)) return entries;
    for (const namespaceValue of namespaces) {
      if (typeof namespaceValue !== 'string' || !namespaceValue) continue;
      const getNamespace = readCallableField(bridge, 'getNamespace', 'bridge.getNamespace');
      const namespaceObject = asRecord(
        getNamespace
          ? wrapReadonlyStep(`bridge.getNamespace(${namespaceValue})`, () =>
              Reflect.apply(getNamespace, bridge, [namespaceValue]),
            )
          : null,
      );
      if (!namespaceObject) continue;
      const namespaceMetadata = namespaceMetadataById[namespaceValue] ?? {};
      const listInstances = readCallableField(
        namespaceObject,
        'listInstances',
        `namespace(${namespaceValue}).listInstances`,
      );
      const instanceIds = listInstances
        ? wrapReadonlyStep(`namespace(${namespaceValue}).listInstances()`, () =>
            Reflect.apply(listInstances, namespaceObject, []),
          )
        : [];
      const normalizedInstanceIds = Array.isArray(instanceIds)
        ? instanceIds.filter((id) => typeof id === 'string' && !!id)
        : [];
      for (const instanceId of normalizedInstanceIds) {
        const getInstance = readCallableField(
          namespaceObject,
          'getInstance',
          `namespace(${namespaceValue}).getInstance`,
        );
        const tools = readToolList(
          asRecord(
            getInstance
              ? wrapReadonlyStep(`namespace(${namespaceValue}).getInstance(${instanceId})`, () =>
                  Reflect.apply(getInstance, namespaceObject, [instanceId]),
                )
              : null,
          ),
          `instance(${namespaceValue}/${instanceId}).listTools()`,
        );
        if (tools.length > 0)
          entries.push({
            namespace: namespaceValue,
            namespaceTitle: namespaceMetadata.title,
            namespaceDescription: namespaceMetadata.description,
            instanceId,
            tools,
          });
      }
      if (normalizedInstanceIds.length === 0) {
        const tools = readToolList(namespaceObject, `namespace(${namespaceValue}).listTools()`);
        if (tools.length > 0)
          entries.push({
            namespace: namespaceValue,
            namespaceTitle: namespaceMetadata.title,
            namespaceDescription: namespaceMetadata.description,
            instanceId: 'default',
            tools,
          });
      }
    }
    return entries;
  }
  const tools = readToolList(bridge, 'legacyBridge.listTools()');
  if (tools.length > 0) {
    const namespace = readStringField(bridge, 'namespace', 'legacyBridge.namespace') ?? 'page';
    const namespaceMetadata = namespaceMetadataById[namespace] ?? {};
    entries.push({
      namespace,
      namespaceTitle: namespaceMetadata.title,
      namespaceDescription: namespaceMetadata.description,
      instanceId: readStringField(bridge, 'instanceId', 'legacyBridge.instanceId') ?? 'default',
      tools,
    });
  }
  return entries;
}
function collectNamespaceMetadata(bridge) {
  const metadataById = {};
  const getManifest = readCallableField(bridge, 'getManifest', 'bridge.getManifest');
  if (!getManifest) return metadataById;
  try {
    const manifest = wrapReadonlyStep('bridge.getManifest()', () =>
      Reflect.apply(getManifest, bridge, []),
    );
    if (manifest instanceof Promise) return metadataById;
    const manifestRecord = asRecord(manifest);
    const manifestNamespaces = Array.isArray(manifestRecord?.namespaces)
      ? manifestRecord.namespaces
      : [];
    for (const entry of manifestNamespaces) {
      const recordEntry = asRecord(entry);
      if (!recordEntry) continue;
      const namespace = typeof recordEntry.namespace === 'string' ? recordEntry.namespace : null;
      if (!namespace) continue;
      metadataById[namespace] = {
        title: typeof recordEntry.title === 'string' ? recordEntry.title : void 0,
        description: typeof recordEntry.description === 'string' ? recordEntry.description : void 0,
      };
    }
  } catch {}
  return metadataById;
}
function readToolList(source, stepLabel) {
  const rawSource = readSourceRecord(source, `${stepLabel}.source`);
  const listTools = readCallableField(rawSource, 'listTools', `${stepLabel}.property`);
  if (!rawSource || !listTools) return [];
  const tools = wrapReadonlyStep(stepLabel, () => Reflect.apply(listTools, rawSource, []));
  return Array.isArray(tools) ? cloneCrossWorldJson(tools) : [];
}
function asRecord(value) {
  return isRecord(unwrapFirefoxObject(value)) ? unwrapFirefoxObject(value) : null;
}
function readSourceRecord(source, stepLabel) {
  const rawSource = wrapReadonlyStep(stepLabel, () => unwrapFirefoxObject(source));
  return isRecord(rawSource) ? rawSource : null;
}
function readCallableField(source, field, stepLabel) {
  const rawSource = readSourceRecord(source, `${stepLabel}.source`);
  if (!rawSource) return null;
  const value = wrapReadonlyStep(`${stepLabel}.property`, () =>
    unwrapFirefoxObject(rawSource[field]),
  );
  return typeof value === 'function' ? value : null;
}
function readStringField(source, field, stepLabel) {
  const rawSource = readSourceRecord(source, `${stepLabel}.source`);
  if (!rawSource) return;
  const value = wrapReadonlyStep(`${stepLabel}.property`, () =>
    unwrapFirefoxObject(rawSource[field]),
  );
  return typeof value === 'string' && value ? value : void 0;
}
function getPageContextBridge(win) {
  const contextWindow = wrapReadonlyStep(
    'window.wrappedJSObject',
    () => win.wrappedJSObject ?? win,
  );
  const bridge = wrapReadonlyStep(
    'window.pageContextBridge',
    () =>
      contextWindow.__pageContextBridgeRaw__ ??
      contextWindow.__pageContextBridge__ ??
      contextWindow.__pageContextTools__,
  );
  if (!bridge || typeof bridge !== 'object') return null;
  return wrapReadonlyStep('window.pageContextBridge.unwrap', () => unwrapFirefoxObject(bridge));
}
function extractStringParam(params, field) {
  if (!isRecord(params) || typeof params[field] !== 'string' || !params[field].trim())
    throw new Error(`${field} is required`);
  return params[field].trim();
}
function extractJsonRecordParam(params, field) {
  if (!isRecord(params) || params[field] == null) return {};
  const value = params[field];
  if (isRecord(value)) return value;
  return {};
}
function extractOptionalStringParam(params, field) {
  if (!isRecord(params) || params[field] == null) return;
  const value = params[field];
  if (typeof value !== 'string') return;
  return value.trim() || void 0;
}
function isReadonlyBrokerResponse(value) {
  if (!isRecord(value)) return false;
  if (typeof value.requestId !== 'string' || typeof value.ok !== 'boolean') return false;
  if (value.ok) return true;
  return typeof value.error === 'string';
}
function parseReadonlyBrokerRequest(value) {
  const parsedValue = parseReadonlyBrokerPayload(value);
  return isReadonlyBrokerRequest(parsedValue) ? parsedValue : null;
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
function unwrapFirefoxObject(value) {
  if (value == null || typeof value !== 'object') return value;
  return value.wrappedJSObject ?? value;
}
function cloneCrossWorldJson(value) {
  return unwrapXray(value);
}
function wrapReadonlyStep(stepLabel, fn) {
  try {
    return fn();
  } catch (error) {
    throw new Error(
      `${stepLabel} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
//#endregion
export {
  runReadonlyBrokerRequest as a,
  requestReadonlyFromMainWorld as i,
  dispatchReadonlyBrokerResponse as n,
  parseReadonlyBrokerRequest as r,
  PAGE_CONTEXT_READONLY_REQUEST_EVENT as t,
};
