import { i as BRIDGE_METHODS, n as sendRuntimeRequest } from '../runtime-rpc.hjw2lJPe.js';
import {
  d as windowsGetCurrent,
  i as storageLocalGet,
  l as tabsQuery,
  n as runtimeGetUrl,
  o as storageLocalSet,
  s as tabsCreate,
  t as getExtensionApi,
} from '../extension-api.BMHS3pcA.js';
import {
  a as setLaunchUrlForSurface,
  n as SIDEPANEL_SURFACE,
  t as DEFAULT_CONSOLE_URL,
} from '../sidepanel-launch-state.BKy_bs2K.js';
//#region src/popup-main.ts
var DEFAULT_WS_URL = 'ws://127.0.0.1:22335/default';
var FALLBACK_CONSOLE_UI_PATH = 'sidepanel.html';
var statusDot = document.getElementById('statusDot');
var statusText = document.getElementById('statusText');
var wsUrlInput = document.getElementById('wsUrlInput');
var pendingCalls = document.getElementById('pendingCalls');
var saveBtn = document.getElementById('saveBtn');
var reconnectBtn = document.getElementById('reconnectBtn');
var toast = document.getElementById('toast');
var openExampleBtn = document.getElementById('openExampleBtn');
var openSidePanelBtn = document.getElementById('openSidePanelBtn');
function showToast(message, type = 'success') {
  toast.textContent = message;
  toast.className = `mt-2 alert ${type === 'success' ? 'alert-success' : 'alert-error'}`;
  setTimeout(() => {
    toast.className = 'mt-2 hidden';
  }, 2e3);
}
async function refreshStatus() {
  try {
    const status = await sendRuntimeRequest(BRIDGE_METHODS.extensionStatusGet);
    statusDot.className = `w-2.5 h-2.5 rounded-full shrink-0 ${status.connected ? 'bg-success' : 'bg-error'}`;
    statusText.textContent = status.connected ? `Connected to ${status.wsUrl}` : 'Disconnected';
    pendingCalls.textContent = String(status.pendingToolCalls ?? 0);
  } catch {
    statusDot.className = 'w-2.5 h-2.5 rounded-full shrink-0 bg-error';
    statusText.textContent = 'Extension not running';
  }
}
async function loadCurrentUrl() {
  wsUrlInput.value = (await storageLocalGet({ mcpWsUrl: DEFAULT_WS_URL })).mcpWsUrl;
}
async function reconnect() {
  try {
    await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect);
    showToast('Reconnecting...');
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    setTimeout(() => void refreshStatus(), 1200);
  }
}
async function saveAndReconnect() {
  const url = wsUrlInput.value.trim();
  if (!url) {
    showToast('Please enter a WebSocket URL', 'error');
    return;
  }
  try {
    new URL(url);
  } catch {
    showToast('Invalid URL format', 'error');
    return;
  }
  await storageLocalSet({ mcpWsUrl: url });
  await reconnect();
}
/**
 * 读取 launcher 的显式绑定。
 * 边界上只返回“存在的字段”，避免把 null/undefined 混在同一条链路里。
 */
async function getLauncherRuntimeBinding() {
  const [activeTab] = await tabsQuery({
    active: true,
    currentWindow: true,
  });
  return {
    ...(activeTab?.id != null ? { tabId: activeTab.id } : {}),
    ...(activeTab?.windowId != null ? { windowId: activeTab.windowId } : {}),
  };
}
/** runtime 绑定 -> launcher URL query 绑定（保留 boundTabId 兼容字段）。 */
function toSidepanelUrlTabBinding(binding) {
  return {
    ...(binding.tabId != null ? { boundTabId: binding.tabId } : {}),
    ...(binding.windowId != null ? { windowId: binding.windowId } : {}),
  };
}
/** fallback 页面继续输出 boundTabId/windowId，保证旧 query 协议兼容。 */
function buildFallbackConsoleUiUrl(binding) {
  const url = new URL(runtimeGetUrl(FALLBACK_CONSOLE_UI_PATH));
  const queryBinding = toSidepanelUrlTabBinding(binding);
  if (queryBinding.boundTabId != null)
    url.searchParams.set('boundTabId', String(queryBinding.boundTabId));
  if (queryBinding.windowId != null)
    url.searchParams.set('windowId', String(queryBinding.windowId));
  return url.toString();
}
async function launchConsoleUi() {
  await setLaunchUrlForSurface(SIDEPANEL_SURFACE.default, DEFAULT_CONSOLE_URL);
  const binding = await getLauncherRuntimeBinding();
  const sidebarApi = getExtensionApi().sidebarAction;
  if (sidebarApi?.open) {
    await sidebarApi.open();
    return;
  }
  const sidePanelApi = getExtensionApi().sidePanel;
  if (sidePanelApi != null) {
    const currentWindow = await windowsGetCurrent();
    if (currentWindow.id != null) {
      await sidePanelApi.open({ windowId: currentWindow.id });
      return;
    }
  }
  await tabsCreate({ url: buildFallbackConsoleUiUrl(binding) });
}
saveBtn.addEventListener('click', () => void saveAndReconnect());
reconnectBtn.addEventListener('click', () => void reconnect());
openExampleBtn.addEventListener('click', () => {
  tabsCreate({ url: 'https://unpkg.com/@page-context/example/dist/example.html' });
});
openSidePanelBtn.addEventListener('click', async () => {
  await launchConsoleUi();
});
loadCurrentUrl();
refreshStatus();
setInterval(() => void refreshStatus(), 2e3);
//#endregion
