/**
 * 页面访问后端（Phase 4）。
 * 目标很单一：把 Chromium 专属的 MAIN world 执行细节集中到一个薄层，
 * 让上层只关心“读什么/调什么”，不关心“怎么注入”。
 */

import {
  BRIDGE_METHODS,
  type ContextResourcePayload,
  type ContextSkillPrompt,
  type PageContextManifest,
} from '@page-context/shared-protocol';
import type { PageToolEntry } from '@page-context/tool-visibility';
import { sendTabRequest } from './runtime-rpc';

type JsonRecord = Record<string, unknown>;
type UnknownRecord = Record<string, unknown>;

/**
 * 兼容策略：就算 shared-protocol 的 dist 还没刷新，这里也能用字面量兜底。
 * 这样 Firefox 只读链路不会因为常量未同步而退化为 undefined method。
 */
const FIREFOX_READONLY_METHODS = {
  manifestGet:
    BRIDGE_METHODS.extensionContentContextManifestGet ?? 'extension.content.context.manifest.get',
  resourceRead:
    BRIDGE_METHODS.extensionContentContextResourceRead ?? 'extension.content.context.resource.read',
  skillGet: BRIDGE_METHODS.extensionContentContextSkillGet ?? 'extension.content.context.skill.get',
  pageToolsDiscover:
    BRIDGE_METHODS.extensionContentPageToolsDiscover ?? 'extension.content.pageTools.discover',
  pageToolExecute:
    BRIDGE_METHODS.extensionContentPageToolExecute ?? 'extension.content.pageTool.execute',
} as const;

/** 只保留运行时需要的最小桥接对象形状，避免在后台层绑死页面实现细节。 */
type PageContextBridgeLike = Record<string, unknown>;

export type PageAccessBackendKind = 'chromium-native-main-world' | 'firefox-probe' | 'unsupported';

export type PageAccessOperation =
  | 'getRawManifest'
  | 'readResource'
  | 'getSkill'
  | 'discoverTools'
  | 'executePageTool';

export class PageAccessBackendError extends Error {
  readonly code = 'PAGE_ACCESS_BACKEND_UNAVAILABLE';
  readonly backendKind: PageAccessBackendKind;
  readonly operation: PageAccessOperation;

  constructor(params: {
    backendKind: PageAccessBackendKind;
    operation: PageAccessOperation;
    reason: string;
  }) {
    super(`[page-access-backend:${params.backendKind}] ${params.operation}: ${params.reason}`);
    this.name = 'PageAccessBackendError';
    this.backendKind = params.backendKind;
    this.operation = params.operation;
  }
}

export function isPageAccessBackendError(error: unknown): error is PageAccessBackendError {
  return error instanceof PageAccessBackendError;
}

export interface BackendPageToolExecutionResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

export interface PageAccessBackend {
  getRawManifest(tabId: number): Promise<PageContextManifest | null>;
  readResource(tabId: number, resourceId: string): Promise<ContextResourcePayload>;
  getSkill(tabId: number, skillId: string, input?: JsonRecord): Promise<ContextSkillPrompt | null>;
  ensureBridgeHost(tabId: number): Promise<void>;
  discoverTools(tabId: number): Promise<PageToolEntry[]>;
  executePageTool(
    tabId: number,
    pageToolName: string,
    args: JsonRecord,
    namespace: string,
    instanceId?: string,
  ): Promise<BackendPageToolExecutionResult>;
}

export interface PageAccessBackendDetection {
  kind: PageAccessBackendKind;
  reason: string;
}

export interface SelectedPageAccessBackend {
  kind: PageAccessBackendKind;
  detection: PageAccessBackendDetection;
  backend: PageAccessBackend;
}

/**
 * 薄探测：只做“路由判定”，不承诺该路径已经可用。
 * Phase 6 的 Firefox 走只读 RPC fallback，避免再误走 Chromium MAIN world。
 */
