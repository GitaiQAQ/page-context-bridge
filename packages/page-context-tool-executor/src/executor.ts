/**
 * Tool execution logic: dispatches tool calls to extension providers or page context.
 */

import {
  type ExtensionToolProvider,
  type ServiceWorkerToolContext,
  RpcProtocolError,
  RPC_ERROR_CODES,
} from '@page-context/shared-protocol';
import { BuiltinExtensionProvider, resolveBuiltinToolNameAlias } from '@page-context/builtin-tools';

type JsonRecord = Record<string, unknown>;

type Debuggee = { tabId: number };
const cdpAttachedTabs = new Set<number>();

function chromeLastErrorMessage(): string | null {
  return chrome.runtime.lastError?.message ?? null;
}

function debuggerAttach(debuggee: Debuggee, protocolVersion = '1.3'): Promise<void> {
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

function debuggerDetach(debuggee: Debuggee): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(debuggee, () => {
      const msg = chromeLastErrorMessage();
      if (msg) {
        // Detach may fail if already detached; treat as non-fatal.
        resolve();
        return;
      }
      resolve();
    });
  });
}

function debuggerSendCommand<T = unknown>(
  debuggee: Debuggee,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggee, method, params ?? {}, (result) => {
      const msg = chromeLastErrorMessage();
      if (msg) {
        reject(new Error(msg));
        return;
      }
      resolve(result as T);
    });
  });
}

async function ensureCdpAttached(tabId: number): Promise<void> {
  if (cdpAttachedTabs.has(tabId)) {
    return;
  }
  await debuggerAttach({ tabId });
  cdpAttachedTabs.add(tabId);
}

