import type {
  ContextResourcePayload,
  ContextSkillPrompt,
  PageContextManifest,
} from '@page-context/shared-protocol';
import type { PageToolEntry } from '@page-context/tool-visibility';

type JsonRecord = Record<string, unknown>;
type UnknownRecord = Record<string, unknown>;

type PageContextBridgeLike = {
  version?: unknown;
  namespace?: unknown;
  instanceId?: unknown;
  getManifest?: () => PageContextManifest | null | Promise<PageContextManifest | null>;
  readResource?: (id: string) => ContextResourcePayload | Promise<ContextResourcePayload>;
  getSkill?: (
    id: string,
    input?: JsonRecord,
  ) => ContextSkillPrompt | null | Promise<ContextSkillPrompt | null>;
  listNamespaces?: () => unknown;
  getNamespace?: (namespace: string) => unknown;
  listTools?: () => unknown;
  callTool?: (name: string, args: JsonRecord) => unknown | Promise<unknown>;
};

export interface MainWorldPageToolExecutionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export const PAGE_CONTEXT_READONLY_REQUEST_EVENT = 'page-context:readonly:request';
export const PAGE_CONTEXT_READONLY_RESPONSE_EVENT = 'page-context:readonly:response';

export type ReadonlyBrokerMethod =
  | 'context.manifest.get'
  | 'context.resource.read'
  | 'context.skill.get'
  | 'page.tools.discover'
  | 'page.tool.execute';

export interface ReadonlyBrokerRequest {
  requestId: string;
  method: ReadonlyBrokerMethod;
  params?: unknown;
}

export type ReadonlyBrokerSuccessResponse = {
  requestId: string;
  ok: true;
  result: unknown;
};

export type ReadonlyBrokerErrorResponse = {
  requestId: string;
  ok: false;
  error: string;
};

export type ReadonlyBrokerResponse = ReadonlyBrokerSuccessResponse | ReadonlyBrokerErrorResponse;