export function detectPageAccessBackend(probe?: {
  manifest?: unknown;
  userAgent?: string;
  hasChromeScriptingExecuteScript?: boolean;
  hasBrowserRuntimeGetBrowserInfo?: boolean;
}): PageAccessBackendDetection {
  const manifestTarget = detectManifestTarget(probe?.manifest ?? safeGetRuntimeManifest());
  const userAgent = probe?.userAgent ?? safeGetRuntimeUserAgent();
  const hasFirefoxUserAgent = /Firefox\/\d+/i.test(userAgent);
  const hasBrowserRuntimeGetBrowserInfo =
    probe?.hasBrowserRuntimeGetBrowserInfo ?? safeHasBrowserRuntimeGetBrowserInfo();
  const hasChromeScriptingExecuteScript =
    probe?.hasChromeScriptingExecuteScript ?? safeHasChromeScriptingExecuteScript();

  if (manifestTarget === 'firefox' || hasFirefoxUserAgent || hasBrowserRuntimeGetBrowserInfo) {
    return {
      kind: 'firefox-probe',
      // Slice E / Phase 6: Firefox 仅打通只读 RPC，不承诺 discover/execute。
      reason:
        'Firefox probe signal detected (manifest/browser API/userAgent). Readonly RPC fallback is available.',
    };
  }

  if (hasChromeScriptingExecuteScript) {
    return {
      kind: 'chromium-native-main-world',
      reason: 'Chromium MAIN world capability detected via chrome.scripting.executeScript.',
    };
  }

  return {
    kind: 'unsupported',
    reason: 'No supported page access backend capability detected.',
  };
}

