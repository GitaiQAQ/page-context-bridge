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
function getExtensionApi() {
  return getGlobalApi();
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
function tabsCreate(createProperties) {
  const api = getGlobalApi();
  return invokeExtensionApi(api.tabs, api.tabs.create, [createProperties]);
}
function storageLocalGet(keys) {
  const api = getGlobalApi();
  return invokeExtensionApi(api.storage.local, api.storage.local.get, [keys]);
}
function storageLocalSet(items) {
  const api = getGlobalApi();
  return invokeExtensionApi(api.storage.local, api.storage.local.set, [items]);
}
function storageLocalRemove(keys) {
  const api = getGlobalApi();
  return invokeExtensionApi(api.storage.local, api.storage.local.remove, [keys]);
}
function windowsGetCurrent() {
  const api = getGlobalApi();
  return invokeExtensionApi(api.windows, api.windows.getCurrent, []);
}
function runtimeGetUrl(path) {
  return getGlobalApi().runtime.getURL(path);
}
//#endregion
export {
  storageLocalRemove as a,
  tabsGet as c,
  windowsGetCurrent as d,
  storageLocalGet as i,
  tabsQuery as l,
  runtimeGetUrl as n,
  storageLocalSet as o,
  runtimeSendMessage as r,
  tabsCreate as s,
  getExtensionApi as t,
  tabsSendMessage as u,
};