function parseReadonlyBrokerPayload(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringifyReadonlyBrokerPayload(
  payload: ReadonlyBrokerRequest | ReadonlyBrokerResponse,
): string {
  // Firefox does not guarantee objects in CustomEvent.detail can be accessed across worlds.
  // Encode them as JSON strings to avoid cross-compartment issues such as
  // "Permission denied to access object" between MAIN world and content script.
  return JSON.stringify(payload);
}

export async function requestReadonlyFromMainWorld<TResult>(
  win: Window,
  method: ReadonlyBrokerMethod,
  params?: unknown,
  timeoutMs = 4_000,
): Promise<TResult> {
  const requestId = `pc-readonly-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const request: ReadonlyBrokerRequest = {
    requestId,
    method,
    // Normalize runtime message args to plain JSON first, so the background -> content script -> MAIN world path
    // does not carry Firefox cross-compartment wrappers that later break JSON encoding or page function calls.
    params: params === undefined ? undefined : cloneCrossWorldJson(params),
  };

  return await new Promise<TResult>((resolve, reject) => {
    const cleanup = (listener: EventListener, timer: ReturnType<typeof setTimeout>) => {
      clearTimeout(timer);
      win.removeEventListener(PAGE_CONTEXT_READONLY_RESPONSE_EVENT, listener);
    };

    const onResponse = ((event: Event) => {
      const detail = parseReadonlyBrokerResponse((event as CustomEvent<unknown>).detail);
      if (!isReadonlyBrokerResponse(detail) || detail.requestId !== requestId) {
        return;
      }

      cleanup(onResponse as EventListener, timer);
      if (!detail.ok) {
        reject(new Error(detail.error));
        return;
      }
      resolve(detail.result as TResult);
    }) as EventListener;

    const timer = setTimeout(() => {
      cleanup(onResponse, timer);
      reject(new Error(`Main world readonly broker timeout: ${method}`));
    }, timeoutMs);

    win.addEventListener(PAGE_CONTEXT_READONLY_RESPONSE_EVENT, onResponse);
    win.dispatchEvent(
      new CustomEvent<string>(PAGE_CONTEXT_READONLY_REQUEST_EVENT, {
        detail: stringifyReadonlyBrokerPayload(request),
      }),
    );
  });
}

export function isReadonlyBrokerRequest(value: unknown): value is ReadonlyBrokerRequest {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.requestId !== 'string' || !value.requestId) {
    return false;
  }
  if (typeof value.method !== 'string') {
    return false;
  }
  return (
    value.method === 'context.manifest.get' ||
    value.method === 'context.resource.read' ||
    value.method === 'context.skill.get' ||
    value.method === 'page.tools.discover' ||
    value.method === 'page.tool.execute'
  );
}

export function dispatchReadonlyBrokerResponse(
  win: Window,
  response: ReadonlyBrokerResponse,
): void {
  win.dispatchEvent(
    new CustomEvent<string>(PAGE_CONTEXT_READONLY_RESPONSE_EVENT, {
      detail: stringifyReadonlyBrokerPayload(response),
    }),
  );
}

export async function runReadonlyBrokerRequest(
  win: Window,
  request: ReadonlyBrokerRequest,
): Promise<ReadonlyBrokerResponse> {
  try {
    const result = await resolveReadonlyRequest(win, request);
    return {
      requestId: request.requestId,
      ok: true,
      // Firefox Xray wrappers make cross-world objects opaque to JSON serialization.
      // A JSON round-trip strips Xray wrappers, producing plain JS objects that
      // chrome.tabs.sendMessage can serialize correctly.
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

async function resolveReadonlyRequest(
  win: Window,
  request: ReadonlyBrokerRequest,
): Promise<unknown> {
  const bridge = getPageContextBridge(win);

  switch (request.method) {
    case 'context.manifest.get': {
      const getManifest = readCallableField(bridge, 'getManifest', 'bridge.getManifest');
      if (!bridge || !getManifest) {
        return null;
      }
      return await Promise.resolve(
        wrapReadonlyStep('bridge.getManifest()', () => Reflect.apply(getManifest, bridge, [])),
      );
    }
    case 'context.resource.read': {
      const resourceId = extractStringParam(request.params, 'resourceId');
      const readResource = readCallableField(bridge, 'readResource', 'bridge.readResource');
      if (!bridge || !readResource) {
        throw new Error('Page Context Bridge does not expose readResource()');
      }
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
      if (!bridge || !getSkill) {
        return null;
      }
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

export async function executeToolFromBridge(
  bridge: PageContextBridgeLike | null,
  params: unknown,
): Promise<MainWorldPageToolExecutionResult> {
  const pageToolName = extractStringParam(params, 'pageToolName');
  const namespace = extractStringParam(params, 'namespace');
  const args = extractJsonRecordParam(params, 'args');
  const instanceId = extractOptionalStringParam(params, 'instanceId');
  const clonedArgs = cloneCrossWorldJson(args);

  if (!bridge || typeof bridge !== 'object') {
    return { ok: false, error: 'No Page Context Bridge object available on this page' };
  }

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
    if (!namespaceObject) {
      return { ok: false, error: `Namespace not found: ${namespace}` };
    }

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
      ? instanceIds.filter((id): id is string => typeof id === 'string' && !!id)
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
    if (!instance || !callTool) {
      return { ok: false, error: `Instance not found: ${instanceId ?? 'default'}` };
    }

    try {
      const result = await Promise.resolve(
        wrapReadonlyStep(`instance(${namespace}).callTool(${pageToolName})`, () =>
          Reflect.apply(callTool, instance, [pageToolName, clonedArgs]),
        ),
      );
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const legacyCallTool = readCallableField(bridge, 'callTool', 'legacyBridge.callTool');
  if (!legacyCallTool) {
    return { ok: false, error: 'Page Context Bridge has no callable API' };
  }

  try {
    const result = await Promise.resolve(
      wrapReadonlyStep(`legacyBridge.callTool(${pageToolName})`, () =>
        Reflect.apply(legacyCallTool, bridge, [pageToolName, clonedArgs]),
      ),
    );
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function discoverToolsFromBridge(bridge: PageContextBridgeLike | null): PageToolEntry[] {
  if (!bridge || typeof bridge !== 'object') {
    return [];
  }

  const entries: PageToolEntry[] = [];
  const namespaceMetadataById = collectNamespaceMetadata(bridge);
  const listNamespaces = readCallableField(bridge, 'listNamespaces', 'bridge.listNamespaces');
  const bridgeVersion = readStringField(bridge, 'version', 'bridge.version');

  if (listNamespaces && bridgeVersion) {
    const namespaces = wrapReadonlyStep('bridge.listNamespaces()', () =>
      Reflect.apply(listNamespaces, bridge, []),
    );
    if (!Array.isArray(namespaces)) {
      return entries;
    }

    for (const namespaceValue of namespaces) {
      if (typeof namespaceValue !== 'string' || !namespaceValue) {
        continue;
      }
      const getNamespace = readCallableField(bridge, 'getNamespace', 'bridge.getNamespace');
      const namespaceObject = asRecord(
        getNamespace
          ? wrapReadonlyStep(`bridge.getNamespace(${namespaceValue})`, () =>
              Reflect.apply(getNamespace, bridge, [namespaceValue]),
            )
          : null,
      );
      if (!namespaceObject) {
        continue;
      }

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
        ? instanceIds.filter((id): id is string => typeof id === 'string' && !!id)
        : [];

      for (const instanceId of normalizedInstanceIds) {
        const getInstance = readCallableField(
          namespaceObject,
          'getInstance',
          `namespace(${namespaceValue}).getInstance`,
        );
        const instance = asRecord(
          getInstance
            ? wrapReadonlyStep(`namespace(${namespaceValue}).getInstance(${instanceId})`, () =>
                Reflect.apply(getInstance, namespaceObject, [instanceId]),
              )
            : null,
        );
        const tools = readToolList(
          instance,
          `instance(${namespaceValue}/${instanceId}).listTools()`,
        );
        if (tools.length > 0) {
          entries.push({
            namespace: namespaceValue,
            namespaceTitle: namespaceMetadata.title,
            namespaceDescription: namespaceMetadata.description,
            instanceId,
            tools,
          });
        }
      }

      if (normalizedInstanceIds.length === 0) {
        const tools = readToolList(namespaceObject, `namespace(${namespaceValue}).listTools()`);
        if (tools.length > 0) {
          entries.push({
            namespace: namespaceValue,
            namespaceTitle: namespaceMetadata.title,
            namespaceDescription: namespaceMetadata.description,
            instanceId: 'default',
            tools,
          });
        }
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

function collectNamespaceMetadata(
  bridge: PageContextBridgeLike,
): Record<string, { title?: string; description?: string }> {
  const metadataById: Record<string, { title?: string; description?: string }> = {};
  const getManifest = readCallableField(bridge, 'getManifest', 'bridge.getManifest');
  if (!getManifest) {
    return metadataById;
  }

  try {
    const manifest = wrapReadonlyStep('bridge.getManifest()', () =>
      Reflect.apply(getManifest, bridge, []),
    );
    if (manifest instanceof Promise) {
      return metadataById;
    }
    const manifestRecord = asRecord(manifest);
    const manifestNamespaces = Array.isArray(manifestRecord?.namespaces)
      ? manifestRecord.namespaces
      : [];
    for (const entry of manifestNamespaces) {
      const recordEntry = asRecord(entry);
      if (!recordEntry) {
        continue;
      }
      const namespace = typeof recordEntry.namespace === 'string' ? recordEntry.namespace : null;
      if (!namespace) {
        continue;
      }
      metadataById[namespace] = {
        title: typeof recordEntry.title === 'string' ? recordEntry.title : undefined,
        description:
          typeof recordEntry.description === 'string' ? recordEntry.description : undefined,
      };
    }
  } catch {
    // Manifest is supplemental; failing to read it should not block tool discovery.
  }

  return metadataById;
}

function readToolList(
  source: PageContextBridgeLike | UnknownRecord | null,
  stepLabel: string,
): PageToolEntry['tools'] {
  const rawSource = readSourceRecord(source, `${stepLabel}.source`);
  const listTools = readCallableField(rawSource, 'listTools', `${stepLabel}.property`);
  if (!rawSource || !listTools) {
    return [];
  }
  const tools = wrapReadonlyStep(stepLabel, () => Reflect.apply(listTools, rawSource, []));
  // Descriptors returned by listTools() still come from the page realm.
  // Convert them to plain JSON early so Firefox does not reject later response serialization with
  // "Permission denied to access object".
  return Array.isArray(tools) ? cloneCrossWorldJson(tools as PageToolEntry['tools']) : [];
}

function asRecord(value: unknown): UnknownRecord | null {
  return isRecord(unwrapFirefoxObject(value))
    ? (unwrapFirefoxObject(value) as UnknownRecord)
    : null;
}

function readSourceRecord(source: unknown, stepLabel: string): UnknownRecord | null {
  const rawSource = wrapReadonlyStep(stepLabel, () => unwrapFirefoxObject(source));
  return isRecord(rawSource) ? (rawSource as UnknownRecord) : null;
}

function readCallableField<TArgs extends unknown[] = unknown[]>(
  source: unknown,
  field: string,
  stepLabel: string,
): ((...args: TArgs) => unknown) | null {
  const rawSource = readSourceRecord(source, `${stepLabel}.source`);
  if (!rawSource) {
    return null;
  }
  const value = wrapReadonlyStep(`${stepLabel}.property`, () =>
    unwrapFirefoxObject(rawSource[field]),
  );
  return typeof value === 'function' ? (value as (...args: TArgs) => unknown) : null;
}

function readStringField(source: unknown, field: string, stepLabel: string): string | undefined {
  const rawSource = readSourceRecord(source, `${stepLabel}.source`);
  if (!rawSource) {
    return undefined;
  }
  const value = wrapReadonlyStep(`${stepLabel}.property`, () =>
    unwrapFirefoxObject(rawSource[field]),
  );
  return typeof value === 'string' && value ? value : undefined;
}

function getPageContextBridge(win: Window): PageContextBridgeLike | null {
  // Firefox Xray vision blocks access to MAIN world expando properties.
  // wrappedJSObject provides access to the underlying page window object,
  // allowing content scripts to see properties set by page JS.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawWin = wrapReadonlyStep(
    'window.wrappedJSObject',
    () => (win as any).wrappedJSObject ?? win,
  );
  const contextWindow = rawWin as Window & {
    __pageContextBridgeRaw__?: PageContextBridgeLike;
    __pageContextBridge__?: PageContextBridgeLike;
    __pageContextTools__?: PageContextBridgeLike;
  };
  // Prefer the raw bridge exposed by the host so Firefox does not hit host getter access again.
  // “Permission denied to access object”。
  const bridge = wrapReadonlyStep(
    'window.pageContextBridge',
    () =>
      contextWindow.__pageContextBridgeRaw__ ??
      contextWindow.__pageContextBridge__ ??
      contextWindow.__pageContextTools__,
  );
  if (!bridge || typeof bridge !== 'object') {
    return null;
  }
  return wrapReadonlyStep('window.pageContextBridge.unwrap', () => unwrapFirefoxObject(bridge));
}

function extractStringParam(params: unknown, field: string): string {
  if (!isRecord(params) || typeof params[field] !== 'string' || !params[field].trim()) {
    throw new Error(`${field} is required`);
  }
  return params[field].trim();
}

function extractJsonRecordParam(params: unknown, field: string): JsonRecord {
  if (!isRecord(params) || params[field] == null) {
    return {};
  }
  const value = params[field];
  if (isRecord(value)) {
    return value;
  }
  return {};
}

function extractOptionalStringParam(params: unknown, field: string): string | undefined {
  if (!isRecord(params) || params[field] == null) {
    return undefined;
  }
  const value = params[field];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isReadonlyBrokerResponse(value: unknown): value is ReadonlyBrokerResponse {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.requestId !== 'string' || typeof value.ok !== 'boolean') {
    return false;
  }
  if (value.ok) {
    return true;
  }
  return typeof value.error === 'string';
}

export function parseReadonlyBrokerRequest(value: unknown): ReadonlyBrokerRequest | null {
  const parsedValue = parseReadonlyBrokerPayload(value);
  return isReadonlyBrokerRequest(parsedValue) ? parsedValue : null;
}

export function parseReadonlyBrokerResponse(value: unknown): ReadonlyBrokerResponse | null {
  const parsedValue = parseReadonlyBrokerPayload(value);
  return isReadonlyBrokerResponse(parsedValue) ? parsedValue : null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/**
 * Strip Firefox Xray wrappers by JSON round-tripping.
 * On Chromium this is a no-op (JSON.parse(JSON.stringify(x)) === x for plain objects).
 * On Firefox, Xray-wrapped objects from MAIN world become opaque;
 * serializing and parsing back produces plain JS objects that message passing can handle.
 */
function unwrapXray<T>(value: T): T {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function unwrapFirefoxObject<T>(value: T): T {
  if (value == null || typeof value !== 'object') {
    return value;
  }
  const wrappedValue = (value as T & { wrappedJSObject?: T }).wrappedJSObject;
  return wrappedValue ?? value;
}

function cloneCrossWorldJson<T>(value: T): T {
  // Page bridge functions run in another compartment.
  // JSON-clone extension-side objects into plain data first to avoid Firefox reporting
  // "Permission denied to access object" on callTool(...) args.
  return unwrapXray(value);
}

function wrapReadonlyStep<T>(stepLabel: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new Error(
      `${stepLabel} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