/** Chromium 继续走 MAIN world 注入执行。 */
export function createChromiumPageAccessBackend(): PageAccessBackend {
  return {
    async getRawManifest(tabId: number): Promise<PageContextManifest | null> {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const contextWindow = window as Window & {
            __pageContextBridge__?: PageContextBridgeLike;
            __pageContextTools__?: PageContextBridgeLike;
          };
          const pageTools =
            contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
          if (!pageTools || typeof pageTools.getManifest !== 'function') {
            return null;
          }
          return pageTools.getManifest();
        },
      });

      return (results[0]?.result ?? null) as PageContextManifest | null;
    },

    async readResource(tabId: number, resourceId: string): Promise<ContextResourcePayload> {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (id) => {
          const contextWindow = window as Window & {
            __pageContextBridge__?: PageContextBridgeLike;
            __pageContextTools__?: PageContextBridgeLike;
          };
          const pageTools =
            contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
          if (!pageTools || typeof pageTools.readResource !== 'function') {
            throw new Error('Page Context Bridge does not expose readResource()');
          }
          return pageTools.readResource(id);
        },
        args: [resourceId],
      });

      return results[0]?.result as ContextResourcePayload;
    },

    async getSkill(
      tabId: number,
      skillId: string,
      input?: JsonRecord,
    ): Promise<ContextSkillPrompt | null> {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (id, args) => {
          const contextWindow = window as Window & {
            __pageContextBridge__?: PageContextBridgeLike;
            __pageContextTools__?: PageContextBridgeLike;
          };
          const pageTools =
            contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
          if (!pageTools || typeof pageTools.getSkill !== 'function') {
            return null;
          }
          return pageTools.getSkill(id, args);
        },
        args: [skillId, input ?? {}],
      });

      return (results[0]?.result ?? null) as ContextSkillPrompt | null;
    },

    /**
     * 本切片不改 host 安装链路，保持由现有调用方（bg-page-tools）负责安装。
     * 这里保留空实现，仅为了把“是否需要 host”收口到 backend 接口。
     */
    async ensureBridgeHost(_tabId: number): Promise<void> {},

    async discoverTools(tabId: number): Promise<PageToolEntry[]> {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const contextWindow = window as Window & {
            __pageContextBridge__?: PageContextBridgeLike;
            __pageContextTools__?: PageContextBridgeLike;
          };
          const pageTools =
            contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
          if (!pageTools || typeof pageTools !== 'object') {
            return [];
          }

          const entries: Array<{
            namespace: string;
            namespaceTitle?: string;
            namespaceDescription?: string;
            instanceId: string;
            tools: Array<Record<string, unknown>>;
          }> = [];
          const namespaceMetadataById: Record<string, { title?: string; description?: string }> =
            {};

          if (typeof pageTools.getManifest === 'function') {
            try {
              const manifest = pageTools.getManifest();
              const manifestNamespaces =
                manifest &&
                typeof manifest === 'object' &&
                Array.isArray((manifest as { namespaces?: unknown }).namespaces)
                  ? ((manifest as { namespaces: Array<Record<string, unknown>> }).namespaces ?? [])
                  : [];

              for (const entry of manifestNamespaces) {
                if (!entry || typeof entry !== 'object') {
                  continue;
                }
                const namespace = typeof entry.namespace === 'string' ? entry.namespace : null;
                if (!namespace) {
                  continue;
                }
                namespaceMetadataById[namespace] = {
                  title: typeof entry.title === 'string' ? entry.title : undefined,
                  description:
                    typeof entry.description === 'string' ? entry.description : undefined,
                };
              }
            } catch {
              // manifest 只是补充信息，拿不到也不应该阻塞工具发现。
            }
          }

          if (
            typeof pageTools.listNamespaces === 'function' &&
            typeof pageTools.version === 'string'
          ) {
            for (const namespace of pageTools.listNamespaces()) {
              const namespaceObject =
                (
                  pageTools.getNamespace as unknown as (
                    ns: string,
                  ) => Record<string, unknown> | undefined
                )(namespace) ?? {};
              if (!namespaceObject || typeof namespaceObject !== 'object') {
                continue;
              }
              const instanceIds =
                (namespaceObject.listInstances as (() => string[]) | undefined)?.() ?? [];
              const namespaceMetadata = namespaceMetadataById[namespace] ?? {};
              for (const instanceId of instanceIds) {
                const instance = (
                  namespaceObject.getInstance as (id: string) => Record<string, unknown> | undefined
                )?.(instanceId);
                const tools =
                  (instance?.listTools as (() => Array<Record<string, unknown>>) | undefined)?.() ??
                  [];
                if (Array.isArray(tools) && tools.length > 0) {
                  entries.push({
                    namespace,
                    namespaceTitle: namespaceMetadata.title,
                    namespaceDescription: namespaceMetadata.description,
                    instanceId,
                    tools,
                  });
                }
              }
              if (instanceIds.length === 0 && typeof namespaceObject.listTools === 'function') {
                const tools = (namespaceObject.listTools as () => Array<Record<string, unknown>>)();
                if (Array.isArray(tools) && tools.length > 0) {
                  entries.push({
                    namespace,
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
      });

      return (results[0]?.result ?? []) as PageToolEntry[];
    },

    async executePageTool(
      tabId: number,
      pageToolName: string,
      args: JsonRecord,
      namespace: string,
      instanceId?: string,
    ): Promise<BackendPageToolExecutionResult> {
      // Chrome 的 scripting.executeScript 不接受 `undefined` 作为注入参数。
      // default instance 在上层常常表现为“未显式传 instanceId”，这里统一降成 null，
      // 保证真实页面工具也能稳定走 MAIN world 执行。
      const serializedInstanceId = instanceId ?? null;
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (name: string, input: JsonRecord, ns: string, instId: string | null) => {
          const contextWindow = window as Window & {
            __pageContextBridge__?: PageContextBridgeLike;
            __pageContextTools__?: PageContextBridgeLike;
          };
          const pageTools =
            contextWindow.__pageContextBridge__ ?? contextWindow.__pageContextTools__;
          if (!pageTools || typeof pageTools !== 'object') {
            return { ok: false, error: 'No Page Context Bridge object available on this page' };
          }

          if (
            typeof pageTools.listNamespaces === 'function' &&
            typeof pageTools.version === 'string'
          ) {
            const namespaceObject =
              (
                pageTools.getNamespace as unknown as (
                  ns: string,
                ) => Record<string, unknown> | undefined
              )(ns) ?? {};
            if (!namespaceObject || typeof namespaceObject !== 'object') {
              return { ok: false, error: `Namespace not found: ${ns}` };
            }

            const listInstances = namespaceObject.listInstances as unknown as
              | (() => string[])
              | undefined;
            const getInstance = namespaceObject.getInstance as unknown as
              | ((id: string) => Record<string, unknown> | undefined)
              | undefined;

            const actualInstance = instId
              ? getInstance?.(instId)
              : getInstance?.(String(listInstances?.()?.[0] ?? ''));

            if (!actualInstance || typeof actualInstance.callTool !== 'function') {
              return { ok: false, error: `Instance not found: ${instId ?? 'default'}` };
            }

            try {
              const callFn = actualInstance.callTool as unknown as (
                name: string,
                args: JsonRecord,
              ) => unknown;
              const result = await Promise.resolve(callFn(name, input));
              return { ok: true, result };
            } catch (error) {
              return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
          }

          if (typeof pageTools.callTool !== 'function') {
            return { ok: false, error: 'Page Context Bridge has no callable API' };
          }

          try {
            const result = await Promise.resolve(pageTools.callTool(name, input));
            return { ok: true, result };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
        args: [pageToolName, args, namespace, serializedInstanceId],
      });

      return (
        (results[0]?.result as BackendPageToolExecutionResult) ?? {
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
function createFirefoxProbePageAccessBackend(): PageAccessBackend {
  return {
    async getRawManifest(tabId: number): Promise<PageContextManifest | null> {
      try {
        return await sendTabRequest<PageContextManifest | null>(
          tabId,
          FIREFOX_READONLY_METHODS.manifestGet,
        );
      } catch (error) {
        return await fallbackToMainWorldIfFirefoxReadonlyFailed(error, 'getRawManifest', () =>
          chromiumPageAccessBackend.getRawManifest(tabId),
        );
      }
    },
    async readResource(tabId: number, resourceId: string): Promise<ContextResourcePayload> {
      try {
        return await sendTabRequest<ContextResourcePayload>(
          tabId,
          FIREFOX_READONLY_METHODS.resourceRead,
          { resourceId },
        );
      } catch (error) {
        return await fallbackToMainWorldIfFirefoxReadonlyFailed(error, 'readResource', () =>
          chromiumPageAccessBackend.readResource(tabId, resourceId),
        );
      }
    },
    async getSkill(
      tabId: number,
      skillId: string,
      input?: JsonRecord,
    ): Promise<ContextSkillPrompt | null> {
      try {
        return await sendTabRequest<ContextSkillPrompt | null>(
          tabId,
          FIREFOX_READONLY_METHODS.skillGet,
          { skillId, input: input ?? {} },
        );
      } catch (error) {
        return await fallbackToMainWorldIfFirefoxReadonlyFailed(error, 'getSkill', () =>
          chromiumPageAccessBackend.getSkill(tabId, skillId, input),
        );
      }
    },
    async ensureBridgeHost(): Promise<void> {},
    async discoverTools(tabId: number): Promise<PageToolEntry[]> {
      try {
        return await sendTabRequest<PageToolEntry[]>(
          tabId,
          FIREFOX_READONLY_METHODS.pageToolsDiscover,
        );
      } catch (error) {
        return await fallbackToMainWorldIfFirefoxReadonlyFailed(error, 'discoverTools', () =>
          chromiumPageAccessBackend.discoverTools(tabId),
        );
      }
    },
    async executePageTool(
      tabId: number,
      pageToolName: string,
      args: JsonRecord,
      namespace: string,
      instanceId?: string,
    ): Promise<BackendPageToolExecutionResult> {
      try {
        return await sendTabRequest<BackendPageToolExecutionResult>(
          tabId,
          FIREFOX_READONLY_METHODS.pageToolExecute,
          { pageToolName, args, namespace, instanceId },
        );
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

function createUnsupportedPageAccessBackend(params: {
  kind: 'unsupported';
  reason: string;
}): PageAccessBackend {
  const fail = (operation: PageAccessOperation): never => {
    throw new PageAccessBackendError({
      backendKind: params.kind,
      operation,
      reason: params.reason,
    });
  };

  return {
    async getRawManifest(): Promise<PageContextManifest | null> {
      return fail('getRawManifest');
    },
    async readResource(): Promise<ContextResourcePayload> {
      return fail('readResource');
    },
    async getSkill(): Promise<ContextSkillPrompt | null> {
      return fail('getSkill');
    },
    /**
     * 这里保持 no-op，避免把“后端不可用”错误提前到 host 安装步骤，
     * 保证失败来源统一落在 5 个 page access 操作上。
     */
    async ensureBridgeHost(): Promise<void> {},
    async discoverTools(): Promise<PageToolEntry[]> {
      return fail('discoverTools');
    },
    async executePageTool(): Promise<BackendPageToolExecutionResult> {
      return fail('executePageTool');
    },
  };
}

export const chromiumPageAccessBackend: PageAccessBackend = createChromiumPageAccessBackend();
export const firefoxProbePageAccessBackend: PageAccessBackend =
  createFirefoxProbePageAccessBackend();
export const unsupportedPageAccessBackend: PageAccessBackend = createUnsupportedPageAccessBackend({
  kind: 'unsupported',
  reason: 'Current runtime does not provide a supported page access backend.',
});

export function selectPageAccessBackend(
  detection: PageAccessBackendDetection = detectPageAccessBackend(),
): SelectedPageAccessBackend {
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

export const selectedPageAccessBackend: SelectedPageAccessBackend = selectPageAccessBackend();

function safeHasChromeScriptingExecuteScript(): boolean {
  const maybeChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
  if (!isRecord(maybeChrome)) {
    return false;
  }
  const scripting = maybeChrome.scripting;
  if (!isRecord(scripting)) {
    return false;
  }
  return typeof scripting.executeScript === 'function';
}

function safeHasBrowserRuntimeGetBrowserInfo(): boolean {
  const maybeBrowser = (globalThis as typeof globalThis & { browser?: unknown }).browser;
  if (!isRecord(maybeBrowser)) {
    return false;
  }
  const runtime = maybeBrowser.runtime;
  if (!isRecord(runtime)) {
    return false;
  }
  return typeof runtime.getBrowserInfo === 'function';
}

async function fallbackToMainWorldIfFirefoxReadonlyFailed<TResult>(
  error: unknown,
  operation: PageAccessOperation,
  runMainWorldFallback: () => Promise<TResult>,
): Promise<TResult> {
  // Firefox 真实站点上的 readonly broker 仍然可能被 Xray/compartment 权限拦住。
  // 这里仅在“明显是跨 realm 权限错误”时退回 MAIN world executeScript 路径，
  // 这样既保留旧 Firefox 的 readonly fallback，又让新 Firefox 能走更稳定的主世界能力。
  if (!shouldFallbackFirefoxReadonlyToMainWorld(error)) {
    throw error;
  }

  try {
    return await runMainWorldFallback();
  } catch (fallbackError) {
    throw new Error(
      `Firefox readonly ${operation} failed: ${
        error instanceof Error ? error.message : String(error)
      }; MAIN world fallback also failed: ${
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      }`,
    );
  }
}

function shouldFallbackFirefoxReadonlyToMainWorld(error: unknown): boolean {
  if (!safeHasChromeScriptingExecuteScript()) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /Permission denied to access object/i.test(message);
}

function safeGetRuntimeManifest(): UnknownRecord | null {
  const maybeChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
  if (!isRecord(maybeChrome)) {
    return null;
  }
  const runtime = maybeChrome.runtime;
  if (!isRecord(runtime) || typeof runtime.getManifest !== 'function') {
    return null;
  }
  try {
    const manifest = runtime.getManifest() as unknown;
    return isRecord(manifest) ? manifest : null;
  } catch {
    return null;
  }
}

function safeGetRuntimeUserAgent(): string {
  const maybeNavigator = (globalThis as typeof globalThis & { navigator?: unknown }).navigator;
  if (!isRecord(maybeNavigator)) {
    return '';
  }
  return typeof maybeNavigator.userAgent === 'string' ? maybeNavigator.userAgent : '';
}

function detectManifestTarget(manifest: unknown): 'firefox' | 'unknown' {
  if (!isRecord(manifest)) {
    return 'unknown';
  }
  const browserSpecificSettings = manifest.browser_specific_settings;
  if (isRecord(browserSpecificSettings) && isRecord(browserSpecificSettings.gecko)) {
    return 'firefox';
  }
  const applications = manifest.applications;
  if (isRecord(applications) && isRecord(applications.gecko)) {
    return 'firefox';
  }
  return 'unknown';
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}
