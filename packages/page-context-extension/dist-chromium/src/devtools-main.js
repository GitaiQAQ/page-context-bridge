import {
  a as setLaunchUrlForSurface,
  n as SIDEPANEL_SURFACE,
  t as DEFAULT_CONSOLE_URL,
} from '../sidepanel-launch-state.BKy_bs2K.js';
//#region src/devtools-main.ts
function getDevtoolsApi() {
  const globalApi = globalThis;
  return globalApi.browser ?? globalApi.chrome ?? null;
}
function buildPanelUrl(inspectedTabId) {
  const params = new URLSearchParams();
  if (typeof inspectedTabId === 'number' && Number.isInteger(inspectedTabId) && inspectedTabId > 0)
    params.set('boundTabId', String(inspectedTabId));
  params.set('surface', 'devtools');
  return `sidepanel.html${params.toString() ? `?${params.toString()}` : ''}`;
}
async function registerPageContextDevtoolsPanel() {
  const extensionApi = getDevtoolsApi();
  if (!extensionApi) {
    console.warn('[page-context-devtools] extension API is unavailable');
    return;
  }
  const panelsApi = extensionApi?.devtools?.panels;
  if (!panelsApi?.create) {
    console.warn('[page-context-devtools] devtools.panels.create is unavailable');
    return;
  }
  if (extensionApi.storage?.local?.set)
    await setLaunchUrlForSurface(SIDEPANEL_SURFACE.devtools, DEFAULT_CONSOLE_URL);
  const inspectedTabId = extensionApi.devtools?.inspectedWindow?.tabId;
  await Promise.resolve(
    panelsApi.create(
      'Page Context Bridge',
      'icons/icon128.png',
      buildPanelUrl(inspectedTabId),
      () => void 0,
    ),
  );
}
registerPageContextDevtoolsPanel();
//#endregion