async function waitForTabStatus(
  tabId: number,
  status: 'loading' | 'complete',
  timeoutMs: number,
): Promise<void> {
  const timeout = Math.max(0, Math.floor(timeoutMs));
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === status) {
      return;
    }
  } catch {
    // fall through to listener/timeout
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timeout waiting for tab ${tabId} status '${status}'`));
    }, timeout);

    const listener = (updatedTabId: number, changeInfo: any) => {
      if (updatedTabId !== tabId) {
        return;
      }
      if (changeInfo.status === status) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Keep CDP attachment bookkeeping tidy.
//
// Note: this module is used in unit tests where `chrome.debugger` may be undefined.
// Guard listener registration to keep imports side-effect safe in those environments.
if (typeof chrome !== 'undefined') {
  chrome.tabs?.onRemoved?.addListener?.((tabId) => {
    if (!cdpAttachedTabs.has(tabId)) {
      return;
    }
    void debuggerDetach({ tabId }).finally(() => {
      cdpAttachedTabs.delete(tabId);
    });
  });

  chrome.debugger?.onDetach?.addListener?.((source) => {
    if (typeof source.tabId === 'number') {
      cdpAttachedTabs.delete(source.tabId);
    }
  });
}

/** Extension-side tool providers. */
const extensionToolProviders: ExtensionToolProvider[] = [new BuiltinExtensionProvider()];

/** Build a ServiceWorkerToolContext backed by extension APIs. */
const serviceWorkerContext: ServiceWorkerToolContext = {
  async getActiveTabId() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? null;
  },
  async listTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      active: tab.active,
    }));
  },
  async captureVisibleTab(format: string, quality?: number) {
    return await chrome.tabs.captureVisibleTab({ format: format as 'png' | 'jpeg', quality });
  },
  async navigateTab(tabId: number, url: string) {
    await chrome.tabs.update(tabId, { url });
  },

  async reloadTab(tabId: number, bypassCache?: boolean) {
    if (bypassCache) {
      await chrome.tabs.reload(tabId, { bypassCache: true });
    } else {
      await chrome.tabs.reload(tabId);
    }
  },

  async goBack(tabId: number) {
    await chrome.tabs.goBack(tabId);
  },

  async goForward(tabId: number) {
    await chrome.tabs.goForward(tabId);
  },

  async createTab(url: string, active?: boolean) {
    const tab = await chrome.tabs.create({ url, active: active ?? true });
    if (!tab.id) {
      throw new Error('Failed to create tab (missing tab.id)');
    }
    return { tabId: tab.id };
  },

  async closeTab(tabId: number) {
    await chrome.tabs.remove(tabId);
  },

  async waitForTabStatus(tabId: number, status: 'loading' | 'complete', timeoutMs: number) {
    await waitForTabStatus(tabId, status, timeoutMs);
  },

  async cdpSendCommand(tabId: number, method: string, params?: Record<string, unknown>) {
    await ensureCdpAttached(tabId);
    return await debuggerSendCommand({ tabId }, method, params);
  },

  async cdpDetach(tabId: number) {
    if (!cdpAttachedTabs.has(tabId)) {
      return;
    }
    await debuggerDetach({ tabId });
    cdpAttachedTabs.delete(tabId);
  },
};

export function getExtensionToolProviders(): ExtensionToolProvider[] {
  return extensionToolProviders;
}

export function getServiceWorkerContext(): ServiceWorkerToolContext {
  return serviceWorkerContext;
}

export function getBuiltinToolDefinitions(): Array<{
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}> {
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
export async function executeToolCall(
  tool: string,
  args: JsonRecord,
  tabId?: number,

  deps?: {
    executePageToolInTab?: (
      tabId: number,
      name: string,
      args: Record<string, unknown>,
      namespace?: string,
      instanceId?: string,
    ) => Promise<any>;
    sendTabRequest?: <T>(
      tabId: number,
      method: string,
      params: Record<string, unknown>,
    ) => Promise<T>;
  },
): Promise<unknown> {
  const resolvedBuiltinTool = resolveBuiltinToolNameAlias(tool);
  const effectiveTool = resolvedBuiltinTool ?? tool;

  // Check extension tool providers first
  for (const provider of extensionToolProviders) {
    const definitions = provider.getToolDefinitions();
    const def = definitions.find((d) => d.name === effectiveTool);
    if (!def) {
      continue;
    }

    if (def.executionContext === 'service-worker' && provider.executeInServiceWorker) {
      const mergedArgs: JsonRecord = { ...args };
      if (tabId != null && args.tabId == null) {
        mergedArgs.tabId = tabId;
      }
      return await provider.executeInServiceWorker(effectiveTool, mergedArgs, serviceWorkerContext);
    }

    if (def.executionContext === 'content-script') {
      if (!deps?.sendTabRequest) {
        throw new Error(
          'executeToolCall: sendTabRequest dependency required for content-script tools',
        );
      }
      const targetTabId = tabId ?? (await serviceWorkerContext.getActiveTabId());
      if (!targetTabId) {
        throw new RpcProtocolError(RPC_ERROR_CODES.invalidRequest, 'No active tab available');
      }
      return await deps.sendTabRequest(targetTabId, 'extension.tool.execute', {
        tool: effectiveTool,
        args,
        _providerId: provider.id,
      });
    }
  }

  if (resolvedBuiltinTool || tool.startsWith('builtin.')) {
    throw new RpcProtocolError(
      RPC_ERROR_CODES.methodNotFound,
      `Builtin tool is unavailable in this browser runtime: ${effectiveTool}`,
    );
  }

  // Page context tools (namespaced)
  if (effectiveTool.includes('.')) {
    if (!deps?.executePageToolInTab) {
      throw new Error('executeToolCall: executePageToolInTab dependency required for page tools');
    }
    return await executePageTool(effectiveTool, args, tabId, deps.executePageToolInTab);
  }

  throw new RpcProtocolError(RPC_ERROR_CODES.methodNotFound, `Unknown tool: ${tool}`);
}

async function executePageTool(
  tool: string,
  args: JsonRecord,
  tabId: number | undefined,

  executePageToolInTab: (
    tabId: number,
    name: string,
    args: Record<string, unknown>,
    namespace?: string,
    instanceId?: string,
  ) => Promise<any>,
): Promise<unknown> {
  const parts = tool.split('.');
  const pageToolName = parts.at(-1) ?? tool;
  const namespace = parts.length >= 2 ? parts[0] : 'page';
  const instanceId = parts.length >= 3 ? parts[1] : undefined;

  const targetTabId = tabId ?? (await serviceWorkerContext.getActiveTabId());
  if (!targetTabId) {
    throw new Error('No active tab available');
  }

  const outcome = await executePageToolInTab(
    targetTabId,
    pageToolName,
    args,
    namespace,
    instanceId,
  );
  if (!outcome.ok) {
    throw new Error(outcome.error ?? 'Unknown page tool execution failure');
  }
  return outcome.result ?? {};
}
