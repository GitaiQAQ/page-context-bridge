type ExtensionGlobal = typeof globalThis & {
  browser?: typeof chrome;
  chrome?: typeof chrome;
};

type MaybePromise<T> = Promise<T> | T | undefined;
type Callback<T> = (value?: T) => void;

function getGlobalApi(): typeof chrome {
  const globalApi = globalThis as ExtensionGlobal;
  const api = globalApi.browser ?? globalApi.chrome;
  if (!api) {
    throw new Error('WebExtension API is unavailable');
  }
  return api;
}

function hasBrowserPromiseApi(): boolean {
  return Boolean((globalThis as ExtensionGlobal).browser);
}

function isThenable<T>(value: unknown): value is Promise<T> {
  return Boolean(value && typeof (value as { then?: unknown }).then === 'function');
}

function getLastErrorMessage(api: typeof chrome): string | undefined {
  return (
    api.runtime?.lastError?.message ??
    (globalThis as ExtensionGlobal).chrome?.runtime?.lastError?.message
  );
}

function invokeExtensionApi<T>(
  target: unknown,
  method: (...args: unknown[]) => MaybePromise<T>,
  args: unknown[],
): Promise<T> {
  const api = getGlobalApi();

  if (hasBrowserPromiseApi()) {
    return Promise.resolve(method.apply(target, args) as MaybePromise<T>).then(
      (value) => value as T,
    );
  }

  return new Promise<T>((resolve, reject) => {
    const callback: Callback<T> = (value) => {
      const lastError = getLastErrorMessage(api);
      if (lastError) {
        reject(new Error(lastError));
        return;
      }
      resolve(value as T);
    };

    try {
      const result = method.apply(target, [...args, callback]);
      if (isThenable<T>(result)) {
        result.then(resolve, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

export function getExtensionApi(): typeof chrome {
  return getGlobalApi();
}

export function runtimeSendMessage<TResult>(message: unknown): Promise<TResult> {
  const api = getGlobalApi();
  return invokeExtensionApi<TResult>(api.runtime, api.runtime.sendMessage as never, [message]);
}

export function tabsSendMessage<TResult>(tabId: number, message: unknown): Promise<TResult> {
  const api = getGlobalApi();
  return invokeExtensionApi<TResult>(api.tabs, api.tabs.sendMessage as never, [tabId, message]);
}

export function tabsQuery(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  const api = getGlobalApi();
  return invokeExtensionApi<chrome.tabs.Tab[]>(api.tabs, api.tabs.query as never, [queryInfo]);
}

export function tabsGet(tabId: number): Promise<chrome.tabs.Tab> {
  const api = getGlobalApi();
  return invokeExtensionApi<chrome.tabs.Tab>(api.tabs, api.tabs.get as never, [tabId]);
}

export function tabsCreate(
  createProperties: chrome.tabs.CreateProperties,
): Promise<chrome.tabs.Tab> {
  const api = getGlobalApi();
  return invokeExtensionApi<chrome.tabs.Tab>(api.tabs, api.tabs.create as never, [
    createProperties,
  ]);
}

export function storageLocalGet<T extends Record<string, unknown>>(
  keys?: string | string[] | T | null,
): Promise<T> {
  const api = getGlobalApi();
  return invokeExtensionApi<T>(api.storage.local, api.storage.local.get as never, [keys]);
}

export function storageLocalSet(items: Record<string, unknown>): Promise<void> {
  const api = getGlobalApi();
  return invokeExtensionApi<void>(api.storage.local, api.storage.local.set as never, [items]);
}

export function storageLocalRemove(keys: string | string[]): Promise<void> {
  const api = getGlobalApi();
  return invokeExtensionApi<void>(api.storage.local, api.storage.local.remove as never, [keys]);
}

export function windowsGetCurrent(): Promise<chrome.windows.Window> {
  const api = getGlobalApi();
  return invokeExtensionApi<chrome.windows.Window>(
    api.windows,
    api.windows.getCurrent as never,
    [],
  );
}

export function runtimeGetUrl(path: string): string {
  return getGlobalApi().runtime.getURL(path);
}
